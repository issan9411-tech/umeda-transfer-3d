import * as THREE from 'three';

/**
 * Walk-through camera that never passes through walls, ceilings or floors
 * (「館内を歩いてる時は壁のすり抜けが起きないように」).
 *
 * - `CollisionWorld`: every solid triangle of the walk scene (walkway walls, glass, shopfronts,
 *   fittings, signs, ceilings, floors, flights; station structure, shell and glass; trains; the
 *   city's street level, solid facades and roofs), picked by mesh name so it follows whatever the
 *   renderers build, in one bounding volume hierarchy built once per walk scene (≈200k triangles,
 *   ≈0.3 s). Swept-sphere, ray and clearance queries take microseconds and allocate nothing.
 * - `chasePose` / `firstPersonPose` / `orbitPose`: pure camera solvers shared by the view and the
 *   regression test (tests/walk-camera.test.ts).
 *
 * The chase view is a spring arm from the walker's upper body. Candidate arms (straight behind at
 * a few pitches, parallel to the flight on stairs and escalators, swung aside when boxed in) are
 * swept with a sphere wider than the near plane's corners, judged both from where the walker is
 * and from where he is about to be, and the freest one near the preferred framing wins. The
 * camera sits just before the first hit and must also have a floor under it (where the modelled
 * rooms have no wall, it would otherwise float outside them and see ceilings from above). The arm
 * pulls in at once when something cuts it, quickly when something is about to (the walker moving
 * on, the arm turning at a corner), and lets out slowly. When it gets very short the figure fades
 * out and the camera slides to the eye rather than into the head. The near plane opens up to 0.3
 * where there is room and closes to 0.08 in tight spots.
 */

/** Mesh names that stop the camera (dynamic things such as lift cabins and cars do not). */
export const CAMERA_SOLID =
  /^(walls|shopfronts|glass|fittings|signs|ceilings|stairs|escalator-treads|floor-(tile|stone|paver|asphalt)|station-(structure|shell|glass|roof-top)|track-(ballast|slab)|train-bodies|train|city-ground|city-[a-z]+-solid)$/;

/** Collision tag of a mesh: its name (route-end trains are unnamed children of a 'train' group). */
export function cameraTag(mesh: THREE.Object3D): string | null {
  const name = mesh.name || (mesh.parent?.name === 'train' ? 'train' : '');
  return CAMERA_SOLID.test(name) ? name : null;
}

// ---------------------------------------------------------------- collision world

const LEAF = 4;

function visibleInWorld(o: THREE.Object3D): boolean {
  for (let x: THREE.Object3D | null = o; x; x = x.parent) if (!x.visible) return false;
  return true;
}

/**
 * Static triangle BVH of the solid walk scene. Positions are world (scene) coordinates; all
 * faces count from both sides.
 */
export class CollisionWorld {
  /** 9 floats per triangle, in BVH leaf order. */
  private tri: Float32Array;
  /** Unit normal and plane offset per triangle (n·p + d = 0). */
  private pln: Float32Array;
  /** Node bounds: minX, minY, minZ, maxX, maxY, maxZ. */
  private box: Float32Array;
  /** Per node: triangle count (0 = inner node) and first triangle / right child. */
  private node: Int32Array;
  private stack = new Int32Array(128);
  /** Vertical component of the normal of the triangle the last `raycast` hit (0 if none). */
  hitNormalY = 0;
  /** Closest solid point found by the last `clearance` query (valid when it found one). */
  readonly closest = new THREE.Vector3();
  private cx = 0;
  private cy = 0;
  private cz = 0;
  readonly triangles: number;
  /** Milliseconds spent building (collect + hierarchy). */
  readonly buildMs: number;

