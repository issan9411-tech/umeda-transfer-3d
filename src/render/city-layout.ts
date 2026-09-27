import type { Footprint, NetEdge, NetNode, Road } from '../core/types';
import { CLEARANCE, clipConvex, flightWidth, type WalkPiece, type WalkSpace } from './walk-space';
import { clipHalfPlane, polyArea, subtractConvex, type P2 } from './walkway-util';

/**
 * Pure layout maths for the city context (no three.js, no DOM): building massing and styles
 * from mapped footprints, polygon walls cut clear of the stations, road junctions and the
 * street index, street-furniture placement, camera cut-away tests and the spatial grid behind
 * them, and the tiny traffic model. Everything here is in local metres (x = east, z = south).
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

// ---------------------------------------------------------------- polygons

/** Signed area in x-z (positive = counter-clockwise, the orientation used throughout). */
export function signedArea(p: P2[]): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i];
    const b = p[(i + 1) % p.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
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

/** Even-odd point-in-polygon over a set of rings (outer ring and holes). */
export function insideRings(rings: P2[][], x: number, z: number): boolean {
  let inside = false;
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, zi] = r[i];
      const [xj, zj] = r[j];
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** Distance from (x, z) to the nearest edge of the rings. */
export function distanceToEdges(rings: P2[][], x: number, z: number): number {
  let best = Infinity;
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [ax, az] = r[j];
      const dx = r[i][0] - ax;
      const dz = r[i][1] - az;
      const l2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
      const ex = ax + dx * t - x;
      const ez = az + dz * t - z;
      best = Math.min(best, ex * ex + ez * ez);
    }
  }
  return Math.sqrt(best);
}

/**
 * Parameter intervals (sorted, within [0, 1]) of the segment a→b that lie inside the rings
 * (even-odd), from its crossings with every edge.
 */
export function insideIntervals(rings: P2[][], ax: number, az: number, bx: number, bz: number): [number, number][] {
  const dx = bx - ax;
  const dz = bz - az;
  const ts: number[] = [];
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [px, pz] = r[j];
      const ex = r[i][0] - px;
      const ez = r[i][1] - pz;
      const den = dx * ez - dz * ex;
      if (Math.abs(den) < 1e-12) continue;
      const t = ((px - ax) * ez - (pz - az) * ex) / den;
      const u = ((px - ax) * dz - (pz - az) * dx) / den;
      if (t > 1e-9 && t < 1 - 1e-9 && u >= 0 && u < 1) ts.push(t);
    }
  }
  ts.sort((p, q) => p - q);
  const out: [number, number][] = [];
  let t = 0;
  // Decide the state of each run by its midpoint (robust at vertices and grazing edges).
  for (const c of [...ts, 1]) {
    if (c - t > 1e-9 && insideRings(rings, ax + dx * ((t + c) / 2), az + dz * ((t + c) / 2))) {
      const last = out[out.length - 1];
      if (last && Math.abs(last[1] - t) < 1e-9) last[1] = c;
      else out.push([t, c]);
    }
    t = c;
  }
  return out;
}

/** Convex hull (counter-clockwise in x-z) of a point set. */
export function convexHull(pts: P2[]): P2[] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: P2, a: P2, b: P2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: P2[] = [];
  for (const q of p) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop();
    lo.push(q);
  }
  const hi: P2[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop();
    hi.push(q);
  }
  lo.pop();
  hi.pop();
  const h = lo.concat(hi);
  return signedArea(h) < 0 ? h.reverse() : h;
}

/** Oriented bounding box of a ring (minimum-area, over its hull's edge directions). */
export function orientedBox(ring: P2[]): { cx: number; cz: number; ux: number; uz: number; hl: number; hw: number } {
  const hull = convexHull(ring);
  let best = { area: Infinity, cx: 0, cz: 0, ux: 1, uz: 0, hl: 0, hw: 0 };
  for (let i = 0; i < hull.length; i++) {
    const [ax, az] = hull[i];
    const [bx, bz] = hull[(i + 1) % hull.length];
    const l = Math.hypot(bx - ax, bz - az);
    if (l < 1e-6) continue;
    const ux = (bx - ax) / l;
    const uz = (bz - az) / l;
    let a0 = Infinity;
    let a1 = -Infinity;
    let b0 = Infinity;
    let b1 = -Infinity;
    for (const [x, z] of hull) {
      const a = x * ux + z * uz;
      const b = -x * uz + z * ux;
      a0 = Math.min(a0, a);
      a1 = Math.max(a1, a);
      b0 = Math.min(b0, b);
      b1 = Math.max(b1, b);
    }
    const area = (a1 - a0) * (b1 - b0);
    if (area < best.area) {
      const am = (a0 + a1) / 2;
      const bm = (b0 + b1) / 2;
      const long = a1 - a0 >= b1 - b0;
      best = {
        area,
        cx: ux * am - uz * bm,
        cz: uz * am + ux * bm,
        ux: long ? ux : -uz,
        uz: long ? uz : ux,
        hl: (long ? a1 - a0 : b1 - b0) / 2,
        hw: (long ? b1 - b0 : a1 - a0) / 2,
      };
    }
  }
  return best;
}

// ---------------------------------------------------------------- building styles

export type FacadeStyle = 'curtain' | 'grid' | 'band' | 'stone';
export const FACADE_STYLES: FacadeStyle[] = ['curtain', 'grid', 'band', 'stone'];

/** Rooftop dressing: machine rooms, a heli pad, a crown, the 阪急 shed, nothing, or a bare canopy. */
export type RoofKind = 'plant' | 'heli' | 'crown' | 'shed' | 'none' | 'canopy';

export interface PartLook {
  style: FacadeStyle;
  /** Facade tint (multiplies the texture). */
  tint: string;
  roof: RoofKind;
}

type Look = [FacadeStyle, string, RoofKind];

