import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_OPTIONS } from '../src/core/cost';
import { buildGraph } from '../src/core/graph';
import { sampleKeyframes } from '../src/core/keyframes';
import { planRoute } from '../src/core/planner';
import type { Footprint } from '../src/core/types';
import { umeda } from '../src/data/umeda';
import { buildCity } from '../src/render/city';
import { fadeTarget, makePrism } from '../src/render/city-layout';
import { buildStations } from '../src/render/station';
import {
  cameraTag,
  chasePose,
  CollisionWorld,
  createPose,
  createRig,
  EYE_H,
  firstPersonPose,
  orbitPose,
  PIVOT_H,
  type Shaft,
  type WalkCameraPose,
} from '../src/render/walk-camera';
import { buildWalkway, headingBetween, liftShafts, verticalLaneOffsets } from '../src/render/walkway';
import { angleDelta } from '../src/render/walkway-util';
import { segTri, Soup, type Tri } from './support/soup';

/**
 * The walk-through camera never looks through a wall (「館内を歩いてる時は壁のすり抜けが起きない
 * ように」): build the walk-mode scene exactly as the view does, walk every edge of the network the
 * way the walker does, run the chase camera along it with the view's own solver and check, against
 * an independent triangle soup of everything solid, that
 *   - the arm from the walker's upper body to the camera crosses nothing,
 *   - the near-plane rectangle (and the lens's reach to it) touches nothing,
 *   - the camera is under the local ceiling, not above it,
 *   - the camera is never in a lift shaft (the cabins run there),
 *   - the walker stays in sight: the figure is shown and nothing opaque stands between the
 *     camera and his upper body or waist (glass is see-through).
 * Where the walker stands in a lift shaft the camera waits on the landing outside and looks in
 * through the shaft's glass, which then counts for none of these. Where it is boxed in (a dead end
 * right behind) it slides to the eye and fades the figure out: that counts as out of sight.
 * The previous camera (8 behind, 3.4 up, lifted over the flight behind) is measured the same way
 * for comparison.
 */

const EX = 1.5;
const Y = (y: number) => y * EX;
const FLOOR_LIFT = 0.09;
const FOV = 42;
const ASPECT = 16 / 9;
/** Downward-facing surfaces that make a roof over the walker (seen from above = camera outside). */
const ROOFISH = /^(ceilings|station-structure|station-shell|city-[a-z]+-solid)$/;
/** See-through surfaces (they stop the camera but not the view). */
const SEE_THROUGH = /^(glass|station-glass)$/;

interface Stats {
  samples: number;
  /** Samples where the walker's own body crosses a solid (data fault; see armHit). */
  body: number;
  /** Arm (upper body → camera) through a solid. */
  arm: number;
  /** Near-plane rectangle touching a solid. */
  lens: number;
  /** Camera above a ceiling / roof (seen from outside). */
  ceiling: number;
  /** Camera in a lift shaft. */
  shaft: number;
  /** Figure shown but something opaque between the camera and its upper body or waist. */
  occluded: number;
  /** Camera boxed in: at the eye with the figure faded out (riding a lift / elsewhere). */
  fadedLift: number;
  faded: number;
  armLen: number;
}

const newStats = (): Stats => ({ samples: 0, body: 0, arm: 0, lens: 0, ceiling: 0, shaft: 0, occluded: 0, fadedLift: 0, faded: 0, armLen: 0 });

const g = buildGraph(umeda.network);
/** Routes played frame after frame: lifts (lobbies, doors, rides), the GFO deck stairs, the long underground walks. */
const PLAYED = [
  { name: 'JR7-8→うめきた段差なし', from: { stationId: 'jr', platformId: 'jr-7-8' }, to: { stationId: 'umekita' }, profile: 'stepfree' as const },
  { name: 'うめきた→阪急', from: { stationId: 'umekita' }, to: { stationId: 'hankyu' }, profile: 'standard' as const },
];
let world: CollisionWorld;
let after: Stats;
let before: Stats;
/** The chase camera played frame after frame along whole routes. */
let played: Stats;
let firstFail = 0;
let orbitFail = 0;
let orbitSamples = 0;
let solveMs = 0;
let solves = 0;
let rideSamples = 0;
const examples: string[] = [];
/** Collision tags the world was built from (a renamed mesh must not silently drop out). */
let tags = new Set<string>();
let hasViaducts = false;

