import * as THREE from 'three';
import type { Footprint, Network, NetNode } from '../core/types';
import {
  analyseRoads,
  approach,
  BoxGrid,
  convexHull,
  distanceToEdges,
  FACADE_STYLES,
  fadeTarget,
  flightWells,
  gondolaOffset,
  groundPieces,
  inflateConvex,
  insideIntervals,
  insideLength,
  insideRings,
  isMajor,
  junctionStations,
  laneLayout,
  makePrism,
  massing,
  nearestOnPolyline,
  OVERVIEW_OPACITY,
  orientedBox,
  placeStreetFurniture,
  PlanIndex,
  PODIUM_TOP,
  pointAt,
  polyBox,
  polyTouchesConvex,
  portalFrames,
  prismWalls,
  realHeight,
  rng,
  roadInfo,
  RoadIndex,
  sceneHeight,
  segmentNearPoint,
  sidewalkWidth,
  slabHoles,
  stepTraffic,
  streetPiercing,
  subtractAll,
  wallOpenings,
  wallPanels,
  WHEEL_GONDOLAS,
  WHEEL_HUB,
  WHEEL_PERIOD_S,
  WHEEL_RADIUS,
  type FacadeStyle,
  type Lane,
  type MassPart,
  type Prism,
  type RoadInfo,
  type Vehicle,
  type WallRect,
  type WallSeg,
} from './city-layout';
import { acquireCityTextures, FACADE_TILE, releaseCityTextures } from './city-textures';
import { CLEARANCE, clipConvex, corridorWidth, insideConvex, WalkSpace, type WalkPiece } from './walk-space';
import { ceilingHeight } from './walkway';
import { polyArea, type P2 } from './walkway-util';

/**
 * City context around the station, from the mapped buildings and streets (OpenStreetMap via
 * Overture Maps, data/osm): every building as its real outline at its real height with
 * curtain-wall, banded, gridded or stone facades (lit windows at night), podiums and towers of
 * the landmarks, the HEP FIVE Ferris wheel, carriageways at their mapped width with kerbed
 * pavements, lane markings and the mapped crosswalks, the expressways and flyovers on their
 * viaducts, 御堂筋 ginkgo trees, street lamps and a little signal-controlled traffic that keeps
 * to one-way streets (and never drives through a walking line).
 *
 * Buildings that stand between the camera and the walker (or the selected route in the
 * overview) are cut away smoothly. Each building has an id; a small texture holds its current
 * opacity, and each facade material is drawn in two passes — an opaque pass over the fully
 * solid buildings (which write depth) and a blended pass over the faded ones (no depth write, so
 * whatever is behind them stays visible). Vertices are grouped per building, so each pass draws
 * exactly its buildings through its own index list, rebuilt only when a building crosses
 * between them; per frame only the buildings near the camera–walker line (a grid query) are
 * tested. Merged geometry keeps the whole module at ~30 draw calls.
 */

export interface CityOptions {
  dark: boolean;
  night: boolean;
  /** Vertical exaggeration of the view (podium floors follow it so decks line up). Default 1. */
  ex?: number;
  /** Walk-through mode: opaque streets and camera cut-away; otherwise overview styling. */
  walk?: boolean;
  /** Autumn-yellow 御堂筋 ginkgo. */
  autumn?: boolean;
}

export interface City {
  object: THREE.Group;
  /** Per frame: cut-away fades, traffic, Ferris wheel. `focus` = walker (walk) or orbit target. */
  update(camera: THREE.Camera, focus: THREE.Vector3, dt: number): void;
  setNight(on: boolean): void;
  /** Route polyline (scene coordinates) kept clear of buildings in the overview; null clears. */
  setRoute(points: THREE.Vector3[] | null): void;
  /** Draw calls and triangles of the visible city meshes (for budgets and tests). */
  stats(): { drawCalls: number; triangles: number; buildings: number; vehicles: number; trees: number };
  /** Current opacity of each building (fade system), for tests and tools. */
  buildingFade(id: string): number | null;
  dispose(): void;
}

/** Layer of everything tall (buildings, trees, lamps, wheel): enable it on the main camera only,
 * so the top-down minimap keeps showing the walkways instead of roofs. */
export const CITY_LAYER = 2;

/** Width (texels) of the per-building opacity texture; its height grows with the building count. */
export const FADE_TEX_WIDTH = 256;
const ROUTE_SAMPLES = 24;
const MAX_TREES = 700;
const MAX_LAMPS = 450;
const MAX_VEHICLES = 700;
/** Buildings within this distance (m) of the network get street-level and rooftop detail. */
const DETAIL_RADIUS = 160;

// ---------------------------------------------------------------- geometry soup

const _m = new THREE.Matrix4();
const _n = new THREE.Matrix3();
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

/**
 * Non-indexed triangle soup with normals, optional UVs, colours and a building id, in growable
 * typed arrays (the city writes a few hundred thousand vertices).
 */
class Geo {
  private n = 0;
  private cap = 0;
  private pos = new Float32Array(0);
  private nor = new Float32Array(0);
  private uv = new Float32Array(0);
  private col = new Float32Array(0);
  private bid = new Float32Array(0);

  private grow(): void {
    this.cap = Math.max(1024, this.cap * 2);
    const g = (a: Float32Array, k: number) => {
      const b = new Float32Array(this.cap * k);
      b.set(a);
      return b;
    };
    this.pos = g(this.pos, 3);
    this.nor = g(this.nor, 3);
    this.uv = g(this.uv, 2);
    this.col = g(this.col, 3);
    this.bid = g(this.bid, 1);
  }

  private vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, w: number, c: THREE.Color, b: number): void {
    if (this.n === this.cap) this.grow();
    const i = this.n++;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.nor[i * 3] = nx;
    this.nor[i * 3 + 1] = ny;
    this.nor[i * 3 + 2] = nz;
    this.uv[i * 2] = u;
    this.uv[i * 2 + 1] = w;
    this.col[i * 3] = c.r;
    this.col[i * 3 + 1] = c.g;
    this.col[i * 3 + 2] = c.b;
    this.bid[i] = b;
  }

  /**
   * Quad p0..p3 (each [x, y, z]) facing `n`; the winding is fixed up to match n, so callers
   * only need the corners in order around the quad.
   */
  quad(p: number[][], n: [number, number, number], c: THREE.Color, b = 0, uv?: number[][]): void {
    const [a, bb, cc] = p;
    const ex1 = bb[0] - a[0];
    const ey1 = bb[1] - a[1];
    const ez1 = bb[2] - a[2];
    const ex2 = cc[0] - a[0];
    const ey2 = cc[1] - a[1];
    const ez2 = cc[2] - a[2];
    const cx = ey1 * ez2 - ez1 * ey2;
    const cy = ez1 * ex2 - ex1 * ez2;
    const cz = ex1 * ey2 - ey1 * ex2;
    const flip = cx * n[0] + cy * n[1] + cz * n[2] < 0;
    const order = flip ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3];
    const t = uv ?? [[0, 0], [0, 0], [0, 0], [0, 0]];
    for (const i of order) this.vert(p[i][0], p[i][1], p[i][2], n[0], n[1], n[2], t[i][0], t[i][1], c, b);
  }

  /** Horizontal polygon fan (convex), facing up or down. */
  fan(cx: number, y: number, cz: number, ring: [number, number][], c: THREE.Color, b = 0, up = true, uvScale = 0): void {
    for (let i = 0; i < ring.length; i++) {
      const [x0, z0] = ring[i];
      const [x1, z1] = ring[(i + 1) % ring.length];
      const pts = [[cx, y, cz], [x0, y, z0], [x1, y, z1]];
      // Up-facing in three.js (y up, z south) needs clockwise order seen from above in x/z.
      const cross = (x0 - cx) * (z1 - cz) - (z0 - cz) * (x1 - cx);
      const ord = (cross < 0) === up ? [0, 1, 2] : [0, 2, 1];
      for (const k of ord) {
        const [px, py, pz] = pts[k];
        this.vert(px, py, pz, 0, up ? 1 : -1, 0, px * uvScale, -pz * uvScale, c, b);
      }
    }
  }

  /** Horizontal convex polygon fanned from its first vertex (n − 2 triangles), facing up or down. */
  poly(ring: P2[], y: number, c: THREE.Color, b = 0, up = true, uvScale = 0): void {
    const [x0, z0] = ring[0];
    for (let i = 1; i < ring.length - 1; i++) {
      const [x1, z1] = ring[i];
      const [x2, z2] = ring[i + 1];
      const cross = (x1 - x0) * (z2 - z0) - (z1 - z0) * (x2 - x0);
      if (Math.abs(cross) < 1e-9) continue;
      const pts = (cross < 0) === up ? [ring[0], ring[i], ring[i + 1]] : [ring[0], ring[i + 1], ring[i]];
      for (const [px, pz] of pts) this.vert(px, y, pz, 0, up ? 1 : -1, 0, px * uvScale, -pz * uvScale, c, b);
    }
  }

  /** Appends a (non-indexed or indexed) geometry transformed by `m`. */
  add(g: THREE.BufferGeometry, m: THREE.Matrix4, c: THREE.Color, b = 0): void {
    const src = g.index ? g.toNonIndexed() : g;
    const p = src.getAttribute('position');
    const n = src.getAttribute('normal');
    _n.getNormalMatrix(m);
    for (let i = 0; i < p.count; i++) {
      _v.fromBufferAttribute(p, i).applyMatrix4(m);
      const [x, y, z] = [_v.x, _v.y, _v.z];
      _v.fromBufferAttribute(n, i).applyMatrix3(_n).normalize();
      this.vert(x, y, z, _v.x, _v.y, _v.z, 0, 0, c, b);
    }
    if (src !== g) src.dispose();
  }

  box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, yaw: number, c: THREE.Color, b = 0): void {
    _q.setFromEuler(_e.set(0, yaw, 0));
    _m.compose(_v.set(cx, cy, cz), _q, new THREE.Vector3(sx, sy, sz));
    this.add(UNIT_BOX, _m, c, b);
  }

  /** Square beam between two points. */
  beam(a: THREE.Vector3, b: THREE.Vector3, t: number, c: THREE.Color, id = 0): void {
    const len = a.distanceTo(b);
    const mid = a.clone().lerp(b, 0.5);
    _q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    _m.compose(mid, _q, new THREE.Vector3(t, len, t));
    this.add(UNIT_BOX, _m, c, id);
  }

  get count(): number {
    return this.n;
  }

  build(uv = false): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    for (const [k, a] of Object.entries(this.attributes(uv))) g.setAttribute(k, a);
    g.computeBoundingSphere();
    return g;
  }

  attributes(uv = false): Record<string, THREE.BufferAttribute> {
    const out: Record<string, THREE.BufferAttribute> = {
      position: new THREE.BufferAttribute(this.pos.slice(0, this.n * 3), 3),
      normal: new THREE.BufferAttribute(this.nor.slice(0, this.n * 3), 3),
      color: new THREE.BufferAttribute(this.col.slice(0, this.n * 3), 3),
      aBid: new THREE.BufferAttribute(this.bid.slice(0, this.n), 1),
    };
    if (uv) out.uv = new THREE.BufferAttribute(this.uv.slice(0, this.n * 2), 2);
    return out;
  }
}

const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();

// ---------------------------------------------------------------- fade shader

/**
 * Per-building opacity from the fade texture at `aBid`. The solid pass draws fully opaque
 * buildings as they are; the ghost pass blends the others by their opacity.
 */
function patchFade(mat: THREE.Material, uFade: { value: THREE.Texture | null }, pass: 'solid' | 'ghost', alphaScale = 1): void {
  mat.onBeforeCompile = (sh) => {
    if (pass === 'solid') return;
    sh.uniforms.uFadeTex = uFade;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\nattribute float aBid;\nuniform sampler2D uFadeTex;\nvarying float vFade;`)
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>\nint fadeId = int(aBid + 0.5);\nvFade = texelFetch(uFadeTex, ivec2(fadeId % ${FADE_TEX_WIDTH}, fadeId / ${FADE_TEX_WIDTH}), 0).r;`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vFade;')
      .replace('#include <opaque_fragment>', `#include <opaque_fragment>\ngl_FragColor.a *= vFade * mix(${alphaScale.toFixed(2)}, 1.0, smoothstep(0.12, 0.45, vFade));`);
  };
  mat.customProgramCacheKey = () => `city-fade-${pass}-${alphaScale}`;
  mat.userData.cityFade = pass;
}

/**
 * Street surfaces get a circular cut-out (with a dark rim) at `uReveal.xy` with radius
 * `uReveal.z`, so a walker below street level stays visible to a camera above it.
 */
function patchReveal(mat: THREE.Material, uReveal: { value: THREE.Vector4 }, soffit = false): void {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uReveal = uReveal;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vRevealXZ;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvRevealXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform vec4 uReveal;\nvarying vec2 vRevealXZ;').replace(
      'void main() {',
      `void main() {
  if (uReveal.z > 0.1) {
    float d = distance(vRevealXZ, uReveal.xy) / uReveal.z;
    if (d < 1.0) discard;
  }`,
    ).replace(
      '#include <opaque_fragment>',
      `#include <opaque_fragment>
  // Dark rim around the cut, like the edge of a section drawing.
  if (uReveal.z > 0.1 && distance(vRevealXZ, uReveal.xy) < uReveal.z + 0.8) gl_FragColor.rgb *= 0.45;${
    soffit
      ? `
  // Seen from below (a camera in the underground mall) the street is a concrete slab, not sky.
  if (!gl_FrontFacing) gl_FragColor.rgb = vec3(0.10, 0.098, 0.094);`
      : ''
  }`,
    );
  };
  mat.customProgramCacheKey = () => (soffit ? 'city-reveal-soffit' : 'city-reveal');
}

// ---------------------------------------------------------------- per-building draw lists

/**
 * The building meshes of one geometry: a solid-pass and a ghost-pass geometry sharing the
 * vertex buffers, each drawing only its buildings through an index list.
 */
class PassGeometry {
  readonly solid = new THREE.BufferGeometry();
  readonly ghost = new THREE.BufferGeometry();
  private readonly si: Uint32Array;
  private readonly gi: Uint32Array;
  private readonly sIndex: THREE.BufferAttribute;
  private readonly gIndex: THREE.BufferAttribute;

  constructor(
    attrs: Record<string, THREE.BufferAttribute>,
    /** Vertex range [start, end) of each building. */
    private readonly start: Int32Array,
    private readonly end: Int32Array,
  ) {
    const n = attrs.position.count;
    for (const [k, a] of Object.entries(attrs)) {
      this.solid.setAttribute(k, a);
      this.ghost.setAttribute(k, a);
    }
    this.si = new Uint32Array(Math.max(3, n));
    this.gi = new Uint32Array(Math.max(3, n));
    this.sIndex = new THREE.BufferAttribute(this.si, 1).setUsage(THREE.DynamicDrawUsage);
    this.gIndex = new THREE.BufferAttribute(this.gi, 1).setUsage(THREE.DynamicDrawUsage);
    this.solid.setIndex(this.sIndex);
    this.ghost.setIndex(this.gIndex);
    this.solid.computeBoundingSphere();
    this.ghost.boundingSphere = this.solid.boundingSphere;
  }

