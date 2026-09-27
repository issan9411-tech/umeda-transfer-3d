import type { Footprint, NetEdge, NetNode, Road } from '../core/types';
import { CLEARANCE, clipConvex, flightWidth, type WalkPiece, type WalkSpace } from './walk-space';
import { clipHalfPlane, polyArea, subtractConvex, type P2 } from './walkway-util';

/**
 * Pure layout maths for the city context (no three.js, no DOM): building massing specs,
 * road junction analysis, street-furniture placement, camera cut-away tests and the tiny
 * traffic model. Everything here is in local metres (x = east, z = south).
 */

// ---------------------------------------------------------------- heights

/** Top of the station decks (3F). Below it the city follows the view's vertical exaggeration. */
export const PODIUM_TOP = 14;

/**
 * Real height (m above street) → scene Y. Podium floors are stretched with the network's
 * exaggeration so a building's 2F/3F lines up with the decks that enter it; everything above
 * 3F is added at true scale, so towers keep their real skyline height.
 */
export function sceneHeight(h: number, ex: number): number {
  return h <= PODIUM_TOP ? h * ex : PODIUM_TOP * ex + (h - PODIUM_TOP);
}

/** Inverse of sceneHeight. */
export function realHeight(y: number, ex: number): number {
  const top = PODIUM_TOP * ex;
  return y <= top ? y / ex : PODIUM_TOP + (y - top);
}

// ---------------------------------------------------------------- building specs

export type FacadeStyle = 'curtain' | 'grid' | 'band' | 'stone';
export const FACADE_STYLES: FacadeStyle[] = ['curtain', 'grid', 'band', 'stone'];

/**
 * One box of a building, as fractions of the footprint rectangle: `a` along its long axis
 * (−0.5…0.5, + = the footprint's bearing direction), `b` across it, `h` real metres.
 */
export interface PartSpec {
  a: [number, number];
  b: [number, number];
  h: [number, number];
  style: FacadeStyle;
  /** Facade tint (multiplies the texture). */
  tint: string;
  /** Rooftop dressing of this part. */
  roof?: 'plant' | 'heli' | 'crown' | 'shed' | 'none';
}

export interface BuildingSpec {
  parts: PartSpec[];
  /** HEP FIVE: Ferris wheel on the roof (real metres, relative to the footprint frame). */
  wheel?: { a: number; b: number; hub: number; radius: number };
}

const P = (a: [number, number], b: [number, number], h: [number, number], style: FacadeStyle, tint: string, roof?: PartSpec['roof']): PartSpec => ({
  a,
  b,
  h,
  style,
  tint,
  roof,
});
const FULL: [number, number] = [-0.5, 0.5];

/**
 * Massing of the footprints in data/context.ts. Heights are the published ones where known
 * (roof height, not antenna): e.g. グランフロント大阪 タワーA 179 m, 梅田阪急ビル 187 m,
 * JPタワー大阪 188 m, ハービスOSAKA 190 m, グラングリーン大阪 南館 181.5 m, 大阪駅前第3ビル 142 m.
 * Podiums are estimated from floor counts. Bearings: 76°/97° footprints run east–west
 * (a+ = east, b+ = south); 355°/0° ones run north–south (a+ = north, b+ = east).
 */