/**
 * The landmarks around the station, found by their mapped name near a known spot (names like
 * 南館 repeat across the city), with their facades and, where the map lacks it, the published
 * height of the tower (roof, not antenna): 梅田阪急ビル 187 m, サウスゲートビルディング 122 m,
 * ハービスOSAKA 190 m, ハービスENT 133 m, HEP FIVE 46 m (with the Ø75 m wheel on top).
 */
export interface Landmark {
  /** Mapped name, or null for a building found by position only. */
  name: string | null;
  /** Footprint id of a station block that is this landmark. */
  id?: string;
  at: [number, number];
  label: string;
  podium: Look;
  tower?: Look;
  /** Tower (tallest part) height override, real metres. */
  towerHeight?: number;
  /** Whole-building height override (single-volume buildings). */
  height?: number;
  wheel?: boolean;
}

export const LANDMARKS: Landmark[] = [
  { name: 'ノースゲートビルディング', at: [-24, -55], label: 'ノースゲートビルディング（ルクア）', podium: ['band', '#c9d2d8', 'plant'], tower: ['curtain', '#a9bccb', 'heli'] },
  { name: 'サウスゲートビルディング', at: [66, 89], label: 'サウスゲートビルディング（大丸梅田店）', podium: ['stone', '#ddd5c8', 'plant'], tower: ['grid', '#e4dfd6', 'heli'], towerHeight: 122 },
  { name: '南館', at: [-80, -187], label: 'グランフロント大阪 南館', podium: ['curtain', '#c3ccd2', 'plant'], tower: ['curtain', '#9fb2c2', 'heli'] },
  { name: '北館', at: [-114, -371], label: 'グランフロント大阪 北館', podium: ['curtain', '#c3ccd2', 'plant'], tower: ['curtain', '#9fb2c2', 'heli'] },
  { name: 'グランフロント大阪 オーナーズタワー', at: [-151, -534], label: 'グランフロント大阪 オーナーズタワー', podium: ['curtain', '#c3ccd2', 'plant'], tower: ['curtain', '#aab8c4', 'heli'] },
  { name: 'ヨドバシ梅田タワー', at: [49, -209], label: 'ヨドバシ梅田タワー', podium: ['band', '#8b949c', 'plant'], tower: ['curtain', '#a2b0bb', 'heli'] },
  { name: '大阪梅田ツインタワーズ・ノース', at: [269, -25], label: '阪急うめだ本店（大阪梅田ツインタワーズ・ノース）', podium: ['stone', '#d8cdbb', 'plant'], tower: ['curtain', '#a7b6c1', 'heli'], towerHeight: 187 },
  { name: '大阪梅田ツインタワーズ・サウス', id: 'hanshin:bldg', at: [236, 164], label: '阪神梅田本店（大阪梅田ツインタワーズ・サウス）', podium: ['stone', '#d9d2c6', 'plant'], tower: ['curtain', '#a4b3bf', 'heli'] },
  { name: 'JPタワー大阪', at: [-153, 218], label: 'JPタワー大阪（KITTE大阪）', podium: ['stone', '#e2ddd3', 'plant'], tower: ['curtain', '#b3c1cc', 'heli'] },
  { name: 'イノゲート大阪', at: [-219, 79], label: 'イノゲート大阪', podium: ['curtain', '#cfd6db', 'none'], tower: ['band', '#b8c3cc', 'heli'] },
  { name: 'うめきたグリーンプレイス', at: [-214, -67], label: 'うめきたグリーンプレイス', podium: ['curtain', '#d3dcd6', 'plant'] },
  { name: 'グラングリーン大阪 北館', at: [-245, -400], label: 'グラングリーン大阪 北館', podium: ['curtain', '#cfd6d8', 'plant'], tower: ['band', '#bcc6cc', 'heli'] },
  { name: '南館 パークタワー', at: [-386, -1], label: 'グラングリーン大阪 南館 パークタワー', podium: ['curtain', '#cfd6d8', 'plant'], tower: ['curtain', '#a8b8c0', 'heli'] },
  { name: '南館 ゲートタワー', at: [-317, 21], label: 'グラングリーン大阪 南館 ゲートタワー', podium: ['curtain', '#cfd6d8', 'plant'], tower: ['curtain', '#a8b8c0', 'heli'] },
  { name: '南館 サウスタワー', at: [-355, 85], label: 'グラングリーン大阪 南館 サウスタワー', podium: ['curtain', '#cfd6d8', 'plant'], tower: ['band', '#bcc6cc', 'heli'] },
  { name: 'GRAND GREEN OSAKA THE NORTH RESIDENCE', at: [-257, -489], label: 'グラングリーン大阪 ザ・ノースレジデンス', podium: ['curtain', '#cfd6d8', 'plant'], tower: ['grid', '#d9dcd8', 'heli'] },
  { name: 'ハービスOSAKA', at: [-276, 449], label: 'ハービスOSAKA', podium: ['stone', '#d7cfc3', 'plant'], tower: ['curtain', '#b3b8b8', 'crown'], towerHeight: 190 },
  { name: 'ハービスENT', at: [-106, 308], label: 'ハービスENT', podium: ['stone', '#d7cfc3', 'plant'], tower: ['curtain', '#aeb6ba', 'heli'], towerHeight: 133 },
  { name: '大阪駅前第1ビル', at: [71, 402], label: '大阪駅前第1ビル', podium: ['grid', '#d6d0c4', 'plant'], tower: ['grid', '#d6d0c4', 'plant'] },
  { name: '大阪駅前第2ビル', at: [207, 410], label: '大阪駅前第2ビル', podium: ['grid', '#cfc9bd', 'plant'], tower: ['grid', '#cfc9bd', 'plant'] },
  { name: null, at: [328, 409], label: '大阪駅前第3ビル', podium: ['grid', '#d3cdc2', 'plant'], tower: ['grid', '#ddd8ce', 'plant'] },
  { name: '大阪駅前第4ビル', at: [293, 292], label: '大阪駅前第4ビル', podium: ['grid', '#d3cdc2', 'plant'], tower: ['grid', '#d8d2c6', 'plant'] },
  { name: 'HEP FIVE', at: [423, -172], label: 'HEP FIVE', podium: ['band', '#e9e2dc', 'plant'], height: 46, wheel: true },
  { name: 'HEP NAVIO', at: [391, -84], label: 'HEP NAVIO', podium: ['band', '#e4ddd4', 'plant'] },
  { name: '梅田スカイビル', at: [-509, -310], label: '梅田スカイビル', podium: ['curtain', '#b9c6ce', 'none'], tower: ['curtain', '#b9c6ce', 'none'] },
  { name: 'ヒルトンプラザ イースト', at: [47, 267], label: 'ヒルトンプラザ イースト', podium: ['stone', '#d9d1c4', 'plant'], tower: ['curtain', '#a9b6c0', 'heli'] },
  { name: 'ヒルトンプラザ ウエスト', at: [-45, 292], label: 'ヒルトンプラザ ウエスト', podium: ['stone', '#d9d1c4', 'plant'], tower: ['curtain', '#b4bfc6', 'heli'] },
  { name: 'ブリーゼタワー', at: [-159, 425], label: 'ブリーゼタワー', podium: ['curtain', '#c9d0d4', 'plant'], tower: ['curtain', '#a6b3bc', 'heli'] },
  { name: '梅田DTタワー', at: [183, 296], label: '梅田DTタワー', podium: ['curtain', '#aebbc4', 'heli'] },
];

