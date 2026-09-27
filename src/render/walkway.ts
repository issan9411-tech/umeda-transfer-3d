import * as THREE from 'three';
import type { Graph } from '../core/graph';
import type { NetEdge, NetNode, Platform } from '../core/types';
import { lateralRoom } from '../sim/crowd';
import { WELL_HEADROOM } from '../data/builder';
import { CLEARANCE, flightWidth, WalkSpace, type WalkPiece } from './walk-space';
import * as TX from './walkway-tex';
import { arrowFor, cabinCycle, destinationsVia, dominantAngle, hash01, isMallEdge, isVertical, laneOffsets, mouthTrims, subtractConvex, type P2, type SignTarget } from './walkway-util';

export { angleDelta } from './walkway-util';

/**
 * Walk-through geometry: the pedestrian network rendered as the place you walk through.
 *
 * - Floors with procedural textures laid on one grid in metres (station tiles in paid areas,
 *   terrazzo in malls, pavers outside, asphalt and zebra stripes at crossings).
 * - Covered corridors get walls and ceilings that are single-sided and face INTO the corridor,
 *   so the chase camera (above ceiling height) looks straight in while the first-person view is
 *   enclosed. Junctions are closed into polygons so corridor mouths meet cleanly.
 * - Ceiling lights, pillar rows in wide concourses, lit shopfronts along the underground malls,
 *   wall adverts, hanging black wayfinding signs at junctions and above fare gates.
 * - Stairs (tread atlas, side walls, handrails), escalators (scrolling treads, glass balustrades,
 *   black handrails), glass elevator shafts with doors and moving cabins, detailed fare gates.
 *
 * Everything is merged per material (≈17 draw calls). Occluders between the chase camera and
 * the walker are cut away in the fragment shader (see `updateWalkway`).
 */

export interface WalkwayOptions {
  /** Maps a real elevation (m) to scene Y. */
  Y: (y: number) => number;
  /** Vertical exaggeration currently applied (heights of walls etc. follow it). */
  ex: number;
  dark: boolean;
  levelVisible: (level: string) => boolean;
  /**
   * Edge ids of the route being walked. Its stairs / escalator / elevator is laid on the
   * node-to-node line the walker follows (the other modes of the bundle move aside) and its
   * junction signs get priority.
   */
  routeEdges?: ReadonlySet<string>;
}

/** Occlusion cut-away for the chase camera: fragments near the eye→target segment are dropped. */
export interface WalkCut {
  eye: THREE.Vector3;
  target: THREE.Vector3;
}

const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
const WHITE = new THREE.Color(1, 1, 1);
/** Vertex tint of floor edges along walls (baked contact shadow). */
const AO = 0.74;
const CUT_RADIUS = 1.7;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _n = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _m = new THREE.Matrix4();

type UV4 = [number, number, number, number, number, number, number, number];

/** Growable non-indexed triangle list with flat normals, UVs and vertex colours. */
class Geo {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  col: number[] = [];

  private push(p: THREE.Vector3, u: number, v: number, n: THREE.Vector3, c: THREE.Color): void {
    this.pos.push(p.x, p.y, p.z);
    this.nor.push(n.x, n.y, n.z);
    this.uv.push(u, v);
    this.col.push(c.r, c.g, c.b);
  }

  /** Quad a→b→c→d (around its outline) made visible from the side `want` points to. */
  /**
   * Quad a→b→c→d (around its outline) made visible from the side `want` points to. `color` is
   * one colour or one per corner (used for baked contact shadows along walls).
   */
  quad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, uv: UV4, want: THREE.Vector3, color: THREE.Color | readonly THREE.Color[] = WHITE): void {
    // Diagonal cross product: robust for any planar quad, even one with a collapsed edge.
    _n.crossVectors(_a.subVectors(c, a), _b.subVectors(d, b));
    const len = _n.length();
    if (len < 1e-9) return;
    _n.divideScalar(len);
    const k = (i: number) => (Array.isArray(color) ? color[i] : (color as THREE.Color));
    if (_n.dot(want) < 0) {
      _n.negate();
      this.push(a, uv[0], uv[1], _n, k(0));
      this.push(c, uv[4], uv[5], _n, k(2));
      this.push(b, uv[2], uv[3], _n, k(1));
      this.push(a, uv[0], uv[1], _n, k(0));
      this.push(d, uv[6], uv[7], _n, k(3));
      this.push(c, uv[4], uv[5], _n, k(2));
      return;
    }
    this.push(a, uv[0], uv[1], _n, k(0));
    this.push(b, uv[2], uv[3], _n, k(1));
    this.push(c, uv[4], uv[5], _n, k(2));
    this.push(a, uv[0], uv[1], _n, k(0));
    this.push(c, uv[4], uv[5], _n, k(2));
    this.push(d, uv[6], uv[7], _n, k(3));
  }

  tri(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, uv: [number, number, number, number, number, number], want: THREE.Vector3, color: THREE.Color | readonly THREE.Color[] = WHITE): void {
    _n.crossVectors(_a.subVectors(b, a), _b.subVectors(c, a));
    const len = _n.length();
    if (len < 1e-9) return;
    _n.divideScalar(len);
    const k = (i: number) => (Array.isArray(color) ? color[i] : (color as THREE.Color));
    if (_n.dot(want) < 0) {
      _n.negate();
      this.push(a, uv[0], uv[1], _n, k(0));
      this.push(c, uv[4], uv[5], _n, k(2));
      this.push(b, uv[2], uv[3], _n, k(1));
      return;
    }
    this.push(a, uv[0], uv[1], _n, k(0));
    this.push(b, uv[2], uv[3], _n, k(1));
    this.push(c, uv[4], uv[5], _n, k(2));
  }

  get triangles(): number {
    return this.pos.length / 9;
  }

  mesh(material: THREE.Material, name: string): THREE.Mesh | null {
    if (this.pos.length === 0) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    const m = new THREE.Mesh(geo, material);
    m.name = name;
    return m;
  }
}

/** Collects box instances and turns them into one InstancedMesh. */
class Boxes {
  mats: number[] = [];
  cols: number[] = [];

  add(center: THREE.Vector3, size: THREE.Vector3, yaw: number, color: THREE.Color, pitch = 0): void {
    _q.setFromEuler(_e.set(pitch, yaw, 0, 'YXZ'));
    _m.compose(center, _q, size);
    for (const v of _m.elements) this.mats.push(v);
    this.cols.push(color.r, color.g, color.b);
  }

  /** Box of cross-section w×h spanning p0→p1 (handrails, beams). */
  beam(p0: THREE.Vector3, p1: THREE.Vector3, w: number, h: number, color: THREE.Color): void {
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const dz = p1.z - p0.z;
    const run = Math.hypot(dx, dz);
    const len = Math.hypot(run, dy);
    if (len < 1e-3) return;
    _p.set((p0.x + p1.x) / 2, (p0.y + p1.y) / 2, (p0.z + p1.z) / 2);
    this.add(_p, _s.set(w, h, len), Math.atan2(dx, dz), color, -Math.atan2(dy, Math.max(run, 1e-4)));
  }

  get count(): number {
    return this.cols.length / 3;
  }

  mesh(material: THREE.Material, name: string): THREE.InstancedMesh | null {
    const n = this.count;
    if (n === 0) return null;
    const m = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material, n);
    (m.instanceMatrix.array as Float32Array).set(this.mats);
    m.instanceMatrix.needsUpdate = true;
    m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.cols), 3);
    m.name = name;
    return m;
  }
}

/** Horizontal unit direction a→b (falls back to +x for vertical edges) and its left normal. */
function frame(a: THREE.Vector3, b: THREE.Vector3): { dir: THREE.Vector3; left: THREE.Vector3; run: number } {
  const dir = new THREE.Vector3(b.x - a.x, 0, b.z - a.z);
  const run = dir.length();
  if (run < 1e-3) dir.set(1, 0, 0);
  else dir.divideScalar(run);
  const left = new THREE.Vector3(dir.z, 0, -dir.x);
  return { dir, left, run };
}

const yawOf = (dir: THREE.Vector3) => Math.atan2(dir.x, dir.z);

const uvRect = (u0: number, v0: number, u1: number, v1: number): UV4 => [u0, v0, u1, v0, u1, v1, u0, v1];
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** Ceiling height (real metres) for a corridor of a given width: wide concourses are taller. */
export function ceilingHeight(width: number): number {
  return width >= 20 ? 4.6 : width >= 12 ? 3.8 : 3.0;
}

const widthOf = (e: NetEdge) => Math.min(26, Math.max(3, e.width ?? (e.kind === 'crossing' ? 8 : e.kind === 'gate' ? 10 : 6)));

interface ArmRec {
  e: NetEdge;
  idx: number;
  other: number;
  angle: number;
  width: number;
  run: number;
  indoor: boolean;
  trim: number;
  H: number;
}

interface SignSpec {
  at: THREE.Vector3;
  normal: THREE.Vector3;
  width: number;
  bottom: number;
  ceil: number | null;
  faceA: number;
  faceB: number;
}

interface CutUniforms {
  uCutA: { value: THREE.Vector3 };
  uCutB: { value: THREE.Vector3 };
  uCutR: { value: number };
}

/** Walk state kept on the group for `updateWalkway` / `disposeWalkway`. */
interface WalkState {
  time: number;
  esc: THREE.Texture | null;
  cabins: THREE.InstancedMesh | null;
  /** Per cabin: x, z, yaw, y0, y1, height, phase, travel, dwell. */
  cabinData: Float32Array;
  cut: CutUniforms;
  textures: THREE.Texture[];
}

const CABIN_STRIDE = 9;

/**
 * Cut-away state shared by every walk-mode material (only one walk scene exists at a time), so
 * meshes built elsewhere, such as the guide line, can take part through `withWalkCut`.
 */
const sharedCut: CutUniforms = { uCutA: { value: new THREE.Vector3() }, uCutB: { value: new THREE.Vector3() }, uCutR: { value: 0 } };

/** Makes a material drop fragments between the chase camera and the walker (see `updateWalkway`). */
export function withWalkCut<T extends THREE.Material>(mat: T): T {
  return withCut(mat, sharedCut);
}

/** Adds the chase-camera cut-away to a material (shared program across all walkway materials). */
function withCut<T extends THREE.Material>(mat: T, cut: CutUniforms): T {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uCutA = cut.uCutA;
    shader.uniforms.uCutB = cut.uCutB;
    shader.uniforms.uCutR = cut.uCutR;
    shader.vertexShader = `varying vec3 vCutPos;\n${shader.vertexShader}`.replace(
      '#include <project_vertex>',
      `#include <project_vertex>
      {
        vec4 cutW = vec4( transformed, 1.0 );
        #ifdef USE_INSTANCING
          cutW = instanceMatrix * cutW;
        #endif
        vCutPos = ( modelMatrix * cutW ).xyz;
      }`,
    );
    shader.fragmentShader = `uniform vec3 uCutA;\nuniform vec3 uCutB;\nuniform float uCutR;\nvarying vec3 vCutPos;\n${shader.fragmentShader}`.replace(
      '#include <clipping_planes_fragment>',
      `#include <clipping_planes_fragment>
      if ( uCutR > 0.0 ) {
        vec3 cutAB = uCutB - uCutA;
        float cutT = dot( vCutPos - uCutA, cutAB ) / max( dot( cutAB, cutAB ), 1e-4 );
        // Nothing right in front of the lens, and no ceilings / upper floors / sign boards
        // above head height on the camera's side of the walker (a cutaway, like a dollhouse).
        if ( cutT < 1.0 && distance( vCutPos, uCutA ) < 2.5 ) discard;
        if ( cutT > 0.0 && cutT < 1.0 && vCutPos.y > uCutB.y + 2.2 ) discard;
        // A cylinder around the sight line, tapering to nothing just before the walker.
        float cutC = clamp( cutT, 0.0, 1.0 );
        float cutR = uCutR * clamp( ( 1.0 - cutC ) / 0.2, 0.0, 1.0 );
        if ( distance( vCutPos, uCutA + cutAB * cutC ) < cutR ) discard;
      }`,
    );
  };
  mat.customProgramCacheKey = () => 'walkway-cut';
  return mat;
}