  /** Rebuilds both index lists from each building's pass (0 hidden, 1 ghost, 2 solid). */
  update(state: Uint8Array): [number, number] {
    let ns = 0;
    let ng = 0;
    for (let b = 0; b < state.length; b++) {
      const s = state[b];
      if (s === 0) continue;
      const a = this.start[b];
      const e = this.end[b];
      if (s === 2) for (let v = a; v < e; v++) this.si[ns++] = v;
      else for (let v = a; v < e; v++) this.gi[ng++] = v;
    }
    for (const [attr, n, g] of [
      [this.sIndex, ns, this.solid],
      [this.gIndex, ng, this.ghost],
    ] as const) {
      g.setDrawRange(0, n);
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, Math.max(1, n));
      attr.needsUpdate = true;
    }
    return [ns, ng];
  }

  dispose(): void {
    this.solid.dispose();
    this.ghost.dispose();
  }
}

// ---------------------------------------------------------------- build

interface BuildingRec {
  id: string;
  prisms: Prism[];
  box: [number, number, number, number];
  /** Opacity it settles at when nothing needs cutting away. */
  rest: number;
}

export function buildCity(net: Network, opts: CityOptions): City {
  const ex = opts.ex ?? 1;
  // Walk/overview styling is fixed per build (the view rebuilds on entering / leaving walk mode).
  const walk = !!opts.walk;
  const dark = opts.dark;
  const group = new THREE.Group();
  group.name = 'city';
  const disposables: { dispose(): void }[] = [];
  const own = <T extends { dispose(): void }>(x: T): T => {
    disposables.push(x);
    return x;
  };
  const tall = (o: THREE.Object3D) => {
    o.layers.set(CITY_LAYER);
    group.add(o);
    return o;
  };
  const col = (hex: string) => new THREE.Color(hex);
  /** Lit materials darkened at night (the view keeps its daylight rig in the dark theme). */
  const dimmed: THREE.MeshLambertMaterial[] = [];
  const dim = (m: THREE.MeshLambertMaterial) => {
    m.userData.dayColor = m.color.clone();
    dimmed.push(m);
    return m;
  };

  const textures = acquireCityTextures();
  const uReveal = { value: new THREE.Vector4(0, 0, 0, 0) };

  // ------------------------------------------------------------ walkable space
  // Where people walk (walk-space.ts, real metres; the network's scene y is real y × ex):
  // facades get entrance portals, slabs and the street surface get openings, and street
  // furniture keeps off it, so the walker and the crowd never pass through anything solid.
  const space = WalkSpace.of(net);
  const wells = flightWells(net);
  const edgeById = new Map(net.edges.map((e) => [e.id, e]));
  // Ceiling height of the enclosed corridors meeting at each junction (their portals match it).
  const junctionCeil = new Map<string, number>();
  for (const e of net.edges) {
    if (!e.indoor || (e.kind !== 'walk' && e.kind !== 'gate')) continue;
    const h = ceilingHeight(corridorWidth(e));
    for (const id of [`node:${e.a}`, `node:${e.b}`]) junctionCeil.set(id, Math.max(junctionCeil.get(id) ?? 0, h));
  }
  /** Height (real m above the floor) a portal for this piece is opened to: its ceiling, or head room. */
  const headRoom = (p: WalkPiece): number => {
    if (p.kind === 'shaft') return p.clear;
    const e = edgeById.get(p.id);
    const ceil = p.kind === 'junction' ? (junctionCeil.get(p.id) ?? 0) : e && e.indoor && (e.kind === 'walk' || e.kind === 'gate') ? ceilingHeight(corridorWidth(e)) : p.kind === 'flight' && e?.indoor ? 3 : 0;
    return Math.max(CLEARANCE + 0.4, ceil + 0.3);
  };
  /** Does a box (scene units, yawed about y) reach into walkable space? Tested on its plan bounds. */
  const boxInWalk = (cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, yaw: number): boolean => {
    const c = Math.abs(Math.cos(yaw));
    const s = Math.abs(Math.sin(yaw));
    // Box local x/z rotated by yaw about y: plan half extents.
    const hx = (sx / 2) * c + (sz / 2) * s;
    const hz = (sx / 2) * s + (sz / 2) * c;
    return space.intersectsBox(cx - hx, cx + hx, (cy - sy / 2) / ex, (cy + sy / 2) / ex, cz - hz, cz + hz);
  };

  // The city covers the walk-mode ground: the network's extent and 320 m around it.
  const nodeXs = net.nodes.map((n) => n.x);
  const nodeZs = net.nodes.map((n) => n.z);
  const nx0 = net.nodes.length ? Math.min(...nodeXs) : 0;
  const nx1 = net.nodes.length ? Math.max(...nodeXs) : 0;
  const nz0 = net.nodes.length ? Math.min(...nodeZs) : 0;
  const nz1 = net.nodes.length ? Math.max(...nodeZs) : 0;
  const gx = (nx0 + nx1) / 2;
  const gz = (nz0 + nz1) / 2;
  const half = Math.max(nx1 - nx0, nz1 - nz0) / 2 + 320;
  // Distance to the nearest network node (for detail and the tree budget).
  const nodeCell = 60;
  const nodeGrid = new Map<string, NetNode[]>();
  for (const n of net.nodes) {
    const k = `${Math.floor(n.x / nodeCell)},${Math.floor(n.z / nodeCell)}`;
    const l = nodeGrid.get(k);
    if (l) l.push(n);
    else nodeGrid.set(k, [n]);
  }
  const nearNet = (x: number, z: number): number => {
    const cx = Math.floor(x / nodeCell);
    const cz = Math.floor(z / nodeCell);
    let best = Infinity;
    for (let r = 0; r <= 5; r++) {
      for (let i = -r; i <= r; i++)
        for (let j = -r; j <= r; j++) {
          if (Math.max(Math.abs(i), Math.abs(j)) !== r) continue;
          for (const n of nodeGrid.get(`${cx + i},${cz + j}`) ?? []) best = Math.min(best, Math.hypot(n.x - x, n.z - z));
        }
      if (best < r * nodeCell) break;
    }
    return best;
  };

  // Elevated stations (JR, 阪急): no mapped building may stand in their platform areas, which
  // station.ts draws (the hull of each station's platforms, 1.5 m beyond their edges).
  const cutters: { poly: P2[]; top: number }[] = [];
  const byStation = new Map<string, typeof net.platforms>();
  for (const p of net.platforms) {
    if (p.y < 0) continue;
    const l = byStation.get(p.stationId);
    if (l) l.push(p);
    else byStation.set(p.stationId, [p]);
  }
  for (const ps of byStation.values()) {
    const pts: P2[] = [];
    let top = -Infinity;
    for (const p of ps) {
      const dx = p.b[0] - p.a[0];
      const dz = p.b[1] - p.a[1];
      const l = Math.hypot(dx, dz) || 1;
      const w = p.width / 2 + 1.5;
      const ux = (dx / l) * 1.5;
      const uz = (dz / l) * 1.5;
      const nx = (-dz / l) * w;
      const nz = (dx / l) * w;
      pts.push([p.a[0] - ux - nx, p.a[1] - uz - nz], [p.a[0] - ux + nx, p.a[1] - uz + nz], [p.b[0] + ux - nx, p.b[1] + uz - nz], [p.b[0] + ux + nx, p.b[1] + uz + nz]);
      top = Math.max(top, p.y + 12);
    }
    cutters.push({ poly: convexHull(pts), top });
  }

  // ------------------------------------------------------------ buildings
  const walls = new Map<FacadeStyle, Geo>(FACADE_STYLES.map((s) => [s, new Geo()]));
  const roofs = new Geo();
  const geos: Geo[] = [...FACADE_STYLES.map((s) => walls.get(s) as Geo), roofs];
  const rangeStart: number[][] = geos.map(() => []);
  const rangeEnd: number[][] = geos.map(() => []);
  const buildings: BuildingRec[] = [];
  const frameC = col('#4a4f55');
  /** Rooftop / canopy box, left out where it would reach into walkable space. */
  const solidBox = (cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, yaw: number, c: THREE.Color, bid: number) => {
    if (!boxInWalk(cx, cy, cz, sx, sy, sz, yaw)) roofs.box(cx, cy, cz, sx, sy, sz, yaw, c, bid);
  };
  const beacons: THREE.Vector3[] = [];
  type WheelSpec = { hub: THREE.Vector3; ax: THREE.Vector3; along: THREE.Vector3; radius: number; bid: number };
  // (Assigned while laying out HEP FIVE; the cast keeps it from narrowing to null here.)
  let wheelSpec = null as WheelSpec | null;
  const R = rng(42);
  /** Street-level plan of every building (for pavements and street furniture). */
  const planRings: P2[][][] = [];

  const inSquare = (b: [number, number, number, number], m = 0) => b[1] > gx - half - m && b[0] < gx + half + m && b[3] > gz - half - m && b[2] < gz + half + m;
  const drawn = net.footprints.filter((fp) => (fp.kind === 'building' || fp.kind === 'station') && inSquare(polyBox(fp.poly)));
  // Buildings just beyond the square still keep pavements off their plots.
  for (const fp of net.footprints) {
    if ((fp.kind !== 'building' && fp.kind !== 'station') || fp.use === 'roof') continue;
    const b = polyBox(fp.poly);
    if (inSquare(b) || !inSquare(b, 60)) continue;
    for (const p of massing(fp, 0).parts) if (p.y0 < 1) planRings.push([p.poly, ...p.holes]);
  }
  // Overview: buildings far from the network recede, and so do the low ones (the thousands of
  // small blocks), so the stations and the landmarks stay readable.
  const restOf = (box: [number, number, number, number], top: number, landmark: boolean): number => {
    if (walk) return 1;
    const dx = Math.max(nx0 - box[1], 0, box[0] - nx1);
    const dz = Math.max(nz0 - box[3], 0, box[2] - nz1);
    const d = Math.hypot(dx, dz);
    const k = Math.min(1, d / 300);
    const size = landmark || top >= 60 ? 1 : top >= 30 ? 0.7 : 0.45;
    return (OVERVIEW_OPACITY - 0.3 * k * k * (3 - 2 * k)) * size;
  };

  function addPart(p: MassPart, cuts: P2[][], bid: number, uOff: number, vOff: number, detail: boolean, slot: P2[] | null, buildingTop: number): void {
    const y0 = sceneHeight(p.y0, ex);
    const y1 = sceneHeight(p.y1, ex);
    const segs = prismWalls(p.poly, p.holes, cuts);
    if (!segs.length) return;
    const canopy = p.look.roof === 'canopy';
    const area = polyArea(p.poly) - p.holes.reduce((s, h) => s + polyArea(h), 0);
    let s = 0;
    for (const seg of segs) {
      const len = Math.hypot(seg.bx - seg.ax, seg.bz - seg.az);
      if (canopy) addEdge(seg, y0, y1, bid);
      else addWall(seg, y0, y1, p.look.style, col(p.look.tint), bid, uOff, vOff, s);
      s += len;
    }
    const front = detail && p.y0 < 0.5 && buildingTop > 12 && !canopy && p.look.roof !== 'shed';
    if (front) for (const seg of segs) if (Math.hypot(seg.bx - seg.ax, seg.bz - seg.az) > 2.5) addStreetFront(seg, bid);
    addRoof(p, cuts, y0, y1, bid, area, detail, segs, slot);
  }

  /** Scene-height bands of a wall: split at the top of the podium so the facade's floors follow its stretch. */
  const bands = (y0: number, y1: number): number[] => {
    const cut = PODIUM_TOP * ex;
    return y0 < cut && y1 > cut ? [y0, cut, y1] : [y0, y1];
  };

  function addWall(seg: WallSeg, y0: number, y1: number, style: FacadeStyle, tint: THREE.Color, bid: number, uOff: number, vOff: number, s: number): void {
    const { ax, az, bx, bz } = seg;
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 1e-3) return;
    const n: [number, number, number] = [(bz - az) / len, 0, -(bx - ax) / len];
    const tile = FACADE_TILE[style];
    const tw = tile.bay * tile.bays;
    const th = tile.floor * tile.floors;
    const geo = walls.get(style) as Geo;
    const u0 = s / tw + uOff;
    const u1 = (s + len) / tw + uOff;
    // Entrance portals wherever a corridor, deck or flight runs through this facade.
    const holes = wallOpenings(space, ax, az, bx, bz, y0, y1, ex, headRoom);
    const ys = bands(y0, y1);
    for (let k = 0; k < ys.length - 1; k++) {
      const ya = ys[k];
      const yb = ys[k + 1];
      const va = realHeight(ya, ex) / th + vOff;
      const vb = realHeight(yb, ex) / th + vOff;
      for (const r of wallPanels(holes, ya, yb)) {
        const ua = u0 + (u1 - u0) * r.t0;
        const ub = u0 + (u1 - u0) * r.t1;
        const v0 = va + ((vb - va) * (r.y0 - ya)) / (yb - ya);
        const v1 = va + ((vb - va) * (r.y1 - ya)) / (yb - ya);
        const px = ax + (bx - ax) * r.t0;
        const pz = az + (bz - az) * r.t0;
        const qx = ax + (bx - ax) * r.t1;
        const qz = az + (bz - az) * r.t1;
        geo.quad([[px, r.y0, pz], [qx, r.y0, qz], [qx, r.y1, qz], [px, r.y1, pz]], n, tint, bid, [[ua, v0], [ub, v0], [ub, v1], [ua, v1]]);
      }
    }
    addPortalFrames(holes, ax, az, bx, bz, n, y1, bid);
  }

  /** The edge of a canopy slab (plain metal, in the roof geometry), open where a walkway passes. */
  function addEdge(seg: WallSeg, y0: number, y1: number, bid: number): void {
    const { ax, az, bx, bz } = seg;
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 1e-3) return;
    const n: [number, number, number] = [(bz - az) / len, 0, -(bx - ax) / len];
    const c = col('#9aa0a4');
    for (const r of wallPanels(wallOpenings(space, ax, az, bx, bz, y0, y1, ex, headRoom), y0, y1)) {
      const px = ax + (bx - ax) * r.t0;
      const pz = az + (bz - az) * r.t0;
      const qx = ax + (bx - ax) * r.t1;
      const qz = az + (bz - az) * r.t1;
      roofs.quad([[px, r.y0, pz], [qx, r.y0, qz], [qx, r.y1, qz], [px, r.y1, pz]], n, c, bid);
    }
  }

  /**
   * A dark steel frame around each group of openings in a wall: a lintel over it (where the
   * wall continues above) and a jamb at either side, standing proud of the facade and the
   * shop-window band. Pieces that would reach into walkable space are left out.
   */
  function addPortalFrames(holes: WallRect[], x0: number, z0: number, x1: number, z1: number, n: [number, number, number], top: number, bid: number): void {
    if (!holes.length) return;
    const len = Math.hypot(x1 - x0, z1 - z0);
    const yaw = Math.atan2(x1 - x0, z1 - z0);
    const jw = 0.35;
    const depth = 0.6;
    const at = (t: number, off: number): [number, number] => [x0 + (x1 - x0) * t + n[0] * off, z0 + (z1 - z0) * t + n[2] * off];
    for (const f of portalFrames(holes, 0.8 / len)) {
      const lt = Math.min(0.55 * ex, top - f.y1);
      const tA = Math.max(0, f.t0 - jw / len);
      const tB = Math.min(1, f.t1 + jw / len);
      if (top - f.y1 > 0.1) {
        const [mx, mz] = at((tA + tB) / 2, 0.1);
        const ly = f.y1 + lt / 2;
        if (!boxInWalk(mx, ly, mz, depth, lt, (tB - tA) * len, yaw)) roofs.box(mx, ly, mz, depth, lt, (tB - tA) * len, yaw, frameC, bid);
      }
      for (const [t, edge] of [[f.t0 - jw / (2 * len), f.t0], [f.t1 + jw / (2 * len), f.t1]] as const) {
        if (edge < 1e-3 || edge > 1 - 1e-3) continue;
        const [jx, jz] = at(t, 0.1);
        const jy = (f.y0 + f.y1) / 2;
        if (!boxInWalk(jx, jy, jz, depth, f.y1 - f.y0, jw, yaw)) roofs.box(jx, jy, jz, depth, f.y1 - f.y0, jw, yaw, frameC, bid);
      }
    }
  }

  /**
   * Street level of a building: a dark shop-window band (1F) just proud of the facade and a
   * shallow canopy above it, which is what a pedestrian actually sees of a tower.
   */
  const glassTint = col('#4f5c66');
  const canopyC = col('#5b6166');
  function addStreetFront(seg: WallSeg, bid: number): void {
    const top = sceneHeight(4.6, ex);
    const tile = FACADE_TILE.curtain;
    const geo = walls.get('curtain') as Geo;
    const len = Math.hypot(seg.bx - seg.ax, seg.bz - seg.az);
    const nx = (seg.bz - seg.az) / len;
    const nz = -(seg.bx - seg.ax) / len;
    const o = 0.12;
    const ax = seg.ax + nx * o;
    const az = seg.az + nz * o;
    const bx = seg.bx + nx * o;
    const bz = seg.bz + nz * o;
    const u1 = len / (tile.bay * tile.bays);
    // Shop windows, open where the facade has a portal.
    for (const r of wallPanels(wallOpenings(space, ax, az, bx, bz, 0, top, ex, headRoom), 0, top)) {
      const pa = [ax + (bx - ax) * r.t0, az + (bz - az) * r.t0];
      const pb = [ax + (bx - ax) * r.t1, az + (bz - az) * r.t1];
      const v0 = 0.02 + (0.11 * r.y0) / top;
      const v1 = 0.02 + (0.11 * r.y1) / top;
      geo.quad([[pa[0], r.y0, pa[1]], [pb[0], r.y0, pb[1]], [pb[0], r.y1, pb[1]], [pa[0], r.y1, pa[1]]], [nx, 0, nz], glassTint, bid, [[u1 * r.t0, v0], [u1 * r.t1, v0], [u1 * r.t1, v1], [u1 * r.t0, v1]]);
    }
    // Canopy: a thin slab projecting 1.8 m over the pavement, broken where a walkway (a flight
    // up to a deck, say) passes through it.
    const cy0 = (top + 0.075) / ex;
    const cy1 = (top + 0.425) / ex;
    const blockedAt: [number, number][] = [];
    for (const off of [0.05, 0.9, 1.75]) blockedAt.push(...space.blocked(seg.ax + nx * off, seg.az + nz * off, seg.bx + nx * off, seg.bz + nz * off, cy0, cy1));
    blockedAt.sort((p, q) => p[0] - q[0]);
    let t = 0;
    const piece = (ta: number, tb: number) => {
      if ((tb - ta) * len < 0.6) return;
      const p0 = [seg.ax + (seg.bx - seg.ax) * ta, seg.az + (seg.bz - seg.az) * ta];
      const p1 = [seg.ax + (seg.bx - seg.ax) * tb, seg.az + (seg.bz - seg.az) * tb];
      const y0 = top + 0.075;
      const y1 = top + 0.425;
      const q = (d: number, y: number) => [
        [p0[0] + nx * d, y, p0[1] + nz * d],
        [p1[0] + nx * d, y, p1[1] + nz * d],
      ];
      const [i0, i1] = q(0.05, y1);
      const [o0, o1] = q(1.85, y1);
      roofs.quad([i0, i1, o1, o0], [0, 1, 0], canopyC, bid);
      const [j0, j1] = q(0.05, y0);
      const [k0, k1] = q(1.85, y0);
      roofs.quad([j0, j1, k1, k0], [0, -1, 0], canopyC, bid);
      roofs.quad([k0, k1, o1, o0], [nx, 0, nz], canopyC, bid);
    };
    for (const [s0, s1] of blockedAt) {
      piece(t, s0 - 0.3 / len);
      t = Math.max(t, s1 + 0.3 / len);
    }
    piece(t, 1);
  }

  /** Triangles of a plan polygon with holes (ear clipping). */
  function triangulate(poly: P2[], holes: P2[][]): P2[][] {
    const contour = poly.map(([x, z]) => new THREE.Vector2(x, z));
    const hs = holes.map((h) => h.map(([x, z]) => new THREE.Vector2(x, z)));
    const faces = THREE.ShapeUtils.triangulateShape(contour, hs);
    const all = [...contour, ...hs.flat()];
    return faces.map((f) => f.map((i) => [all[i].x, all[i].y] as P2));
  }

  function addRoof(p: MassPart, cuts: P2[][], y0: number, y1: number, bid: number, area: number, detail: boolean, segs: WallSeg[], slot: P2[] | null): void {
    const kind = p.look.roof;
    const roofC = col(kind === 'shed' ? '#8e969c' : kind === 'canopy' ? '#a3a8ab' : '#9a9d9f');
    const edge = col('#b9bcbd');
    const [bx0, bx1, bz0, bz1] = polyBox(p.poly);
    // Stair wells (and anything else people walk through) are cut out of the slab.
    const holes = [...cuts, ...slabHoles(space, wells, y1 / ex, bx0, bx1, bz0, bz1)];
    if (slot) holes.push(slot);
    const tris = triangulate(p.poly, p.holes);
    const slab = (y: number, up: boolean, hs: P2[][]) => {
      const boxes = hs.map(polyBox);
      for (const t of tris) {
        const [t0, t1, s0, s1] = polyBox(t);
        const near = hs.filter((_, k) => boxes[k][0] < t1 && boxes[k][1] > t0 && boxes[k][2] < s1 && boxes[k][3] > s0);
        if (!near.length) roofs.poly(t, y, roofC, bid, up);
        else for (const piece of subtractAll(t, near)) roofs.poly(piece, y, roofC, bid, up);
      }
    };
    slab(y1, true, holes);
    // Raised volumes (a bridge, a canopy) have an underside.
    if (p.y0 > 2.5 || kind === 'canopy') slab(y0, false, [...cuts, ...slabHoles(space, wells, y0 / ex, bx0, bx1, bz0, bz1)]);
    if (kind === 'canopy' || cuts.length && !segs.length) return;
    const realTop = p.y1;
    const r = rng(bid * 97 + Math.round(y1));
    const o = orientedBox(p.poly);
    const yaw = Math.atan2(o.ux, o.uz);
    const vx = -o.uz;
    const vz = o.ux;
    const at = (a: number, w: number): [number, number] => [o.cx + o.ux * a + vx * w, o.cz + o.uz * a + vz * w];
    const rings = [p.poly, ...p.holes];
    if (kind !== 'shed' && kind !== 'none' && (detail || realTop >= 30)) {
      // Parapet: the facade carried 1.1 m (9 m for a crown) above the roof, with a coping.
      const ph = kind === 'crown' ? 9 : 1.1;
      for (const s of segs) {
        const len = Math.hypot(s.bx - s.ax, s.bz - s.az);
        if (len < 0.3) continue;
        const nx = (s.bz - s.az) / len;
        const nz = -(s.bx - s.ax) / len;
        if (space.intersectsBox(Math.min(s.ax, s.bx) - 0.6, Math.max(s.ax, s.bx) + 0.6, y1 / ex, (y1 + ph) / ex, Math.min(s.az, s.bz) - 0.6, Math.max(s.az, s.bz) + 0.6)) continue;
        roofs.quad([[s.ax, y1, s.az], [s.bx, y1, s.bz], [s.bx, y1 + ph, s.bz], [s.ax, y1 + ph, s.az]], [nx, 0, nz], edge, bid);
        const ix = -nx * 0.45;
        const iz = -nz * 0.45;
        roofs.quad([[s.ax, y1 + ph, s.az], [s.bx, y1 + ph, s.bz], [s.bx + ix, y1 + ph, s.bz + iz], [s.ax + ix, y1 + ph, s.az + iz]], [0, 1, 0], edge, bid);
      }
    }
    // Room on the roof: inside it, m metres clear of its edges and of every opening in it.
    const fits = (x: number, z: number, m: number) =>
      insideRings(rings, x, z) && distanceToEdges(rings, x, z) >= m && !holes.some((h) => insideConvex(h, x, z) || distanceToEdges([h], x, z) < m);
    if ((kind === 'plant' || kind === 'heli') && detail && area >= 150 && realTop >= 12) {
      // Machine rooms, cooling towers and ducts.
      const n = kind === 'heli' ? 3 : Math.min(6, 1 + Math.floor(area / 400) + Math.floor(r() * 3));
      for (let i = 0, tries = 0; i < n && tries < n * 8; tries++) {
        const sx = 3 + r() * Math.min(12, o.hl * 0.5);
        const sz = 3 + r() * Math.min(10, o.hw * 0.5);
        const a = (r() - 0.5) * (o.hl * 2 - sx - 3);
        const w = (r() - 0.5) * (o.hw * 2 - sz - 3);
        const [x, z] = at(a, w);
        const rad = Math.hypot(sx, sz) / 2;
        if (!fits(x, z, rad + 0.8)) continue;
        i++;
        const h = 1.5 + r() * 3.5;
        const shade = 0.72 + r() * 0.2;
        solidBox(x, y1 + h / 2, z, sz, h, sx, yaw, new THREE.Color(shade, shade, shade * 1.02), bid);
      }
    }
    if (kind === 'heli' && (realTop >= 100 || p.helipad) && area >= 500 && fits(o.cx, o.cz, 9)) {
      // Emergency helicopter space: dark pad, white circle and "H" (as on Japanese high-rises).
      const rad = Math.min(15, distanceToEdges(rings, o.cx, o.cz) * 0.8);
      const ring: [number, number][] = [];
      const inner: [number, number][] = [];
      for (let i = 0; i < 28; i++) {
        const t = (i / 28) * Math.PI * 2;
        ring.push([o.cx + Math.cos(t) * rad, o.cz + Math.sin(t) * rad]);
        inner.push([o.cx + Math.cos(t) * rad * 0.86, o.cz + Math.sin(t) * rad * 0.86]);
      }
      roofs.fan(o.cx, y1 + 0.06, o.cz, ring, col('#eeeeea'), bid, true);
      roofs.fan(o.cx, y1 + 0.1, o.cz, inner, col('#4f5a55'), bid, true);
      const hc = col('#f2f2ee');
      const hs = rad * 0.5;
      for (const sa of [-1, 1]) {
        const [x, z] = at(sa * hs * 0.45, 0);
        roofs.box(x, y1 + 0.14, z, hs * 1.4, 0.06, hs * 0.18, yaw, hc, bid);
      }
      roofs.box(o.cx, y1 + 0.14, o.cz, hs * 0.18, 0.06, hs * 0.9, yaw, hc, bid);
    }
    if (kind === 'shed') {
      // Skylight strips along the platform shed, and the columns that carry it.
      const light = col('#c9d6dc');
      for (const w of [-0.33, 0, 0.33]) {
        // Along the shed's axis, only over its roof.
        const [ax, az] = at(-o.hl, w * o.hw * 2);
        const [bx, bz] = at(o.hl, w * o.hw * 2);
        for (const [t0, t1] of insideIntervals(rings, ax, az, bx, bz)) {
          // In ≤ 8 m lengths, each wholly over the roof.
          const a0 = -o.hl + t0 * o.hl * 2 + 1;
          const a1 = -o.hl + t1 * o.hl * 2 - 1;
          const n = Math.ceil((a1 - a0) / 8);
          for (let k = 0; k < n; k++) {
            const s0 = a0 + ((a1 - a0) * k) / n;
            const s1 = a0 + ((a1 - a0) * (k + 1)) / n;
            const corners = [at(s0, w * o.hw * 2 - 3), at(s0, w * o.hw * 2 + 3), at(s1, w * o.hw * 2 - 3), at(s1, w * o.hw * 2 + 3)];
            if (s1 - s0 < 2 || !corners.every(([x, z]) => insideRings(rings, x, z))) continue;
            const [x, z] = at((s0 + s1) / 2, w * o.hw * 2);
            solidBox(x, y1 + 0.3, z, 6, 0.6, s1 - s0 - 0.2, yaw, light, bid);
          }
        }
      }
      const colC = col('#7d858b');
      const base = sceneHeight(10.4, ex);
      for (let a = -o.hl + 8; a <= o.hl - 8; a += 24) {
        for (const w of [-1, 1]) {
          // A column that would stand on a walking line moves along the row (or is left out).
          for (const da of [0, 3, -3, 6, -6]) {
            const [x, z] = at(a + da, w * (o.hw - 1));
            if (!insideRings(rings, x, z) || boxInWalk(x, (base + y0) / 2, z, 0.9, y0 - base, 0.9, yaw)) continue;
            roofs.box(x, (base + y0) / 2, z, 0.9, y0 - base, 0.9, yaw, colC, bid);
            break;
          }
        }
      }
    }
    if (realTop >= 60 && kind !== 'none') {
      // Aviation lights at the outermost corners.
      const ext: P2[] = [];
      for (const f of [(q: P2) => q[0] + q[1], (q: P2) => q[0] - q[1]]) {
        let lo = p.poly[0];
        let hi = p.poly[0];
        for (const q of p.poly) {
          if (f(q) < f(lo)) lo = q;
          if (f(q) > f(hi)) hi = q;
        }
        ext.push(lo, hi);
      }
      for (const [x, z] of new Set(ext)) beacons.push(new THREE.Vector3(x, y1 + (kind === 'crown' ? 9.5 : 1.8), z));
    }
  }

  // HEP FIVE wheel support legs belong to the building (they fade with it).
  const wheelFrame = new Geo();
  const wheelRed = col('#d1232c');
  function addWheelLegs(w: WheelSpec, roofY: number): void {
    const legC = col('#e8e4e0');
    for (const sa of [-1, 1]) {
      for (const sx of [-1, 1]) {
        const foot = w.hub.clone().addScaledVector(w.along, sa * w.radius * 0.42).addScaledVector(w.ax, sx * 5.5).setY(roofY);
        roofs.beam(w.hub.clone().addScaledVector(w.ax, sx * 2.6), foot, 1.1, legC, w.bid);
      }
    }
  }
  drawn.forEach((fp, index) => {
    const bid = buildings.length;
    const { parts, landmark } = massing(fp, index);
    const box = polyBox(fp.poly);
    const detail = nearNet((box[0] + box[1]) / 2, (box[2] + box[3]) / 2) - Math.hypot(box[1] - box[0], box[3] - box[2]) / 2 < DETAIL_RADIUS;
    geos.forEach((g, k) => rangeStart[k].push(g.count));
    const prisms: Prism[] = [];
    const uOff = R();
    const vOff = R();
    const top = Math.max(...parts.map((p) => p.y1));
    let wheelPart: MassPart | null = null;
    for (const part of parts) {
      prisms.push(makePrism(part.poly, part.holes, sceneHeight(part.y0, ex), sceneHeight(part.y1, ex)));
      if (part.y0 < 1 && part.look.roof !== 'canopy') planRings.push([part.poly, ...part.holes]);
      if (landmark?.wheel && (!wheelPart || polyArea(part.poly) > polyArea(wheelPart.poly))) wheelPart = part;
    }
    // HEP FIVE: the wheel stands on the roof, its lower rim dipping through a slot into the
    // boarding floor.
    let slot: P2[] | null = null;
    if (wheelPart) {
      const o = orientedBox(wheelPart.poly);
      const vx = -o.uz;
      const vz = o.ux;
      // The wheel plane runs along the block; its hub goes where the rim's plan stays over the roof.
      const rings = [wheelPart.poly, ...wheelPart.holes];
      let best = { score: -Infinity, x: o.cx, z: o.cz };
      for (let a = -0.3; a <= 0.301; a += 0.1)
        for (let b = -0.6; b <= 0.601; b += 0.1) {
          const x = o.cx + o.ux * a * o.hl + vx * b * o.hw;
          const z = o.cz + o.uz * a * o.hl + vz * b * o.hw;
          if (!insideRings(rings, x, z)) continue;
          const score = insideLength(rings, x - o.ux * WHEEL_RADIUS, z - o.uz * WHEEL_RADIUS, x + o.ux * WHEEL_RADIUS, z + o.uz * WHEEL_RADIUS) + Math.min(8, distanceToEdges(rings, x, z));
          if (score > best.score) best = { score, x, z };
        }
      const hub = new THREE.Vector3(best.x, sceneHeight(WHEEL_HUB, ex), best.z);
      wheelSpec = { hub, ax: new THREE.Vector3(vx, 0, vz), along: new THREE.Vector3(o.ux, 0, o.uz), radius: WHEEL_RADIUS, bid };
      const dip = WHEEL_HUB - wheelPart.y1;
      if (dip < WHEEL_RADIUS) {
        const hl = Math.sqrt(WHEEL_RADIUS * WHEEL_RADIUS - dip * dip) + 2;
        slot = [
          [hub.x - o.ux * hl - vx * 3, hub.z - o.uz * hl - vz * 3],
          [hub.x + o.ux * hl - vx * 3, hub.z + o.uz * hl - vz * 3],
          [hub.x + o.ux * hl + vx * 3, hub.z + o.uz * hl + vz * 3],
          [hub.x - o.ux * hl + vx * 3, hub.z - o.uz * hl + vz * 3],
        ];
        if (polyArea(slot) > 0 && (slot[1][0] - slot[0][0]) * (slot[2][1] - slot[1][1]) - (slot[1][1] - slot[0][1]) * (slot[2][0] - slot[1][0]) < 0) slot.reverse();
      }
    }
    for (const part of parts) {
      const cuts = fp.source === 'osm' && fp.kind === 'building' ? cutters.filter((c) => part.y0 < c.top && polyTouchesConvex(part.poly, c.poly)).map((c) => c.poly) : [];
      addPart(part, cuts, bid, uOff, vOff, detail, part === wheelPart ? slot : null, top);
    }
    if (landmark?.wheel && wheelSpec) addWheelLegs(wheelSpec, sceneHeight(wheelPart?.y1 ?? 30, ex));
    geos.forEach((g, k) => rangeEnd[k].push(g.count));
    buildings.push({ id: fp.id, prisms, box, rest: restOf(box, top, !!landmark || fp.kind === 'station') });
  });

  if (wheelSpec) {
    const { radius } = wheelSpec;
    // Rotating frame (built around the origin in wheel space: x = axle, y = up, z = along).
    const torus = new THREE.TorusGeometry(radius, 0.55, 6, 72);
    torus.rotateY(Math.PI / 2);
    for (const off of [-1.8, 1.8]) wheelFrame.add(torus, _m.makeTranslation(off, 0, 0), wheelRed);
    const innerRing = new THREE.TorusGeometry(radius * 0.3, 0.4, 5, 36);
    innerRing.rotateY(Math.PI / 2);
    for (const off of [-1.2, 1.2]) wheelFrame.add(innerRing, _m.makeTranslation(off, 0, 0), wheelRed);
    torus.dispose();
    innerRing.dispose();
    const spokeC = col('#e04a50');
    for (let i = 0; i < WHEEL_GONDOLAS / 2; i++) {
      const t = (i / (WHEEL_GONDOLAS / 2)) * Math.PI * 2;
      for (const off of [-1.8, 1.8]) {
        const a = new THREE.Vector3(off * 0.4, 0, 0);
        const b2 = new THREE.Vector3(off, Math.sin(t) * radius, Math.cos(t) * radius);
        wheelFrame.beam(a, b2, 0.28, spokeC);
      }
    }
    wheelFrame.box(0, 0, 0, 5, 3.2, 3.2, 0, col('#bfb9b4'));
  }

  // Per-building opacity (fade texture) and draw lists.
  const nb = buildings.length;
  const fadeH = Math.max(1, Math.ceil(nb / FADE_TEX_WIDTH));
  const fadeData = new Uint8Array(FADE_TEX_WIDTH * fadeH);
  const fadeTex = own(new THREE.DataTexture(fadeData, FADE_TEX_WIDTH, fadeH, THREE.RedFormat, THREE.UnsignedByteType));
  fadeTex.magFilter = fadeTex.minFilter = THREE.NearestFilter;
  fadeTex.generateMipmaps = false;
  fadeTex.needsUpdate = true;
  const uFade = { value: fadeTex as THREE.Texture | null };
  const fade = new Float32Array(nb);
  const rest = new Float32Array(nb);
  const passOf = (f: number) => (f >= 0.995 ? 2 : f < 0.004 ? 0 : 1);
  const state = new Uint8Array(nb);
  buildings.forEach((b, i) => {
    fade[i] = rest[i] = b.rest;
    fadeData[i] = Math.round(b.rest * 255);
    state[i] = passOf(b.rest);
  });
  const passGeos: PassGeometry[] = [];

  // Facade materials: day map + night emissive map, two passes each.
  const facadeMats: THREE.MeshPhongMaterial[] = [];
  const passMeshes: THREE.Mesh[] = [];
  FACADE_STYLES.forEach((style, gi) => {
    const geo = walls.get(style) as Geo;
    if (geo.count === 0) return;
    const tex = textures.facade.get(style);
    const pg = new PassGeometry(geo.attributes(true), Int32Array.from(rangeStart[gi]), Int32Array.from(rangeEnd[gi]));
    passGeos.push(pg);
    for (const pass of ['solid', 'ghost'] as const) {
      const m = own(
        new THREE.MeshPhongMaterial({
          vertexColors: true,
          map: tex?.day ?? null,
          emissiveMap: tex?.night ?? null,
          specular: style === 'curtain' || style === 'band' ? 0x5a6670 : 0x222222,
          shininess: style === 'curtain' ? 70 : 20,
          transparent: pass === 'ghost',
          depthWrite: pass === 'solid',
          // Solid buildings are seen into through their entrance portals: show the far walls'
          // inner faces rather than the sky behind a hollow box (shadows cast as before).
          side: pass === 'solid' ? THREE.DoubleSide : THREE.FrontSide,
          shadowSide: THREE.BackSide,
        }),
      );
      patchFade(m, uFade, pass);
      facadeMats.push(m);
      const mesh = new THREE.Mesh(pass === 'solid' ? pg.solid : pg.ghost, m);
      mesh.renderOrder = pass === 'ghost' ? -0.5 : 0;
      mesh.name = `city-${style}-${pass}`;
      passMeshes.push(mesh);
      tall(mesh);
    }
  });
  const roofMats: THREE.MeshLambertMaterial[] = [];
  if (roofs.count) {
    const gi = geos.length - 1;
    const pg = new PassGeometry(roofs.attributes(false), Int32Array.from(rangeStart[gi]), Int32Array.from(rangeEnd[gi]));
    passGeos.push(pg);
    for (const pass of ['solid', 'ghost'] as const) {
      const m = own(
        new THREE.MeshLambertMaterial({
          vertexColors: true,
          transparent: pass === 'ghost',
          depthWrite: pass === 'solid',
          side: pass === 'solid' ? THREE.DoubleSide : THREE.FrontSide,
          shadowSide: THREE.BackSide,
        }),
      );
      // Rooftop clutter stacks many faces: when cut away, ghost it harder than the walls.
      patchFade(m, uFade, pass, 0.45);
      roofMats.push(m);
      const mesh = new THREE.Mesh(pass === 'solid' ? pg.solid : pg.ghost, m);
      mesh.renderOrder = pass === 'ghost' ? -0.5 : 0;
      mesh.name = `city-roofs-${pass}`;
      passMeshes.push(mesh);
      tall(mesh);
    }
  }
  for (const pg of passGeos) own(pg);
  /** Rebuilds the draw lists and hides empty passes. */
  const refreshPasses = () => {
    passGeos.forEach((pg, i) => {
      const [ns, ng] = pg.update(state);
      passMeshes[i * 2].visible = ns > 0;
      passMeshes[i * 2 + 1].visible = ng > 0;
    });
  };
  refreshPasses();

  // Ferris wheel (rotating frame + gondolas that stay level).
  let wheelMesh: THREE.Mesh | null = null;
  let gondolas: THREE.InstancedMesh | null = null;
  const wheelMat = dim(own(new THREE.MeshLambertMaterial({ vertexColors: true })));
  if (wheelSpec) {
    const ws = wheelSpec;
    wheelMesh = new THREE.Mesh(own(wheelFrame.build()), wheelMat);
    wheelMesh.position.copy(ws.hub);
    wheelMesh.rotation.order = 'YXZ';
    wheelMesh.rotation.y = Math.atan2(-ws.ax.z, ws.ax.x);
    // Gondolas must follow the frame's local +z, whichever way the footprint axis points.
    ws.along.set(Math.sin(wheelMesh.rotation.y), 0, Math.cos(wheelMesh.rotation.y));
    wheelMesh.name = 'city-wheel';
    tall(wheelMesh);
    const cab = new Geo();
    cab.box(0, 0, 0, 2.2, 2.3, 2.2, 0, col('#ffffff'));
    cab.box(0, 0.25, 0, 2.3, 0.9, 2.3, 0, col('#26323c'));
    cab.box(0, 1.35, 0, 0.3, 0.6, 0.3, 0, col('#888888'));
    gondolas = new THREE.InstancedMesh(own(cab.build()), dim(own(new THREE.MeshLambertMaterial({ vertexColors: true }))), WHEEL_GONDOLAS);
    const gc = new THREE.Color();
    for (let i = 0; i < WHEEL_GONDOLAS; i++) gondolas.setColorAt(i, gc.set(i % 13 === 0 ? '#f2c230' : i % 2 ? '#e0353c' : '#f4f1ee'));
    gondolas.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    gondolas.frustumCulled = false;
    gondolas.name = 'city-gondolas';
    tall(gondolas);
  }

  // Aviation obstruction lights (night only, blinking).
  let beaconMesh: THREE.InstancedMesh | null = null;
  const beaconMat = own(new THREE.MeshBasicMaterial({ color: 0xff2a1a, transparent: true }));
  if (beacons.length) {
    beaconMesh = new THREE.InstancedMesh(own(new THREE.SphereGeometry(0.9, 8, 6)), beaconMat, beacons.length);
    beacons.forEach((p, i) => beaconMesh?.setMatrixAt(i, _m.makeTranslation(p.x, p.y, p.z)));
    beaconMesh.name = 'city-beacons';
    tall(beaconMesh);
  }

  // ------------------------------------------------------------ streets
  // Streets at ground level; elevated carriageways (decks) are drawn as viaducts further down.
  const streetRoads = net.roads.filter((r) => !r.deck);
  const deckRoads = net.roads.filter((r) => r.deck && r.deck.length === r.points.length && r.points.length >= 2);
  const { infos, junctions, byRoad } = analyseRoads(streetRoads);
  const roadIndex = new RoadIndex(infos);
  const plan = new PlanIndex(planRings);
  const nodeById = new Map<string, NetNode>(net.nodes.map((n) => [n.id, n]));
  const crossings = net.edges
    .filter((e) => e.kind === 'crossing')
    .map((e) => ({ e, a: nodeById.get(e.a) as NetNode, b: nodeById.get(e.b) as NetNode }))
    .filter((c) => c.a && c.b);

  const asphalt = new Geo();
  const walksG = new Geo();
  const marks = new Geo();
  const white = col('#f1f1ec');
  const yellow = col('#f0b429');
  const asphaltC = col('#ffffff');
  const kerbC = col('#c9c6bf');
  const paveC = col('#ffffff');
  const Y_ROAD = 0.02;
  const Y_MARK = 0.045;
  const Y_WALK = 0.15;
  const Y_GROUND = -0.1;
  let groundMesh: THREE.Mesh | null = null;
  const tmp = { x: 0, z: 0, dx: 1, dz: 0, seg: 0 };

  // Stair wells, lift shafts and underground head room that reach up through street level: every
  // street surface (asphalt, pavements, markings and, walking, the paved ground) is open there.
  const streetHoles = net.nodes.length ? slabHoles(space, wells, Y_GROUND / ex, nx0 - 50, nx1 + 50, nz0 - 50, nz1 + 50) : [];
  const holeBox = streetHoles.map(polyBox);
  const holesNear = (x0: number, x1: number, z0: number, z1: number) => streetHoles.filter((_, k) => holeBox[k][0] < x1 && holeBox[k][1] > x0 && holeBox[k][2] < z1 && holeBox[k][3] > z0);
  /** Horizontal street surface (convex, at scene height y) minus the holes it overlaps. */
  const surface = (geo: Geo, ring: P2[], y: number, c: THREE.Color, uv = 0) => {
    const [x0, x1, z0, z1] = polyBox(ring);
    const near = holesNear(x0, x1, z0, z1);
    if (!near.length) geo.poly(ring, y, c, 0, true, uv);
    else for (const piece of subtractAll(ring, near)) geo.poly(piece, y, c, 0, true, uv);
  };
  /** Quad between arc s0..s1 (within one polyline segment) and lateral offsets l0..l1 (left of the direction). */
  const ribbon = (geo: Geo, info: RoadInfo, s0: number, s1: number, l0: number, l1: number, y: number, c: THREE.Color, uv = 0) => {
    pointAt(info, s0, tmp);
    const ax = tmp.x;
    const az = tmp.z;
    const alx = tmp.dz;
    const alz = -tmp.dx;
    pointAt(info, s1, tmp, tmp.seg);
    const P = (x: number, z: number, l: number): P2 => [x + alx * l, z + alz * l];
    surface(geo, [P(ax, az, l0), P(tmp.x, tmp.z, l0), P(tmp.x, tmp.z, l1), P(ax, az, l1)], y, c, uv);
  };
  /** Vertical kerb face along a→b from y0 to Y_WALK facing n, stopping at wells. */
  const kerb = (ax: number, az: number, bx: number, bz: number, y0: number, nx: number, nz: number) => {
    let t = 0;
    const cuts = holesNear(Math.min(ax, bx), Math.max(ax, bx), Math.min(az, bz), Math.max(az, bz))
      .map((h) => clipConvex(h, ax, az, bx - ax, bz - az))
      .filter((c): c is [number, number] => c !== null)
      .sort((p, q) => p[0] - q[0]);
    for (const [c0, c1] of [...cuts, [1, 1] as [number, number]]) {
      if (c0 - t > 1e-3) {
        const p0 = [ax + (bx - ax) * t, az + (bz - az) * t];
        const p1 = [ax + (bx - ax) * c0, az + (bz - az) * c0];
        walksG.quad([[p0[0], y0, p0[1]], [p1[0], y0, p1[1]], [p1[0], Y_WALK, p1[1]], [p0[0], Y_WALK, p0[1]]], [nx, 0, nz], kerbC);
      }
      t = Math.max(t, c1);
    }
  };

  // Network crossings near a point (the network's own zebras take precedence over mapped ones).
  const nearCrossing = (x: number, z: number, d: number) => crossings.some((c) => segDist(x, z, c.a.x, c.a.z, c.b.x, c.b.z) < d);
  // Street-level walking lines other than the crossings: concourses and passages at street level
  // (indoor) and pavements the network walks along (outdoor). Where a mapped carriageway runs
  // into one (the network and the map disagree by a few metres there), no pavement is laid inside
  // an indoor one and no vehicle is drawn on any of them.
  const crossingIds = new Set(crossings.map((c) => c.e.id));
  const streetWalks = space.pieces.filter(
    (p) => p.kind === 'corridor' && !crossingIds.has(p.id) && p.poly.some(([x, z]) => Math.abs(p.f0 + p.fx * x + p.fz * z - 0.3) < 1),
  );
  const streetWalkGrid = new BoxGrid(
    streetWalks.map((p) => p.box),
    16,
  );
  const walkBuf = new Int32Array(256);
  /** Plan bounds of every street-level walking line (to skip roads nowhere near one). */
  const nearStreetWalk = (x0: number, x1: number, z0: number, z1: number): boolean => {
    streetWalkGrid.begin();
    const n = streetWalkGrid.box(x0, x1, z0, z1, walkBuf, 0);
    for (let k = 0; k < n; k++) {
      const b = streetWalks[walkBuf[k]].box;
      if (b[0] <= x1 && b[1] >= x0 && b[2] <= z1 && b[3] >= z0) return true;
    }
    return false;
  };
  const onStreetWalk = (x: number, z: number, indoorOnly: boolean): boolean => {
    streetWalkGrid.begin();
    const n = streetWalkGrid.box(x, x, z, z, walkBuf, 0);
    for (let k = 0; k < n; k++) {
      const p = streetWalks[walkBuf[k]];
      if (indoorOnly && !p.indoor) continue;
      const f = p.f0 + p.fx * x + p.fz * z;
      if (f > -0.6 && f < 1.2 && insideConvex(p.poly, x, z)) return true;
    }
    return false;
  };

  // Streets are drawn over the city square (a little beyond it at most).
  const off = (x: number, z: number) => Math.abs(x - gx) > half + 20 || Math.abs(z - gz) > half + 20;
  const segOff = (info: RoadInfo, k: number) => off(info.pts[k][0], info.pts[k][1]) && off(info.pts[k + 1][0], info.pts[k + 1][1]);
  infos.forEach((info, i) => {
    const road = info.road;
    const w = road.width;
    const major = isMajor(road);
    const js = byRoad[i].map((k) => junctions[k]);
    const stations = junctionStations(info, js);
    const inJunction = (s: number, extra: number) => stations.some((j) => Math.abs(j.s - s) < j.r + extra);

    // Asphalt: a rectangle per segment, wedges on the outside of bends, round ends.
    for (let k = 0; k < info.pts.length - 1; k++) {
      if (info.cum[k + 1] - info.cum[k] < 0.01 || segOff(info, k)) continue;
      ribbon(asphalt, info, info.cum[k], info.cum[k + 1], -w / 2, w / 2, Y_ROAD, asphaltC, 1 / 7);
    }
    for (let k = 1; k < info.pts.length - 1; k++) {
      const [x, z] = info.pts[k];
      if (off(x, z)) continue;
      const a0 = Math.atan2(z - info.pts[k - 1][1], x - info.pts[k - 1][0]);
      const a1 = Math.atan2(info.pts[k + 1][1] - z, info.pts[k + 1][0] - x);
      let turn = a1 - a0;
      while (turn > Math.PI) turn -= Math.PI * 2;
      while (turn < -Math.PI) turn += Math.PI * 2;
      if (Math.abs(turn) < 0.03) continue;
      // Outer side: the left (+) normals for a turn towards +angle (a right turn, z being south).
      const side = turn > 0 ? 1 : -1;
      const steps = Math.max(1, Math.ceil(Math.abs(turn) / 0.35));
      for (let t = 0; t < steps; t++) {
        const b0 = a0 + (turn * t) / steps;
        const b1 = a0 + (turn * (t + 1)) / steps;
        const p0: P2 = [x + Math.sin(b0) * side * (w / 2), z - Math.cos(b0) * side * (w / 2)];
        const p1: P2 = [x + Math.sin(b1) * side * (w / 2), z - Math.cos(b1) * side * (w / 2)];
        surface(asphalt, [[x, z], p0, p1], Y_ROAD, asphaltC, 1 / 7);
      }
    }
    for (const end of [0, 1]) {
      const k = end ? info.pts.length - 1 : 0;
      const [x, z] = info.pts[k];
      if (off(x, z)) continue;
      const [px, pz] = info.pts[end ? k - 1 : 1];
      const a = Math.atan2(z - pz, x - px);
      const cap: P2[] = [];
      for (let t = 0; t <= 8; t++) {
        const b = a - Math.PI / 2 + (Math.PI * t) / 8;
        cap.push([x + Math.cos(b) * (w / 2), z + Math.sin(b) * (w / 2)]);
      }
      surface(asphalt, cap, Y_ROAD, asphaltC, 1 / 7);
    }
    if (!major) return;

    // Pavements with kerbs in ≤ 4 m pieces: dropped where they would lie on another road,
    // and narrowed (or dropped) where a building stands closer to the kerb.
    const sw = sidewalkWidth(w, road);
    for (let k = 0; k < info.pts.length - 1; k++) {
      const segLen = info.cum[k + 1] - info.cum[k];
      if (segLen < 0.5 || segOff(info, k)) continue;
      const n = Math.max(1, Math.ceil(segLen / 4));
      for (const side of [1, -1]) {
        let runStart = -1;
        let runW = 0;
        const flush = (endS: number) => {
          if (runStart < 0) return;
          const s0 = runStart;
          const l0 = side * (w / 2);
          const l1 = side * (w / 2 + runW);
          ribbon(walksG, info, s0, endS, Math.min(l0, l1), Math.max(l0, l1), Y_WALK, paveC, 1 / 2.4);
          pointAt(info, s0, tmp, k);
          const ax = tmp.x;
          const az = tmp.z;
          const nlx = tmp.dz * side;
          const nlz = -tmp.dx * side;
          pointAt(info, endS, tmp, k);
          const bx = tmp.x;
          const bz = tmp.z;
          // Kerb face towards the road and a small face at the back edge.
          kerb(ax + nlx * (w / 2), az + nlz * (w / 2), bx + nlx * (w / 2), bz + nlz * (w / 2), Y_ROAD, -nlx, -nlz);
          kerb(ax + nlx * (w / 2 + runW), az + nlz * (w / 2 + runW), bx + nlx * (w / 2 + runW), bz + nlz * (w / 2 + runW), 0, nlx, nlz);
          runStart = -1;
        };
        for (let p = 0; p < n; p++) {
          const s0 = info.cum[k] + (segLen * p) / n;
          const s1 = info.cum[k] + (segLen * (p + 1)) / n;
          pointAt(info, (s0 + s1) / 2, tmp, k);
          const lx = tmp.dz * side;
          const lz = -tmp.dx * side;
          const kx = tmp.x + lx * (w / 2 + 0.05);
          const kz = tmp.z + lz * (w / 2 + 0.05);
          let width = 0;
          if (!roadIndex.onRoad(tmp.x + lx * (w / 2 + 0.4), tmp.z + lz * (w / 2 + 0.4), i, 0) && !roadIndex.onRoad(tmp.x + lx * (w / 2 + sw * 0.6), tmp.z + lz * (w / 2 + sw * 0.6), i, 0)) {
            let reach = sw;
            for (const s of [s0 + 0.05, (s0 + s1) / 2, s1 - 0.05]) {
              pointAt(info, s, tmp, k);
              reach = Math.min(reach, plan.reach(tmp.x + lx * (w / 2 + 0.05), tmp.z + lz * (w / 2 + 0.05), lx, lz, sw) - 0.1);
            }
            if (!plan.inside(kx, kz)) width = reach >= 1.2 ? Math.floor(reach * 4) / 4 : 0;
            // Not inside a concourse at street level (tested on a 3 × 3 grid over the piece).
            for (const s of [s0 + 0.05, (s0 + s1) / 2, s1 - 0.05]) {
              if (width <= 0) break;
              pointAt(info, s, tmp, k);
              for (const f of [0.02, 0.5, 0.98]) {
                const m = w / 2 + width * f;
                if (onStreetWalk(tmp.x + lx * m, tmp.z + lz * m, true)) width = 0;
              }
            }
            // A facade may still cut the piece between the samples: narrow it, or drop it.
            while (width > 0) {
              pointAt(info, s0, tmp, k);
              const ax = tmp.x + lx * (w / 2 + 0.05);
              const az = tmp.z + lz * (w / 2 + 0.05);
              pointAt(info, s1, tmp, k);
              const bx = tmp.x + lx * (w / 2 + 0.05);
              const bz = tmp.z + lz * (w / 2 + 0.05);
              if (!plan.overlapsConvex([[ax, az], [bx, bz], [bx + lx * width, bz + lz * width], [ax + lx * width, az + lz * width]])) break;
              width = width >= 2.4 ? Math.floor(width * 2) / 4 : 0;
            }
          }
          if (width <= 0) {
            flush(s0);
            continue;
          }
          if (runStart >= 0 && Math.abs(width - runW) > 1e-6) flush(s0);
          if (runStart < 0) {
            runStart = s0;
            runW = width;
          }
        }
        flush(info.cum[k + 1]);
      }
    }

    // Lane markings: dashed between lanes, solid centre line (two-way) and edge lines.
    const lanes = laneLayout(road);
    const lines: { l: number; dash: boolean; c: THREE.Color; wdt: number }[] = [];
    if (road.oneway) {
      const lats = lanes.map((l) => l.lat).sort((a, b) => a - b);
      for (let k = 0; k < lats.length - 1; k++) lines.push({ l: (lats[k] + lats[k + 1]) / 2, dash: true, c: white, wdt: 0.15 });
      if (w >= 5) for (const sgn of [1, -1]) lines.push({ l: sgn * (w / 2 - 0.6), dash: false, c: white, wdt: 0.15 });
    } else {
      const n = lanes.length / 2;
      lines.push({ l: 0.2, dash: false, c: n >= 2 ? yellow : white, wdt: 0.15 }, { l: -0.2, dash: false, c: n >= 2 ? yellow : white, wdt: 0.15 });
      if (w >= 7) for (const sgn of [1, -1]) lines.push({ l: sgn * (w / 2 - 0.9), dash: false, c: white, wdt: 0.2 });
      for (let k = 1; k < n; k++) for (const sgn of [1, -1]) lines.push({ l: sgn * (0.4 + k * 3.25), dash: true, c: white, wdt: 0.15 });
    }
    for (const ln of lines) {
      for (let k = 0; k < info.pts.length - 1; k++) {
        if (segOff(info, k)) continue;
        const a = info.cum[k];
        const b = info.cum[k + 1];
        const piece = ln.dash ? 5 : Math.min(8, Math.max(1, b - a));
        const period = ln.dash ? 10 : piece;
        let runA = -1;
        let runB = -1;
        const emit = () => {
          if (runA >= 0 && runB - runA > 0.3) ribbon(marks, info, runA, runB, ln.l - ln.wdt / 2, ln.l + ln.wdt / 2, Y_MARK, ln.c);
          runA = -1;
        };
        for (let s = ln.dash ? Math.ceil(a / period) * period : a; s < b - 0.3; s += period) {
          const e = Math.min(b, s + piece);
          pointAt(info, (s + e) / 2, tmp, k);
          const ok = !inJunction(s, 3) && !inJunction(e, 3) && !roadIndex.onRoad(tmp.x + tmp.dz * ln.l, tmp.z - tmp.dx * ln.l, i, 0.3);
          if (!ok || ln.dash) emit();
          if (!ok) continue;
          if (runA < 0) runA = s;
          runB = e;
          if (ln.dash) emit();
        }
        emit();
      }
    }

    // Mapped crosswalks (unless the network has its own crossing there) and stop lines before them.
    for (const [x0, z0, x1, z1, cw] of road.crosswalks ?? []) {
      const mx = (x0 + x1) / 2;
      const mz = (z0 + z1) / 2;
      if (!nearCrossing(mx, mz, 6)) zebra(x0, z0, x1, z1, cw);
      const at = nearestOnPolyline(mx, mz, info);
      const lanesHere = laneLayout(road);
      for (const dir of road.oneway ? [1] : [1, -1]) {
        const ss = at.s - dir * (cw / 2 + 1.2);
        if (ss < 0.5 || ss > info.len - 0.5) continue;
        const lats = lanesHere.filter((l) => l.dir === dir).map((l) => l.lat);
        if (!lats.length) continue;
        const lo = Math.min(...lats) - 1.6;
        const hi = Math.max(...lats) + 1.6;
        const l0 = road.oneway ? -w / 2 + 0.6 : dir === 1 ? 0.4 : -(w / 2 - 0.9);
        const l1 = road.oneway ? w / 2 - 0.6 : dir === 1 ? w / 2 - 0.9 : -0.4;
        if (l1 - l0 < 1) continue;
        ribbon(marks, info, ss - 0.225, ss + 0.225, Math.max(l0, lo), Math.min(l1, hi), Y_MARK, white);
      }
    }
  });

  /** Zebra across the walking line a→b: bars of the crosswalk's width, where on asphalt. */
  function zebra(ax: number, az: number, bx: number, bz: number, width: number): void {
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 1) return;
    const dx = (bx - ax) / len;
    const dz = (bz - az) / len;
    const W = Math.min(7, Math.max(3, width));
    const lx = dz;
    const lz = -dx;
    for (let d = 0.6; d < len - 0.6; d += 0.9) {
      const x = ax + dx * d;
      const z = az + dz * d;
      if (!roadIndex.onRoad(x, z, -1, -0.8)) continue;
      const p0: P2 = [x - (lx * W) / 2, z - (lz * W) / 2];
      const p1: P2 = [x + (lx * W) / 2, z + (lz * W) / 2];
      surface(marks, [p0, p1, [p1[0] + dx * 0.45, p1[1] + dz * 0.45], [p0[0] + dx * 0.45, p0[1] + dz * 0.45]], Y_MARK + 0.005, white);
    }
  }

  // Network crossings: zebra only where the crossing lies on asphalt.
  for (const { e, a, b } of crossings) zebra(a.x, a.z, b.x, b.z, Math.min(7, Math.max(4, (e.width ?? 8) * 0.7)));

  const roadMat = own(new THREE.MeshLambertMaterial({ color: 0x6c7075, map: textures.asphalt }));
  const walkMat = own(new THREE.MeshLambertMaterial({ color: 0xc9c5bd, map: textures.paving, vertexColors: true }));
  const markMat = own(new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  for (const m of [roadMat, walkMat, markMat]) patchReveal(m, uReveal);
  for (const [geo, mat, order, name] of [
    [asphalt, roadMat, -1.6, 'city-roads'],
    [walksG, walkMat, -1.5, 'city-sidewalks'],
    [marks, markMat, -1.4, 'city-markings'],
  ] as const) {
    if (!geo.count) continue;
    const mesh = new THREE.Mesh(own(geo.build(true)), mat);
    mesh.renderOrder = order;
    mesh.name = name;
    group.add(mesh);
  }

  // Walking: an opaque paved street level (with openings where stairs go down) replaces the
  // view's translucent ground plane, so the street reads as solid ground.
  if (walk && net.nodes.length) {
    const ground = new Geo();
    const gc = col('#ffffff');
    for (const piece of groundPieces(gx, gz, half, streetHoles)) ground.poly(piece, Y_GROUND, gc, 0, true, 1 / 3.2);
    const groundMat = own(
      new THREE.MeshLambertMaterial({
        color: dark ? 0xa39a8c : 0xd9cfc0,
        map: textures.paving,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: 2,
        polygonOffsetUnits: 2,
      }),
    );
    patchReveal(groundMat, uReveal, true);
    groundMesh = new THREE.Mesh(own(ground.build(true)), groundMat);
    groundMesh.name = 'city-ground';
    groundMesh.renderOrder = -2;
    tall(groundMesh);
  }

  // ------------------------------------------------------------ viaducts
  // Expressways and flyovers (阪神高速, the 新御堂筋 viaduct, the 国道176号 flyover): a deck with
  // parapets on a box girder, ramps down to the street where they meet it, and piers every ~30 m
  // standing clear of the streets below, the buildings and walkable space.
  const deckInfos = deckRoads.map((r) => roadInfo(r));
  /** Scene height of each deck vertex's road surface. */
  const deckTop = deckRoads.map((r) => Float32Array.from(r.deck as number[], (h) => sceneHeight(h, ex) + 0.04));
  const viaductMat = dim(own(new THREE.MeshLambertMaterial({ vertexColors: true })));
  if (deckRoads.length) {
    const vg = new Geo();
    const topC = col('#5d6064');
    const sideC = col('#b9b6af');
    const underC = col('#8e8b85');
    const capC = col('#d2cfc8');
    const pierC = col('#a9a69f');
    const GIRDER = 1.8;
    const PARAPET = 1.0;
    const vtx = { x: 0, z: 0, dx: 1, dz: 0, seg: 0 };
    deckInfos.forEach((info, di) => {
      const pts = info.pts;
      const Y = deckTop[di];
      const H = deckRoads[di].deck as number[];
      const hw = info.road.width / 2 + 0.5;
      const n = pts.length;
      // Mitred left offsets at every vertex (left of the direction = (dz, −dx)).
      const lx = new Float64Array(n);
      const lz = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const a = pts[Math.max(0, i - 1)];
        const b = pts[i];
        const c = pts[Math.min(n - 1, i + 1)];
        const d0 = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        const d1 = Math.hypot(c[0] - b[0], c[1] - b[1]) || 1;
        const n0x = i > 0 ? (b[1] - a[1]) / d0 : (c[1] - b[1]) / d1;
        const n0z = i > 0 ? -(b[0] - a[0]) / d0 : -(c[0] - b[0]) / d1;
        const n1x = i < n - 1 ? (c[1] - b[1]) / d1 : n0x;
        const n1z = i < n - 1 ? -(c[0] - b[0]) / d1 : n0z;
        let mx = n0x + n1x;
        let mz = n0z + n1z;
        const ml = Math.hypot(mx, mz) || 1;
        mx /= ml;
        mz /= ml;
        const k = 1 / Math.max(0.35, mx * n1x + mz * n1z);
        lx[i] = mx * k;
        lz[i] = mz * k;
      }
      const P = (i: number, off: number, y: number): number[] => [pts[i][0] + lx[i] * off, y, pts[i][1] + lz[i] * off];
      for (let i = 0; i < n - 1; i++) {
        const j = i + 1;
        const len = Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]);
        if (len < 0.05) continue;
        // Leave out a piece that would pass through walkable space (a deck over a footbridge).
        const [bx0, bx1, bz0, bz1] = polyBox([
          [pts[i][0] - hw, pts[i][1] - hw],
          [pts[j][0] + hw, pts[j][1] + hw],
          [pts[j][0] - hw, pts[j][1] - hw],
          [pts[i][0] + hw, pts[i][1] + hw],
        ]);
        if (space.intersectsBox(bx0, bx1, Math.min(H[i], H[j]) - GIRDER, Math.max(H[i], H[j]) + PARAPET, bz0, bz1)) continue;
        const ya = Y[i];
        const yb = Y[j];
        const ba = Math.max(0, ya - GIRDER);
        const bb = Math.max(0, yb - GIRDER);
        const dx = (pts[j][0] - pts[i][0]) / len;
        const dz = (pts[j][1] - pts[i][1]) / len;
        vg.quad([P(i, hw, ya), P(j, hw, yb), P(j, -hw, yb), P(i, -hw, ya)], [0, 1, 0], topC);
        if (ya > GIRDER + 0.3 || yb > GIRDER + 0.3) vg.quad([P(i, hw, ba), P(j, hw, bb), P(j, -hw, bb), P(i, -hw, ba)], [0, -1, 0], underC);
        for (const sd of [1, -1]) {
          const nx = dz * sd;
          const nz = -dx * sd;
          const o = sd * hw;
          const oi = sd * (hw - 0.3);
          // Fascia and parapet (outside), parapet inside, coping.
          vg.quad([P(i, o, ba), P(j, o, bb), P(j, o, yb + PARAPET), P(i, o, ya + PARAPET)], [nx, 0, nz], sideC);
          vg.quad([P(i, oi, ya), P(j, oi, yb), P(j, oi, yb + PARAPET), P(i, oi, ya + PARAPET)], [-nx, 0, -nz], sideC);
          vg.quad([P(i, o, ya + PARAPET), P(j, o, yb + PARAPET), P(j, oi, yb + PARAPET), P(i, oi, ya + PARAPET)], [0, 1, 0], capC);
        }
      }
      // Open ends (the deck stops at the edge of the data, or a ramp meets the street).
      for (const [i, sgn] of [
        [0, -1],
        [n - 1, 1],
      ] as const) {
        if (Y[i] < 0.5) continue;
        const k = sgn > 0 ? i - 1 : i + 1;
        const len = Math.hypot(pts[i][0] - pts[k][0], pts[i][1] - pts[k][1]) || 1;
        const b = Math.max(0, Y[i] - GIRDER);
        vg.quad([P(i, hw, b), P(i, -hw, b), P(i, -hw, Y[i] + PARAPET), P(i, hw, Y[i] + PARAPET)], [(pts[i][0] - pts[k][0]) / len, 0, (pts[i][1] - pts[k][1]) / len], sideC);
      }
      // Piers: on the deck's centre line every ~30 m where it is high enough, moved along it
      // (up to 8 m) off the streets below, buildings and walkways, else left out.
      for (let s0 = 15; s0 < info.len - 5; s0 += 30) {
        for (const ds of [0, 4, -4, 8, -8]) {
          const sp = s0 + ds;
          if (sp < 2 || sp > info.len - 2) continue;
          pointAt(info, sp, vtx);
          const c = info.cum;
          const t = Math.max(0, Math.min(1, (sp - c[vtx.seg]) / (c[vtx.seg + 1] - c[vtx.seg] || 1)));
          const h = H[vtx.seg] + (H[vtx.seg + 1] - H[vtx.seg]) * t;
          if (h < GIRDER + 2.5) break;
          const y = Y[vtx.seg] + (Y[vtx.seg + 1] - Y[vtx.seg]) * t - GIRDER;
          const across = Math.min(hw * 1.1, 7);
          const yaw = Math.atan2(vtx.dx, vtx.dz);
          const clear = (x: number, z: number) =>
            !roadIndex.onRoad(x, z, -1, 0.8) &&
            !plan.inside(x, z, 0.8) &&
            !space.intersectsBox(x - across / 2 - 0.5, x + across / 2 + 0.5, 0, h, z - across / 2 - 0.5, z + across / 2 + 0.5);
          // Both ends of the pier's section, and its middle.
          const ok = [-across / 2, 0, across / 2].every((l) => clear(vtx.x + vtx.dz * l, vtx.z - vtx.dx * l));
          if (!ok) continue;
          vg.box(vtx.x, y / 2, vtx.z, across, y, 1.6, yaw, pierC);
          break;
        }
      }
    });
    if (vg.count) {
      const mesh = new THREE.Mesh(own(vg.build()), viaductMat);
      mesh.name = 'city-viaducts';
      tall(mesh);
    }
  }

  // ------------------------------------------------------------ trees and lamps
  /**
   * Whether a tree or lamp's envelope (scene units, at the largest random size) would reach
   * into walkable space: trunk / pole, then crown / arm and lamp head. Crowns start above the
   * head room of street-level walkways (so they may overhang them) but not decks or flights.
   */
  const inWalk = (x: number, z: number, what: 'tree' | 'lamp', kind: number): boolean => {
    const box = (r: number, y0: number, y1: number) => space.intersectsBox(x - r, x + r, y0 / ex, y1 / ex, z - r, z + r);
    if (what === 'lamp') return box(0.35, 0, 9.1) || box(2.8, 8.4, 9.1);
    const ginkgo = kind === 1;
    const [tl, tu] = [(ginkgo ? 4.4 : 3.8) * 0.85, (ginkgo ? 4.4 : 3.8) * 1.15];
    const [yl, yu] = [(ginkgo ? 4.6 : 3.0) * 0.85, (ginkgo ? 4.6 : 3.0) * 1.15];
    const crownLow = tl + yl * 0.06;
    return box(0.35, 0, crownLow) || box((ginkgo ? 2.4 : 3.4) * 1.15 * 1.1, crownLow, tu + yu * 1.9);
  };
  const blocked = (x: number, z: number, what: 'tree' | 'lamp', kind: number) =>
    plan.inside(x, z, what === 'tree' ? 2.5 : 1) ||
    crossings.some((c) => segDist(x, z, c.a.x, c.a.z, c.b.x, c.b.z) < (c.e.width ?? 8) / 2 + 4) ||
    net.nodes.some((n) => n.level === '1F' && n.kind !== 'junction' && Math.hypot(n.x - x, n.z - z) < 5) ||
    inWalk(x, z, what, kind);
  const { trees, lamps } = placeStreetFurniture(infos, junctions, blocked, { index: roadIndex, byRoad, rank: nearNet, maxTrees: MAX_TREES, maxLamps: MAX_LAMPS });

  const trunkGeo = own(new THREE.CylinderGeometry(0.16, 0.26, 1, 6).translate(0, 0.5, 0));
  const crownGeo = own(crownGeometry(5));
  const trunkMesh = new THREE.InstancedMesh(trunkGeo, dim(own(new THREE.MeshLambertMaterial({ color: 0x5b4a3c }))), Math.max(1, trees.length));
  const crownMesh = new THREE.InstancedMesh(crownGeo, dim(own(new THREE.MeshLambertMaterial({ vertexColors: true }))), Math.max(1, trees.length));
  const tc = new THREE.Color();
  const tr = rng(5);
  // Crown spheres (x, y, z, r) and original matrices, for hiding trees right at the camera.
  const crownAt = new Float32Array(trees.length * 4);
  const crownM = new Float32Array(trees.length * 16);
  const trunkM = new Float32Array(trees.length * 16);
  const treeHidden = new Uint8Array(trees.length);
  trees.forEach((t, i) => {
    const k = 0.85 + tr() * 0.3;
    const ginkgo = t.kind === 1;
    // Crowns start above head height (street trees are pruned for clearance).
    const trunkH = (ginkgo ? 4.4 : 3.8) * k;
    trunkMesh.setMatrixAt(i, _m.compose(_v.set(t.x, 0.15, t.z), _q.identity(), new THREE.Vector3(1, trunkH + 2, 1)));
    // Ginkgo along 御堂筋 are pruned into tall cones; zelkova have wide vase crowns.
    const sx = (ginkgo ? 2.4 : 3.4) * k;
    const sy = (ginkgo ? 4.6 : 3.0) * k;
    _q.setFromEuler(_e.set(0, tr() * Math.PI * 2, 0));
    crownMesh.setMatrixAt(i, _m.compose(_v.set(t.x, trunkH + sy * 0.95, t.z), _q, new THREE.Vector3(sx, sy, sx)));
    crownAt.set([t.x, trunkH + sy * 0.95, t.z, Math.max(sx, sy)], i * 4);
    _m.toArray(crownM, i * 16);
    trunkMesh.getMatrixAt(i, _m);
    _m.toArray(trunkM, i * 16);
    if (ginkgo && opts.autumn) tc.setHSL(0.13 + tr() * 0.02, 0.8, 0.5 + tr() * 0.08);
    else if (ginkgo) tc.setHSL(0.24 + tr() * 0.04, 0.45, 0.36 + tr() * 0.06);
    else tc.setHSL(0.27 + tr() * 0.05, 0.35, 0.3 + tr() * 0.07);
    crownMesh.setColorAt(i, tc);
  });
  trunkMesh.count = crownMesh.count = trees.length;
  trunkMesh.name = 'city-trunks';
  crownMesh.name = 'city-crowns';
  tall(trunkMesh);
  tall(crownMesh);

  const pole = new Geo();
  const poleCyl = new THREE.CylinderGeometry(0.09, 0.13, 9, 6);
  pole.add(poleCyl, _m.makeTranslation(0, 4.5, 0), col('#6d7479'));
  poleCyl.dispose();
  pole.box(0, 8.9, 1.1, 0.12, 0.12, 2.3, 0, col('#6d7479'));
  const poleMesh = new THREE.InstancedMesh(own(pole.build()), dim(own(new THREE.MeshLambertMaterial({ vertexColors: true }))), Math.max(1, lamps.length));
  const headMat = own(new THREE.MeshBasicMaterial({ color: 0xd8dcdf }));
  const headMesh = new THREE.InstancedMesh(own(new THREE.BoxGeometry(0.5, 0.18, 0.9).translate(0, 8.8, 2.2)), headMat, Math.max(1, lamps.length));
  const glowTex = textures.glow;
  const poolMat = own(
    new THREE.MeshBasicMaterial({ map: glowTex, color: 0xffd9a0, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  const poolMesh = new THREE.InstancedMesh(own(new THREE.PlaneGeometry(13, 13).rotateX(-Math.PI / 2).translate(0, 0.2, 2.2)), poolMat, Math.max(1, lamps.length));
  lamps.forEach((l, i) => {
    _q.setFromEuler(_e.set(0, l.yaw, 0));
    _m.compose(_v.set(l.x, 0.15, l.z), _q, new THREE.Vector3(1, 1, 1));
    poleMesh.setMatrixAt(i, _m);
    headMesh.setMatrixAt(i, _m);
    poolMesh.setMatrixAt(i, _m);
  });
  poleMesh.count = headMesh.count = poolMesh.count = lamps.length;
  poleMesh.name = 'city-lamp-poles';
  headMesh.name = 'city-lamp-heads';
  poolMesh.name = 'city-lamp-pools';
  poolMesh.renderOrder = -1.3;
  tall(poleMesh);
  tall(headMesh);
  group.add(poolMesh);

  // ------------------------------------------------------------ traffic
  const lanes: Lane[] = [];
  infos.forEach((info, ri) => {
    const road = info.road;
    if (!isMajor(road) || road.terminal) return;
    const first = info.pts[0];
    const last = info.pts[info.pts.length - 1];
    const phase: 0 | 1 = Math.abs(last[0] - first[0]) > Math.abs(last[1] - first[1]) ? 1 : 0;
    const st = junctionStations(info, byRoad[ri].map((k) => junctions[k]).filter((j) => j.roads.some((r) => r !== ri && isMajor(infos[r].road))));
    const cw = (road.crosswalks ?? []).map(([x0, z0, x1, z1, w]) => ({ s: nearestOnPolyline((x0 + x1) / 2, (z0 + z1) / 2, info).s, r: w / 2 + 0.5 }));
    // The network's own crossings: traffic stops short of the zebra on red, and whenever the
    // walker is on it, so no car ever waits on (or drives through) a walking line.
    const xs: { s: number; hw: number; c: number }[] = [];
    crossings.forEach((c, ci) => {
      const s = crossingOnRoad(info, c.a.x, c.a.z, c.b.x, c.b.z);
      if (s !== null) xs.push({ s, hw: corridorWidth(c.e) / 2, c: ci });
    });
    for (const { lat, dir } of laneLayout(road)) {
      const stops = [...st.map((j) => j.s - dir * (j.r + 2)), ...cw.map((c) => c.s - dir * (c.r + 1.5))].filter((s) => s > 0 && s < info.len).sort((a, b) => a - b);
      if (dir === -1) stops.reverse();
      const holds = xs.map((x) => ({ s: x.s - dir * (x.hw + 2.5), c: x.c })).filter((h) => h.s > 0 && h.s < info.len);
      lanes.push({ road: ri, dir, lat, stops, phase, holds: holds.length ? holds : undefined });
    }
  });
  // Free-flowing traffic on the expressway decks (no signals), after the streets' lanes.
  const laneInfos: RoadInfo[] = [...infos, ...deckInfos];
  /** Scene height of the carriageway at each vertex, per lane road (null: street level). */
  const laneDeck: (Float32Array | null)[] = [...infos.map(() => null), ...deckTop];
  deckInfos.forEach((info, k) => {
    for (const { lat, dir } of laneLayout(info.road)) lanes.push({ road: infos.length + k, dir, lat, stops: [], phase: 0 });
  });
  // Stretches of each lane (arc intervals, padded by half a bus) that run through a street-level
  // walking line: vehicles are not drawn there.
  const laneHidden: (Float64Array | null)[] = lanes.map((lane) => {
    if (laneDeck[lane.road]) return null;
    const info = infos[lane.road];
    const [x0, x1, z0, z1] = polyBox(info.pts);
    if (!nearStreetWalk(x0 - 15, x1 + 15, z0 - 15, z1 + 15)) return null;
    const iv: number[] = [];
    for (let s = 0; s <= info.len; s += 1) {
      pointAt(info, s, tmp);
      if (!onStreetWalk(tmp.x + tmp.dz * lane.lat, tmp.z - tmp.dx * lane.lat, false)) continue;
      if (iv.length && s - 1 - iv[iv.length - 1] < 6.5) iv[iv.length - 1] = s + 6;
      else iv.push(s - 6, s + 6);
    }
    return iv.length ? Float64Array.from(iv) : null;
  });
  // Crossing areas (a little beyond the walkway) and whether the walker is on each.
  const crossingPolys = crossings.map((c) => {
    const piece = space.pieces.find((p) => p.id === c.e.id);
    return piece ? inflateConvex(piece.poly, 1.5) : null;
  });
  const held = new Uint8Array(crossings.length);
  const vehicles: Vehicle[] = [];
  const byLane: number[][] = lanes.map(() => []);
  const vr = rng(9);
  const laneTotal = lanes.reduce((s, l) => s + laneInfos[l.road].len, 0);
  // Spacing grows when there is more street than the vehicle budget covers.
  const spread = Math.max(1, laneTotal / (MAX_VEHICLES * 64));
  lanes.forEach((lane, li) => {
    const len = laneInfos[lane.road].len;
    let p = len - 5 - vr() * 20 * spread;
    while (p > 10 && vehicles.length < MAX_VEHICLES) {
      const bus = laneInfos[lane.road].road.width >= 20 && vr() < 0.08;
      const v: Vehicle = { lane: li, s: lane.dir === 1 ? p : len - p, v: 6 + vr() * 5, type: bus ? 1 : 0, len: bus ? 11 : 4.6 };
      byLane[li].push(vehicles.length);
      vehicles.push(v);
      p -= (34 + vr() * 60) * spread;
    }
  });
  // Buses waiting in the 大阪駅前 terminal bays.
  const statics: { x: number; z: number; yaw: number; type: 0 | 1; color: string }[] = [];
  /** Parks a bus / taxi (at the road point in `tmp`) at lateral offset l, clear of walkways. */
  const park = (l: number, yaw: number, type: 0 | 1, color: string) => {
    const [hl, hw, h] = type === 1 ? [5.6, 1.3, 3.4] : [2.4, 0.9, 1.7];
    const c = Math.abs(Math.cos(yaw));
    const sn = Math.abs(Math.sin(yaw));
    const rx = hl * sn + hw * c;
    const rz = hl * c + hw * sn;
    const x = tmp.x + tmp.dz * l;
    const z = tmp.z - tmp.dx * l;
    if (space.intersectsBox(x - rx, x + rx, 0, h / ex, z - rz, z + rz) || plan.inside(x, z, 1.5)) return;
    statics.push({ x, z, yaw, type, color });
  };
  infos.forEach((info, ri) => {
    if (!info.road.terminal) return;
    const js = junctionStations(info, byRoad[ri].map((k) => junctions[k]));
    for (let s = 8; s < info.len - 8; s += 14) {
      if (js.some((j) => Math.abs(j.s - s) < j.r + 6) || vr() < 0.3) continue;
      pointAt(info, s, tmp);
      park(0, Math.atan2(tmp.dx, tmp.dz), vr() < 0.8 ? 1 : 0, vr() < 0.7 ? '#f0f2f0' : '#e6ecf5');
    }
  });

  const carColors = ['#f4f4f2', '#1d1f22', '#9aa1a8', '#c9ccd0', '#1c1d20', '#f2c230', '#2f5d8a', '#8a2a2a', '#f4f4f2', '#3a3f45'];
  const carGeo = vehicleGeometry(false);
  const busGeo = vehicleGeometry(true);
  const nCars = vehicles.filter((v) => v.type === 0).length + statics.filter((s) => s.type === 0).length;
  const nBus = vehicles.filter((v) => v.type === 1).length + statics.filter((s) => s.type === 1).length;
  const carMesh = new THREE.InstancedMesh(own(carGeo.body), dim(own(new THREE.MeshLambertMaterial({ vertexColors: true }))), Math.max(1, nCars));
  const busMesh = new THREE.InstancedMesh(own(busGeo.body), dim(own(new THREE.MeshLambertMaterial({ vertexColors: true }))), Math.max(1, nBus));
  const lightMat = own(new THREE.MeshBasicMaterial({ vertexColors: true }));
  const carLights = new THREE.InstancedMesh(own(carGeo.lights), lightMat, Math.max(1, nCars));
  const busLights = new THREE.InstancedMesh(own(busGeo.lights), lightMat, Math.max(1, nBus));
  carLights.instanceMatrix = carMesh.instanceMatrix;
  busLights.instanceMatrix = busMesh.instanceMatrix;
  for (const m of [carMesh, busMesh]) {
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.frustumCulled = false;
  }
  carLights.frustumCulled = busLights.frustumCulled = false;
  carMesh.name = 'city-cars';
  busMesh.name = 'city-buses';
  carLights.name = 'city-car-lights';
  busLights.name = 'city-bus-lights';
  // Slot of each moving vehicle in its instanced mesh; statics follow the moving ones.
  const slot = new Int32Array(vehicles.length);
  let ci = 0;
  let bi = 0;
  vehicles.forEach((v, i) => {
    if (v.type === 0) {
      slot[i] = ci;
      carMesh.setColorAt(ci++, tc.set(carColors[Math.floor(vr() * carColors.length)]));
    } else {
      slot[i] = bi;
      busMesh.setColorAt(bi++, tc.set(vr() < 0.5 ? '#f0f2f0' : '#e8efe6'));
    }
  });
  for (const s of statics) {
    const mesh = s.type === 0 ? carMesh : busMesh;
    const idx = s.type === 0 ? ci++ : bi++;
    _q.setFromEuler(_e.set(0, s.yaw, 0));
    mesh.setMatrixAt(idx, _m.compose(_v.set(s.x, Y_ROAD, s.z), _q, new THREE.Vector3(1, 1, 1)));
    mesh.setColorAt(idx, tc.set(s.color));
  }
  carMesh.count = carLights.count = ci;
  busMesh.count = busLights.count = bi;
  for (const m of [carMesh, busMesh, carLights, busLights]) group.add(m);

  // ------------------------------------------------------------ state
  let night = opts.night;
  let time = 0;
  const route: THREE.Vector3[] = [];
  const camPos = new THREE.Vector3();
  const fadeIn = { camera: camPos, focus: new THREE.Vector3(), route, walk };
  const mat4 = new THREE.Matrix4();
  // Fade bookkeeping (allocation-free per frame).
  const grid = new BoxGrid(
    buildings.map((b) => b.box),
    40,
  );
  const cand = new Int32Array(Math.max(16, nb));
  const target = new Float32Array(nb);
  const seen = new Uint32Array(nb);
  const active = new Int32Array(Math.max(1, nb));
  const isActive = new Uint8Array(nb);
  let activeN = 0;
  let frame = 0;
  const maxTop = buildings.reduce((m, b) => Math.max(m, ...b.prisms.map((p) => p.y1)), 0);

  function applyMode(): void {
    // Overview: see-through streets that never hide the underground network (drawn before it,
    // without depth). Walking: solid ground surfaces with depth.
    const see = !walk;
    roadMat.transparent = walkMat.transparent = markMat.transparent = see;
    roadMat.opacity = see ? (dark ? 0.75 : 0.8) : 1;
    walkMat.opacity = see ? 0.6 : 1;
    markMat.opacity = see ? 0.7 : 1;
    roadMat.depthWrite = walkMat.depthWrite = markMat.depthWrite = !see;
    for (const m of [roadMat, walkMat, markMat]) m.needsUpdate = true;
    // Viaducts: solid when walking, see-through like the buildings in the overview.
    viaductMat.transparent = see;
    viaductMat.opacity = see ? OVERVIEW_OPACITY * 0.8 : 1;
    viaductMat.depthWrite = !see;
    viaductMat.needsUpdate = true;
    fadeIn.walk = walk;
  }

  function applyNight(): void {
    const k = night ? 0.3 : 1;
    for (const m of facadeMats) {
      m.color.setScalar(k);
      m.emissive.setScalar(night ? 1 : 0);
      m.emissiveIntensity = night ? 0.95 : 0;
    }
    for (const m of roofMats) m.color.setScalar(night ? 0.35 : 1);
    for (const m of dimmed) m.color.copy(m.userData.dayColor as THREE.Color).multiplyScalar(night ? 0.38 : 1);
    roadMat.color.set(night ? 0x2e3237 : dark ? 0x5b5f64 : 0x6c7075);
    walkMat.color.set(night ? 0x55534f : 0xc9c5bd);
    markMat.color.setScalar(night ? 0.55 : 1);
    headMat.color.set(night ? 0xffe8b8 : 0xd8dcdf);
    if (groundMesh) (groundMesh.material as THREE.MeshLambertMaterial).color.set(night ? 0x4a4845 : dark ? 0xa39a8c : 0xd9cfc0);
    poolMesh.visible = night;
    carLights.visible = busLights.visible = night;
    if (beaconMesh) beaconMesh.visible = night;
    wheelMat.emissive.set(night ? 0xff2448 : 0x000000);
    wheelMat.emissiveIntensity = night ? 0.9 : 0;
  }

  function writeVehicles(): void {
    for (let i = 0; i < vehicles.length; i++) {
      const v = vehicles[i];
      const lane = lanes[v.lane];
      const info = laneInfos[lane.road];
      const hid = laneHidden[v.lane];
      if (hid) {
        let off = false;
        for (let k = 0; k < hid.length; k += 2) if (v.s > hid[k] && v.s < hid[k + 1]) off = true;
        if (off) {
          (v.type === 0 ? carMesh : busMesh).setMatrixAt(slot[i], zero);
          continue;
        }
      }
      pointAt(info, v.s, tmp, tmp.seg);
      const x = tmp.x + tmp.dz * lane.lat;
      const z = tmp.z - tmp.dx * lane.lat;
      const fx = tmp.dx * lane.dir;
      const fz = tmp.dz * lane.dir;
      let y = Y_ROAD;
      const deck = laneDeck[lane.road];
      if (deck) {
        const c = info.cum;
        const i = tmp.seg;
        const t = Math.max(0, Math.min(1, (v.s - c[i]) / (c[i + 1] - c[i] || 1)));
        y = deck[i] + (deck[i + 1] - deck[i]) * t;
      }
      // Rotation about y taking local +z to the travel direction (fx, fz), plus translation.
      mat4.set(fz, 0, fx, x, 0, 1, 0, y, -fx, 0, fz, z, 0, 0, 0, 1);
      (v.type === 0 ? carMesh : busMesh).setMatrixAt(slot[i], mat4);
    }
    carMesh.instanceMatrix.needsUpdate = true;
    busMesh.instanceMatrix.needsUpdate = true;
  }

  /** Buildings that may need cutting away this frame: near the sight lines and the camera. */
  function gatherCandidates(): number {
    grid.begin();
    const c = camPos;
    const f = fadeIn.focus;
    let n = 0;
    if (walk) {
      n = grid.segment(c.x, c.z, f.x, f.z, cand, n);
      n = grid.box(c.x - 3, c.x + 3, c.z - 3, c.z + 3, cand, n);
      return grid.box(f.x - 1, f.x + 1, f.z - 1, f.z + 1, cand, n);
    }
    n = grid.box(c.x - 10, c.x + 10, c.z - 10, c.z + 10, cand, n);
    // Sight lines only matter below the tallest roof.
    const clip = (px: number, py: number, pz: number) => {
      const t = c.y > maxTop && c.y > py ? Math.max(0, Math.min(1, (c.y - maxTop) / (c.y - py))) : 0;
      return grid.segment(c.x + (px - c.x) * t, c.z + (pz - c.z) * t, px, pz, cand, n);
    };
    n = clip(f.x, f.y, f.z);
    for (let k = 0; k < route.length; k++) {
      const p = route[k];
      n = grid.box(p.x - 18, p.x + 18, p.z - 18, p.z + 18, cand, n);
      n = clip(p.x, p.y, p.z);
    }
    return n;
  }

  function updateFades(dt: number): void {
    frame++;
    const n = gatherCandidates();
    for (let k = 0; k < n; k++) {
      const id = cand[k];
      target[id] = fadeTarget(buildings[id].prisms, fadeIn, rest[id]);
      seen[id] = frame;
      if (!isActive[id] && target[id] !== fade[id]) {
        isActive[id] = 1;
        active[activeN++] = id;
      }
    }
    let dirtyTex = false;
    let dirtyPass = false;
    for (let k = 0; k < activeN; k++) {
      const id = active[k];
      const t = seen[id] === frame ? target[id] : rest[id];
      let f = approach(fade[id], t, dt, walk ? 5 : 4);
      if (Math.abs(f - t) < 0.004 || (t === 1 && f > 0.99)) f = t;
      fade[id] = f;
      const byte = Math.round(f * 255);
      if (fadeData[id] !== byte) {
        fadeData[id] = byte;
        dirtyTex = true;
      }
      const ps = passOf(f);
      if (ps !== state[id]) {
        state[id] = ps;
        dirtyPass = true;
      }
      if (f === t && t === rest[id]) {
        isActive[id] = 0;
        active[k--] = active[--activeN];
      }
    }
    if (dirtyTex) fadeTex.needsUpdate = true;
    if (dirtyPass) refreshPasses();
  }

  let revealR = 0;
  const pierce = { x: 0, z: 0 };
  const camDir = new THREE.Vector3();
  const ahead = new THREE.Vector3();
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  /** Trees the camera is inside, or that stand between it and the walker, are hidden. */
  function hideTreesNear(f: THREE.Vector3): void {
    let dirty = false;
    // Also keep the first 14 m of the view direction clear (first-person view).
    ahead.copy(camDir).multiplyScalar(14).add(camPos);
    for (let i = 0; i < treeHidden.length; i++) {
      const cx = crownAt[i * 4];
      const cy = crownAt[i * 4 + 1];
      const cz = crownAt[i * 4 + 2];
      const r = crownAt[i * 4 + 3];
      const dx = camPos.x - cx;
      const dz = camPos.z - cz;
      if (dx * dx + dz * dz > 60 * 60) {
        if (treeHidden[i]) {
          treeHidden[i] = 0;
          mat4.fromArray(crownM, i * 16);
          crownMesh.setMatrixAt(i, mat4);
          mat4.fromArray(trunkM, i * 16);
          trunkMesh.setMatrixAt(i, mat4);
          dirty = true;
        }
        continue;
      }
      const hide =
        segmentNearPoint(camPos.x, camPos.y, camPos.z, f.x, f.y, f.z, cx, cy, cz, r * 0.9) ||
        segmentNearPoint(camPos.x, camPos.y, camPos.z, ahead.x, ahead.y, ahead.z, cx, cy, cz, r * 0.9) ||
        Math.hypot(dx, camPos.y - cy, dz) < r + 1.5
          ? 1
          : 0;
      if (hide === treeHidden[i]) continue;
      treeHidden[i] = hide;
      if (hide) {
        crownMesh.setMatrixAt(i, zero);
        trunkMesh.setMatrixAt(i, zero);
      } else {
        mat4.fromArray(crownM, i * 16);
        crownMesh.setMatrixAt(i, mat4);
        mat4.fromArray(trunkM, i * 16);
        trunkMesh.setMatrixAt(i, mat4);
      }
      dirty = true;
    }
    if (dirty) crownMesh.instanceMatrix.needsUpdate = trunkMesh.instanceMatrix.needsUpdate = true;
  }

  function writeGondolas(): void {
    if (!wheelSpec || !gondolas || !wheelMesh) return;
    const ang = (time / WHEEL_PERIOD_S) * Math.PI * 2;
    wheelMesh.rotation.x = -ang;
    const { hub, along, radius } = wheelSpec;
    for (let i = 0; i < WHEEL_GONDOLAS; i++) {
      const [up, al] = gondolaOffset(i, WHEEL_GONDOLAS, ang, radius);
      mat4.makeTranslation(hub.x + along.x * al, hub.y + up - 1.6, hub.z + along.z * al);
      gondolas.setMatrixAt(i, mat4);
    }
    gondolas.instanceMatrix.needsUpdate = true;
  }

  applyMode();
  applyNight();
  writeVehicles();
  writeGondolas();

  const idIndex = new Map(buildings.map((b, i) => [b.id, i]));
  let released = false;
  const city: City = {
    object: group,
    update(camera, focus, dt) {
      time += dt;
      camera.getWorldPosition(camPos);
      camera.getWorldDirection(camDir);
      fadeIn.focus.copy(focus);
      if (walk) fadeIn.focus.y += 1.5;
      updateFades(dt);
      if (walk) {
        hideTreesNear(fadeIn.focus);
        const cut = streetPiercing(camPos, focus, pierce);
        revealR = approach(revealR, cut ? 15 : 0, dt, 8);
        if (cut) uReveal.value.set(pierce.x, pierce.z, revealR, 0);
        else uReveal.value.z = revealR;
      }
      if (walk) {
        for (let i = 0; i < crossingPolys.length; i++) {
          const poly = crossingPolys[i];
          held[i] = poly && focus.y < 4 && focus.y > -2 && insideConvex(poly, focus.x, focus.z) ? 1 : 0;
        }
      }
      stepTraffic(lanes, laneInfos, vehicles, byLane, time, dt, held);
      writeVehicles();
      writeGondolas();
      if (beaconMesh && night) beaconMat.opacity = 0.25 + 0.75 * Math.max(0, Math.sin(time * 3.1));
    },
    setNight(on) {
      night = on;
      applyNight();
    },
    setRoute(points) {
      route.length = 0;
      if (points && points.length) {
        const n = Math.min(ROUTE_SAMPLES, points.length);
        for (let i = 0; i < n; i++) route.push(points[Math.round((i / Math.max(1, n - 1)) * (points.length - 1))].clone());
      }
    },
    stats() {
      let drawCalls = 0;
      let triangles = 0;
      group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || !o.visible) return;
        drawCalls++;
        const g = m.geometry;
        const count = g.index ? Math.min(g.index.count, g.drawRange.count) : g.getAttribute('position').count;
        triangles += (count / 3) * ((m as THREE.InstancedMesh).isInstancedMesh ? (m as THREE.InstancedMesh).count : 1);
      });
      return { drawCalls, triangles, buildings: buildings.length, vehicles: vehicles.length + statics.length, trees: trees.length };
    },
    buildingFade(id) {
      const i = idIndex.get(id);
      return i === undefined ? null : fade[i];
    },
    dispose() {
      group.removeFromParent();
      for (const d of disposables) d.dispose();
      for (const m of [carMesh, busMesh, carLights, busLights, trunkMesh, crownMesh, poleMesh, headMesh, poolMesh, gondolas, beaconMesh]) m?.dispose();
      disposables.length = 0;
      if (!released) releaseCityTextures();
      released = true;
    },
  };
  return city;
}

