import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { umeda } from '../src/data/umeda';
import { buildGraph } from '../src/core/graph';
import { buildCity } from '../src/render/city';
import { insideConvex, WalkSpace } from '../src/render/walk-space';
import { verticalLaneOffsets } from '../src/render/walkway';
import { polyArea, type P2 } from '../src/render/walkway-util';
import {
  analyseRoads,
  approach,
  BUILDING_SPECS,
  distanceToBox,
  fadeTarget,
  GHOST_OPACITY,
  gondolaOffset,
  greenFor,
  flightWells,
  groundPieces,
  inflateConvex,
  layoutParts,
  OVERVIEW_OPACITY,
  portalFrames,
  realHeight,
  sceneHeight,
  segmentHitsBox,
  slabHoles,
  stepTraffic,
  subtractAll,
  wallOpenings,
  wallPanels,
  type Lane,
  type OBox,
  type Vehicle,
  type WallRect,
} from '../src/render/city-layout';
import type { NetEdge, NetNode, Network } from '../src/core/types';

const net = umeda.network;
const centroid = (p: P2[]): P2 => [p.reduce((s, q) => s + q[0], 0) / p.length, p.reduce((s, q) => s + q[1], 0) / p.length];
/** Signed area in x-z (positive = counter-clockwise, as insideConvex expects). */
const signedArea = (p: P2[]) => p.reduce((s, q, i) => s + q[0] * p[(i + 1) % p.length][1] - p[(i + 1) % p.length][0] * q[1], 0) / 2;
const box: OBox = { cx: 0, cz: 0, ux: 1, uz: 0, hl: 10, hw: 5, y0: 0, y1: 50 };

describe('city heights', () => {
  it('stretches the podium with the exaggeration and keeps towers at true height', () => {
    expect(sceneHeight(7, 4)).toBe(28);
    expect(sceneHeight(14, 4)).toBe(56);
    expect(sceneHeight(179, 4)).toBe(56 + 165);
    expect(sceneHeight(179, 1)).toBe(179);
    for (const ex of [1, 1.5, 4]) for (const h of [0, 3, 14, 60, 190]) expect(realHeight(sceneHeight(h, ex), ex)).toBeCloseTo(h, 9);
  });

  it('has a massing spec for every building and station footprint', () => {
    for (const f of net.footprints) {
      if (f.kind !== 'building' && f.kind !== 'station') continue;
      const spec = BUILDING_SPECS[f.id];
      expect(spec, f.id).toBeDefined();
      for (const p of spec.parts) {
        expect(p.h[1]).toBeGreaterThan(p.h[0]);
        expect(p.a[0]).toBeGreaterThanOrEqual(-0.5);
        expect(p.a[1]).toBeLessThanOrEqual(0.5);
      }
    }
    const top = (id: string) => Math.max(...BUILDING_SPECS[id].parts.map((p) => p.h[1]));
    expect(top('gfo-s')).toBe(179);
    expect(top('hk-dept')).toBe(187);
    expect(top('ekimae3')).toBeGreaterThan(top('ekimae4'));
  });

  it('lays parts out inside their footprint', () => {
    for (const f of net.footprints) {
      const spec = BUILDING_SPECS[f.id];
      if (!spec) continue;
      const xs = f.poly.map((p) => p[0]);
      const zs = f.poly.map((p) => p[1]);
      for (const b of layoutParts(f, spec, 1.5)) {
        expect(b.cx).toBeGreaterThanOrEqual(Math.min(...xs) - 1);
        expect(b.cx).toBeLessThanOrEqual(Math.max(...xs) + 1);
        expect(b.cz).toBeGreaterThanOrEqual(Math.min(...zs) - 1);
        expect(b.cz).toBeLessThanOrEqual(Math.max(...zs) + 1);
        expect(b.hl).toBeGreaterThan(0);
        expect(b.hw).toBeGreaterThan(0);
      }
    }
  });
});