beforeAll(() => {
  const walk = buildWalkway(g, { Y, ex: EX, dark: false, levelVisible: () => true });
  const st = buildStations(g.net, { Y, ex: EX, dark: false, levelVisible: () => true, walk: true });
  const city = buildCity(g.net, { dark: false, night: false, ex: EX, walk: true });
  // As the view builds it: the walk scene, the city at rest (kept per city) and the lift shafts.
  world = CollisionWorld.join([CollisionWorld.fromScene([walk, st]), CollisionWorld.fromScene(city.solidMeshes())]);
  const shafts = liftShafts(walk);
  world.shafts = shafts;
  // The independent soup reads the drawn scene (a fresh city is at rest).
  const roots = [walk, st, city.object];
  const soup = new Soup();
  for (const o of roots) soup.addObject(o, (m) => cameraTag(m));
  tags = new Set(soup.tris.map((t) => t.tag));
  hasViaducts = !!city.object.getObjectByName('city-viaducts');
  // The soup's plan grid leaves out huge triangles (ground slabs): test those one by one.
  const inGrid = new Uint8Array(soup.tris.length);
  for (const ids of soup.grid.values()) for (const id of ids) inGrid[id] = 1;
  const big = soup.tris.filter((_, i) => !inGrid[i]);
  /** The shaft the walker stands in (its glass is looked through), per sample. */
  let own: Shaft | null = null;
  const ownGlass = (t: Tri) => !!own && t.tag === 'glass' && [t.a, t.b, t.c].every((v) => Math.hypot(v.x - own!.x, v.z - own!.z) <= own!.half * Math.SQRT2 + 0.06);
  const hit = (p: THREE.Vector3, q: THREE.Vector3, opaque = false): { tri: Tri; f: number } | null => {
    const keep = (t: Tri) => !ownGlass(t) && !(opaque && SEE_THROUGH.test(t.tag));
    let best = soup.hit(p, q, keep);
    for (const t of big) {
      if (!keep(t)) continue;
      const f = segTri(p, q, t);
      if (f !== null && (!best || f < best.f)) best = { tri: t, f };
    }
    return best;
  };
  /** Camera inside a shaft's glass box (the cabins run there). */
  const inShaft = (p: THREE.Vector3) =>
    shafts.some((s) => {
      if (p.y < s.y0 || p.y > s.y1) return false;
      const dx = p.x - s.x;
      const dz = p.z - s.z;
      const u = dx * Math.sin(s.yaw) + dz * Math.cos(s.yaw);
      const v = -dx * Math.cos(s.yaw) + dz * Math.sin(s.yaw);
      return Math.abs(u) < s.half && Math.abs(v) < s.half;
    });

  const cam = new THREE.PerspectiveCamera(FOV, ASPECT, 0.1, 5000);
  const corners = [new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, -1, -1), new THREE.Vector3(1, 1, -1), new THREE.Vector3(-1, 1, -1)];
  const cw = corners.map(() => new THREE.Vector3());
  /** Near-plane rectangle, the lens's reach to its corners and its diagonals: all clear? */
  const lensClear = (pos: THREE.Vector3, target: THREE.Vector3, near: number): boolean => {
    cam.near = near;
    cam.updateProjectionMatrix();
    cam.position.copy(pos);
    cam.lookAt(target);
    cam.updateMatrixWorld(true);
    corners.forEach((c, i) => cw[i].copy(c).unproject(cam));
    const o = own;
    own = null; // (the near plane keeps clear of the lift's glass too)
    let ok = true;
    for (let i = 0; i < 4 && ok; i++) {
      if (hit(pos, cw[i]) || hit(cw[i], cw[(i + 1) % 4])) ok = false;
    }
    ok = ok && !hit(cw[0], cw[2]) && !hit(cw[1], cw[3]);
    own = o;
    return ok;
  };
  const down = new THREE.Vector3();
  const underCeiling = (pos: THREE.Vector3): boolean => {
    const h = hit(pos, down.copy(pos).setY(pos.y - 40));
    return !(h && h.tri.n.y < -0.5 && ROOFISH.test(h.tri.tag));
  };
  const pivot = new THREE.Vector3();
  const waist = new THREE.Vector3();
  const feet = new THREE.Vector3();
  const crown = new THREE.Vector3();
  /**
   * Whether the walker's own body (a vertical line from the knees to the crown) crosses a solid:
   * a network / walkway geometry fault the camera can only work around (walk-geometry.test.ts
   * counts those), so the hop from the nominal pivot to the one the solver used is not checked.
   */
  let bodyBlocked = false;
  /** Sight line from the walker's upper body to the camera, via the solver's (eased) pivot. */
  const armHit = (from: THREE.Vector3, via: THREE.Vector3 | null, to: THREE.Vector3, opaque = false) => {
    if (via && via.distanceTo(from) > 0.8) return { tri: { tag: 'pivot-far' } as Tri, f: 0 };
    return (via && !bodyBlocked && via.distanceToSquared(from) > 1e-8 ? hit(from, via, opaque) : null) ?? hit(via ?? from, to, opaque);
  };
  let inLift = false;
  const measure = (s: Stats, w: THREE.Vector3, pose: { pos: THREE.Vector3; target: THREE.Vector3; near: number; figure: number; pivot?: THREE.Vector3 }, label: string) => {
    s.samples++;
    if (bodyBlocked) s.body++;
    pivot.copy(w).setY(w.y + PIVOT_H);
    waist.copy(w).setY(w.y + 1.0);
    const arm = pose.pos.distanceTo(pivot);
    s.armLen += arm;
    const bad: string[] = [];
    const a = armHit(pivot, pose.pivot ?? null, pose.pos);
    if (a) {
      s.arm++;
      bad.push(`arm:${a.tri.tag}`);
    }
    if (!lensClear(pose.pos, pose.target, pose.near)) {
      s.lens++;
      bad.push('lens');
    }
    // (Only where the walker himself stands under a ceiling, i.e. not over a gap in the floor.)
    if (!underCeiling(pose.pos) && underCeiling(pivot)) {
      s.ceiling++;
      bad.push('ceiling');
    }
    if (inShaft(pose.pos)) {
      s.shaft++;
      bad.push('shaft');
    }
    if (pose.figure < 0.5) {
      if (inLift) s.fadedLift++;
      else s.faded++;
    } else if (armHit(pivot, pose.pivot ?? null, pose.pos, true) || hit(pose.pos, waist, true)) s.occluded++;
    if (bad.length && examples.length < 8 && label) examples.unshift(`${label} ${bad.join(',')}`);
  };

  const lanes = verticalLaneOffsets(g);
  /** Direction of the first walk edge at node ni with some run: into it (`into`), else out of it. */
  const walkDir = (ni: number, into: boolean): number => {
    const n = g.nodes[ni];
    for (const e of g.edges) {
      if (e.kind !== 'walk' || (e.a !== n.id && e.b !== n.id)) continue;
      const o = g.nodes[g.nodeIndex.get(e.a === n.id ? e.b : e.a)!];
      if (Math.hypot(o.x - n.x, o.z - n.z) > 0.3) return into ? Math.atan2(n.x - o.x, n.z - o.z) : Math.atan2(o.x - n.x, o.z - n.z);
    }
    return 0;
  };
  after = newStats();
  before = newStats();
  const rig = createRig();
  const orbitRig = createRig();
  const pose: WalkCameraPose = createPose();
  const fp: WalkCameraPose = createPose();
  const op: WalkCameraPose = createPose();
  const w = new THREE.Vector3();
  const soon = new THREE.Vector3();
  const tgt = new THREE.Vector3();
  const wanted = new THREE.Vector3();

  g.edges.forEach((e, ei) => {
    const ia = g.nodeIndex.get(e.a)!;
    const ib = g.nodeIndex.get(e.b)!;
    const na = g.nodes[ia];
    const nb = g.nodes[ib];
    const lift = FLOOR_LIFT + (e.kind === 'stairs' ? 0.09 * EX : e.kind === 'escalator' ? 0.35 : 0);
    const A = new THREE.Vector3(na.x + lanes[ei * 2], Y(na.y) + lift, na.z + lanes[ei * 2 + 1]);
    const B = new THREE.Vector3(nb.x + lanes[ei * 2], Y(nb.y) + lift, nb.z + lanes[ei * 2 + 1]);
    const run = Math.hypot(B.x - A.x, B.z - A.z);
    // Riding a lift the view looks the way he will walk out (lookaheadHeading).
    const heading = run > 0.3 ? Math.atan2(B.x - A.x, B.z - A.z) : e.kind === 'elevator' ? walkDir(ib, false) : walkDir(ia, true);
    const slope = run > 0.3 ? (B.y - A.y) / run : 0;
    const ride = e.kind === 'elevator' ? { from: A.y, to: B.y } : null;
    const len = A.distanceTo(B);
    const n = Math.max(1, Math.min(60, Math.ceil(len / 1.5)));
    const step = len / n;
    const speed = e.kind === 'walk' || e.kind === 'crossing' || e.kind === 'gate' ? 1.3 : 0.6;
    rig.ready = false;
    orbitRig.ready = false;
    inLift = e.kind === 'elevator';
    for (let i = 0; i <= n; i++) {
      w.copy(A).lerp(B, i / n);
      const label = `${e.id}@${(i / n).toFixed(2)}`;
      bodyBlocked = !!hit(feet.copy(w).setY(w.y + 0.5), crown.copy(w).setY(w.y + 2.2));
      pivot.copy(w).setY(w.y + PIVOT_H);
      own = shafts.find((s) => pivot.y > s.y0 && pivot.y < s.y1 && Math.hypot(pivot.x - s.x, pivot.z - s.z) < s.half) ?? null;
      if (ride) rideSamples++;
      // After: the view's solver, run continuously along the edge.
      const t0 = performance.now();
      soon.copy(A).lerp(B, Math.min(1, (i + 1) / n));
      chasePose(world, { walker: w, heading, slopeBehind: -slope, slopeAhead: slope, aspect: ASPECT, fov: FOV, ahead: soon, ride }, rig, i === 0 ? 0 : step / speed, pose);
      solveMs += performance.now() - t0;
      solves++;
      measure(after, w, pose, label);
      // Before (every other sample): fixed offset behind and above, lifted over the flight behind.
      const fx = Math.sin(heading);
      const fz = Math.cos(heading);
      if (i % 2 === 0) {
        const behindY = A.y + (w.y - A.y) * Math.max(0, 1 - 7.8 / Math.max(1e-3, (i / n) * len));
        const bpos = new THREE.Vector3(w.x - fx * 8, Math.max(w.y + 3.4, behindY - lift + 2.6), w.z - fz * 8);
        const o = own;
        own = null;
        measure(before, w, { pos: bpos, target: tgt.set(w.x + fx * 7, w.y + 1, w.z + fz * 7), near: 0.3, figure: 1 }, '');
        own = o;
      }
      // First person: eye and near plane clear.
      if (i % 3 === 0) {
        firstPersonPose(world, w, tgt.set(w.x + fx * 14, w.y + EYE_H - 1.2 + slope * 14 * 0.7, w.z + fz * 14), FOV, ASPECT, fp);
        const o = own;
        own = null;
        if (armHit(pivot.copy(w).setY(w.y + EYE_H), fp.pivot, fp.pos) || !lensClear(fp.pos, fp.target, fp.near)) {
          firstFail++;
          if (examples.length < 16) examples.push(`first ${label}`);
        }
        own = o;
        // Orbit: the user drags the camera 12 m out in some direction; it must be pulled in.
        const yaw = (ei * 2.39996 + i) % (Math.PI * 2);
        const pitch = -0.2 + ((ei * 7 + i * 3) % 10) / 10;
        wanted.set(w.x + Math.sin(yaw) * Math.cos(pitch) * 12, w.y + PIVOT_H + Math.sin(pitch) * 12, w.z + Math.cos(yaw) * Math.cos(pitch) * 12);
        orbitPose(world, w, wanted, orbitRig, 0, FOV, ASPECT, op, ride, heading);
        orbitSamples++;
        if (armHit(pivot.copy(w).setY(w.y + PIVOT_H), op.pivot, op.pos) || !lensClear(op.pos, op.pivot, op.near) || inShaft(op.pos)) {
          orbitFail++;
          if (examples.length < 16) examples.push(`orbit ${label}`);
        }
      }
    }
  });

  // Whole routes played the way the view plays them (×4 at 60 fps): the arm keeps its state
  // from one edge to the next, so corners, lift doors, rides and U-turns come as they come.
  played = newStats();
  const RATE = 4;
  const FPS = 60;
  for (const q of PLAYED) {
    const r = planRoute(g, { from: q.from, to: q.to, options: { ...DEFAULT_OPTIONS, profile: q.profile, congestion: false }, boarding: 'best', alternatives: 1 }).routes[0];
    const kf = r.keyframes;
    // Keyframe segment → edge (waits have none), as the view maps them.
    const segEdge = new Int32Array(Math.max(0, kf.length - 1)).fill(-1);
    for (let i = 0, s = 0; i + 1 < kf.length; i++) {
      const a = kf[i];
      const b = kf[i + 1];
      if ((a.x !== b.x || a.y !== b.y || a.z !== b.z) && s < r.path.steps.length) segEdge[i] = r.path.steps[s++].edge;
    }
    const segAt = (t: number) => {
      let k = 0;
      while (k + 2 < kf.length && kf[k + 1].t <= t) k++;
      return k;
    };
    const at = (t: number) => sampleKeyframes(kf, t);
    const lookahead = (t: number): number | null => {
      const p0 = at(t);
      for (const d of [2, 5, 10, 20]) {
        const h = headingBetween(p0, at(t + d));
        if (h !== null) return h;
      }
      return headingBetween(at(t - 5), p0);
    };
    const prig = createRig();
    const off = { x: 0, z: 0 };
    let flight = 0;
    let heading = lookahead(0) ?? 0;
    const step = RATE / FPS;
    const ahead = new THREE.Vector3();
    for (let t = 0, f = 0; t <= r.timeS; t += step, f++) {
      const p = at(t);
      const k = segAt(t);
      const ei = segEdge[k];
      const kind = ei >= 0 ? g.edges[ei].kind : null;
      const e = f === 0 ? 1 : 1 - Math.exp(-step / 0.6);
      off.x += ((ei >= 0 ? lanes[ei * 2] : 0) - off.x) * e;
      off.z += ((ei >= 0 ? lanes[ei * 2 + 1] : 0) - off.z) * e;
      flight += ((kind === 'stairs' ? 0.09 * EX : kind === 'escalator' ? 0.35 : 0) - flight) * (f === 0 ? 1 : 1 - Math.exp(-step / 0.25));
      const base = FLOOR_LIFT + flight;
      w.set(p.x + off.x, Y(p.y) + base, p.z + off.z);
      const h = lookahead(t);
      if (h !== null) heading += angleDelta(heading, h) * Math.min(1, (1 / FPS) * 2.4);
      const headingSoon = h === null ? heading : heading + angleDelta(heading, h) * (1 - Math.exp(-0.35 * 2.4));
      const p0 = p;
      const pb = at(t - 2.5);
      const pa = at(t + 2.5);
      const rb = Math.hypot(pb.x - p0.x, pb.z - p0.z);
      const ra = Math.hypot(pa.x - p0.x, pa.z - p0.z);
      const slopeBehind = rb > 0.4 ? (Y(pb.y) - Y(p0.y)) / rb : 0;
      const slopeAhead = ra > 0.4 ? (Y(pa.y) - Y(p0.y)) / ra : 0;
      const sn = at(t + RATE * 0.4);
      ahead.set(sn.x + off.x, Y(sn.y) + base, sn.z + off.z);
      const ride = kind === 'elevator' ? { from: Y(kf[k].y) + base, to: Y(kf[k + 1].y) + base } : null;
      chasePose(world, { walker: w, heading, headingSoon, slopeBehind, slopeAhead, aspect: ASPECT, fov: FOV, ahead, ride }, prig, f === 0 ? 0 : 1 / FPS, pose);
      if (f % 2) continue;
      bodyBlocked = !!hit(feet.copy(w).setY(w.y + 0.5), crown.copy(w).setY(w.y + 2.2));
      pivot.copy(w).setY(w.y + PIVOT_H);
      own = shafts.find((s) => pivot.y > s.y0 && pivot.y < s.y1 && Math.hypot(pivot.x - s.x, pivot.z - s.z) < s.half) ?? null;
      inLift = kind === 'elevator';
      measure(played, w, pose, `${q.name}@${t.toFixed(1)}`);
    }
  }
  own = null;
  const pct = (s: Stats, k: number) => `${((100 * k) / s.samples).toFixed(2)}%`;
  const line = (name: string, s: Stats) =>
    `${name}: ${s.samples} samples (walker's body in a solid: ${s.body}), arm through a solid ${pct(s, s.arm)}, near plane clipped ${pct(s, s.lens)}, above a ceiling ${pct(s, s.ceiling)}, in a lift shaft ${pct(s, s.shaft)}, walker out of sight ${pct(s, s.occluded + s.faded + s.fadedLift)} (occluded ${pct(s, s.occluded)}, eye fallback ${pct(s, s.faded)}, riding a lift ${pct(s, s.fadedLift)}), mean arm ${(s.armLen / s.samples).toFixed(2)}`;
  console.log(`[walk-camera] world ${world.triangles} triangles, built in ${world.buildMs.toFixed(0)} ms; ${shafts.length} lift shafts; chase solve ${((solveMs / solves) * 1000).toFixed(0)} µs`);
  console.log(`[walk-camera] ${line('before', before)}`);
  console.log(`[walk-camera] ${line('after', after)}`);
  console.log(`[walk-camera] ${line('played along routes', played)}`);
  console.log(`[walk-camera] ${rideSamples} samples riding a lift; first person fails ${firstFail}, orbit fails ${orbitFail}/${orbitSamples}`);
  if (examples.length) console.log(`[walk-camera] e.g. ${examples.join(' | ')}`);
}, 300_000);