// ---------------------------------------------------------------- helpers

function segDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2));
  return Math.hypot(px - ax - dx * t, pz - az - dz * t);
}

/** Arc position where the segment a→b crosses the road's centre line, or null. */
function crossingOnRoad(info: RoadInfo, ax: number, az: number, bx: number, bz: number): number | null {
  const dx = bx - ax;
  const dz = bz - az;
  for (let i = 0; i < info.pts.length - 1; i++) {
    const [px, pz] = info.pts[i];
    const ex = info.pts[i + 1][0] - px;
    const ez = info.pts[i + 1][1] - pz;
    const den = dx * ez - dz * ex;
    if (Math.abs(den) < 1e-9) continue;
    // a + t·d = p + u·e
    const t = ((px - ax) * ez - (pz - az) * ex) / den;
    const u = ((px - ax) * dz - (pz - az) * dx) / den;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return info.cum[i] + u * (info.cum[i + 1] - info.cum[i]);
  }
  return null;
}

/**
 * Tree crown: a cluster of jittered icospheres with radial (soft) normals and a baked
 * top-light gradient in the vertex colours, so instanced crowns read as foliage, not blobs.
 */
function crownGeometry(seed: number): THREE.BufferGeometry {
  const rand = rng(seed);
  const lobes: [number, number, number, number][] = [[0, 0.05, 0, 0.8]];
  for (let i = 0; i < 3; i++) {
    const t = (i / 3) * Math.PI * 2 + rand();
    lobes.push([Math.cos(t) * 0.42, -0.2 + rand() * 0.4, Math.sin(t) * 0.42, 0.5 + rand() * 0.12]);
  }
  const pos: number[] = [];
  const nor: number[] = [];
  const colr: number[] = [];
  for (const [cx, cy, cz, r] of lobes) {
    const g = new THREE.IcosahedronGeometry(1, 1);
    const p = g.getAttribute('position');
    const cache = new Map<string, number>();
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const y = p.getY(i);
      const z = p.getZ(i);
      const key = `${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`;
      let k = cache.get(key);
      if (k === undefined) {
        k = 0.85 + rand() * 0.25;
        cache.set(key, k);
      }
      pos.push(cx + x * r * k, cy + y * r * k, cz + z * r * k);
      nor.push(x, y, z);
      // Darker underneath and inside the cluster, lighter at the sunny top.
      const lit = 0.62 + 0.38 * (y * 0.5 + 0.5) + (cy + y * r) * 0.12;
      colr.push(lit, lit, lit);
    }
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(colr, 3));
  out.computeBoundingSphere();
  return out;
}