/** The landmark a mapped building is (by name within 60 m of its spot, or by position alone). */
export function landmarkOf(fp: Footprint): Landmark | null {
  const [x0, x1, z0, z1] = polyBox(fp.poly);
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  for (const l of LANDMARKS) {
    if (l.id && fp.id === l.id) return l;
    const d = Math.hypot(l.at[0] - cx, l.at[1] - cz);
    if (l.name ? fp.nameJa === l.name && d < 60 : d < 25 && insideRings([fp.poly], l.at[0], l.at[1])) return l;
  }
  return null;
}

const TINTS: Record<FacadeStyle, string[]> = {
  curtain: ['#a9b8c4', '#9fb0bd', '#b3bfc8', '#a4b4b8', '#b8c4cc'],
  band: ['#c8cdd0', '#bfc5c9', '#b4bcc2', '#cfd2d2'],
  grid: ['#d6d0c4', '#cfc9bd', '#ddd8ce', '#c9c4ba', '#e0dbd2', '#d2cfc8'],
  stone: ['#d8d0c4', '#cfc6b8', '#c9bfb0', '#ddd6cb'],
};

/**
 * Facade of an ordinary mapped building part from its use and height (real metres), varied
 * per building by `r` (0…1): glass towers, banded mid-rises, tiled walls with punched windows.
 */
export function genericLook(use: string | undefined, h: number, area: number, r: number): PartLook {
  const pick = (s: FacadeStyle) => TINTS[s][Math.floor(r * 997) % TINTS[s].length];
  const flat: RoofKind = area >= 150 && h >= 12 ? 'plant' : 'none';
  if (use === 'roof') return { style: 'band', tint: '#b9bcbd', roof: 'canopy' };
  if (use === 'religious') return { style: 'stone', tint: r < 0.5 ? '#b9a58c' : '#a8927a', roof: 'none' };
  if (use === 'parking') return { style: 'band', tint: '#b8b8b2', roof: 'none' };
  if (use === 'residential') return { style: 'grid', tint: ['#e2dccf', '#d8cfbf', '#cfc6b6', '#e6e1d8'][Math.floor(r * 991) % 4], roof: flat };
  if (h >= 100) return { style: 'curtain', tint: pick('curtain'), roof: area >= 900 ? 'heli' : 'plant' };
  if (h >= 45) return r < 0.5 ? { style: 'curtain', tint: pick('curtain'), roof: flat } : { style: 'band', tint: pick('band'), roof: flat };
  if (h >= 20) return r < 0.55 ? { style: 'grid', tint: pick('grid'), roof: flat } : r < 0.8 ? { style: 'band', tint: pick('band'), roof: flat } : { style: 'stone', tint: pick('stone'), roof: flat };
  return r < 0.7 ? { style: 'grid', tint: pick('grid'), roof: flat } : { style: 'stone', tint: pick('stone'), roof: flat };
}

/** One massing volume of a building: plan rings and real-height range, with its look. */
export interface MassPart {
  poly: P2[];
  holes: P2[][];
  y0: number;
  y1: number;
  look: PartLook;
}

/**
 * Massing of a footprint: its parts (or the outline) with heights and looks. The 阪急 station
 * keeps its concourse block under the 3F platforms and the long train shed over them; landmarks
 * get their facades and published tower heights; everything else a generic look by height.
 */
export function massing(fp: Footprint, seed: number): { parts: MassPart[]; landmark: Landmark | null } {
  const r = rng(seed * 7919 + 17)();
  const holes = fp.holes ?? [];
  if (fp.id === 'hankyu:bldg') {
    return {
      landmark: null,
      parts: [
        { poly: fp.poly, holes, y0: 0, y1: 10.4, look: { style: 'stone', tint: '#c9b9a4', roof: 'none' } },
        { poly: fp.poly, holes, y0: 21, y1: 23, look: { style: 'band', tint: '#a9b0b6', roof: 'shed' } },
      ],
    };
  }
  const lm = landmarkOf(fp);
  const src = fp.parts?.length ? fp.parts.map((p) => ({ poly: p.poly, holes: p.holes ?? [], y0: p.y0, y1: p.y1 })) : [{ poly: fp.poly, holes, y0: fp.kind === 'station' ? 0 : fp.y0, y1: fp.y1 }];
  const top = Math.max(...src.map((p) => p.y1));
  const parts: MassPart[] = src.map((p) => {
    const area = polyArea(p.poly);
    const isTower = !!lm?.tower && p.y1 >= Math.max(40, top * 0.6);
    let y1 = p.y1;
    if (lm?.height && !fp.parts?.length) y1 = lm.height;
    // A published tower height scales the tower parts (the tallest one reaches it exactly).
    if (isTower && lm?.towerHeight && top > 0) y1 = (p.y1 * lm.towerHeight) / top;
    const look: PartLook = lm ? toLook(isTower ? (lm.tower as Look) : lm.podium) : genericLook(fp.use, p.y1, area, r);
    return { poly: p.poly, holes: p.holes, y0: p.y0, y1, look };
  });
  return { parts, landmark: lm };
}