  constructor(tris: Float32Array, buildMs = 0) {
    const t0 = now();
    const n = tris.length / 9;
    this.triangles = n;
    const idx = new Uint32Array(n);
    const cen = new Float32Array(n * 3);
    const tb = new Float32Array(n * 6);
    for (let i = 0; i < n; i++) {
      idx[i] = i;
      const k = i * 9;
      for (let a = 0; a < 3; a++) {
        const v0 = tris[k + a];
        const v1 = tris[k + 3 + a];
        const v2 = tris[k + 6 + a];
        const lo = Math.min(v0, v1, v2);
        const hi = Math.max(v0, v1, v2);
        tb[i * 6 + a] = lo;
        tb[i * 6 + 3 + a] = hi;
        cen[i * 3 + a] = (lo + hi) / 2;
      }
    }
    const maxNodes = Math.max(1, 2 * Math.ceil(n / LEAF) * 2);
    let box = new Float32Array(maxNodes * 6);
    let node = new Int32Array(maxNodes * 2);
    let count = 0;
    const grow = () => {
      const b = new Float32Array(box.length * 2);
      b.set(box);
      box = b;
      const d = new Int32Array(node.length * 2);
      d.set(node);
      node = d;
    };
    const build = (start: number, end: number, depth: number): number => {
      if (count * 6 >= box.length) grow();
      const ni = count++;
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity; // prettier-ignore
      let cx0 = Infinity, cy0 = Infinity, cz0 = Infinity, cx1 = -Infinity, cy1 = -Infinity, cz1 = -Infinity; // prettier-ignore
      for (let j = start; j < end; j++) {
        const i = idx[j];
        const b = i * 6;
        if (tb[b] < x0) x0 = tb[b];
        if (tb[b + 1] < y0) y0 = tb[b + 1];
        if (tb[b + 2] < z0) z0 = tb[b + 2];
        if (tb[b + 3] > x1) x1 = tb[b + 3];
        if (tb[b + 4] > y1) y1 = tb[b + 4];
        if (tb[b + 5] > z1) z1 = tb[b + 5];
        const c = i * 3;
        if (cen[c] < cx0) cx0 = cen[c];
        if (cen[c] > cx1) cx1 = cen[c];
        if (cen[c + 1] < cy0) cy0 = cen[c + 1];
        if (cen[c + 1] > cy1) cy1 = cen[c + 1];
        if (cen[c + 2] < cz0) cz0 = cen[c + 2];
        if (cen[c + 2] > cz1) cz1 = cen[c + 2];
      }
      box[ni * 6] = x0;
      box[ni * 6 + 1] = y0;
      box[ni * 6 + 2] = z0;
      box[ni * 6 + 3] = x1;
      box[ni * 6 + 4] = y1;
      box[ni * 6 + 5] = z1;
      const len = end - start;
      const ex = cx1 - cx0;
      const ey = cy1 - cy0;
      const ez = cz1 - cz0;
      if (len <= LEAF || depth > 60 || Math.max(ex, ey, ez) < 1e-5) {
        node[ni * 2] = len;
        node[ni * 2 + 1] = start;
        return ni;
      }
      const axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;
      const mid = axis === 0 ? (cx0 + cx1) / 2 : axis === 1 ? (cy0 + cy1) / 2 : (cz0 + cz1) / 2;
      // Partition by the spatial median of the centroids.
      let i = start;
      let j = end - 1;
      while (i <= j) {
        if (cen[idx[i] * 3 + axis] < mid) i++;
        else {
          const t = idx[i];
          idx[i] = idx[j];
          idx[j] = t;
          j--;
        }
      }
      let m = i;
      if (m === start || m === end) m = (start + end) >> 1;
      build(start, m, depth + 1);
      const right = build(m, end, depth + 1);
      node[ni * 2] = 0;
      node[ni * 2 + 1] = right;
      return ni;
    };
    if (n > 0) build(0, n, 0);
    else {
      count = 1;
      node[0] = 0;
      node[1] = 0;
      box.fill(0, 0, 6);
    }
    this.box = box.slice(0, count * 6);
    this.node = node.slice(0, count * 2);
    // Triangles and planes in leaf order (the hierarchy then walks memory front to back).
    this.tri = new Float32Array(n * 9);
    this.pln = new Float32Array(n * 4);
    for (let j = 0; j < n; j++) {
      const s = idx[j] * 9;
      const d = j * 9;
      for (let k = 0; k < 9; k++) this.tri[d + k] = tris[s + k];
      const ax = tris[s], ay = tris[s + 1], az = tris[s + 2]; // prettier-ignore
      const e1x = tris[s + 3] - ax, e1y = tris[s + 4] - ay, e1z = tris[s + 5] - az; // prettier-ignore
      const e2x = tris[s + 6] - ax, e2y = tris[s + 7] - ay, e2z = tris[s + 8] - az; // prettier-ignore
      let nx = e1y * e2z - e1z * e2y;
      let ny = e1z * e2x - e1x * e2z;
      let nz = e1x * e2y - e1y * e2x;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l;
      ny /= l;
      nz /= l;
      this.pln[j * 4] = nx;
      this.pln[j * 4 + 1] = ny;
      this.pln[j * 4 + 2] = nz;
      this.pln[j * 4 + 3] = -(nx * ax + ny * ay + nz * az);
    }
    this.buildMs = buildMs + (now() - t0);
  }

