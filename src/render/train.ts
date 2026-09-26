import * as THREE from 'three';
import { Mesher, type Frame, type V3 } from './station-geo';
import { makeCanvas } from './station-tex';

/**
 * Rolling stock: car bodies with a rounded cross-section (smooth normals), windows, doors and
 * the operator's livery painted into one shared canvas atlas (a row per livery), cab fronts
 * with a raked windscreen, gangways, bogies with wheels, underfloor boxes, roof AC units and
 * pantographs. A whole train is two meshes (body + equipment); every train in the scene can be
 * merged into the same two draw calls because they share one atlas.
 *
 * Local car coordinates: x across (+x = left of the direction of travel), y up from rail top (m),
 * z along the train from its rear end.
 */

export interface Livery {
  id: string;
  /** Series name shown nowhere, kept for readers of the table. */
  series: string;
  body: string;
  /** Lower body colour for two-tone liveries (below `split` m above rail). */
  lower?: string;
  split?: number;
  roof: string;
  /** Horizontal bands [from, to] metres above rail. */
  stripes: [number, number, string][];
  doors: number;
  doorColor?: string;
  /** Door leaf width (m). */
  doorW: number;
  /** 'band' = commuter windows between doors, 'small' = limited-express seat windows. */
  windows: 'band' | 'small';
  frame?: string;
  /** Cab front: mask colour and windscreen rake (m). */
  mask: string;
  rake: number;
  width: number;
  carLen: number;
  gauge: number;
  pantograph: boolean;
  maxCars: number;
}

const JR_STAINLESS = '#c9ced2';

export const LIVERIES: Livery[] = [
  { id: 'jr323', series: '323系', body: JR_STAINLESS, roof: '#8d9296', stripes: [[1.7, 1.86, '#f07f1b'], [2.93, 3.05, '#f07f1b']], doors: 3, doorW: 1.4, doorColor: '#d3d6d8', windows: 'band', mask: '#16191c', rake: 0.35, width: 2.95, carLen: 19.5, gauge: 1.067, pantograph: true, maxCars: 8 },
  { id: 'jr225', series: '225系/321系', body: JR_STAINLESS, roof: '#8d9296', stripes: [[1.62, 1.82, '#0b64b3'], [1.82, 1.9, '#7d4f2a']], doors: 3, doorW: 1.3, windows: 'band', mask: '#16191c', rake: 0.45, width: 2.95, carLen: 19.5, gauge: 1.067, pantograph: true, maxCars: 12 },
  { id: 'jr207', series: '207系（JR東西線）', body: JR_STAINLESS, roof: '#8d9296', stripes: [[1.62, 1.82, '#0b64b3'], [1.82, 1.9, '#d0287e']], doors: 3, doorW: 1.3, windows: 'band', mask: '#16191c', rake: 0.3, width: 2.95, carLen: 19.5, gauge: 1.067, pantograph: true, maxCars: 7 },
  { id: 'jr683', series: '683系 サンダーバード', body: '#f1f0ea', roof: '#b9bcbd', stripes: [[1.9, 2.72, '#34404f'], [1.74, 1.82, '#1d4e9e'], [1.82, 1.86, '#8ea5c9']], doors: 2, doorW: 0.9, windows: 'small', mask: '#1b2230', rake: 1.4, width: 2.9, carLen: 21, gauge: 1.067, pantograph: true, maxCars: 9 },
  { id: 'jr271', series: '271系 はるか', body: '#f4f4f1', roof: '#babdbe', stripes: [[1.25, 1.72, '#1f5fae'], [1.72, 1.77, '#d83a34'], [1.95, 2.7, '#2f3a48']], doors: 2, doorW: 0.9, windows: 'small', mask: '#1b2230', rake: 1.2, width: 2.95, carLen: 21, gauge: 1.067, pantograph: true, maxCars: 9 },
  { id: 'jr221', series: '221系', body: '#ece6d5', roof: '#9c9a94', stripes: [[1.72, 1.86, '#6a3f25'], [1.86, 1.92, '#e2842a'], [1.97, 2.82, '#2b3239']], doors: 3, doorW: 1.3, windows: 'band', mask: '#1b1e22', rake: 0.5, width: 2.95, carLen: 19.5, gauge: 1.067, pantograph: true, maxCars: 8 },
  { id: 'hankyu', series: '阪急1000系', body: '#5a0d1d', roof: '#8e8b86', stripes: [[3.3, 3.5, '#e9e2cf']], doors: 3, doorW: 1.3, windows: 'band', frame: '#c9c6bf', mask: '#5a0d1d', rake: 0.15, width: 2.75, carLen: 19, gauge: 1.435, pantograph: true, maxCars: 8 },
  { id: 'hanshin', series: '阪神5700系', body: '#dde2e6', lower: '#0b56a6', split: 1.9, roof: '#8f9499', stripes: [[1.9, 1.96, '#79b8e6']], doors: 4, doorW: 1.3, windows: 'band', mask: '#16191c', rake: 0.35, width: 2.8, carLen: 19, gauge: 1.435, pantograph: true, maxCars: 6 },
  { id: 'metro-m', series: '30000系（御堂筋線）', body: '#c7ccd0', roof: '#8a8f94', stripes: [[1.68, 1.94, '#e5171f'], [2.95, 3.05, '#e5171f']], doors: 4, doorW: 1.3, windows: 'band', mask: '#16191c', rake: 0.3, width: 2.89, carLen: 18.9, gauge: 1.435, pantograph: false, maxCars: 10 },
  { id: 'metro-t', series: '22系（谷町線）', body: '#c7ccd0', roof: '#8a8f94', stripes: [[1.68, 1.94, '#6a2c8e']], doors: 4, doorW: 1.3, windows: 'band', mask: '#16191c', rake: 0.2, width: 2.89, carLen: 18.9, gauge: 1.435, pantograph: false, maxCars: 6 },
  { id: 'metro-y', series: '23系（四つ橋線）', body: '#c7ccd0', roof: '#8a8f94', stripes: [[1.68, 1.94, '#0078ba']], doors: 4, doorW: 1.3, windows: 'band', mask: '#16191c', rake: 0.2, width: 2.89, carLen: 18.9, gauge: 1.435, pantograph: false, maxCars: 6 },
];