function toLook(l: Look): PartLook {
  return { style: l[0], tint: l[1], roof: l[2] };
}

// ---------------------------------------------------------------- walls cut clear of the stations

/** A straight piece of facade from a to b; its outward normal is (dz, −dx) / length. */
export interface WallSeg {
  ax: number;
  az: number;
  bx: number;
  bz: number;
}

/**
 * The facade segments of a polygon (outer ring counter-clockwise, holes clockwise) minus the
 * convex `cutters` (the elevated stations' platform areas): ring edges lose the parts inside a
 * cutter, and where a cutter bites into the polygon its own edges become facade, facing into it.
 */
export function prismWalls(poly: P2[], holes: P2[][], cutters: P2[][]): WallSeg[] {
  const rings = [poly, ...holes];
  const out: WallSeg[] = [];
  const keep = (ax: number, az: number, bx: number, bz: number, skip: number) => {
    // Portions of a→b outside every cutter (but `skip`).
    let spans: [number, number][] = [[0, 1]];
    cutters.forEach((c, k) => {
      if (k === skip || !spans.length) return;
      const iv = clipConvex(c, ax, az, bx - ax, bz - az);
      if (!iv) return;
      const next: [number, number][] = [];
      for (const [s0, s1] of spans) {
        if (iv[1] <= s0 || iv[0] >= s1) next.push([s0, s1]);
        else {
          if (iv[0] > s0) next.push([s0, iv[0]]);
          if (iv[1] < s1) next.push([iv[1], s1]);
        }
      }
      spans = next;
    });
    for (const [s0, s1] of spans) {
      if ((s1 - s0) * Math.hypot(bx - ax, bz - az) < 0.05) continue;
      out.push({ ax: ax + (bx - ax) * s0, az: az + (bz - az) * s0, bx: ax + (bx - ax) * s1, bz: az + (bz - az) * s1 });
    }
  };
  for (const r of rings) for (let i = 0; i < r.length; i++) keep(r[i][0], r[i][1], r[(i + 1) % r.length][0], r[(i + 1) % r.length][1], -1);
  cutters.forEach((c, k) => {
    for (let i = 0; i < c.length; i++) {
      // Walk the cutter edge backwards: the remaining solid lies on its left then.
      const [bx, bz] = c[i];
      const [ax, az] = c[(i + 1) % c.length];
      for (const [t0, t1] of insideIntervals(rings, ax, az, bx, bz)) {
        const sx = ax + (bx - ax) * t0;
        const sz = az + (bz - az) * t0;
        const ex = ax + (bx - ax) * t1;
        const ez = az + (bz - az) * t1;
        keep(sx, sz, ex, ez, k);
      }
    }
  });
  return out;
}

/** Does a polygon reach into a convex cutter (by more than `eps` metres)? */
export function polyTouchesConvex(poly: P2[], cutter: P2[], eps = 0.05): boolean {
  const [a0, a1, b0, b1] = polyBox(poly);
  const [c0, c1, d0, d1] = polyBox(cutter);
  if (a1 <= c0 || a0 >= c1 || b1 <= d0 || b0 >= d1) return false;
  for (let i = 0; i < poly.length; i++) {
    const [ax, az] = poly[i];
    const [bx, bz] = poly[(i + 1) % poly.length];
    const iv = clipConvex(cutter, ax, az, bx - ax, bz - az, eps);
    if (iv && iv[1] - iv[0] > 1e-6) return true;
  }
  // The cutter wholly inside the polygon.
  return insideRings([poly], cutter[0][0], cutter[0][1]);
}

// ---------------------------------------------------------------- cut-away

/** A building volume in scene units: plan rings and scene heights, with plan bounds. */
export interface Prism {
  poly: P2[];
  holes: P2[][];
  /** [poly, ...holes]. */
  rings: P2[][];
  y0: number;
  y1: number;
  box: [number, number, number, number];
}

export function makePrism(poly: P2[], holes: P2[][], y0: number, y1: number): Prism {
  return { poly, holes, rings: [poly, ...holes], y0, y1, box: polyBox(poly) };
}

const crossings = new Float64Array(512);

/**
 * Length of the plan segment p→q inside the rings (even-odd). Allocation-free (per-frame use):
 * crossing parameters go to a shared scratch buffer.
 */
export function insideLength(rings: P2[][], px: number, pz: number, qx: number, qz: number): number {
  const dx = qx - px;
  const dz = qz - pz;
  let n = 0;
  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r];
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const ax = ring[j][0];
      const az = ring[j][1];
      const ex = ring[i][0] - ax;
      const ez = ring[i][1] - az;
      const den = dx * ez - dz * ex;
      if (Math.abs(den) < 1e-12) continue;
      const t = ((ax - px) * ez - (az - pz) * ex) / den;
      const u = ((ax - px) * dz - (az - pz) * dx) / den;
      if (t > 1e-9 && t < 1 - 1e-9 && u >= 0 && u < 1 && n < crossings.length) crossings[n++] = t;
    }
  }
  // Insertion sort (a handful of crossings).
  for (let i = 1; i < n; i++) {
    const v = crossings[i];
    let k = i - 1;
    while (k >= 0 && crossings[k] > v) {
      crossings[k + 1] = crossings[k];
      k--;
    }
    crossings[k + 1] = v;
  }
  const len = Math.hypot(dx, dz);
  let total = 0;
  let t = 0;
  for (let i = 0; i <= n; i++) {
    const c = i < n ? crossings[i] : 1;
    if (c - t > 1e-9) {
      const m = (t + c) / 2;
      if (insideRings(rings, px + dx * m, pz + dz * m)) total += (c - t) * len;
    }
    t = c;
  }
  return total;
}