describe('walk-through camera', () => {
  it('keeps the chase arm and the near plane out of every solid', () => {
    expect(after.arm).toBe(0);
    expect(after.lens).toBe(0);
  });

  it('stays under the local ceiling and out of lift shafts', () => {
    expect(after.ceiling).toBe(0);
    expect(after.shaft).toBe(0);
  });

  it('keeps the walker in sight', () => {
    // Shown and unobstructed in ≥ 99 % of samples: every sample where he is hidden counts
    // (something opaque in between, the figure faded at the eye fallback, riding a lift).
    expect((after.occluded + after.faded + after.fadedLift) / after.samples).toBeLessThanOrEqual(0.01);
    expect(rideSamples).toBeGreaterThan(200);
  });

  it('keeps it all up frame after frame along whole routes', () => {
    expect(played.samples).toBeGreaterThan(4000);
    expect(played.arm).toBe(0);
    expect(played.lens).toBe(0);
    expect(played.ceiling).toBe(0);
    expect(played.shaft).toBe(0);
    expect((played.occluded + played.faded + played.fadedLift) / played.samples).toBeLessThanOrEqual(0.01);
  });

  it('keeps the first-person eye and the orbit view clear of walls too', () => {
    expect(firstFail).toBe(0);
    expect(orbitFail).toBe(0);
  });

  it('collides with the walkway, the stations and the city alike', () => {
    for (const t of ['walls', 'ceilings', 'glass', 'stairs', 'floor-tile', 'station-structure', 'city-ground']) expect(tags.has(t), t).toBe(true);
    expect([...tags].some((t) => /^city-[a-z]+-solid$/.test(t))).toBe(true);
    // Elevated expressways (decks and piers) where the city has them.
    expect(tags.has('city-viaducts')).toBe(hasViaducts);
    expect(world.shafts.length).toBeGreaterThan(40);
  });

  it('solves a frame well within budget', () => {
    expect(solveMs / solves).toBeLessThan(1);
    expect(world.triangles).toBeGreaterThan(50_000);
  });
});