const LINE_LIVERY: Record<string, string> = {
  'jr-loop': 'jr323',
  'jr-kobe': 'jr225',
  'jr-kyoto': 'jr225',
  'jr-takarazuka': 'jr225',
  'jr-tozai': 'jr207',
  'jr-ltd': 'jr683',
  'jr-umekita': 'jr271',
  'jr-higashi': 'jr221',
  'hankyu-kobe': 'hankyu',
  'hankyu-takarazuka': 'hankyu',
  'hankyu-kyoto': 'hankyu',
  hanshin: 'hanshin',
  midosuji: 'metro-m',
  tanimachi: 'metro-t',
  yotsubashi: 'metro-y',
};

/** Typical formation length per line (cars), capped by the platform length at placement. */
const LINE_CARS: Record<string, number> = {
  'jr-loop': 8,
  'jr-kobe': 12,
  'jr-kyoto': 12,
  'jr-takarazuka': 7,
  'jr-tozai': 7,
  'jr-ltd': 9,
  'jr-umekita': 9,
  'jr-higashi': 6,
  'hankyu-takarazuka': 10,
};

export function liveryFor(lineId: string): Livery {
  const id = LINE_LIVERY[lineId] ?? (lineId.startsWith('jr') ? 'jr225' : 'metro-m');
  return LIVERIES.find((l) => l.id === id) as Livery;
}

/** Whole cars that fit on a platform of `len` metres (≥ 2, ≤ the line's usual formation). */
export function carsFor(lineId: string, len: number): number {
  const l = liveryFor(lineId);
  const want = LINE_CARS[lineId] ?? l.maxCars;
  return Math.max(2, Math.min(want, Math.floor((len - 4) / (l.carLen + CAR_GAP))));
}

export const CAR_GAP = 0.5;