/**
 * Does segment a→b pass through the prism? With `pad`, the top is lowered by it and the
 * segment must run at least 2·pad inside the plan outline (grazing a facade is not a hit).
 */
export function segmentHitsPrism(ax: number, ay: number, az: number, bx: number, by: number, bz: number, pr: Prism, pad = 0): boolean {
  let t0 = 0;
  let t1 = 1;
  const dy = by - ay;
  const lo = pr.y0;
  const hi = pr.y1 - pad;
  if (Math.abs(dy) < 1e-9) {
    if (ay < lo || ay > hi) return false;
  } else {
    let ta = (lo - ay) / dy;
    let tb = (hi - ay) / dy;
    if (ta > tb) {
      const s = ta;
      ta = tb;
      tb = s;
    }
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 >= t1) return false;
  }
  const px = ax + (bx - ax) * t0;
  const pz = az + (bz - az) * t0;
  const qx = ax + (bx - ax) * t1;
  const qz = az + (bz - az) * t1;
  const b = pr.box;
  if (Math.max(px, qx) < b[0] || Math.min(px, qx) > b[1] || Math.max(pz, qz) < b[2] || Math.min(pz, qz) > b[3]) return false;
  if (Math.hypot(qx - px, qz - pz) < 1e-6) return insideRings(pr.rings, px, pz) && (pad === 0 || distanceToEdges(pr.rings, px, pz) > pad);
  const inside = insideLength(pr.rings, px, pz, qx, qz);
  return pad === 0 ? inside > 1e-6 : inside > 2 * pad;
}

/** Euclidean distance from a point to the prism (0 inside). */
export function distanceToPrism(px: number, py: number, pz: number, pr: Prism): number {
  const c = py < pr.y0 ? pr.y0 - py : py > pr.y1 ? py - pr.y1 : 0;
  return Math.hypot(distanceToPlan(px, pz, pr), c);
}

/** Horizontal distance from (x, z) to the prism's plan (0 inside). */
export function distanceToPlan(x: number, z: number, pr: Prism): number {
  const [x0, x1, z0, z1] = pr.box;
  const bx = Math.max(x0 - x, 0, x - x1);
  const bz = Math.max(z0 - z, 0, z - z1);
  if (bx > 0 || bz > 0) {
    // Outside the bounds: the box distance is a lower bound, exact enough far away.
    if (Math.hypot(bx, bz) > 30) return Math.hypot(bx, bz);
  }
  return insideRings(pr.rings, x, z) ? 0 : distanceToEdges(pr.rings, x, z);
}

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
 * the walker, or the camera is inside / grazing it. Overview: semi-solid (`rest`), and ghosted
 * when it hides (or stands on) part of the selected route.
 */
export function fadeTarget(parts: Prism[], o: FadeInput, rest = OVERVIEW_OPACITY): number {
  const { camera: c, focus: f } = o;
  const ghost = o.walk ? GHOST_OPACITY * 0.7 : GHOST_OPACITY;
  for (let i = 0; i < parts.length; i++) {
    const b = parts[i];
    if (distanceToPrism(c.x, c.y, c.z, b) < (o.walk ? 3 : 10)) return ghost;
    if (segmentHitsPrism(c.x, c.y, c.z, f.x, f.y, f.z, b, o.walk ? 0.4 : 0)) return ghost;
  }
  if (o.walk) {
    // The walker standing inside the building (indoor concourse) also cuts it away.
    for (let i = 0; i < parts.length; i++) if (distanceToPrism(f.x, f.y, f.z, parts[i]) < 0.5) return ghost;
    return 1;
  }
  for (let i = 0; i < parts.length; i++) {
    const b = parts[i];
    for (let k = 0; k < o.route.length; k++) {
      const p = o.route[k];
      if (p.y < b.y1 + 20 && distanceToPlan(p.x, p.z, b) < 18) return Math.min(rest, GHOST_OPACITY * 1.4);
      if (segmentHitsPrism(c.x, c.y, c.z, p.x, p.y, p.z, b)) return Math.min(rest, GHOST_OPACITY * 1.4);
    }
  }
  return rest;
}

/** Frame-rate independent approach of `v` to `target` (time constant ≈ 1/rate s). */
export function approach(v: number, target: number, dt: number, rate = 6): number {
  return v + (target - v) * (1 - Math.exp(-Math.max(0, dt) * rate));
}

/**
 * Uniform grid over item bounding boxes (compressed rows), with duplicate-free queries along
 * boxes and segments. Queries write ids into a caller-owned buffer, so per-frame use allocates
 * nothing.
 */
export class BoxGrid {
  readonly x0: number;
  readonly z0: number;
  readonly nx: number;
  readonly nz: number;
  private readonly start: Int32Array;
  private readonly items: Int32Array;
  private readonly stamp: Uint32Array;
  private epoch = 0;