describe('collision world and the city cut-away', () => {
  const city = buildCity(g.net, { dark: false, night: false, ex: EX, walk: true });
  const yodo = g.net.footprints.find((f) => f.source === 'osm' && f.kind === 'building' && f.nameJa === 'ヨドバシ梅田タワー') as Footprint;
  const [cx, cz] = yodo.poly.reduce(([x, z], [px, pz]) => [x + px / yodo.poly.length, z + pz / yodo.poly.length], [0, 0]);
  /** Height of the first solid straight below (cx, 400, cz). */
  const roofUnder = (wd: CollisionWorld) => 400 - wd.raycast(cx, 400, cz, 0, -1, 0, 500);

  it('keeps every building solid for the camera, whatever is cut away when the walk scene is rebuilt', () => {
    const fresh = CollisionWorld.fromScene(city.solidMeshes());
    const liveFresh = CollisionWorld.fromScene([city.object]);
    const roof = roofUnder(fresh);
    expect(roof).toBeGreaterThan(20);
    // Camera north of ヨドバシ, walker south of it: the tower is cut away.
    const cam = new THREE.PerspectiveCamera();
    cam.position.set(49, 20, -330);
    cam.updateMatrixWorld();
    for (let i = 0; i < 40; i++) city.update(cam, new THREE.Vector3(49, 0, -110), 1 / 30);
    expect(city.buildingFade(yodo.id) as number).toBeLessThan(0.2);
    // A walk-scene rebuild now: the city part is the building at rest, all of it.
    const rebuilt = CollisionWorld.fromScene(city.solidMeshes());
    expect(rebuilt.triangles).toBe(fresh.triangles);
    expect(roofUnder(rebuilt)).toBeCloseTo(roof, 3);
    // The drawn passes are read only as far as they are drawn (no stale tail of the index):
    // the faded tower has left the opaque pass and nothing else came in its place.
    const live = CollisionWorld.fromScene([city.object]);
    expect(live.triangles).toBeLessThan(liveFresh.triangles);
    expect(roofUnder(live)).toBeLessThan(roof - 5);
  }, 60_000);

  it('cuts away only along the sight line once the camera keeps out of solids itself', () => {
    const box = makePrism([[-10, -5], [10, -5], [10, 5], [-10, 5]], [], 0, 50);
    // Camera 1 m off the facade, walker beside it: faded for the old camera, solid now.
    const at = (solidCamera: boolean) => fadeTarget([box], { camera: { x: 11, y: 2, z: 0 }, focus: { x: 11, y: 1.5, z: 8 }, route: [], walk: true, solidCamera });
    expect(at(false)).toBeLessThan(0.2);
    expect(at(true)).toBe(1);
    // Still cut away between the camera and the walker, and around a walker inside.
    expect(fadeTarget([box], { camera: { x: -30, y: 8, z: 0 }, focus: { x: 30, y: 1.5, z: 0 }, route: [], walk: true, solidCamera: true })).toBeLessThan(0.2);
    expect(fadeTarget([box], { camera: { x: 0, y: 3, z: -8 }, focus: { x: 0, y: 1.5, z: 0 }, route: [], walk: true, solidCamera: true })).toBeLessThan(0.2);
  });
});
