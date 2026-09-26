import * as THREE from 'three';
import { buildPartGeometry, type Detail, type PartId } from './people-geometry';
import {
  affine,
  BODY,
  cadence,
  Carry,
  composeE,
  composeZX,
  computePose,
  DEFAULT_STAIR_SLOPE,
  Hair,
  heroLook,
  Look,
  LOOK_STRIDE,
  makeLook,
  packLook,
  Pose,
  unpackLook,
  setRoot,
  writeMatrix,
  type GaitState,
} from './people-rig';

/**
 * Animated pedestrians: low-poly human figures (head, hair, torso, pelvis, two-segment legs
 * and arms, shoes, hands, bags / backpacks / suitcases / phones) driven by the procedural walk
 * cycle in people-rig.ts. One InstancedMesh per body part — the whole crowd costs ~18 draw
 * calls whatever its size — with every instance matrix recomputed each frame from a pose.
 *
 * Agents are addressed by index per frame; pass stable `ids` so that appearance, gait phase
 * and smoothing stay with the same person when the simulation compacts its arrays.
 */

export interface PeopleOptions {
  /** Maps a real elevation (m) to scene Y. */
  Y: (y: number) => number;
  /** Figure size multiplier (1 = real size). */
  scale: number;
  /**
   * Stride is computed for figures of this scale (default: `scale`, capped at 1.6): feet stay
   * planted up to it, while oversized overview figures keep natural proportions and slide.
   */
  gaitScale?: number;
  /** Stable agent ids (same packing as the other arrays). */
  ids?: Uint32Array;
  /** +1 climbing stairs, −1 descending, 0 otherwise. */
  climbs?: Int8Array;
  /** Extra world-space displacement per agent as (x, z) pairs, eased per person (lanes). */
  offsets?: Float32Array;
  /** Per-agent filter (hidden levels…). */
  visible?: (i: number) => boolean;
  /** Scene units between Y(y) and the soles (floors are drawn slightly above their level). */
  lift?: number;
  /** Additional per-agent lift in scene units (stair treads, escalator steps), eased. */
  groundLift?: (i: number) => number;
  /** Skip figures outside this camera's frustum, farther than `maxDistance` or nearer than
   * `minDistance` (people brushing past the lens would fill the screen). */
  camera?: THREE.Camera;
  maxDistance?: number;
  minDistance?: number;
  /** Per-agent sRGB colours (0xrrggbb) blended into the clothes by `tintAmount` — keeps flows
   * colour-coded (e.g. by destination) in the overview. */
  tints?: Uint32Array;
  tintAmount?: number;
  /** Draw at most this many figures (the nearest to `camera` when given). */
  maxDrawn?: number;
  /** Geometry detail; 'low' for the overview, 'high' when walking. */
  detail?: 'low' | 'high';
  /** Ground rise per metre forward on stairs, in scene proportions. */
  stairSlope?: number;
  /** Draw soft contact shadows (default true). */
  shadows?: boolean;
}

interface PartSpec {
  id: PartId;
  /** Instances per person at most. */
  per: number;
  mat: 'body' | 'face' | 'double' | 'tinted' | 'shadow';
}

const PARTS: PartSpec[] = [
  { id: 'shadow', per: 1, mat: 'shadow' },
  { id: 'head', per: 1, mat: 'face' },
  { id: 'hairShort', per: 1, mat: 'double' },
  { id: 'hairLong', per: 1, mat: 'double' },
  { id: 'hairBun', per: 1, mat: 'double' },
  { id: 'cap', per: 1, mat: 'double' },
  { id: 'torso', per: 1, mat: 'body' },
  { id: 'torsoF', per: 1, mat: 'body' },
  { id: 'shirt', per: 1, mat: 'tinted' },
  { id: 'pelvis', per: 1, mat: 'body' },
  { id: 'skirt', per: 1, mat: 'double' },
  { id: 'thigh', per: 2, mat: 'body' },
  { id: 'shin', per: 2, mat: 'body' },
  { id: 'shoe', per: 2, mat: 'body' },
  { id: 'upperArm', per: 2, mat: 'body' },
  { id: 'forearm', per: 2, mat: 'body' },
  { id: 'hand', per: 2, mat: 'body' },
  { id: 'box', per: 4, mat: 'body' },
  { id: 'suitcase', per: 1, mat: 'tinted' },
];

