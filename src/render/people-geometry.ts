import * as THREE from 'three';
import { BODY } from './people-rig';

/**
 * Low-poly body parts for the pedestrians, built in code (no assets). Every part is authored
 * in its bone's frame (see people-rig.ts: +y up, +z forward, +x = the person's left), limbs
 * hanging along −y from the joint, so one InstancedMesh per part can be driven by the rig.
 */

export type Detail = 'low' | 'high' | 'hero';

export type PartId =
  | 'head'
  | 'hairShort'
  | 'hairLong'
  | 'hairBun'
  | 'cap'
  | 'torso'
  | 'torsoF'
  | 'shirt'
  | 'pelvis'
  | 'skirt'
  | 'thigh'
  | 'shin'
  | 'shoe'
  | 'upperArm'
  | 'forearm'
  | 'hand'
  | 'box'
  | 'suitcase'
  | 'shadow';

/**
 * Per detail level: ring vertex counts and which loft sections to keep (indices into the shape
 * tables below; null = all). Budgets: low ≈ 250 triangles per figure (the whole overview crowd),
 * high ≈ 950 (the nearest few hundred while walking), hero unconstrained.
 */
interface Segs {
  torso: number;
  limb: number;
  hand: number;
  shoe: number;
  headW: number;
  headH: number;
  /** Rotate rings half a step so 4-sided rings are boxes, not diamonds. */
  offset: boolean;
  face: boolean;
  ears: boolean;
  pick: Record<'torso' | 'pelvis' | 'thigh' | 'shin' | 'upperArm' | 'forearm' | 'hand' | 'shoe' | 'skirt', number[] | null>;
}

const SEGS: Record<Detail, Segs> = {
  low: {
    torso: 4,
    limb: 4,
    hand: 4,
    shoe: 4,
    headW: 6,
    headH: 3,
    offset: true,
    face: false,
    ears: false,
    pick: { torso: [0, 3, 5, 8], pelvis: [0, 2, 4], thigh: [1, 4], shin: [1, 4], upperArm: [1, 3], forearm: [1, 3], hand: [0, 3], shoe: [1, 5], skirt: [0, 3] },
  },
  high: {
    torso: 8,
    limb: 6,
    hand: 5,
    shoe: 6,
    headW: 10,
    headH: 6,
    offset: false,
    face: true,
    ears: false,
    pick: { torso: [0, 2, 3, 5, 6, 8], pelvis: [0, 1, 2, 4], thigh: [1, 2, 4, 5], shin: [1, 2, 4, 5], upperArm: [0, 1, 3, 4], forearm: [1, 2, 3, 4], hand: [0, 2, 4], shoe: [0, 2, 3, 5, 6], skirt: null },
  },
  hero: {
    torso: 18,
    limb: 12,
    hand: 8,
    shoe: 12,
    headW: 22,
    headH: 16,
    offset: false,
    face: true,
    ears: true,
    pick: { torso: null, pelvis: null, thigh: null, shin: null, upperArm: null, forearm: null, hand: null, shoe: null, skirt: null },
  },
};

const pick = (secs: Section[], idx: number[] | null): Section[] => (idx ? idx.map((i) => secs[i]) : secs);

/** One loft cross-section: axial position, two half-extents, two centre offsets. */
type Section = [number, number, number, number?, number?];

/** Indexed triangle soup with optional per-vertex colour. */
class Mesher {
  private pos: number[] = [];
  private col: number[] = [];
  private idx: number[] = [];
  color: [number, number, number] = [1, 1, 1];

