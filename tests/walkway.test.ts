import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildGraph } from '../src/core/graph';
import { umeda } from '../src/data/umeda';
import { angleDelta, buildGuideLine, buildTrain, buildWalkway, headingBetween } from '../src/render/walkway';

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