class Part {
  readonly mesh: THREE.InstancedMesh;
  readonly m: Float32Array;
  readonly c: Float32Array | null;
  readonly cap: number;
  n = 0;
  readonly geos = new Map<Detail, THREE.BufferGeometry>();

  constructor(
    readonly spec: PartSpec,
    detail: Detail,
    material: THREE.Material,
    people: number,
  ) {
    this.cap = Math.max(1, people * spec.per);
    const geo = this.geometry(detail);
    this.mesh = new THREE.InstancedMesh(geo, material, this.cap);
    this.mesh.name = `people-${spec.id}`;
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.m = this.mesh.instanceMatrix.array as Float32Array;
    if (spec.mat === 'shadow') {
      this.c = null;
      this.mesh.renderOrder = 2;
    } else {
      const attr = new THREE.InstancedBufferAttribute(new Float32Array(this.cap * 3), 3);
      attr.setUsage(THREE.DynamicDrawUsage);
      this.mesh.instanceColor = attr;
      this.c = attr.array as Float32Array;
    }
    this.mesh.count = 0;
  }

  geometry(detail: Detail): THREE.BufferGeometry {
    let g = this.geos.get(detail);
    if (!g) {
      g = buildPartGeometry(this.spec.id, detail);
      this.geos.set(detail, g);
    }
    return g;
  }

  /** Appends one instance: matrix `mat · diag(sx, sy, sz)` and colour. */
  put(mat: Float64Array, sx: number, sy: number, sz: number, col: Float32Array | null): void {
    if (this.n >= this.cap) return;
    const j = this.n++;
    writeMatrix(this.m, j * 16, mat, sx, sy, sz);
    if (this.c && col) {
      this.c[j * 3] = col[0];
      this.c[j * 3 + 1] = col[1];
      this.c[j * 3 + 2] = col[2];
    }
  }

  flush(): void {
    const mesh = this.mesh;
    mesh.count = this.n;
    mesh.visible = this.n > 0;
    if (this.n === 0) return;
    const im = mesh.instanceMatrix;
    im.clearUpdateRanges();
    im.addUpdateRange(0, this.n * 16);
    im.needsUpdate = true;
    const ic = mesh.instanceColor;
    if (ic) {
      ic.clearUpdateRanges();
      ic.addUpdateRange(0, this.n * 3);
      ic.needsUpdate = true;
    }
  }
}

const PHONE = new Float32Array([0.012, 0.012, 0.014]);

// Scratch (module-level so the per-frame loops never allocate).
const M0 = affine();
const MP = affine();
const MT = affine();
const MH = affine();
const MA = affine();
const MB = affine();
const MC = affine();
const MX = affine();
const MS = affine();
const pose = new Pose();
const look = new Look();
const gait: GaitState = { phase: 0, blend: 0, speed: 0, climb: 0, time: 0, slope: DEFAULT_STAIR_SLOPE };
const sphere = new THREE.Sphere();
const frustum = new THREE.Frustum();
const projView = new THREE.Matrix4();
const camPos = new THREE.Vector3();
const HIST = 64;
const hist = new Int32Array(HIST);

const frac = (x: number) => x - Math.floor(x);