  vert(x: number, y: number, z: number): number {
    this.pos.push(x, y, z);
    this.col.push(...this.color);
    return this.pos.length / 3 - 1;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  /**
   * Superellipse loft along y (rings in x–z), z (rings in x–y) or x (rings in y–z), with
   * optional end caps. Outward winding for sections sorted by axial position.
   */
  loft(sections: Section[], axis: 'x' | 'y' | 'z', radial: number, power = 2, capLo = true, capHi = true, offset = false): void {
    const secs = [...sections].sort((a, b) => a[0] - b[0]);
    const e = 2 / power;
    const rings: number[][] = [];
    for (const [t, a, b, c1 = 0, c2 = 0] of secs) {
      const ring: number[] = [];
      for (let j = 0; j < radial; j++) {
        const th = ((j + (offset ? 0.5 : 0)) / radial) * Math.PI * 2;
        const cs = Math.cos(th);
        const sn = Math.sin(th);
        const u = c1 + a * Math.sign(cs) * Math.abs(cs) ** e;
        const v = c2 + b * Math.sign(sn) * Math.abs(sn) ** e;
        ring.push(axis === 'y' ? this.vert(u, t, v) : axis === 'z' ? this.vert(u, v, t) : this.vert(t, u, v));
      }
      rings.push(ring);
    }
    const flip = axis !== 'y';
    for (let k = 0; k + 1 < rings.length; k++) {
      for (let j = 0; j < radial; j++) {
        const j1 = (j + 1) % radial;
        const a = rings[k][j];
        const b = rings[k + 1][j];
        const c = rings[k][j1];
        const d = rings[k + 1][j1];
        if (flip) {
          this.tri(a, c, b);
          this.tri(c, d, b);
        } else {
          this.tri(a, b, c);
          this.tri(c, b, d);
        }
      }
    }
    const cap = (k: number, lo: boolean) => {
      const [t, , , c1 = 0, c2 = 0] = secs[k];
      const m = axis === 'y' ? this.vert(c1, t, c2) : axis === 'z' ? this.vert(c1, c2, t) : this.vert(t, c1, c2);
      for (let j = 0; j < radial; j++) {
        const j1 = (j + 1) % radial;
        if (lo !== flip) this.tri(m, rings[k][j], rings[k][j1]);
        else this.tri(m, rings[k][j1], rings[k][j]);
      }
    };
    if (capLo) cap(0, true);
    if (capHi) cap(secs.length - 1, false);
  }

  /**
   * Lat-long shell around (cx, cy, cz). `bottom(theta)` is the polar extent per longitude
   * (π = closed sphere); beyond the equator the shell hangs straight down (long hair).
   * theta = 0 faces +z. `deform` may reshape each point in place.
   */
  shell(
    c: [number, number, number],
    r: [number, number, number],
    w: number,
    h: number,
    bottom: (theta: number) => number,
    deform?: (p: THREE.Vector3, polar: number) => void,
  ): void {
    const closed = bottom(0) >= Math.PI - 1e-6 && bottom(Math.PI) >= Math.PI - 1e-6;
    const p = new THREE.Vector3();
    const top = this.vert(c[0], c[1] + r[1], c[2]);
    const rows: number[][] = [];
    const lastRow = closed ? h - 1 : h;
    for (let i = 1; i <= lastRow; i++) {
      const row: number[] = [];
      for (let j = 0; j < w; j++) {
        const th = (j / w) * Math.PI * 2;
        const s = (i / h) * bottom(th);
        if (s <= Math.PI / 2 || closed) {
          p.set(r[0] * Math.sin(s) * Math.sin(th), r[1] * Math.cos(s), r[2] * Math.sin(s) * Math.cos(th));
        } else {
          // Hanging part: keep the equator's footprint, drop vertically.
          p.set(r[0] * 0.97 * Math.sin(th), -(s - Math.PI / 2) * r[1], r[2] * 0.97 * Math.cos(th));
        }
        deform?.(p, s);
        row.push(this.vert(c[0] + p.x, c[1] + p.y, c[2] + p.z));
      }
      rows.push(row);
    }
    for (let j = 0; j < w; j++) this.tri(top, rows[0][j], rows[0][(j + 1) % w]);
    for (let i = 0; i + 1 < rows.length; i++) {
      for (let j = 0; j < w; j++) {
        const j1 = (j + 1) % w;
        this.tri(rows[i][j], rows[i + 1][j], rows[i][j1]);
        this.tri(rows[i][j1], rows[i + 1][j], rows[i + 1][j1]);
      }
    }
    if (closed) {
      const bot = this.vert(c[0], c[1] - r[1], c[2]);
      const last = rows[rows.length - 1];
      for (let j = 0; j < w; j++) this.tri(last[j], bot, last[(j + 1) % w]);
    }
  }

  /** Axis-aligned box with its own (flat-shaded) vertices per face. */
  box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number): void {
    const g = new THREE.BoxGeometry(sx, sy, sz);
    const pa = g.getAttribute('position');
    const base = this.pos.length / 3;
    for (let i = 0; i < pa.count; i++) this.vert(cx + pa.getX(i), cy + pa.getY(i), cz + pa.getZ(i));
    const ix = g.getIndex() as THREE.BufferAttribute;
    for (let i = 0; i < ix.count; i += 3) this.tri(base + ix.getX(i), base + ix.getX(i + 1), base + ix.getX(i + 2));
    g.dispose();
  }