describe('camera cut-away', () => {
  it('detects segments through an oriented box', () => {
    expect(segmentHitsBox(-30, 10, 0, 30, 10, 0, box)).toBe(true);
    expect(segmentHitsBox(-30, 60, 0, 30, 60, 0, box)).toBe(false);
    expect(segmentHitsBox(-30, 10, 8, 30, 10, 8, box)).toBe(false);
    expect(segmentHitsBox(-30, 10, 0, -12, 10, 0, box)).toBe(false);
    const rotated = { ...box, ux: 0, uz: 1 }; // long side now along z
    expect(segmentHitsBox(0, 10, -30, 0, 10, 30, rotated)).toBe(true);
    expect(segmentHitsBox(8, 10, -30, 8, 10, 30, rotated)).toBe(false);
    expect(distanceToBox(0, 10, 0, box)).toBe(0);
    expect(distanceToBox(13, 10, 0, box)).toBeCloseTo(3);
  });

  it('ghosts buildings between the camera and the walker, not the others', () => {
    const walk = (camera: { x: number; y: number; z: number }) => fadeTarget([box], { camera, focus: { x: 30, y: 1.5, z: 0 }, route: [], walk: true });
    expect(walk({ x: -30, y: 8, z: 0 })).toBeLessThanOrEqual(GHOST_OPACITY);
    expect(walk({ x: 50, y: 8, z: 0 })).toBe(1);
    // Camera inside the building.
    expect(walk({ x: 0, y: 8, z: 0 })).toBeLessThanOrEqual(GHOST_OPACITY);
  });

  it('keeps the overview semi-solid and clears buildings on the route', () => {
    const o = (route: { x: number; y: number; z: number }[]) =>
      fadeTarget([box], { camera: { x: 500, y: 500, z: 500 }, focus: { x: 400, y: 0, z: 400 }, route, walk: false });
    expect(o([])).toBe(OVERVIEW_OPACITY);
    expect(o([{ x: 5, y: 20, z: 0 }])).toBeLessThan(OVERVIEW_OPACITY);
  });

  it('approaches targets smoothly and frame-rate independently', () => {
    expect(approach(1, 0, 0)).toBe(1);
    const a = approach(approach(1, 0, 0.05), 0, 0.05);
    expect(a).toBeCloseTo(approach(1, 0, 0.1), 9);
    expect(approach(1, 0, 10)).toBeLessThan(1e-6);
  });
});

describe('streets', () => {
  const { infos, junctions } = analyseRoads(net.roads);

  it('finds the 梅田 junction where 御堂筋, 国道176号 and 新御堂筋 meet', () => {
    const umedaX = junctions.find((j) => Math.hypot(j.x - 284, j.z - 78) < 25);
    expect(umedaX).toBeDefined();
    expect(umedaX?.roads.length).toBeGreaterThanOrEqual(3);
    for (const i of infos) for (const p of i.pts) expect(Number.isFinite(p[0] + p[1])).toBe(true);
  });

  it('cuts openings in the street level where stairs go underground', () => {
    const space = WalkSpace.of(net);
    const holes = slabHoles(space, flightWells(net), -0.1 / 1.5, -250, 550, -400, 400);
    expect(holes.length).toBeGreaterThan(10);
    const pieces = groundPieces(150, 0, 400, holes);
    for (const p of pieces) {
      const [cx, cz] = centroid(p);
      for (const h of holes) expect(insideConvex(h, cx, cz)).toBe(false);
    }
    const area = pieces.reduce((s, p) => s + polyArea(p), 0);
    expect(area).toBeLessThan(800 * 800);
    expect(area).toBeGreaterThan(800 * 800 * 0.97);
  });

  it('runs signal-controlled traffic without collisions or NaN', () => {
    const lanes: Lane[] = [{ road: 0, dir: 1, lat: 2, stops: [300], phase: 0 }];
    const vehicles: Vehicle[] = [];
    for (let k = 0; k < 8; k++) vehicles.push({ lane: 0, s: 280 - k * 12, v: 8, type: 0, len: 4.6 });
    const byLane = [vehicles.map((_, i) => i)];
    // Red for phase 0 from t = 26 s: everyone queues behind the stop line.
    for (let t = 30; t < 55; t += 0.05) stepTraffic(lanes, infos, vehicles, byLane, t, 0.05);
    for (const v of vehicles) {
      expect(Number.isFinite(v.s)).toBe(true);
      expect(v.s).toBeLessThan(300);
    }
    const ordered = byLane[0].map((i) => vehicles[i].s);
    for (let k = 1; k < ordered.length; k++) expect(ordered[k - 1] - ordered[k]).toBeGreaterThan(4.6);
    expect(greenFor(0, 5)).toBe(true);
    expect(greenFor(1, 5)).toBe(false);
    expect(greenFor(0, 28)).toBe(false); // all-red clearance
    expect(greenFor(1, 35)).toBe(true);
  });

  it('keeps gondolas on the rim', () => {
    for (let i = 0; i < 52; i += 7) {
      const [u, a] = gondolaOffset(i, 52, 1.3, 37.5);
      expect(Math.hypot(u, a)).toBeCloseTo(37.5, 9);
    }
  });
});