function angleTo(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export interface PeopleCrowdConfig {
  /** Initial / fixed geometry detail (default 'high'). */
  detail?: Detail;
  /** Appearance per id (default: seeded random pedestrians). */
  look?: (id: number, out: Look) => Look;
}

export class PeopleCrowd {
  readonly object = new THREE.Group();
  readonly capacity: number;
  private parts = new Map<PartId, Part>();
  private list: Part[] = [];
  private materials: THREE.Material[];
  private detail: Detail;
  private readonly lookOf: (id: number, out: Look) => Look;
  private time = 0;

  // Per-person state in a direct-mapped table keyed by id (collisions only if two live ids
  // are a multiple of the table size apart: thousands of spawns during one trip).
  private readonly mask: number;
  private readonly sId: Uint32Array;
  private readonly sPhase: Float32Array;
  private readonly sBlend: Float32Array;
  private readonly sSpeed: Float32Array;
  private readonly sYaw: Float32Array;
  private readonly sOffX: Float32Array;
  private readonly sOffZ: Float32Array;
  private readonly sLift: Float32Array;
  private readonly sHeight: Float32Array;
  private readonly sCad: Float32Array;

  // Looks cached per person (regenerating them every frame costs as much as posing).
  private readonly lookMask: number;
  private readonly lookId: Uint32Array;
  private readonly lookData: Float32Array;

  // Parts used for every figure, resolved once.
  private readonly pShadow: Part;
  private readonly pHead: Part;
  private readonly pTorso: Part;
  private readonly pTorsoF: Part;
  private readonly pPelvis: Part;
  private readonly pThigh: Part;
  private readonly pShin: Part;
  private readonly pShoe: Part;
  private readonly pUpper: Part;
  private readonly pFore: Part;
  private readonly pHand: Part;
  private readonly pBox: Part;
  private readonly pHair: Part[];

  // Candidates when `maxDrawn` limits the crowd.
  private readonly candI: Int32Array;
  private readonly candD: Float32Array;

  /** Figures drawn in the last update (after culling). */
  drawn = 0;

  constructor(capacity: number, config: PeopleCrowdConfig = {}) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.detail = config.detail ?? 'high';
    this.lookOf = config.look ?? makeLook;
    this.object.name = 'people';

    const body = new THREE.MeshLambertMaterial();
    const face = new THREE.MeshLambertMaterial({ vertexColors: true });
    const double = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide });
    const tinted = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    const shadow = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    });
    this.materials = [body, face, double, tinted, shadow];
    const mats = { body, face, double, tinted, shadow };
    for (const spec of PARTS) {
      const p = new Part(spec, this.detail, mats[spec.mat], this.capacity);
      this.parts.set(spec.id, p);
      this.list.push(p);
      this.object.add(p.mesh);
    }

    let size = 64;
    while (size < this.capacity * 8) size <<= 1;
    this.mask = size - 1;
    this.sId = new Uint32Array(size).fill(0xffffffff);
    this.sPhase = new Float32Array(size);
    this.sBlend = new Float32Array(size);
    this.sSpeed = new Float32Array(size);
    this.sYaw = new Float32Array(size);
    this.sOffX = new Float32Array(size);
    this.sOffZ = new Float32Array(size);
    this.sLift = new Float32Array(size);
    this.sHeight = new Float32Array(size);
    this.sCad = new Float32Array(size);
    this.candI = new Int32Array(this.capacity);
    this.candD = new Float32Array(this.capacity);
    let lsize = 16;
    while (lsize < this.capacity * 2) lsize <<= 1;
    this.lookMask = lsize - 1;
    this.lookId = new Uint32Array(lsize).fill(0xffffffff);
    this.lookData = new Float32Array(lsize * LOOK_STRIDE);

    this.pShadow = this.part('shadow');
    this.pHead = this.part('head');
    this.pTorso = this.part('torso');
    this.pTorsoF = this.part('torsoF');
    this.pPelvis = this.part('pelvis');
    this.pThigh = this.part('thigh');
    this.pShin = this.part('shin');
    this.pShoe = this.part('shoe');
    this.pUpper = this.part('upperArm');
    this.pFore = this.part('forearm');
    this.pHand = this.part('hand');
    this.pBox = this.part('box');
    this.pHair = [this.part('hairShort'), this.part('hairLong'), this.part('hairBun')];
  }

  /** The look of a person, from the cache or generated (and cached). */
  private lookFor(id: number): Look {
    const s = id & this.lookMask;
    if (this.lookId[s] === id) return unpackLook(this.lookData, s * LOOK_STRIDE, look);
    this.lookOf(id, look);
    packLook(look, this.lookData, s * LOOK_STRIDE);
    this.lookId[s] = id;
    return look;
  }

  private part(id: PartId): Part {
    return this.parts.get(id) as Part;
  }

  private setDetail(d: Detail): void {
    if (d === this.detail) return;
    this.detail = d;
    for (const p of this.list) p.mesh.geometry = p.geometry(d);
  }

  /**
   * Advances every person by `dt` seconds of simulated time and rebuilds the instances.
   * positions: x, y, z in real metres (packed); headings: yaw (0 = +z); speeds: m/s.
   * Allocation-free.
   */
  update(positions: Float32Array, headings: Float32Array, speeds: Float32Array, count: number, dt: number, o: PeopleOptions): void {
    if (o.detail && this.detail !== 'hero') this.setDetail(o.detail);
    dt = Math.max(0, dt);
    this.time += dt;
    for (const p of this.list) p.n = 0;
    const n = Math.min(count, this.capacity, Math.floor(positions.length / 3));
    const cam = o.camera;
    if (cam) {
      projView.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      frustum.setFromProjectionMatrix(projView);
      camPos.setFromMatrixPosition(cam.matrixWorld);
    }
    const maxD2 = o.maxDistance ? o.maxDistance * o.maxDistance : Infinity;
    const minD2 = o.minDistance ? o.minDistance * o.minDistance : 0;
    const limit = Math.min(o.maxDrawn ?? Infinity, this.capacity);
    const lift = o.lift ?? 0;
    const gaitScale = o.gaitScale ?? Math.min(o.scale, 1.6);
    const kSpeed = 1 - Math.exp(-dt / 0.3);
    const kOff = 1 - Math.exp(-dt / 0.8);
    const kLift = 1 - Math.exp(-dt / 0.25);
    const turn = dt > 3 ? Infinity : 5 * dt;
    let cands = 0;

    for (let i = 0; i < n; i++) {
      if (o.visible && !o.visible(i)) continue;
      const id = o.ids ? o.ids[i] : i;
      const s = id & this.mask;
      const v = Number.isFinite(speeds[i]) ? Math.max(0, speeds[i]) : 0;
      const heading = Number.isFinite(headings[i]) ? headings[i] : 0;
      const climb = o.climbs ? o.climbs[i] : 0;
      let ox = o.offsets ? o.offsets[i * 2] : 0;
      let oz = o.offsets ? o.offsets[i * 2 + 1] : 0;
      if (!Number.isFinite(ox) || !Number.isFinite(oz)) ox = oz = 0;
      const gl = o.groundLift ? o.groundLift(i) : 0;

      if (this.sId[s] !== id) {
        // First sighting: snap every smoothed quantity.
        this.lookFor(id);
        this.sId[s] = id;
        this.sHeight[s] = look.height;
        this.sCad[s] = look.cadence;
        this.sPhase[s] = look.phase0;
        this.sSpeed[s] = v;
        this.sBlend[s] = v > 0.12 ? 1 : 0;
        this.sYaw[s] = heading;
        this.sOffX[s] = ox;
        this.sOffZ[s] = oz;
        this.sLift[s] = gl;
      } else {
        this.sSpeed[s] += (v - this.sSpeed[s]) * kSpeed;
        this.sBlend[s] += ((v > 0.12 ? 1 : 0) - this.sBlend[s]) * kSpeed;
        const d = angleTo(this.sYaw[s], heading);
        // Turn at a walking pace (≈ 290°/s of simulated time), kept within ±π.
        this.sYaw[s] = angleTo(0, this.sYaw[s] + Math.max(-turn, Math.min(turn, d)));
        this.sOffX[s] += (ox - this.sOffX[s]) * kOff;
        this.sOffZ[s] += (oz - this.sOffZ[s]) * kOff;
        this.sLift[s] += (gl - this.sLift[s]) * kLift;
      }
      // Phase advances with the cadence of the body's own (planted-stride) speed.
      const vc = this.sSpeed[s] / (this.sHeight[s] * gaitScale);
      this.sPhase[s] = frac(this.sPhase[s] + (cadenceOf(vc, this.sCad[s], climb) / 2) * dt);

      // Culling.
      const x = positions[i * 3] + this.sOffX[s];
      const z = positions[i * 3 + 2] + this.sOffZ[s];
      const y = o.Y(positions[i * 3 + 1]) + lift + this.sLift[s];
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
      let d2 = 0;
      if (cam) {
        const h = this.sHeight[s] * o.scale;
        sphere.center.set(x, y + 0.9 * h, z);
        sphere.radius = 1.3 * h + 0.5;
        if (!frustum.intersectsSphere(sphere)) continue;
        d2 = (x - camPos.x) ** 2 + (y - camPos.y) ** 2 + (z - camPos.z) ** 2;
        if (d2 > maxD2 || d2 < minD2) continue;
      }
      if (limit >= this.capacity) {
        this.drawPerson(i, id, s, x, y, z, climb, o);
      } else {
        this.candI[cands] = i;
        this.candD[cands] = d2;
        cands++;
      }
    }

    if (cands > 0) this.drawNearest(cands, limit, positions, o);
    this.drawn = this.pTorso.n + this.pTorsoF.n;
    for (const p of this.list) p.flush();
  }

  /** Draws the `limit` candidates nearest to the camera (distance histogram, no sorting). */
  private drawNearest(cands: number, limit: number, positions: Float32Array, o: PeopleOptions): void {
    let maxD = 0;
    for (let k = 0; k < cands; k++) maxD = Math.max(maxD, this.candD[k]);
    let cut = Infinity;
    if (cands > limit && maxD > 0) {
      hist.fill(0);
      for (let k = 0; k < cands; k++) hist[Math.min(HIST - 1, Math.floor((this.candD[k] / maxD) * HIST))]++;
      let acc = 0;
      for (let b = 0; b < HIST; b++) {
        acc += hist[b];
        if (acc >= limit) {
          cut = ((b + 1) / HIST) * maxD;
          break;
        }
      }
    }
    let drawn = 0;
    for (let k = 0; k < cands && drawn < limit; k++) {
      if (this.candD[k] > cut) continue;
      const i = this.candI[k];
      const id = o.ids ? o.ids[i] : i;
      const s = id & this.mask;
      const x = positions[i * 3] + this.sOffX[s];
      const z = positions[i * 3 + 2] + this.sOffZ[s];
      const y = o.Y(positions[i * 3 + 1]) + (o.lift ?? 0) + this.sLift[s];
      this.drawPerson(i, id, s, x, y, z, o.climbs ? o.climbs[i] : 0, o);
      drawn++;
    }
  }

  private drawPerson(i: number, id: number, s: number, x: number, y: number, z: number, climb: number, o: PeopleOptions): void {
    const k = this.lookFor(id);
    if (o.tints && o.tintAmount) tintLook(k, o.tints[i], o.tintAmount);
    const sc = k.height * o.scale;
    const gaitScale = o.gaitScale ?? Math.min(o.scale, 1.6);
    gait.phase = this.sPhase[s];
    gait.blend = this.sBlend[s];
    gait.speed = this.sSpeed[s] / (k.height * gaitScale);
    gait.climb = climb;
    gait.time = this.time;
    gait.slope = o.stairSlope ?? DEFAULT_STAIR_SLOPE;
    const P = computePose(pose, gait, k);
    const yaw = this.sYaw[s];
    const g = k.girth;
    // Shoulder width moves the arms; the torso shape itself differs for women (torsoF).
    const tw = k.shoulder * g;

    if (o.shadows !== false) {
      setRoot(MS, x, y + 0.03 * o.scale, z, yaw, 1);
      this.pShadow.put(MS, 0.36 * sc, 1, 0.46 * sc, null);
    }

    setRoot(M0, x, y, z, yaw, sc);
    // Pelvis, torso, head.
    composeE(MP, M0, P.px, P.py, P.pz, P.pPitch, P.pYaw, P.pRoll);
    this.pPelvis.put(MP, k.hip * g, 1, g, k.pelvisC);
    if (k.skirt) this.part('skirt').put(MP, k.hip * g, 1, g, k.skirtC);
    composeE(MT, MP, 0, BODY.pelvisTop, 0, P.tPitch, P.tYaw, P.tRoll);
    (k.female ? this.pTorsoF : this.pTorso).put(MT, g, 1, g, k.top);
    if (k.shirt) this.part('shirt').put(MT, g, 1, g, k.shirtC);
    composeE(MH, MT, 0, BODY.torsoLen, -0.004 * g, P.hPitch, P.hYaw, P.hRoll);
    this.pHead.put(MH, 1, 1, 1, k.skin);
    this.pHair[k.hair === Hair.Long ? 1 : k.hair === Hair.Bun ? 2 : 0].put(MH, 1, 1, 1, k.hairC);
    if (k.cap) this.part('cap').put(MH, 1, 1, 1, k.capC);

    // Legs (thighs hang from the hip joints in person space so the IK stays exact).
    const thigh = this.pThigh;
    const shin = this.pShin;
    const shoe = this.pShoe;
    for (let i = 0; i < 2; i++) {
      composeZX(MA, M0, P.hip[i * 3], P.hip[i * 3 + 1], P.hip[i * 3 + 2], P.thighRoll[i], P.thighPitch[i]);
      thigh.put(MA, g, 1, g, k.thighC);
      composeE(MB, MA, 0, -BODY.thigh, 0, P.knee[i], 0, 0);
      shin.put(MB, g, 1, g, k.shinC);
      composeE(MC, MB, 0, -BODY.shin, 0, P.footPitch[i], P.footYaw[i], 0);
      shoe.put(MC, 1, 1, 1, k.shoes);
    }

    // Arms and whatever the hands hold.
    const upper = this.pUpper;
    const fore = this.pFore;
    const hand = this.pHand;
    const box = this.pBox;
    for (let i = 0; i < 2; i++) {
      const sx = i === 0 ? 1 : -1;
      composeE(MA, MT, sx * BODY.shoulderHalf * tw, BODY.shoulderY, -0.01, P.armPitch[i], P.armYaw[i], P.armRoll[i]);
      upper.put(MA, g, 1, g, k.top);
      composeE(MB, MA, 0, -BODY.upperArm, 0, P.elbow[i], P.foreYaw[i], 0);
      fore.put(MB, g, 1, g, k.sleeve);
      composeE(MC, MB, 0, -BODY.forearm, 0, P.handPitch[i], 0, P.handRoll[i]);
      if (this.detail !== 'low') hand.put(MC, 1, 1, 1, k.skin); // sub-pixel in the overview
      if (k.side !== sx) continue;
      if (k.carry === Carry.Briefcase) {
        composeE(MX, MC, 0, -0.2, 0.02, 0, 0, 0);
        box.put(MX, 0.085, 0.3, 0.42, k.bagC);
      } else if (k.carry === Carry.Tote) {
        composeE(MX, MC, 0, -0.22, 0.01, 0, 0, 0);
        box.put(MX, 0.13, 0.32, 0.36, k.bagC);
      } else if (k.carry === Carry.Phone) {
        composeE(MX, MC, -sx * 0.024, -0.1, 0.01, 0, 0, 0);
        box.put(MX, 0.01, 0.148, 0.072, PHONE);
      } else if (k.carry === Carry.Suitcase) {
        this.putSuitcase(MC, y, yaw, sc, k.caseC);
      }
    }

    if (k.backpack) {
      composeE(MX, MT, 0, 0.245, -0.105 * g - 0.075, 0.06, 0, 0);
      box.put(MX, 0.3 * Math.sqrt(tw), 0.4, 0.15, k.packC);
      for (let i = 0; i < 2; i++) {
        const sx = i === 0 ? 1 : -1;
        composeE(MX, MT, sx * 0.09 * tw, 0.33, 0.125 * g + 0.004, -0.14, 0, 0);
        box.put(MX, 0.036, 0.24, 0.012, k.packC);
      }
    } else if (k.shoulderBag) {
      const sx = k.side;
      composeE(MX, MT, sx * 0.215 * tw, -0.07, -0.035, 0, 0, -sx * 0.05);
      box.put(MX, 0.09, 0.26, 0.31, k.bagC);
      composeE(MX, MT, sx * 0.178 * tw, 0.255, -0.02, 0, 0, sx * Math.asin(Math.min(1, (0.075 * tw) / 0.4)));
      box.put(MX, 0.022, 0.42, 0.01, k.bagC);
    }
  }

  /**
   * Suitcase rolling behind: its wheels on the ground, its handle in the hand (`hand` is the
   * hand bone in world space).
   */
  private putSuitcase(hand: Float64Array, ground: number, yaw: number, sc: number, col: Float32Array): void {
    const part = this.part('suitcase');
    if (part.n >= part.cap) return;
    // Grip: a few centimetres down the hand from the wrist (the y column carries the scale).
    const gx = hand[3] - hand[1] * 0.07;
    const gy = hand[7] - hand[5] * 0.07;
    const gz = hand[11] - hand[9] * 0.07;
    const len = 0.995 * sc;
    const hy = Math.max(0.05 * sc, gy - ground);
    const back = Math.sqrt(Math.max(0.01 * sc * sc, len * len - hy * hy));
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const wx = gx - fx * back;
    const wz = gz - fz * back;
    // Frame: y along wheels → grip, z perpendicular in the vertical plane (up-ish), x = y × z.
    let yx = gx - wx;
    let yy = gy - ground;
    let yz = gz - wz;
    const yl = Math.hypot(yx, yy, yz) || 1;
    yx /= yl;
    yy /= yl;
    yz /= yl;
    let zx = -yy * yx;
    let zy = 1 - yy * yy;
    let zz = -yy * yz;
    const zl = Math.hypot(zx, zy, zz) || 1;
    zx /= zl;
    zy /= zl;
    zz /= zl;
    const xx = yy * zz - yz * zy;
    const xy = yz * zx - yx * zz;
    const xz = yx * zy - yy * zx;
    MX[0] = xx * sc;
    MX[4] = xy * sc;
    MX[8] = xz * sc;
    MX[1] = yx * sc;
    MX[5] = yy * sc;
    MX[9] = yz * sc;
    MX[2] = zx * sc;
    MX[6] = zy * sc;
    MX[10] = zz * sc;
    MX[3] = wx;
    MX[7] = ground;
    MX[11] = wz;
    part.put(MX, 1, 1, 1, col);
  }

  /** Hides every figure (e.g. when the simulation is switched off). */
  clear(): void {
    for (const p of this.list) {
      p.n = 0;
      p.flush();
    }
    this.drawn = 0;
  }

  /** Triangles per figure for the current detail (body and one hair style; excludes extras). */
  trianglesPerPerson(): number {
    let t = 0;
    for (const p of this.list) {
      const id = p.spec.id;
      if (id === 'hairLong' || id === 'hairBun' || id === 'cap' || id === 'torsoF' || id === 'shirt' || id === 'skirt' || id === 'box' || id === 'suitcase') continue;
      const g = p.mesh.geometry;
      const tri = (g.index ? g.index.count : g.getAttribute('position').count) / 3;
      t += tri * p.spec.per;
    }
    return t;
  }

  dispose(): void {
    for (const p of this.list) {
      this.object.remove(p.mesh);
      p.mesh.dispose();
      for (const g of p.geos.values()) g.dispose();
    }
    for (const m of this.materials) m.dispose();
    this.list = [];
    this.parts.clear();
  }
}