export const BUILDING_SPECS: Record<string, BuildingSpec> = {
  // ノースゲートビルディング: 150 m office tower at the west end, LUCUA 1100 block to the east.
  ngb: {
    parts: [
      P(FULL, [-0.45, 0.5], [0, 30], 'band', '#c9d2d8'),
      P([-0.48, -0.1], [-0.36, 0.38], [30, 150], 'curtain', '#a9bccb', 'heli'),
      P([-0.06, 0.46], [-0.4, 0.42], [30, 70], 'curtain', '#b9c5cc', 'plant'),
    ],
  },
  // サウスゲートビルディング: 大丸梅田店 podium + ホテルグランヴィア slab, 122 m.
  sgb: {
    parts: [
      P(FULL, FULL, [0, 58], 'stone', '#ddd5c8', 'plant'),
      P([-0.46, 0.2], [-0.36, 0.3], [58, 122], 'grid', '#e4dfd6', 'heli'),
    ],
  },
  'gfo-s': {
    parts: [
      P(FULL, FULL, [0, 42], 'curtain', '#c3ccd2', 'plant'),
      P([-0.05, 0.45], [-0.38, 0.3], [42, 179], 'curtain', '#9fb2c2', 'heli'),
    ],
  },
  'gfo-n': {
    parts: [
      P(FULL, FULL, [0, 45], 'curtain', '#c3ccd2', 'plant'),
      P([-0.46, -0.08], [-0.34, 0.3], [45, 174], 'curtain', '#9fb2c2', 'heli'),
      P([0.12, 0.47], [-0.3, 0.26], [45, 154], 'curtain', '#aab8c4', 'heli'),
    ],
  },
  inogate: {
    parts: [
      P(FULL, FULL, [0, 22], 'curtain', '#cfd6db', 'none'),
      P([-0.44, 0.44], [-0.4, 0.4], [22, 122], 'band', '#b8c3cc', 'heli'),
    ],
  },
  ugp: { parts: [P(FULL, FULL, [0, 15], 'curtain', '#d3dcd6', 'plant')] },
  'ggo-s': {
    parts: [
      P(FULL, FULL, [0, 30], 'curtain', '#cfd6d8', 'plant'),
      P([0.02, 0.48], [-0.46, 0.34], [30, 181.5], 'curtain', '#a8b8c0', 'heli'),
      P([-0.47, -0.08], [-0.2, 0.44], [30, 128], 'band', '#bcc6cc', 'heli'),
    ],
  },
  // JPタワー大阪: KITTE 大阪 podium, 188 m tower.
  kitte: {
    parts: [
      P(FULL, FULL, [0, 38], 'stone', '#e2ddd3', 'plant'),
      P([-0.1, 0.46], [-0.42, 0.42], [38, 188], 'curtain', '#b3c1cc', 'heli'),
    ],
  },
  // ヨドバシ梅田タワー: dark camera-store box, hotel/office tower to the north, 150 m.
  yodobashi: {
    parts: [
      P(FULL, FULL, [0, 45], 'band', '#8b949c', 'plant'),
      P([0.04, 0.46], [-0.36, 0.34], [45, 150], 'curtain', '#a2b0bb', 'heli'),
    ],
  },
  // 梅田阪急ビル: 阪急うめだ本店 podium (13F), office tower to 187 m.
  'hk-dept': {
    parts: [
      P(FULL, FULL, [0, 62], 'stone', '#d8cdbb', 'plant'),
      P([-0.2, 0.4], [-0.36, 0.36], [62, 187], 'curtain', '#a7b6c1', 'heli'),
    ],
  },
  herbis: {
    parts: [
      P(FULL, FULL, [0, 30], 'stone', '#d7cfc3', 'plant'),
      P([-0.3, 0.4], [-0.36, 0.3], [30, 190], 'curtain', '#b3b8b8', 'crown'),
    ],
  },
  // 大阪駅前ビル群 (1970s–80s): tiled walls with punched windows. 第3ビル is the tallest (142 m).
  ekimae1: { parts: [P(FULL, FULL, [0, 50], 'grid', '#d6d0c4', 'plant')] },
  ekimae2: { parts: [P(FULL, FULL, [0, 66], 'grid', '#cfc9bd', 'plant')] },
  ekimae3: {
    parts: [
      P(FULL, FULL, [0, 22], 'grid', '#d3cdc2', 'plant'),
      P([-0.42, 0.42], [-0.42, 0.42], [22, 132], 'grid', '#ddd8ce', 'plant'),
      P([-0.12, 0.12], [-0.25, 0.25], [132, 142], 'grid', '#ddd8ce', 'none'),
    ],
  },
  ekimae4: {
    parts: [
      P(FULL, FULL, [0, 22], 'grid', '#d3cdc2', 'plant'),
      P([-0.4, 0.4], [-0.42, 0.42], [22, 94], 'grid', '#d8d2c6', 'plant'),
    ],
  },
  // HEP FIVE: red Ferris wheel (Ø75 m, top 106 m) over the lower east wing.
  hepfive: {
    parts: [
      P(FULL, [-0.5, 0.12], [0, 46], 'band', '#e9e2dc', 'plant'),
      P(FULL, [0.12, 0.5], [0, 30], 'band', '#e9e2dc', 'none'),
    ],
    wheel: { a: 0, b: 0.31, hub: 68.5, radius: 37.5 },
  },
  // 阪急大阪梅田駅: concourse block under the 3F platforms and a long steel platform shed.
  'hankyu:bldg': {
    parts: [
      P(FULL, FULL, [0, 10.4], 'stone', '#c9b9a4', 'none'),
      P(FULL, [-0.47, 0.47], [21, 23], 'band', '#a9b0b6', 'shed'),
    ],
  },
  // 大阪梅田ツインタワーズ・サウス: 阪神梅田本店 podium + 190 m tower.
  'hanshin:bldg': {
    parts: [
      P(FULL, FULL, [0, 55], 'stone', '#d9d2c6', 'plant'),
      P([-0.1, 0.44], [-0.34, 0.34], [55, 190], 'curtain', '#a4b3bf', 'heli'),
    ],
  },
};

// ---------------------------------------------------------------- oriented boxes

/** Oriented box in scene coordinates: centre, unit long axis (ux, uz), half sizes, Y range. */
export interface OBox {
  cx: number;
  cz: number;
  ux: number;
  uz: number;
  hl: number;
  hw: number;
  y0: number;
  y1: number;
}

/** Frame of a (near-)rectangular footprint: centre, unit axis along the long side, sizes. */
export function footprintFrame(poly: [number, number][]): { cx: number; cz: number; ux: number; uz: number; L: number; W: number } {
  const n = poly.length;
  const cx = poly.reduce((s, p) => s + p[0], 0) / n;
  const cz = poly.reduce((s, p) => s + p[1], 0) / n;
  // Longest edge gives the axis; its neighbour the width.
  let best = 0;
  let bl = -1;
  for (let i = 0; i < n; i++) {
    const [x0, z0] = poly[i];
    const [x1, z1] = poly[(i + 1) % n];
    const l = Math.hypot(x1 - x0, z1 - z0);
    if (l > bl) {
      bl = l;
      best = i;
    }
  }
  const [x0, z0] = poly[best];
  const [x1, z1] = poly[(best + 1) % n];
  let ux = (x1 - x0) / (bl || 1);
  let uz = (z1 - z0) / (bl || 1);
  // Orient the axis like data/builder rect(): long axis pointing to the footprint's first vertex side.
  const [px, pz] = poly[0];
  if ((px - cx) * ux + (pz - cz) * uz < 0) {
    ux = -ux;
    uz = -uz;
  }
  // Extents along both axes (robust to rounding of the vertices).
  const vx = -uz;
  const vz = ux;
  let L = 0;
  let W = 0;
  for (const [x, z] of poly) {
    L = Math.max(L, Math.abs((x - cx) * ux + (z - cz) * uz));
    W = Math.max(W, Math.abs((x - cx) * vx + (z - cz) * vz));
  }
  return { cx, cz, ux, uz, L: L * 2, W: W * 2 };
}

