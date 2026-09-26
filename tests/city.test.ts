import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { umeda } from '../src/data/umeda';
import { buildCity } from '../src/render/city';
import {
  analyseRoads,
  approach,
  BUILDING_SPECS,
  distanceToBox,
  fadeTarget,
  GHOST_OPACITY,
  gondolaOffset,
  greenFor,
  groundCells,
  groundOpenings,
  layoutParts,
  OVERVIEW_OPACITY,
  realHeight,
  sceneHeight,
  segmentHitsBox,
  stepTraffic,
  type Lane,
  type OBox,
  type Vehicle,
} from '../src/render/city-layout';

const net = umeda.network;
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
    const openings = groundOpenings(net.nodes, net.edges);
    expect(openings.length).toBeGreaterThan(10);
    const cells = groundCells(150, 0, 400, openings);
    for (const [x0, z0, x1, z1] of cells) {
      const cx = (x0 + x1) / 2;
      const cz = (z0 + z1) / 2;
      for (const o of openings) expect(distanceToBox(cx, 0, cz, { ...o, y0: -1, y1: 1 }) > 0 || x1 - x0 > 4).toBe(true);
    }
    const area = cells.reduce((s, [x0, z0, x1, z1]) => s + (x1 - x0) * (z1 - z0), 0);
    expect(area).toBeLessThan(800 * 800);
    expect(area).toBeGreaterThan(800 * 800 * 0.9);
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