const tint = new Float32Array(3);

/** Blends a look's clothes (not skin, hair or shoes) toward an sRGB colour. */
function tintLook(k: Look, hex: number, amount: number): void {
  for (let c = 0; c < 3; c++) {
    const v = ((hex >> (16 - 8 * c)) & 255) / 255;
    tint[c] = v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }
  mixTint(k.top, k.skin, amount);
  mixTint(k.sleeve, k.skin, amount);
  mixTint(k.pelvisC, k.skin, amount);
  mixTint(k.thighC, k.skin, amount);
  mixTint(k.shinC, k.skin, amount);
  mixTint(k.skirtC, k.skin, amount);
}

/** Moves a clothing colour toward `tint`, leaving bare skin (short sleeves, legs) alone. */
function mixTint(col: Float32Array, skin: Float32Array, amount: number): void {
  if (col[0] === skin[0] && col[1] === skin[1] && col[2] === skin[2]) return;
  for (let c = 0; c < 3; c++) col[c] += (tint[c] - col[c]) * amount;
}

function cadenceOf(speed: number, k: number, climb: number): number {
  look.cadence = k;
  return cadence(speed, look, climb);
}

// ---------------------------------------------------------------- hero walker

const identity = (y: number) => y;

/**
 * The walker the camera follows: the same rig at higher detail, dressed as a traveller with
 * the app's yellow cap and backpack. `object` has its feet at the origin; position, scale and
 * visibility are the caller's. Speed is the walking speed in m/s (0 while riding or waiting).
 */
