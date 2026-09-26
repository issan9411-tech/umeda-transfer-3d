import type { Graph } from '../core/graph';
import type { Line, NetEdge, NetNode, Station } from '../core/types';

/**
 * Pure helpers behind the walk-through interiors (no three.js, no DOM), kept separate so the
 * layout rules can be unit-tested: corridor mouths at junctions, lanes of stair/escalator
 * bundles, elevator cabin motion, which corridors are shopping malls and what the hanging
 * wayfinding signs say.
 */

/** Shortest signed angle from a to b. */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * Length-weighted dominant direction of a set of segments modulo 90° (radians). Floor tile
 * grids are laid along it so most corridors run parallel to their joints.
 */
export function dominantAngle(segs: { dx: number; dz: number }[]): number {
  let c = 0;
  let s = 0;
  for (const { dx, dz } of segs) {
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) continue;
    // ×4 folds the four grid directions onto one before averaging on the circle.
    const a = Math.atan2(dz, dx) * 4;
    c += Math.cos(a) * len;
    s += Math.sin(a) * len;
  }
  if (Math.abs(c) + Math.abs(s) < 1e-9) return 0;
  return Math.atan2(s, c) / 4;
}

export interface Arm {
  /** Direction away from the junction, atan2(dz, dx). */
  angle: number;
  width: number;
}

/**
 * Distance each corridor stops short of a junction so its side walls do not cut through the
 * neighbouring corridor's mouth: where the near sides of two arms meet, clamped to `cap`.
 * Nearly straight continuations (> 150° apart) need no trim.
 */
export function mouthTrims(arms: Arm[], cap: number): number[] {
  return arms.map((a, i) => {
    let t = 0;
    arms.forEach((b, j) => {
      if (i === j) return;
      const phi = Math.abs(angleDelta(a.angle, b.angle));
      if (phi > (150 * Math.PI) / 180) return;
      const p = Math.max(phi, 0.2);
      t = Math.max(t, (b.width / 2 + (a.width / 2) * Math.cos(p)) / Math.sin(p));
    });
    return Math.min(cap, Math.max(0, t));
  });
}

/**
 * Lateral offsets for side-by-side stairs / escalators / elevators between the same landings.
 * The lane at index `center` (the one the walker uses) sits on the node-to-node line, since the
 * walker is animated along that line; the others are packed alternately right and left of it.
 */
export function laneOffsets(widths: number[], center: number, gap = 0.8): number[] {
  const out = widths.map(() => 0);
  if (widths.length === 0) return out;
  const c = Math.min(Math.max(0, center), widths.length - 1);
  let right = widths[c] / 2;
  let left = widths[c] / 2;
  let side = 1;
  for (let i = 0; i < widths.length; i++) {
    if (i === c) continue;
    const w = widths[i];
    if (side > 0) {
      out[i] = right + gap + w / 2;
      right += gap + w;
    } else {
      out[i] = -(left + gap + w / 2);
      left += gap + w;
    }
    side = -side;
  }
  return out;
}

/**
 * Elevator cabin height as a fraction 0 (bottom) … 1 (top) at time t: waits `dwell` seconds at
 * each landing and travels in `travel` seconds with eased acceleration.
 */
export function cabinCycle(t: number, travel: number, dwell: number): number {
  const period = 2 * (travel + dwell);
  let u = t % period;
  if (u < 0) u += period;
  const ease = (x: number) => x * x * (3 - 2 * x);
  if (u < dwell) return 0;
  u -= dwell;
  if (u < travel) return ease(u / travel);
  u -= travel;
  if (u < dwell) return 1;
  u -= dwell;
  return 1 - ease(Math.min(1, u / travel));
}

