import * as THREE from 'three';
import type { Graph } from '../core/graph';
import type { NetEdge, NetNode, Platform } from '../core/types';

/**
 * Walk-through geometry: the pedestrian network rendered as a place you can walk through —
 * floors with real widths, corridor walls and ceiling lights underground, stair steps,
 * escalators, glass elevator shafts, fare-gate rows and platform tactile strips.
 * Built once per exaggeration/theme; everything is merged into a handful of draw calls.
 */

export interface WalkwayOptions {
  /** Maps a real elevation (m) to scene Y. */
  Y: (y: number) => number;
  /** Vertical exaggeration currently applied (heights of walls etc. follow it). */
  ex: number;
  dark: boolean;
  levelVisible: (level: string) => boolean;
}

const tmpQ = new THREE.Quaternion();
const tmpS = new THREE.Vector3();
const tmpP = new THREE.Vector3();

/** Growable triangle soup with per-vertex colours. */
class Soup {
  pos: number[] = [];
  col: number[] = [];

  quad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, color: THREE.Color): void {
    for (const p of [a, b, c, a, c, d]) {
      this.pos.push(p.x, p.y, p.z);
      this.col.push(color.r, color.g, color.b);
    }
  }

  disc(center: THREE.Vector3, r: number, color: THREE.Color, segs = 14): void {
    for (let i = 0; i < segs; i++) {
      const a0 = (i / segs) * Math.PI * 2;
      const a1 = ((i + 1) / segs) * Math.PI * 2;
      this.pos.push(center.x, center.y, center.z);
      this.pos.push(center.x + Math.cos(a1) * r, center.y, center.z + Math.sin(a1) * r);
      this.pos.push(center.x + Math.cos(a0) * r, center.y, center.z + Math.sin(a0) * r);
      for (let k = 0; k < 3; k++) this.col.push(color.r, color.g, color.b);
    }
  }

  mesh(material: THREE.Material): THREE.Mesh | null {
    if (this.pos.length === 0) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    geo.computeVertexNormals();
    return new THREE.Mesh(geo, material);
  }
}

/** Collects box instances and turns them into one InstancedMesh. */
class Boxes {
  mats: THREE.Matrix4[] = [];
  cols: THREE.Color[] = [];

  add(center: THREE.Vector3, size: THREE.Vector3, yaw: number, color: THREE.Color, pitch = 0): void {
    tmpQ.setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
    this.mats.push(new THREE.Matrix4().compose(center, tmpQ, size));
    this.cols.push(color.clone());
  }

  mesh(material: THREE.Material): THREE.InstancedMesh | null {
    if (this.mats.length === 0) return null;
    const m = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material, this.mats.length);
    this.mats.forEach((mat, i) => {
      m.setMatrixAt(i, mat);
      m.setColorAt(i, this.cols[i]);
    });
    m.instanceMatrix.needsUpdate = true;
    return m;
  }
}

/** Horizontal unit direction a→b (falls back to +x for vertical edges) and its left normal. */
function frame(a: THREE.Vector3, b: THREE.Vector3): { dir: THREE.Vector3; left: THREE.Vector3; run: number } {
  const dir = new THREE.Vector3(b.x - a.x, 0, b.z - a.z);
  const run = dir.length();
  if (run < 1e-3) dir.set(1, 0, 0);
  else dir.divideScalar(run);
  const left = new THREE.Vector3(dir.z, 0, -dir.x);
  return { dir, left, run };
}

const yawOf = (dir: THREE.Vector3) => Math.atan2(dir.x, dir.z);