/** Total length (m) of a formation. */
export function trainLength(l: Livery, cars: number): number {
  return cars * l.carLen + (cars - 1) * CAR_GAP;
}

// ------------------------------------------------------------------------------------------------
// Livery atlas: one 128 px row per livery = [side 768 | cab front 128 | gangway end 128].

const ATLAS_W = 1024;
const ATLAS_H = 2048;
const ROW = 128;
/** Heights (m above rail) covered by the texture rows. */
const H_BOT = 1.0;
const H_TOP = 3.72;

let atlas: { map: THREE.Texture; glow: THREE.Texture } | null | undefined;

export function liveryAtlas(): { map: THREE.Texture; glow: THREE.Texture } | null {
  if (atlas !== undefined) return atlas;
  const a = makeCanvas(ATLAS_W, ATLAS_H);
  const b = makeCanvas(ATLAS_W, ATLAS_H);
  if (!a || !b) return (atlas = null);
  b.g.fillStyle = '#000';
  b.g.fillRect(0, 0, ATLAS_W, ATLAS_H);
  LIVERIES.forEach((l, i) => drawLivery(a.g, b.g, l, i * ROW));
  const mk = (c: HTMLCanvasElement) => {
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  };
  atlas = { map: mk(a.c), glow: mk(b.c) };
  return atlas;
}

export function disposeTrainTextures(): void {
  if (atlas) {
    atlas.map.dispose();
    atlas.glow.dispose();
  }
  atlas = undefined;
}

/** Door centre positions (m from car end) for a livery. */
export function doorPositions(l: Livery): number[] {
  if (l.windows === 'small') return [1.3, l.carLen - 1.3];
  return Array.from({ length: l.doors }, (_, k) => (l.carLen * (k + 0.5)) / l.doors);
}

