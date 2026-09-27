import { platformPieces, type NetEdge, type NetNode, type Network } from '../core/types';

/**
 * The space people actually walk through: every corridor, junction, platform, flight and lift
 * shaft as a convex plan polygon with a (planar) floor and a clearance height above it.
 *
 * Geometry builders ask it where NOT to build: a wall, column, facade or slab that would stand
 * inside this volume is clipped, so the walker (who follows the network's centre lines) and the
 * crowd never pass through anything solid. Units are real metres (scene Y = Y(real y)).
 */

export type PieceKind = 'corridor' | 'junction' | 'platform' | 'flight' | 'shaft';

export interface WalkPiece {
  /** Edge id (corridors, flights, shafts), `node:<id>` (junctions) or `platform:<id>`. */
  id: string;
  kind: PieceKind;
  /** Convex plan polygon, counter-clockwise in (x, z). */
  poly: [number, number][];
  box: [number, number, number, number];
  /** Floor height: f0 + fx·x + fz·z (real metres). */
  f0: number;
  fx: number;
  fz: number;
  /** Clear height above the floor that must stay free. */
  clear: number;
  indoor: boolean;
}

/** Head room kept free above every walking surface (a tall person plus a margin). */
export const CLEARANCE = 2.3;

/** Width of a corridor as drawn by the walk-through (walkway.ts uses the same rule). */
export const corridorWidth = (e: NetEdge): number => Math.min(26, Math.max(3, e.width ?? (e.kind === 'crossing' ? 8 : e.kind === 'gate' ? 10 : 6)));

/** Plan width of a stair / escalator lane (walkway.ts and station.ts draw them this wide). */
export const flightWidth = (e: NetEdge): number => (e.kind === 'stairs' ? Math.min(8, Math.max(1.8, e.width ?? 3.2)) : e.kind === 'escalator' ? 1.6 : 2.6);

const VERTICAL = new Set(['stairs', 'escalator', 'elevator']);

const cache = new WeakMap<Network, WalkSpace>();

export class WalkSpace {
  readonly pieces: WalkPiece[] = [];
  private readonly cell = 8;
  private readonly grid = new Map<string, number[]>();

  /** Shared instance per network (the network is immutable once built). */
  static of(net: Network): WalkSpace {
    let s = cache.get(net);
    if (!s) {
      s = new WalkSpace(net);
      cache.set(net, s);
    }
    return s;
  }

  constructor(net: Network) {
    const byId = new Map(net.nodes.map((n) => [n.id, n]));
    const reach = new Map<string, number>();
    for (const e of net.edges) {
      const a = byId.get(e.a) as NetNode;
      const b = byId.get(e.b) as NetNode;
      if (VERTICAL.has(e.kind)) {
        if (e.kind === 'elevator') this.addShaft(e, a, b);
        else this.addStrip(e.id, 'flight', a, b, flightWidth(e) / 2 + 0.1, e.indoor);
        continue;
      }
      const w = corridorWidth(e);
      this.addStrip(e.id, 'corridor', a, b, w / 2, e.indoor);
      for (const n of [a, b]) reach.set(n.id, Math.max(reach.get(n.id) ?? 0, w / 2));
    }
    // Junction discs fill the wedges between the corridors meeting at a node.
    for (const [id, r] of reach) {
      const n = byId.get(id) as NetNode;
      const k = 12;
      const rr = Math.max(0.5, r - 0.1) / Math.cos(Math.PI / k);
      const poly: [number, number][] = [];
      for (let i = 0; i < k; i++) poly.push([n.x + rr * Math.cos((2 * Math.PI * i) / k), n.z + rr * Math.sin((2 * Math.PI * i) / k)]);
      this.push({ id: `node:${id}`, kind: 'junction', poly, f0: n.y, fx: 0, fz: 0, clear: CLEARANCE, indoor: true });
    }
    for (const p of net.platforms.flatMap(platformPieces)) {
      const ax = p.b[0] - p.a[0];
      const az = p.b[1] - p.a[1];
      const len = Math.hypot(ax, az) || 1;
      const nx = (-az / len) * (p.width / 2);
      const nz = (ax / len) * (p.width / 2);
      const poly: [number, number][] = [
        [p.a[0] - nx, p.a[1] - nz],
        [p.b[0] - nx, p.b[1] - nz],
        [p.b[0] + nx, p.b[1] + nz],
        [p.a[0] + nx, p.a[1] + nz],
      ];
      this.push({ id: `platform:${p.id}`, kind: 'platform', poly, f0: p.y, fx: 0, fz: 0, clear: CLEARANCE, indoor: true });
    }
  }