/**
 * Scene boxes of a building's parts. The b axis follows builder.rect(): v = (−uz, ux) rotated so
 * that b+ is east for north–south footprints and south for east–west ones.
 */
export function layoutParts(fp: Footprint, spec: BuildingSpec, ex: number): (OBox & { spec: PartSpec })[] {
  const f = footprintFrame(fp.poly);
  // builder.rect: u = (sin r, −cos r), v = (−uz, ux) = (cos r, sin r).
  const vx = -f.uz;
  const vz = f.ux;
  return spec.parts.map((p) => {
    const am = (p.a[0] + p.a[1]) / 2;
    const bm = (p.b[0] + p.b[1]) / 2;
    return {
      cx: f.cx + f.ux * am * f.L + vx * bm * f.W,
      cz: f.cz + f.uz * am * f.L + vz * bm * f.W,
      ux: f.ux,
      uz: f.uz,
      hl: ((p.a[1] - p.a[0]) / 2) * f.L,
      hw: ((p.b[1] - p.b[0]) / 2) * f.W,
      y0: sceneHeight(p.h[0], ex),
      y1: sceneHeight(p.h[1], ex),
      spec: p,
    };
  });
}

/** Corners (x, z) of a box, counter-clockwise seen from above (outward normals for CCW in x/−z). */
export function boxCorners(b: OBox): [number, number][] {
  const vx = -b.uz;
  const vz = b.ux;
  const c = (sa: number, sb: number): [number, number] => [b.cx + b.ux * b.hl * sa + vx * b.hw * sb, b.cz + b.uz * b.hl * sa + vz * b.hw * sb];
  return [c(-1, -1), c(1, -1), c(1, 1), c(-1, 1)];
}

/**
 * Does segment a→b pass through the box (shrunk by `pad` metres)? Slab test in the box frame.
 */
export function segmentHitsBox(ax: number, ay: number, az: number, bx: number, by: number, bz: number, box: OBox, pad = 0): boolean {
  const vx = -box.uz;
  const vz = box.ux;
  const dxa = ax - box.cx;
  const dza = az - box.cz;
  const dxb = bx - box.cx;
  const dzb = bz - box.cz;
  const p0 = [dxa * box.ux + dza * box.uz, dxa * vx + dza * vz, ay];
  const p1 = [dxb * box.ux + dzb * box.uz, dxb * vx + dzb * vz, by];
  const lo = [-box.hl + pad, -box.hw + pad, box.y0];
  const hi = [box.hl - pad, box.hw - pad, box.y1 - pad];
  let t0 = 0;
  let t1 = 1;
  for (let k = 0; k < 3; k++) {
    const d = p1[k] - p0[k];
    if (Math.abs(d) < 1e-9) {
      if (p0[k] < lo[k] || p0[k] > hi[k]) return false;
      continue;
    }
    let ta = (lo[k] - p0[k]) / d;
    let tb = (hi[k] - p0[k]) / d;
    if (ta > tb) [ta, tb] = [tb, ta];
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return false;
  }
  return true;
}

/** Euclidean distance from a point to the box (0 inside). */
export function distanceToBox(px: number, py: number, pz: number, box: OBox): number {
  const dx = px - box.cx;
  const dz = pz - box.cz;
  const a = Math.abs(dx * box.ux + dz * box.uz) - box.hl;
  const b = Math.abs(dx * -box.uz + dz * box.ux) - box.hw;
  const c = py < box.y0 ? box.y0 - py : py > box.y1 ? py - box.y1 : 0;
  return Math.hypot(Math.max(0, a), Math.max(0, b), c);
}

/** Horizontal distance from (x, z) to the box footprint (0 inside). */
export function distanceToFootprint(x: number, z: number, box: OBox): number {
  const dx = x - box.cx;
  const dz = z - box.cz;
  const a = Math.abs(dx * box.ux + dz * box.uz) - box.hl;
  const b = Math.abs(dx * -box.uz + dz * box.ux) - box.hw;
  return Math.hypot(Math.max(0, a), Math.max(0, b));
}

// ---------------------------------------------------------------- cut-away

export interface FadeInput {
  camera: { x: number; y: number; z: number };
  focus: { x: number; y: number; z: number };
  /** Route samples (scene coordinates) that should stay visible in the overview. */
  route: { x: number; y: number; z: number }[];
  walk: boolean;
}

/** Opacity a building settles at in the overview when nothing needs cutting away. */
export const OVERVIEW_OPACITY = 0.5;
/** Opacity of a cut-away building (a faint ghost, so the skyline stays legible). */
export const GHOST_OPACITY = 0.1;

/**
 * Target opacity of one building. Walking: fully solid unless it stands between the camera and
 * the walker, or the camera is inside / grazing it. Overview: semi-solid, and ghosted when it
 * hides (or stands on) part of the selected route.
 */
