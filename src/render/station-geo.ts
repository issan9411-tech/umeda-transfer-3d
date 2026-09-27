import * as THREE from 'three';

/**
 * Small geometry kit for the station and train builders: a growable triangle soup with
 * normals, colours and (optionally) UVs, plus the plan-view helpers (platform frames and
 * rectangles with holes) the station layout is built from. Pure maths, no DOM.
 */

export type V3 = [number, number, number];

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Growable triangle soup. Faces are counter-clockwise seen from the side they face. */
export class Mesher {
  readonly pos: number[] = [];
  readonly nor: number[] = [];
  readonly col: number[] = [];
  readonly uv: number[] = [];

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  private vert(p: V3, n: V3, c: THREE.Color, u = 0, v = 0): void {
    this.pos.push(p[0], p[1], p[2]);
    this.nor.push(n[0], n[1], n[2]);
    this.col.push(c.r, c.g, c.b);
    this.uv.push(u, v);
  }

  /** Triangle with explicit per-vertex normals (for smooth shells) and optional UVs. */
  triN(a: V3, b: V3, c: V3, na: V3, nb: V3, nc: V3, color: THREE.Color, uv?: number[]): void {
    this.vert(a, na, color, uv?.[0], uv?.[1]);
    this.vert(b, nb, color, uv?.[2], uv?.[3]);
    this.vert(c, nc, color, uv?.[4], uv?.[5]);
  }

  /**
   * Flat quad p0→p1→p2→p3; uv = [u0,v0,u1,v1,u2,v2,u3,v3]. `normal` overrides the shading
   * normal (not the facing): ceilings use an upward normal so they read as lit from below.
   */
  quad(p0: V3, p1: V3, p2: V3, p3: V3, color: THREE.Color, uv?: number[], normal?: V3): void {
    const n = normal ?? norm(cross(sub(p1, p0), sub(p2, p0)));
    const u = uv ?? [0, 0, 1, 0, 1, 1, 0, 1];
    this.vert(p0, n, color, u[0], u[1]);
    this.vert(p1, n, color, u[2], u[3]);
    this.vert(p2, n, color, u[4], u[5]);
    this.vert(p0, n, color, u[0], u[1]);
    this.vert(p2, n, color, u[4], u[5]);
    this.vert(p3, n, color, u[6], u[7]);
  }

  /**
   * Box around centre c with orthonormal axes e1 (length l), e2 (height h), e3 = e1 × e2 (width w).
   * `skip` omits faces by index: 0 +e1, 1 −e1, 2 +e2 (top), 3 −e2 (bottom), 4 +e3, 5 −e3.
   */
  box(c: V3, e1: V3, e2: V3, l: number, h: number, w: number, color: THREE.Color, skip = 0): void {
    const e3 = cross(e1, e2);
    const P = (s1: number, s2: number, s3: number): V3 => [
      c[0] + e1[0] * s1 * l * 0.5 + e2[0] * s2 * h * 0.5 + e3[0] * s3 * w * 0.5,
      c[1] + e1[1] * s1 * l * 0.5 + e2[1] * s2 * h * 0.5 + e3[1] * s3 * w * 0.5,
      c[2] + e1[2] * s1 * l * 0.5 + e2[2] * s2 * h * 0.5 + e3[2] * s3 * w * 0.5,
    ];
    const faces: [V3, V3, V3, V3][] = [
      [P(1, -1, 1), P(1, -1, -1), P(1, 1, -1), P(1, 1, 1)],
      [P(-1, -1, -1), P(-1, -1, 1), P(-1, 1, 1), P(-1, 1, -1)],
      [P(-1, 1, 1), P(1, 1, 1), P(1, 1, -1), P(-1, 1, -1)],
      [P(-1, -1, -1), P(1, -1, -1), P(1, -1, 1), P(-1, -1, 1)],
      [P(-1, -1, 1), P(1, -1, 1), P(1, 1, 1), P(-1, 1, 1)],
      [P(1, -1, -1), P(-1, -1, -1), P(-1, 1, -1), P(1, 1, -1)],
    ];
    faces.forEach((f, i) => {
      if (!(skip & (1 << i))) this.quad(f[0], f[1], f[2], f[3], color);
    });
  }

