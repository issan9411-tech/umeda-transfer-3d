/**
 * Pure maths behind the animated pedestrians (no three.js, no DOM): body proportions, seeded
 * appearance, the procedural walk cycle and a tiny 3×4 affine toolkit used to turn a pose into
 * instance matrices without allocating.
 *
 * Person space: origin on the ground under the body, +y up, +z forward (heading 0 = +z, as in
 * `headingBetween`), +x = the person's LEFT. Lengths are metres of a 1.71 m reference adult;
 * each person is scaled uniformly by `Look.height`.
 */

const D = Math.PI / 180;
const TAU = Math.PI * 2;

/** Reference skeleton (metres). */
export const BODY = {
  ankleH: 0.075,
  shin: 0.4,
  thigh: 0.42,
  hipHalf: 0.088,
  /** Waist (torso origin) above the hip joints. */
  pelvisTop: 0.1,
  /** Waist → neck base. */
  torsoLen: 0.455,
  shoulderY: 0.395,
  shoulderHalf: 0.185,
  upperArm: 0.285,
  forearm: 0.25,
  /** Heel behind / ball of the foot ahead of the ankle. */
  heel: 0.055,
  ball: 0.15,
} as const;

/** Height of the reference adult, metres. */
export const REFERENCE_HEIGHT = 1.71;

const LEG = BODY.thigh + BODY.shin;
/** Longest hip→ankle distance the gait asks for (a hint of knee bend keeps legs alive). */
const LMAX = LEG * 0.99;

// ---------------------------------------------------------------- random + colour helpers

/** Deterministic PRNG state; `seed` re-initialises it from a person id. */
export class Rng {
  private s = 1;