  /**
   * Collects the solid triangles of every visible mesh under `roots` whose tag (see
   * `cameraTag`) is accepted, including each drawn instance of instanced meshes.
   */
  static fromScene(roots: readonly (THREE.Object3D | null | undefined)[], tagOf: (m: THREE.Mesh) => string | null = cameraTag): CollisionWorld {
    const t0 = now();
    const chunks: Float32Array[] = [];
    let total = 0;
    const m4 = new THREE.Matrix4();
    const inst = new THREE.Matrix4();
    const v = new THREE.Vector3();
    for (const root of roots) {
      if (!root) continue;
      root.updateMatrixWorld(true);
      root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh || !mesh.geometry || !tagOf(mesh) || !visibleInWorld(mesh)) return;
        const geo = mesh.geometry;
        const pos = geo.getAttribute('position');
        if (!pos) return;
        const index = geo.getIndex();
        const nt = Math.floor((index ? index.count : pos.count) / 3);
        const im = mesh as THREE.InstancedMesh;
        const copies = im.isInstancedMesh ? im.count : 1;
        const out = new Float32Array(nt * 9 * copies);
        let w = 0;
        for (let c = 0; c < copies; c++) {
          m4.copy(mesh.matrixWorld);
          if (im.isInstancedMesh) {
            im.getMatrixAt(c, inst);
            if (Math.abs(inst.determinant()) < 1e-12) continue; // hidden instance
            m4.multiply(inst);
          }
          for (let t = 0; t < nt; t++) {
            for (let k = 0; k < 3; k++) {
              const vi = index ? index.getX(t * 3 + k) : t * 3 + k;
              v.fromBufferAttribute(pos, vi).applyMatrix4(m4);
              out[w++] = v.x;
              out[w++] = v.y;
              out[w++] = v.z;
            }
            // Drop degenerate slivers (they have no plane to collide with).
            const b = w - 9;
            const e1x = out[b + 3] - out[b], e1y = out[b + 4] - out[b + 1], e1z = out[b + 5] - out[b + 2]; // prettier-ignore
            const e2x = out[b + 6] - out[b], e2y = out[b + 7] - out[b + 1], e2z = out[b + 8] - out[b + 2]; // prettier-ignore
            const cx = e1y * e2z - e1z * e2y;
            const cy = e1z * e2x - e1x * e2z;
            const cz = e1x * e2y - e1y * e2x;
            if (cx * cx + cy * cy + cz * cz < 1e-12) w -= 9;
          }
        }
        if (w > 0) {
          chunks.push(out.subarray(0, w));
          total += w;
        }
      });
    }
    const tris = new Float32Array(total);
    let o = 0;
    for (const c of chunks) {
      tris.set(c, o);
      o += c.length;
    }
    return new CollisionWorld(tris, now() - t0);
  }

  /**
   * Sweeps a sphere of radius r from a to b; returns the fraction of the way (0..1) at which
   * it first touches a solid, 1 when the whole way is free, 0 when it already overlaps at a.
   */
  sweep(ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number): number {
    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;
    const ix = dx !== 0 ? 1 / dx : Infinity;
    const iy = dy !== 0 ? 1 / dy : Infinity;
    const iz = dz !== 0 ? 1 / dz : Infinity;
    const box = this.box;
    const node = this.node;
    const st = this.stack;
    let best = 1;
    let sp = 0;
    st[sp++] = 0;
    while (sp > 0) {
      const ni = st[--sp];
      const b = ni * 6;
      if (!slab(ax, ay, az, dx, dy, dz, ix, iy, iz, box[b] - r, box[b + 1] - r, box[b + 2] - r, box[b + 3] + r, box[b + 4] + r, box[b + 5] + r, best)) continue;
      const cnt = node[ni * 2];
      const off = node[ni * 2 + 1];
      if (cnt > 0) {
        for (let t = off; t < off + cnt; t++) {
          const h = this.sweepTri(t, ax, ay, az, dx, dy, dz, r, best);
          if (h < best) {
            best = h;
            if (best <= 0) return 0;
          }
        }
      } else if (sp + 2 <= st.length) {
        st[sp++] = off;
        st[sp++] = ni + 1;
      }
    }
    return best;
  }

  /**
   * Distance along the unit direction (dx, dy, dz) to the first solid, or maxT when none; the
   * hit face's normal.y is left in `hitNormalY`.
   */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number): number {
    const ix = dx !== 0 ? 1 / (dx * maxT) : Infinity;
    const iy = dy !== 0 ? 1 / (dy * maxT) : Infinity;
    const iz = dz !== 0 ? 1 / (dz * maxT) : Infinity;
    const box = this.box;
    const node = this.node;
    const st = this.stack;
    const tri = this.tri;
    const sx = dx * maxT;
    const sy = dy * maxT;
    const sz = dz * maxT;
    let best = 1;
    let bestTri = -1;
    let sp = 0;
    st[sp++] = 0;
    while (sp > 0) {
      const ni = st[--sp];
      const b = ni * 6;
      if (!slab(ox, oy, oz, sx, sy, sz, ix, iy, iz, box[b], box[b + 1], box[b + 2], box[b + 3], box[b + 4], box[b + 5], best)) continue;
      const cnt = node[ni * 2];
      const off = node[ni * 2 + 1];
      if (cnt > 0) {
        for (let t = off; t < off + cnt; t++) {
          const k = t * 9;
          const f = segTri(ox, oy, oz, sx, sy, sz, tri[k], tri[k + 1], tri[k + 2], tri[k + 3], tri[k + 4], tri[k + 5], tri[k + 6], tri[k + 7], tri[k + 8]);
          if (f >= 0 && f < best) {
            best = f;
            bestTri = t;
          }
        }
      } else if (sp + 2 <= st.length) {
        st[sp++] = off;
        st[sp++] = ni + 1;
      }
    }
    this.hitNormalY = bestTri >= 0 ? this.pln[bestTri * 4 + 1] : 0;
    return best * maxT;
  }

  /** Distance from p to the nearest solid, or maxD when nothing is closer. */
  clearance(px: number, py: number, pz: number, maxD: number): number {
    const box = this.box;
    const node = this.node;
    const st = this.stack;
    let best2 = maxD * maxD;
    let sp = 0;
    st[sp++] = 0;
    while (sp > 0) {
      const ni = st[--sp];
      const b = ni * 6;
      const qx = px < box[b] ? box[b] - px : px > box[b + 3] ? px - box[b + 3] : 0;
      const qy = py < box[b + 1] ? box[b + 1] - py : py > box[b + 4] ? py - box[b + 4] : 0;
      const qz = pz < box[b + 2] ? box[b + 2] - pz : pz > box[b + 5] ? pz - box[b + 5] : 0;
      if (qx * qx + qy * qy + qz * qz >= best2) continue;
      const cnt = node[ni * 2];
      const off = node[ni * 2 + 1];
      if (cnt > 0) {
        for (let t = off; t < off + cnt; t++) {
          const d2 = this.dist2(t, px, py, pz);
          if (d2 < best2) {
            best2 = d2;
            this.closest.set(this.cx, this.cy, this.cz);
          }
        }
      } else if (sp + 2 <= st.length) {
        st[sp++] = off;
        st[sp++] = ni + 1;
      }
    }
    return Math.sqrt(best2);
  }

  /** Squared distance from p to triangle t (Ericson, Real-Time Collision Detection 5.1.5). */
  private dist2(t: number, px: number, py: number, pz: number): number {
    const T = this.tri;
    const k = t * 9;
    const ax = T[k], ay = T[k + 1], az = T[k + 2]; // prettier-ignore
    const abx = T[k + 3] - ax, aby = T[k + 4] - ay, abz = T[k + 5] - az; // prettier-ignore
    const acx = T[k + 6] - ax, acy = T[k + 7] - ay, acz = T[k + 8] - az; // prettier-ignore
    const apx = px - ax, apy = py - ay, apz = pz - az; // prettier-ignore
    const d1 = abx * apx + aby * apy + abz * apz;
    const d2 = acx * apx + acy * apy + acz * apz;
    let cx: number, cy: number, cz: number; // prettier-ignore
    if (d1 <= 0 && d2 <= 0) {
      cx = ax;
      cy = ay;
      cz = az;
    } else {
      const bpx = px - T[k + 3], bpy = py - T[k + 4], bpz = pz - T[k + 5]; // prettier-ignore
      const d3 = abx * bpx + aby * bpy + abz * bpz;
      const d4 = acx * bpx + acy * bpy + acz * bpz;
      const cpx = px - T[k + 6], cpy = py - T[k + 7], cpz = pz - T[k + 8]; // prettier-ignore
      const d5 = abx * cpx + aby * cpy + abz * cpz;
      const d6 = acx * cpx + acy * cpy + acz * cpz;
      const vc = d1 * d4 - d3 * d2;
      const vb = d5 * d2 - d1 * d6;
      const va = d3 * d6 - d5 * d4;
      if (d3 >= 0 && d4 <= d3) {
        cx = T[k + 3];
        cy = T[k + 4];
        cz = T[k + 5];
      } else if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3);
        cx = ax + abx * v;
        cy = ay + aby * v;
        cz = az + abz * v;
      } else if (d6 >= 0 && d5 <= d6) {
        cx = T[k + 6];
        cy = T[k + 7];
        cz = T[k + 8];
      } else if (vb <= 0 && d2 >= 0 && d6 <= 0) {
        const w = d2 / (d2 - d6);
        cx = ax + acx * w;
        cy = ay + acy * w;
        cz = az + acz * w;
      } else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
        const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
        cx = T[k + 3] + (T[k + 6] - T[k + 3]) * w;
        cy = T[k + 4] + (T[k + 7] - T[k + 4]) * w;
        cz = T[k + 5] + (T[k + 8] - T[k + 5]) * w;
      } else {
        const denom = 1 / (va + vb + vc);
        const v = vb * denom;
        const w = vc * denom;
        cx = ax + abx * v + acx * w;
        cy = ay + aby * v + acy * w;
        cz = az + abz * v + acz * w;
      }
    }
    this.cx = cx;
    this.cy = cy;
    this.cz = cz;
    const ex = px - cx;
    const ey = py - cy;
    const ez = pz - cz;
    return ex * ex + ey * ey + ez * ez;
  }

  /**
   * First contact (fraction of the way, < limit) of a sphere of radius r moving from a by d
   * with triangle t, from either side; `limit` when there is none before it. After Fauerby,
   * "Improved Collision detection and Response" (2003).
   */
  private sweepTri(t: number, ax: number, ay: number, az: number, dx: number, dy: number, dz: number, r: number, limit: number): number {
    const P = this.pln;
    const nx = P[t * 4], ny = P[t * 4 + 1], nz = P[t * 4 + 2], nd = P[t * 4 + 3]; // prettier-ignore
    const sd = nx * ax + ny * ay + nz * az + nd;
    const ndv = nx * dx + ny * dy + nz * dz;
    let t0: number;
    let t1: number;
    let inSlab = false;
    if (Math.abs(ndv) < 1e-12) {
      if (Math.abs(sd) >= r) return limit;
      t0 = 0;
      t1 = 1;
      inSlab = true;
    } else {
      t0 = (r - sd) / ndv;
      t1 = (-r - sd) / ndv;
      if (t0 > t1) {
        const s = t0;
        t0 = t1;
        t1 = s;
      }
      if (t0 >= limit || t1 < 0) return limit;
      if (t0 < 0) {
        t0 = 0;
        inSlab = true;
      }
      if (t1 > 1) t1 = 1;
    }
    // Already touching at the start: nothing to sweep.
    if (inSlab && this.dist2(t, ax, ay, az) < r * r) return 0;
    const T = this.tri;
    const k = t * 9;
    if (!inSlab) {
      // Contact with the face itself happens first if the touch point lies inside.
      const s = sd > 0 ? r : -r;
      const qx = ax + dx * t0 - nx * s;
      const qy = ay + dy * t0 - ny * s;
      const qz = az + dz * t0 - nz * s;
      if (inTri(T, k, qx, qy, qz)) return t0;
    }
    // Vertices and edges (contacts can only happen while the sphere overlaps the plane).
    let best = Math.min(limit, t1 + 1e-9);
    let hit = false;
    const vv = dx * dx + dy * dy + dz * dz;
    if (vv < 1e-18) return limit;
    for (let i = 0; i < 3; i++) {
      const px = T[k + i * 3], py = T[k + i * 3 + 1], pz = T[k + i * 3 + 2]; // prettier-ignore
      const bpx = ax - px, bpy = ay - py, bpz = az - pz; // prettier-ignore
      const b = 2 * (dx * bpx + dy * bpy + dz * bpz);
      const c = bpx * bpx + bpy * bpy + bpz * bpz - r * r;
      const root = lowestRoot(vv, b, c, best);
      if (root >= 0) {
        best = root;
        hit = true;
      }
    }
    for (let i = 0; i < 3; i++) {
      const j = (i + 1) % 3;
      const p1x = T[k + i * 3], p1y = T[k + i * 3 + 1], p1z = T[k + i * 3 + 2]; // prettier-ignore
      const ex = T[k + j * 3] - p1x, ey = T[k + j * 3 + 1] - p1y, ez = T[k + j * 3 + 2] - p1z; // prettier-ignore
      const bx = p1x - ax, by = p1y - ay, bz = p1z - az; // prettier-ignore
      const ee = ex * ex + ey * ey + ez * ez;
      const ev = ex * dx + ey * dy + ez * dz;
      const eb = ex * bx + ey * by + ez * bz;
      const a = ee * -vv + ev * ev;
      const b = ee * (2 * (dx * bx + dy * by + dz * bz)) - 2 * ev * eb;
      const c = ee * (r * r - (bx * bx + by * by + bz * bz)) + eb * eb;
      const root = lowestRoot(a, b, c, best);
      if (root >= 0) {
        const f = (ev * root - eb) / ee;
        if (f >= 0 && f <= 1) {
          best = root;
          hit = true;
        }
      }
    }
    return hit && best < limit ? best : limit;
  }
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Segment a + s·d (s ∈ [0, maxS]) against an axis-aligned box. */
function slab(
  ax: number, ay: number, az: number, dx: number, dy: number, dz: number, ix: number, iy: number, iz: number, // prettier-ignore
  x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, maxS: number, // prettier-ignore
): boolean {
  let lo = 0;
  let hi = maxS;
  if (dx === 0) {
    if (ax < x0 || ax > x1) return false;
  } else {
    const t0 = (x0 - ax) * ix;
    const t1 = (x1 - ax) * ix;
    if (t0 < t1) {
      if (t0 > lo) lo = t0;
      if (t1 < hi) hi = t1;
    } else {
      if (t1 > lo) lo = t1;
      if (t0 < hi) hi = t0;
    }
    if (lo > hi) return false;
  }
  if (dy === 0) {
    if (ay < y0 || ay > y1) return false;
  } else {
    const t0 = (y0 - ay) * iy;
    const t1 = (y1 - ay) * iy;
    if (t0 < t1) {
      if (t0 > lo) lo = t0;
      if (t1 < hi) hi = t1;
    } else {
      if (t1 > lo) lo = t1;
      if (t0 < hi) hi = t0;
    }
    if (lo > hi) return false;
  }
  if (dz === 0) {
    if (az < z0 || az > z1) return false;
  } else {
    const t0 = (z0 - az) * iz;
    const t1 = (z1 - az) * iz;
    if (t0 < t1) {
      if (t0 > lo) lo = t0;
      if (t1 < hi) hi = t1;
    } else {
      if (t1 > lo) lo = t1;
      if (t0 < hi) hi = t0;
    }
    if (lo > hi) return false;
  }
  return true;
}

