/**
 * Plan geometry for laying out stair / escalator / elevator bundles (pure, unit-tested).
 * Coordinates are local metres in plan (x = east, z = south).
 */

export interface P2 {
  x: number;
  z: number;
}

/** An oriented rectangle: centre c, unit axis u, half-lengths hu (along u) and hn (across). */
export interface ORect {
  c: P2;
  u: P2;
  hu: number;
  hn: number;
}

const cross = (ax: number, az: number, bx: number, bz: number) => ax * bz - az * bx;

/** Rectangle spanning s ∈ [s0, s1] along u and lateral ∈ [l0, l1] from origin o (n = u rotated +90°). */
export function rectFromFrame(o: P2, u: P2, s0: number, s1: number, l0: number, l1: number): ORect {
  const n = { x: -u.z, z: u.x };
  const sm = (s0 + s1) / 2;
  const lm = (l0 + l1) / 2;
  return { c: { x: o.x + u.x * sm + n.x * lm, z: o.z + u.z * sm + n.z * lm }, u, hu: Math.abs(s1 - s0) / 2, hn: Math.abs(l1 - l0) / 2 };
}

export function inflate(r: ORect, m: number): ORect {
  return { c: r.c, u: r.u, hu: r.hu + m, hn: r.hn + m };
}

export function corners(r: ORect): P2[] {
  const n = { x: -r.u.z, z: r.u.x };
  return [
    [1, 1],
    [-1, 1],
    [-1, -1],
    [1, -1],
  ].map(([a, b]) => ({ x: r.c.x + r.u.x * r.hu * a + n.x * r.hn * b, z: r.c.z + r.u.z * r.hu * a + n.z * r.hn * b }));
}

/** Local (s, t) coordinates of p relative to the rectangle centre. */
function local(r: ORect, p: P2): [number, number] {
  const dx = p.x - r.c.x;
  const dz = p.z - r.c.z;
  return [dx * r.u.x + dz * r.u.z, -dx * r.u.z + dz * r.u.x];
}

export function insideRect(r: ORect, p: P2, eps = 1e-6): boolean {
  const [s, t] = local(r, p);
  return Math.abs(s) < r.hu - eps && Math.abs(t) < r.hn - eps;
}

/** Whether segment a→b passes through the open interior of the rectangle (touching is fine). */
export function segmentHitsRect(r: ORect, a: P2, b: P2): boolean {
  const [s0, t0] = local(r, a);
  const [s1, t1] = local(r, b);
  // Liang–Barsky clip against the slightly shrunk box.
  const eps = 1e-4;
  let lo = 0;
  let hi = 1;
  const ds = s1 - s0;
  const dt = t1 - t0;
  const clip = (p: number, q: number) => {
    if (Math.abs(p) < 1e-12) return q >= 0;
    const r_ = q / p;
    if (p < 0) {
      if (r_ > hi) return false;
      if (r_ > lo) lo = r_;
    } else {
      if (r_ < lo) return false;
      if (r_ < hi) hi = r_;
    }
    return true;
  };
  const hu = r.hu - eps;
  const hn = r.hn - eps;
  if (hu <= 0 || hn <= 0) return false;
  if (!clip(-ds, s0 + hu) || !clip(ds, hu - s0) || !clip(-dt, t0 + hn) || !clip(dt, hn - t0)) return false;
  return hi - lo > 1e-6;
}

/**
 * Shortest plan path from a to b avoiding the rectangles (visibility graph over the corners of
 * the rectangles inflated by `margin`). Returns the intermediate corner points only; [] when the
 * straight line is clear or no detour exists.
 */
export function detour(a: P2, b: P2, obstacles: ORect[], margin = 0.6): P2[] {
  const blocked = (p: P2, q: P2) => obstacles.some((r) => segmentHitsRect(r, p, q));
  if (!blocked(a, b)) return [];
  const pts: P2[] = [a, b];
  for (const r of obstacles) for (const c of corners(inflate(r, margin))) if (!obstacles.some((o) => insideRect(o, c))) pts.push(c);
  const n = pts.length;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  dist[0] = 0;
  for (;;) {
    let u = -1;
    for (let i = 0; i < n; i++) if (!done[i] && (u < 0 || dist[i] < dist[u])) u = i;
    if (u < 0 || dist[u] === Infinity || u === 1) break;
    done[u] = 1;
    for (let v = 0; v < n; v++) {
      if (done[v] || v === u) continue;
      const d = dist[u] + Math.hypot(pts[v].x - pts[u].x, pts[v].z - pts[u].z);
      if (d < dist[v] && !blocked(pts[u], pts[v])) {
        dist[v] = d;
        prev[v] = u;
      }
    }
  }
  if (!Number.isFinite(dist[1])) return [];
  const out: P2[] = [];
  for (let v = prev[1]; v > 0; v = prev[v]) out.unshift(pts[v]);
  return out;
}

/** Signed lateral offset of p from the line through o along u (positive towards n = u rotated +90°). */
export function lateralOf(o: P2, u: P2, p: P2): number {
  return cross(u.x, u.z, p.x - o.x, p.z - o.z);
}

/** Distance along u of p from o. */
export function alongOf(o: P2, u: P2, p: P2): number {
  return (p.x - o.x) * u.x + (p.z - o.z) * u.z;
}

/** Separating-axis overlap test of two oriented rectangles (touching does not count). */
export function rectsOverlap(a: ORect, b: ORect): boolean {
  const axes = [a.u, { x: -a.u.z, z: a.u.x }, b.u, { x: -b.u.z, z: b.u.x }];
  const ca = corners(a);
  const cb = corners(b);
  for (const ax of axes) {
    const pa = ca.map((p) => p.x * ax.x + p.z * ax.z);
    const pb = cb.map((p) => p.x * ax.x + p.z * ax.z);
    if (Math.max(...pa) <= Math.min(...pb) + 1e-6 || Math.max(...pb) <= Math.min(...pa) + 1e-6) return false;
  }
  return true;
}
