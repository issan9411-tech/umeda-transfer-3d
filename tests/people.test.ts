import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  affine,
  BODY,
  cadence,
  Carry,
  composeE,
  composeZX,
  computePose,
  Look,
  makeLook,
  Pose,
  REFERENCE_HEIGHT,
  setRoot,
  type GaitState,
} from '../src/render/people-rig';
import { nearSightLine } from '../src/render/people';

/** Forward kinematics of leg i: ankle position in person space from the pose's angles. */
function ankleFK(p: Pose, i: number): [number, number, number] {
  const root = setRoot(affine(), 0, 0, 0, 0, 1);
  const thigh = composeZX(affine(), root, p.hip[i * 3], p.hip[i * 3 + 1], p.hip[i * 3 + 2], p.thighRoll[i], p.thighPitch[i]);
  const shin = composeE(affine(), thigh, 0, -BODY.thigh, 0, p.knee[i], 0, 0);
  const foot = composeE(affine(), shin, 0, -BODY.shin, 0, p.footPitch[i], 0, 0);
  return [foot[3], foot[7], foot[11]];
}

/** Knee position (to check that knees bend forward). */
function kneeFK(p: Pose, i: number): [number, number, number] {
  const root = setRoot(affine(), 0, 0, 0, 0, 1);
  const thigh = composeZX(affine(), root, p.hip[i * 3], p.hip[i * 3 + 1], p.hip[i * 3 + 2], p.thighRoll[i], p.thighPitch[i]);
  const shin = composeE(affine(), thigh, 0, -BODY.thigh, 0, p.knee[i], 0, 0);
  return [shin[3], shin[7], shin[11]];
}

const walk = (phase: number, speed = 1.3, extra: Partial<GaitState> = {}): GaitState => ({
  phase,
  blend: 1,
  speed,
  climb: 0,
  time: 0,
  slope: 0.7,
  ...extra,
});

describe('people rig: walk cycle', () => {
  const look = makeLook(42, new Look());
  look.carry = Carry.None;

  it('reaches every ankle target (two-bone IK) and bends knees forward', () => {
    const p = new Pose();
    for (let k = 0; k < 40; k++) {
      computePose(p, walk(k / 40), look);
      for (let i = 0; i < 2; i++) {
        const [x, y, z] = ankleFK(p, i);
        expect(Math.hypot(x - p.ankle[i * 3], y - p.ankle[i * 3 + 1], z - p.ankle[i * 3 + 2])).toBeLessThan(0.012);
        // The knee sits in front of the hip→ankle line.
        const [, ky, kz] = kneeFK(p, i);
        const hy = p.hip[i * 3 + 1];
        const hz = p.hip[i * 3 + 2];
        const t = (ky - hy) / (y - hy);
        expect(kz - (hz + (z - hz) * t)).toBeGreaterThan(-0.005);
      }
    }
  });

  it('keeps the stance foot planted while the body moves on', () => {
    // Body moves at v; the stance ankle (in world) must stay put during flat-foot stance.
    const v = 1.3;
    const cad = cadence(v, look);
    const p = new Pose();
    const worldZ: number[] = [];
    for (let ph = 0.12; ph <= 0.34; ph += 0.02) {
      computePose(p, walk(ph, v), look);
      const bodyZ = (ph / (cad / 2)) * v; // time = phase / cycle frequency
      worldZ.push(bodyZ + ankleFK(p, 0)[2]);
    }
    expect(Math.max(...worldZ) - Math.min(...worldZ)).toBeLessThan(0.02);
  });

  it('walks at a natural cadence and stride', () => {
    const avg = makeLook(7, new Look());
    avg.cadence = 1;
    expect(cadence(1.3, avg)).toBeGreaterThanOrEqual(1.8);
    expect(cadence(1.3, avg)).toBeLessThanOrEqual(2.0);
    expect(cadence(1.6, avg)).toBeGreaterThan(cadence(1.0, avg));
    const step = 1.3 / cadence(1.3, avg);
    expect(step).toBeGreaterThan(0.6);
    expect(step).toBeLessThan(0.75);
  });

  it('bobs twice per cycle by a few centimetres and swings arms against the legs', () => {
    const p = new Pose();
    const ys: number[] = [];
    for (let k = 0; k < 100; k++) ys.push(computePose(p, walk(k / 100), look).py);
    const bob = Math.max(...ys) - Math.min(...ys);
    expect(bob).toBeGreaterThan(0.02);
    expect(bob).toBeLessThan(0.08);
    // Two minima per cycle: at the two heel strikes.
    let minima = 0;
    for (let k = 0; k < 100; k++) if (ys[k] < ys[(k + 99) % 100] && ys[k] <= ys[(k + 1) % 100]) minima++;
    expect(minima).toBe(2);
    // Left heel strike: left leg forward, left arm back (Rx < 0 is a forward swing).
    computePose(p, walk(0), look);
    expect(p.ankle[2]).toBeGreaterThan(p.ankle[5]);
    expect(p.armPitch[0]).toBeGreaterThan(p.armPitch[1]);
  });

  it('stands with straight legs and both feet down when not moving', () => {
    const p = computePose(new Pose(), { ...walk(0.3, 0), blend: 0, time: 3 }, look);
    for (let i = 0; i < 2; i++) {
      expect(p.ankle[i * 3 + 1]).toBeCloseTo(BODY.ankleH, 3);
      expect(p.knee[i]).toBeLessThan(0.35);
    }
    expect(p.py).toBeGreaterThan(0.85);
  });

  it('lifts the knees higher on stairs going up', () => {
    const p = new Pose();
    let flat = 0;
    let up = 0;
    for (let k = 0; k < 50; k++) {
      flat = Math.max(flat, ...computePose(p, walk(k / 50, 0.5), look).knee);
      up = Math.max(up, ...computePose(p, walk(k / 50, 0.5, { climb: 1, slope: 0.9 }), look).knee);
    }
    expect(up).toBeGreaterThan(flat + 0.2);
  });

  it('never produces NaN, whatever the input', () => {
    const p = new Pose();
    for (const speed of [0, 0.01, 0.4, 1.3, 2.5, 6]) {
      for (const climb of [-1, 0, 1]) {
        for (const blend of [0, 0.5, 1]) {
          computePose(p, { phase: 0.37, blend, speed, climb, time: 12.3, slope: 0.9 }, look);
          for (const v of [p.px, p.py, p.pz, p.tPitch, p.hPitch, ...p.thighPitch, ...p.knee, ...p.footPitch, ...p.armPitch, ...p.elbow]) {
            expect(Number.isFinite(v)).toBe(true);
          }
        }
      }
    }
  });
});

