import * as THREE from 'three';
import type { Network, NetNode } from '../core/types';
import {
  analyseRoads,
  approach,
  BUILDING_SPECS,
  boxCorners,
  FACADE_STYLES,
  fadeTarget,
  gondolaOffset,
  groundCells,
  groundOpenings,
  junctionStations,
  lanesPerDirection,
  layoutParts,
  onOtherRoad,
  placeStreetFurniture,
  PODIUM_TOP,
  pointAt,
  realHeight,
  rng,
  sceneHeight,
  segmentNearPoint,
  streetPiercing,
  sidewalkWidth,
  stepTraffic,
  WHEEL_GONDOLAS,
  WHEEL_PERIOD_S,
  type BuildingSpec,
  type FacadeStyle,
  type Lane,
  type OBox,
  type PartSpec,
  type RoadInfo,
  type Vehicle,
} from './city-layout';
import { acquireCityTextures, FACADE_TILE, releaseCityTextures } from './city-textures';

/**
 * City context around the station: building massing at real heights with curtain-wall
 * facades (lit windows at night), the HEP FIVE Ferris wheel, streets with lane markings,
 * kerbs and crosswalks, 御堂筋 ginkgo trees, street lamps and a little signal-controlled traffic.
 *
 * Buildings that stand between the camera and the walker (or the selected route in the
 * overview) are cut away smoothly: every building carries an id attribute, a uniform array holds
 * its current opacity, and each facade material is drawn in two passes — an opaque pass that
 * keeps only fully solid buildings (so they write depth) and a blended pass for the faded ones
 * (no depth write, so whatever is behind them stays visible). Merged geometry keeps the whole
 * module at ~30 draw calls.
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
  dispose(): void;
}

/** Layer of everything tall (buildings, trees, lamps, wheel): enable it on the main camera only,
 * so the top-down minimap keeps showing the walkways instead of roofs. */
export const CITY_LAYER = 2;

const MAX_BUILDINGS = 48;
const ROUTE_SAMPLES = 24;

// ---------------------------------------------------------------- geometry soup

const _m = new THREE.Matrix4();
const _n = new THREE.Matrix3();
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

/** Non-indexed triangle soup with normals, optional UVs, colours and a building id. */
class Geo {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  bid: number[] = [];

  private vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, w: number, c: THREE.Color, b: number): void {
    this.pos.push(x, y, z);
    this.nor.push(nx, ny, nz);
    this.uv.push(u, w);
    this.col.push(c.r, c.g, c.b);
    this.bid.push(b);
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
    return this.pos.length / 3;
  }

  build(uv = false): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    if (uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aBid', new THREE.Float32BufferAttribute(this.bid, 1));
    g.computeBoundingSphere();
    return g;
  }
}

const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();

// ---------------------------------------------------------------- fade shader

/**
 * Per-building opacity from `uFade[aBid]`. 'solid' keeps fragments of fully opaque buildings,
 * 'ghost' draws the others blended.
 */
function patchFade(mat: THREE.Material, uFade: { value: Float32Array }, pass: 'solid' | 'ghost', alphaScale = 1): void {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uFade = uFade;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\nattribute float aBid;\nuniform float uFade[${MAX_BUILDINGS}];\nvarying float vFade;`)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFade = uFade[int(aBid + 0.5)];');
    const test = pass === 'solid' ? 'if (vFade < 0.995) discard;' : 'if (vFade >= 0.995 || vFade < 0.004) discard;';
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vFade;')
      .replace('void main() {', `void main() {\n${test}`)
      .replace('#include <opaque_fragment>', pass === 'ghost' ? `#include <opaque_fragment>\ngl_FragColor.a *= vFade * mix(${alphaScale.toFixed(2)}, 1.0, smoothstep(0.12, 0.45, vFade));` : '#include <opaque_fragment>');
  };
  mat.customProgramCacheKey = () => `city-fade-${pass}-${alphaScale}`;
  mat.userData.cityFade = pass;
}

/**
 * Street surfaces get a circular cut-out (with a dark rim) at `uReveal.xy` with radius
 * `uReveal.z`, so a walker below street level stays visible to a camera above it.
 */