export class WalkerFigure {
  readonly object: THREE.Group;
  private crowd: PeopleCrowd;
  private pos = new Float32Array(3);
  private heading = new Float32Array(1);
  private speed = new Float32Array(1);
  private climbs = new Int8Array(1);
  private ids = new Uint32Array(1);
  private ws = new THREE.Vector3();
  private opts: PeopleOptions = { Y: identity, scale: 1, shadows: true };

  constructor() {
    this.crowd = new PeopleCrowd(1, { detail: 'hero', look: (_id, out) => heroLook(out) });
    this.object = this.crowd.object;
    this.object.name = 'walker-figure';
  }

  /**
   * dt: seconds of route time since the last call; headingYaw: 0 = +z; climbing: stairs
   * direction; slope: stair rise per metre forward in scene proportions.
   */
  update(dt: number, speed: number, headingYaw: number, climbing: -1 | 0 | 1 = 0, slope = DEFAULT_STAIR_SLOPE): void {
    // Planted stride needs the size the figure is drawn at.
    this.object.getWorldScale(this.ws);
    this.speed[0] = speed;
    this.heading[0] = headingYaw;
    this.climbs[0] = climbing;
    const o = this.opts;
    o.gaitScale = Math.max(0.05, this.ws.x);
    o.climbs = this.climbs;
    o.ids = this.ids;
    o.stairSlope = slope;
    this.crowd.update(this.pos, this.heading, this.speed, 1, dt, o);
  }

  dispose(): void {
    this.crowd.dispose();
  }
}

/** Creates the hero walker figure (see WalkerFigure). */
export function createWalkerFigure(): WalkerFigure {
  return new WalkerFigure();
}