/** Car (4.6 m) or city bus (11 m) body with glass, and a separate head/tail light geometry. */
function vehicleGeometry(bus: boolean): { body: THREE.BufferGeometry; lights: THREE.BufferGeometry } {
  const b = new Geo();
  const l = new Geo();
  const glass = new THREE.Color('#1f2a33');
  const tyre = new THREE.Color('#161616');
  const body = new THREE.Color('#ffffff');
  if (bus) {
    b.box(0, 1.75, 0, 2.5, 2.7, 11, 0, body);
    b.box(0, 2.1, 0, 2.54, 1.0, 10.2, 0, glass);
    b.box(0, 0.95, 0, 2.55, 0.25, 10.9, 0, new THREE.Color('#2f8a5b'));
    b.box(0, 3.15, -1, 1.8, 0.3, 4, 0, new THREE.Color('#d9dcde'));
    for (const z of [-3.6, 3.4]) b.box(0, 0.5, z, 2.4, 1.0, 1.0, 0, tyre);
    for (const x of [-0.9, 0.9]) {
      l.box(x, 1.0, 5.52, 0.4, 0.25, 0.05, 0, new THREE.Color('#fff6dc'));
      l.box(x, 1.0, -5.52, 0.35, 0.3, 0.05, 0, new THREE.Color('#ff2a1a'));
    }
  } else {
    b.box(0, 0.72, 0, 1.72, 0.72, 4.6, 0, body);
    b.box(0, 1.3, -0.2, 1.5, 0.5, 2.3, 0, glass);
    b.box(0, 1.56, -0.2, 1.5, 0.04, 2.1, 0, body);
    for (const z of [-1.4, 1.4]) b.box(0, 0.33, z, 1.76, 0.64, 0.66, 0, tyre);
    for (const x of [-0.6, 0.6]) {
      l.box(x, 0.8, 2.31, 0.35, 0.16, 0.04, 0, new THREE.Color('#fff6dc'));
      l.box(x, 0.85, -2.31, 0.3, 0.14, 0.04, 0, new THREE.Color('#ff2a1a'));
    }
  }
  return { body: b.build(), lights: l.build() };
}

export type { Footprint };