/** Lowest root of a·x² + b·x + c in [0, max), or -1. */
function lowestRoot(a: number, b: number, c: number, max: number): number {
  if (Math.abs(a) < 1e-14) {
    if (Math.abs(b) < 1e-14) return -1;
    const x = -c / b;
    return x >= 0 && x < max ? x : -1;
  }
  const det = b * b - 4 * a * c;
  if (det < 0) return -1;
  const sq = Math.sqrt(det);
  let r1 = (-b - sq) / (2 * a);
  let r2 = (-b + sq) / (2 * a);
  if (r1 > r2) {
    const s = r1;
    r1 = r2;
    r2 = s;
  }
  // Entry is always the smaller root (vertex spheres open upward, edge cylinders downward);
  // a start inside is the caller's business, so an exit root never counts.
  return r1 >= 0 && r1 < max ? r1 : -1;
}

/** Point (on the triangle's plane) inside triangle k of T, barycentric test with a small tolerance. */
function inTri(T: Float32Array, k: number, px: number, py: number, pz: number): boolean {
  const ax = T[k], ay = T[k + 1], az = T[k + 2]; // prettier-ignore
  const v0x = T[k + 6] - ax, v0y = T[k + 7] - ay, v0z = T[k + 8] - az; // prettier-ignore
  const v1x = T[k + 3] - ax, v1y = T[k + 4] - ay, v1z = T[k + 5] - az; // prettier-ignore
  const v2x = px - ax, v2y = py - ay, v2z = pz - az; // prettier-ignore
  const d00 = v0x * v0x + v0y * v0y + v0z * v0z;
  const d01 = v0x * v1x + v0y * v1y + v0z * v1z;
  const d02 = v0x * v2x + v0y * v2y + v0z * v2z;
  const d11 = v1x * v1x + v1y * v1y + v1z * v1z;
  const d12 = v1x * v2x + v1y * v2y + v1z * v2z;
  const den = d00 * d11 - d01 * d01;
  if (Math.abs(den) < 1e-18) return false;
  const inv = 1 / den;
  const u = (d11 * d02 - d01 * d12) * inv;
  const v = (d00 * d12 - d01 * d02) * inv;
  return u >= -1e-7 && v >= -1e-7 && u + v <= 1 + 1e-7;
}