describe('walkable space', () => {
  // A street-level corridor along x, a deck at 7 m beside it and an escalator from B1 up to
  // the street (foot at x = 50, head at x ≈ 60.4).
  const n = (id: string, x: number, y: number, z: number, extra: Partial<NetNode> = {}): NetNode => ({ id, kind: 'junction', name: id, x, y, z, level: '1F', ...extra });
  const e = (id: string, a: string, b: string, kind: NetEdge['kind'], width?: number, indoor = false): NetEdge => ({ id, a, b, kind, width, indoor });
  const tiny: Network = {
    levels: [],
    lines: [],
    stations: [],
    platforms: [],
    footprints: [],
    roads: [],
    nodes: [n('s0', 0, 0, 0), n('s1', 40, 0, 0), n('d0', 0, 7, 20), n('d1', 40, 7, 20), n('foot', 50, -6, 10), n('head', 50 + 6 * Math.sqrt(3), 0, 10)],
    edges: [e('street', 's0', 's1', 'walk', 6), e('deck', 'd0', 'd1', 'walk', 4, true), e('esc', 'foot', 'head', 'escalator')],
  };
  const space = new WalkSpace(tiny);
  const head = () => 2.6;

  it('opens a wall where a walkway runs through it, from its floor to its head room', () => {
    // Wall across the street corridor (x = 20, z −10…10), 0…30 high, ex = 1.5.
    const holes = wallOpenings(space, 20, -10, 20, 10, 0, 30, 1.5, head);
    expect(holes.length).toBeGreaterThanOrEqual(1);
    const h = holes.find((r) => r.t0 < 0.5 && r.t1 > 0.5) as WallRect;
    expect(h.t0).toBeCloseTo((10 - 3 - 0.25) / 20, 2);
    expect(h.t1).toBeCloseTo((10 + 3 + 0.25) / 20, 2);
    expect(h.y0).toBe(0);
    expect(h.y1).toBeCloseTo(2.6 * 1.5, 6);
    // The deck crossing a wall higher up keeps the wall below it.
    const deck = wallOpenings(space, 20, 10, 20, 30, 0, 30, 1.5, head).find((r) => r.y0 > 5) as WallRect;
    expect(deck.y0).toBeCloseTo(7 * 1.5 - 0.05, 6);
    expect(deck.y1).toBeCloseTo((7 + 2.6) * 1.5, 6);
    // Far from any walkway: nothing to open.
    expect(wallOpenings(space, -50, -10, -50, 10, 0, 30, 1.5, head)).toEqual([]);
  });

  it('keeps the rest of the wall as panels that avoid every opening', () => {
    const holes: WallRect[] = [
      { t0: 0.2, t1: 0.4, y0: 0, y1: 4 },
      { t0: 0.3, t1: 0.6, y0: 10, y1: 14 },
    ];
    const panels = wallPanels(holes, 0, 20);
    const area = (r: WallRect) => (r.t1 - r.t0) * (r.y1 - r.y0);
    const holeArea = 0.2 * 4 + 0.3 * 4;
    expect(panels.reduce((s, r) => s + area(r), 0)).toBeCloseTo(20 - holeArea, 9);
    for (const p of panels) {
      for (const h of holes) {
        const overlap = Math.min(p.t1, h.t1) - Math.max(p.t0, h.t0) > 1e-9 && Math.min(p.y1, h.y1) - Math.max(p.y0, h.y0) > 1e-9;
        expect(overlap).toBe(false);
      }
    }
    // Columns with the same open interval are merged: the untouched ends are single panels.
    expect(panels.filter((r) => r.y0 === 0 && r.y1 === 20)).toHaveLength(2);
    expect(wallPanels([], 0, 5)).toEqual([{ t0: 0, t1: 1, y0: 0, y1: 5 }]);
  });

  it('frames nearby openings together and separate ones apart', () => {
    const frames = portalFrames(
      [
        { t0: 0.1, t1: 0.2, y0: 0, y1: 3 },
        { t0: 0.19, t1: 0.3, y0: 0, y1: 4 },
        { t0: 0.7, t1: 0.8, y0: 0, y1: 3 },
      ],
      0.01,
    );
    expect(frames).toHaveLength(2);
    expect(frames.find((f) => f.t0 === 0.1)).toEqual({ t0: 0.1, t1: 0.3, y0: 0, y1: 4 });
  });

  it('opens slabs over whole wells and where head room reaches through them', () => {
    const wells = flightWells(tiny);
    expect(wells).toHaveLength(1);
    expect(wells[0].lo).toBe(-6);
    expect(wells[0].hi).toBe(0);
    // Street level: the escalator well, not the street corridor itself.
    const street = slabHoles(space, wells, -0.07, -100, 100, -100, 100);
    expect(street).toHaveLength(1);
    expect(polyArea(street[0])).toBeCloseTo(6 * Math.sqrt(3) * (1.6 + 0.4), 6);
    // A slab at 8 m cuts through the deck's head room; one at 10 m clears it.
    expect(slabHoles(space, wells, 8, -100, 100, -100, 100).length).toBeGreaterThan(0);
    expect(slabHoles(space, wells, 10, -100, 100, -100, 100)).toEqual([]);
    // Ground pieces cover everything but the well.
    const pieces = groundPieces(0, 0, 100, street, 20);
    expect(pieces.reduce((s, p) => s + polyArea(p), 0)).toBeCloseTo(200 * 200 - polyArea(street[0]), 3);
    expect(signedArea(street[0])).toBeGreaterThan(0);
    for (const p of pieces) expect(insideConvex(street[0], ...centroid(p))).toBe(false);
  });

  it('subtracts convex holes and grows convex polygons', () => {
    const sq: P2[] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    const hole: P2[] = [
      [4, 4],
      [6, 4],
      [6, 6],
      [4, 6],
    ];
    expect(subtractAll(sq, [hole]).reduce((s, p) => s + polyArea(p), 0)).toBeCloseTo(96, 9);
    expect(polyArea(inflateConvex(hole, 1))).toBeCloseTo(16, 9);
    expect(polyArea(inflateConvex([...hole].reverse(), 1))).toBeCloseTo(16, 9);
  });
});