export function buildWalkway(g: Graph, o: WalkwayOptions): THREE.Group {
  const group = new THREE.Group();
  group.name = 'walkway';
  const { Y, ex } = o;
  const route = o.routeEdges ?? new Set<string>();
  const nodeOf = (id: string) => g.nodes[g.nodeIndex.get(id) as number];
  const idxOf = (id: string) => g.nodeIndex.get(id) as number;
  const P = (n: NetNode) => new THREE.Vector3(n.x, Y(n.y), n.z);
  const visible = (e: NetEdge) => o.levelVisible(nodeOf(e.a).level) || o.levelVisible(nodeOf(e.b).level);
  const dim = o.dark ? 0.74 : 1;
  const col = (hex: string, k = 1) => new THREE.Color(hex).multiplyScalar(k);
  const space = WalkSpace.of(g.net);
  const Y0 = Y(0);
  /** Scene height → real metres (walk-space.ts works in real metres). */
  const real = (y: number) => (y - Y0) / ex;
  /** Skip the walk-space pieces with these ids (a wall never clips against its own corridor). */
  const not =
    (...ids: string[]) =>
    (p: WalkPiece) =>
      ids.includes(p.id);
  /**
   * Vertical quad with bottom edge a→b and top edge d←c, emitted only where it does not stand in
   * walkable space: no wall, parapet or shopfront ever blocks a path someone walks. Returns the
   * kept parameter runs along a→b.
   */
  const vquad = (
    target: Geo,
    a: THREE.Vector3,
    b: THREE.Vector3,
    c2: THREE.Vector3,
    d: THREE.Vector3,
    uv: UV4,
    want: THREE.Vector3,
    color: THREE.Color | readonly THREE.Color[] = WHITE,
    skip?: (p: WalkPiece) => boolean,
  ): [number, number][] => {
    const runs = space.open(a.x, a.z, b.x, b.z, real(Math.min(a.y, b.y)), real(Math.max(c2.y, d.y)), skip);
    for (const [t0, t1] of runs) {
      const u = (i0: number, i1: number, t: number) => uv[i0] + (uv[i1] - uv[i0]) * t;
      const sub: UV4 = [u(0, 2, t0), u(1, 3, t0), u(0, 2, t1), u(1, 3, t1), u(6, 4, t1), u(7, 5, t1), u(6, 4, t0), u(7, 5, t0)];
      let cols: THREE.Color | THREE.Color[] = color as THREE.Color;
      if (Array.isArray(color)) {
        const cl = color as readonly THREE.Color[];
        cols = [cl[0].clone().lerp(cl[1], t0), cl[0].clone().lerp(cl[1], t1), cl[3].clone().lerp(cl[2], t1), cl[3].clone().lerp(cl[2], t0)];
      }
      target.quad(a.clone().lerp(b, t0), a.clone().lerp(b, t1), d.clone().lerp(c2, t1), d.clone().lerp(c2, t0), sub, want, cols);
    }
    return runs;
  };

  const c = {
    wallStation: col('#ffffff', dim),
    wallMall: col('#f3e6d2', dim),
    wallPaid: col('#e9eef3', dim),
    zebraDark: col('#4c4f53', dim),
    zebraWhite: col('#f2f2ee', dim),
    platEdge: col('#f4f4f0', dim),
    pillar: col('#e7e3db', dim),
    pillarBase: col('#4f5459', dim),
    gateBody: col('#dfe3e7', dim),
    gateTop: col('#3a4047', dim),
    gateFlap: col('#e4632e', dim),
    rail: col('#1c1f22'),
    railLight: col('#9aa1a8', dim),
    escTruss: col('#7c8288', dim),
    escDeck: col('#c3c8cd', dim),
    steel: col('#b9bfc5', dim),
    frame: col('#40464d', dim),
    icBlue: col('#2f8dff'),
    lampGreen: col('#2bd46b'),
    lampRed: col('#ff3b30'),
    callPanel: col('#8fd6ff'),
    signRod: col('#2a2d31', dim),
  };
  const adGlow = ['#fff4dc', '#e4f3ff', '#ffe6ea', '#e9ffe6'].map((h) => col(h, o.dark ? 0.9 : 1));

  // One tile grid for all floors, aligned with the dominant street direction, so overlapping
  // floor pieces sample identical texels (no visible z-fighting) and joints run along corridors.
  const alpha = dominantAngle(
    g.edges
      .filter((e) => e.kind === 'walk')
      .map((e) => {
        const a = nodeOf(e.a);
        const b = nodeOf(e.b);
        return { dx: b.x - a.x, dz: b.z - a.z };
      }),
  );
  const ca = Math.cos(alpha);
  const sa = Math.sin(alpha);
  const gu = (p: THREE.Vector3, s: number) => (p.x * ca + p.z * sa) / s;
  const gv = (p: THREE.Vector3, s: number) => (-p.x * sa + p.z * ca) / s;
  const gridUV = (a: THREE.Vector3, b: THREE.Vector3, cc: THREE.Vector3, d: THREE.Vector3, s: number): UV4 => [
    gu(a, s), gv(a, s), gu(b, s), gv(b, s), gu(cc, s), gv(cc, s), gu(d, s), gv(d, s),
  ];

  const geo = {
    tile: new Geo(),
    stone: new Geo(),
    paver: new Geo(),
    asphalt: new Geo(),
    marks: new Geo(),
    tactile: new Geo(),
    wall: new Geo(),
    ceil: new Geo(),
    light: new Geo(),
    shop: new Geo(),
    sign: new Geo(),
    stair: new Geo(),
    esc: new Geo(),
    glass: new Geo(),
  };
  const floorScale = { tile: TX.TILE_M, stone: TX.STONE_M, paver: TX.PAVER_M, asphalt: TX.ASPHALT_M };
  type FloorKind = keyof typeof floorScale;
  const boxes = new Boxes();
  const glow = new Boxes();
  const cabins = new Boxes();
  const cabinData: number[] = [];
  const signs: SignSpec[] = [];
  const faces: TX.SignEntry[][] = [];

  const floorQuad = (kind: FloorKind, a: THREE.Vector3, b: THREE.Vector3, cc: THREE.Vector3, d: THREE.Vector3) =>
    geo[kind].quad(a, b, cc, d, gridUV(a, b, cc, d, floorScale[kind]), UP);

  // ------------------------------------------------------------------ vertical flights (laid out first: their wells open the floors above)
  // builder.ts lays every staircase out as straight flights joined by level landings (nodes
  // flagged `landing`), every escalator as one 30° incline and every lift as a vertical shaft.
  // A staircase is grouped back together here so its well, enclosure and balustrade span all of it.
  interface Seg {
    e: NetEdge;
    a: NetNode;
    b: NetNode;
  }
  interface Flight {
    kind: 'stairs' | 'escalator' | 'elevator';
    segs: Seg[];
    lo: NetNode;
    hi: NetNode;
    w: number;
    indoor: boolean;
    ids: Set<string>;
  }
  const flights: Flight[] = [];
  {
    const used = new Set<string>();
    const vertAt = new Map<string, NetEdge[]>();
    for (const e of g.edges) {
      if (!isVertical(e)) continue;
      for (const id of [e.a, e.b]) {
        const l = vertAt.get(id) ?? [];
        l.push(e);
        vertAt.set(id, l);
      }
    }
    for (const e of g.edges) {
      if (!isVertical(e) || used.has(e.id) || !visible(e)) continue;
      used.add(e.id);
      const chain: NetEdge[] = [e];
      const ends: string[] = [];
      for (const start of [e.a, e.b]) {
        let at = start;
        let prev = e;
        while (nodeOf(at).landing) {
          const next = (vertAt.get(at) ?? []).find((x) => x !== prev && !used.has(x.id));
          if (!next) break;
          used.add(next.id);
          chain.push(next);
          prev = next;
          at = next.a === at ? next.b : next.a;
        }
        ends.push(at);
      }
      const n0 = nodeOf(ends[0]);
      const n1 = nodeOf(ends[1]);
      const [lo, hi] = n0.y <= n1.y ? [n0, n1] : [n1, n0];
      const segs: Seg[] = [];
      const rest = new Set(chain);
      let cur = lo.id;
      while (rest.size) {
        const next = [...rest].find((x) => x.a === cur || x.b === cur);
        if (!next) break;
        rest.delete(next);
        const other = next.a === cur ? next.b : next.a;
        segs.push({ e: next, a: nodeOf(cur), b: nodeOf(other) });
        cur = other;
      }
      flights.push({ kind: e.kind as Flight['kind'], segs, lo, hi, w: flightWidth(e), indoor: chain.every((x) => x.indoor), ids: new Set(chain.map((x) => x.id)) });
    }
  }

  /** Openings in the upper floor over each staircase / escalator (and around lift shafts). */
  const wells: { poly: P2[]; y: number; box: [number, number, number, number] }[] = [];
  /** Openings in ceilings the flights pass through (real heights). */
  const ceilHoles: { poly: P2[]; y0: number; y1: number; box: [number, number, number, number] }[] = [];
  const boxOf = (poly: P2[]): [number, number, number, number] => {
    const xs = poly.map((p) => p[0]);
    const zs = poly.map((p) => p[1]);
    return [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
  };
  const addWell = (pts: THREE.Vector3[], y: number) => {
    const poly = pts.map((p) => [p.x, p.z] as P2);
    wells.push({ poly, y, box: boxOf(poly) });
  };
  /**
   * Distance along a flight (from its foot) where its opening in the upper floor starts: the
   * upper floor can only run over the flight where there is head room under it.
   */
  const wellStart = (f: Flight, run: number) => {
    const A = P(f.lo);
    const dir = frame(A, P(f.hi)).dir;
    const pts = [{ s: 0, y: f.lo.y }, ...f.segs.map((sg) => ({ s: Math.max(0, P(sg.b).sub(A).dot(dir)), y: sg.b.y }))];
    const want = f.hi.y - WELL_HEADROOM;
    for (let i = 1; i < pts.length; i++) {
      if (pts[i].y < want) continue;
      const p0 = pts[i - 1];
      const p1 = pts[i];
      if (p1.y - p0.y < 1e-6) return Math.max(0, p0.s);
      return Math.max(0, Math.min(run, p0.s + ((want - p0.y) / (p1.y - p0.y)) * (p1.s - p0.s)));
    }
    return 0;
  };
  for (const f of flights) {
    const A = P(f.lo);
    const B = P(f.hi);
    const { dir, left, run } = frame(A, B);
    const hw = f.w / 2 + 0.15;
    // The well (the opening in the upper floor) covers the top part of the flight only; the
    // lower levels' ceilings open over the whole flight.
    let pts: THREE.Vector3[];
    let hole: THREE.Vector3[];
    if (f.kind === 'elevator' || run < 0.5) {
      const d = dir.clone().multiplyScalar(1.3);
      const l = left.clone().multiplyScalar(1.3);
      pts = hole = [A.clone().sub(d).sub(l), A.clone().add(d).sub(l), A.clone().add(d).add(l), A.clone().sub(d).add(l)];
    } else {
      const a0 = A.clone().add(dir.clone().multiplyScalar(Math.max(0, wellStart(f, run) - 0.1)));
      const b0 = B.clone().sub(dir.clone().multiplyScalar(0.05));
      const l = left.clone().multiplyScalar(hw);
      pts = [a0.clone().sub(l), b0.clone().sub(l), b0.clone().add(l), a0.clone().add(l)];
      const f0 = A.clone().sub(dir.clone().multiplyScalar(0.1));
      hole = [f0.clone().sub(l), b0.clone().sub(l), b0.clone().add(l), f0.clone().add(l)];
    }
    if (B.y - A.y >= 1) addWell(pts, B.y);
    const poly = hole.map((p) => [p.x, p.z] as P2);
    ceilHoles.push({ poly, y0: f.lo.y, y1: f.hi.y + CLEARANCE, box: boxOf(poly) });
  }

  /** Solves value = a·x + b·z + c over a planar polygon from three of its corners. */
  const affine = (pts: THREE.Vector3[], vals: number[]) => {
    for (const [i, j, k] of [[0, 1, 2], [0, 2, 3], [0, 1, 3]]) {
      if (k >= pts.length) continue;
      const x1 = pts[j].x - pts[i].x;
      const z1 = pts[j].z - pts[i].z;
      const x2 = pts[k].x - pts[i].x;
      const z2 = pts[k].z - pts[i].z;
      const det = x1 * z2 - x2 * z1;
      if (Math.abs(det) < 1e-9) continue;
      const f1 = vals[j] - vals[i];
      const f2 = vals[k] - vals[i];
      const a = (f1 * z2 - f2 * z1) / det;
      const bb = (x1 * f2 - x2 * f1) / det;
      const x0 = pts[i].x;
      const z0 = pts[i].z;
      const v0 = vals[i];
      return (x: number, z: number) => v0 + a * (x - x0) + bb * (z - z0);
    }
    const v0 = vals[0];
    return () => v0;
  };

  /**
   * Emits a convex, (nearly) horizontal surface piece facing up, with stair-well openings cut
   * out of it. `shade` darkens corners (contact shadow); `uvOf` maps a point to texture UV.
   */
  const polyFloor = (target: Geo, pts: THREE.Vector3[], uvOf: (p: THREE.Vector3) => [number, number], shade: number[] | null = null, color: THREE.Color = WHITE) => {
    let y0 = Infinity;
    let y1 = -Infinity;
    let bx0 = Infinity;
    let bx1 = -Infinity;
    let bz0 = Infinity;
    let bz1 = -Infinity;
    for (const p of pts) {
      y0 = Math.min(y0, p.y);
      y1 = Math.max(y1, p.y);
      bx0 = Math.min(bx0, p.x);
      bx1 = Math.max(bx1, p.x);
      bz0 = Math.min(bz0, p.z);
      bz1 = Math.max(bz1, p.z);
    }
    let pieces: P2[][] | null = null;
    if (y1 - y0 < 0.9) {
      for (const w of wells) {
        if (Math.abs(w.y - y0) > 0.9 || w.box[1] < bx0 || w.box[0] > bx1 || w.box[3] < bz0 || w.box[2] > bz1) continue;
        pieces = (pieces ?? [pts.map((p) => [p.x, p.z] as P2)]).flatMap((pc) => subtractConvex(pc, w.poly));
      }
    }
    const tint = (k: number) => (k === 1 ? color : color.clone().multiplyScalar(k));
    const fan = (vs: THREE.Vector3[], ks: number[]) => {
      for (let i = 1; i + 1 < vs.length; i++) {
        const a = uvOf(vs[0]);
        const b = uvOf(vs[i]);
        const cc = uvOf(vs[i + 1]);
        target.tri(vs[0], vs[i], vs[i + 1], [a[0], a[1], b[0], b[1], cc[0], cc[1]], UP, [tint(ks[0]), tint(ks[i]), tint(ks[i + 1])]);
      }
    };
    const ks = shade ?? pts.map(() => 1);
    if (!pieces) {
      fan(pts, ks);
      return;
    }
    const fy = affine(pts, pts.map((p) => p.y));
    const fk = affine(pts, ks);
    for (const pc of pieces) {
      const vs = pc.map(([x, z]) => V(x, fy(x, z), z));
      fan(vs, vs.map((v) => fk(v.x, v.z)));
    }
  };
  const gridOf = (kind: FloorKind) => (p: THREE.Vector3): [number, number] => [gu(p, floorScale[kind]), gv(p, floorScale[kind])];
  const floorPoly = (kind: FloorKind, pts: THREE.Vector3[], shade: number[] | null = null) => polyFloor(geo[kind], pts, gridOf(kind), shade);

  /** Flat ceiling (convex, facing down) with openings where a flight passes through it. */
  const ceilPoly = (pts: THREE.Vector3[]) => {
    const yc = pts[0].y;
    const yr = real(yc);
    const bb = boxOf(pts.map((p) => [p.x, p.z] as P2));
    let pieces: P2[][] = [pts.map((p) => [p.x, p.z] as P2)];
    for (const h of ceilHoles) {
      if (!(h.y0 < yr - 0.3 && h.y1 > yr) || h.box[1] < bb[0] || h.box[0] > bb[1] || h.box[3] < bb[2] || h.box[2] > bb[3]) continue;
      pieces = pieces.flatMap((pc) => subtractConvex(pc, h.poly));
    }
    // A walkway on a mezzanine above: the ceiling below it stops where it would cut through the
    // people walking up there.
    for (const w of space.query(bb[0], bb[1], bb[2], bb[3])) {
      if (w.kind === 'flight' || w.kind === 'shaft' || Math.abs(w.fx) > 1e-3 || Math.abs(w.fz) > 1e-3) continue;
      if (!(w.f0 > yr - w.clear && w.f0 < yr - 0.05)) continue;
      pieces = pieces.flatMap((pc) => subtractConvex(pc, w.poly));
    }
    const uvc = (p: THREE.Vector3): [number, number] => [gu(p, TX.CEIL_M), gv(p, TX.CEIL_M)];
    for (const pc of pieces) {
      const vs = pc.map(([x, z]) => V(x, yc, z));
      for (let i = 1; i + 1 < vs.length; i++) {
        const a = uvc(vs[0]);
        const b = uvc(vs[i]);
        const cc = uvc(vs[i + 1]);
        geo.ceil.tri(vs[0], vs[i], vs[i + 1], [a[0], a[1], b[0], b[1], cc[0], cc[1]], DOWN);
      }
    }
  };

  // ------------------------------------------------------------------ junction arms
  const platformOf = new Map(g.net.platforms.map((p) => [p.id, p]));
  /** Standing on a platform slab (boarding positions, stair heads and their walkways). */
  const onPlatform = (n: NetNode) => n.kind === 'platform' || !!n.platformId || space.platformAt(n.x, n.z, n.y) !== null;
  /** Walkways running along a platform stay open to the tracks (no walls or ceiling). */
  const alongPlatform = (e: NetEdge) => {
    const a = nodeOf(e.a);
    const b = nodeOf(e.b);
    if (e.kind === 'platform') return true;
    if (onPlatform(a) || onPlatform(b)) return true;
    if (a.platformId && a.platformId === b.platformId) return true;
    const ex_ = b.x - a.x;
    const ez = b.z - a.z;
    const len = Math.hypot(ex_, ez) || 1;
    for (const n of [a, b]) {
      const p = n.platformId ? platformOf.get(n.platformId) : undefined;
      if (!p) continue;
      const px = p.b[0] - p.a[0];
      const pz = p.b[1] - p.a[1];
      const pl = Math.hypot(px, pz) || 1;
      if (Math.abs((ex_ * px + ez * pz) / (len * pl)) > 0.8) return true;
    }
    return false;
  };
  const enclosedEdge = (e: NetEdge) => e.indoor && (e.kind === 'walk' || e.kind === 'gate') && !alongPlatform(e);

  const arms = new Map<string, ArmRec[]>();
  g.edges.forEach((e, idx) => {
    // Platform edges only shape junction mouths (the platform itself is drawn by the view).
    if (!(e.kind === 'walk' || e.kind === 'crossing' || e.kind === 'gate' || e.kind === 'platform') || !visible(e)) return;
    const a = nodeOf(e.a);
    const b = nodeOf(e.b);
    const run = Math.hypot(b.x - a.x, b.z - a.z);
    if (run < 0.5) return;
    const w = widthOf(e);
    const indoor = enclosedEdge(e);
    const H = ceilingHeight(w);
    const push = (from: NetNode, to: NetNode) => {
      const list = arms.get(from.id) ?? [];
      list.push({ e, idx, other: idxOf(to.id), angle: Math.atan2(to.z - from.z, to.x - from.x), width: w, run, indoor, trim: 0, H });
      arms.set(from.id, list);
    };
    push(a, b);
    push(b, a);
  });
  for (const list of arms.values()) {
    list.sort((p, q) => p.angle - q.angle);
    const t = mouthTrims(list, 24);
    list.forEach((arm, k) => (arm.trim = Math.min(t[k], arm.run * 0.45)));
  }
  const trimAt = (nodeId: string, idx: number) => arms.get(nodeId)?.find((x) => x.idx === idx)?.trim ?? 0;
  const hasVertical = new Set<string>();
  for (const e of g.edges) if (isVertical(e) || e.kind === 'platform') hasVertical.add(e.a), hasVertical.add(e.b);

  // ------------------------------------------------------------------ corridors
  g.edges.forEach((e, ei) => {
    if (!(e.kind === 'walk' || e.kind === 'crossing' || e.kind === 'gate') || !visible(e)) return;
    const na = nodeOf(e.a);
    const nb = nodeOf(e.b);
    const A = P(na);
    const B = P(nb);
    const { dir, left, run } = frame(A, B);
    if (run < 0.5) return;
    const w = widthOf(e);
    const hw = w / 2;
    const s0 = trimAt(na.id, ei);
    const s1 = run - trimAt(nb.id, ei);
    if (s1 - s0 < 0.2) return;
    const lift = 0.08;
    /** Point at distance s along the corridor, lateral offset `lat` (left +), height h above floor. */
    const at = (s: number, lat: number, h = 0) =>
      V(A.x + dir.x * s + left.x * lat, A.y + (B.y - A.y) * (s / run) + h, A.z + dir.z * s + left.z * lat);
    const enclosed = enclosedEdge(e);
    // Indoor floors darken towards the walls (baked contact shadow) in three strips.
    const floor = (kind: FloorKind, f0: number, f1: number) => {
      if (!enclosed) {
        floorPoly(kind, [at(f0, hw, lift), at(f1, hw, lift), at(f1, -hw, lift), at(f0, -hw, lift)]);
        return;
      }
      const m = Math.min(0.9, hw * 0.3);
      const ks = [hw, hw - m, -(hw - m), -hw];
      for (let i = 0; i < 3; i++) {
        const kl = i === 0 ? AO : 1;
        const kr = i === 2 ? AO : 1;
        floorPoly(kind, [at(f0, ks[i], lift), at(f1, ks[i], lift), at(f1, ks[i + 1], lift), at(f0, ks[i + 1], lift)], [kl, kl, kr, kr]);
      }
    };

    // The floor under the trimmed ends too (plain, no wall shading): walk-space.ts counts the
    // whole strip from node to node as walkable, and the crowd uses all of it.
    const endKind: FloorKind = e.kind === 'crossing' ? 'asphalt' : !e.indoor ? 'paver' : na.paid && nb.paid ? 'tile' : 'stone';
    const endLift = e.kind === 'crossing' ? 0.1 : lift;
    if (s0 > 0.05) floorPoly(endKind, [at(0, hw, endLift), at(s0, hw, endLift), at(s0, -hw, endLift), at(0, -hw, endLift)]);
    if (s1 < run - 0.05) floorPoly(endKind, [at(s1, hw, endLift), at(run, hw, endLift), at(run, -hw, endLift), at(s1, -hw, endLift)]);

    if (e.kind === 'crossing') {
      floorPoly('asphalt', [at(s0, hw, 0.1), at(s1, hw, 0.1), at(s1, -hw, 0.1), at(s0, -hw, 0.1)]);
      // Zebra bars: 45 cm wide every 90 cm, long axis across the walking direction.
      for (let s = s0 + 0.6; s + 0.45 < s1 - 0.3; s += 0.9) {
        const lat = hw * 0.9;
        geo.marks.quad(at(s, lat, 0.13), at(s + 0.45, lat, 0.13), at(s + 0.45, -lat, 0.13), at(s, -lat, 0.13), uvRect(0, 0, 1, 1), UP, c.zebraWhite);
      }
      return;
    }

    const paidA = !!na.paid;
    const paidB = !!nb.paid;
    let gateS = -1;
    if (e.kind === 'gate') {
      // Gate line just inside the corridor on the paid side (builder: gate(paidSide, freeSide)).
      gateS = Math.min(s0 + 1.8, (s0 + s1) / 2);
      const paidFirst = paidA || !paidB;
      floor(paidFirst ? 'tile' : 'stone', s0, gateS);
      floor(paidFirst ? 'stone' : 'tile', gateS, s1);
      addGateRow(e, at, gateS, w, dir);
    } else {
      floor(!e.indoor ? 'paver' : paidA && paidB ? 'tile' : 'stone', s0, s1);
    }

    if (enclosed) {
      const H = ceilingHeight(w) * ex;
      const mall = isMallEdge(e, na, nb);
      const tint = mall ? c.wallMall : paidA && paidB ? c.wallPaid : c.wallStation;
      const low = tint.clone().multiplyScalar(0.8);
      for (const side of [1, -1]) {
        const lat = side * hw;
        const inward = left.clone().multiplyScalar(-side);
        const runs = vquad(geo.wall, at(s0, lat), at(s1, lat), at(s1, lat, H), at(s0, lat, H), uvRect(s0 / TX.WALL_M, 0, s1 / TX.WALL_M, 1), inward, [low, low, tint, tint], not(e.id));
        // Shopfronts and adverts only on the wall that is actually there (not across openings).
        for (const [t0, t1] of runs) {
          const a0 = s0 + (s1 - s0) * t0;
          const a1 = s0 + (s1 - s0) * t1;
          if (mall) addShops(e, at, a0, a1, side, hw, H, inward);
          else if (e.kind === 'walk') addAds(e, at, a0, a1, side, hw, inward);
        }
      }
      if (Math.abs(A.y - B.y) < 0.05) ceilPoly([at(s0, hw, H), at(s1, hw, H), at(s1, -hw, H), at(s0, -hw, H)]);
      else {
        const q = [at(s0, hw, H), at(s1, hw, H), at(s1, -hw, H), at(s0, -hw, H)] as const;
        geo.ceil.quad(q[0], q[1], q[2], q[3], gridUV(q[0], q[1], q[2], q[3], TX.CEIL_M), DOWN);
      }
      addLights(at, s0, s1, w, H);
      if (e.name?.includes('動く歩道')) addMovingWalkway(at, s0, s1, w, dir);
      else if (w >= 10 && e.kind === 'walk') addPillars(e, at, s0, s1, w, H);
    } else if (!e.indoor && Math.min(na.y, nb.y) >= 2) {
      // Elevated outdoor deck / pedestrian bridge: glass parapets with a steel top rail.
      for (const side of [1, -1]) {
        const lat = side * (hw - 0.05);
        const h = 1.1 * ex;
        for (const [t0, t1] of vquad(geo.glass, at(s0, lat, lift), at(s1, lat, lift), at(s1, lat, h), at(s0, lat, h), uvRect(0, 0, 1, 1), left.clone().multiplyScalar(-side), WHITE, not(e.id))) {
          boxes.beam(at(s0 + (s1 - s0) * t0, lat, h), at(s0 + (s1 - s0) * t1, lat, h), 0.12, 0.1, c.railLight);
        }
      }
    }
  });

  function addGateRow(e: NetEdge, at: (s: number, lat: number, h?: number) => THREE.Vector3, s: number, w: number, dir: THREE.Vector3): void {
    const yaw = yawOf(dir);
    let n = Math.round((w * 0.75) / 0.9);
    n += n % 2; // even count: an aisle, not a machine, sits on the centreline the walker follows
    n = Math.min(24, Math.max(4, n));
    const pitch = 0.9;
    const bodyH = 0.95 * ex;
    const own = not(e.id, `node:${e.a}`, `node:${e.b}`);
    for (let i = 0; i < n; i++) {
      const lat = (i - (n - 1) / 2) * pitch;
      // A machine never stands in another walkway that happens to cross the gate line.
      const q = at(s, lat);
      if (space.intersectsBox(q.x - 0.4, q.x + 0.4, real(q.y), real(q.y) + 1, q.z - 0.4, q.z + 0.4, own)) continue;
      boxes.add(at(s, lat, bodyH / 2), _s.set(0.22, bodyH, 1.5), yaw, c.gateBody);
      boxes.add(at(s, lat, bodyH + 0.03), _s.set(0.27, 0.06, 1.54), yaw, c.gateTop);
      for (const end of [-1, 1]) {
        // IC card reader (blue) on the top plate at both ends, and a direction lamp on the end face.
        glow.add(at(s + end * 0.52, lat, bodyH + 0.07), _s.set(0.2, 0.03, 0.26), yaw, c.icBlue);
        glow.add(at(s + end * 0.77, lat, bodyH * 0.86), _s.set(0.07, 0.05, 0.02), yaw, (i + (end > 0 ? 1 : 0)) % 2 ? c.lampGreen : c.lampRed);
      }
      // Closed flaps in a few aisles (never in the central one).
      if (i < n - 1 && i !== n / 2 - 1 && hash01(e.id, i) < 0.3) {
        const mid = lat + pitch / 2;
        for (const side of [-1, 1]) boxes.add(at(s, mid + side * 0.22, bodyH * 0.6), _s.set(0.24, bodyH * 0.35, 0.05), yaw, c.gateFlap);
      }
    }
    // Glass fences from the row ends to the corridor walls.
    const rowHalf = (n / 2) * pitch;
    const h = 1.1 * ex;
    for (const side of [-1, 1]) {
      const l0 = side * (rowHalf - 0.3);
      const l1 = side * (w / 2 - 0.05);
      if (Math.abs(l1) - Math.abs(l0) < 0.3) continue;
      for (const [t0, t1] of vquad(geo.glass, at(s, l0, 0.05), at(s, l1, 0.05), at(s, l1, h), at(s, l0, h), uvRect(0, 0, 1, 1), dir, WHITE, not(e.id))) {
        boxes.beam(at(s, l0 + (l1 - l0) * t0, h), at(s, l0 + (l1 - l0) * t1, h), 0.08, 0.08, c.railLight);
      }
    }
    // 「改札」 sign above the row, both faces.
    const st = g.net.stations.find((x) => x.id === nodeOf(e.a).stationId || x.id === nodeOf(e.b).stationId);
    const label = (e.name ?? '改札').replace(/^\S+\s+/, '');
    const face: TX.SignEntry[] = [
      { arrow: null, badge: st?.badge ?? '改札', badgeColor: st?.color ?? '#444', badgeInk: '#fff', text: label.includes('改札') ? label : `${label} 改札` },
    ];
    const H = ceilingHeight(w) * ex;
    addSign(at(s, 0), dir, Math.min(4.2, w * 0.4), H, face, face);
  }

  function addShops(e: NetEdge, at: (s: number, lat: number, h?: number) => THREE.Vector3, s0: number, s1: number, side: number, hw: number, H: number, inward: THREE.Vector3): void {
    const lat = side * (hw - 0.04);
    const top = Math.min(2.8 * ex, H * 0.94);
    let s = s0 + 0.6;
    let k = Math.round(s0) * 7;
    while (s1 - 0.6 - s >= 3) {
      const r = hash01(e.id, k * 2 + (side > 0 ? 0 : 1));
      let L = 5 + r * 4;
      if (s + L > s1 - 0.6) L = s1 - 0.6 - s;
      if (L < 3) break;
      const cell = Math.floor(hash01(e.id, 100 + k * 2 + (side > 0 ? 0 : 1)) * TX.SHOP_CELLS);
      const [u0, v0, u1, v1] = TX.cellUV(cell, TX.SHOP_COLS, TX.SHOP_ROWS);
      // Text reads left→right from inside: along +dir on the left wall, -dir on the right wall.
      const uv: UV4 = side > 0 ? [u0, v0, u1, v0, u1, v1, u0, v1] : [u1, v0, u0, v0, u0, v1, u1, v1];
      geo.shop.quad(at(s, lat), at(s + L, lat), at(s + L, lat, top), at(s, lat, top), uv, inward);
      s += L + 0.45;
      k++;
    }
  }

  function addAds(e: NetEdge, at: (s: number, lat: number, h?: number) => THREE.Vector3, s0: number, s1: number, side: number, hw: number, inward: THREE.Vector3): void {
    const lat = side * (hw - 0.05);
    let k = Math.round(s0) * 7;
    for (let s = s0 + 4; s + 3 < s1 - 3; s += 16, k++) {
      if (hash01(e.id, 300 + k * 2 + (side > 0 ? 0 : 1)) > 0.55) continue;
      const cell = TX.AD_CELLS[Math.floor(hash01(e.id, 400 + k) * TX.AD_CELLS.length)];
      const [u0, v0, u1, v1] = TX.cellUV(cell, TX.SHOP_COLS, TX.SHOP_ROWS);
      const uv: UV4 = side > 0 ? [u0, v0, u1, v0, u1, v1, u0, v1] : [u1, v0, u0, v0, u0, v1, u1, v1];
      geo.shop.quad(at(s, lat, 0.9 * ex), at(s + 2.8, lat, 0.9 * ex), at(s + 2.8, lat, 2.3 * ex), at(s, lat, 2.3 * ex), uv, inward);
    }
  }

  function addLights(at: (s: number, lat: number, h?: number) => THREE.Vector3, s0: number, s1: number, w: number, H: number): void {
    const h = H - 0.03;
    if (w < 12) {
      // Recessed line lights in segments along the corridor.
      const lats = w >= 7 ? [-w / 4, w / 4] : [0];
      for (const lat of lats) {
        for (let s = s0 + 0.6; s + 2.4 <= s1 - 0.4; s += 3.4) {
          geo.light.quad(at(s, lat - 0.13, h), at(s + 2.4, lat - 0.13, h), at(s + 2.4, lat + 0.13, h), at(s, lat + 0.13, h), uvRect(0, 0, 1, 1), DOWN);
        }
      }
      return;
    }
    // Square panels on a 4.8 m grid in wide concourses.
    const across = Math.max(1, Math.floor((w - 3) / 4.8));
    for (let s = s0 + 2.4; s + 0.6 <= s1 - 0.6; s += 4.8) {
      for (let i = 0; i < across; i++) {
        const lat = (i - (across - 1) / 2) * 4.8;
        geo.light.quad(at(s - 0.6, lat - 0.6, h), at(s + 0.6, lat - 0.6, h), at(s + 0.6, lat + 0.6, h), at(s - 0.6, lat + 0.6, h), uvRect(0, 0, 1, 1), DOWN);
      }
    }
  }

  /** Travelators either side of the centre (the Hankyu one, Japan's first, runs both ways). */
  function addMovingWalkway(at: (s: number, lat: number, h?: number) => THREE.Vector3, s0: number, s1: number, w: number, dir: THREE.Vector3): void {
    const a = s0 + 3;
    const b = s1 - 3;
    if (b - a < 10) return;
    const yaw = yawOf(dir);
    const h = 0.95 * ex;
    for (const side of [1, -1]) {
      const lat = side * w * 0.27;
      const tw = 0.55;
      const q = [at(a, lat + tw, 0.14), at(b, lat + tw, 0.14), at(b, lat - tw, 0.14), at(a, lat - tw, 0.14)] as const;
      const vLen = (b - a) / TX.ESC_STEP;
      // Opposite directions on the two sides (treads move towards decreasing V).
      const uv: UV4 = side > 0 ? [1, vLen, 1, 0, 0, 0, 0, vLen] : [1, 0, 1, vLen, 0, vLen, 0, 0];
      geo.esc.quad(q[0], q[1], q[2], q[3], uv, UP);
      for (const edge of [-1, 1]) {
        const l = lat + edge * 0.68;
        boxes.beam(at(a, l, 0.12), at(b, l, 0.12), 0.3, 0.24, c.escDeck);
        geo.glass.quad(at(a, l, 0.24), at(b, l, 0.24), at(b, l, h), at(a, l, h), uvRect(0, 0, 1, 1), UP);
        boxes.beam(at(a - 0.5, l, h + 0.05), at(b + 0.5, l, h + 0.05), 0.09, 0.1, c.rail);
      }
      for (const s of [a - 0.7, b + 0.7]) boxes.add(at(s, lat, 0.1), _s.set(1.5, 0.05, 1.4), yaw, c.escDeck);
    }
  }

  function addPillars(e: NetEdge, at: (s: number, lat: number, h?: number) => THREE.Vector3, s0: number, s1: number, w: number, H: number): void {
    if (s1 - s0 < 8) return;
    // Pillar rows stand outside the band the crowd walks in (sim/crowd.ts lateralRoom), near the
    // walls; concourses too narrow for that get none.
    const band = lateralRoom(e.kind, e.width);
    const off = Math.min(w / 2 - 1, Math.max(w * 0.3, band + 0.7));
    if (off < band + 0.6) return;
    const lats = [-off, off];
    const yaw = yawOf(at(1, 0).sub(at(0, 0)));
    let k = 0;
    const own = not(e.id, `node:${e.a}`, `node:${e.b}`);
    for (let s = s0 + 4; s <= s1 - 4; s += 9, k++) {
      for (const lat of lats) {
        // No pillar where another walkway crosses the concourse.
        const p = at(s, lat);
        const r = 0.45 * (Math.abs(Math.cos(yaw)) + Math.abs(Math.sin(yaw)));
        if (space.intersectsBox(p.x - r, p.x + r, real(p.y), real(p.y) + H / ex, p.z - r, p.z + r, own)) continue;
        boxes.add(at(s, lat, H / 2), _s.set(0.8, H, 0.8), yaw, c.pillar);
        boxes.add(at(s, lat, 0.08 * ex), _s.set(0.86, 0.16 * ex, 0.86), yaw, c.pillarBase);
        // Every other pillar carries an illuminated advert wrap.
        if (hash01(e.id, 500 + k * 2 + (lat > 0 ? 1 : 0)) < 0.5) {
          glow.add(at(s, lat, 1.55 * ex), _s.set(0.86, 1.3 * ex, 0.86), yaw, adGlow[Math.floor(hash01(e.id, 600 + k) * adGlow.length)]);
        }
      }
    }
  }

  // ------------------------------------------------------------------ junction rooms
  const stationById = new Map(g.net.stations.map((s) => [s.id, s]));
  const toEntry = (t: SignTarget, arrow: TX.SignEntry['arrow']): TX.SignEntry =>
    t.kind === 'station'
      ? { arrow, badge: stationById.get(t.id)?.badge ?? '', badgeColor: stationById.get(t.id)?.color ?? '#555', badgeInk: '#ffffff', text: t.text }
      : { arrow, badge: '出口', badgeColor: '#f5c400', badgeInk: '#141414', text: t.text };

  const signCandidates: { prio: number; make: () => void }[] = [];

  for (const [id, list] of arms) {
    const n = nodeOf(id);
    if (!o.levelVisible(n.level)) continue;
    const C = P(n);
    const lift = 0.08;
    const solid = list.filter((a) => a.e.kind !== 'platform');
    if (solid.length === 0) continue;
    // Roofed when every corridor meeting here is enclosed (platform mouths stay open).
    const roofed = solid.every((a) => a.indoor);
    const Hn = Math.max(...solid.map((a) => a.H)) * ex;
    const dirOf = (a: ArmRec) => V(Math.cos(a.angle), 0, Math.sin(a.angle));
    const perpOf = (a: ArmRec) => V(-Math.sin(a.angle), 0, Math.cos(a.angle));

    if (list.length === 1) {
      // Dead end of an indoor corridor with nothing beyond it: close it (with doors at entrances).
      const a = list[0];
      if (!a.indoor || hasVertical.has(id) || onPlatform(n)) continue;
      const d = dirOf(a);
      const p = perpOf(a).multiplyScalar(a.width / 2);
      const H = a.H * ex;
      // The end wall (and entrance doors) stand 0.4 m behind the node, so a walker starting or
      // ending there is inside the corridor, not in the doorway.
      const back = d.clone().multiplyScalar(-0.4);
      const lo = C.clone().sub(p).add(back);
      const hi = C.clone().add(p).add(back);
      vquad(geo.wall, lo, hi, hi.clone().setY(C.y + H), lo.clone().setY(C.y + H), uvRect(0, 0, a.width / TX.WALL_M, 1), d, c.wallStation, not(a.e.id, `node:${id}`));
      if (n.kind === 'entrance') {
        const dw = Math.min(a.width * 0.8, 7);
        const q = perpOf(a).multiplyScalar(dw / 2);
        const off = d.clone().multiplyScalar(0.05).add(back);
        const top = Math.min(3 * ex, H * 0.95);
        const [u0, v0, u1, v1] = TX.cellUV(TX.DOOR_CELL, TX.SHOP_COLS, TX.SHOP_ROWS);
        // Seen from inside (facing -d) the reader's right is +perp.
        geo.shop.quad(C.clone().sub(q).add(off), C.clone().add(q).add(off), C.clone().add(q).add(off).setY(C.y + top), C.clone().sub(q).add(off).setY(C.y + top), [u0, v0, u1, v0, u1, v1, u0, v1], d);
      }
      continue;
    }

    // A floor disc as wide as the widest corridor fills the corners between the corridor mouths
    // (walk-space.ts counts the same disc as walkable; the crowd spreads across it).
    if (!onPlatform(n)) {
      const r = Math.max(...solid.map((a) => a.width)) / 2 - 0.1;
      const disc: THREE.Vector3[] = [];
      for (let i = 0; i < 12; i++) disc.push(C.clone().add(V(Math.cos((i * Math.PI) / 6) * r, lift, Math.sin((i * Math.PI) / 6) * r)));
      floorPoly(n.paid ? 'tile' : list.some((a) => a.indoor) ? 'stone' : 'paver', disc);
    }

    // Mouth corners, counter-clockwise by arm angle.
    const poly: THREE.Vector3[] = [];
    const mouths = list.map((a) => {
      const m = C.clone().add(dirOf(a).multiplyScalar(a.trim));
      const p = perpOf(a).multiplyScalar(a.width / 2);
      const lo = m.clone().sub(p);
      const hi = m.clone().add(p);
      poly.push(lo, hi);
      return { lo, hi };
    });
    const kind: FloorKind = n.paid ? 'tile' : list.some((a) => a.indoor) ? 'stone' : 'paver';
    const liftV = V(0, lift, 0);
    // Corners on enclosed corridors' walls get the same contact shadow as the corridor floors.
    const shade = list.flatMap((a) => (a.indoor ? [AO, AO] : [1, 1]));
    for (let i = 0; i < poly.length; i++) {
      const j = (i + 1) % poly.length;
      floorPoly(kind, [C.clone().add(liftV), poly[i].clone().add(liftV), poly[j].clone().add(liftV)], [1, shade[i], shade[j]]);
    }
    if (!roofed) continue;

    const hv = V(0, Hn, 0);
    for (let i = 0; i < poly.length; i++) {
      const p0 = poly[i].clone().add(hv).setY(C.y + Hn);
      const p1 = poly[(i + 1) % poly.length].clone().add(hv).setY(C.y + Hn);
      ceilPoly([C.clone().add(hv), p0, p1]);
    }
    const lp = 0.8;
    geo.light.quad(C.clone().add(V(-lp, Hn - 0.03, -lp)), C.clone().add(V(lp, Hn - 0.03, -lp)), C.clone().add(V(lp, Hn - 0.03, lp)), C.clone().add(V(-lp, Hn - 0.03, lp)), uvRect(0, 0, 1, 1), DOWN);
    for (let k = 0; k < list.length; k++) {
      const next = (k + 1) % list.length;
      const p0 = mouths[k].hi;
      const p1 = mouths[next].lo;
      const len = p0.distanceTo(p1);
      if (len > 0.05 && list[k].indoor && list[next].indoor) {
        const mid = p0.clone().add(p1).multiplyScalar(0.5);
        const inward = C.clone().sub(mid).setY(0);
        if (inward.lengthSq() < 1e-6) inward.copy(dirOf(list[k]));
        vquad(geo.wall, p0, p1, p1.clone().add(hv), p0.clone().add(hv), uvRect(0, 0, len / TX.WALL_M, 1), inward, c.wallStation, not(`node:${id}`));
      }
      // Bulkhead above a lower corridor opening into a taller junction.
      const a = list[k];
      const Ha = a.H * ex;
      if (a.indoor && Ha < Hn - 0.05) {
        const { lo, hi } = mouths[k];
        geo.wall.quad(lo.clone().setY(C.y + Ha), hi.clone().setY(C.y + Ha), hi.clone().setY(C.y + Hn), lo.clone().setY(C.y + Hn), uvRect(0, 0.9, a.width / TX.WALL_M, 1), dirOf(a).negate(), c.wallStation);
      }
    }

    // Hanging wayfinding signs across each long corridor leaving a real junction.
    if (list.length < 3) continue;
    const ni = idxOf(id);
    list.forEach((arm, k) => {
      if (arm.e.kind !== 'walk' || arm.run < 12) return;
      const onRoute = route.has(arm.e.id);
      signCandidates.push({
        prio: (onRoute ? 10 : 0) + (arm.e.busy ?? 1),
        make: () => {
          const d = dirOf(arm);
          const sAt = Math.min(arm.trim + 3, arm.run * 0.4);
          const pos = C.clone().add(d.clone().multiplyScalar(sAt));
          // Face A looks back into the corridor: read by people walking towards the junction.
          const heading = arm.angle + Math.PI;
          const faceA: TX.SignEntry[] = [];
          const used = new Set<string>();
          const others = list.filter((_, j) => j !== k).map((x) => ({ x, t: destinationsVia(g, ni, x.other, x.run)[0] }));
          others.sort((p, q) => (p.t?.dist ?? 1e9) - (q.t?.dist ?? 1e9));
          for (const { x, t } of others) {
            if (!t || used.has(t.text) || faceA.length >= 2) continue;
            used.add(t.text);
            faceA.push(toEntry(t, arrowFor(heading, x.angle)));
          }
          // Face B looks at the junction: what lies ahead down this corridor.
          const faceB = destinationsVia(g, ni, arm.other, arm.run)
            .slice(0, 2)
            .map((t) => toEntry(t, 0));
          if (faceA.length === 0 && faceB.length === 0) return;
          const filler = (): TX.SignEntry[] => [{ arrow: null, badge: n.level, badgeColor: '#5b636c', badgeInk: '#fff', text: arm.e.name ?? n.name }];
          addSign(pos, d, Math.min(3.6, arm.width * 0.55), arm.H * ex, faceA.length ? faceA : filler(), faceB.length ? faceB : filler());
        },
      });
    });
  }
  signCandidates.sort((p, q) => q.prio - p.prio);
  for (const s of signCandidates.slice(0, 44)) s.make();

  function addSign(at: THREE.Vector3, normal: THREE.Vector3, width: number, ceilH: number | null, a: TX.SignEntry[], b: TX.SignEntry[]): void {
    faces.push(a, b);
    const bottom = Math.min(2.4 * ex, (ceilH ?? 99) - 0.55 * ex);
    signs.push({ at, normal: normal.clone().setY(0).normalize(), width, bottom, ceil: ceilH, faceA: faces.length - 2, faceB: faces.length - 1 });
  }

  // Platform slabs (tiles, coping, white line, tactile strip, stair-well parapets) are drawn by
  // station.ts, which cuts its wells with the same lane table (verticalLaneOffsets).

  /**
   * Platform slab: tiled top with the stair wells cut out, white edge lines and yellow tactile
   * strips, concrete faces towards the tracks (the view's coloured platform boxes are for the
   * overview).
   */
  // ------------------------------------------------------------------ stairs, escalators, elevators
  for (const f of flights) {
    const A = P(f.lo);
    const B = P(f.hi);
    const { dir, left, run } = frame(A, B);
    const rise = B.y - A.y;
    // Height profile along the staircase (flights and landings), s measured from its foot.
    const prof = [{ s: 0, y: A.y }, ...f.segs.map((sg) => ({ s: Math.max(0, P(sg.b).sub(A).dot(dir)), y: P(sg.b).y }))];
    const yOn = (s: number) => {
      if (s <= prof[0].s) return prof[0].y;
      for (let i = 1; i < prof.length; i++) {
        const p0 = prof[i - 1];
        const p1 = prof[i];
        if (s <= p1.s) return p1.s - p0.s < 1e-6 ? p1.y : p0.y + ((p1.y - p0.y) * (s - p0.s)) / (p1.s - p0.s);
      }
      return prof[prof.length - 1].y;
    };
    const line = (s: number, lat: number, h = 0) => V(A.x + dir.x * s + left.x * lat, yOn(s) + h, A.z + dir.z * s + left.z * lat);
    const skipOwn = (p: WalkPiece) => f.ids.has(p.id) || p.id === `node:${f.hi.id}` || p.id === `node:${f.lo.id}`;

    if (f.kind === 'elevator') {
      addElevator(f.segs[0].e, A, B, f.lo, f.hi);
      continue;
    }
    for (const sg of f.segs) {
      const a = P(sg.a);
      const b = P(sg.b);
      const fr = frame(a, b);
      const segRise = b.y - a.y;
      const segLine = (s: number, lat: number, h = 0) => V(a.x + fr.dir.x * s + fr.left.x * lat, a.y + segRise * (fr.run > 1e-3 ? s / fr.run : 0) + h, a.z + fr.dir.z * s + fr.left.z * lat);
      if (Math.abs(sg.b.y - sg.a.y) < 0.05) addLanding(segLine, fr.run, f.w, fr.dir, fr.left);
      else if (f.kind === 'stairs') addStairs(segLine, 0, f.w, fr.run, segRise, Math.abs(sg.b.y - sg.a.y), fr.dir, fr.left, f.indoor);
      else addEscalator(sg.e, segLine, 0, fr.run, segRise, fr.dir, nodeOf(sg.e.a), nodeOf(sg.e.b));
    }
    if (run < 0.5 || rise < 1) continue;

    // The upper landing is under a roof (a corridor or concourse) or open (a platform / deck).
    const upperRoofed = !onPlatform(f.hi) && (arms.get(f.hi.id) ?? []).every((a) => a.indoor || a.e.kind === 'platform');
    const rh = 1.1 * ex;
    const lmin = -f.w / 2 - 0.15;
    const lmax = f.w / 2 + 0.15;

    // Balustrade around the opening in the upper floor (open at the top of the flight): glass
    // in concourses, solid panels on platforms. Clipped where a walkway meets the opening.
    const sw = wellStart(f, run);
    const edge = (s: number, lat: number) => line(s, lat).setY(B.y);
    const sides: [THREE.Vector3, THREE.Vector3, THREE.Vector3][] = [
      [edge(sw, lmin - 0.08), edge(run, lmin - 0.08), left.clone().negate()],
      [edge(sw, lmax + 0.08), edge(run, lmax + 0.08), left],
      [edge(sw, lmin - 0.08), edge(sw, lmax + 0.08), dir.clone().negate()],
    ];
    for (const [p0, p1, out] of sides) {
      const t0 = p0.clone().setY(p0.y + rh);
      const t1 = p1.clone().setY(p1.y + rh);
      const runs =
        upperRoofed || !f.indoor
          ? vquad(geo.glass, p0, p1, t1, t0, uvRect(0, 0, 1, 1), UP, WHITE, skipOwn)
          : vquad(geo.wall, p0, p1, t1, t0, uvRect(0, 0, p0.distanceTo(p1) / TX.WALL_M, 0.3), out, c.wallStation, skipOwn);
      for (const [a0, a1] of runs) boxes.beam(t0.clone().lerp(t1, a0), t0.clone().lerp(t1, a1), 0.08, 0.08, c.railLight);
    }

    // One enclosure around the flight. Where the upper floor still runs over the flight (its
    // lower part, s < sw) the walls stop under that floor and a soffit closes them; around the
    // opening (s ≥ sw) the well is double height with a flat ceiling at the upper level's ceiling
    // height (parapet height under an open platform). A bulkhead closes the gap over the lower
    // opening. Walls are clipped wherever a walkway runs beside or across the well.
    if (!f.indoor) continue;
    const H = 3.0 * ex;
    const top = rise + (upperRoofed ? H : rh); // above the foot
    const below = -1.4 * ex;
    const flat = (s: number, lat: number, h: number) => line(s, lat).setY(A.y + h);
    const tint = c.wallStation;
    const low = tint.clone().multiplyScalar(0.8);
    const swW = Math.min(run, sw);
    // Side walls stop at the lower level's ceiling: around the foot of the flight the lower
    // concourse stays open (people walk past it there).
    let sx = run;
    for (let s = 0; s <= run; s += 0.25) {
      if (yOn(s) - A.y >= H - below) {
        sx = s;
        break;
      }
    }
    const cuts = [...new Set([0, sx, swW, run].map((v) => Math.round(v * 1000) / 1000))].sort((a, b) => a - b);
    for (const [lat, want] of [[lmin, left], [lmax, left.clone().negate()]] as const) {
      for (let i = 1; i < cuts.length; i++) {
        const s0 = cuts[i - 1];
        const s1 = cuts[i];
        if (s1 - s0 < 0.05) continue;
        const cap = s0 >= swW - 1e-3 ? top : rise;
        const hang = s1 <= sx + 1e-3; // hangs from the lower ceiling (open below)
        const b0 = hang ? flat(s0, lat, H) : line(s0, lat, below);
        const b1 = hang ? flat(s1, lat, H) : line(s1, lat, below);
        if (Math.max(b0.y, b1.y) >= A.y + cap - 0.05) continue;
        const v0 = hang ? H / top : 0;
        vquad(geo.wall, b0, b1, flat(s1, lat, cap), flat(s0, lat, cap), [s0 / TX.WALL_M, v0, s1 / TX.WALL_M, v0, s1 / TX.WALL_M, cap / top, s0 / TX.WALL_M, cap / top], want, hang ? tint : [low, low, tint, tint], skipOwn);
      }
    }
    const bulkTop = swW > 0.05 ? rise : upperRoofed ? top : rise;
    if (bulkTop > H + 0.1) {
      vquad(geo.wall, flat(0, lmin, H), flat(0, lmax, H), flat(0, lmax, bulkTop), flat(0, lmin, bulkTop), uvRect(0, 0.85, (lmax - lmin) / TX.WALL_M, 1), dir, tint, skipOwn);
    }
    if (swW > 0.05 && rise > H + 0.1) {
      // Soffit of the upper floor over the covered part of the flight.
      const q = [flat(0, lmin, rise - 0.02), flat(swW, lmin, rise - 0.02), flat(swW, lmax, rise - 0.02), flat(0, lmax, rise - 0.02)] as const;
      geo.ceil.quad(q[0], q[1], q[2], q[3], gridUV(q[0], q[1], q[2], q[3], TX.CEIL_M), DOWN);
    }
    if (!upperRoofed || run - swW < 0.3) continue;
    const q = [flat(swW, lmin, top), flat(run, lmin, top), flat(run, lmax, top), flat(swW, lmax, top)] as const;
    geo.ceil.quad(q[0], q[1], q[2], q[3], gridUV(q[0], q[1], q[2], q[3], TX.CEIL_M), DOWN);
    for (let s = swW + 0.8; s + 2.4 <= run - 0.4; s += 3.4) {
      geo.light.quad(flat(s, -0.13, top - 0.03), flat(s + 2.4, -0.13, top - 0.03), flat(s + 2.4, 0.13, top - 0.03), flat(s, 0.13, top - 0.03), uvRect(0, 0, 1, 1), DOWN);
    }
  }

  /** Level stair landing: slab with a soffit and side faces, same finish as the treads. */
  function addLanding(line: (s: number, lat: number, h?: number) => THREE.Vector3, run: number, sw: number, dir: THREE.Vector3, left: THREE.Vector3): void {
    const L0 = -sw / 2;
    const L1 = sw / 2;
    const th = 0.3;
    geo.stair.quad(line(0, L0), line(run, L0), line(run, L1), line(0, L1), [0, 1, 0, 0.5, 1, 0.5, 1, 1], UP);
    geo.stair.quad(line(0, L0, -th), line(run, L0, -th), line(run, L1, -th), line(0, L1, -th), [0, 0, 1, 0, 1, 0.25, 0, 0.25], DOWN);
    geo.stair.quad(line(0, L0, -th), line(run, L0, -th), line(run, L0), line(0, L0), [0, 0, 1, 0, 1, 0.25, 0, 0.25], left.clone().negate());
    geo.stair.quad(line(0, L1, -th), line(run, L1, -th), line(run, L1), line(0, L1), [0, 0, 1, 0, 1, 0.25, 0, 0.25], left);
    const hr = 0.85 * ex;
    for (const lat of [L0 + 0.12, L1 - 0.12]) boxes.beam(line(0, lat, hr), line(run, lat, hr), 0.06, 0.07, c.steel);
    void dir;
  }

  function addStairs(
    line: (s: number, lat: number, h?: number) => THREE.Vector3,
    off: number,
    sw: number,
    run: number,
    rise: number,
    realRise: number,
    dir: THREE.Vector3,
    left: THREE.Vector3,
    indoor: boolean,
  ): void {
    const n = Math.min(80, Math.max(3, Math.round(realRise / 0.17)));
    const d = run / n;
    const r = rise / n;
    const hw = sw / 2;
    const L0 = off - hw;
    const L1 = off + hw;
    const back = dir.clone().negate();
    if (d > 1.1 || run < 0.5) {
      // Too shallow for steps (or no run at all): a sloped passage in terrazzo.
      const q = [line(0, L1, 0.06), line(run, L1, 0.06), line(run, L0, 0.06), line(0, L0, 0.06)] as const;
      if (run >= 0.5) floorQuad('stone', q[0], q[1], q[2], q[3]);
    } else {
      const th = 0.25;
      for (let i = 0; i < n; i++) {
        const sA = i * d;
        const sB = (i + 1) * d;
        // The step top sits on the walking line at the step's middle.
        const topAbs = line(0, 0).y + (i + 0.5) * r;
        const bot = topAbs - Math.abs(r) - th;
        const p = (s: number, lat: number, y: number) => {
          const q = line(s, lat);
          q.y = y;
          return q;
        };
        // Tread (top half of the atlas, nosing at the front edge = V 1).
        geo.stair.quad(p(sA, L0, topAbs), p(sB, L0, topAbs), p(sB, L1, topAbs), p(sA, L1, topAbs), [0, 1, 0, 0.5, 1, 0.5, 1, 1], UP);
        // Riser facing the lower end.
        geo.stair.quad(p(sA, L0, bot), p(sA, L1, bot), p(sA, L1, topAbs), p(sA, L0, topAbs), [0, 0.25, 1, 0.25, 1, 0.5, 0, 0.5], back);
        // Stringer sides.
        geo.stair.quad(p(sA, L0, bot), p(sB, L0, bot), p(sB, L0, topAbs), p(sA, L0, topAbs), [0, 0, 1, 0, 1, 0.25, 0, 0.25], left.clone().negate());
        geo.stair.quad(p(sA, L1, bot), p(sB, L1, bot), p(sB, L1, topAbs), p(sA, L1, topAbs), [0, 0, 1, 0, 1, 0.25, 0, 0.25], left);
      }
      // Soffit under the flight.
      const u = [line(0, L0, -Math.abs(r) - 0.25), line(run, L0, -Math.abs(r) - 0.25), line(run, L1, -Math.abs(r) - 0.25), line(0, L1, -Math.abs(r) - 0.25)] as const;
      geo.stair.quad(u[0], u[1], u[2], u[3], [0, 0, 1, 0, 1, 0.25, 0, 0.25], DOWN);
    }
    // Handrails on both sides (on posts outdoors, where there are no walls to carry them).
    const hr = 0.85 * ex;
    for (const lat of [L0 + 0.12, L1 - 0.12]) {
      boxes.beam(line(0, lat, hr), line(run, lat, hr), 0.06, 0.07, indoor ? c.steel : c.railLight);
      if (!indoor) {
        const posts = Math.max(2, Math.round(run / 2.5));
        for (let i = 0; i <= posts; i++) {
          const s = (i / posts) * run;
          boxes.add(line(s, lat, hr / 2), _s.set(0.05, hr, 0.05), yawOf(dir), c.railLight);
        }
      }
    }
    if (!indoor) {
      // Low glass parapets on outdoor flights (pedestrian-bridge stairs).
      for (const lat of [L0 - 0.05, L1 + 0.05]) {
        geo.glass.quad(line(0, lat, 0), line(run, lat, 0), line(run, lat, 1.05 * ex), line(0, lat, 1.05 * ex), uvRect(0, 0, 1, 1), left);
      }
    }
  }

  function addEscalator(
    e: NetEdge,
    line: (s: number, lat: number, h?: number) => THREE.Vector3,
    off: number,
    run: number,
    rise: number,
    dir: THREE.Vector3,
    na: NetNode,
    nb: NetNode,
  ): void {
    const len = Math.hypot(run, rise);
    const pitch = -Math.atan2(rise, Math.max(run, 0.01));
    const yaw = yawOf(dir);
    const mid = line(run / 2, off);
    // Truss below the steps, stainless decks and black handrails on glass balustrades.
    boxes.add(mid.clone().add(V(0, -0.55, 0)), _s.set(1.6, 1.0, len), yaw, c.escTruss, pitch);
    const tw = 0.5;
    const t = [line(0, off - tw, 0.04), line(run, off - tw, 0.04), line(run, off + tw, 0.04), line(0, off + tw, 0.04)] as const;
    // Treads scroll towards decreasing V (the texture offset grows), so V must grow against the
    // direction of travel: 'up' travels lo→hi; 'down' hi→lo; 'both' follows the edge a→b.
    const upward = e.dir === 'up' ? true : e.dir === 'down' ? false : nb.y > na.y;
    const vLen = len / TX.ESC_STEP;
    const uv: UV4 = upward ? [0, vLen, 0, 0, 1, 0, 1, vLen] : [0, 0, 0, vLen, 1, vLen, 1, 0];
    geo.esc.quad(t[0], t[1], t[2], t[3], uv, UP);
    const h = 0.95 * ex;
    for (const side of [-1, 1]) {
      const lat = off + side * 0.62;
      boxes.beam(line(0, off + side * 0.72, 0.12), line(run, off + side * 0.72, 0.12), 0.26, 0.2, c.escDeck);
      geo.glass.quad(line(0, lat, 0.2), line(run, lat, 0.2), line(run, lat, h), line(0, lat, h), uvRect(0, 0, 1, 1), UP);
      // Handrails follow the incline, then level off for 0.6 m at each end (newels).
      const r0 = line(0, lat, h + 0.05);
      const r1 = line(run, lat, h + 0.05);
      boxes.beam(r0, r1, 0.09, 0.1, c.rail);
      boxes.beam(r0.clone().sub(dir.clone().multiplyScalar(0.6)), r0, 0.09, 0.1, c.rail);
      boxes.beam(r1, r1.clone().add(dir.clone().multiplyScalar(0.6)), 0.09, 0.1, c.rail);
    }
    // Landing plates at both ends.
    const endA = line(0, off).sub(dir.clone().multiplyScalar(0.7));
    const endB = line(run, off).add(dir.clone().multiplyScalar(0.7));
    boxes.add(endA.add(V(0, 0.04, 0)), _s.set(1.3, 0.05, 1.4), yaw, c.escDeck);
    boxes.add(endB.add(V(0, 0.04, 0)), _s.set(1.3, 0.05, 1.4), yaw, c.escDeck);
  }

  /**
   * Glass lift shaft around the cabin line (both landings share x, z). Each landing gets a door
   * opening in the face its walkway leaves through; the doors are drawn open (slid aside).
   */
  function addElevator(e: NetEdge, lo: THREE.Vector3, hi: THREE.Vector3, loNode: NetNode, hiNode: NetNode): void {
    const S = lo;
    const y0 = lo.y;
    const y1 = hi.y;
    const top = y1 + 3.0 * ex;
    const hs = 1.2;
    // Face directions: the shaft is aligned with its first walkway (else with x).
    const exitDir = (n: NetNode) => {
      for (const x of g.edges) {
        if (x.kind !== 'walk' || (x.a !== n.id && x.b !== n.id)) continue;
        const o = nodeOf(x.a === n.id ? x.b : x.a);
        const d = V(o.x - n.x, 0, o.z - n.z);
        if (d.lengthSq() > 0.01) return d.normalize();
      }
      return null;
    };
    const dLo = exitDir(loNode);
    const dHi = exitDir(hiNode);
    const dir = (dLo ?? dHi ?? V(1, 0, 0)).clone();
    const left = V(-dir.z, 0, dir.x);
    const yaw = yawOf(dir);
    const faceOf = (d: THREE.Vector3 | null) => {
      if (!d) return -1;
      const fs = [dir, left, dir.clone().negate(), left.clone().negate()];
      let best = 0;
      for (let i = 1; i < 4; i++) if (fs[i].dot(d) > fs[best].dot(d)) best = i;
      return best;
    };
    const doorH = 2.2 * ex;
    const doors: { face: number; y: number }[] = [];
    if (faceOf(dLo) >= 0) doors.push({ face: faceOf(dLo), y: y0 });
    if (faceOf(dHi) >= 0) doors.push({ face: faceOf(dHi), y: y1 });
    const normals = [dir, left, dir.clone().negate(), left.clone().negate()];
    for (let fi = 0; fi < 4; fi++) {
      const nrm = normals[fi];
      const side = V(nrm.z, 0, -nrm.x);
      const c0 = S.clone().add(nrm.clone().multiplyScalar(hs));
      const P2_ = (lat: number, y: number) => c0.clone().add(side.clone().multiplyScalar(lat)).setY(y);
      const glass = (l0: number, l1: number, ya: number, yb: number) => {
        if (l1 - l0 < 0.02 || yb - ya < 0.02) return;
        geo.glass.quad(P2_(l0, ya), P2_(l1, ya), P2_(l1, yb), P2_(l0, yb), uvRect(0, 0, 1, 1), nrm);
      };
      const here = doors.filter((d) => d.face === fi).sort((p, q) => p.y - q.y);
      let y = y0 - 0.2;
      for (const d of here) {
        glass(-hs, hs, y, d.y);
        glass(-hs, -0.55, d.y, d.y + doorH);
        glass(0.55, hs, d.y, d.y + doorH);
        // Frame posts, lintel and the two door leaves standing open behind the side panels.
        boxes.add(P2_(-0.6, d.y + doorH / 2), _s.set(0.1, doorH, 0.14), yawOf(nrm), c.frame);
        boxes.add(P2_(0.6, d.y + doorH / 2), _s.set(0.1, doorH, 0.14), yawOf(nrm), c.frame);
        boxes.add(P2_(0, d.y + doorH + 0.06), _s.set(1.3, 0.12, 0.14), yawOf(nrm), c.frame);
        for (const sgn of [-1, 1]) boxes.add(P2_(sgn * 0.88, d.y + doorH / 2).sub(nrm.clone().multiplyScalar(0.08)), _s.set(0.04, doorH * 0.95, 0.6), yawOf(nrm), c.steel);
        glow.add(P2_(0.85, d.y + 1.0 * ex).add(nrm.clone().multiplyScalar(0.06)), _s.set(0.12, 0.25 * ex, 0.03), yawOf(nrm), c.callPanel);
        y = d.y + doorH;
      }
      glass(-hs, hs, y, top);
    }
    for (const [i0, j0] of [[1, 1], [1, -1], [-1, -1], [-1, 1]]) {
      const corner = S.clone().add(dir.clone().multiplyScalar(i0 * hs)).add(left.clone().multiplyScalar(j0 * hs));
      boxes.add(corner.setY((y0 + top) / 2), _s.set(0.14, top - y0 + 0.2, 0.14), yaw, c.frame);
    }
    boxes.add(S.clone().setY(top + 0.12), _s.set(2.6, 0.24, 2.6), yaw, c.frame);
    // Moving cabin (animated in updateWalkway).
    const ch = 2.4 * ex;
    cabins.add(S.clone().setY(y0 + ch / 2), _s.set(2.1, ch, 2.1), yaw, c.steel);
    cabinData.push(S.x, S.z, yaw, y0 + 0.02, y1 + 0.02, ch, hash01(e.id) * 40, 3 + Math.abs(y1 - y0) / ex * 0.5, 5);
  }

  // ------------------------------------------------------------------ materials and meshes
  const cut = sharedCut;
  const textures: THREE.Texture[] = [];
  const keep = <T extends THREE.Texture | null>(t: T): T => {
    if (t) textures.push(t);
    return t;
  };
  const tex = {
    tile: keep(TX.tileTexture()),
    stone: keep(TX.stoneTexture()),
    paver: keep(TX.paverTexture()),
    asphalt: keep(TX.asphaltTexture()),
    tactile: keep(TX.tactileTexture()),
    wall: keep(TX.wallTexture()),
    ceil: keep(TX.ceilingTexture()),
    stair: keep(TX.stairTexture()),
    esc: keep(TX.escalatorTexture()),
    shop: keep(TX.shopAtlas()),
  };
  const lambert = (map: THREE.Texture | null, fallback: string, extra: THREE.MeshLambertMaterialParameters = {}) =>
    withCut(new THREE.MeshLambertMaterial({ map, color: map ? new THREE.Color(dim, dim, dim) : col(fallback, dim), ...extra }), cut);

  // Signs: build the atlas now that every face is known; one extra blank face for the edges.
  faces.push([]);
  const atlas = TX.signAtlas(faces);
  if (atlas) keep(atlas.tex);
  const rows = atlas?.rows ?? Math.ceil(faces.length / TX.SIGN_COLS);
  const blank = TX.cellUV(faces.length - 1, TX.SIGN_COLS, rows, 0.01);
  const blankUV: UV4 = [blank[0], blank[1], blank[0], blank[1], blank[0], blank[1], blank[0], blank[1]];
  for (const s of signs) {
    const nrm = s.normal;
    const r = V(nrm.z, 0, -nrm.x); // reader's right when facing -normal
    const hw = s.width / 2;
    const hh = 0.42 * ex;
    const dep = 0.07;
    const base = s.at.clone().setY(s.at.y + s.bottom);
    const pt = (lat: number, h: number, depth: number) => base.clone().add(r.clone().multiplyScalar(lat)).add(nrm.clone().multiplyScalar(depth)).setY(base.y + h);
    const [a0, b0, a1, b1] = TX.cellUV(s.faceA, TX.SIGN_COLS, rows);
    const [c0, d0, c1, d1] = TX.cellUV(s.faceB, TX.SIGN_COLS, rows);
    geo.sign.quad(pt(-hw, 0, dep), pt(hw, 0, dep), pt(hw, hh, dep), pt(-hw, hh, dep), [a0, b0, a1, b0, a1, b1, a0, b1], nrm);
    geo.sign.quad(pt(hw, 0, -dep), pt(-hw, 0, -dep), pt(-hw, hh, -dep), pt(hw, hh, -dep), [c0, d0, c1, d0, c1, d1, c0, d1], nrm.clone().negate());
    geo.sign.quad(pt(-hw, hh, dep), pt(hw, hh, dep), pt(hw, hh, -dep), pt(-hw, hh, -dep), blankUV, UP);
    geo.sign.quad(pt(-hw, 0, dep), pt(hw, 0, dep), pt(hw, 0, -dep), pt(-hw, 0, -dep), blankUV, DOWN);
    geo.sign.quad(pt(-hw, 0, dep), pt(-hw, 0, -dep), pt(-hw, hh, -dep), pt(-hw, hh, dep), blankUV, r.clone().negate());
    geo.sign.quad(pt(hw, 0, dep), pt(hw, 0, -dep), pt(hw, hh, -dep), pt(hw, hh, dep), blankUV, r);
    if (s.ceil !== null && s.ceil > s.bottom + hh) {
      for (const lat of [-hw * 0.7, hw * 0.7]) {
        const y0 = base.y + hh;
        const y1 = s.at.y + s.ceil;
        boxes.add(pt(lat, hh + (y1 - y0) / 2, 0), _s.set(0.04, y1 - y0, 0.04), yawOf(nrm), c.signRod);
      }
    }
  }

  const meshes: (THREE.Mesh | null)[] = [
    // Where floors of different finishes overlap (junctions, corridor ends), a fixed depth
    // priority decides which one shows: station tiles over terrazzo over pavers over asphalt.
    geo.tile.mesh(lambert(tex.tile, '#d8cfc2', { vertexColors: true, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }), 'floor-tile'),
    geo.stone.mesh(lambert(tex.stone, '#cfc6b8', { vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }), 'floor-stone'),
    geo.paver.mesh(lambert(tex.paver, '#a39e96', { vertexColors: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }), 'floor-paver'),
    geo.asphalt.mesh(lambert(tex.asphalt, '#4c4f53', { vertexColors: true }), 'floor-asphalt'),
    geo.marks.mesh(withCut(new THREE.MeshLambertMaterial({ vertexColors: true }), cut), 'markings'),
    geo.tactile.mesh(lambert(tex.tactile, '#e9b400'), 'tactile'),
    geo.wall.mesh(lambert(tex.wall, '#e6e6e2', { vertexColors: true, emissive: new THREE.Color(0.1, 0.1, 0.1).multiplyScalar(dim) }), 'walls'),
    geo.ceil.mesh(lambert(tex.ceil, '#ecebe6', { emissive: new THREE.Color(0.32, 0.32, 0.31).multiplyScalar(dim), emissiveMap: tex.ceil }), 'ceilings'),
    geo.light.mesh(withCut(new THREE.MeshBasicMaterial({ color: '#fffaf0' }), cut), 'ceiling-lights'),
    geo.shop.mesh(lambert(tex.shop, '#f3dcb4', { emissive: new THREE.Color(1, 1, 1), emissiveMap: tex.shop, emissiveIntensity: o.dark ? 0.62 : 0.5 }), 'shopfronts'),
    geo.sign.mesh(withCut(new THREE.MeshBasicMaterial({ map: atlas?.tex ?? null, color: atlas ? '#ffffff' : '#1b1d20' }), cut), 'signs'),
    geo.stair.mesh(lambert(tex.stair, '#b0aaa0'), 'stairs'),
    geo.esc.mesh(lambert(tex.esc, '#4a4e53'), 'escalator-treads'),
    geo.glass.mesh(
      withCut(new THREE.MeshLambertMaterial({ color: '#c9e2ee', transparent: true, opacity: o.dark ? 0.2 : 0.24, depthWrite: false, side: THREE.DoubleSide }), cut),
      'glass',
    ),
    boxes.mesh(withCut(new THREE.MeshLambertMaterial(), cut), 'fittings'),
    glow.mesh(withCut(new THREE.MeshBasicMaterial(), cut), 'lamps'),
  ];
  const cabinMesh = cabins.mesh(withCut(new THREE.MeshLambertMaterial(), cut), 'elevator-cabins');
  if (cabinMesh) {
    cabinMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    cabinMesh.frustumCulled = false;
    meshes.push(cabinMesh);
  }
  for (const m of meshes) {
    if (!m) continue;
    if (m.name === 'glass') m.renderOrder = 3;
    group.add(m);
  }

  const state: WalkState = { time: 0, esc: tex.esc, cabins: cabinMesh, cabinData: new Float32Array(cabinData), cut, textures };
  group.userData.walkway = state;
  return group;
}

/**
 * Per-frame animation: escalator treads, elevator cabins and the chase-camera cut-away (pass the
 * camera position and a point on the walker; null disables it, e.g. in first person).
 * Allocation-free.
 */
export function updateWalkway(group: THREE.Object3D, dt: number, cut: WalkCut | null = null): void {
  const s = group.userData.walkway as WalkState | undefined;
  if (!s) return;
  s.time += dt;
  // 0.5 m/s real tread speed.
  if (s.esc) s.esc.offset.y = ((s.time * 0.5) / TX.ESC_STEP) % 1;
  const m = s.cabins;
  if (m) {
    const d = s.cabinData;
    for (let i = 0; i * CABIN_STRIDE < d.length; i++) {
      const k = i * CABIN_STRIDE;
      const f = cabinCycle(s.time + d[k + 6], d[k + 7], d[k + 8]);
      _p.set(d[k], d[k + 3] + (d[k + 4] - d[k + 3]) * f + d[k + 5] / 2, d[k + 1]);
      _q.setFromEuler(_e.set(0, d[k + 2], 0));
      _m.compose(_p, _q, _s.set(2.1, d[k + 5], 2.1));
      m.setMatrixAt(i, _m);
    }
    m.instanceMatrix.needsUpdate = true;
  }
  if (cut) {
    s.cut.uCutA.value.copy(cut.eye);
    s.cut.uCutB.value.copy(cut.target);
    s.cut.uCutR.value = CUT_RADIUS;
  } else {
    s.cut.uCutR.value = 0;
  }
}

/** Frees every geometry, material and texture created by `buildWalkway`. */
export function disposeWalkway(group: THREE.Object3D): void {
  group.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    const mat = mesh.material as THREE.Material | THREE.Material[];
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else mat.dispose();
    if ((mesh as THREE.InstancedMesh).isInstancedMesh) (mesh as THREE.InstancedMesh).dispose();
  });
  const s = group.userData.walkway as WalkState | undefined;
  if (s) for (const t of s.textures) t.dispose();
  delete group.userData.walkway;
  sharedCut.uCutR.value = 0;
}