  seed(n: number): this {
    // Scramble sequential ids so neighbours do not look alike.
    let h = Math.imul((n >>> 0) ^ 0x9e3779b9, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    this.s = (h ^ (h >>> 16)) >>> 0;
    return this;
  }

  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Approximately normal (sum of three uniforms), mean 0, sd 1. */
  gauss(): number {
    return (this.next() + this.next() + this.next() - 1.5) * 2;
  }

  pick(n: number): number {
    return Math.min(n - 1, Math.floor(this.next() * n));
  }
}

/** sRGB hex → linear RGB triplets packed in one array (what instance colours expect). */
function palette(hexes: string[]): Float32Array {
  const out = new Float32Array(hexes.length * 3);
  hexes.forEach((h, i) => {
    const v = parseInt(h.slice(1), 16);
    for (let k = 0; k < 3; k++) {
      const c = ((v >> (16 - 8 * k)) & 255) / 255;
      out[i * 3 + k] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }
  });
  return out;
}

/** Colour sets (sRGB) for a weekday Umeda crowd. */
export const PALETTES = {
  skin: palette(['#f1cba8', '#e9bd95', '#ddb08a', '#f4d3b5', '#d6a47e', '#e3b690', '#b27a55', '#8d5b3d']),
  hair: palette(['#16120f', '#1f1813', '#2b2019', '#3b2a20', '#5a3d2b', '#7a5234', '#8f8b86', '#c8c4be']),
  suit: palette(['#24272d', '#1f2739', '#17181c', '#33363c', '#2a3242', '#44474d']),
  shirt: palette(['#f4f5f7', '#e4ecf6', '#fbfbf9']),
  top: palette([
    '#f0eee8', '#d8d2c4', '#9a9ea3', '#2e3a55', '#556045', '#1e1f22', '#6d8fb3',
    '#9e3d3b', '#d6a9b0', '#c7a24a', '#7b5a42', '#4f6d7a', '#e6dac6', '#3d4a3b',
  ]),
  bottom: palette(['#2f4868', '#243650', '#1c1d20', '#b4a585', '#5d6066', '#7d7458', '#e4e1d8', '#3a3a40']),
  skirt: palette(['#1d1f24', '#2c3550', '#b9a88a', '#5b6246', '#e0dbd0', '#8c5a5f', '#9aa3ad']),
  shoes: palette(['#161618', '#3b2a20', '#ecebe7', '#6b6e73', '#c4b196']),
  bag: palette(['#1b1b1d', '#3d2b1f', '#6e5a45', '#8a8f96', '#b9a27f', '#2b3445', '#7a2e2e']),
  case: palette(['#1e1f22', '#b8bcc2', '#2c3a5a', '#b3363a', '#8fb2cf', '#e8e5de', '#c7a34a']),
  uniform: palette(['#14161b', '#1c2540', '#3c4a63', '#4b4f58']),
  hosiery: palette(['#2a2a2e', '#d9c2aa']),
  accent: palette(['#ffc400', '#1f2a3d', '#c9b89a', '#f4f2ec', '#2a2f38']),
};

function setRgb(out: Float32Array, pal: Float32Array, i: number): void {
  out[0] = pal[i * 3];
  out[1] = pal[i * 3 + 1];
  out[2] = pal[i * 3 + 2];
}

// ---------------------------------------------------------------- appearance

/** What a person carries in one hand. */
export const Carry = { None: 0, Briefcase: 1, Tote: 2, Suitcase: 3, Phone: 4 } as const;
export type Carry = (typeof Carry)[keyof typeof Carry];

export const Hair = { Short: 0, Long: 1, Bun: 2 } as const;
export type Hair = (typeof Hair)[keyof typeof Hair];

/** Everything that makes one pedestrian look and move like themselves. */
export class Look {
  female = false;
  /** Uniform scale vs the 1.71 m reference (1.55–1.85 m overall). */
  height = 1;
  /** Build: limb and torso thickness. */
  girth = 1;
  shoulder = 1;
  hip = 1;
  hair: Hair = Hair.Short as Hair;
  cap = false;
  skirt = false;
  /** White shirt front and tie under a suit jacket. */
  shirt = false;
  carry: Carry = Carry.None as Carry;
  /** Hand / shoulder used for carrying: +1 left, −1 right. */
  side = -1;
  backpack = false;
  shoulderBag = false;
  /** Personal gait factors. */
  cadence = 1;
  swing = 1;
  lean = 0;
  stepWidth = 1;
  phase0 = 0;
  /** Period of the idle weight shift, seconds. */
  idlePeriod = 7;
  readonly skin = new Float32Array(3);
  readonly hairC = new Float32Array(3);
  readonly top = new Float32Array(3);
  /** Forearm colour (skin for short sleeves). */
  readonly sleeve = new Float32Array(3);
  readonly shirtC = new Float32Array(3);
  readonly pelvisC = new Float32Array(3);
  readonly thighC = new Float32Array(3);
  readonly shinC = new Float32Array(3);
  readonly shoes = new Float32Array(3);
  readonly skirtC = new Float32Array(3);
  readonly bagC = new Float32Array(3);
  readonly packC = new Float32Array(3);
  readonly caseC = new Float32Array(3);
  readonly capC = new Float32Array(3);
}

/** Floats needed to store a Look (see packLook). */
export const LOOK_STRIDE = 64;

/** Serialises a look into `dst` at offset `o` (a compact per-person cache). */
export function packLook(k: Look, dst: Float32Array, o: number): void {
  dst[o] = k.female ? 1 : 0;
  dst[o + 1] = k.height;
  dst[o + 2] = k.girth;
  dst[o + 3] = k.shoulder;
  dst[o + 4] = k.hip;
  dst[o + 5] = k.hair;
  dst[o + 6] = k.cap ? 1 : 0;
  dst[o + 7] = k.skirt ? 1 : 0;
  dst[o + 8] = k.shirt ? 1 : 0;
  dst[o + 9] = k.carry;
  dst[o + 10] = k.side;
  dst[o + 11] = k.backpack ? 1 : 0;
  dst[o + 12] = k.shoulderBag ? 1 : 0;
  dst[o + 13] = k.cadence;
  dst[o + 14] = k.swing;
  dst[o + 15] = k.lean;
  dst[o + 16] = k.stepWidth;
  dst[o + 17] = k.phase0;
  dst[o + 18] = k.idlePeriod;
  let c = o + 19;
  for (const col of lookColours(k)) {
    dst[c++] = col[0];
    dst[c++] = col[1];
    dst[c++] = col[2];
  }
}

/** Inverse of packLook. */
export function unpackLook(src: Float32Array, o: number, k: Look): Look {
  k.female = src[o] === 1;
  k.height = src[o + 1];
  k.girth = src[o + 2];
  k.shoulder = src[o + 3];
  k.hip = src[o + 4];
  k.hair = src[o + 5] as Hair;
  k.cap = src[o + 6] === 1;
  k.skirt = src[o + 7] === 1;
  k.shirt = src[o + 8] === 1;
  k.carry = src[o + 9] as Carry;
  k.side = src[o + 10];
  k.backpack = src[o + 11] === 1;
  k.shoulderBag = src[o + 12] === 1;
  k.cadence = src[o + 13];
  k.swing = src[o + 14];
  k.lean = src[o + 15];
  k.stepWidth = src[o + 16];
  k.phase0 = src[o + 17];
  k.idlePeriod = src[o + 18];
  let c = o + 19;
  for (const col of lookColours(k)) {
    col[0] = src[c++];
    col[1] = src[c++];
    col[2] = src[c++];
  }
  return k;
}

/** The colour arrays of a look, in a fixed order (cached per Look instance: no allocation). */
const colourLists = new WeakMap<Look, Float32Array[]>();
function lookColours(k: Look): Float32Array[] {
  let l = colourLists.get(k);
  if (!l) {
    l = [k.skin, k.hairC, k.top, k.sleeve, k.shirtC, k.pelvisC, k.thighC, k.shinC, k.shoes, k.skirtC, k.bagC, k.packC, k.caseC, k.capC];
    colourLists.set(k, l);
  }
  return l;
}

const rng = new Rng();

/**
 * Deterministic appearance for a person id (office workers, casual, students, travellers,
 * seniors in rough weekday-Umeda proportions). Writes into `out`; allocation-free.
 */
export function makeLook(id: number, out: Look): Look {
  const r = rng.seed(id);
  const P = PALETTES;
  const cat = r.next();
  const business = cat < 0.3;
  const student = !business && cat >= 0.7 && cat < 0.8;
  const traveller = cat >= 0.8 && cat < 0.9;
  const senior = cat >= 0.9;
  const female = r.next() < (business ? 0.3 : 0.52);
  out.female = female;
  out.height = Math.min(1.08, Math.max(0.908, (female ? 0.925 : 1.0) + r.gauss() * 0.032 - (senior ? 0.025 : 0)));
  out.girth = Math.min(1.18, Math.max(0.88, 1 + r.gauss() * 0.06 + (senior ? 0.04 : 0) - (student ? 0.04 : 0)));
  out.shoulder = female ? 0.9 : 1;
  out.hip = female ? 1.05 : 1;
  out.cadence = 0.95 + r.next() * 0.1 - (senior ? 0.06 : 0);
  out.swing = 0.75 + r.next() * 0.5 - (senior ? 0.25 : 0);
  out.lean = (r.next() * 3 + (senior ? 5 : 0)) * D;
  out.stepWidth = 0.8 + r.next() * 0.4;
  out.phase0 = r.next();
  out.idlePeriod = 5 + r.next() * 5;

  // Skin: mostly East Asian tones, a few visitors.
  const sk = r.next();
  setRgb(out.skin, P.skin, sk < 0.94 ? r.pick(6) : 6 + r.pick(2));
  // Hair colour and style.
  const hc = senior ? (r.next() < 0.7 ? 6 + r.pick(2) : r.pick(3)) : r.next() < 0.78 ? r.pick(4) : 4 + r.pick(2);
  setRgb(out.hairC, P.hair, hc);
  const hs = r.next();
  out.hair = female ? (hs < (student ? 0.7 : 0.52) ? Hair.Long : hs < 0.75 ? Hair.Bun : Hair.Short) : hs < 0.04 ? Hair.Long : Hair.Short;
  out.cap = !female && (senior ? r.next() < 0.25 : r.next() < 0.05);
  setRgb(out.capC, P.top, r.pick(14));

  // Clothes.
  out.shirt = false;
  out.skirt = false;
  let shortSleeves = r.next() < 0.18;
  if (business) {
    const s = r.pick(6);
    shortSleeves = r.next() < 0.2; // shirt-sleeve office workers
    if (shortSleeves) setRgb(out.top, P.shirt, r.pick(3));
    else setRgb(out.top, P.suit, s);
    setRgb(out.pelvisC, P.suit, s);
    out.shirt = !shortSleeves && !female;
    setRgb(out.shirtC, P.shirt, r.pick(3));
    out.skirt = female && r.next() < 0.5;
    setRgb(out.skirtC, P.suit, s);
    setRgb(out.shoes, P.shoes, r.next() < 0.8 ? 0 : 1);
  } else if (student && r.next() < 0.6) {
    // School uniform: black gakuran or navy blazer + plaid skirt.
    setRgb(out.top, P.uniform, female ? 1 : 0);
    setRgb(out.pelvisC, P.uniform, female ? 2 : 0);
    out.skirt = female;
    setRgb(out.skirtC, P.uniform, 2 + r.pick(2));
    setRgb(out.shoes, P.shoes, r.next() < 0.6 ? 1 : 0);
    shortSleeves = false;
  } else {
    setRgb(out.top, P.top, senior ? [1, 2, 3, 10, 12][r.pick(5)] : r.pick(14));
    setRgb(out.pelvisC, P.bottom, female && r.next() < 0.15 ? 6 : r.pick(6));
    out.skirt = female && r.next() < 0.38;
    setRgb(out.skirtC, P.skirt, r.pick(7));
    setRgb(out.shoes, P.shoes, r.next() < 0.4 ? 2 : r.pick(5));
  }
  out.sleeve.set(shortSleeves ? out.skin : out.top);
  if (out.skirt) {
    out.pelvisC.set(out.skirtC);
    const bare = r.next() < 0.55;
    if (bare) out.thighC.set(out.skin);
    else setRgb(out.thighC, P.hosiery, r.pick(2));
    out.shinC.set(out.thighC);
    if (student) setRgb(out.shinC, P.uniform, 1); // navy socks
  } else {
    out.thighC.set(out.pelvisC);
    out.shinC.set(out.pelvisC);
  }

  // Things people carry (≈ a quarter with a bag, a few suitcases, some on their phones).
  out.carry = Carry.None;
  out.backpack = false;
  out.shoulderBag = false;
  out.side = r.next() < 0.7 ? -1 : 1;
  const a = r.next();
  if (business) {
    if (a < 0.2) out.carry = Carry.Briefcase;
    else if (a < 0.3) out.shoulderBag = true;
    else if (a < 0.42) out.backpack = true;
    else if (a < 0.5) out.carry = Carry.Phone;
  } else if (student) {
    out.backpack = a < 0.5;
    if (!out.backpack && a < 0.6) out.shoulderBag = true;
    if (r.next() < 0.15) out.carry = Carry.Phone;
  } else if (traveller) {
    out.carry = a < 0.55 ? Carry.Suitcase : a < 0.65 ? Carry.Phone : Carry.None;
    out.backpack = r.next() < 0.45;
    if (!out.backpack) out.shoulderBag = r.next() < 0.3;
  } else if (senior) {
    if (a < 0.25) out.shoulderBag = true;
    else if (a < 0.4) out.carry = Carry.Tote;
  } else {
    if (a < 0.12) out.carry = Carry.Tote;
    else if (a < 0.24) out.shoulderBag = true;
    else if (a < 0.31) out.backpack = true;
    else if (a < 0.41) out.carry = Carry.Phone;
  }
  if (out.carry === Carry.Suitcase) out.side = -1;
  setRgb(out.bagC, P.bag, business ? (r.next() < 0.7 ? 0 : 1) : r.pick(7));
  setRgb(out.packC, P.bag, business ? 0 : r.pick(7));
  setRgb(out.caseC, P.case, r.pick(7));
  return out;
}

/** The hero walker: a traveller in a navy jacket with the app's yellow cap and backpack. */
export function heroLook(out: Look): Look {
  makeLook(1, out);
  const A = PALETTES.accent;
  out.female = false;
  out.height = 1.02;
  out.girth = 1;
  out.shoulder = 1;
  out.hip = 1;
  out.hair = Hair.Short;
  out.cap = true;
  out.skirt = false;
  out.shirt = false;
  out.carry = Carry.None;
  out.backpack = true;
  out.shoulderBag = false;
  out.cadence = 1;
  out.swing = 1;
  out.lean = 1.5 * D;
  out.stepWidth = 1;
  out.phase0 = 0;
  setRgb(out.skin, PALETTES.skin, 1);
  setRgb(out.hairC, PALETTES.hair, 1);
  setRgb(out.top, A, 1);
  out.sleeve.set(out.top);
  setRgb(out.pelvisC, A, 2);
  out.thighC.set(out.pelvisC);
  out.shinC.set(out.pelvisC);
  setRgb(out.shoes, A, 3);
  setRgb(out.capC, A, 0);
  setRgb(out.packC, A, 0);
  return out;
}

// ---------------------------------------------------------------- walk cycle

/** Ground rise per metre forward used for stair poses when the caller gives none (≈ 35°). */
export const DEFAULT_STAIR_SLOPE = 0.7;

/**
 * Steps per second for a walking speed in m/s of the reference body (≈1.9 at 1.3 m/s).
 * Stairs keep a steady rhythm whatever the horizontal speed.
 */
export function cadence(speed: number, look: Look, climb = 0): number {
  if (climb > 0) return 1.7 * look.cadence;
  if (climb < 0) return 1.9 * look.cadence;
  return Math.min(2.5, Math.max(1.2, 1.0 + 0.72 * speed)) * look.cadence;
}

/** Joint angles and positions of one frame, in person space (see module comment). */
export class Pose {
  /** Pelvis (hip-joint centre) position and rotation. */
  px = 0;
  py = 0;
  pz = 0;
  pPitch = 0;
  pYaw = 0;
  pRoll = 0;
  /** Torso relative to the pelvis, head relative to the torso (Euler YXZ, radians). */
  tPitch = 0;
  tYaw = 0;
  tRoll = 0;
  hPitch = 0;
  hYaw = 0;
  hRoll = 0;
  /** Per leg / arm: index 0 = left, 1 = right. */
  readonly hip = new Float64Array(6);
  readonly ankle = new Float64Array(6);
  /** Thigh rotation = Rz(thighRoll) · Rx(thighPitch) in person space. */
  readonly thighPitch = new Float64Array(2);
  readonly thighRoll = new Float64Array(2);
  /** Rx angles of shin (knee) and foot, each relative to its parent. */
  readonly knee = new Float64Array(2);
  readonly footPitch = new Float64Array(2);
  readonly footYaw = new Float64Array(2);
  /** Upper arm relative to the torso (Euler YXZ), then elbow / wrist. */
  readonly armPitch = new Float64Array(2);
  readonly armYaw = new Float64Array(2);
  readonly armRoll = new Float64Array(2);
  readonly elbow = new Float64Array(2);
  readonly foreYaw = new Float64Array(2);
  readonly handPitch = new Float64Array(2);
  readonly handRoll = new Float64Array(2);
}

export interface GaitState {
  /** Gait cycle phase in [0, 1); 0 = left heel strike. */
  phase: number;
  /** 0 = standing, 1 = walking (smoothed by the caller). */
  blend: number;
  /** Walking speed in m/s of the reference body. */
  speed: number;
  /** −1 down stairs, 0 level, +1 up stairs. */
  climb: number;
  /** Seconds, drives idle motion. */
  time: number;
  /** Ground rise per metre forward on stairs (tangent of the flight's slope). */
  slope: number;
}

const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const frac = (x: number) => x - Math.floor(x);

/** Scratch for stance / swing ankle targets: forward, height, foot pitch. */
const sa = new Float64Array(3);

interface StepShape {
  L: number;
  beta: number;
  fpHS: number;
  fpTO: number;
  slope: number;
}

/**
 * Ankle of a planted foot at stance phase p ∈ [0, β): the footprint slides back linearly
 * (it is fixed on the ground while the body moves on), rolling heel → flat → ball.
 */
function stanceAnkle(p: number, s: StepShape, out: Float64Array): void {
  const { L, beta } = s;
  // Heel relative to the body. Offset so the ankle sweeps symmetrically about the hip: the
  // contact point also rolls heel → ball, which is why the heel lands only ~0.3 m ahead.
  const xh = beta * L - 0.13 - 2 * L * p;
  let fp: number;
  if (p < 0.1) fp = s.fpHS * (1 - smooth(p / 0.1));
  else if (p < 0.34) fp = 0;
  else fp = -s.fpTO * smooth((p - 0.34) / (beta - 0.34));
  const g = s.slope * (xh + 0.08); // tread under the middle of the foot
  const c = Math.cos(fp);
  const sn = Math.sin(fp);
  if (fp >= 0) {
    // Heel rocker: rotate about the heel.
    out[0] = xh + BODY.heel * c - BODY.ankleH * sn;
    out[1] = g + BODY.heel * sn + BODY.ankleH * c;
  } else {
    // Ball rocker: rotate about the ball of the foot.
    const xb = xh + BODY.heel + BODY.ball;
    out[0] = xb - BODY.ball * c - BODY.ankleH * sn;
    out[1] = g - BODY.ball * sn + BODY.ankleH * c;
  }
  out[2] = fp;
}

/** Highest hip-joint height from which a stance leg still reaches its ankle target. */
function reach(p: number, s: StepShape): number {
  stanceAnkle(p, s, sa);
  return sa[1] + Math.sqrt(Math.max(0, LMAX * LMAX - sa[0] * sa[0]));
}

/** Walking ankle target (forward, height, foot pitch) for one leg at leg phase p. */
function walkAnkle(p: number, s: StepShape, lift: number, out: Float64Array): void {
  if (p < s.beta) {
    stanceAnkle(p, s, out);
    return;
  }
  // Swing: ease from toe-off to the next heel strike, lifting the foot on the way.
  const u = (p - s.beta) / (1 - s.beta);
  stanceAnkle(s.beta - 1e-6, s, out);
  const x0 = out[0];
  const y0 = out[1];
  const f0 = out[2];
  stanceAnkle(0, s, out);
  const e = smooth(u);
  out[0] = x0 + (out[0] - x0) * e;
  out[1] = y0 + (out[1] - y0) * smooth(u * 1.15) + lift * Math.sin(Math.PI * Math.pow(u, 0.75));
  out[2] = f0 + (out[2] - f0) * e;
}

const shape: StepShape = { L: 0, beta: 0.6, fpHS: 0, fpTO: 0, slope: 0 };
const ank = new Float64Array(3);

/**
 * Procedural walk cycle → pose. Planted feet (the stance ankle follows the footprint exactly),
 * knees from two-bone IK, pelvis bob at twice the step frequency, sway and list toward the
 * stance leg, pelvis / shoulder counter-rotation, arms swinging opposite to the legs, a stable
 * head; blends into a relaxed standing pose with a slow weight shift when `blend` → 0.
 */
export function computePose(o: Pose, g: GaitState, k: Look): Pose {
  const w = Math.min(1, Math.max(0, g.blend));
  const v = Math.max(0, g.speed);
  const vr = Math.min(1.35, v / 1.3);
  const climb = g.climb > 0.5 ? 1 : g.climb < -0.5 ? -1 : 0;
  const cad = cadence(v, k, climb);
  shape.L = v / cad;
  shape.beta = 0.6;
  shape.slope = climb * g.slope;
  shape.fpHS = climb ? 0 : (6 + 9 * vr) * D;
  shape.fpTO = (climb > 0 ? 14 : climb < 0 ? 6 : 12 + 18 * vr) * D;
  const lift = climb > 0 ? 0.12 : climb < 0 ? 0.06 : 0.04 + 0.04 * vr;
  const pL = frac(g.phase);

  // Pelvis height: lowest at heel strike (double support), highest at mid-stance.
  const hLow = Math.min(reach(0, shape), reach(0.5, shape)) - 0.008 * vr;
  const hMid = Math.min(LMAX + BODY.ankleH - 0.004, reach(0.28, shape));
  const hWalk = hMid - (hMid - Math.min(hLow, hMid)) * 0.5 * (1 + Math.cos(2 * TAU * pL));
  // Standing: nearly straight legs and a slow weight shift from foot to foot.
  const idle = Math.sin(TAU * (g.time / k.idlePeriod + k.phase0));
  const hIdle = LEG * 0.995 + BODY.ankleH;

  const sway = w * (0.02 + 0.012 * vr) * Math.sin(TAU * (pL - 0.05)) + (1 - w) * 0.028 * idle;
  o.px = sway;
  o.py = hIdle + (hWalk - hIdle) * w;
  o.pz = w * climb * 0.03;
  o.pRoll = w * (2 + 2 * vr) * D * Math.sin(TAU * (pL - 0.05)) + (1 - w) * 2.4 * D * idle;
  o.pYaw = -w * (3 + 3 * vr) * D * Math.cos(TAU * pL);
  o.pPitch = w * 2 * D;

  // Torso lean, shoulder counter-rotation, breathing; head keeps looking ahead.
  const phone = k.carry === Carry.Phone;
  const lean = w * ((2 + 3 * vr) * D + (climb > 0 ? 9 * D : climb < 0 ? 2 * D : 0)) + k.lean + (phone ? 4 * D : 0);
  o.tPitch = lean - o.pPitch + (1 - w) * 0.5 * D * Math.sin((TAU * g.time) / 4.2);
  o.tYaw = -o.pYaw * 1.7;
  o.tRoll = -o.pRoll * 0.8;
  const look = (1 - w) * 14 * D * Math.sin(TAU * (g.time / (k.idlePeriod * 1.7) + k.phase0 * 3));
  o.hPitch = -lean * 0.7 + (phone ? 28 * D : climb < 0 ? 12 * D : 0);
  o.hYaw = -(o.pYaw + o.tYaw) + (phone ? 0 : look);
  o.hRoll = -(o.pRoll + o.tRoll) * 0.8;

  // Hip joints in person space (pelvis yaw and list move them).
  const cy = Math.cos(o.pYaw);
  const sy = Math.sin(o.pYaw);
  const cr = Math.cos(o.pRoll);
  const sr = Math.sin(o.pRoll);
  for (let i = 0; i < 2; i++) {
    const sx = i === 0 ? 1 : -1;
    const h = BODY.hipHalf * sx * k.hip;
    o.hip[i * 3] = o.px + h * cr * cy;
    o.hip[i * 3 + 1] = o.py + h * sr;
    o.hip[i * 3 + 2] = o.pz - h * cr * sy;

    // Ankle target: blend walking and standing positions.
    walkAnkle(frac(pL + 0.5 * i), shape, lift, ank);
    const idleFwd = sx * (k.phase0 > 0.5 ? 0.035 : -0.035);
    const ax = sx * (0.075 * k.stepWidth * w + 0.105 * (1 - w));
    const ay = ank[1] * w + BODY.ankleH * (1 - w);
    const az = ank[0] * w + idleFwd * (1 - w);
    const fp = ank[2] * w;
    o.ankle[i * 3] = ax;
    o.ankle[i * 3 + 1] = ay;
    o.ankle[i * 3 + 2] = az;

    // Two-bone IK in the plane tilted by the thigh roll.
    const dx = ax - o.hip[i * 3];
    const dy = ay - o.hip[i * 3 + 1];
    const dz = az - o.hip[i * 3 + 2];
    const lat = Math.hypot(dx, dy);
    const dist = Math.min(LEG - 1e-4, Math.max(0.25, Math.hypot(lat, dz)));
    const a1 = BODY.thigh;
    const a2 = BODY.shin;
    const cosA = (a1 * a1 + dist * dist - a2 * a2) / (2 * a1 * dist);
    const cosK = (a1 * a1 + a2 * a2 - dist * dist) / (2 * a1 * a2);
    const theta = Math.atan2(dz, lat) + Math.acos(Math.min(1, Math.max(-1, cosA)));
    const knee = Math.PI - Math.acos(Math.min(1, Math.max(-1, cosK)));
    o.thighRoll[i] = Math.atan2(dx, -dy);
    o.thighPitch[i] = -theta;
    o.knee[i] = knee;
    o.footPitch[i] = -fp + theta - knee;
    o.footYaw[i] = sx * (5 + 6 * (1 - w)) * D;
  }

  // Arms: counter-swing to the legs, elbows bend more on the forward swing.
  const amp = w * (13 + 11 * vr) * D * k.swing * (climb ? 0.6 : 1);
  for (let i = 0; i < 2; i++) {
    const sx = i === 0 ? 1 : -1;
    const carrying = k.side === sx;
    let theta = 2.5 * D - amp * Math.cos(TAU * (frac(pL + 0.5 * i) - 0.03));
    let elbow = 12 * D + 0.9 * Math.max(0, theta) + (1 - w) * 2 * D;
    let abd = (5 + 4 * (k.girth - 1) * 3) * D;
    let foreYaw = 0;
    let handPitch = 6 * D;
    let handRoll = 0;
    if (carrying && k.carry === Carry.Suitcase) {
      theta = -17 * D + 2 * D * Math.sin(TAU * pL);
      elbow = 6 * D;
      abd = 9 * D;
      handPitch = -8 * D;
    } else if (carrying && (k.carry === Carry.Briefcase || k.carry === Carry.Tote)) {
      theta = 1 * D + (theta - 2.5 * D) * 0.45;
      elbow = 5 * D;
      abd = 8 * D;
    } else if (carrying && k.carry === Carry.Phone) {
      theta = 14 * D + 1.5 * D * Math.sin(TAU * pL);
      elbow = 98 * D;
      abd = 7 * D;
      foreYaw = -sx * 32 * D;
      handPitch = -14 * D;
      handRoll = sx * 70 * D;
    } else if (k.shoulderBag && carrying) {
      theta = 2 * D + (theta - 2.5 * D) * 0.35;
      abd = 13 * D;
    } else if (k.carry === Carry.Phone) {
      theta *= 0.75;
    }
    // Swing angles are world-vertical: undo the torso lean (forward swing = negative Rx).
    o.armPitch[i] = -(theta + lean);
    o.armYaw[i] = 0;
    o.armRoll[i] = sx * abd;
    o.elbow[i] = -elbow;
    o.foreYaw[i] = foreYaw;
    o.handPitch[i] = -handPitch;
    o.handRoll[i] = handRoll;
  }
  return o;
}

// ---------------------------------------------------------------- 3×4 affine helpers

/** Row-major 3×4 affine matrix: [r00 r01 r02 tx, r10 r11 r12 ty, r20 r21 r22 tz]. */
export type Affine = Float64Array;
export const affine = (): Affine => new Float64Array(12);
const R = new Float64Array(9);

/** Rotation matrix for three.js Euler order 'YXZ' (yaw, then pitch, then roll), row-major. */
export function rotYXZ(out: Float64Array, x: number, y: number, z: number): Float64Array {
  // Most joints turn about one or two axes: skip the trig for zero angles.
  const a = x === 0 ? 1 : Math.cos(x);
  const b = x === 0 ? 0 : Math.sin(x);
  const c = y === 0 ? 1 : Math.cos(y);
  const d = y === 0 ? 0 : Math.sin(y);
  const e = z === 0 ? 1 : Math.cos(z);
  const f = z === 0 ? 0 : Math.sin(z);
  const ce = c * e;
  const cf = c * f;
  const de = d * e;
  const df = d * f;
  out[0] = ce + df * b;
  out[1] = de * b - cf;
  out[2] = a * d;
  out[3] = a * f;
  out[4] = a * e;
  out[5] = -b;
  out[6] = cf * b - de;
  out[7] = df + ce * b;
  out[8] = a * c;
  return out;
}

/** Rz(z) · Rx(x), row-major. */
export function rotZX(out: Float64Array, z: number, x: number): Float64Array {
  const cz = Math.cos(z);
  const sz = Math.sin(z);
  const cx = Math.cos(x);
  const sx = Math.sin(x);
  out[0] = cz;
  out[1] = -sz * cx;
  out[2] = sz * sx;
  out[3] = sz;
  out[4] = cz * cx;
  out[5] = -cz * sx;
  out[6] = 0;
  out[7] = sx;
  out[8] = cx;
  return out;
}

/** Root transform: translate, yaw about +y, uniform scale. */
export function setRoot(out: Affine, x: number, y: number, z: number, yaw: number, s: number): Affine {
  const c = Math.cos(yaw) * s;
  const n = Math.sin(yaw) * s;
  out[0] = c;
  out[1] = 0;
  out[2] = n;
  out[3] = x;
  out[4] = 0;
  out[5] = s;
  out[6] = 0;
  out[7] = y;
  out[8] = -n;
  out[9] = 0;
  out[10] = c;
  out[11] = z;
  return out;
}

/** out = parent · T(tx, ty, tz) · rot (rot: row-major 3×3). `out` may not alias `parent`. */
export function compose(out: Affine, p: Affine, tx: number, ty: number, tz: number, rot: Float64Array): Affine {
  for (let r = 0; r < 3; r++) {
    const p0 = p[r * 4];
    const p1 = p[r * 4 + 1];
    const p2 = p[r * 4 + 2];
    out[r * 4] = p0 * rot[0] + p1 * rot[3] + p2 * rot[6];
    out[r * 4 + 1] = p0 * rot[1] + p1 * rot[4] + p2 * rot[7];
    out[r * 4 + 2] = p0 * rot[2] + p1 * rot[5] + p2 * rot[8];
    out[r * 4 + 3] = p0 * tx + p1 * ty + p2 * tz + p[r * 4 + 3];
  }
  return out;
}

/** compose() with an Euler YXZ rotation. */
export function composeE(out: Affine, p: Affine, tx: number, ty: number, tz: number, x: number, y: number, z: number): Affine {
  return compose(out, p, tx, ty, tz, rotYXZ(R, x, y, z));
}

/** compose() with Rz · Rx (used for thighs so IK can tilt the knee plane). */
export function composeZX(out: Affine, p: Affine, tx: number, ty: number, tz: number, z: number, x: number): Affine {
  return compose(out, p, tx, ty, tz, rotZX(R, z, x));
}

/** Writes `m · diag(sx, sy, sz)` as a column-major 4×4 (three.js layout) at dst[o…o+15]. */
export function writeMatrix(dst: Float32Array, o: number, m: Affine, sx: number, sy: number, sz: number): void {
  dst[o] = m[0] * sx;
  dst[o + 1] = m[4] * sx;
  dst[o + 2] = m[8] * sx;
  dst[o + 3] = 0;
  dst[o + 4] = m[1] * sy;
  dst[o + 5] = m[5] * sy;
  dst[o + 6] = m[9] * sy;
  dst[o + 7] = 0;
  dst[o + 8] = m[2] * sz;
  dst[o + 9] = m[6] * sz;
  dst[o + 10] = m[10] * sz;
  dst[o + 11] = 0;
  dst[o + 12] = m[3];
  dst[o + 13] = m[7];
  dst[o + 14] = m[11];
  dst[o + 15] = 1;
}