function drawLivery(g: CanvasRenderingContext2D, e: CanvasRenderingContext2D, l: Livery, oy: number): void {
  const L = l.carLen;
  const X = (z: number) => (z / L) * 768;
  const Yp = (h: number) => oy + ((H_TOP - h) / (H_TOP - H_BOT)) * ROW;
  const band = (x0: number, w: number, h0: number, h1: number, c: string, ctx = g) => {
    ctx.fillStyle = c;
    ctx.fillRect(x0, Yp(h1), w, Yp(h0) - Yp(h1));
  };
  const cells: [number, number][] = [
    [0, 768],
    [768, 128],
    [896, 128],
  ];
  for (const [x0, w] of cells) {
    band(x0, w, H_BOT, H_TOP, l.body);
    if (l.lower) band(x0, w, H_BOT, l.split ?? 1.9, l.lower);
    // Roof: a soft grey gradient above the cant rail.
    const grd = g.createLinearGradient(0, Yp(H_TOP), 0, Yp(3.3));
    grd.addColorStop(0, l.roof);
    grd.addColorStop(1, shade(l.roof, 0.15));
    g.fillStyle = grd;
    g.fillRect(x0, Yp(H_TOP), w, Yp(3.3) - Yp(H_TOP));
    for (const [h0, h1, c] of l.stripes) band(x0, w, h0, h1, c);
  }
  // Stainless cars: faint vertical beads for a brushed-metal look.
  if (l.body === JR_STAINLESS || l.id.startsWith('metro')) {
    g.fillStyle = 'rgba(255,255,255,0.10)';
    for (let x = 2; x < 768; x += 6) g.fillRect(x, Yp(1.62), 1, Yp(1.05) - Yp(1.62));
  }

  // --- side: doors and windows
  const doors = doorPositions(l);
  const winLo = l.windows === 'small' ? 2.0 : 1.95;
  const winHi = l.windows === 'small' ? 2.66 : 2.86;
  const glass = (x: number, w: number, h0: number, h1: number) => {
    const grd = g.createLinearGradient(0, Yp(h1), 0, Yp(h0));
    grd.addColorStop(0, '#46525e');
    grd.addColorStop(0.35, '#232b33');
    grd.addColorStop(1, '#1a2027');
    if (l.frame) band(x - 2, w + 4, h0 - 0.05, h1 + 0.05, l.frame);
    g.fillStyle = grd;
    g.fillRect(x, Yp(h1), w, Yp(h0) - Yp(h1));
    band(x, w, h0, h1, '#ffefc6', e);
  };
  // Door leaves with their windows and a dark gap between the leaves.
  for (const d of doors) {
    const x = X(d - l.doorW / 2);
    const w = X(l.doorW);
    band(x - 1, w + 2, 1.12, 3.06, '#3a3f44');
    band(x, w, 1.14, 3.04, l.doorColor ?? (l.lower ? l.body : l.body));
    if (l.lower) band(x, w, 1.14, l.split ?? 1.9, l.lower);
    const leaves = l.windows === 'small' ? 1 : 2;
    for (let k = 0; k < leaves; k++) {
      const lx = x + (w / leaves) * k;
      glass(lx + w * 0.08 / leaves, (w / leaves) * 0.84, 2.0, 2.86);
    }
    if (leaves === 2) band(x + w / 2 - 0.5, 1, 1.14, 3.04, '#2a2e33');
  }
  // Windows in each bay between doors (and between the car ends and the end doors).
  const edges = [0.35, ...doors.flatMap((d) => [d - l.doorW / 2 - 0.25, d + l.doorW / 2 + 0.25]), L - 0.35];
  for (let i = 0; i < edges.length; i += 2) {
    const a = edges[i] + 0.1;
    const b = edges[i + 1] - 0.1;
    const len = b - a;
    if (len < 0.5) continue;
    const pitch = l.windows === 'small' ? 1.0 : 2.1;
    const n = Math.max(1, Math.round(len / pitch));
    const pw = len / n;
    for (let k = 0; k < n; k++) glass(X(a + pw * k + 0.12), X(pw - 0.24), winLo, winHi);
  }
  // Car-end panel joints.
  band(0, 2, H_BOT, 3.3, 'rgba(0,0,0,0.35)');
  band(766, 2, H_BOT, 3.3, 'rgba(0,0,0,0.35)');

  // --- cab front (u across the width, left→right as seen from ahead)
  const U = (u: number) => 768 + u * 128;
  const fr = (u0: number, u1: number, h0: number, h1: number, c: string, ctx = g) => {
    ctx.fillStyle = c;
    ctx.fillRect(U(u0), Yp(h1), U(u1) - U(u0), Yp(h0) - Yp(h1));
  };
  if (l.id === 'hankyu') {
    fr(0.06, 0.4, 2.05, 3.05, '#1b2127');
    fr(0.6, 0.94, 2.05, 3.05, '#1b2127');
    fr(0.42, 0.58, 1.3, 3.05, '#4a0a17');
    fr(0.44, 0.56, 2.1, 2.95, '#1b2127');
    fr(0.1, 0.36, 2.85, 3.0, '#101010');
    fr(0.14, 0.32, 2.88, 2.97, '#ffb13b', e);
  } else {
    fr(0.05, 0.95, 2.0, 3.25, l.mask);
    fr(0.1, 0.9, 2.12, 2.95, '#2c3844');
    fr(0.3, 0.7, 2.97, 3.18, '#0a0a0a');
    fr(0.34, 0.66, 3.02, 3.13, '#ffb13b');
    fr(0.34, 0.66, 3.02, 3.13, '#ffb13b', e);
  }
  // Head / tail lights.
  for (const [u0, u1] of [[0.1, 0.24], [0.76, 0.9]] as const) {
    fr(u0, u1, 1.5, 1.66, '#f3efe2');
    fr(u0, u1, 1.5, 1.66, '#ffffff', e);
  }
  for (const [u0, u1] of [[0.25, 0.31], [0.69, 0.75]] as const) fr(u0, u1, 1.52, 1.64, '#8a1414');

  // --- gangway end
  const V = (u: number) => 896 + u * 128;
  const en = (u0: number, u1: number, h0: number, h1: number, c: string, ctx = g) => {
    ctx.fillStyle = c;
    ctx.fillRect(V(u0), Yp(h1), V(u1) - V(u0), Yp(h0) - Yp(h1));
  };
  en(0.34, 0.66, 1.15, 3.08, '#50565c');
  en(0.39, 0.61, 2.15, 2.8, '#232b33');
  en(0.39, 0.61, 2.15, 2.8, '#ffefc6', e);
  for (const [u0, u1] of [[0.08, 0.26], [0.74, 0.92]] as const) {
    en(u0, u1, 2.1, 2.8, '#232b33');
    en(u0, u1, 2.1, 2.8, '#ffefc6', e);
  }
}