  constructor(boxes: ArrayLike<number>[], readonly cell = 40) {
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    for (const b of boxes) {
      x0 = Math.min(x0, b[0]);
      x1 = Math.max(x1, b[1]);
      z0 = Math.min(z0, b[2]);
      z1 = Math.max(z1, b[3]);
    }
    if (!boxes.length) x0 = x1 = z0 = z1 = 0;
    this.x0 = x0 - cell;
    this.z0 = z0 - cell;
    this.nx = Math.max(1, Math.ceil((x1 - this.x0) / cell) + 1);
    this.nz = Math.max(1, Math.ceil((z1 - this.z0) / cell) + 1);
    const count = new Int32Array(this.nx * this.nz + 1);
    const each = (b: ArrayLike<number>, f: (c: number) => void) => {
      const i0 = this.cx(b[0]);
      const i1 = this.cx(b[1]);
      const j0 = this.cz(b[2]);
      const j1 = this.cz(b[3]);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) f(j * this.nx + i);
    };
    for (const b of boxes) each(b, (c) => count[c + 1]++);
    for (let i = 1; i < count.length; i++) count[i] += count[i - 1];
    this.start = count;
    this.items = new Int32Array(count[count.length - 1]);
    const fill = count.slice();
    boxes.forEach((b, id) => each(b, (c) => (this.items[fill[c]++] = id)));
    this.stamp = new Uint32Array(boxes.length);
  }

  private cx(x: number): number {
    return Math.max(0, Math.min(this.nx - 1, Math.floor((x - this.x0) / this.cell)));
  }

  private cz(z: number): number {
    return Math.max(0, Math.min(this.nz - 1, Math.floor((z - this.z0) / this.cell)));
  }

  /** Starts a new duplicate-free query batch. */
  begin(): void {
    this.epoch = (this.epoch + 1) >>> 0;
    if (this.epoch === 0) {
      this.stamp.fill(0);
      this.epoch = 1;
    }
  }

  private cellInto(c: number, out: Int32Array, n: number): number {
    for (let k = this.start[c]; k < this.start[c + 1] && n < out.length; k++) {
      const id = this.items[k];
      if (this.stamp[id] === this.epoch) continue;
      this.stamp[id] = this.epoch;
      out[n++] = id;
    }
    return n;
  }

  /** Appends the ids of items whose cells overlap the box to out[n…]; returns the new count. */
  box(x0: number, x1: number, z0: number, z1: number, out: Int32Array, n: number): number {
    const i0 = this.cx(x0);
    const i1 = this.cx(x1);
    const j0 = this.cz(z0);
    const j1 = this.cz(z1);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) n = this.cellInto(j * this.nx + i, out, n);
    return n;
  }

  /** Appends the ids of items in the cells the plan segment a→b passes through (and their neighbours). */
  segment(ax: number, az: number, bx: number, bz: number, out: Int32Array, n: number): number {
    const len = Math.hypot(bx - ax, bz - az);
    const steps = Math.max(1, Math.ceil(len / (this.cell * 0.5)));
    let last = -1;
    for (let s = 0; s <= steps; s++) {
      const x = ax + ((bx - ax) * s) / steps;
      const z = az + ((bz - az) * s) / steps;
      const i = this.cx(x);
      const j = this.cz(z);
      const c = j * this.nx + i;
      if (c === last) continue;
      last = c;
      // The 3×3 block keeps items the line passes near a cell corner.
      for (let dj = -1; dj <= 1; dj++) {
        const jj = j + dj;
        if (jj < 0 || jj >= this.nz) continue;
        for (let di = -1; di <= 1; di++) {
          const ii = i + di;
          if (ii < 0 || ii >= this.nx) continue;
          n = this.cellInto(jj * this.nx + ii, out, n);
        }
      }
    }
    return n;
  }
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
  /** Radius of the box junction (covers every carriageway meeting there). */
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
 * Spatial index of the carriageways (segments on a 16 m grid): which road's asphalt a point is
 * on, without scanning every road.
 */
export class RoadIndex {
  private readonly grid: BoxGrid;
  private readonly segs: Float64Array;
  private readonly segRoad: Int32Array;
  private readonly buf = new Int32Array(4096);

  constructor(readonly infos: RoadInfo[]) {
    const boxes: number[][] = [];
    const segs: number[] = [];
    const road: number[] = [];
    infos.forEach((info, r) => {
      const m = info.road.width / 2 + 4;
      for (let i = 0; i < info.pts.length - 1; i++) {
        const [ax, az] = info.pts[i];
        const [bx, bz] = info.pts[i + 1];
        boxes.push([Math.min(ax, bx) - m, Math.max(ax, bx) + m, Math.min(az, bz) - m, Math.max(az, bz) + m]);
        segs.push(ax, az, bx, bz);
        road.push(r);
      }
    });
    this.grid = new BoxGrid(boxes, 16);
    this.segs = new Float64Array(segs);
    this.segRoad = new Int32Array(road);
  }

  /** Index of a road (other than `skip`) whose asphalt, grown by `margin` (≤ 4 m), covers (x, z); −1 if none. */
  roadAt(x: number, z: number, skip = -1, margin = 0): number {
    this.grid.begin();
    const n = this.grid.box(x, x, z, z, this.buf, 0);
    for (let k = 0; k < n; k++) {
      const i = this.buf[k];
      const r = this.segRoad[i];
      if (r === skip) continue;
      const ax = this.segs[i * 4];
      const az = this.segs[i * 4 + 1];
      const dx = this.segs[i * 4 + 2] - ax;
      const dz = this.segs[i * 4 + 3] - az;
      const l2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
      const lim = this.infos[r].road.width / 2 + margin;
      const ex = ax + dx * t - x;
      const ez = az + dz * t - z;
      if (ex * ex + ez * ez < lim * lim) return r;
    }
    return -1;
  }

  onRoad(x: number, z: number, skip = -1, margin = 0): boolean {
    return this.roadAt(x, z, skip, margin) >= 0;
  }
}

/**
 * Junctions: vertices shared by carriageways (mapped roads meet at common nodes), plus for
 * hand-placed roads vertices lying on another road and dangling ends close to one (snapped
 * onto it). Junction points closer than 16 m merge (a crossing of two dual carriageways is one
 * junction), and each junction's radius covers every carriageway meeting there.
 */
