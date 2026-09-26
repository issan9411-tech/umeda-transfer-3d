import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildGraph } from '../src/core/graph';
import { umeda } from '../src/data/umeda';
import {
  angleDelta,
  buildGuideLine,
  buildTrain,
  buildWalkway,
  disposeWalkway,
  headingBetween,
  updateWalkway,
  verticalLaneOffsets,
  walkwayStats,
} from '../src/render/walkway';

const g = buildGraph(umeda.network);

describe('walk-through geometry', () => {
  it('builds floors, walls, steps and gates for the whole network', () => {
    const group = buildWalkway(g, { Y: (y) => y * 1.5, ex: 1.5, dark: false, levelVisible: () => true });
    const meshes: THREE.Mesh[] = [];
    group.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
    });
    expect(meshes.length).toBeGreaterThanOrEqual(5);
    const instanced = meshes.find((m) => (m as THREE.InstancedMesh).isInstancedMesh) as THREE.InstancedMesh;
    expect(instanced.count).toBeGreaterThan(500); // stair steps + gate machines
    for (const m of meshes) {
      const pos = m.geometry.getAttribute('position');
      for (let i = 0; i < pos.count; i++) expect(Number.isFinite(pos.getY(i))).toBe(true);
    }
  });

  it('hides geometry of hidden levels', () => {
    const all = buildWalkway(g, { Y: (y) => y, ex: 1, dark: false, levelVisible: () => true });
    const some = buildWalkway(g, { Y: (y) => y, ex: 1, dark: false, levelVisible: (l) => l !== 'B1' });
    const verts = (grp: THREE.Group) => {
      let n = 0;
      grp.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh && !(m as THREE.InstancedMesh).isInstancedMesh) n += m.geometry.getAttribute('position').count;
      });
      return n;
    };
    expect(verts(some)).toBeLessThan(verts(all));
  });

  it('paints a guide line with chevrons and skips vertical elevator legs', () => {
    const pts = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(30, 0, 0), new THREE.Vector3(30, 9, 0), new THREE.Vector3(30, 9, 20)];
    const mesh = buildGuideLine(pts, new THREE.Color('#ffc400')) as THREE.Mesh;
    const count = mesh.geometry.getAttribute('position').count;
    // 2 horizontal legs × 6 vertices + chevrons (2 quads × 6 vertices each)
    expect(count).toBeGreaterThan(12);
    expect(count % 6).toBe(0);
  });

  it('parks a train of whole cars beside a platform', () => {
    const p = umeda.network.platforms.find((x) => x.id === 'jr-5-6')!;
    const t = buildTrain(p, '#1d7fc4', (y) => y, 1);
    const body = t.children[0] as THREE.InstancedMesh;
    expect(body.count).toBeGreaterThanOrEqual(8);
    expect(body.count).toBeLessThanOrEqual(10);
  });

  it('computes headings and wraps angles', () => {
    expect(headingBetween({ x: 0, z: 0 }, { x: 0, z: 0.1 })).toBeNull();
    expect(headingBetween({ x: 0, z: 0 }, { x: 0, z: 5 })).toBeCloseTo(0);
    expect(headingBetween({ x: 0, z: 0 }, { x: 5, z: 0 })).toBeCloseTo(Math.PI / 2);
    expect(angleDelta(3, -3)).toBeCloseTo(2 * Math.PI - 6);
    expect(angleDelta(-3, 3)).toBeCloseTo(6 - 2 * Math.PI);
  });
});