function patchReveal(mat: THREE.Material, uReveal: { value: THREE.Vector4 }): void {
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
  if (uReveal.z > 0.1 && distance(vRevealXZ, uReveal.xy) < uReveal.z + 0.8) gl_FragColor.rgb *= 0.45;`,
    );
  };
  mat.customProgramCacheKey = () => 'city-reveal';
}

// ---------------------------------------------------------------- build

interface BuildingRec {
  id: string;
  parts: OBox[];
  fade: number;
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
  const uFade = { value: new Float32Array(MAX_BUILDINGS).fill(walk ? 1 : 0.5) };
  const uReveal = { value: new THREE.Vector4(0, 0, 0, 0) };
  const buildings: BuildingRec[] = [];

  // ------------------------------------------------------------ buildings
  const walls = new Map<FacadeStyle, Geo>(FACADE_STYLES.map((s) => [s, new Geo()]));
  const roofs = new Geo();
  const beacons: THREE.Vector3[] = [];
  let wheelSpec: { hub: THREE.Vector3; ax: THREE.Vector3; along: THREE.Vector3; radius: number; bid: number } | null = null;
  const R = rng(42);

  for (const fp of net.footprints) {
    if (fp.kind !== 'building' && fp.kind !== 'station') continue;
    if (buildings.length >= MAX_BUILDINGS) break;
    const spec: BuildingSpec =
      BUILDING_SPECS[fp.id] ?? ({ parts: [{ a: [-0.5, 0.5], b: [-0.5, 0.5], h: [0, Math.max(fp.y1, 10)], style: 'grid', tint: '#cfcac0', roof: 'plant' }] } as BuildingSpec);
    const bid = buildings.length;
    const parts = layoutParts(fp, spec, ex);
    buildings.push({ id: fp.id, parts, fade: walk ? 1 : 0.5 });
    const uOff = R();
    const vOff = R();
    for (const part of parts) addPart(part, part.spec, bid, uOff, vOff);
    if (spec.wheel) {
      const f = parts[0];
      const vx = -f.uz;
      const vz = f.ux;
      // Wheel centre relative to the whole footprint: parts[0] spans the full long axis.
      const full = layoutParts(fp, { parts: [{ a: [-0.5, 0.5], b: [-0.5, 0.5], h: [0, 1], style: 'band', tint: '#fff' }] }, ex)[0];
      const hub = new THREE.Vector3(
        full.cx + f.ux * spec.wheel.a * full.hl * 2 + vx * spec.wheel.b * full.hw * 2,
        sceneHeight(spec.wheel.hub, ex),
        full.cz + f.uz * spec.wheel.a * full.hl * 2 + vz * spec.wheel.b * full.hw * 2,
      );
      wheelSpec = { hub, ax: new THREE.Vector3(vx, 0, vz), along: new THREE.Vector3(f.ux, 0, f.uz), radius: spec.wheel.radius, bid };
    }
  }

  function addPart(b: OBox, p: PartSpec, bid: number, uOff: number, vOff: number): void {
    const tint = col(p.tint);
    const tile = FACADE_TILE[p.style];
    const tw = tile.bay * tile.bays;
    const th = tile.floor * tile.floors;
    const geo = walls.get(p.style) as Geo;
    const cs = boxCorners(b);
    // Split walls at the top of the podium so the texture's floors follow the stretched podium.
    const cut = PODIUM_TOP * ex;
    const ys = b.y0 < cut && b.y1 > cut ? [b.y0, cut, b.y1] : [b.y0, b.y1];
    let s = 0;
    for (let i = 0; i < 4; i++) {
      const [x0, z0] = cs[i];
      const [x1, z1] = cs[(i + 1) % 4];
      const len = Math.hypot(x1 - x0, z1 - z0);
      const mx = (x0 + x1) / 2 - b.cx;
      const mz = (z0 + z1) / 2 - b.cz;
      const ml = Math.hypot(mx, mz) || 1;
      const n: [number, number, number] = [mx / ml, 0, mz / ml];
      // Snap the normal to the edge's true perpendicular.
      const px = (z1 - z0) / (len || 1);
      const pz = -(x1 - x0) / (len || 1);
      const sgn = px * n[0] + pz * n[2] >= 0 ? 1 : -1;
      n[0] = px * sgn;
      n[2] = pz * sgn;
      const u0 = s / tw + uOff;
      const u1 = (s + len) / tw + uOff;
      for (let k = 0; k < ys.length - 1; k++) {
        const ya = ys[k];
        const yb = ys[k + 1];
        const va = realHeight(ya, ex) / th + vOff;
        const vb = realHeight(yb, ex) / th + vOff;
        geo.quad([[x0, ya, z0], [x1, ya, z1], [x1, yb, z1], [x0, yb, z0]], n, tint, bid, [[u0, va], [u1, va], [u1, vb], [u0, vb]]);
      }
      s += len;
    }
    if (b.y0 < 0.01 && p.roof !== 'none' && realHeight(b.y1, ex) > 12) addStreetFront(b, cs, bid);
    addRoof(b, p, bid);
  }

  /**
   * Street level of a building: a dark shop-window band (1F) just proud of the facade and a
   * shallow canopy above it, which is what a pedestrian actually sees of a tower.
   */
  function addStreetFront(b: OBox, cs: [number, number][], bid: number): void {
    const glassTint = col('#4f5c66');
    const top = sceneHeight(4.6, ex);
    const tile = FACADE_TILE.curtain;
    const geo = walls.get('curtain') as Geo;
    const canopyC = col('#5b6166');
    for (let i = 0; i < 4; i++) {
      const [x0, z0] = cs[i];
      const [x1, z1] = cs[(i + 1) % 4];
      const len = Math.hypot(x1 - x0, z1 - z0) || 1;
      let nx = (z1 - z0) / len;
      let nz = -(x1 - x0) / len;
      if (nx * ((x0 + x1) / 2 - b.cx) + nz * ((z0 + z1) / 2 - b.cz) < 0) {
        nx = -nx;
        nz = -nz;
      }
      const o = 0.12;
      const q = [[x0 + nx * o, 0, z0 + nz * o], [x1 + nx * o, 0, z1 + nz * o], [x1 + nx * o, top, z1 + nz * o], [x0 + nx * o, top, z0 + nz * o]];
      const u1 = len / (tile.bay * tile.bays);
      geo.quad(q, [nx, 0, nz], glassTint, bid, [[0, 0.02], [u1, 0.02], [u1, 0.13], [0, 0.13]]);
      // Canopy: a thin slab projecting 1.8 m over the pavement.
      const mx = (x0 + x1) / 2 + nx * 0.9;
      const mz = (z0 + z1) / 2 + nz * 0.9;
      roofs.box(mx, top + 0.25, mz, 1.8, 0.35, len, Math.atan2(x1 - x0, z1 - z0), canopyC, bid);
    }
  }

  function addRoof(b: OBox, p: PartSpec, bid: number): void {
    const roofC = col(p.roof === 'shed' ? '#8e969c' : '#9a9d9f');
    const edge = col('#b9bcbd');
    const cs = boxCorners(b);
    roofs.fan(b.cx, b.y1, b.cz, cs, roofC, bid, true);
    const yaw = Math.atan2(b.ux, b.uz);
    const vx = -b.uz;
    const vz = b.ux;
    const at = (a: number, w: number): [number, number] => [b.cx + b.ux * a + vx * w, b.cz + b.uz * a + vz * w];
    const r = rng(bid * 97 + Math.round(b.y1));
    if (p.roof !== 'shed' && p.roof !== 'none') {
      // Parapet: four low walls just inside the roof edge.
      const ph = p.roof === 'crown' ? 9 : 1.1;
      // Box local x runs across the footprint (b axis), local z along it (a axis).
      for (const sa of [-1, 1]) {
        const [x, z] = at(sa * (b.hl - 0.25), 0);
        roofs.box(x, b.y1 + ph / 2, z, b.hw * 2, ph, 0.5, yaw, edge, bid);
      }
      for (const sb of [-1, 1]) {
        const [x, z] = at(0, sb * (b.hw - 0.25));
        roofs.box(x, b.y1 + ph / 2, z, 0.5, ph, b.hl * 2, yaw, edge, bid);
      }
    }
    const realTop = realHeight(b.y1, ex);
    if (p.roof === 'plant' || p.roof === 'heli') {
      // Machine rooms, cooling towers and ducts.
      const n = p.roof === 'heli' ? 3 : 6 + Math.floor(r() * 6);
      for (let i = 0; i < n; i++) {
        const sx = 3 + r() * Math.min(12, b.hl * 0.5);
        const sz = 3 + r() * Math.min(10, b.hw * 0.5);
        const a = (r() - 0.5) * (b.hl * 2 - sx - 3);
        const w = (r() - 0.5) * (b.hw * 2 - sz - 3);
        const h = 1.5 + r() * 3.5;
        const [x, z] = at(p.roof === 'heli' ? Math.sign(a || 1) * (b.hl - sx / 2 - 2) : a, w);
        const shade = 0.72 + r() * 0.2;
        roofs.box(x, b.y1 + h / 2, z, sz, h, sx, yaw, new THREE.Color(shade, shade, shade * 1.02), bid);
      }
    }
    if (p.roof === 'heli' && Math.min(b.hl, b.hw) > 11) {
      // Emergency helicopter space: dark pad, white circle and "H" (as on Japanese high-rises).
      const rad = Math.min(b.hl, b.hw) * 0.62;
      const ring: [number, number][] = [];
      const inner: [number, number][] = [];
      for (let i = 0; i < 28; i++) {
        const t = (i / 28) * Math.PI * 2;
        ring.push([b.cx + Math.cos(t) * rad, b.cz + Math.sin(t) * rad]);
        inner.push([b.cx + Math.cos(t) * rad * 0.86, b.cz + Math.sin(t) * rad * 0.86]);
      }
      roofs.fan(b.cx, b.y1 + 0.06, b.cz, ring, col('#eeeeea'), bid, true);
      roofs.fan(b.cx, b.y1 + 0.1, b.cz, inner, col('#4f5a55'), bid, true);
      const hc = col('#f2f2ee');
      const hs = rad * 0.5;
      for (const sa of [-1, 1]) {
        const [x, z] = at(sa * hs * 0.45, 0);
        roofs.box(x, b.y1 + 0.14, z, hs * 1.4, 0.06, hs * 0.18, yaw, hc, bid);
      }
      roofs.box(b.cx, b.y1 + 0.14, b.cz, hs * 0.18, 0.06, hs * 0.9, yaw, hc, bid);
    }
    if (p.roof === 'shed') {
      // Skylight strips along the platform shed, and the columns that carry it.
      const light = col('#c9d6dc');
      for (const w of [-0.33, 0, 0.33]) {
        const [x, z] = at(0, w * b.hw * 2);
        roofs.box(x, b.y1 + 0.3, z, 6, 0.6, b.hl * 1.9, yaw, light, bid);
      }
      const colC = col('#7d858b');
      const base = sceneHeight(10.4, ex);
      for (let a = -b.hl + 8; a <= b.hl - 8; a += 24) {
        for (const w of [-1, 1]) {
          const [x, z] = at(a, w * (b.hw - 1));
          roofs.box(x, (base + b.y0) / 2, z, 0.9, b.y0 - base, 0.9, yaw, colC, bid);
        }
      }
    }
    if (realTop >= 60 && p.roof !== 'none') for (const [x, z] of cs) beacons.push(new THREE.Vector3(x, b.y1 + (p.roof === 'crown' ? 9.5 : 1.8), z));
  }

  // HEP FIVE wheel support legs belong to the building (they fade with it).
  const wheelFrame = new Geo();
  const wheelRed = col('#d1232c');
  if (wheelSpec) {
    const { hub, ax, along, radius, bid } = wheelSpec;
    const roofY = sceneHeight(30, ex);
    const legC = col('#e8e4e0');
    for (const sa of [-1, 1]) {
      for (const sx of [-1, 1]) {
        const foot = hub.clone().addScaledVector(along, sa * radius * 0.42).addScaledVector(ax, sx * 5.5).setY(roofY);
        roofs.beam(hub.clone().addScaledVector(ax, sx * 2.6), foot, 1.1, legC, bid);
      }
    }
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

  // Facade materials: day map + night emissive map, two passes each.
  const facadeMats: THREE.MeshPhongMaterial[] = [];
  FACADE_STYLES.forEach((style) => {
    const geo = walls.get(style) as Geo;
    if (geo.count === 0) return;
    const tex = textures.facade.get(style);
    const g = own(geo.build(true));
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
        }),
      );
      patchFade(m, uFade, pass);
      facadeMats.push(m);
      const mesh = new THREE.Mesh(g, m);
      mesh.renderOrder = pass === 'ghost' ? -0.5 : 0;
      mesh.name = `city-${style}-${pass}`;
      tall(mesh);
    }
  });
  const roofMats: THREE.MeshLambertMaterial[] = [];
  if (roofs.count) {
    const g = own(roofs.build());
    for (const pass of ['solid', 'ghost'] as const) {
      const m = own(new THREE.MeshLambertMaterial({ vertexColors: true, transparent: pass === 'ghost', depthWrite: pass === 'solid' }));
      // Rooftop clutter stacks many faces: when cut away, ghost it harder than the walls.
      patchFade(m, uFade, pass, 0.45);
      roofMats.push(m);
      const mesh = new THREE.Mesh(g, m);
      mesh.renderOrder = pass === 'ghost' ? -0.5 : 0;
      mesh.name = `city-roofs-${pass}`;
      tall(mesh);
    }
  }

  // Ferris wheel (rotating frame + gondolas that stay level).
  let wheelMesh: THREE.Mesh | null = null;
  let gondolas: THREE.InstancedMesh | null = null;
  const wheelMat = dim(own(new THREE.MeshLambertMaterial({ vertexColors: true })));
  if (wheelSpec) {
    wheelMesh = new THREE.Mesh(own(wheelFrame.build()), wheelMat);
    wheelMesh.position.copy(wheelSpec.hub);
    wheelMesh.rotation.order = 'YXZ';
    wheelMesh.rotation.y = Math.atan2(-wheelSpec.ax.z, wheelSpec.ax.x);
    // Gondolas must follow the frame's local +z, whichever way the footprint axis points.
    wheelSpec.along.set(Math.sin(wheelMesh.rotation.y), 0, Math.cos(wheelMesh.rotation.y));
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
  const { infos, junctions } = analyseRoads(net.roads);
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
  const Y_ROAD = 0.02;
  const Y_MARK = 0.045;
  const Y_WALK = 0.15;
  const Y_GROUND = -0.1;
  let groundMesh: THREE.Mesh | null = null;
  const tmp = { x: 0, z: 0, dx: 1, dz: 0, seg: 0 };

  const ribbon = (geo: Geo, info: RoadInfo, s0: number, s1: number, l0: number, l1: number, y: number, c: THREE.Color, uv = 0) => {
    // Quad between arc s0..s1 and lateral offsets l0..l1 (left of the polyline direction).
    pointAt(info, s0, tmp);
    const ax = tmp.x;
    const az = tmp.z;
    const alx = tmp.dz;
    const alz = -tmp.dx;
    pointAt(info, s1, tmp);
    const bx = tmp.x;
    const bz = tmp.z;
    // Use the direction at the start for both ends (pieces are short and straight).
    const P = (x: number, z: number, l: number) => [x + alx * l, y, z + alz * l];
    const p = [P(ax, az, l0), P(bx, bz, l0), P(bx, bz, l1), P(ax, az, l1)];
    geo.quad(p, [0, 1, 0], c, 0, uv ? p.map((q) => [q[0] * uv, -q[2] * uv]) : undefined);
  };

  infos.forEach((info, i) => {
    const w = info.road.width;
    const sw = sidewalkWidth(w);
    // Asphalt per polyline segment plus round joints at bends.
    for (let k = 0; k < info.pts.length - 1; k++) {
      const s0 = info.cum[k];
      const s1 = info.cum[k + 1];
      ribbon(asphalt, info, s0 + 0.001, s1 - 0.001, -w / 2, w / 2, Y_ROAD, asphaltC, 1 / 7);
      if (k > 0) {
        const [x, z] = info.pts[k];
        const ring: [number, number][] = [];
        for (let t = 0; t < 20; t++) ring.push([x + Math.cos((t / 20) * Math.PI * 2) * (w / 2), z + Math.sin((t / 20) * Math.PI * 2) * (w / 2)]);
        asphalt.fan(x, Y_ROAD, z, ring, asphaltC, 0, true, 1 / 7);
      }
    }
    const stations = junctionStations(info, junctions);
    const inJunction = (s: number, extra: number) => stations.some((j) => Math.abs(j.s - s) < j.r + extra);

    // Sidewalks with kerbs, in 3 m pieces; pieces that would lie on another road are dropped.
    const step = 3;
    for (let s = 0; s < info.len - 0.5; s += step) {
      const s1 = Math.min(info.len, s + step);
      pointAt(info, (s + s1) / 2, tmp);
      for (const side of [1, -1]) {
        const mid = w / 2 + sw / 2;
        const mx = tmp.x + tmp.dz * side * mid;
        const mz = tmp.z - tmp.dx * side * mid;
        if (onOtherRoad(mx, mz, infos, i, 1.5)) continue;
        const l0 = side * (w / 2);
        const l1 = side * (w / 2 + sw);
        ribbon(walksG, info, s, s1, l0, l1, Y_WALK, col('#ffffff'), 1 / 2.4);
        // Kerb face towards the road and a small face at the back edge.
        for (const [l, y0] of [[l0, Y_ROAD], [l1, 0]] as const) {
          pointAt(info, s, tmp);
          const ax = tmp.x + tmp.dz * l;
          const az = tmp.z - tmp.dx * l;
          pointAt(info, s1, tmp);
          const bx = tmp.x + tmp.dz * l;
          const bz = tmp.z - tmp.dx * l;
          const nx = tmp.dz * side * (l === l0 ? -1 : 1);
          const nz = -tmp.dx * side * (l === l0 ? -1 : 1);
          walksG.quad([[ax, y0, az], [bx, y0, bz], [bx, Y_WALK, bz], [ax, Y_WALK, az]], [nx, 0, nz], kerbC);
        }
      }
    }

    // Lane lines: dashed between lanes, solid double centre line and edge lines.
    const n = lanesPerDirection(w);
    const lines: { l: number; dash: boolean; c: THREE.Color; wdt: number }[] = [
      { l: 0.2, dash: false, c: n >= 2 ? yellow : white, wdt: 0.15 },
      { l: -0.2, dash: false, c: n >= 2 ? yellow : white, wdt: 0.15 },
      { l: w / 2 - 0.9, dash: false, c: white, wdt: 0.2 },
      { l: -(w / 2 - 0.9), dash: false, c: white, wdt: 0.2 },
    ];
    for (let k = 1; k < n; k++) for (const sgn of [1, -1]) lines.push({ l: sgn * (0.4 + k * 3.25), dash: true, c: white, wdt: 0.15 });
    for (const ln of lines) {
      const period = ln.dash ? 10 : 5;
      const on = 5;
      for (let s = 0; s + on <= info.len; s += period) {
        if (inJunction(s, 8) || inJunction(s + on, 8)) continue;
        pointAt(info, s + on / 2, tmp);
        if (onOtherRoad(tmp.x + tmp.dz * ln.l, tmp.z - tmp.dx * ln.l, infos, i, 0.5)) continue;
        ribbon(marks, info, s, s + on, ln.l - ln.wdt / 2, ln.l + ln.wdt / 2, Y_MARK, ln.c);
      }
    }

    // Crosswalks and stop lines on every arm of each junction (unless a network crossing is there).
    for (const j of stations) {
      for (const arm of [1, -1]) {
        const sc = j.s + arm * (j.r + 3.5);
        if (sc < 2 || sc > info.len - 2) continue;
        pointAt(info, sc, tmp);
        const cx = tmp.x;
        const cz = tmp.z;
        const covered = crossings.some((c) => segDist(cx, cz, c.a.x, c.a.z, c.b.x, c.b.z) < 10);
        if (!covered) {
          for (let l = -w / 2 + 1.2; l <= w / 2 - 1.2; l += 0.9) ribbon(marks, info, sc - 2, sc + 2, l, l + 0.45, Y_MARK, white);
        }
        const ss = sc + arm * 4;
        if (ss > 0 && ss < info.len) {
          // Stop line across the lanes approaching the junction (keep-left traffic).
          const side = arm === 1 ? -1 : 1;
          ribbon(marks, info, ss - 0.225, ss + 0.225, side * 0.4, side * (w / 2 - 0.9), Y_MARK, white);
        }
      }
    }
  });

  // Network crossings: zebra only where the crossing lies on asphalt.
  for (const { e, a, b } of crossings) {
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 1) continue;
    const dx = (b.x - a.x) / len;
    const dz = (b.z - a.z) / len;
    const W = Math.min(7, Math.max(4, (e.width ?? 8) * 0.7));
    const lx = dz;
    const lz = -dx;
    for (let d = 0.6; d < len - 0.6; d += 0.9) {
      const x = a.x + dx * d;
      const z = a.z + dz * d;
      if (!onOtherRoad(x, z, infos, -1, -0.8)) continue;
      const p0 = [x - lx * W / 2, Y_MARK + 0.005, z - lz * W / 2];
      const p1 = [x + lx * W / 2, Y_MARK + 0.005, z + lz * W / 2];
      const q1 = [p1[0] + dx * 0.45, p1[1], p1[2] + dz * 0.45];
      const q0 = [p0[0] + dx * 0.45, p0[1], p0[2] + dz * 0.45];
      marks.quad([p0, p1, q1, q0], [0, 1, 0], white);
    }
  }

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
    const xs = net.nodes.map((n) => n.x);
    const zs = net.nodes.map((n) => n.z);
    const gx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const gz = (Math.min(...zs) + Math.max(...zs)) / 2;
    const half = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)) / 2 + 320;
    const ground = new Geo();
    const gc = col('#ffffff');
    for (const [x0, z0, x1, z1] of groundCells(gx, gz, half, groundOpenings(net.nodes, net.edges))) {
      const q = [[x0, Y_GROUND, z0], [x1, Y_GROUND, z0], [x1, Y_GROUND, z1], [x0, Y_GROUND, z1]];
      ground.quad(q, [0, 1, 0], gc, 0, q.map((v) => [v[0] / 3.2, -v[2] / 3.2]));
    }
    const groundMat = own(
      new THREE.MeshLambertMaterial({ color: dark ? 0xa39a8c : 0xd9cfc0, map: textures.paving, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 }),
    );
    patchReveal(groundMat, uReveal);
    groundMesh = new THREE.Mesh(own(ground.build(true)), groundMat);
    groundMesh.name = 'city-ground';
    groundMesh.renderOrder = -2;
    tall(groundMesh);
  }

  // ------------------------------------------------------------ trees and lamps
  const footprintBoxes = buildings.flatMap((b) => b.parts.filter((p) => p.y0 < 1));
  const blocked = (x: number, z: number) =>
    footprintBoxes.some((b) => inBox(x, z, b, 2)) ||
    crossings.some((c) => segDist(x, z, c.a.x, c.a.z, c.b.x, c.b.z) < (c.e.width ?? 8) / 2 + 4) ||
    net.nodes.some((n) => n.level === '1F' && n.kind !== 'junction' && Math.hypot(n.x - x, n.z - z) < 5);
  const { trees, lamps } = placeStreetFurniture(infos, junctions, blocked);

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
    const n = lanesPerDirection(info.road.width);
    const terminal = info.road.id === 'ekimae';
    const count = terminal ? 1 : n;
    const first = info.pts[0];
    const last = info.pts[info.pts.length - 1];
    const phase: 0 | 1 = Math.abs(last[0] - first[0]) > Math.abs(last[1] - first[1]) ? 1 : 0;
    const st = junctionStations(info, junctions);
    for (const dir of [1, -1] as const) {
      const stops = st.map((j) => j.s - dir * (j.r + 8)).filter((s) => s > 0 && s < info.len);
      if (dir === -1) stops.reverse();
      for (let k = 0; k < count; k++) lanes.push({ road: ri, dir, lat: dir * (0.4 + (k + 0.5) * 3.25), stops, phase });
    }
  });
  const vehicles: Vehicle[] = [];
  const byLane: number[][] = lanes.map(() => []);
  const vr = rng(9);
  lanes.forEach((lane, li) => {
    const len = infos[lane.road].len;
    let p = len - 5 - vr() * 20;
    while (p > 10) {
      const bus = infos[lane.road].road.width >= 30 && vr() < 0.08;
      const v: Vehicle = { lane: li, s: lane.dir === 1 ? p : len - p, v: 6 + vr() * 5, type: bus ? 1 : 0, len: bus ? 11 : 4.6 };
      byLane[li].push(vehicles.length);
      vehicles.push(v);
      p -= 34 + vr() * 60;
    }
  });
  // Parked buses at the 大阪駅前 bus terminal and a taxi rank opposite.
  const statics: { x: number; z: number; yaw: number; type: 0 | 1; color: string }[] = [];
  const eki = infos.find((i) => i.road.id === 'ekimae');
  if (eki) {
    const w = eki.road.width;
    const js = junctionStations(eki, junctions);
    for (let s = 70; s < eki.len - 60; s += 17) {
      if (js.some((j) => Math.abs(j.s - s) < j.r + 14) || vr() < 0.25) continue;
      pointAt(eki, s, tmp);
      // Keep-left: the station (north) kerb carries eastbound buses, the south kerb westbound taxis.
      const north = -tmp.dx < 0 ? 1 : -1; // sign of "left" (dz, −dx) pointing north
      const l = north * (w / 2 - 2.2);
      const east = tmp.dx >= 0 ? 1 : -1;
      statics.push({ x: tmp.x + tmp.dz * l, z: tmp.z - tmp.dx * l, yaw: Math.atan2(tmp.dx * east, tmp.dz * east), type: 1, color: vr() < 0.7 ? '#f0f2f0' : '#e6ecf5' });
    }
    for (let s = 120; s < eki.len - 90; s += 5.6) {
      pointAt(eki, s, tmp);
      const north = -tmp.dx < 0 ? 1 : -1;
      const l = -north * (w / 2 - 2);
      const east = tmp.dx >= 0 ? 1 : -1;
      statics.push({ x: tmp.x + tmp.dz * l, z: tmp.z - tmp.dx * l, yaw: Math.atan2(-tmp.dx * east, -tmp.dz * east), type: 0, color: vr() < 0.6 ? '#1c1d20' : vr() < 0.5 ? '#f2c230' : '#2f6a4a' });
    }
  }

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
      const info = infos[lane.road];
      pointAt(info, v.s, tmp, tmp.seg);
      const x = tmp.x + tmp.dz * lane.lat;
      const z = tmp.z - tmp.dx * lane.lat;
      const fx = tmp.dx * lane.dir;
      const fz = tmp.dz * lane.dir;
      // Rotation about y taking local +z to the travel direction (fx, fz), plus translation.
      mat4.set(fz, 0, fx, x, 0, 1, 0, Y_ROAD, -fx, 0, fz, z, 0, 0, 0, 1);
      (v.type === 0 ? carMesh : busMesh).setMatrixAt(slot[i], mat4);
    }
    carMesh.instanceMatrix.needsUpdate = true;
    busMesh.instanceMatrix.needsUpdate = true;
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

  let released = false;
  const city: City = {
    object: group,
    update(camera, focus, dt) {
      time += dt;
      camera.getWorldPosition(camPos);
      camera.getWorldDirection(camDir);
      fadeIn.focus.copy(focus);
      if (walk) fadeIn.focus.y += 1.5;
      for (let i = 0; i < buildings.length; i++) {
        const b = buildings[i];
        b.fade = approach(b.fade, fadeTarget(b.parts, fadeIn), dt, walk ? 5 : 4);
        uFade.value[i] = b.fade > 0.99 ? 1 : b.fade;
      }
      if (walk) {
        hideTreesNear(fadeIn.focus);
        const cut = streetPiercing(camPos, focus, pierce);
        revealR = approach(revealR, cut ? 15 : 0, dt, 8);
        if (cut) uReveal.value.set(pierce.x, pierce.z, revealR, 0);
        else uReveal.value.z = revealR;
      }
      stepTraffic(lanes, infos, vehicles, byLane, time, dt);
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
        const tris = (g.index ? g.index.count : g.getAttribute('position').count) / 3;
        triangles += tris * ((m as THREE.InstancedMesh).isInstancedMesh ? (m as THREE.InstancedMesh).count : 1);
      });
      return { drawCalls, triangles, buildings: buildings.length, vehicles: vehicles.length + statics.length, trees: trees.length };
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

function inBox(x: number, z: number, b: OBox, margin: number): boolean {
  const dx = x - b.cx;
  const dz = z - b.cz;
  return Math.abs(dx * b.ux + dz * b.uz) < b.hl + margin && Math.abs(-dx * b.uz + dz * b.ux) < b.hw + margin;
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