export function fadeTarget(parts: OBox[], o: FadeInput): number {
  const { camera: c, focus: f } = o;
  const ghost = o.walk ? GHOST_OPACITY * 0.7 : GHOST_OPACITY;
  for (const b of parts) {
    if (distanceToBox(c.x, c.y, c.z, b) < (o.walk ? 3 : 10)) return ghost;
    if (segmentHitsBox(c.x, c.y, c.z, f.x, f.y, f.z, b, o.walk ? 0.4 : 0)) return ghost;
  }
  if (o.walk) {
    // The walker standing inside the building (indoor concourse) also cuts it away.
    for (const b of parts) if (distanceToBox(f.x, f.y, f.z, b) < 0.5) return ghost;
    return 1;
  }
  for (const b of parts) {
    for (const p of o.route) {
      if (distanceToFootprint(p.x, p.z, b) < 18 && p.y < b.y1 + 20) return GHOST_OPACITY * 1.4;
      if (segmentHitsBox(c.x, c.y, c.z, p.x, p.y, p.z, b)) return GHOST_OPACITY * 1.4;
    }
  }
  return OVERVIEW_OPACITY;
}

/** Frame-rate independent approach of `v` to `target` (time constant ≈ 1/rate s). */
export function approach(v: number, target: number, dt: number, rate = 6): number {
  return v + (target - v) * (1 - Math.exp(-Math.max(0, dt) * rate));
}

// ---------------------------------------------------------------- roads

export interface RoadInfo {
  road: Road;
  pts: [number, number][];
  /** Cumulative length at each vertex. */
  cum: number[];
  len: number;
}

export interface Junction {
  x: number;
  z: number;
  /** Radius of the box junction (half the widest road through it). */
  r: number;
  roads: number[];
}

export function roadInfo(road: Road, pts = road.points): RoadInfo {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return { road, pts, cum, len: cum[cum.length - 1] };
}

/** Nearest point on a polyline: distance, arc position s and the point. */
export function nearestOnPolyline(x: number, z: number, info: RoadInfo): { d: number; s: number; x: number; z: number } {
  let best = { d: Infinity, s: 0, x: 0, z: 0 };
  for (let i = 0; i < info.pts.length - 1; i++) {
    const [x0, z0] = info.pts[i];
    const [x1, z1] = info.pts[i + 1];
    const dx = x1 - x0;
    const dz = z1 - z0;
    const l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - x0) * dx + (z - z0) * dz) / l2));
    const px = x0 + dx * t;
    const pz = z0 + dz * t;
    const d = Math.hypot(x - px, z - pz);
    if (d < best.d) best = { d, s: info.cum[i] + t * Math.sqrt(l2), x: px, z: pz };
  }
  return best;
}

/** Position and unit direction at arc length s (clamped). */
export function pointAt(info: RoadInfo, s: number, out = { x: 0, z: 0, dx: 1, dz: 0, seg: 0 }, hint = 0): typeof out {
  const c = info.cum;
  const sc = Math.max(0, Math.min(info.len, s));
  let i = Math.max(0, Math.min(hint, c.length - 2));
  while (i < c.length - 2 && sc > c[i + 1]) i++;
  while (i > 0 && sc < c[i]) i--;
  const [x0, z0] = info.pts[i];
  const [x1, z1] = info.pts[i + 1];
  const l = c[i + 1] - c[i] || 1;
  const t = (sc - c[i]) / l;
  out.x = x0 + (x1 - x0) * t;
  out.z = z0 + (z1 - z0) * t;
  out.dx = (x1 - x0) / l;
  out.dz = (z1 - z0) / l;
  out.seg = i;
  return out;
}

/**
 * Finds junctions (vertices of one road lying on another, and dangling road ends close to
 * another road, which are snapped onto it) and merges those closer than 20 m.
 */
export function analyseRoads(roads: Road[]): { infos: RoadInfo[]; junctions: Junction[] } {
  const base = roads.map((r) => roadInfo(r));
  const raw: { x: number; z: number; r: number; roads: Set<number> }[] = [];
  const pts = roads.map((r) => r.points.map((p) => [p[0], p[1]] as [number, number]));
  roads.forEach((r, i) => {
    r.points.forEach((p, k) => {
      const end = k === 0 || k === r.points.length - 1;
      for (let j = 0; j < roads.length; j++) {
        if (j === i) continue;
        const near = nearestOnPolyline(p[0], p[1], base[j]);
        const tol = roads[j].width / 2 + (end ? 14 : 3);
        if (near.d > tol) continue;
        if (end) pts[i][k] = [near.x, near.z]; // snap the dangling end onto the other road
        raw.push({ x: near.x, z: near.z, r: Math.max(r.width, roads[j].width) / 2, roads: new Set([i, j]) });
      }
    });
  });
  const merged: typeof raw = [];
  for (const j of raw) {
    const m = merged.find((q) => Math.hypot(q.x - j.x, q.z - j.z) < 20);
    if (m) {
      m.r = Math.max(m.r, j.r);
      j.roads.forEach((r) => m.roads.add(r));
    } else merged.push({ ...j, roads: new Set(j.roads) });
  }
  const infos = roads.map((r, i) => roadInfo(r, pts[i]));
  return { infos, junctions: merged.map((m) => ({ x: m.x, z: m.z, r: m.r, roads: [...m.roads].sort((a, b) => a - b) })) };
}

/** Arc positions where a road meets junctions (for stop lines and marking gaps). */
export function junctionStations(info: RoadInfo, junctions: Junction[]): { s: number; r: number }[] {
  const out: { s: number; r: number }[] = [];
  for (const j of junctions) {
    const n = nearestOnPolyline(j.x, j.z, info);
    if (n.d < j.r + 4) out.push({ s: n.s, r: j.r });
  }
  return out.sort((a, b) => a.s - b.s);
}