/** Draw calls and triangles of a walkway group (for budgets and tests). */
export function walkwayStats(group: THREE.Object3D): { drawCalls: number; triangles: number } {
  let drawCalls = 0;
  let triangles = 0;
  group.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    drawCalls++;
    const g = mesh.geometry;
    const tris = (g.index ? g.index.count : g.getAttribute('position').count) / 3;
    triangles += tris * ((mesh as THREE.InstancedMesh).isInstancedMesh ? (mesh as THREE.InstancedMesh).count : 1);
  });
  return { drawCalls, triangles };
}

/**
 * A train standing at a platform (boxes per car with a window band), on the track beside the
 * platform's first listed side.
 */
export function buildTrain(p: Platform, color: string, Y: (y: number) => number, ex: number, side: 1 | -1 = 1): THREE.Group {
  const group = new THREE.Group();
  const a = new THREE.Vector3(p.a[0], Y(p.y), p.a[1]);
  const b = new THREE.Vector3(p.b[0], Y(p.y), p.b[1]);
  const { dir, left, run } = frame(a, b);
  const carLen = 19.5;
  const gap = 0.8;
  const cars = Math.max(2, Math.min(10, Math.floor((run * 0.85) / (carLen + gap))));
  const total = cars * (carLen + gap) - gap;
  const start = a.clone().lerp(b, 0.5).sub(dir.clone().multiplyScalar(total / 2));
  const off = left.clone().multiplyScalar(side * (p.width / 2 + 1.7));
  const bodyH = 3.2 * Math.min(ex, 1.6);
  const yaw = yawOf(dir);
  const body = new Boxes();
  const band = new Boxes();
  const bodyColor = new THREE.Color(color);
  const glass = new THREE.Color('#1d2733');
  for (let i = 0; i < cars; i++) {
    const center = start
      .clone()
      .add(dir.clone().multiplyScalar(i * (carLen + gap) + carLen / 2))
      .add(off)
      .add(new THREE.Vector3(0, bodyH / 2 - 0.6, 0));
    body.add(center, new THREE.Vector3(2.9, bodyH, carLen), yaw, bodyColor);
    band.add(center.clone().add(new THREE.Vector3(0, bodyH * 0.15, 0)), new THREE.Vector3(2.96, bodyH * 0.28, carLen * 0.92), yaw, glass);
  }
  const m1 = body.mesh(withWalkCut(new THREE.MeshLambertMaterial()), 'train-body');
  const m2 = band.mesh(withWalkCut(new THREE.MeshLambertMaterial()), 'train-windows');
  if (m1) group.add(m1);
  if (m2) group.add(m2);
  return group;
}