function shade(hex: string, k: number): string {
  const c = new THREE.Color(hex);
  c.offsetHSL(0, 0, -k);
  return `#${c.getHexString()}`;
}

/** Atlas UV of a point in a livery cell: kind 0 side, 1 front, 2 end; u, v in 0…1 of the cell. */
function atlasUV(row: number, kind: 0 | 1 | 2, u: number, v: number): [number, number] {
  const x0 = kind === 0 ? 0 : kind === 1 ? 768 : 896;
  const w = kind === 0 ? 768 : 128;
  const px = x0 + 1.5 + Math.min(1, Math.max(0, u)) * (w - 3);
  const py = row * ROW + 1.5 + (1 - Math.min(1, Math.max(0, v))) * (ROW - 3);
  return [px / ATLAS_W, 1 - py / ATLAS_H];
}

// ------------------------------------------------------------------------------------------------
// Geometry

/** Half cross-section (right side, bottom → roof centre), metres. */
function halfProfile(w: number): [number, number][] {
  const h = w / 2;
  return [
    [h - 0.1, 1.0],
    [h - 0.03, 1.2],
    [h, 1.45],
    [h, 2.6],
    [h - 0.03, 3.05],
    [h - 0.12, 3.33],
    [h - 0.34, 3.54],
    [h - 0.72, 3.66],
    [h - 1.1, 3.71],
    [0, 3.72],
  ];
}

/** Full ring, counter-clockwise seen from +z: right side up, over the roof, left side down. */
export function bodyProfile(w: number): [number, number][] {
  const half = halfProfile(w);
  const left = half
    .slice(0, -1)
    .reverse()
    .map(([x, y]) => [-x, y] as [number, number]);
  return [...half, ...left];
}

const tmpC = new THREE.Color();

export interface TrainParts {
  body: Mesher;
  equip: Mesher;
  length: number;
  livery: Livery;
}

/**
 * Builds a formation in local coordinates. `detail` adds bogies, wheels and underfloor gear
 * (only worth it in walk mode, where the camera is metres away).
 */
