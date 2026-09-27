import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../src/core/graph';
import { umeda } from '../src/data/umeda';
import { buildCity } from '../src/render/city';
import { buildStations } from '../src/render/station';
import { cameraTag, chasePose, CollisionWorld, createPose, createRig, EYE_H, firstPersonPose, orbitPose, PIVOT_H, type WalkCameraPose } from '../src/render/walk-camera';
import { buildWalkway, verticalLaneOffsets } from '../src/render/walkway';
import { segTri, Soup, type Tri } from './support/soup';

/**
 * The walk-through camera never looks through a wall (「館内を歩いてる時は壁のすり抜けが起きない
 * ように」): build the walk-mode scene exactly as the view does, walk every edge of the network the
 * way the walker does, run the chase camera along it with the view's own solver and check, against
 * an independent triangle soup of everything solid, that
 *   - the arm from the walker's upper body to the camera crosses nothing,
 *   - the near-plane rectangle (and the lens's reach to it) touches nothing,
 *   - the camera is under the local ceiling, not above it,
 *   - the walker stays in sight: nothing solid between the camera and the upper body or waist.
 * Where the camera is boxed in (a 2.4 m glass lift shaft, a dead end right behind) it slides to
 * the eye and fades the figure out instead; those samples are counted separately.
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
  /** Figure shown but a solid between the camera and its upper body or waist. */
  occluded: number;
  /** Camera boxed in: at the eye with the figure faded out (in lift shafts / elsewhere). */
  fadedLift: number;
  faded: number;
  armLen: number;
}

const newStats = (): Stats => ({ samples: 0, body: 0, arm: 0, lens: 0, ceiling: 0, occluded: 0, fadedLift: 0, faded: 0, armLen: 0 });

const g = buildGraph(umeda.network);
let world: CollisionWorld;
let after: Stats;
let before: Stats;
let firstFail = 0;
let orbitFail = 0;
let orbitSamples = 0;
let solveMs = 0;
let solves = 0;
const examples: string[] = [];
/** Collision tags the world was built from (a renamed mesh must not silently drop out). */
let tags = new Set<string>();