/**
 * Wayfinding guide painted on the floor along the route: a yellow band with white chevrons
 * every few metres pointing the way (follows stairs and escalators; skips elevator shafts).
 */
export function buildGuideLine(points: THREE.Vector3[], color: THREE.Color): THREE.Mesh | null {
  const band = new Geo();
  const white = new THREE.Color('#ffffff');
  const uv0: UV4 = [0, 0, 0, 0, 0, 0, 0, 0];
  let carry = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const { dir, left, run } = frame(points[i], points[i + 1]);
    if (run < 0.3) continue; // vertical (elevator): nothing to paint
    // On stairs the band floats over the step noses instead of cutting through the treads.
    const lift = new THREE.Vector3(0, Math.abs(points[i + 1].y - points[i].y) / run > 0.08 ? 0.34 : 0.18, 0);
    const a = points[i].clone().add(lift);
    const b = points[i + 1].clone().add(lift);
    const h = left.clone().multiplyScalar(0.7);
    band.quad(a.clone().add(h), b.clone().add(h), b.clone().sub(h), a.clone().sub(h), uv0, UP, color);
    // Chevrons every 7 m of horizontal distance.
    const seg = a.distanceTo(b);
    for (let d = 7 - carry; d < seg; d += 7) {
      const p = a.clone().lerp(b, d / seg).add(new THREE.Vector3(0, 0.03, 0));
      const tip = p.clone().add(dir.clone().multiplyScalar(0.9));
      const l = p.clone().add(left.clone().multiplyScalar(0.55));
      const r = p.clone().sub(left.clone().multiplyScalar(0.55));
      const back = p.clone().sub(dir.clone().multiplyScalar(0.2));
      band.tri(l, tip, back, [0, 0, 0, 0, 0, 0], UP, white);
      band.tri(r, back, tip, [0, 0, 0, 0, 0, 0], UP, white);
      carry = seg - d;
    }
    carry = (carry + seg) % 7;
  }
  return band.mesh(withWalkCut(new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })), 'guide-line');
}