export function trainParts(lineId: string, cars: number, detail: boolean): TrainParts {
  const l = liveryFor(lineId);
  const row = LIVERIES.indexOf(l);
  const body = new Mesher();
  const equip = new Mesher();
  const ring = bodyProfile(l.width);
  const n = ring.length;
  // Per-vertex outward normals from neighbouring points (smooth shading around the shell).
  const nrm = ring.map((_, i) => {
    const a = ring[Math.max(0, i - 1)];
    const b = ring[Math.min(n - 1, i + 1)];
    const tx = b[0] - a[0];
    const ty = b[1] - a[1];
    const len = Math.hypot(tx, ty) || 1;
    return [ty / len, -tx / len] as [number, number];
  });
  const vOf = (y: number) => (y - H_BOT) / (H_TOP - H_BOT);
  const white = tmpC.set('#ffffff').clone();
  const dark = new THREE.Color('#2b2f33');
  const mid = new THREE.Color('#4a4f55');
  const roofBox = new THREE.Color('#aeb3b7');
  const gangway = new THREE.Color('#25282b');
  const wheel = new THREE.Color('#3b3d40');

  for (let c = 0; c < cars; c++) {
    const z0 = c * (l.carLen + CAR_GAP);
    const z1 = z0 + l.carLen;
    const cab0 = c === 0;
    const cab1 = c === cars - 1;
    // Windscreen rake: upper ring points pulled back at cab ends.
    const zAt = (y: number, end: 0 | 1) => {
      const cab = end === 0 ? cab0 : cab1;
      if (!cab || y < 2.0) return end === 0 ? z0 : z1;
      const k = Math.min(1, (y - 2.0) / 1.72) * l.rake;
      return end === 0 ? z0 + k : z1 - k;
    };
    for (let i = 0; i < n - 1; i++) {
      const [xa, ya] = ring[i];
      const [xb, yb] = ring[i + 1];
      const na: V3 = [nrm[i][0], nrm[i][1], 0];
      const nb: V3 = [nrm[i + 1][0], nrm[i + 1][1], 0];
      // u runs so that each side reads left→right seen from outside (no mirrored texture).
      const uA0 = xa + xb <= 0 ? 0 : 1;
      const uA1 = 1 - uA0;
      const [a0u, a0v] = atlasUV(row, 0, uA0, vOf(ya));
      const [b0u, b0v] = atlasUV(row, 0, uA0, vOf(yb));
      const [b1u, b1v] = atlasUV(row, 0, uA1, vOf(yb));
      const [a1u, a1v] = atlasUV(row, 0, uA1, vOf(ya));
      const A: V3 = [xa, ya, zAt(ya, 0)];
      const B: V3 = [xb, yb, zAt(yb, 0)];
      const C: V3 = [xb, yb, zAt(yb, 1)];
      const D: V3 = [xa, ya, zAt(ya, 1)];
      body.triN(A, B, C, na, nb, nb, white, [a0u, a0v, b0u, b0v, b1u, b1v]);
      body.triN(A, C, D, na, nb, na, white, [a0u, a0v, b1u, b1v, a1u, a1v]);
    }
    // End caps: fan around a centre point, front (cab) or gangway texture.
    for (const end of [0, 1] as const) {
      const cab = end === 0 ? cab0 : cab1;
      const kind = cab ? 1 : 2;
      const zc = end === 0 ? z0 + (cab ? l.rake * 0.4 : 0) : z1 - (cab ? l.rake * 0.4 : 0);
      const ctr: V3 = [0, 2.3, zc];
      const nz: V3 = [0, 0, end === 0 ? -1 : 1];
      // u across as seen from outside that end.
      const uOf = (x: number) => (end === 0 ? 0.5 - x / l.width : 0.5 + x / l.width);
      const cuv = atlasUV(row, kind, 0.5, vOf(2.3));
      const pts = [...ring, ring[0]];
      for (let i = 0; i < pts.length - 1; i++) {
        const p = pts[i];
        const q = pts[i + 1];
        const Pp: V3 = [p[0], p[1], zAt(p[1], end)];
        const Qq: V3 = [q[0], q[1], zAt(q[1], end)];
        const pu = atlasUV(row, kind, uOf(p[0]), vOf(p[1]));
        const qu = atlasUV(row, kind, uOf(q[0]), vOf(q[1]));
        if (end === 0) body.triN(ctr, Qq, Pp, nz, nz, nz, white, [cuv[0], cuv[1], qu[0], qu[1], pu[0], pu[1]]);
        else body.triN(ctr, Pp, Qq, nz, nz, nz, white, [cuv[0], cuv[1], pu[0], pu[1], qu[0], qu[1]]);
      }
    }

    // --- equipment
    const zm = (z0 + z1) / 2;
    const ax: V3 = [0, 0, 1];
    const up: V3 = [0, 1, 0];
    // Underframe and equipment boxes.
    equip.box([0, 0.78, zm], ax, up, l.carLen - 5.8, 0.44, l.width - 0.5, dark);
    // Roof: AC unit(s).
    if (l.windows === 'small') {
      equip.box([0, 3.8, z0 + l.carLen * 0.25], ax, up, 2.6, 0.2, 1.5, roofBox);
      equip.box([0, 3.8, z0 + l.carLen * 0.75], ax, up, 2.6, 0.2, 1.5, roofBox);
    } else {
      // AC unit with a darker grille on top.
      equip.box([0, 3.8, zm], ax, up, 3.2, 0.2, 1.6, roofBox);
      equip.box([0, 3.91, zm], ax, up, 2.4, 0.03, 1.2, mid);
    }
    // Gangway bellows to the next car.
    if (c < cars - 1) equip.box([0, 2.15, z1 + CAR_GAP / 2], ax, up, CAR_GAP + 0.1, 2.0, 1.25, gangway);
    // Pantograph: base, a single arm and the pan head at contact-wire height (5.1 m).
    if (l.pantograph && c % 3 === 1 && c < cars - 1) {
      const zp = z0 + l.carLen * 0.22;
      equip.box([0, 3.82, zp], ax, up, 1.6, 0.18, 1.3, mid);
      equip.beam([0, 3.9, zp + 0.7], [0, 4.55, zp - 0.4], 0.09, 0.09, dark);
      equip.beam([0, 4.55, zp - 0.4], [0, 5.02, zp + 0.1], 0.07, 0.07, dark);
      equip.box([0, 5.05, zp + 0.1], [1, 0, 0], up, 1.9, 0.07, 0.22, dark);
    }
    if (detail) {
      for (const zb of [z0 + 2.4, z1 - 2.4]) {
        equip.box([0, 0.58, zb], ax, up, 2.8, 0.36, 2.1, dark);
        for (const dz of [-1.05, 1.05]) {
          for (const sx of [-1, 1]) {
            const x = (sx * l.gauge) / 2;
            equip.prism([x - 0.07, 0.43, zb + dz], [x + 0.07, 0.43, zb + dz], 0.43, 10, wheel);
          }
        }
      }
      // Skirt / coupler at cab ends.
      if (cab0) equip.box([0, 0.8, z0 + 0.15], ax, up, 0.3, 0.36, l.width * 0.7, dark);
      if (cab1) equip.box([0, 0.8, z1 - 0.15], ax, up, 0.3, 0.36, l.width * 0.7, dark);
    }
  }
  return { body, equip, length: trainLength(l, cars), livery: l };
}