  build(withColor = false): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    if (withColor) g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

// ---------------------------------------------------------------- body shape tables (metres)

/** Torso from the waist (y = 0) to the neck base: [y, half width, half depth, x, z]. */
const TORSO: Section[] = [
  [-0.06, 0.156, 0.108, 0, -0.004],
  [-0.03, 0.155, 0.106, 0, -0.002],
  [0.08, 0.152, 0.102, 0, 0.004],
  [0.2, 0.168, 0.112, 0, 0.012],
  [0.31, 0.182, 0.112, 0, 0.012],
  [0.38, 0.19, 0.1, 0, 0.004],
  [0.425, 0.168, 0.085, 0, -0.004],
  [0.45, 0.115, 0.068, 0, -0.006],
  [0.466, 0.058, 0.05, 0, -0.006],
];

/** Women's cut: narrower shoulders and waist, the same hem over the hips. */
const TORSO_F: Section[] = [
  [-0.06, 0.154, 0.106, 0, -0.004],
  [-0.03, 0.152, 0.104, 0, -0.002],
  [0.08, 0.136, 0.094, 0, 0.004],
  [0.2, 0.152, 0.11, 0, 0.014],
  [0.31, 0.162, 0.106, 0, 0.012],
  [0.38, 0.17, 0.094, 0, 0.004],
  [0.425, 0.15, 0.08, 0, -0.004],
  [0.45, 0.104, 0.064, 0, -0.006],
  [0.466, 0.054, 0.048, 0, -0.006],
];

/** Front surface of the torso (z) at height y, for things worn on the chest. */
function torsoFront(y: number): number {
  for (let i = 0; i + 1 < TORSO.length; i++) {
    const [y0, , d0, , z0 = 0] = TORSO[i];
    const [y1, , d1, , z1 = 0] = TORSO[i + 1];
    if (y >= y0 && y <= y1) {
      const f = (y - y0) / (y1 - y0);
      return z0 + d0 + (z1 + d1 - z0 - d0) * f;
    }
  }
  return 0.1;
}

const PELVIS: Section[] = [
  [-0.105, 0.1, 0.07, 0, -0.012],
  [-0.085, 0.135, 0.095, 0, -0.012],
  [-0.02, 0.158, 0.108, 0, -0.012],
  [0.05, 0.14, 0.094, 0, -0.006],
  [0.1, 0.126, 0.086, 0, -0.004],
];

const THIGH: Section[] = [
  [0.06, 0.07, 0.074, 0, 0],
  [0, 0.082, 0.085, 0, 0.004],
  [-0.12, 0.078, 0.08, 0, 0.008],
  [-0.3, 0.062, 0.064, 0, 0.004],
  [-0.42, 0.052, 0.056, 0, 0],
  [-0.45, 0.038, 0.04, 0, -0.004],
];

const SHIN: Section[] = [
  [0.03, 0.045, 0.048, 0, 0],
  [0, 0.053, 0.056, 0, 0],
  [-0.1, 0.054, 0.06, 0, -0.012],
  [-0.26, 0.04, 0.043, 0, -0.004],
  [-0.4, 0.033, 0.035, 0, 0],
  [-0.42, 0.024, 0.025, 0, 0],
];

const UPPER_ARM: Section[] = [
  [0.045, 0.034, 0.038, 0, 0],
  [0, 0.05, 0.054, 0, 0],
  [-0.12, 0.047, 0.05, 0, 0],
  [-0.27, 0.039, 0.041, 0, 0],
  [-0.3, 0.028, 0.03, 0, 0],
];

const FOREARM: Section[] = [
  [0.02, 0.03, 0.032, 0, 0],
  [0, 0.038, 0.04, 0, 0],
  [-0.08, 0.036, 0.039, 0, 0],
  [-0.24, 0.024, 0.029, 0, 0],
  [-0.26, 0.018, 0.02, 0, 0],
];

/** Hand hanging from the wrist: thin across x (palm faces the body), wide along z. */
const HAND: Section[] = [
  [0.01, 0.017, 0.026, 0, 0],
  [-0.03, 0.02, 0.04, 0, 0.002],
  [-0.09, 0.018, 0.043, 0, 0.004],
  [-0.15, 0.013, 0.034, 0, 0.004],
  [-0.175, 0.006, 0.016, 0, 0.002],
];

/** Shoe along z from heel to toe: [z, half width, half height, x, y]; the ankle is the origin. */
const SHOE: Section[] = [
  [-0.075, 0.028, 0.026, 0, -0.049],
  [-0.062, 0.04, 0.04, 0, -0.037],
  [0, 0.044, 0.042, 0, -0.034],
  [0.07, 0.048, 0.035, 0, -0.042],
  [0.15, 0.047, 0.026, 0, -0.05],
  [0.19, 0.04, 0.02, 0, -0.055],
  [0.215, 0.022, 0.012, 0, -0.062],
];

const SKIRT: Section[] = [
  [0.1, 0.16, 0.11, 0, -0.006],
  [0, 0.182, 0.13, 0, -0.008],
  [-0.15, 0.205, 0.16, 0, 0],
  [-0.33, 0.228, 0.19, 0, 0.01],
];

/** Head ellipsoid in the head frame (origin at the neck base). */
const HEAD_C: [number, number, number] = [0, 0.152, 0.012];
const HEAD_R: [number, number, number] = [0.076, 0.108, 0.094];

/** Narrower jaw and a fuller back of the head. */
function skull(p: THREE.Vector3): void {
  const yn = p.y / HEAD_R[1];
  if (yn < 0) {
    const t = Math.min(1, -yn);
    p.x *= 1 - 0.24 * t ** 1.5;
    if (p.z < 0) p.z *= 1 - 0.3 * t;
  } else if (p.z < 0) p.z *= 1.04;
}

/** Hair line per longitude (0 = front): forehead in front, nape (short) or shoulders (long). */
const hairShort = (th: number) => 0.3 * Math.PI + (0.66 * Math.PI - 0.3 * Math.PI) * ((1 - Math.cos(th)) / 2) ** 0.8;
const hairLong = (th: number) => 0.3 * Math.PI + (Math.PI / 2 + 1.75 - 0.3 * Math.PI) * ((1 - Math.cos(th)) / 2) ** 0.55;

// ---------------------------------------------------------------- builders

/**
 * A limb segment. Ends buried in the neighbouring part (thigh in the pelvis, shin in the shoe,
 * shoulder in the torso…) stay open below hero detail; low detail keeps only visible tips.
 */
function limb(sections: Section[], radial: number, s: Segs, lo: 'open' | 'cap' | 'low-open', hi: 'open' | 'cap' | 'low-open'): THREE.BufferGeometry {
  const m = new Mesher();
  const keep = (e: 'open' | 'cap' | 'low-open') => s === SEGS.hero || e === 'cap' || (e === 'low-open' && !s.offset);
  m.loft(sections, 'y', radial, 2, keep(lo), keep(hi), s.offset);
  return m.build();
}

/** Front surface of the (undeformed) head ellipsoid at (x, y), in the head frame. */
function faceZ(x: number, y: number): number {
  const u = x / HEAD_R[0];
  const v = (y - HEAD_C[1]) / HEAD_R[1];
  return HEAD_C[2] + HEAD_R[2] * Math.sqrt(Math.max(0, 1 - u * u - v * v));
}

/** A small patch painted on the face (eyes, brows, mouth), following its curvature. */
function facePatch(m: Mesher, x0: number, x1: number, y0: number, y1: number, rgb: [number, number, number]): void {
  m.color = rgb;
  const v = (x: number, y: number) => m.vert(x, y, faceZ(x, y) + 0.0016);
  const a = v(x0, y0);
  const b = v(x1, y0);
  const c = v(x1, y1);
  const d = v(x0, y1);
  m.tri(a, b, c);
  m.tri(a, c, d);
  m.color = [1, 1, 1];
}

/** Neck and head (vertex coloured: skin comes from the instance colour, features darken it). */
function head(s: Segs, detail: Detail): THREE.BufferGeometry {
  const m = new Mesher();
  if (detail !== 'low') {
    m.loft(
      [
        [-0.02, 0.05, 0.05, 0, 0],
        [0.1, 0.046, 0.048, 0, 0.004],
      ],
      'y',
      s.limb,
      2,
      true,
      false,
    );
  }
  m.shell(HEAD_C, HEAD_R, s.headW, s.headH, () => Math.PI, detail === 'low' ? undefined : skull);
  if (s.face) {
    // Nose and ears: small, but they tell which way a face is looking.
    m.loft(
      [
        [HEAD_C[2] + 0.078, 0.013, 0.02, 0, HEAD_C[1] - 0.015],
        [HEAD_C[2] + 0.104, 0.006, 0.006, 0, HEAD_C[1] - 0.03],
      ],
      'z',
      4,
      2,
      false,
      true,
    );
    if (s.ears) for (const sx of [1, -1]) m.shell([sx * 0.074, HEAD_C[1] - 0.005, HEAD_C[2] - 0.01], [0.012, 0.026, 0.018], 6, 4, () => Math.PI);
    // Eyes, brows and mouth: a few painted quads make faces read at close range.
    const cy = HEAD_C[1];
    for (const sx of [1, -1]) {
      const [a, b] = sx > 0 ? [0.021, 0.039] : [-0.039, -0.021];
      facePatch(m, a, b, cy - 0.003, cy + 0.005, [0.06, 0.05, 0.05]);
      facePatch(m, a - 0.004, b + 0.003, cy + 0.017, cy + 0.022, [0.22, 0.17, 0.15]);
    }
    facePatch(m, -0.016, 0.016, cy - 0.052, cy - 0.047, [0.62, 0.36, 0.36]);
  }
  return m.build(true);
}

function hair(kind: 'short' | 'long' | 'bun', s: Segs): THREE.BufferGeometry {
  const m = new Mesher();
  const r: [number, number, number] = [HEAD_R[0] * 1.08, HEAD_R[1] * 1.07, HEAD_R[2] * 1.07];
  const c: [number, number, number] = [HEAD_C[0], HEAD_C[1] + 0.006, HEAD_C[2] - 0.004];
  const rows = Math.max(2, Math.round(s.headH * (kind === 'long' ? 1.4 : 0.65)));
  m.shell(c, r, s.headW, rows, kind === 'long' ? hairLong : hairShort, (p) => {
    if (p.z < 0 && p.y > -0.05) p.z *= 1.04;
    if (p.y < 0) p.x *= 1 - 0.1 * Math.min(1, -p.y / 0.1);
  });
  if (kind === 'bun') m.shell([0, HEAD_C[1] + 0.06, HEAD_C[2] - 0.095], [0.044, 0.042, 0.042], Math.max(5, s.headW >> 1), Math.max(3, s.headH >> 1), () => Math.PI);
  return m.build();
}

function cap(s: Segs): THREE.BufferGeometry {
  const m = new Mesher();
  const r: [number, number, number] = [HEAD_R[0] * 1.12, HEAD_R[1] * 1.0, HEAD_R[2] * 1.1];
  const c: [number, number, number] = [HEAD_C[0], HEAD_C[1] + 0.018, HEAD_C[2] - 0.004];
  m.shell(c, r, s.headW, Math.max(3, s.headH >> 1), () => 0.47 * Math.PI);
  // Brim: a flattened half-ellipse in front.
  const n = Math.max(4, s.headW >> 1);
  const y = c[1] + r[1] * Math.cos(0.47 * Math.PI) - 0.004;
  const ring: number[] = [];
  const outer: number[] = [];
  for (let j = 0; j <= n; j++) {
    const th = -1.25 + (2.5 * j) / n;
    const ex = Math.sin(th);
    const ez = Math.cos(th);
    ring.push(m.vert(ex * r[0] * 0.98, y, c[2] + ez * r[2] * 0.98));
    outer.push(m.vert(ex * r[0] * 1.05, y - 0.012, c[2] + ez * (r[2] + 0.075)));
  }
  for (let j = 0; j < n; j++) {
    m.tri(ring[j], outer[j], ring[j + 1]);
    m.tri(ring[j + 1], outer[j], outer[j + 1]);
  }
  return m.build();
}

/** White shirt V and a dark tie on the chest, in the torso frame (vertex coloured). */
function shirt(): THREE.BufferGeometry {
  const m = new Mesher();
  const rows = [0.445, 0.4, 0.34, 0.27];
  const vRow = (y: number, half: number, lift: number) => {
    const z = torsoFront(y) + lift;
    return [m.vert(half, y, z), m.vert(0, y, z + 0.002), m.vert(-half, y, z)];
  };
  m.color = [1, 1, 1];
  const shirtRows = rows.map((y, i) => vRow(y, 0.058 * (1 - i / (rows.length - 1)) + 0.002, 0.004));
  for (let i = 0; i + 1 < shirtRows.length; i++) {
    const [a0, b0, c0] = shirtRows[i];
    const [a1, b1, c1] = shirtRows[i + 1];
    m.tri(a0, a1, b0);
    m.tri(b0, a1, b1);
    m.tri(b0, b1, c0);
    m.tri(c0, b1, c1);
  }
  // Tie: a narrow dark strip down the middle.
  m.color = [0.05, 0.05, 0.09];
  const tie = [0.43, 0.3].map((y, i) => {
    const z = torsoFront(y) + 0.008;
    const h = i === 0 ? 0.011 : 0.02;
    return [m.vert(h, y, z), m.vert(-h, y, z)];
  });
  const tip = m.vert(0, 0.275, torsoFront(0.275) + 0.008);
  m.tri(tie[0][0], tie[1][0], tie[0][1]);
  m.tri(tie[0][1], tie[1][0], tie[1][1]);
  m.tri(tie[1][0], tip, tie[1][1]);
  return m.build(true);
}

/** Two-wheeled suitcase with a telescopic handle; origin at the wheels, +y up the handle. */
function suitcase(s: Segs): THREE.BufferGeometry {
  const m = new Mesher();
  m.color = [1, 1, 1];
  m.box(0, 0.33, -0.13, 0.38, 0.58, 0.24);
  m.color = [0.12, 0.12, 0.13];
  // Corner guards and the handle.
  m.box(0, 0.045, -0.13, 0.4, 0.03, 0.26);
  for (const x of [0.08, -0.08]) m.box(x, 0.8, -0.012, 0.018, 0.4, 0.018);
  m.box(0, 0.995, -0.012, 0.19, 0.03, 0.03);
  for (const x of [0.15, -0.15]) {
    m.loft(
      [
        [x - 0.015, 0.035, 0.035, 0.035, -0.03],
        [x + 0.015, 0.035, 0.035, 0.035, -0.03],
      ],
      'x',
      Math.max(5, s.limb),
    );
  }
  return m.build(true);
}

function shadow(): THREE.BufferGeometry {
  // Soft contact shadow: vertex alpha falls from the centre to the rim (no texture needed).
  const segs = 10;
  const pos: number[] = [0, 0, 0];
  const col: number[] = [0, 0, 0, 0.42];
  for (const [r, a] of [
    [0.55, 0.26],
    [1, 0],
  ]) {
    for (let j = 0; j < segs; j++) {
      const th = (j / segs) * Math.PI * 2;
      pos.push(Math.sin(th) * r, 0, Math.cos(th) * r);
      col.push(0, 0, 0, a);
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < segs; j++) {
    const j1 = (j + 1) % segs;
    idx.push(0, 1 + j, 1 + j1);
    const a = 1 + j;
    const b = 1 + j1;
    idx.push(a, 1 + segs + j, b, b, 1 + segs + j, 1 + segs + j1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(pos.map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  g.setIndex(idx);
  return g;
}

/** Builds the geometry of one body part at a detail level. */
export function buildPartGeometry(part: PartId, detail: Detail): THREE.BufferGeometry {
  const s = SEGS[detail];
  switch (part) {
    case 'head':
      return head(s, detail);
    case 'hairShort':
      return hair('short', s);
    case 'hairLong':
      return hair('long', s);
    case 'hairBun':
      return hair('bun', s);
    case 'cap':
      return cap(s);
    case 'torso':
    case 'torsoF': {
      const m = new Mesher();
      m.loft(pick(part === 'torso' ? TORSO : TORSO_F, s.pick.torso), 'y', s.torso, 2.6, true, true, s.offset);
      return m.build();
    }
    case 'shirt':
      return shirt();
    case 'pelvis': {
      const m = new Mesher();
      m.loft(pick(PELVIS, s.pick.pelvis), 'y', s.torso, 2.4, true, true, s.offset);
      return m.build();
    }
    case 'skirt': {
      const m = new Mesher();
      m.loft(pick(SKIRT, s.pick.skirt), 'y', s.torso + 2, 2, false, false, s.offset);
      return m.build();
    }
    case 'thigh':
      return limb(pick(THIGH, s.pick.thigh), s.limb, s, 'low-open', 'open');
    case 'shin':
      return limb(pick(SHIN, s.pick.shin), s.limb, s, 'open', 'low-open');
    case 'upperArm':
      return limb(pick(UPPER_ARM, s.pick.upperArm), s.limb, s, 'low-open', 'open');
    case 'forearm':
      return limb(pick(FOREARM, s.pick.forearm), Math.max(4, s.limb - 1), s, 'open', 'open');
    case 'hand':
      return limb(pick(HAND, s.pick.hand), s.hand, s, 'cap', 'open');
    case 'shoe': {
      const m = new Mesher();
      m.loft(pick(SHOE, s.pick.shoe), 'z', s.shoe, 3.2, true, true, s.offset);
      return m.build();
    }
    case 'box':
      return new THREE.BoxGeometry(1, 1, 1);
    case 'suitcase':
      return suitcase(s);
    case 'shadow':
      return shadow();
  }
}

/** Lengths the geometry was authored for (kept next to the shapes for tests). */
export const GEOMETRY_LENGTHS = { thigh: BODY.thigh, shin: BODY.shin, upperArm: BODY.upperArm, forearm: BODY.forearm };