/** Deterministic 0…1 hash of a string and an integer (shop variants, sign picks). */
export function hash01(s: string, k = 0): number {
  let h = 2166136261 ^ k;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

const MALL_RE = /ホワイティ|ディアモール|三番街|ルクア|駅前ビル|梅田地下街|グランフロント|KITTE|エキマルシェ|阪神梅田本店|大丸|イノゲート|バルチカ|17番街/;

/** Covered free walkways lined with shops (Umeda's underground malls and station arcades). */
export function isMallEdge(e: NetEdge, a: NetNode, b: NetNode): boolean {
  if (!e.indoor || e.kind !== 'walk' || a.paid || b.paid) return false;
  if (e.name) return MALL_RE.test(e.name);
  // Unnamed links between two mall junctions.
  return a.y < -1 && b.y < -1 && MALL_RE.test(a.name) && MALL_RE.test(b.name);
}

/** Text used for a station on wayfinding signs: 「地下鉄 御堂筋線」「JR線」「阪急線」… */
export function signLabel(s: Station, lines: Line[]): string {
  const ls = s.lineIds.map((id) => lines.find((l) => l.id === id)).filter((l): l is Line => !!l);
  if (s.operator.includes('Metro') && ls[0]) return `地下鉄 ${ls[0].nameJa}`;
  if (ls.length === 1) return ls[0].nameJa;
  return `${s.badge}線`;
}

export interface SignTarget {
  kind: 'station' | 'exit';
  /** Station id (for colour and badge) or '' for exits. */
  id: string;
  text: string;
  /** Walking distance from the junction, m. */
  dist: number;
}

/**
 * What lies down one corridor of a junction: the nearest station gates and street exits
 * reached through `first` without passing back through `junction` (Dijkstra on horizontal
 * length, limited to `maxDist`). Up to `limit` targets, nearest first, one per station.
 */
export function destinationsVia(g: Graph, junction: number, first: number, firstDist: number, maxDist = 260, limit = 2): SignTarget[] {
  const dist = new Map<number, number>([[first, firstDist]]);
  const done = new Set<number>([junction]);
  const out: SignTarget[] = [];
  const seen = new Set<string>();
  const lines = g.net.lines;
  const startPaid = !!g.nodes[first].paid;
  for (;;) {
    let best = -1;
    let bd = Infinity;
    for (const [n, d] of dist) {
      if (!done.has(n) && d < bd) {
        bd = d;
        best = n;
      }
    }
    if (best < 0 || bd > maxDist) break;
    done.add(best);
    const n = g.nodes[best];
    if (n.kind === 'gate' && n.stationId && !seen.has(n.stationId)) {
      const s = g.net.stations.find((x) => x.id === n.stationId);
      if (s) {
        seen.add(s.id);
        out.push({ kind: 'station', id: s.id, text: signLabel(s, lines), dist: bd });
      }
    } else if (n.kind === 'entrance' && !seen.has(`exit:${n.name}`)) {
      seen.add(`exit:${n.name}`);
      out.push({ kind: 'exit', id: '', text: n.name, dist: bd });
    } else if (n.y < -1 && n.y > -8 && !seen.has('exit:地上') && g.adj[best].some((a) => g.nodes[a.to].y >= 0 && isVertical(g.edges[a.edge]))) {
      // A way up to the street from the underground.
      seen.add('exit:地上');
      out.push({ kind: 'exit', id: '', text: '地上出口', dist: bd });
    }
    if (out.length >= limit) break;
    // A gate is a destination, not a way through: free-side signs do not look into paid areas.
    if (n.kind === 'gate' && n.paid && !startPaid) continue;
    for (const arc of g.adj[best]) {
      if (done.has(arc.to)) continue;
      const e = g.edges[arc.edge];
      if (e.kind === 'platform' || (g.nodes[arc.to].paid && !n.paid && e.kind !== 'gate')) continue;
      const nd = bd + g.hlen[arc.edge] + Math.abs(g.rise[arc.edge]) * 3;
      if (nd < (dist.get(arc.to) ?? Infinity)) dist.set(arc.to, nd);
    }
  }
  return out;
}

export function isVertical(e: NetEdge): boolean {
  return e.kind === 'stairs' || e.kind === 'escalator' || e.kind === 'elevator';
}

/** Arrow for a sign: 0 = ahead, ±1 = right/left, 2 = behind (relative to the reader's heading). */
export function arrowFor(heading: number, target: number): -1 | 0 | 1 | 2 {
  const d = angleDelta(heading, target);
  if (Math.abs(d) < Math.PI / 5) return 0;
  if (Math.abs(d) > (Math.PI * 4) / 5) return 2;
  // Angles are atan2(dz, dx) with z pointing south: a positive delta turns clockwise (right).
  return d > 0 ? 1 : -1;
}

export type P2 = [number, number];

/** Sutherland–Hodgman step: the part of a convex polygon where nx·x + nz·z ≤ d. */
export function clipHalfPlane(poly: P2[], nx: number, nz: number, d: number): P2[] {
  const out: P2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const da = nx * a[0] + nz * a[1] - d;
    const db = nx * b[0] + nz * b[1] - d;
    if (da <= 0) out.push(a);
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
      const t = da / (da - db);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

export function polyArea(poly: P2[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(s) / 2;
}

/**
 * A convex polygon minus a convex hole, as convex pieces (one per hole edge the polygon
 * extends beyond). Used to open stair wells in the floors above them.
 */
export function subtractConvex(poly: P2[], hole: P2[]): P2[][] {
  let cx = 0;
  let cz = 0;
  for (const p of hole) {
    cx += p[0] / hole.length;
    cz += p[1] / hole.length;
  }
  const pieces: P2[][] = [];
  let rest = poly;
  for (let i = 0; i < hole.length && rest.length >= 3; i++) {
    const a = hole[i];
    const b = hole[(i + 1) % hole.length];
    // Outward normal of this hole edge.
    let nx = b[1] - a[1];
    let nz = a[0] - b[0];
    if (nx * (cx - a[0]) + nz * (cz - a[1]) > 0) {
      nx = -nx;
      nz = -nz;
    }
    const d = nx * a[0] + nz * a[1];
    const outside = clipHalfPlane(rest, -nx, -nz, -d);
    if (outside.length >= 3 && polyArea(outside) > 1e-4) pieces.push(outside);
    rest = clipHalfPlane(rest, nx, nz, d);
  }
  // Whatever is left lies inside the hole and is dropped.
  return pieces;
}