/**
 * Copies a local-coordinate soup into `out`, placed on a track: z → along the frame from `s0`,
 * x → left offset from the track centre `t`, y → `y0 + y·hs` (vertical scale hs).
 * `reverse` turns the train around (its rear at s0 + length).
 */
export function placeSoup(src: Mesher, out: Mesher, f: Frame, s0: number, t: number, y0: number, hs: number, length: number, reverse = false): void {
  const { pos, nor } = src;
  const lx = f.dz;
  const lz = -f.dx;
  for (let i = 0; i < pos.length; i += 3) {
    let x = pos[i];
    let z = pos[i + 2];
    let nx = nor[i];
    let nz = nor[i + 2];
    if (reverse) {
      x = -x;
      z = length - z;
      nx = -nx;
      nz = -nz;
    }
    const s = s0 + z;
    out.pos.push(f.ox + f.dx * s + lx * (t + x), y0 + pos[i + 1] * hs, f.oz + f.dz * s + lz * (t + x));
    // Vertical scaling: normals scale by 1/hs in y, then renormalise.
    const wx = f.dx * nz + lx * nx;
    const wz = f.dz * nz + lz * nx;
    const wy = nor[i + 1] / hs;
    const len = Math.hypot(wx, wy, wz) || 1;
    out.nor.push(wx / len, wy / len, wz / len);
  }
  for (const v of src.col) out.col.push(v);
  for (const v of src.uv) out.uv.push(v);
}

export function trainMaterials(dark: boolean): { body: THREE.Material; equip: THREE.Material } {
  const a = liveryAtlas();
  const body = new THREE.MeshPhongMaterial({
    map: a?.map ?? null,
    emissiveMap: a?.glow ?? null,
    emissive: a ? new THREE.Color('#ffffff') : new THREE.Color('#000000'),
    emissiveIntensity: dark ? 0.85 : 0.04,
    color: a ? 0xffffff : 0xb9bec3,
    shininess: 48,
    specular: new THREE.Color(dark ? '#303030' : '#4a4a4a'),
  });
  const equip = new THREE.MeshLambertMaterial({ vertexColors: true });
  return { body, equip };
}