/** Möller–Trumbore on the segment o → o + s (either face); fraction in [0, 1] or -1. */
function segTri(
  ox: number, oy: number, oz: number, sx: number, sy: number, sz: number, // prettier-ignore
  ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, // prettier-ignore
): number {
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az; // prettier-ignore
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az; // prettier-ignore
  const px = sy * e2z - sz * e2y;
  const py = sz * e2x - sx * e2z;
  const pz = sx * e2y - sy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-14) return -1;
  const inv = 1 / det;
  const tx = ox - ax, ty = oy - ay, tz = oz - az; // prettier-ignore
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < 0 || u > 1) return -1;
  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;
  const v = (sx * qx + sy * qy + sz * qz) * inv;
  if (v < 0 || u + v > 1) return -1;
  const f = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return f >= 0 && f <= 1 ? f : -1;
}

// ---------------------------------------------------------------- camera solvers

/** Height of the spring arm's pivot above the walker's soles (upper chest; scene units). */
export const PIVOT_H = 1.75;
/** First-person eye height above the soles (1.6 m × the walk-mode people scale). */
export const EYE_H = 2.0;
/** Radius kept free around the camera: the near plane's corners plus a 0.1 margin. */
export const CAMERA_RADIUS = 0.24;
/** Near-plane range while walking (it opens up to NEAR_MAX where there is room). */
export const NEAR_MIN = 0.08;
export const NEAR_MAX = 0.3;

/** Preferred chase arm: this far behind and above the pivot (camera 3.4 above the soles). */
const ARM_BACK = 8;
const ARM_UP = 3.4 - PIVOT_H;
const ARM_LEN = Math.hypot(ARM_BACK, ARM_UP);
const ARM_PITCH = Math.atan2(ARM_UP, ARM_BACK);
/** Candidate arms: pitch offsets (rad) tried straight behind, then yaw swings if all are short. */
const PITCHES = [0, -0.14, 0.17, 0.38, 0.7];
const SWINGS = [0.45, -0.45, 0.9, -0.9, 1.35, -1.35];
const SWING_PITCHES = [0, 0.17];
/** Pitches relative to the flight's own slope (on stairs and escalators). */
const SLOPE_PITCHES = [0.05, 0.2];
/** Score of a candidate: free arm length minus these per radian away from the preferred arm. */
const PITCH_COST = 2.2;
const SWING_COST = 1.8;
const KEEP_BONUS = 0.6;
/** Arm lengths where the walker fades out (FADE_TO → FADE_FROM) and the camera moves to the eye (FADE_FROM → EYE_FROM). */
const FADE_TO = 2.1;
const FADE_FROM = 1.4;
const EYE_FROM = 0.7;

export interface ChaseInput {
  /** Walker's soles (scene). */
  walker: THREE.Vector3;
  /** Direction of travel (yaw; 0 = +z, π/2 = +x). */
  heading: number;
  /** Rise of the track behind the walker per unit run (scene): > 0 when coming down a flight. */
  slopeBehind: number;
  /** Rise of the track ahead per unit run (scene): < 0 when going down. */
  slopeAhead: number;
  /** Camera aspect ratio and vertical field of view (degrees). */
  aspect: number;
  fov: number;
  /**
   * Where the walker's soles will be a moment from now (on the track, ≈0.4 s of real time): the
   * arm eases in before something moves between it and the walker instead of popping in.
   */
  ahead?: THREE.Vector3;
  /** The travel direction the view is turning toward (the camera eases to it). */
  headingSoon?: number;
}

/** Smoothed state of a walk camera (one per view). */
export interface CameraRig {
  ready: boolean;
  /** Arm yaw offset from straight behind and arm pitch (rad), eased toward the chosen arm. */
  swing: number;
  pitch: number;
  /** Current arm length (pivot → camera). */
  len: number;
  /** Chosen candidate (hysteresis). */
  choice: number;
  /** Smoothed look-at point. */
  target: THREE.Vector3;
}