describe('walk-through interiors', () => {
  const opts = { Y: (y: number) => y * 1.5, ex: 1.5, dark: false, levelVisible: () => true };

  it('stays within the draw-call and triangle budget', () => {
    const group = buildWalkway(g, opts);
    const s = walkwayStats(group);
    expect(s.drawCalls).toBeLessThanOrEqual(20);
    expect(s.triangles).toBeLessThan(400_000);
    disposeWalkway(group);
  });

  it('builds without a DOM (plain colours instead of canvas textures)', () => {
    const group = buildWalkway(g, { ...opts, dark: true });
    const names: string[] = [];
    group.traverse((o) => names.push(o.name));
    for (const n of ['floor-tile', 'floor-stone', 'walls', 'ceilings', 'shopfronts', 'signs', 'stairs', 'escalator-treads', 'fittings', 'lamps', 'elevator-cabins']) {
      expect(names).toContain(n);
    }
    disposeWalkway(group);
  });

  it('faces walls into the corridors, ceilings down and floors up', () => {
    const group = buildWalkway(g, opts);
    const mesh = (name: string) => group.getObjectByName(name) as THREE.Mesh;
    const ny = (name: string) => {
      const n = mesh(name).geometry.getAttribute('normal');
      let up = 0;
      let down = 0;
      for (let i = 0; i < n.count; i++) {
        if (n.getY(i) > 0.5) up++;
        if (n.getY(i) < -0.5) down++;
      }
      return { up, down, count: n.count };
    };
    const floor = ny('floor-stone');
    expect(floor.up).toBe(floor.count);
    const ceil = ny('ceilings');
    expect(ceil.down).toBe(ceil.count);
    // Walls are vertical.
    const w = mesh('walls').geometry.getAttribute('normal');
    for (let i = 0; i < w.count; i++) expect(Math.abs(w.getY(i))).toBeLessThan(1e-6);
    disposeWalkway(group);
  });

  it('lays the route’s staircase on the node line the walker follows', () => {
    const stairs = g.edges.find((e) => e.kind === 'stairs' && e.a === 'f_mido_s' && e.b === 'f_jrf_b1')!;
    const esc = g.edges.find((e) => e.kind === 'escalator' && e.a === 'f_mido_s' && e.b === 'f_jrf_b1')!;
    const mid = (id: string) => {
      const group = buildWalkway(g, { ...opts, routeEdges: new Set([id]) });
      const m = group.getObjectByName('stairs') as THREE.Mesh;
      const pos = m.geometry.getAttribute('position');
      const a = g.nodes[g.nodeIndex.get('f_mido_s')!];
      const b = g.nodes[g.nodeIndex.get('f_jrf_b1')!];
      // Distance of the stair vertices closest to the segment a–b (plan view).
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len = Math.hypot(dx, dz);
      // Mean signed lateral offset of the stair vertices from the segment a–b (plan view).
      let sum = 0;
      let n = 0;
      for (let i = 0; i < pos.count; i++) {
        const px = pos.getX(i) - a.x;
        const pz = pos.getZ(i) - a.z;
        const t = (px * dx + pz * dz) / (len * len);
        const lat = (px * dz - pz * dx) / len;
        // Only this flight: between its landings in plan and in height, within a few metres.
        if (t < 0.2 || t > 0.8 || Math.abs(lat) > 6 || pos.getY(i) > a.y * 1.5 || pos.getY(i) < b.y * 1.5) continue;
        sum += lat;
        n++;
      }
      disposeWalkway(group);
      return Math.abs(sum / n);
    };
    expect(mid(stairs.id)).toBeLessThan(0.5); // the flight straddles the line
    expect(mid(esc.id)).toBeGreaterThan(0.5); // …and moves aside when the escalator is taken
  });

  it('animates escalators and elevator cabins without NaN', () => {
    const group = buildWalkway(g, opts);
    const cut = { eye: new THREE.Vector3(0, 10, 0), target: new THREE.Vector3(5, 1, 5) };
    for (let i = 0; i < 50; i++) updateWalkway(group, 0.1, i % 2 ? cut : null);
    const cabins = group.getObjectByName('elevator-cabins') as THREE.InstancedMesh;
    const arr = cabins.instanceMatrix.array;
    for (let i = 0; i < arr.length; i++) expect(Number.isFinite(arr[i])).toBe(true);
    disposeWalkway(group);
    expect(group.userData.walkway).toBeUndefined();
  });
});

describe('vertical lane offsets', () => {
  it('spreads parallel flights apart and leaves walkways on their line', () => {
    const lanes = verticalLaneOffsets(g);
    const byPair = new Map<string, number[]>();
    g.edges.forEach((e, i) => {
      const len = Math.hypot(lanes[i * 2], lanes[i * 2 + 1]);
      if (e.kind === 'stairs' || e.kind === 'escalator' || e.kind === 'elevator') {
        expect(Number.isFinite(len)).toBe(true);
        const key = e.a < e.b ? `${e.a}|${e.b}` : `${e.b}|${e.a}`;
        byPair.set(key, [...(byPair.get(key) ?? []), i]);
      } else {
        expect(len).toBe(0);
      }
    });
    for (const idx of byPair.values()) {
      const keys = new Set(idx.map((i) => `${lanes[i * 2].toFixed(3)},${lanes[i * 2 + 1].toFixed(3)}`));
      expect(keys.size).toBe(idx.length);
    }
  });

  it("keeps the route's own flight on the node line the walker follows", () => {
    const i = g.edges.findIndex((e) => e.kind === 'escalator');
    const lanes = verticalLaneOffsets(g, new Set([g.edges[i].id]));
    expect(Math.hypot(lanes[i * 2], lanes[i * 2 + 1])).toBeCloseTo(0);
  });
});