/** True when (x, z) lies on the asphalt of any road other than `skip`. */
export function onOtherRoad(x: number, z: number, infos: RoadInfo[], skip: number, margin = 0): boolean {
  for (let j = 0; j < infos.length; j++) {
    if (j === skip) continue;
    if (nearestOnPolyline(x, z, infos[j]).d < infos[j].road.width / 2 + margin) return true;
  }
  return false;
}

/** Lanes per direction (3.25 m lanes, 1 m shoulders). */
export function lanesPerDirection(width: number): number {
  return Math.max(1, Math.floor((width - 2) / 3.25 / 2));
}

/** Sidewalk width alongside a road of the given width. */
export function sidewalkWidth(width: number): number {
  return width >= 36 ? 7 : width >= 28 ? 5.5 : 4.5;
}

// ---------------------------------------------------------------- street furniture

export interface Placement {
  x: number;
  z: number;
  /** Yaw facing the road centre (radians, 0 = +z). */
  yaw: number;
  kind: number;
}

/**
 * Trees (御堂筋 ginkgo = kind 1, other roads' zelkova = kind 0) and street lamps along both
 * kerbs, skipping junctions, other roads, crossings and anything `blocked` rejects (it is told
 * what would stand there, so it can test that object's own envelope).
 */
export function placeStreetFurniture(
  infos: RoadInfo[],
  junctions: Junction[],
  blocked: (x: number, z: number, what: 'tree' | 'lamp', kind: number) => boolean,
): { trees: Placement[]; lamps: Placement[] } {
  const trees: Placement[] = [];
  const lamps: Placement[] = [];
  const tmp = { x: 0, z: 0, dx: 1, dz: 0, seg: 0 };
  infos.forEach((info, i) => {
    const w = info.road.width;
    const sw = sidewalkWidth(w);
    const ginkgo = info.road.id === 'midosuji' || info.road.id === 'shinmidosuji';
    const stations = junctionStations(info, junctions);
    const nearJunction = (s: number) => stations.some((j) => Math.abs(j.s - s) < j.r + 12);
    const place = (spacing: number, inset: number, list: Placement[], what: 'tree' | 'lamp', kind: number, phase: number) => {
      for (let s = phase; s < info.len; s += spacing) {
        if (nearJunction(s)) continue;
        pointAt(info, s, tmp);
        for (const side of [1, -1]) {
          const lx = tmp.dz * side;
          const lz = -tmp.dx * side;
          const x = tmp.x + lx * (w / 2 + inset);
          const z = tmp.z + lz * (w / 2 + inset);
          if (onOtherRoad(x, z, infos, i, sw * 0.5) || blocked(x, z, what, kind)) continue;
          list.push({ x, z, yaw: Math.atan2(-lx, -lz), kind });
        }
      }
    };
    if (info.road.id !== 'ekimae') place(ginkgo ? 10 : 18, Math.min(1.4, sw * 0.3), trees, 'tree', ginkgo ? 1 : 0, 4);
    place(30, 0.5, lamps, 'lamp', 0, 15);
  });
  return { trees, lamps };
}

// ---------------------------------------------------------------- traffic

export interface Lane {
  road: number;
  /** +1 travels with the polyline, −1 against it. */
  dir: 1 | -1;
  /** Offset to the left of the polyline direction (m). */
  lat: number;
  /** Stop lines (arc positions) the lane meets, in travel order. */
  stops: number[];
  /** East–west roads get green in the other half of the signal cycle. */
  phase: 0 | 1;
  /**
   * Stop lines before the network's signalised crossings: obeyed on red like `stops`, and also
   * whenever `held[c]` is set (someone is on crossing c).
   */
  holds?: { s: number; c: number }[];
}

export interface Vehicle {
  lane: number;
  s: number;
  v: number;
  /** 0 = car / taxi, 1 = bus. */
  type: 0 | 1;
  len: number;
}

export const SIGNAL_CYCLE = 60;
const V_MAX = 11; // ≈ 40 km/h

/** Is the signal green for this phase at time t? (Amber/all-red are the last 4 s of each half.) */
export function greenFor(phase: 0 | 1, t: number): boolean {
  const u = ((t % SIGNAL_CYCLE) + SIGNAL_CYCLE) % SIGNAL_CYCLE;
  const half = SIGNAL_CYCLE / 2;
  const inFirst = u < half;
  const local = inFirst ? u : u - half;
  return (inFirst ? phase === 0 : phase === 1) && local < half - 4;
}

/**
 * Car-following on independent lanes: vehicles keep a gap to the one ahead and stop at red
 * stop lines; at the end of a lane they re-enter at its start. `vehicles` of one lane must stay
 * sorted by travel order, which the model preserves (no overtaking).
 */