describe('people rig: appearance', () => {
  it('is deterministic per id and varied across ids', () => {
    const a = makeLook(123, new Look());
    const b = makeLook(123, new Look());
    expect(a.height).toBe(b.height);
    expect([...a.top]).toEqual([...b.top]);
    const heights = new Set<number>();
    const tops = new Set<string>();
    let suitcases = 0;
    let bags = 0;
    const N = 2000;
    for (let id = 0; id < N; id++) {
      const l = makeLook(id, new Look());
      const h = l.height * REFERENCE_HEIGHT;
      expect(h).toBeGreaterThanOrEqual(1.55);
      expect(h).toBeLessThanOrEqual(1.85);
      heights.add(Math.round(h * 100));
      tops.add([...l.top].map((x) => x.toFixed(3)).join());
      if (l.carry === Carry.Suitcase) suitcases++;
      if (l.carry === Carry.Briefcase || l.carry === Carry.Tote || l.shoulderBag || l.backpack) bags++;
    }
    expect(heights.size).toBeGreaterThan(20);
    expect(tops.size).toBeGreaterThan(12);
    expect(suitcases / N).toBeGreaterThan(0.02);
    expect(suitcases / N).toBeLessThan(0.1);
    expect(bags / N).toBeGreaterThan(0.15);
    expect(bags / N).toBeLessThan(0.45);
  });
});