export interface WalkCameraPose {
  pos: THREE.Vector3;
  target: THREE.Vector3;
  near: number;
  /** Pivot → camera distance. */
  arm: number;
  /** Opacity for the walker figure (fades out when the camera is right behind the head). */
  figure: number;
  /** Where the arm starts: the walker's upper body (eased off anything it brushes past). */
  pivot: THREE.Vector3;
}

export function createRig(): CameraRig {
  return { ready: false, swing: 0, pitch: ARM_PITCH, len: ARM_LEN, choice: 0, target: new THREE.Vector3() };
}

export function createPose(): WalkCameraPose {
  return { pos: new THREE.Vector3(), target: new THREE.Vector3(), near: NEAR_MAX, arm: 0, figure: 1, pivot: new THREE.Vector3() };
}

/** Distance from the camera to its near plane's corners, per unit of near distance. */
export function nearCornerFactor(fovDeg: number, aspect: number): number {
  const h = Math.tan((fovDeg * Math.PI) / 360);
  return Math.sqrt(1 + h * h * (1 + aspect * aspect));
}

/** Largest near distance that keeps the near plane 0.1 clear, given the camera's clearance. */
export function safeNear(clearance: number, fovDeg: number, aspect: number): number {
  return Math.min(NEAR_MAX, Math.max(NEAR_MIN, (clearance - 0.1) / nearCornerFactor(fovDeg, aspect)));
}

/** How far ahead (s) the arm looks for a turn about to swing it into something. */
const TURN_AHEAD = 0.35;

const _d = new THREE.Vector3();
const _s = new THREE.Vector3();
const _q = new THREE.Vector3();
const _vt = new THREE.Vector3();
const _vp = new THREE.Vector3();
const _ahead = new THREE.Vector3();
const _dSoon = new THREE.Vector3();

/** Unit arm direction for a yaw (direction the arm points) and pitch. */
function armDir(yaw: number, pitch: number, out: THREE.Vector3): THREE.Vector3 {
  const c = Math.cos(pitch);
  return out.set(Math.sin(yaw) * c, Math.sin(pitch), Math.cos(yaw) * c);
}

/**
 * Eases p (in place) off anything closer than `radius`, the way the nearest solid pushes it,
 * without crossing anything on the way. Returns the clearance reached.
 */
export function seat(world: CollisionWorld | null, p: THREE.Vector3, radius = CAMERA_RADIUS): number {
  if (!world) return radius;
  let c = world.clearance(p.x, p.y, p.z, radius + 0.01);
  for (let k = 0; k < 3 && c < radius; k++) {
    _s.subVectors(p, world.closest);
    const l = _s.length();
    if (l < 1e-5) break;
    _s.multiplyScalar((radius - c + 0.02) / l);
    const f = world.sweep(p.x, p.y, p.z, p.x + _s.x, p.y + _s.y, p.z + _s.z, c * 0.5);
    p.addScaledVector(_s, f < 1 ? Math.max(0, f - 0.05) : 1);
    c = world.clearance(p.x, p.y, p.z, radius + 0.01);
  }
  return Math.min(radius, c);
}

/**
 * The first surface straight below p faces up: something to stand on (strict), or at least
 * not the underside of a ceiling seen from above (when the walker himself is over a lift shaft).
 */
export function floorUnder(world: CollisionWorld, x: number, y: number, z: number, strict = true): boolean {
  const d = world.raycast(x, y, z, 0, -1, 0, 80);
  if (d >= 80) return !strict;
  return strict ? world.hitNormalY > 0.3 : world.hitNormalY > -0.3;
}

/** Pivot heights tried where the walker brushes past something (chest, head, waist, above the head). */
const PIVOTS = [PIVOT_H, PIVOT_H + 0.3, PIVOT_H - 0.4, PIVOT_H + 0.55];
/** First-person eye heights tried (the eye, then a little lower, higher, the neck). */
const EYES = [EYE_H, EYE_H - 0.25, EYE_H + 0.15, EYE_H - 0.5];

/**
 * Puts `out` at the first of `heights` above `walker` with room for the camera sphere (else the
 * roomiest), eased off whatever is still close. Returns its clearance.
 */
function seatColumn(world: CollisionWorld | null, walker: THREE.Vector3, heights: readonly number[], out: THREE.Vector3): number {
  out.copy(walker);
  out.y += heights[0];
  if (!world) return CAMERA_RADIUS;
  let bestC = -1;
  let bestH = heights[0];
  for (const h of heights) {
    const c = world.clearance(walker.x, walker.y + h, walker.z, CAMERA_RADIUS + 0.01);
    if (c > bestC) {
      bestC = c;
      bestH = h;
    }
    if (c >= CAMERA_RADIUS) break;
  }
  out.y = walker.y + bestH;
  return bestC >= CAMERA_RADIUS ? CAMERA_RADIUS : seat(world, out);
}

/** Free length along the arm from the pivot (sphere of radius r), up to len. */
function freeArm(world: CollisionWorld | null, p: THREE.Vector3, d: THREE.Vector3, len: number, r: number): number {
  if (!world) return len;
  const f = world.sweep(p.x, p.y, p.z, p.x + d.x * len, p.y + d.y * len, p.z + d.z * len, r);
  return Math.max(0, f * len - 0.02);
}

/**
 * Longest length ≤ len along the arm that still has a floor under the camera. Where walls are
 * missing (a corridor mouth meeting a station box) the arm could otherwise leave the modelled
 * rooms and look at them from outside, over the void or a ceiling below.
 */
function flooredArm(world: CollisionWorld | null, p: THREE.Vector3, d: THREE.Vector3, len: number, strict: boolean): number {
  if (!world || len <= 0) return len;
  if (floorUnder(world, p.x + d.x * len, p.y + d.y * len, p.z + d.z * len, strict)) return len;
  if (len < 0.3) return 0;
  let lo = 0;
  let hi = len;
  for (let k = 0; k < 5; k++) {
    const m = (lo + hi) / 2;
    if (floorUnder(world, p.x + d.x * m, p.y + d.y * m, p.z + d.z * m, strict)) lo = m;
    else hi = m;
  }
  return lo;
}

/** Arm length allowed along d: clear of solids and over a floor. */
function allowedArm(world: CollisionWorld | null, p: THREE.Vector3, d: THREE.Vector3, len: number, r: number, check: boolean): number {
  return flooredArm(world, p, d, freeArm(world, p, d, len, r), check);
}