export function stepTraffic(lanes: Lane[], infos: RoadInfo[], vehicles: Vehicle[], byLane: number[][], t: number, dt: number, held?: ArrayLike<number>): void {
  const h = Math.min(0.1, Math.max(0, dt));
  if (h === 0) return;
  for (let li = 0; li < lanes.length; li++) {
    const lane = lanes[li];
    const len = infos[lane.road].len;
    const ids = byLane[li];
    const green = greenFor(lane.phase, t);
    for (let k = 0; k < ids.length; k++) {
      const veh = vehicles[ids[k]];
      // Distance travelled along the lane (0 at its entry).
      const pos = lane.dir === 1 ? veh.s : len - veh.s;
      let gap = Infinity;
      if (k > 0) {
        const ahead = vehicles[ids[k - 1]];
        const pa = lane.dir === 1 ? ahead.s : len - ahead.s;
        if (pa > pos) gap = pa - pos - (ahead.len + veh.len) / 2 - 2;
      }
      if (!green) {
        for (const st of lane.stops) {
          const ps = lane.dir === 1 ? st : len - st;
          const d = ps - pos - veh.len / 2;
          if (d > -0.5 && d < gap) gap = d;
        }
      }
      if (lane.holds) {
        for (const h of lane.holds) {
          if (green && !held?.[h.c]) continue;
          const ps = lane.dir === 1 ? h.s : len - h.s;
          const d = ps - pos - veh.len / 2;
          if (d > -0.5 && d < gap) gap = d;
        }
      }
      const target = Math.max(0, Math.min(V_MAX, gap * 0.7));
      veh.v += (target - veh.v) * Math.min(1, h * (target < veh.v ? 4 : 1.2));
      if (veh.v > gap / 0.5) veh.v = Math.max(0, gap / 0.5);
      let np = pos + veh.v * h;
      if (np > len) np -= len; // wrap: re-enter at the start of the lane
      veh.s = lane.dir === 1 ? np : len - np;
    }
    // Keep travel order after a wrap: the wrapped vehicle becomes the last one.
    if (ids.length > 1) {
      const first = vehicles[ids[0]];
      const pf = lane.dir === 1 ? first.s : len - first.s;
      const second = vehicles[ids[1]];
      const p2 = lane.dir === 1 ? second.s : len - second.s;
      if (pf < p2) ids.push(ids.shift() as number);
    }
  }
}

// ---------------------------------------------------------------- Ferris wheel

/** HEP FIVE wheel: 52 gondolas, one revolution in 15 min in reality; sped up to stay visible. */
export const WHEEL_GONDOLAS = 52;
export const WHEEL_PERIOD_S = 240;

/** Offset of gondola i from the hub in the wheel plane (up, along) for rotation angle `ang`. */
export function gondolaOffset(i: number, n: number, ang: number, radius: number): [number, number] {
  const a = ang + (i / n) * Math.PI * 2;
  return [Math.sin(a) * radius, Math.cos(a) * radius];
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- walkable space

/**
 * A convex plan polygon grown by m metres (every edge moved outwards). Orientation-agnostic.
 */
export function inflateConvex(poly: P2[], m: number): P2[] {
  const n = poly.length;
  if (n < 3 || m === 0) return poly.map((p) => [p[0], p[1]] as P2);
  let area = 0;
  for (let i = 0; i < n; i++) area += poly[i][0] * poly[(i + 1) % n][1] - poly[(i + 1) % n][0] * poly[i][1];
  const s = area >= 0 ? 1 : -1;
  const out: P2[] = [];
  for (let i = 0; i < n; i++) {
    const p = poly[(i + n - 1) % n];
    const q = poly[i];
    const r = poly[(i + 1) % n];
    // Outward normals of the edges p→q and q→r (for CCW: (dz, −dx)).
    const l1 = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
    const l2 = Math.hypot(r[0] - q[0], r[1] - q[1]) || 1;
    const n1x = (s * (q[1] - p[1])) / l1;
    const n1z = (-s * (q[0] - p[0])) / l1;
    const n2x = (s * (r[1] - q[1])) / l2;
    const n2z = (-s * (r[0] - q[0])) / l2;
    const k = m / Math.max(0.2, 1 + n1x * n2x + n1z * n2z);
    out.push([q[0] + (n1x + n2x) * k, q[1] + (n1z + n2z) * k]);
  }
  return out;
}

/** Plan rectangle of half width hw along a→b (null when a and b coincide in plan). */
export function stripPoly(ax: number, az: number, bx: number, bz: number, hw: number): P2[] | null {
  const dx = bx - ax;
  const dz = bz - az;
  const l = Math.hypot(dx, dz);
  if (l < 0.05) return null;
  const nx = (-dz / l) * hw;
  const nz = (dx / l) * hw;
  return [
    [ax - nx, az - nz],
    [bx - nx, bz - nz],
    [bx + nx, bz + nz],
    [ax + nx, az + nz],
  ];
}

/**
 * The well of one stair / escalator run: its flights and landings (a chain of flights joined at
 * landing nodes) as plan rectangles, with the lowest and highest floor along it (real metres).
 */
export interface Well {
  polys: P2[][];
  lo: number;
  hi: number;
}

/**
 * Stair and escalator wells of the network. The walk-through frames every flight as one open
 * well with a balustrade around it at the upper floor, so a slab it passes through is opened
 * over the whole run (not just where a head would touch it), `pad` metres beyond each side.
 */
export function flightWells(net: { nodes: NetNode[]; edges: NetEdge[] }, pad = 0.2): Well[] {
  const byId = new Map(net.nodes.map((n) => [n.id, n]));
  const flights = net.edges.filter((e) => e.kind === 'stairs' || e.kind === 'escalator');
  const parent = flights.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  const firstAt = new Map<string, number>();
  flights.forEach((e, i) => {
    for (const id of [e.a, e.b]) {
      if (!byId.get(id)?.landing) continue;
      const j = firstAt.get(id);
      if (j === undefined) firstAt.set(id, i);
      else parent[find(i)] = find(j);
    }
  });
  const wells = new Map<number, Well>();
  flights.forEach((e, i) => {
    const a = byId.get(e.a);
    const b = byId.get(e.b);
    if (!a || !b) return;
    const poly = stripPoly(a.x, a.z, b.x, b.z, flightWidth(e) / 2 + pad);
    if (!poly) return;
    const r = find(i);
    const w = wells.get(r) ?? { polys: [], lo: Infinity, hi: -Infinity };
    w.polys.push(poly);
    w.lo = Math.min(w.lo, a.y, b.y);
    w.hi = Math.max(w.hi, a.y, b.y);
    wells.set(r, w);
  });
  return [...wells.values()];
}

/** Plan bounds [x0, x1, z0, z1] of a polygon. */
export function polyBox(p: P2[]): [number, number, number, number] {
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const [x, z] of p) {
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    z0 = Math.min(z0, z);
    z1 = Math.max(z1, z);
  }
  return [x0, x1, z0, z1];
}