describe('PeopleCrowd', () => {
  const N = 300;
  const positions = new Float32Array(N * 3);
  const headings = new Float32Array(N);
  const speeds = new Float32Array(N);
  const ids = new Uint32Array(N);
  const climbs = new Int8Array(N);
  for (let i = 0; i < N; i++) {
    positions[i * 3] = (i % 20) * 2;
    positions[i * 3 + 1] = i % 3 === 0 ? -6 : 0;
    positions[i * 3 + 2] = Math.floor(i / 20) * 2;
    headings[i] = i * 0.37;
    speeds[i] = i % 7 === 0 ? 0 : 0.8 + (i % 5) * 0.2;
    ids[i] = 1000 + i;
    climbs[i] = i % 11 === 0 ? 1 : 0;
  }

  it('stays within the draw-call and triangle budgets', async () => {
    const { PeopleCrowd } = await import('../src/render/people');
    const crowd = new PeopleCrowd(N, { detail: 'low' });
    expect(crowd.object.children.length).toBeLessThanOrEqual(20);
    const low = crowd.trianglesPerPerson();
    crowd.update(positions, headings, speeds, N, 0.1, { Y: (y) => y, scale: 1, ids, climbs, detail: 'high' });
    const high = crowd.trianglesPerPerson();
    expect(low).toBeLessThanOrEqual(270); // 1,400 overview agents ≈ 380k triangles
    expect(high).toBeLessThanOrEqual(1000); // 350 nearest while walking ≈ 350k
    expect(high).toBeGreaterThan(low * 2);
    crowd.dispose();
  });

  it('writes finite instance matrices for every visible person and keeps ids stable', async () => {
    const { PeopleCrowd } = await import('../src/render/people');
    const crowd = new PeopleCrowd(N);
    const opts = { Y: (y: number) => y * 1.5, scale: 1.25, ids, climbs, visible: (i: number) => i % 10 !== 0 };
    for (let f = 0; f < 5; f++) crowd.update(positions, headings, speeds, N, 1 / 30, opts);
    expect(crowd.drawn).toBe(N - N / 10);
    for (const m of crowd.object.children as import('three').InstancedMesh[]) {
      const a = m.instanceMatrix.array;
      for (let i = 0; i < m.count * 16; i++) expect(Number.isFinite(a[i])).toBe(true);
    }
    // Compacting the arrays (agent 0 leaves) must not change anyone's appearance or pose phase.
    const torso = () => (crowd.object.children.find((c) => c.name === 'people-torso') as import('three').InstancedMesh).count;
    const before = torso();
    crowd.update(positions.subarray(3), headings.subarray(1), speeds.subarray(1), N - 1, 0, { ...opts, ids: ids.subarray(1), climbs: climbs.subarray(1), visible: (i) => (i + 1) % 10 !== 0 });
    expect(torso()).toBe(before);
    crowd.dispose();
  });

  it('culls by distance and caps the number drawn to the nearest', async () => {
    const THREE = await import('three');
    const { PeopleCrowd } = await import('../src/render/people');
    const crowd = new PeopleCrowd(N);
    const cam = new THREE.PerspectiveCamera(90, 1, 0.1, 1000);
    cam.position.set(20, 30, 10);
    cam.lookAt(20, 0, 10);
    cam.updateMatrixWorld();
    crowd.update(positions, headings, speeds, N, 0.1, { Y: (y) => y, scale: 1, ids, camera: cam, maxDrawn: 50 });
    expect(crowd.drawn).toBeLessThanOrEqual(50);
    expect(crowd.drawn).toBeGreaterThan(30);
    crowd.update(positions, headings, speeds, N, 0.1, { Y: (y) => y, scale: 1, ids, camera: cam, maxDistance: 5 });
    expect(crowd.drawn).toBe(0);
    crowd.dispose();
  });

  it('animates the hero walker without NaN', async () => {
    const { createWalkerFigure } = await import('../src/render/people');
    const hero = createWalkerFigure();
    for (let f = 0; f < 60; f++) hero.update(1 / 60, f < 30 ? 1.3 : 0, 0.5, f % 20 < 10 ? 1 : 0);
    let n = 0;
    hero.object.traverse((o) => {
      const m = o as import('three').InstancedMesh;
      if (!m.isInstancedMesh) return;
      n += m.count;
      for (let i = 0; i < m.count * 16; i++) expect(Number.isFinite(m.instanceMatrix.array[i])).toBe(true);
    });
    expect(n).toBeGreaterThan(12);
    hero.dispose();
  });
});

describe('sight line', () => {
  it('flags figures between the camera and the walker only', () => {
    const cam = new Vector3(0, 4, 0);
    const walker = new Vector3(0, 1, 10);
    expect(nearSightLine(cam, walker, 0.3, 2.5, 5, 1)).toBe(true); // right in the way
    expect(nearSightLine(cam, walker, 2, 2.5, 5, 1)).toBe(false); // beside the line
    expect(nearSightLine(cam, walker, 0, 1, 10.5, 1)).toBe(false); // at / beyond the walker
    expect(nearSightLine(cam, walker, 0, 4, -1, 1)).toBe(false); // behind the camera
  });
});