  /** A strip of half width hw along a→b whose floor rises linearly from a.y to b.y. */
  private addStrip(id: string, kind: PieceKind, a: NetNode, b: NetNode, hw: number, indoor: boolean): void {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const run = Math.hypot(dx, dz);
    if (run < 0.05) return;
    const ux = dx / run;
    const uz = dz / run;
    const nx = -uz * hw;
    const nz = ux * hw;
    const poly: [number, number][] = [
      [a.x - nx, a.z - nz],
      [b.x - nx, b.z - nz],
      [b.x + nx, b.z + nz],
      [a.x + nx, a.z + nz],
    ];
    const k = (b.y - a.y) / run;
    this.push({ id, kind, poly, f0: a.y - k * (a.x * ux + a.z * uz), fx: k * ux, fz: k * uz, clear: CLEARANCE, indoor });
  }

  private addShaft(e: NetEdge, a: NetNode, b: NetNode): void {
    const h = flightWidth(e) / 2;
    const cx = (a.x + b.x) / 2;
    const cz = (a.z + b.z) / 2;
    const lo = Math.min(a.y, b.y);
    const hi = Math.max(a.y, b.y);
    this.push({
      id: e.id,
      kind: 'shaft',
      poly: [
        [cx - h, cz - h],
        [cx + h, cz - h],
        [cx + h, cz + h],
        [cx - h, cz + h],
      ],
      f0: lo,
      fx: 0,
      fz: 0,
      clear: hi - lo + CLEARANCE,
      indoor: e.indoor,
    });
  }

  private push(p: Omit<WalkPiece, 'box'>): void {
    // Normalise to counter-clockwise (positive signed area in x-z).
    let area = 0;
    for (let i = 0; i < p.poly.length; i++) {
      const [x0, z0] = p.poly[i];
      const [x1, z1] = p.poly[(i + 1) % p.poly.length];
      area += x0 * z1 - x1 * z0;
    }
    if (area < 0) p.poly.reverse();
    const xs = p.poly.map((q) => q[0]);
    const zs = p.poly.map((q) => q[1]);
    const piece: WalkPiece = { ...p, box: [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)] };
    const id = this.pieces.length;
    this.pieces.push(piece);
    const [x0, x1, z0, z1] = piece.box;
    for (let gx = Math.floor(x0 / this.cell); gx <= Math.floor(x1 / this.cell); gx++)
      for (let gz = Math.floor(z0 / this.cell); gz <= Math.floor(z1 / this.cell); gz++) {
        const key = `${gx},${gz}`;
        const l = this.grid.get(key);
        if (l) l.push(id);
        else this.grid.set(key, [id]);
      }
  }

  /** Pieces whose plan bounding box overlaps the given box. */
  query(x0: number, x1: number, z0: number, z1: number): WalkPiece[] {
    const seen = new Set<number>();
    const out: WalkPiece[] = [];
    for (let gx = Math.floor(x0 / this.cell); gx <= Math.floor(x1 / this.cell); gx++)
      for (let gz = Math.floor(z0 / this.cell); gz <= Math.floor(z1 / this.cell); gz++)
        for (const i of this.grid.get(`${gx},${gz}`) ?? []) {
          if (seen.has(i)) continue;
          seen.add(i);
          const p = this.pieces[i];
          if (p.box[0] <= x1 && p.box[1] >= x0 && p.box[2] <= z1 && p.box[3] >= z0) out.push(p);
        }
    return out;
  }

  /**
   * Parameter intervals (sorted, merged, within [0, 1]) of the plan segment a→b along which a
   * vertical surface spanning real heights [y0, y1] would stand inside walkable space.
   */
  blocked(ax: number, az: number, bx: number, bz: number, y0: number, y1: number, skip?: (p: WalkPiece) => boolean): [number, number][] {
    const dx = bx - ax;
    const dz = bz - az;
    const out: [number, number][] = [];
    for (const p of this.query(Math.min(ax, bx), Math.max(ax, bx), Math.min(az, bz), Math.max(az, bz))) {
      if (skip?.(p)) continue;
      const span = clipConvex(p.poly, ax, az, dx, dz, 0.03);
      if (!span) continue;
      let [ta, tb] = span;
      // Floor along the segment: F(t) = F0 + F1·t. Blocked where F < y1 and F + clear > y0.
      const F0 = p.f0 + p.fx * ax + p.fz * az;
      const F1 = p.fx * dx + p.fz * dz;
      const lim = (c: number, sign: 1 | -1) => {
        // sign = 1: need F(t) < c ; sign = -1: need F(t) > c.
        if (Math.abs(F1) < 1e-9) {
          if (sign * (F0 - c) >= 0) ta = 1;
          return;
        }
        const t = (c - F0) / F1;
        if (sign * F1 > 0) tb = Math.min(tb, t);
        else ta = Math.max(ta, t);
      };
      lim(y1 - 0.05, 1);
      lim(y0 + 0.05 - p.clear, -1);
      if (tb - ta > 1e-4) out.push([Math.max(0, ta), Math.min(1, tb)]);
    }
    out.sort((p, q) => p[0] - q[0]);
    const merged: [number, number][] = [];
    for (const iv of out) {
      const last = merged[merged.length - 1];
      if (last && iv[0] <= last[1] + 1e-4) last[1] = Math.max(last[1], iv[1]);
      else merged.push([iv[0], iv[1]]);
    }
    return merged;
  }

  /**
   * The complement of `blocked`: parts of a→b where a wall spanning [y0, y1] may stand, as
   * parameter intervals at least `minLen` metres long.
   */
  open(ax: number, az: number, bx: number, bz: number, y0: number, y1: number, skip?: (p: WalkPiece) => boolean, minLen = 0.2): [number, number][] {
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 1e-6) return [];
    const out: [number, number][] = [];
    let t = 0;
    for (const [s, e] of this.blocked(ax, az, bx, bz, y0, y1, skip)) {
      if ((s - t) * len >= minLen) out.push([t, s]);
      t = Math.max(t, e);
    }
    if ((1 - t) * len >= minLen) out.push([t, 1]);
    return out;
  }

  /**
   * Whether an axis-aligned box (real metres) reaches into walkable space. Floors of sloped
   * pieces are bounded by their values at the polygon's vertices.
   */
  intersectsBox(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, skip?: (p: WalkPiece) => boolean): boolean {
    for (const p of this.query(x0, x1, z0, z1)) {
      if (skip?.(p)) continue;
      if (!convexOverlapsRect(p.poly, x0 + 0.02, x1 - 0.02, z0 + 0.02, z1 - 0.02)) continue;
      let fmin = Infinity;
      let fmax = -Infinity;
      for (const [x, z] of p.poly) {
        const f = p.f0 + p.fx * x + p.fz * z;
        fmin = Math.min(fmin, f);
        fmax = Math.max(fmax, f);
      }
      if (y1 > fmin + 0.05 && y0 < fmax + p.clear - 0.05) return true;
    }
    return false;
  }

  /** The platform (id) whose slab carries a point at real height y, if any. */
  platformAt(x: number, z: number, y: number): string | null {
    for (const p of this.query(x, x, z, z)) {
      if (p.kind === 'platform' && Math.abs(p.f0 - y) < 0.6 && insideConvex(p.poly, x, z)) return p.id.slice('platform:'.length);
    }
    return null;
  }

  /** Highest walking surface at (x, z) with its floor within [y - below, y + above], or null. */
  floorAt(x: number, z: number, y: number, below = 1, above = 1): number | null {
    let best: number | null = null;
    for (const p of this.query(x, x, z, z)) {
      if (p.kind === 'shaft' || !insideConvex(p.poly, x, z)) continue;
      const f = p.f0 + p.fx * x + p.fz * z;
      if (f >= y - below && f <= y + above && (best === null || f > best)) best = f;
    }
    return best;
  }
}