/**
 * Holes a horizontal slab at real height y needs inside the plan box [x0, x1] × [z0, z1] so it
 * never cuts through walkable space: whole wells whose flights pass through it, and of every
 * other piece (lift shafts, ramps, low corridors, junctions) the part whose floor lies below the
 * slab while its head room reaches above it. Convex plan polygons, counter-clockwise like the
 * walk-space pieces (positive signed area in x-z).
 */
export function slabHoles(space: WalkSpace, wells: Well[], y: number, x0: number, x1: number, z0: number, z1: number): P2[][] {
  const out: P2[][] = [];
  const overlaps = (p: P2[]) => {
    const [a0, a1, b0, b1] = polyBox(p);
    return a0 < x1 && a1 > x0 && b0 < z1 && b1 > z0;
  };
  for (const w of wells) {
    if (!(w.lo < y - 0.05 && w.hi + CLEARANCE > y)) continue;
    for (const p of w.polys) if (overlaps(p)) out.push(p);
  }
  for (const p of space.query(x0, x1, z0, z1)) {
    if (p.kind === 'flight') continue; // covered by the wells
    // Floor F = f0 + fx·x + fz·z: keep F < y − 0.05 and F + clear > y.
    let poly: P2[] = p.poly;
    const flat = Math.abs(p.fx) + Math.abs(p.fz) < 1e-9;
    if (flat) {
      if (!(p.f0 < y - 0.05 && p.f0 + p.clear > y)) continue;
    } else {
      poly = clipHalfPlane(poly, p.fx, p.fz, y - 0.05 - p.f0);
      if (poly.length >= 3) poly = clipHalfPlane(poly, -p.fx, -p.fz, p.f0 + p.clear - y);
    }
    if (poly.length >= 3 && polyArea(poly) > 1e-3 && overlaps(poly)) out.push(poly);
  }
  // (Never reverse in place: wells and pieces are shared.)
  return out.map((h) => {
    let a = 0;
    for (let i = 0; i < h.length; i++) a += h[i][0] * h[(i + 1) % h.length][1] - h[(i + 1) % h.length][0] * h[i][1];
    return a < 0 ? [...h].reverse() : h;
  });
}

/** A convex polygon minus several convex holes, as convex pieces. */
export function subtractAll(poly: P2[], holes: P2[][]): P2[][] {
  let pieces: P2[][] = [poly];
  for (const h of holes) {
    const [h0, h1, k0, k1] = polyBox(h);
    const next: P2[][] = [];
    for (const p of pieces) {
      const [p0, p1, q0, q1] = polyBox(p);
      if (p0 >= h1 || p1 <= h0 || q0 >= k1 || q1 <= k0) next.push(p);
      else next.push(...subtractConvex(p, h));
    }
    pieces = next;
  }
  return pieces;
}

/**
 * Street-level ground: `coarse` square cells covering [cx ± half] × [cz ± half], with the
 * holes cut out of the cells they touch. Convex plan polygons.
 */
export function groundPieces(cx: number, cz: number, half: number, holes: P2[][], coarse = 20): P2[][] {
  const out: P2[][] = [];
  const n = Math.ceil((half * 2) / coarse);
  const x0 = cx - (n * coarse) / 2;
  const z0 = cz - (n * coarse) / 2;
  const boxes = holes.map(polyBox);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const ax = x0 + i * coarse;
      const az = z0 + j * coarse;
      const cell: P2[] = [
        [ax, az],
        [ax + coarse, az],
        [ax + coarse, az + coarse],
        [ax, az + coarse],
      ];
      const near = holes.filter((_, k) => boxes[k][0] < ax + coarse && boxes[k][1] > ax && boxes[k][2] < az + coarse && boxes[k][3] > az);
      if (!near.length) out.push(cell);
      else for (const p of subtractAll(cell, near)) if (polyArea(p) > 1e-3) out.push(p);
    }
  }
  return out;
}

/** Rectangle in a wall's own frame: t along the wall (0…1) and scene height y. */
export interface WallRect {
  t0: number;
  t1: number;
  y0: number;
  y1: number;
}

/**
 * Openings a wall along a→b (scene heights y0…y1) needs so that nothing solid stands in
 * walkable space: for every walk-space piece the wall line crosses, the crossing (widened by
 * `margin` metres each side) from the piece's lowest floor there up to its highest floor plus
 * the head room `head(p)` (real metres). Scene y = real y × ex.
 */