export function buildWalkway(g: Graph, o: WalkwayOptions): THREE.Group {
  const group = new THREE.Group();
  group.name = 'walkway';
  const { Y, ex } = o;
  const nodeOf = (id: string) => g.nodes[g.nodeIndex.get(id) as number];
  const P = (n: NetNode) => new THREE.Vector3(n.x, Y(n.y), n.z);

  const c = {
    floorPaid: new THREE.Color(o.dark ? '#4a4540' : '#d8cfc2'),
    floorFree: new THREE.Color(o.dark ? '#3c4046' : '#c9c4bc'),
    floorOut: new THREE.Color(o.dark ? '#2e3338' : '#9aa1a8'),
    zebraDark: new THREE.Color(o.dark ? '#22262a' : '#50565c'),
    zebraWhite: new THREE.Color('#f4f4f0'),
    step: new THREE.Color(o.dark ? '#6e6a64' : '#b9ad9c'),
    nosing: new THREE.Color('#f2b200'),
    escBed: new THREE.Color('#3b4046'),
    escRail: new THREE.Color('#1c1f22'),
    gateBody: new THREE.Color(o.dark ? '#8d99a5' : '#dfe4e8'),
    gateTop: new THREE.Color('#2c7be5'),
    tactile: new THREE.Color('#f2c200'),
    light: new THREE.Color('#fff4d6'),
    wall: new THREE.Color(o.dark ? '#5d6b78' : '#e4e8ec'),
    shaft: new THREE.Color('#5fcf86'),
  };

  const floors = new Soup();
  const walls = new Soup();
  const lights = new Soup();
  const zebra = new Soup();
  const boxes = new Boxes();
  const shafts = new Boxes();

  const visible = (e: NetEdge) => o.levelVisible(nodeOf(e.a).level) || o.levelVisible(nodeOf(e.b).level);
  const widthOf = (e: NetEdge) => Math.min(16, Math.max(3, e.width ?? (e.kind === 'crossing' ? 8 : 6)));

  // Parallel vertical edges (stairs + escalator + elevator between the same landings) are
  // spread sideways so they do not overlap.
  const lanes = verticalLaneOffsets(g);

  // Node joints: fill the gaps where corridors meet.
  const jointWidth = new Map<string, number>();

  for (let ei = 0; ei < g.edges.length; ei++) {
    const e = g.edges[ei];
    if (!visible(e)) continue;
    const na = nodeOf(e.a);
    const nb = nodeOf(e.b);
    const a = P(na);
    const b = P(nb);

    if (e.kind === 'walk' || e.kind === 'crossing') {
      const w = widthOf(e);
      const { left, run } = frame(a, b);
      if (run < 0.5) continue;
      const h = left.clone().multiplyScalar(w / 2);
      const lift = new THREE.Vector3(0, 0.08, 0);
      const color = !e.indoor ? c.floorOut : na.paid && nb.paid ? c.floorPaid : c.floorFree;
      if (e.kind === 'crossing') {
        // Asphalt with zebra stripes across the direction of travel.
        zebra.quad(a.clone().add(h).add(lift), b.clone().add(h).add(lift), b.clone().sub(h).add(lift), a.clone().sub(h).add(lift), c.zebraDark);
        const stripes = Math.floor(run / 1.2);
        for (let i = 1; i < stripes; i += 2) {
          const t0 = i / stripes;
          const t1 = (i + 0.6) / stripes;
          const p0 = a.clone().lerp(b, t0).add(new THREE.Vector3(0, 0.12, 0));
          const p1 = a.clone().lerp(b, t1).add(new THREE.Vector3(0, 0.12, 0));
          const hs = left.clone().multiplyScalar(w * 0.42);
          zebra.quad(p0.clone().add(hs), p1.clone().add(hs), p1.clone().sub(hs), p0.clone().sub(hs), c.zebraWhite);
        }
      } else {
        floors.quad(a.clone().add(h).add(lift), b.clone().add(h).add(lift), b.clone().sub(h).add(lift), a.clone().sub(h).add(lift), color);
        for (const id of [e.a, e.b]) jointWidth.set(id, Math.max(jointWidth.get(id) ?? 0, w));
      }

      // Corridor walls and ceiling light strips for covered walkways.
      if (e.indoor && e.kind === 'walk' && run > 4) {
        const wallH = 3.2 * ex;
        const up = new THREE.Vector3(0, wallH, 0);
        for (const side of [1, -1]) {
          const off = left.clone().multiplyScalar((side * w) / 2);
          const a0 = a.clone().add(off);
          const b0 = b.clone().add(off);
          walls.quad(a0, b0, b0.clone().add(up), a0.clone().add(up), c.wall);
        }
        if (Math.min(na.y, nb.y) < -0.5) {
          const hl = left.clone().multiplyScalar(0.35);
          const lh = new THREE.Vector3(0, wallH * 0.92, 0);
          lights.quad(a.clone().add(hl).add(lh), b.clone().add(hl).add(lh), b.clone().sub(hl).add(lh), a.clone().sub(hl).add(lh), c.light);
        }
      }
      continue;
    }

    if (e.kind === 'stairs' || e.kind === 'escalator' || e.kind === 'elevator') {
      const [lo, hi] = a.y <= b.y ? [a, b] : [b, a];
      const { dir, left, run } = frame(lo, hi);
      const shift = new THREE.Vector3(lanes[ei * 2], 0, lanes[ei * 2 + 1]);
      const l0 = lo.clone().add(shift);
      const h0 = hi.clone().add(shift);
      const rise = h0.y - l0.y;
      const yaw = yawOf(dir);

      if (e.kind === 'stairs') {
        const realRise = Math.abs(nb.y - na.y);
        const n = Math.min(40, Math.max(4, Math.round(realRise / 0.18)));
        const depth = Math.max(0.35, run / n);
        const w = 3.2;
        for (let i = 0; i < n; i++) {
          const f = (i + 0.5) / n;
          tmpP.set(l0.x + (h0.x - l0.x) * f, l0.y + rise * f, l0.z + (h0.z - l0.z) * f);
          boxes.add(tmpP.clone(), tmpS.set(w, rise / n, depth).clone(), yaw, i % 4 === 3 ? c.nosing : c.step);
        }
      } else if (e.kind === 'escalator') {
        // Inclined bed with two balustrades.
        const len = Math.hypot(run, rise);
        const pitch = -Math.atan2(rise, Math.max(run, 0.01));
        const mid = l0.clone().lerp(h0, 0.5);
        boxes.add(mid.clone().add(new THREE.Vector3(0, 0.2, 0)), new THREE.Vector3(1.4, 0.3, len), yaw, c.escBed, pitch);
        for (const side of [1, -1]) {
          const off = left.clone().multiplyScalar(side * 0.85);
          boxes.add(mid.clone().add(off).add(new THREE.Vector3(0, 0.9, 0)), new THREE.Vector3(0.12, 1.1, len), yaw, c.escRail, pitch);
        }
      } else {
        // Glass shaft from the lower to the upper landing: faint panes plus solid corner posts.
        const mid = l0.clone().lerp(h0, 0.5);
        const height = rise + 3 * ex;
        mid.y = (l0.y + h0.y) / 2 + 1.5 * ex;
        shafts.add(mid, new THREE.Vector3(2.6, height, 2.6), yaw, c.shaft);
        for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          const post = mid.clone().add(left.clone().multiplyScalar(sx * 1.3)).add(dir.clone().multiplyScalar(sz * 1.3));
          boxes.add(post, new THREE.Vector3(0.14, height, 0.14), yaw, c.shaft);
        }
      }
      continue;
    }

    if (e.kind === 'gate') {
      // A row of gate machines across the direction of travel, at the paid-side gate node.
      const gateNode = na.kind === 'gate' ? na : nb;
      const other = gateNode === na ? nb : na;
      const at = P(gateNode);
      const { dir, left } = frame(at, P(other));
      const count = Math.min(14, Math.max(4, Math.round((e.width ?? 8) / 1.4)));
      const yaw = yawOf(dir);
      for (let i = 0; i < count; i++) {
        const off = left.clone().multiplyScalar((i - (count - 1) / 2) * 1.0);
        const base = at.clone().add(off);
        boxes.add(base.clone().add(new THREE.Vector3(0, 0.5 * ex, 0)), new THREE.Vector3(0.28, 1.0 * ex, 1.4), yaw, c.gateBody);
        boxes.add(base.clone().add(new THREE.Vector3(0, 1.0 * ex + 0.06, 0)), new THREE.Vector3(0.3, 0.12, 1.4), yaw, c.gateTop);
      }
    }
  }

  for (const [id, w] of jointWidth) {
    const n = nodeOf(id);
    if (!o.levelVisible(n.level)) continue;
    floors.disc(P(n).add(new THREE.Vector3(0, 0.07, 0)), w / 2, n.paid ? c.floorPaid : c.floorFree);
  }

  // Tactile paving along both edges of every platform.
  for (const p of g.net.platforms) {
    if (!o.levelVisible(p.level)) continue;
    addTactile(floors, p, Y, c.tactile);
  }

  const floorMesh = floors.mesh(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  const zebraMesh = zebra.mesh(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  const wallMesh = walls.mesh(
    new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: o.dark ? 0.22 : 0.3, depthWrite: false }),
  );
  const lightMesh = lights.mesh(new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  const boxMesh = boxes.mesh(new THREE.MeshLambertMaterial());
  const shaftMesh = shafts.mesh(new THREE.MeshLambertMaterial({ transparent: true, opacity: 0.1, depthWrite: false }));
  for (const m of [floorMesh, zebraMesh, wallMesh, lightMesh, boxMesh, shaftMesh]) if (m) group.add(m);
  if (wallMesh) wallMesh.renderOrder = 3;
  if (shaftMesh) shaftMesh.renderOrder = 3;
  return group;
}