export function analyseRoads(roads: Road[]): { infos: RoadInfo[]; junctions: Junction[]; byRoad: number[][] } {
  const pts = roads.map((r) => r.points.map((p) => [p[0], p[1]] as [number, number]));
  const raw: { x: number; z: number; roads: Set<number> }[] = [];
  const at = new Map<string, Set<number>>();
  const keyOf = (x: number, z: number) => `${Math.round(x * 10)},${Math.round(z * 10)}`;
  roads.forEach((r, i) => {
    for (const [x, z] of r.points) {
      const k = keyOf(x, z);
      const s = at.get(k);
      if (s) s.add(i);
      else at.set(k, new Set([i]));
    }
  });
  const seen = new Set<string>();
  roads.forEach((r) => {
    for (const [x, z] of r.points) {
      const k = keyOf(x, z);
      const s = at.get(k) as Set<number>;
      if (s.size < 2 || seen.has(k)) continue;
      seen.add(k);
      raw.push({ x, z, roads: new Set(s) });
    }
  });
  // Hand-placed roads (no source): the proximity rules.
  const base = roads.map((r) => roadInfo(r));
  roads.forEach((r, i) => {
    if (r.source) return;
    r.points.forEach((p, k) => {
      const end = k === 0 || k === r.points.length - 1;
      for (let j = 0; j < roads.length; j++) {
        if (j === i) continue;
        const near = nearestOnPolyline(p[0], p[1], base[j]);
        const tol = roads[j].width / 2 + (end ? 14 : 3);
        if (near.d > tol) continue;
        if (end) pts[i][k] = [near.x, near.z];
        raw.push({ x: near.x, z: near.z, roads: new Set([i, j]) });
      }
    });
  });
  // Merge nearby points (union-find over a 16 m grid).
  const parent = raw.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  const cells = new Map<string, number[]>();
  const R = 16;
  raw.forEach((p, i) => {
    const cx = Math.floor(p.x / R);
    const cz = Math.floor(p.z / R);
    for (let dx = -1; dx <= 1; dx++)
      for (let dz = -1; dz <= 1; dz++)
        for (const j of cells.get(`${cx + dx},${cz + dz}`) ?? []) if (Math.hypot(raw[j].x - p.x, raw[j].z - p.z) < R) parent[find(i)] = find(j);
    const k = `${cx},${cz}`;
    const l = cells.get(k);
    if (l) l.push(i);
    else cells.set(k, [i]);
  });
  const groups = new Map<number, number[]>();
  raw.forEach((_, i) => {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(i);
    else groups.set(r, [i]);
  });
  const junctions: Junction[] = [];
  const byRoad: number[][] = roads.map(() => []);
  for (const g of groups.values()) {
    const x = g.reduce((s, i) => s + raw[i].x, 0) / g.length;
    const z = g.reduce((s, i) => s + raw[i].z, 0) / g.length;
    const members = new Set<number>();
    let r = 0;
    for (const i of g) {
      for (const k of raw[i].roads) {
        members.add(k);
        r = Math.max(r, Math.hypot(raw[i].x - x, raw[i].z - z) + roads[k].width / 2);
      }
    }
    const id = junctions.length;
    junctions.push({ x, z, r, roads: [...members].sort((a, b) => a - b) });
    for (const k of members) byRoad[k].push(id);
  }
  const infos = roads.map((r, i) => roadInfo(r, pts[i]));
  return { infos, junctions, byRoad };
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

/** Lanes per direction of a two-way road (3.25 m lanes, 1 m shoulders). */
export function lanesPerDirection(width: number): number {
  return Math.max(1, Math.floor((width - 2) / 3.25 / 2));
}

/** Lanes of a carriageway: per direction for two-way roads, in all for one-way ones. */
export function laneCount(road: Road): number {
  return road.oneway ? Math.max(1, Math.floor((road.width - 1) / 3.25)) : lanesPerDirection(road.width);
}

/** Lateral offsets (left of the polyline direction) and travel directions of a road's lanes (keep left). */
export function laneLayout(road: Road): { lat: number; dir: 1 | -1 }[] {
  const n = laneCount(road);
  const out: { lat: number; dir: 1 | -1 }[] = [];
  if (road.oneway) {
    for (let k = 0; k < n; k++) out.push({ lat: (n * 3.25) / 2 - (k + 0.5) * 3.25, dir: 1 });
    return out;
  }
  for (const dir of [1, -1] as const) for (let k = 0; k < n; k++) out.push({ lat: dir * (0.4 + (k + 0.5) * 3.25), dir });
  return out;
}

/** Streets with raised, kerbed pavements, marked lanes and street trees (the narrow ones share the road). */
export function isMajor(road: Road): boolean {
  return !road.cls || road.cls === 'trunk' || road.cls === 'primary' || road.cls === 'secondary' || road.cls === 'tertiary';
}

/** Sidewalk width alongside a road of the given carriageway width. */
export function sidewalkWidth(width: number, road?: Road): number {
  if (road?.cls && road.oneway) return road.cls === 'trunk' || road.cls === 'primary' ? 5 : 3.5;
  return width >= 36 ? 7 : width >= 28 ? 5.5 : width >= 14 ? 4.5 : 3.5;
}

/** Ginkgo avenues (御堂筋, 新御堂筋). */
export function isGinkgoAvenue(road: Road): boolean {
  return road.id === 'midosuji' || road.id === 'shinmidosuji' || road.nameJa === '御堂筋' || road.nameJa === '新御堂筋';
}

// ---------------------------------------------------------------- building plan index

/**
 * The street-level plan of the buildings (volumes that reach the ground): is a point inside
 * one, and how far a pavement can reach from the kerb before it meets a facade.
 */
export class PlanIndex {
  private readonly grid: BoxGrid;
  private readonly buf = new Int32Array(2048);

  constructor(readonly rings: P2[][][]) {
    this.grid = new BoxGrid(
      rings.map((r) => polyBox(r[0])),
      24,
    );
  }

  /** Is (x, z) inside a building, or within `margin` of its outline? */
  inside(x: number, z: number, margin = 0): boolean {
    this.grid.begin();
    const n = this.grid.box(x - margin, x + margin, z - margin, z + margin, this.buf, 0);
    for (let k = 0; k < n; k++) {
      const r = this.rings[this.buf[k]];
      const [x0, x1, z0, z1] = polyBox(r[0]);
      if (x < x0 - margin || x > x1 + margin || z < z0 - margin || z > z1 + margin) continue;
      if (insideRings(r, x, z)) return true;
      if (margin > 0 && distanceToEdges(r, x, z) < margin) return true;
    }
    return false;
  }

  /** Does a convex plan polygon overlap any building (corner inside, or edges crossing)? */
  overlapsConvex(q: P2[]): boolean {
    const [x0, x1, z0, z1] = polyBox(q);
    this.grid.begin();
    const n = this.grid.box(x0, x1, z0, z1, this.buf, 0);
    for (let k = 0; k < n; k++) {
      const rings = this.rings[this.buf[k]];
      const [a0, a1, b0, b1] = polyBox(rings[0]);
      if (a1 < x0 || a0 > x1 || b1 < z0 || b0 > z1) continue;
      for (const [x, z] of q) if (insideRings(rings, x, z)) return true;
      for (const r of rings) {
        for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
          const iv = clipConvex(signedArea(q) >= 0 ? q : [...q].reverse(), r[j][0], r[j][1], r[i][0] - r[j][0], r[i][1] - r[j][1], 0.01);
          if (iv && iv[1] - iv[0] > 1e-6) return true;
        }
      }
    }
    return false;
  }

  /** Distance from (x, z) along (dx, dz) (unit) to the first building outline, capped at `max`. */
  reach(x: number, z: number, dx: number, dz: number, max: number): number {
    const bx = x + dx * max;
    const bz = z + dz * max;
    this.grid.begin();
    const n = this.grid.box(Math.min(x, bx), Math.max(x, bx), Math.min(z, bz), Math.max(z, bz), this.buf, 0);
    let best = max;
    for (let k = 0; k < n; k++) {
      for (const ring of this.rings[this.buf[k]]) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const [px, pz] = ring[j];
          const ex = ring[i][0] - px;
          const ez = ring[i][1] - pz;
          const den = (bx - x) * ez - (bz - z) * ex;
          if (Math.abs(den) < 1e-12) continue;
          const t = ((px - x) * ez - (pz - z) * ex) / den;
          const u = ((px - x) * (bz - z) - (pz - z) * (bx - x)) / den;
          if (t >= 0 && t <= 1 && u >= 0 && u <= 1) best = Math.min(best, t * max);
        }
      }
      if (best === 0) return 0;
    }
    return best;
  }
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
 * kerbs of the major streets, skipping junctions, other roads, crossings and anything `blocked`
 * rejects (it is told what would stand there, so it can test that object's own envelope).
 * `near` ranks positions (e.g. by distance to the network); at most `maxTrees` / `maxLamps`
 * of the best-ranked are kept.
 */
export function placeStreetFurniture(
  infos: RoadInfo[],
  junctions: Junction[],
  blocked: (x: number, z: number, what: 'tree' | 'lamp', kind: number) => boolean,
  opts: { index?: RoadIndex; byRoad?: number[][]; rank?: (x: number, z: number) => number; maxTrees?: number; maxLamps?: number } = {},
): { trees: Placement[]; lamps: Placement[] } {
  const index = opts.index ?? new RoadIndex(infos);
  const rank = opts.rank ?? (() => 0);
  const trees: (Placement & { rk: number })[] = [];
  const lamps: (Placement & { rk: number })[] = [];
  const tmp = { x: 0, z: 0, dx: 1, dz: 0, seg: 0 };
  infos.forEach((info, i) => {
    if (!isMajor(info.road)) return;
    const w = info.road.width;
    const sw = sidewalkWidth(w, info.road);
    const ginkgo = isGinkgoAvenue(info.road);
    const js = opts.byRoad ? opts.byRoad[i].map((k) => junctions[k]) : junctions;
    const stations = junctionStations(info, js);
    const nearJunction = (s: number) => stations.some((j) => Math.abs(j.s - s) < j.r + 12);
    const place = (spacing: number, inset: number, list: (Placement & { rk: number })[], what: 'tree' | 'lamp', kind: number, phase: number) => {
      for (let s = phase; s < info.len; s += spacing) {
        if (nearJunction(s)) continue;
        pointAt(info, s, tmp);
        for (const side of [1, -1]) {
          const lx = tmp.dz * side;
          const lz = -tmp.dx * side;
          const x = tmp.x + lx * (w / 2 + inset);
          const z = tmp.z + lz * (w / 2 + inset);
          if (index.onRoad(x, z, i, Math.min(4, sw * 0.5)) || blocked(x, z, what, kind)) continue;
          list.push({ x, z, yaw: Math.atan2(-lx, -lz), kind, rk: rank(x, z) });
        }
      }
    };
    if (!info.road.terminal && info.road.id !== 'ekimae') place(ginkgo ? 10 : 18, Math.min(1.4, sw * 0.3), trees, 'tree', ginkgo ? 1 : 0, 4);
    place(30, 0.5, lamps, 'lamp', 0, 15);
  });
  const best = (l: (Placement & { rk: number })[], max: number | undefined) => {
    const kept = max !== undefined && l.length > max ? [...l].sort((a, b) => a.rk - b.rk).slice(0, max) : l;
    return kept.map(({ rk: _, ...p }) => p);
  };
  return { trees: best(trees, opts.maxTrees), lamps: best(lamps, opts.maxLamps) };
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
/** Hub height (real m) and radius of the HEP FIVE wheel (Ø75 m, top 106 m). */
export const WHEEL_HUB = 68.5;
export const WHEEL_RADIUS = 37.5;

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