export function wallOpenings(
  space: WalkSpace,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  y0: number,
  y1: number,
  ex: number,
  head: (p: WalkPiece) => number,
  margin = 0.25,
): WallRect[] {
  const dx = bx - ax;
  const dz = bz - az;
  if (Math.hypot(dx, dz) < 1e-6) return [];
  const pad = margin + 0.05;
  const out: WallRect[] = [];
  for (const p of space.query(Math.min(ax, bx) - pad, Math.max(ax, bx) + pad, Math.min(az, bz) - pad, Math.max(az, bz) + pad)) {
    const span = clipConvex(p.poly, ax, az, dx, dz, -margin);
    if (!span) continue;
    const F0 = p.f0 + p.fx * ax + p.fz * az;
    const F1 = p.fx * dx + p.fz * dz;
    const fa = F0 + F1 * span[0];
    const fb = F0 + F1 * span[1];
    // A hair below the floor, so no sliver of wall shows above a (lifted) walkway floor.
    const lo = Math.min(fa, fb) * ex - 0.05;
    const hi = (Math.max(fa, fb) + head(p)) * ex;
    if (hi <= y0 + 1e-3 || lo >= y1 - 1e-3) continue;
    out.push({ t0: span[0], t1: span[1], y0: Math.max(y0, lo), y1: Math.min(y1, hi) });
  }
  return out;
}

/**
 * The band [0, 1] × [y0, y1] minus the holes, as rectangles: the wall is cut into columns at
 * every hole edge, and runs of columns with the same open interval are merged.
 */
export function wallPanels(holes: WallRect[], y0: number, y1: number): WallRect[] {
  const ts = [0, 1];
  for (const h of holes) {
    if (h.y1 <= y0 || h.y0 >= y1) continue;
    ts.push(Math.min(1, Math.max(0, h.t0)), Math.min(1, Math.max(0, h.t1)));
  }
  ts.sort((a, b) => a - b);
  const cols: number[] = [];
  for (const t of ts) if (!cols.length || t - cols[cols.length - 1] > 1e-6) cols.push(t);
  const out: WallRect[] = [];
  const open = new Map<string, WallRect>();
  for (let i = 0; i < cols.length - 1; i++) {
    const a = cols[i];
    const b = cols[i + 1];
    const cover: [number, number][] = [];
    for (const h of holes) if (h.t0 <= a + 1e-9 && h.t1 >= b - 1e-9 && h.y1 > y0 && h.y0 < y1) cover.push([Math.max(y0, h.y0), Math.min(y1, h.y1)]);
    cover.sort((p, q) => p[0] - q[0]);
    const free: [number, number][] = [];
    let y = y0;
    for (const [c0, c1] of cover) {
      if (c0 > y + 1e-4) free.push([y, c0]);
      y = Math.max(y, c1);
    }
    if (y1 > y + 1e-4) free.push([y, y1]);
    const seen = new Set<string>();
    for (const [f0, f1] of free) {
      const key = `${f0.toFixed(4)}|${f1.toFixed(4)}`;
      seen.add(key);
      const r = open.get(key);
      if (r && Math.abs(r.t1 - a) < 1e-9) r.t1 = b;
      else {
        if (r) out.push(r);
        open.set(key, { t0: a, t1: b, y0: f0, y1: f1 });
      }
    }
    for (const [key, r] of open) {
      if (seen.has(key)) continue;
      out.push(r);
      open.delete(key);
    }
  }
  out.push(...open.values());
  return out;
}

/**
 * Door frames for the openings of one wall: overlapping (or nearly touching, within `gap` in
 * t) openings are grouped, and each group gets its bounding rectangle, around which a lintel
 * and two jambs are drawn.
 */
export function portalFrames(holes: WallRect[], gap: number): WallRect[] {
  const parent = holes.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  for (let i = 0; i < holes.length; i++) {
    for (let j = i + 1; j < holes.length; j++) {
      const a = holes[i];
      const b = holes[j];
      if (a.t0 <= b.t1 + gap && a.t1 >= b.t0 - gap && a.y0 <= b.y1 && a.y1 >= b.y0) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, WallRect>();
  holes.forEach((h, i) => {
    const r = find(i);
    const g = groups.get(r);
    if (!g) groups.set(r, { ...h });
    else {
      g.t0 = Math.min(g.t0, h.t0);
      g.t1 = Math.max(g.t1, h.t1);
      g.y0 = Math.min(g.y0, h.y0);
      g.y1 = Math.max(g.y1, h.y1);
    }
  });
  return [...groups.values()];
}

// ---------------------------------------------------------------- walk-mode helpers

/** Does segment a→b pass within r of the point c? */
export function segmentNearPoint(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, r: number): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const l2 = dx * dx + dy * dy + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((cx - ax) * dx + (cy - ay) * dy + (cz - az) * dz) / l2));
  const px = ax + dx * t - cx;
  const py = ay + dy * t - cy;
  const pz = az + dz * t - cz;
  return px * px + py * py + pz * pz < r * r;
}

/**
 * Where the camera→walker sight line pierces street level, when the walker is below it and the
 * camera above (the street surfaces are cut open there): writes it to `out` and returns true.
 */
export function streetPiercing(
  cam: { x: number; y: number; z: number },
  walker: { x: number; y: number; z: number },
  out: { x: number; z: number },
  level = 0,
): boolean {
  if (!(walker.y < level - 0.3 && cam.y > level + 0.2)) return false;
  const t = (cam.y - level) / (cam.y - walker.y);
  out.x = cam.x + (walker.x - cam.x) * t;
  out.z = cam.z + (walker.z - cam.z) * t;
  return true;
}