describe('buildCity', () => {
  for (const walk of [false, true]) {
    it(`stays within the draw-call and triangle budget (${walk ? 'walk' : 'overview'})`, () => {
      const city = buildCity(net, { dark: false, night: false, ex: walk ? 1.5 : 4, walk });
      const day = city.stats();
      expect(day.buildings).toBeGreaterThanOrEqual(18);
      expect(day.trees).toBeGreaterThan(100);
      expect(day.drawCalls).toBeLessThanOrEqual(40);
      expect(day.triangles).toBeLessThanOrEqual(400_000);
      city.setNight(true);
      const night = city.stats();
      expect(night.drawCalls).toBeLessThanOrEqual(40);
      expect(night.triangles).toBeLessThanOrEqual(400_000);
      city.object.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const pos = m.geometry.getAttribute('position');
        for (let i = 0; i < pos.count; i++) expect(Number.isFinite(pos.getX(i) + pos.getY(i) + pos.getZ(i))).toBe(true);
      });
      city.dispose();
    });
  }

  it('animates traffic and the wheel in update() without NaN', () => {
    const city = buildCity(net, { dark: true, night: true, ex: 1.5, walk: true });
    const cam = new THREE.PerspectiveCamera();
    cam.position.set(200, 10, 0);
    cam.updateMatrixWorld();
    const cars = city.object.getObjectByName('city-cars') as THREE.InstancedMesh;
    const before = new THREE.Matrix4();
    cars.getMatrixAt(0, before);
    for (let i = 0; i < 60; i++) city.update(cam, new THREE.Vector3(230, 0, 0), 1 / 30);
    const after = new THREE.Matrix4();
    cars.getMatrixAt(0, after);
    expect(after.equals(before)).toBe(false);
    for (let i = 0; i < cars.count; i++) {
      cars.getMatrixAt(i, after);
      expect(after.elements.every(Number.isFinite)).toBe(true);
    }
    const wheel = city.object.getObjectByName('city-wheel');
    expect(wheel && Number.isFinite(wheel.rotation.x) && wheel.rotation.x !== 0).toBe(true);
    city.setRoute([new THREE.Vector3(0, 0, 0), new THREE.Vector3(100, 0, 0)]);
    city.update(cam, new THREE.Vector3(), 0);
    city.dispose();
    expect(city.object.parent).toBeNull();
  });
});