/** Parameter range of a + t·d (t ∈ [0, 1]) strictly inside a CCW convex polygon (shrunk by eps). */
export function clipConvex(poly: [number, number][], ax: number, az: number, dx: number, dz: number, eps = 0): [number, number] | null {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < poly.length; i++) {
    const [px, pz] = poly[i];
    const [qx, qz] = poly[(i + 1) % poly.length];
    const ex = qx - px;
    const ez = qz - pz;
    const el = Math.hypot(ex, ez);
    if (el < 1e-9) continue;
    // Inward normal of a CCW polygon in (x, z): (-ez, ex) / |e|.
    const nx = -ez / el;
    const nz = ex / el;
    const num = nx * (ax - px) + nz * (az - pz) - eps;
    const den = nx * dx + nz * dz;
    if (Math.abs(den) < 1e-12) {
      if (num < 0) return null;
      continue;
    }
    const t = -num / den;
    if (den > 0) lo = Math.max(lo, t);
    else hi = Math.min(hi, t);
    if (lo >= hi) return null;
  }
  return [lo, hi];
}

export function insideConvex(poly: [number, number][], x: number, z: number): boolean {
  for (let i = 0; i < poly.length; i++) {
    const [px, pz] = poly[i];
    const [qx, qz] = poly[(i + 1) % poly.length];
    if ((qx - px) * (z - pz) - (qz - pz) * (x - px) < 0) return false;
  }
  return true;
}

/** Separating-axis test between a convex polygon and an axis-aligned rectangle. */
function convexOverlapsRect(poly: [number, number][], x0: number, x1: number, z0: number, z1: number): boolean {
  if (x1 <= x0 || z1 <= z0) return false;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of poly) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  if (maxX <= x0 || minX >= x1 || maxZ <= z0 || minZ >= z1) return false;
  const rect: [number, number][] = [
    [x0, z0],
    [x1, z0],
    [x1, z1],
    [x0, z1],
  ];
  for (let i = 0; i < poly.length; i++) {
    const [px, pz] = poly[i];
    const [qx, qz] = poly[(i + 1) % poly.length];
    const nx = -(qz - pz);
    const nz = qx - px;
    const d = nx * px + nz * pz;
    // Polygon is on the inner side (≥ d); the rectangle is separated if all its corners are below.
    if (rect.every(([x, z]) => nx * x + nz * z <= d)) return false;
  }
  return true;
}