/**
 * Sideways placement of stairs, escalators and elevators: parallel flights between the same
 * two landings are spread apart. Per edge, the world (x, z) offset of the drawn flight from the
 * straight line between its nodes (0 for other kinds) — pedestrians use it to stay on the steps.
 */
export function verticalLaneOffsets(g: Graph): Float32Array {
  const out = new Float32Array(g.edges.length * 2);
  const lane = new Map<string, number>();
  g.edges.forEach((e, i) => {
    if (e.kind !== 'stairs' && e.kind !== 'escalator' && e.kind !== 'elevator') return;
    const key = e.a < e.b ? `${e.a}|${e.b}` : `${e.b}|${e.a}`;
    const k = lane.get(key) ?? 0;
    lane.set(key, k + 1);
    const na = g.nodes[g.nodeIndex.get(e.a) as number];
    const nb = g.nodes[g.nodeIndex.get(e.b) as number];
    const [lo, hi] = na.y <= nb.y ? [na, nb] : [nb, na];
    const { left } = frame(new THREE.Vector3(lo.x, 0, lo.z), new THREE.Vector3(hi.x, 0, hi.z));
    const m = (k === 0 ? -1 : k === 1 ? 1 : 3) * 2.2;
    out[i * 2] = left.x * m;
    out[i * 2 + 1] = left.z * m;
  });
  return out;
}