describe('buildCity in walkable space', () => {
  const ex = 1.5;
  const city = buildCity(net, { dark: false, night: false, ex, walk: true });
  const space = WalkSpace.of(net);

  /** World-space triangles of the named meshes (instances expanded), bucketed on a 4 m grid. */
  function soup(test: RegExp): { tri: Float32Array; grid: Map<string, number[]> } {
    const out: number[] = [];
    const m4 = new THREE.Matrix4();
    const inst = new THREE.Matrix4();
    const v = new THREE.Vector3();
    city.object.updateMatrixWorld(true);
    city.object.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !test.test(mesh.name)) return;
      const pos = mesh.geometry.getAttribute('position');
      const idx = mesh.geometry.getIndex();
      const im = mesh as THREE.InstancedMesh;
      for (let k = 0; k < (im.isInstancedMesh ? im.count : 1); k++) {
        m4.copy(mesh.matrixWorld);
        if (im.isInstancedMesh) m4.multiply((im.getMatrixAt(k, inst), inst));
        const n = idx ? idx.count : pos.count;
        for (let i = 0; i < n; i++) {
          v.fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(m4);
          out.push(v.x, v.y, v.z);
        }
      }
    });
    const tri = new Float32Array(out);
    const grid = new Map<string, number[]>();
    for (let t = 0; t < tri.length / 9; t++) {
      let x0 = Infinity;
      let x1 = -Infinity;
      let z0 = Infinity;
      let z1 = -Infinity;
      for (let k = 0; k < 3; k++) {
        x0 = Math.min(x0, tri[t * 9 + k * 3]);
        x1 = Math.max(x1, tri[t * 9 + k * 3]);
        z0 = Math.min(z0, tri[t * 9 + k * 3 + 2]);
        z1 = Math.max(z1, tri[t * 9 + k * 3 + 2]);
      }
      for (let gx = Math.floor(x0 / 4); gx <= Math.floor(x1 / 4); gx++)
        for (let gz = Math.floor(z0 / 4); gz <= Math.floor(z1 / 4); gz++) {
          const key = `${gx},${gz}`;
          const l = grid.get(key);
          if (l) l.push(t);
          else grid.set(key, [t]);
        }
    }
    return { tri, grid };
  }

  /** Does segment p→q cross a triangle of the soup whose normal is (not) vertical? */
  function hits(s: ReturnType<typeof soup>, p: THREE.Vector3, q: THREE.Vector3, horizontal: boolean): boolean {
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const n = new THREE.Vector3();
    const seen = new Set<number>();
    const ray = new THREE.Ray(p, q.clone().sub(p).normalize());
    const len = p.distanceTo(q);
    const hit = new THREE.Vector3();
    for (let gx = Math.floor(Math.min(p.x, q.x) / 4); gx <= Math.floor(Math.max(p.x, q.x) / 4); gx++)
      for (let gz = Math.floor(Math.min(p.z, q.z) / 4); gz <= Math.floor(Math.max(p.z, q.z) / 4); gz++)
        for (const t of s.grid.get(`${gx},${gz}`) ?? []) {
          if (seen.has(t)) continue;
          seen.add(t);
          a.fromArray(s.tri, t * 9);
          b.fromArray(s.tri, t * 9 + 3);
          c.fromArray(s.tri, t * 9 + 6);
          n.subVectors(b, a).cross(c.clone().sub(a));
          if (n.lengthSq() < 1e-12) continue;
          if (Math.abs(n.normalize().y) >= 0.5 !== horizontal) continue;
          if (ray.intersectTriangle(a, b, c, false, hit) && hit.distanceTo(p) < len) return true;
        }
    return false;
  }

  it('never stands a facade, roof, canopy, frame or street surface in the walker’s way', () => {
    const solid = soup(/^city-((curtain|grid|band|stone|roofs)-solid|ground|roads|sidewalks|markings|wheel)$/);
    const g = buildGraph(net);
    const lanes = verticalLaneOffsets(g);
    const bad: string[] = [];
    g.edges.forEach((e, i) => {
      if (e.kind === 'elevator') return;
      const a = g.nodes[g.nodeIndex.get(e.a) as number];
      const b = g.nodes[g.nodeIndex.get(e.b) as number];
      const lift = e.kind === 'stairs' ? 0.09 + 0.09 * ex : e.kind === 'escalator' ? 0.44 : 0.09;
      const A = new THREE.Vector3(a.x + lanes[i * 2], a.y * ex + lift, a.z + lanes[i * 2 + 1]);
      const B = new THREE.Vector3(b.x + lanes[i * 2], b.y * ex + lift, b.z + lanes[i * 2 + 1]);
      const n = Math.max(1, Math.ceil(A.distanceTo(B) / 0.5));
      for (let k = 0; k <= n; k++) {
        const p = A.clone().lerp(B, k / n);
        const q = A.clone().lerp(B, Math.min(1, (k + 1) / n));
        const wall = k < n && [0.7, 1.3, 1.9].some((h) => hits(solid, p.clone().setY(p.y + h), q.clone().setY(q.y + h), false));
        const slab = hits(solid, p.clone().setY(p.y + 0.35), p.clone().setY(p.y + 2), true);
        if (wall || slab) {
          bad.push(`${e.id} ${wall ? 'wall' : 'slab'} at ${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}`);
          return;
        }
      }
    });
    expect(bad).toEqual([]);
  });

  it('keeps trees, lamps and the Ferris wheel off walking lines', () => {
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const check = (name: string, r: number, h: number) => {
      const mesh = city.object.getObjectByName(name) as THREE.InstancedMesh;
      expect(mesh.count).toBeGreaterThan(0);
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, m);
        p.setFromMatrixPosition(m);
        expect(space.intersectsBox(p.x - r, p.x + r, 0, h / ex, p.z - r, p.z + r), `${name} ${i}`).toBe(false);
      }
    };
    check('city-trunks', 0.25, 3);
    check('city-lamp-poles', 0.12, 9);
    const wheel = new THREE.Box3().setFromObject(city.object.getObjectByName('city-wheel') as THREE.Object3D);
    expect(space.intersectsBox(wheel.min.x, wheel.max.x, wheel.min.y / ex, wheel.max.y / ex, wheel.min.z, wheel.max.z)).toBe(false);
  });

  it('holds traffic short of a network crossing while someone is on it', () => {
    const { infos } = analyseRoads(net.roads);
    const lanes: Lane[] = [{ road: 0, dir: 1, lat: 2, stops: [], phase: 0, holds: [{ s: 300, c: 0 }] }];
    const vehicles: Vehicle[] = [];
    for (let k = 0; k < 4; k++) vehicles.push({ lane: 0, s: 280 - k * 12, v: 8, type: 0, len: 4.6 });
    const byLane = [vehicles.map((_, i) => i)];
    // Green for phase 0 during t < 26, but the crossing is held: nobody passes the stop line.
    for (let t = 0; t < 20; t += 0.05) stepTraffic(lanes, infos, vehicles, byLane, t, 0.05, [1]);
    for (const v of vehicles) expect(v.s + v.len / 2).toBeLessThan(300.6);
    // Released on green: they drive on.
    for (let t = 0; t < 10; t += 0.05) stepTraffic(lanes, infos, vehicles, byLane, t, 0.05, [0]);
    expect(Math.max(...vehicles.map((v) => v.s))).toBeGreaterThan(300);
  });
});