  /** Axis-aligned box from min/max corners. */
  aabb(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color: THREE.Color, skip = 0): void {
    this.box([(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], [1, 0, 0], [0, 1, 0], x1 - x0, y1 - y0, z1 - z0, color, skip);
  }

  /** Box spanning segment a→b (any direction) with a square-ish cross-section w × h. */
  beam(a: V3, b: V3, w: number, h: number, color: THREE.Color): void {
    const d = sub(b, a);
    const len = Math.hypot(d[0], d[1], d[2]);
    if (len < 1e-4) return;
    const e1 = norm(d);
    // Any vector not parallel to e1 gives the second axis.
    const ref: V3 = Math.abs(e1[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
    const e3 = norm(cross(e1, ref));
    const e2 = cross(e3, e1);
    this.box([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], e1, e2, len, h, w, color);
  }

  /** Closed n-gon prism (cylinder) of radius r from a to b; smooth sides, flat caps. */
  prism(a: V3, b: V3, r: number, sides: number, color: THREE.Color, caps = true): void {
    const e1 = norm(sub(b, a));
    const ref: V3 = Math.abs(e1[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
    const u = norm(cross(e1, ref));
    const v = cross(e1, u);
    const ring = (o: V3, k: number): { p: V3; n: V3 } => {
      const t = (k / sides) * Math.PI * 2;
      const n: V3 = [u[0] * Math.cos(t) + v[0] * Math.sin(t), u[1] * Math.cos(t) + v[1] * Math.sin(t), u[2] * Math.cos(t) + v[2] * Math.sin(t)];
      return { p: [o[0] + n[0] * r, o[1] + n[1] * r, o[2] + n[2] * r], n };
    };
    for (let k = 0; k < sides; k++) {
      const a0 = ring(a, k);
      const a1 = ring(a, k + 1);
      const b0 = ring(b, k);
      const b1 = ring(b, k + 1);
      this.triN(a0.p, a1.p, b1.p, a0.n, a1.n, b1.n, color);
      this.triN(a0.p, b1.p, b0.p, a0.n, b1.n, b0.n, color);
      if (caps) {
        const na: V3 = [-e1[0], -e1[1], -e1[2]];
        this.triN(a, a1.p, a0.p, na, na, na, color);
        this.triN(b, b0.p, b1.p, e1, e1, e1, color);
      }
    }
  }

  /** Appends another soup (same attribute layout). */
  append(o: Mesher): void {
    for (const k of ['pos', 'nor', 'col', 'uv'] as const) {
      const src = o[k];
      const dst = this[k];
      for (let i = 0; i < src.length; i++) dst.push(src[i]);
    }
  }

  geometry(attrs: { color?: boolean; uv?: boolean } = { color: true }): THREE.BufferGeometry | null {
    if (this.pos.length === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    if (attrs.color) g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    if (attrs.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.computeBoundingSphere();
    return g;
  }
}

/** Collects thin line segments (wires, mullions) for one LineSegments draw call. */
export class Lines {
  readonly pos: number[] = [];

  seg(a: V3, b: V3): void {
    this.pos.push(a[0], a[1], a[2], b[0], b[1], b[2]);
  }

  geometry(): THREE.BufferGeometry | null {
    if (this.pos.length === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.computeBoundingSphere();
    return g;
  }
}

// ------------------------------------------------------------------------------------------------
// Plan-view frames

/**
 * A platform-aligned plan frame: s runs along the tracks (from the reference platform's `a` end),
 * t runs to the LEFT of the direction of travel (matching walkway.ts's `left` normal).
 */
export interface Frame {
  ox: number;
  oz: number;
  dx: number;
  dz: number;
}

export function frameOf(a: [number, number], b: [number, number]): Frame {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const l = Math.hypot(dx, dz) || 1;
  return { ox: a[0], oz: a[1], dx: dx / l, dz: dz / l };
}

/** Local (s, t) → world (x, z). Left normal is (dz, −dx). */
export function toWorld(f: Frame, s: number, t: number): [number, number] {
  return [f.ox + f.dx * s + f.dz * t, f.oz + f.dz * s - f.dx * t];
}

/** World (x, z) → local (s, t). */
export function toLocal(f: Frame, x: number, z: number): [number, number] {
  const rx = x - f.ox;
  const rz = z - f.oz;
  return [rx * f.dx + rz * f.dz, rx * f.dz - rz * f.dx];
}

/** World point from local (s, t) at scene height y. */
export function P(f: Frame, s: number, y: number, t: number): V3 {
  const [x, z] = toWorld(f, s, t);
  return [x, y, z];
}

/** Axis-aligned rectangle in a frame's (s, t) coordinates. */
export interface Rect {
  s0: number;
  s1: number;
  t0: number;
  t1: number;
}

/**
 * The part of `outer` not covered by `holes`, as disjoint rectangles. Holes are clipped to the
 * outer rectangle and may overlap each other. Sweeps bands between hole edges across t and merges
 * identical s-runs of consecutive bands, so a slab with k holes costs O(k²) rectangles at worst.
 */
export function rectMinusHoles(outer: Rect, holes: Rect[]): Rect[] {
  const hs = holes
    .map((h) => ({ s0: Math.max(h.s0, outer.s0), s1: Math.min(h.s1, outer.s1), t0: Math.max(h.t0, outer.t0), t1: Math.min(h.t1, outer.t1) }))
    .filter((h) => h.s1 - h.s0 > 1e-6 && h.t1 - h.t0 > 1e-6);
  if (outer.s1 <= outer.s0 || outer.t1 <= outer.t0) return [];
  if (hs.length === 0) return [{ ...outer }];
  const ts = [...new Set([outer.t0, outer.t1, ...hs.flatMap((h) => [h.t0, h.t1])])].sort((a, b) => a - b);
  const out: Rect[] = [];
  let open = new Map<string, Rect>();
  for (let i = 0; i < ts.length - 1; i++) {
    const t0 = ts[i];
    const t1 = ts[i + 1];
    if (t1 - t0 < 1e-6) continue;
    const act = hs.filter((h) => h.t0 <= t0 + 1e-9 && h.t1 >= t1 - 1e-9).sort((a, b) => a.s0 - b.s0);
    const runs: [number, number][] = [];
    let s = outer.s0;
    for (const h of act) {
      if (h.s0 > s + 1e-6) runs.push([s, h.s0]);
      s = Math.max(s, h.s1);
    }
    if (outer.s1 > s + 1e-6) runs.push([s, outer.s1]);
    const next = new Map<string, Rect>();
    for (const [a, b] of runs) {
      const key = `${a.toFixed(4)}|${b.toFixed(4)}`;
      const prev = open.get(key);
      if (prev) {
        prev.t1 = t1;
        next.set(key, prev);
        open.delete(key);
      } else next.set(key, { s0: a, s1: b, t0, t1 });
    }
    for (const r of open.values()) out.push(r);
    open = next;
  }
  for (const r of open.values()) out.push(r);
  return out;
}

/**
 * Convex polygon (s, t) clipped to a rectangle (Sutherland–Hodgman against its four sides);
 * either winding. Returns [] when they do not overlap in a region of positive area.
 */
export function clipToRect(poly: [number, number][], r: Rect): [number, number][] {
  let pts = poly;
  const sides: [0 | 1, number, 1 | -1][] = [
    [0, r.s0, 1],
    [0, r.s1, -1],
    [1, r.t0, 1],
    [1, r.t1, -1],
  ];
  for (const [k, v, sg] of sides) {
    const out: [number, number][] = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const q = pts[(i + 1) % pts.length];
      const dp = (p[k] - v) * sg;
      const dq = (q[k] - v) * sg;
      if (dp >= 0) out.push(p);
      if (dp * dq < 0) {
        const u = dp / (dp - dq);
        out.push([p[0] + (q[0] - p[0]) * u, p[1] + (q[1] - p[1]) * u]);
      }
    }
    pts = out;
    if (pts.length < 3) return [];
  }
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const [s0, t0] = pts[i];
    const [s1, t1] = pts[(i + 1) % pts.length];
    area += s0 * t1 - s1 * t0;
  }
  return Math.abs(area) > 1e-6 ? pts : [];
}

/** Area of a rectangle list (tests / sanity checks). */
export function rectArea(rs: Rect[]): number {
  return rs.reduce((a, r) => a + (r.s1 - r.s0) * (r.t1 - r.t0), 0);
}

/** The parts of [a, b] not covered by the intervals, each at least minLen long. */
export function gaps(a: number, b: number, covered: [number, number][], minLen = 0): [number, number][] {
  const iv = covered.filter(([x, y]) => y > a && x < b).sort((p, q) => p[0] - q[0]);
  const out: [number, number][] = [];
  let u = a;
  for (const [x, y] of iv) {
    if (x - u >= minLen && x > u) out.push([u, Math.min(x, b)]);
    u = Math.max(u, y);
    if (u >= b) break;
  }
  if (b - u >= minLen && b > u) out.push([u, b]);
  return out;
}

/** Deterministic 0…1 hash of a string (stable train placement without Math.random). */
export function hash01(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