/** Heading (yaw, radians; 0 = +z/south) from a to b, or null for (nearly) vertical moves. */
export function headingBetween(a: { x: number; z: number }, b: { x: number; z: number }): number | null {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  if (Math.hypot(dx, dz) < 0.4) return null;
  return Math.atan2(dx, dz);
}

/** Drawn width of a stair flight, escalator or elevator lane (m). */
export const verticalLaneWidth = (e: NetEdge): number =>
  e.kind === 'stairs' ? Math.min(8, Math.max(2.4, e.width ?? 3.2)) : e.kind === 'escalator' ? 1.7 : 2.6;

/**
 * Sideways placement of stairs, escalators and elevators, matching buildWalkway's layout: the
 * flights between the same two landings are spread apart with the route's own flight (if any)
 * kept on the node line. Per edge, the world (x, z) offset of the drawn flight from the straight
 * line between its nodes (0 for other kinds) — pedestrians use it to stay on the steps.
 */
export function verticalLaneOffsets(
  g: { edges: NetEdge[]; nodes: NetNode[]; nodeIndex?: Map<string, number> },
  routeEdges: ReadonlySet<string> = new Set(),
): Float32Array {
  const nodeIndex = g.nodeIndex ?? new Map(g.nodes.map((n, i) => [n.id, i]));
  const out = new Float32Array(g.edges.length * 2);
  const byPair = new Map<string, number[]>();
  g.edges.forEach((e, i) => {
    if (e.kind !== 'stairs' && e.kind !== 'escalator' && e.kind !== 'elevator') return;
    const key = e.a < e.b ? `${e.a}|${e.b}` : `${e.b}|${e.a}`;
    const list = byPair.get(key) ?? [];
    list.push(i);
    byPair.set(key, list);
  });
  for (const idx of byPair.values()) {
    const es = idx.map((i) => g.edges[i]);
    const center = Math.max(0, es.findIndex((e) => routeEdges.has(e.id)));
    const offs = laneOffsets(es.map(verticalLaneWidth), center);
    const na = g.nodes[nodeIndex.get(es[0].a) as number];
    const nb = g.nodes[nodeIndex.get(es[0].b) as number];
    const [lo, hi] = na.y <= nb.y ? [na, nb] : [nb, na];
    const { left } = frame(new THREE.Vector3(lo.x, 0, lo.z), new THREE.Vector3(hi.x, 0, hi.z));
    idx.forEach((i, k) => {
      out[i * 2] = left.x * offs[k];
      out[i * 2 + 1] = left.z * offs[k];
    });
  }
  return out;
}