function addTactile(soup: Soup, p: Platform, Y: (y: number) => number, color: THREE.Color): void {
  const a = new THREE.Vector3(p.a[0], Y(p.y) + 0.03, p.a[1]);
  const b = new THREE.Vector3(p.b[0], Y(p.y) + 0.03, p.b[1]);
  const { left } = frame(a, b);
  for (const side of [1, -1]) {
    const edge = left.clone().multiplyScalar(side * (p.width / 2 - 1.0));
    const inner = left.clone().multiplyScalar(side * (p.width / 2 - 1.4));
    soup.quad(a.clone().add(edge), b.clone().add(edge), b.clone().add(inner), a.clone().add(inner), color);
  }
}

/**
 * A train standing at a platform (boxes per car with a window band), on the track beside the
 * platform's first listed side.
 */
export function buildTrain(p: Platform, color: string, Y: (y: number) => number, ex: number, side: 1 | -1 = 1): THREE.Group {
  const group = new THREE.Group();
  const a = new THREE.Vector3(p.a[0], Y(p.y), p.a[1]);
  const b = new THREE.Vector3(p.b[0], Y(p.y), p.b[1]);
  const { dir, left, run } = frame(a, b);
  const carLen = 19.5;
  const gap = 0.8;
  const cars = Math.max(2, Math.min(10, Math.floor((run * 0.85) / (carLen + gap))));
  const total = cars * (carLen + gap) - gap;
  const start = a.clone().lerp(b, 0.5).sub(dir.clone().multiplyScalar(total / 2));
  const off = left.clone().multiplyScalar(side * (p.width / 2 + 1.7));
  const bodyH = 3.2 * Math.min(ex, 1.6);
  const yaw = yawOf(dir);
  const body = new Boxes();
  const band = new Boxes();
  const bodyColor = new THREE.Color(color);
  const glass = new THREE.Color('#1d2733');
  for (let i = 0; i < cars; i++) {
    const center = start
      .clone()
      .add(dir.clone().multiplyScalar(i * (carLen + gap) + carLen / 2))
      .add(off)
      .add(new THREE.Vector3(0, bodyH / 2 - 0.6, 0));
    body.add(center, new THREE.Vector3(2.9, bodyH, carLen), yaw, bodyColor);
    band.add(center.clone().add(new THREE.Vector3(0, bodyH * 0.15, 0)), new THREE.Vector3(2.96, bodyH * 0.28, carLen * 0.92), yaw, glass);
  }
  const m1 = body.mesh(new THREE.MeshLambertMaterial());
  const m2 = band.mesh(new THREE.MeshLambertMaterial());
  if (m1) group.add(m1);
  if (m2) group.add(m2);
  return group;
}

