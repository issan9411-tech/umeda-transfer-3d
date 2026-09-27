// Triangle soup with a plan grid and segment tests, for the walk-geometry audit test.
import * as THREE from 'three';

export interface Tri {
  a: THREE.Vector3;
  b: THREE.Vector3;
  c: THREE.Vector3;
  n: THREE.Vector3;
  tag: string;
}

export class Soup {
  tris: Tri[] = [];
  cell = 4;
  grid = new Map<string, number[]>();

  addObject(root: THREE.Object3D, tagOf: (m: THREE.Mesh) => string | null): void {
    root.updateMatrixWorld(true);
    const m4 = new THREE.Matrix4();
    const inst = new THREE.Matrix4();
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      if (!isVisible(mesh)) return;
      const tag = tagOf(mesh);
      if (!tag) return;
      const geo = mesh.geometry;
      const pos = geo.getAttribute('position');
      if (!pos) return;
      const idx = geo.getIndex();
      const im = mesh as THREE.InstancedMesh;
      const count = im.isInstancedMesh ? im.count : 1;
      for (let k = 0; k < count; k++) {
        m4.copy(mesh.matrixWorld);
        if (im.isInstancedMesh) {
          im.getMatrixAt(k, inst);
          if (Math.abs(inst.determinant()) < 1e-12) continue; // hidden (zero-scaled) instance
          m4.multiply(inst);
        }
        // Only the drawn range (the city's per-pass index lists are longer than what they draw).
        const total = idx ? idx.count : pos.count;
        const first = Math.min(total, Math.max(0, geo.drawRange.start));
        const last = Math.min(total, first + Math.max(0, geo.drawRange.count));
        for (let t = Math.ceil(first / 3); t < Math.floor(last / 3); t++) {
          const i0 = idx ? idx.getX(t * 3) : t * 3;
          const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
          const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
          const a = new THREE.Vector3().fromBufferAttribute(pos, i0).applyMatrix4(m4);
          const b = new THREE.Vector3().fromBufferAttribute(pos, i1).applyMatrix4(m4);
          const c = new THREE.Vector3().fromBufferAttribute(pos, i2).applyMatrix4(m4);
          const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
          const len = n.length();
          if (len < 1e-9) continue;
          n.divideScalar(len);
          this.push({ a, b, c, n, tag });
        }
      }
    });
  }

  private push(t: Tri): void {
    const id = this.tris.length;
    this.tris.push(t);
    const x0 = Math.floor(Math.min(t.a.x, t.b.x, t.c.x) / this.cell);
    const x1 = Math.floor(Math.max(t.a.x, t.b.x, t.c.x) / this.cell);
    const z0 = Math.floor(Math.min(t.a.z, t.b.z, t.c.z) / this.cell);
    const z1 = Math.floor(Math.max(t.a.z, t.b.z, t.c.z) / this.cell);
    if ((x1 - x0 + 1) * (z1 - z0 + 1) > 4000) return; // huge ground planes: skip grid (rare)
    for (let x = x0; x <= x1; x++)
      for (let z = z0; z <= z1; z++) {
        const k = `${x},${z}`;
        const l = this.grid.get(k);
        if (l) l.push(id);
        else this.grid.set(k, [id]);
      }
  }

  /** Triangles near the segment p→q (bbox in XZ). */
  near(p: THREE.Vector3, q: THREE.Vector3): Set<number> {
    const out = new Set<number>();
    const x0 = Math.floor(Math.min(p.x, q.x) / this.cell);
    const x1 = Math.floor(Math.max(p.x, q.x) / this.cell);
    const z0 = Math.floor(Math.min(p.z, q.z) / this.cell);
    const z1 = Math.floor(Math.max(p.z, q.z) / this.cell);
    for (let x = x0; x <= x1; x++)
      for (let z = z0; z <= z1; z++) for (const id of this.grid.get(`${x},${z}`) ?? []) out.add(id);
    return out;
  }

  /** First hit along p→q (segment), filtered; returns tri + fraction. */
  hit(p: THREE.Vector3, q: THREE.Vector3, filter: (t: Tri) => boolean): { tri: Tri; f: number } | null {
    let best: { tri: Tri; f: number } | null = null;
    for (const id of this.near(p, q)) {
      const t = this.tris[id];
      if (!filter(t)) continue;
      const f = segTri(p, q, t);
      if (f !== null && (!best || f < best.f)) best = { tri: t, f };
    }
    return best;
  }
}

function isVisible(o: THREE.Object3D): boolean {
  for (let x: THREE.Object3D | null = o; x; x = x.parent) if (!x.visible) return false;
  return true;
}

const e1 = new THREE.Vector3();
const e2 = new THREE.Vector3();
const pv = new THREE.Vector3();
const tv = new THREE.Vector3();
const qv = new THREE.Vector3();
const d = new THREE.Vector3();

/** Möller–Trumbore on a segment; returns fraction in (0,1) or null. */
export function segTri(p: THREE.Vector3, q: THREE.Vector3, t: Tri): number | null {
  d.subVectors(q, p);
  e1.subVectors(t.b, t.a);
  e2.subVectors(t.c, t.a);
  pv.crossVectors(d, e2);
  const det = e1.dot(pv);
  if (Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;
  tv.subVectors(p, t.a);
  const u = tv.dot(pv) * inv;
  if (u < 0 || u > 1) return null;
  qv.crossVectors(tv, e1);
  const v = d.dot(qv) * inv;
  if (v < 0 || u + v > 1) return null;
  const f = e2.dot(qv) * inv;
  return f > 1e-6 && f < 1 - 1e-6 ? f : null;
}