const smooth = (rate: number, dt: number) => 1 - Math.exp(-Math.max(0, dt) * rate);

function wrap(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * Sets out.pos = pivot + d·len, then eases it off any surface closer than the near plane needs
 * (possible only where the pivot itself brushes past something), keeping the sight line clear.
 */
function place(world: CollisionWorld | null, out: WalkCameraPose, d: THREE.Vector3, len: number, fov: number, aspect: number, strict: boolean): void {
  out.pos.copy(out.pivot).addScaledVector(d, len);
  if (!world) {
    out.near = NEAR_MAX;
    return;
  }
  let c = world.clearance(out.pos.x, out.pos.y, out.pos.z, 1);
  if (c < CAMERA_RADIUS && len > 0.05) {
    _q.copy(out.pos);
    seat(world, _q);
    const p = out.pivot;
    _s.subVectors(_q, p);
    const l = _s.length();
    if (l > 1e-4 && world.raycast(p.x, p.y, p.z, _s.x / l, _s.y / l, _s.z / l, l) >= l && floorUnder(world, _q.x, _q.y, _q.z, strict)) {
      out.pos.copy(_q);
      c = world.clearance(out.pos.x, out.pos.y, out.pos.z, 1);
    }
  }
  out.near = safeNear(c, fov, aspect);
}

/**
 * Chase camera: spring arm behind the walker that never passes through solids.
 * `dt` ≤ 0 (or a fresh rig) snaps; otherwise pull-in is immediate and release eases out.
 */
export function chasePose(world: CollisionWorld | null, inp: ChaseInput, rig: CameraRig, dt: number, out: WalkCameraPose = createPose()): WalkCameraPose {
  const snap = !rig.ready || dt <= 0;
  const pivot = out.pivot;
  const r = Math.min(CAMERA_RADIUS, seatColumn(world, inp.walker, PIVOTS, pivot) * 0.95);
  const check = world ? floorUnder(world, pivot.x, pivot.y, pivot.z) : false;
  const back = inp.heading + Math.PI;
  // Follow the slope of the track behind: up a flight when coming down, a little lower when
  // climbing. Enclosed flights get a candidate parallel to the steps (between treads and ceiling).
  const sb = Math.atan(inp.slopeBehind);
  const basePitch = ARM_PITCH + (sb > 0 ? Math.min(0.75, sb * 0.85) : Math.max(-0.2, sb * 0.2));
  const onFlight = Math.abs(sb) > 0.2;

  // Pick the freest candidate arm near the preferred framing (the current one first, so the
  // others can often be ruled out before their floor check).
  let bestScore = -Infinity;
  let bestSwing = 0;
  let bestPitch = basePitch;
  let bestId = -1;
  let bestLen = 0;
  // Candidate ids: straight behind at PITCHES offsets, then parallel to the flight, then swings.
  const nPitch = PITCHES.length;
  const nStraight = nPitch + SLOPE_PITCHES.length;
  const nAll = nStraight + SWINGS.length * SWING_PITCHES.length;
  // Where the walker is about to be (arms are judged from there too, so the choice does not
  // flip to one that is about to be cut).
  let soon: THREE.Vector3 | null = null;
  if (world && inp.ahead && !snap) {
    soon = _ahead.copy(inp.ahead).add(pivot).sub(inp.walker);
    if (soon.distanceToSquared(pivot) < 0.01 || world.clearance(soon.x, soon.y, soon.z, r + 0.01) < r * 0.95) soon = null;
  }
  const consider = (id: number) => {
    if (id >= nPitch && id < nStraight && !onFlight) return;
    const swing = id < nStraight ? 0 : SWINGS[Math.floor((id - nStraight) / SWING_PITCHES.length)];
    const dp = id < nPitch ? PITCHES[id] : id < nStraight ? sb + SLOPE_PITCHES[id - nPitch] - basePitch : SWING_PITCHES[(id - nStraight) % SWING_PITCHES.length];
    const pitch = Math.min(1.5, Math.max(-0.9, basePitch + dp));
    const flight = id >= nPitch && id < nStraight ? 0.5 : 1;
    const cost = PITCH_COST * flight * Math.abs(dp) + SWING_COST * Math.abs(swing) - (id === rig.choice && !snap ? KEEP_BONUS : 0);
    const d = armDir(back + swing, pitch, _d);
    let free = freeArm(world, pivot, d, ARM_LEN, r);
    if (free - cost <= bestScore) return;
    if (soon) {
      free = Math.min(free, freeArm(world, soon, d, ARM_LEN, r));
      if (free - cost <= bestScore) return;
    }
    free = flooredArm(world, pivot, d, free, check);
    const score = free - cost - (free < 1.2 ? 2 : 0);
    if (score > bestScore) {
      bestScore = score;
      bestSwing = swing;
      bestPitch = pitch;
      bestId = id;
      bestLen = free;
    }
  };
  const first = !snap && rig.choice >= 0 && rig.choice < nAll ? rig.choice : 0;
  consider(first);
  for (let id = 0; id < nStraight; id++) if (id !== first) consider(id);
  // Boxed in behind (a wall, a stairwell, a lift door): look for room to the sides.
  if (bestLen < ARM_LEN * 0.75 && world) for (let id = nStraight; id < nAll; id++) if (id !== first) consider(id);
  rig.choice = bestId;

  // Ease the arm toward the choice, then keep it clear along the eased direction.
  if (snap) {
    rig.swing = bestSwing;
    rig.pitch = bestPitch;
  } else {
    rig.swing += wrap(bestSwing - rig.swing) * smooth(3, dt);
    rig.pitch += (bestPitch - rig.pitch) * smooth(2.5, dt);
  }
  const dir = armDir(back + rig.swing, rig.pitch, _d);
  const free = allowedArm(world, pivot, dir, ARM_LEN, r, check);
  let want = free;
  if (world && !snap) {
    // Where the arm is about to point (turning at a corner, easing to another choice)...
    const hs = inp.headingSoon ?? inp.heading;
    const swingSoon = rig.swing + wrap(bestSwing - rig.swing) * smooth(3, TURN_AHEAD);
    const pitchSoon = rig.pitch + (bestPitch - rig.pitch) * smooth(2.5, TURN_AHEAD);
    const turn = armDir(hs + Math.PI + swingSoon, pitchSoon, _dSoon);
    if (turn.dot(dir) < 0.9995) want = Math.min(want, allowedArm(world, pivot, turn, ARM_LEN, r, check));
    // ...from where the walker is about to be.
    if (soon) want = Math.min(want, allowedArm(world, soon, turn, ARM_LEN, r, check));
  }
  // Pull in at once where something already cuts the arm, quickly where it is about to, and
  // let it out slowly.
  let len = snap || free < rig.len ? free : rig.len + (want - rig.len) * (want < rig.len ? smooth(9, dt) : smooth(1 / 0.55, dt));
  // Floors are not monotonic along the arm: check the eased length too.
  if (len < free) len = flooredArm(world, pivot, dir, len, check);
  rig.len = len;
  const eyeBlend = 1 - smoothstep(EYE_FROM, FADE_FROM, rig.len);
  if (eyeBlend > 0) {
    // Boxed in (a lift shaft, a door behind): slide toward the eye rather than into the head.
    _q.copy(pivot).addScaledVector(dir, rig.len);
    const up = EYE_H - PIVOT_H;
    const eyeUp = world ? Math.max(0, world.sweep(pivot.x, pivot.y, pivot.z, pivot.x, pivot.y + up, pivot.z, r) * up - 0.02) : up;
    _s.set(pivot.x, pivot.y + eyeUp, pivot.z).sub(_q).multiplyScalar(eyeBlend).add(_q).sub(pivot);
    const l = _s.length();
    const clear = !world || l < 1e-4 || world.sweep(pivot.x, pivot.y, pivot.z, pivot.x + _s.x, pivot.y + _s.y, pivot.z + _s.z, Math.min(r, 0.1)) >= 1;
    if (clear && l > 1e-4) place(world, out, _s.divideScalar(l), l, inp.fov, inp.aspect, check);
    else place(world, out, dir, rig.len, inp.fov, inp.aspect, check);
  } else place(world, out, dir, rig.len, inp.fov, inp.aspect, check);
  out.arm = rig.len;

  // Look ahead over the walker, following the slope ahead (down a flight: look down it).
  const ahead = Math.max(-1, Math.min(1, inp.slopeAhead));
  const tx = inp.walker.x + Math.sin(inp.heading) * 7;
  const ty = inp.walker.y + 1.0 + ahead * 7 * 0.6;
  const tz = inp.walker.z + Math.cos(inp.heading) * 7;
  if (snap) rig.target.set(tx, ty, tz);
  else {
    const k = smooth(5, dt);
    rig.target.x += (tx - rig.target.x) * k;
    rig.target.y += (ty - rig.target.y) * k;
    rig.target.z += (tz - rig.target.z) * k;
  }
  out.target.copy(rig.target);
  keepInFrame(out, inp.walker, inp.fov);
  // Right behind the head: fade the figure out rather than filling the screen with it.
  out.figure = smoothstep(FADE_FROM, FADE_TO, rig.len);
  rig.ready = true;
  return out;
}

/**
 * Turns the view (not the camera) toward the walker's body if it would drift out of the middle
 * of the frame, e.g. with a steep arm up a lift shaft or a stairwell.
 */
function keepInFrame(out: WalkCameraPose, walker: THREE.Vector3, fov: number): void {
  const vt = _vt.subVectors(out.target, out.pos);
  const lt = vt.length();
  const vp = _vp.set(walker.x - out.pos.x, walker.y + 1.0 - out.pos.y, walker.z - out.pos.z);
  const lp = vp.length();
  if (lt < 1e-3 || lp < 2.5) return;
  vt.divideScalar(lt);
  vp.divideScalar(lp);
  const ang = Math.acos(Math.max(-1, Math.min(1, vt.dot(vp))));
  const limit = 0.55 * ((fov * Math.PI) / 360);
  if (ang <= limit || ang > Math.PI - 1e-3) return;
  const k = (ang - limit) / ang;
  const s = Math.sin(ang);
  const a = Math.sin((1 - k) * ang) / s;
  const b = Math.sin(k * ang) / s;
  out.target.set(out.pos.x + (vt.x * a + vp.x * b) * lt, out.pos.y + (vt.y * a + vp.y * b) * lt, out.pos.z + (vt.z * a + vp.z * b) * lt);
}

/** First person: eye at head height (lowered under anything overhead), looking at `target`. */
export function firstPersonPose(world: CollisionWorld | null, walker: THREE.Vector3, target: THREE.Vector3, fov: number, aspect: number, out: WalkCameraPose = createPose()): WalkCameraPose {
  seatColumn(world, walker, EYES, out.pivot);
  place(world, out, _d.set(0, 1, 0), 0, fov, aspect, false);
  out.target.copy(target);
  out.arm = 0;
  out.figure = 0;
  return out;
}

/**
 * Orbit: the user's camera position (from OrbitControls) pulled in toward the walker's upper
 * body wherever a solid stands in between; pull-in immediate, release eased.
 */
export function orbitPose(world: CollisionWorld | null, walker: THREE.Vector3, wanted: THREE.Vector3, rig: CameraRig, dt: number, fov: number, aspect: number, out: WalkCameraPose = createPose()): WalkCameraPose {
  const pivot = out.pivot;
  const r = Math.min(CAMERA_RADIUS, seatColumn(world, walker, PIVOTS, pivot) * 0.95);
  const check = world ? floorUnder(world, pivot.x, pivot.y, pivot.z) : false;
  const dir = _d.subVectors(wanted, pivot);
  const len = dir.length();
  if (len < 1e-6) dir.set(0, 1, 0);
  else dir.divideScalar(len);
  const free = allowedArm(world, pivot, dir, len, r, check);
  let arm = !rig.ready || dt <= 0 || free < rig.len ? free : rig.len + (free - rig.len) * smooth(1 / 0.45, dt);
  arm = Math.min(arm, len);
  if (arm < free) arm = flooredArm(world, pivot, dir, arm, check);
  rig.len = arm;
  rig.ready = true;
  place(world, out, dir, rig.len, fov, aspect, check);
  out.arm = rig.len;
  out.figure = smoothstep(FADE_FROM, FADE_TO, rig.len);
  return out;
}