/**
 * Wayfinding guide painted on the floor along the route: a yellow band with white chevrons
 * every few metres pointing the way (follows stairs and escalators; skips elevator shafts).
 */
export function buildGuideLine(points: THREE.Vector3[], color: THREE.Color): THREE.Mesh | null {
  const band = new Soup();
  const white = new THREE.Color('#ffffff');
  const lift = new THREE.Vector3(0, 0.18, 0);
  let carry = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i].clone().add(lift);
    const b = points[i + 1].clone().add(lift);
    const { dir, left, run } = frame(a, b);
    if (run < 0.3) continue; // vertical (elevator): nothing to paint
    const h = left.clone().multiplyScalar(0.7);
    band.quad(a.clone().add(h), b.clone().add(h), b.clone().sub(h), a.clone().sub(h), color);
    // Chevrons every 7 m of horizontal distance.
    const seg = a.distanceTo(b);
    for (let d = 7 - carry; d < seg; d += 7) {
      const p = a.clone().lerp(b, d / seg).add(new THREE.Vector3(0, 0.03, 0));
      const tip = p.clone().add(dir.clone().multiplyScalar(0.9));
      const l = p.clone().add(left.clone().multiplyScalar(0.55));
      const r = p.clone().sub(left.clone().multiplyScalar(0.55));
      const back = p.clone().sub(dir.clone().multiplyScalar(0.2));
      band.quad(l, tip, back, l, white);
      band.quad(r, back, tip, r, white);
      carry = seg - d;
    }
    carry = (carry + seg) % 7;
  }
  return band.mesh(new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
}

/** Heading (yaw, radians; 0 = +z/south) from a to b, or null for (nearly) vertical moves. */
export function headingBetween(a: { x: number; z: number }, b: { x: number; z: number }): number | null {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  if (Math.hypot(dx, dz) < 0.4) return null;
  return Math.atan2(dx, dz);
}

/** Shortest signed angle from a to b. */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