beforeAll(() => {
  const walk = buildWalkway(g, { Y, ex: EX, dark: false, levelVisible: () => true });
  const st = buildStations(g.net, { Y, ex: EX, dark: false, levelVisible: () => true, walk: true });
  const city = buildCity(g.net, { dark: false, night: false, ex: EX, walk: true });
  const roots = [walk, st, city.object];
  world = CollisionWorld.fromScene(roots);
  const soup = new Soup();
  for (const o of roots) soup.addObject(o, (m) => cameraTag(m));
  tags = new Set(soup.tris.map((t) => t.tag));
  // The soup's plan grid leaves out huge triangles (ground slabs): test those one by one.
  const inGrid = new Uint8Array(soup.tris.length);
  for (const ids of soup.grid.values()) for (const id of ids) inGrid[id] = 1;
  const big = soup.tris.filter((_, i) => !inGrid[i]);
  const hit = (p: THREE.Vector3, q: THREE.Vector3): { tri: Tri; f: number } | null => {
    let best = soup.hit(p, q, () => true);
    for (const t of big) {
      const f = segTri(p, q, t);
      if (f !== null && (!best || f < best.f)) best = { tri: t, f };
    }
    return best;
  };

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
    for (let i = 0; i < 4; i++) {
      if (hit(pos, cw[i]) || hit(cw[i], cw[(i + 1) % 4])) return false;
    }
    return !hit(cw[0], cw[2]) && !hit(cw[1], cw[3]);
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
  const armHit = (from: THREE.Vector3, via: THREE.Vector3 | null, to: THREE.Vector3) => {
    if (via && via.distanceTo(from) > 0.8) return { tri: { tag: 'pivot-far' } as Tri, f: 0 };
    return (via && !bodyBlocked && via.distanceToSquared(from) > 1e-8 ? hit(from, via) : null) ?? hit(via ?? from, to);
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
    if (pose.figure < 0.5) {
      if (inLift) s.fadedLift++;
      else s.faded++;
    } else if (a || hit(pose.pos, waist)) s.occluded++;
    if (bad.length && examples.length < 8 && label) examples.unshift(`${label} ${bad.join(',')}`);
  };

  const lanes = verticalLaneOffsets(g);
  const approach = (ni: number): number => {
    const n = g.nodes[ni];
    for (const e of g.edges) {
      if (e.kind !== 'walk' || (e.a !== n.id && e.b !== n.id)) continue;
      const o = g.nodes[g.nodeIndex.get(e.a === n.id ? e.b : e.a)!];
      if (Math.hypot(o.x - n.x, o.z - n.z) > 0.3) return Math.atan2(n.x - o.x, n.z - o.z);
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
    const na = g.nodes[ia];
    const nb = g.nodes[g.nodeIndex.get(e.b)!];
    const lift = FLOOR_LIFT + (e.kind === 'stairs' ? 0.09 * EX : e.kind === 'escalator' ? 0.35 : 0);
    const A = new THREE.Vector3(na.x + lanes[ei * 2], Y(na.y) + lift, na.z + lanes[ei * 2 + 1]);
    const B = new THREE.Vector3(nb.x + lanes[ei * 2], Y(nb.y) + lift, nb.z + lanes[ei * 2 + 1]);
    const run = Math.hypot(B.x - A.x, B.z - A.z);
    const heading = run > 0.3 ? Math.atan2(B.x - A.x, B.z - A.z) : approach(ia);
    const slope = run > 0.3 ? (B.y - A.y) / run : 0;
    const len = A.distanceTo(B);
    const n = Math.max(1, Math.min(80, Math.ceil(len / 1.0)));
    const step = len / n;
    const speed = e.kind === 'walk' || e.kind === 'crossing' || e.kind === 'gate' ? 1.3 : 0.6;
    rig.ready = false;
    orbitRig.ready = false;
    inLift = e.kind === 'elevator';
    for (let i = 0; i <= n; i++) {
      w.copy(A).lerp(B, i / n);
      const label = `${e.id}@${(i / n).toFixed(2)}`;
      bodyBlocked = !!hit(feet.copy(w).setY(w.y + 0.5), crown.copy(w).setY(w.y + 2.2));
      // After: the view's solver, run continuously along the edge.
      const t0 = performance.now();
      soon.copy(A).lerp(B, Math.min(1, (i + 1) / n));
      chasePose(world, { walker: w, heading, slopeBehind: -slope, slopeAhead: slope, aspect: ASPECT, fov: FOV, ahead: soon }, rig, i === 0 ? 0 : step / speed, pose);
      solveMs += performance.now() - t0;
      solves++;
      measure(after, w, pose, label);
      // Before: fixed offset behind and above, lifted over the flight behind.
      const fx = Math.sin(heading);
      const fz = Math.cos(heading);
      const behindY = A.y + (w.y - A.y) * Math.max(0, 1 - 7.8 / Math.max(1e-3, (i / n) * len));
      const bpos = new THREE.Vector3(w.x - fx * 8, Math.max(w.y + 3.4, behindY - lift + 2.6), w.z - fz * 8);
      measure(before, w, { pos: bpos, target: tgt.set(w.x + fx * 7, w.y + 1, w.z + fz * 7), near: 0.3, figure: 1 }, '');
      // First person: eye and near plane clear.
      if (i % 4 === 0) {
        firstPersonPose(world, w, tgt.set(w.x + fx * 14, w.y + 1.6 * 1.25 - 1.2 + slope * 14 * 0.7, w.z + fz * 14), FOV, ASPECT, fp);
        if (armHit(pivot.copy(w).setY(w.y + EYE_H), fp.pivot, fp.pos) || !lensClear(fp.pos, fp.target, fp.near)) {
          firstFail++;
          if (examples.length < 16) examples.push(`first ${label}`);
        }
        // Orbit: the user drags the camera 12 m out in some direction; it must be pulled in.
        const yaw = (ei * 2.39996 + i) % (Math.PI * 2);
        const pitch = -0.2 + ((ei * 7 + i * 3) % 10) / 10;
        wanted.set(w.x + Math.sin(yaw) * Math.cos(pitch) * 12, w.y + PIVOT_H + Math.sin(pitch) * 12, w.z + Math.cos(yaw) * Math.cos(pitch) * 12);
        orbitPose(world, w, wanted, orbitRig, 0, FOV, ASPECT, op);
        orbitSamples++;
        if (armHit(pivot.copy(w).setY(w.y + PIVOT_H), op.pivot, op.pos) || !lensClear(op.pos, op.pivot, op.near)) {
          orbitFail++;
          if (examples.length < 16) examples.push(`orbit ${label}`);
        }
      }
    }
  });
  const pct = (s: Stats, k: number) => `${((100 * k) / s.samples).toFixed(2)}%`;
  const line = (name: string, s: Stats) =>
    `${name}: ${s.samples} samples (walker's body in a solid: ${s.body}), arm through a solid ${pct(s, s.arm)}, near plane clipped ${pct(s, s.lens)}, above a ceiling ${pct(s, s.ceiling)}, walker occluded ${pct(s, s.occluded)}, eye fallback ${pct(s, s.faded)} (+ lift shafts ${pct(s, s.fadedLift)}), mean arm ${(s.armLen / s.samples).toFixed(2)}`;
  console.log(`[walk-camera] world ${world.triangles} triangles, built in ${world.buildMs.toFixed(0)} ms; chase solve ${((solveMs / solves) * 1000).toFixed(0)} µs`);
  console.log(`[walk-camera] ${line('before', before)}`);
  console.log(`[walk-camera] ${line('after', after)}`);
  console.log(`[walk-camera] first person fails ${firstFail}, orbit fails ${orbitFail}/${orbitSamples}`);
  if (examples.length) console.log(`[walk-camera] e.g. ${examples.join(' | ')}`);
}, 300_000);

describe('walk-through camera', () => {
  it('keeps the chase arm and the near plane out of every solid', () => {
    expect(after.arm).toBe(0);
    expect(after.lens).toBe(0);
  });

  it('stays under the local ceiling', () => {
    expect(after.ceiling).toBe(0);
  });

  it('keeps the walker in sight', () => {
    // Nothing solid between the camera and the walker in ≥ 99 % of samples.
    expect(after.occluded / after.samples).toBeLessThanOrEqual(0.01);
    // Boxed in (dead ends, doors right behind) rarely: the eye fallback stays the exception.
    expect(after.faded / after.samples).toBeLessThanOrEqual(0.015);
  });

  it('keeps the first-person eye and the orbit view clear of walls too', () => {
    expect(firstFail).toBe(0);
    expect(orbitFail).toBe(0);
  });

  it('collides with the walkway, the stations and the city alike', () => {
    for (const t of ['walls', 'ceilings', 'glass', 'stairs', 'floor-tile', 'station-structure', 'city-ground']) expect(tags.has(t), t).toBe(true);
    expect([...tags].some((t) => /^city-[a-z]+-solid$/.test(t))).toBe(true);
  });

  it('solves a frame well within budget', () => {
    expect(solveMs / solves).toBeLessThan(1);
    expect(world.triangles).toBeGreaterThan(50_000);
  });
});
