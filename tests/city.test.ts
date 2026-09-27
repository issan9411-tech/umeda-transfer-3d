import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { umeda } from '../src/data/umeda';
import { decodeBuildings, decodeRoads, Reader } from '../src/data/osm/codec';
import { BUILDING_DATA, BUILDING_NAMES } from '../src/data/osm/buildings';
import { ROAD_DATA, ROAD_NAMES } from '../src/data/osm/roads';
import { buildGraph } from '../src/core/graph';
import { buildCity, FADE_TEX_WIDTH } from '../src/render/city';
import { insideConvex, WalkSpace } from '../src/render/walk-space';
import { verticalLaneOffsets } from '../src/render/walkway';
import { polyArea, type P2 } from '../src/render/walkway-util';
import {
  analyseRoads,
  approach,
  BoxGrid,
  convexHull,
  distanceToEdges,
  distanceToPrism,
  fadeTarget,
  GHOST_OPACITY,
  gondolaOffset,
  greenFor,
  flightWells,
  groundPieces,
  inflateConvex,
  insideIntervals,
  insideRings,
  landmarkOf,
  laneLayout,
  makePrism,
  massing,
  orientedBox,
  OVERVIEW_OPACITY,
  PlanIndex,
  portalFrames,
  prismWalls,
  realHeight,
  RoadIndex,
  sceneHeight,
  segmentHitsPrism,
  signedArea,
  slabHoles,
  stepTraffic,
  subtractAll,
  wallOpenings,
  wallPanels,
  type Lane,
  type Vehicle,
  type WallRect,
} from '../src/render/city-layout';
import type { Footprint, NetEdge, NetNode, Network } from '../src/core/types';

const net = umeda.network;
const centroid = (p: P2[]): P2 => [p.reduce((s, q) => s + q[0], 0) / p.length, p.reduce((s, q) => s + q[1], 0) / p.length];
const osm = net.footprints.filter((f) => f.source === 'osm' && f.kind === 'building');
const byName = (name: string) => osm.find((f) => f.nameJa === name);
const top = (f: Footprint) => Math.max(...massing(f, 0).parts.map((p) => p.y1));
/** A 20 × 10 box, 50 high. */
const box = makePrism(
  [
    [-10, -5],
    [10, -5],
    [10, 5],
    [-10, 5],
  ],
  [],
  0,
  50,
);
/** Plan rectangle of a platform (its slab). */
const platformRect = (p: Network['platforms'][number]): P2[] => {
  const dx = p.b[0] - p.a[0];
  const dz = p.b[1] - p.a[1];
  const l = Math.hypot(dx, dz);
  const nx = (-dz / l) * (p.width / 2);
  const nz = (dx / l) * (p.width / 2);
  return convexHull([
    [p.a[0] - nx, p.a[1] - nz],
    [p.b[0] - nx, p.b[1] - nz],
    [p.b[0] + nx, p.b[1] + nz],
    [p.a[0] + nx, p.a[1] + nz],
  ]);
};

describe('OpenStreetMap context data', () => {
  it('decodes every building and street without loss', () => {
    const b = decodeBuildings(BUILDING_DATA, BUILDING_NAMES);
    expect(b.buildings.length).toBeGreaterThan(3000);
    expect(b.hankyu?.nameJa).toBe('大阪梅田');
    expect(b.hanshin?.nameJa).toBe('大阪梅田ツインタワーズ・サウス');
    for (const f of b.buildings) {
      expect(f.poly.length).toBeGreaterThanOrEqual(3);
      expect(signedArea(f.poly)).toBeGreaterThan(0);
      for (const h of f.holes ?? []) expect(signedArea(h)).toBeLessThan(0);
      expect(f.y1).toBeGreaterThan(f.y0);
      expect(f.y1).toBeLessThan(260);
      for (const [x, z] of f.poly) expect(Number.isFinite(x + z)).toBe(true);
    }
    const roads = decodeRoads(ROAD_DATA, ROAD_NAMES);
    expect(roads.length).toBeGreaterThan(300);
    for (const r of roads) {
      expect(r.points.length).toBeGreaterThanOrEqual(2);
      expect(r.width).toBeGreaterThanOrEqual(3.5);
    }
    // Varints round-trip (zig-zag, multi-character).
    const rd = new Reader('AB_A-DBA');
    expect(rd.u()).toBe(0);
    expect(rd.u()).toBe(1);
    expect(rd.u()).toBe(31 + 32 * 0);
  });

  it('has the landmarks at their mapped places with plausible heights', () => {
    const want: [string, number, number][] = [
      ['ノースゲートビルディング', 140, 160],
      ['サウスゲートビルディング', 110, 130],
      ['ヨドバシ梅田タワー', 140, 160],
      ['大阪梅田ツインタワーズ・ノース', 180, 195],
      ['JPタワー大阪', 180, 195],
      ['イノゲート大阪', 110, 130],
      ['大阪駅前第4ビル', 90, 120],
      ['HEP FIVE', 30, 50],
    ];
    for (const [name, lo, hi] of want) {
      const f = byName(name);
      expect(f, name).toBeDefined();
      expect(landmarkOf(f as Footprint), name).not.toBeNull();
      const h = top(f as Footprint);
      expect(h, name).toBeGreaterThanOrEqual(lo);
      expect(h, name).toBeLessThanOrEqual(hi);
    }
    // NGB stands north of the JR tracks, SGB south of them, ヨドバシ north of NGB.
    const c = (n: string) => centroid((byName(n) as Footprint).poly);
    expect(c('ノースゲートビルディング')[1]).toBeLessThan(c('サウスゲートビルディング')[1] - 100);
    expect(c('ヨドバシ梅田タワー')[1]).toBeLessThan(c('ノースゲートビルディング')[1] - 100);
    // The station blocks take the mapped outlines and keep their ids.
    const hk = net.footprints.find((f) => f.id === 'hankyu:bldg') as Footprint;
    const hs = net.footprints.find((f) => f.id === 'hanshin:bldg') as Footprint;
    expect(hk.kind).toBe('station');
    expect(hs.kind).toBe('station');
    expect(polyArea(hk.poly)).toBeGreaterThan(20000);
    expect(massing(hk, 0).parts.map((p) => p.look.roof)).toEqual(['none', 'shed']);
    expect(Math.max(...massing(hs, 0).parts.map((p) => p.y1))).toBeGreaterThan(180);
    expect(net.footprints.find((f) => f.id === 'jr:roof')?.kind).toBe('deck');
    // The JR station building itself is left to station.ts.
    expect(osm.some((f) => f.nameJa === '大阪駅')).toBe(false);
  });

  it('keeps heights honest: estimated ones are flagged, mapped ones match the data', () => {
    const est = osm.filter((f) => f.estimated);
    expect(est.length).toBeGreaterThan(100);
    expect(est.length).toBeLessThan(osm.length * 0.5);
    for (const f of est) expect(f.y1).toBeLessThanOrEqual(24);
  });

  it('models streets as mapped carriageways: one-way pairs that never overlap', () => {
    const roads = net.roads.filter((r) => r.source === 'osm' && !r.deck);
    const oneway = roads.filter((r) => r.oneway);
    expect(oneway.length).toBeGreaterThan(100);
    // 御堂筋 runs one way southbound from 梅田新道.
    const mido = roads.filter((r) => r.nameJa === '御堂筋' && r.oneway);
    expect(mido.length).toBeGreaterThan(0);
    // (梅田新道, where it crosses 曽根崎通, is at z ≈ 470–485.)
    const south = mido.filter((r) => Math.min(...r.points.map((p) => p[1])) > 480);
    expect(south.length, 'southbound 御堂筋 below 梅田新道').toBeGreaterThan(0);
    for (const s of south) expect(s.points[s.points.length - 1][1], s.id).toBeGreaterThan(s.points[0][1]);
    // North of it the two carriageways run both ways.
    const north = mido.filter((r) => Math.max(...r.points.map((p) => p[1])) < 480 && Math.min(...r.points.map((p) => p[1])) > 60);
    expect(north.some((r) => r.points[r.points.length - 1][1] < r.points[0][1])).toBe(true);
    expect(north.some((r) => r.points[r.points.length - 1][1] > r.points[0][1])).toBe(true);
    // Twin carriageways (side by side, opposite directions) keep their asphalt apart.
    const infos = analyseRoads(roads).infos;
    let pairs = 0;
    let overlaps = 0;
    for (let i = 0; i < infos.length; i++) {
      const a = infos[i];
      if (!a.road.oneway || a.len < 50) continue;
      for (let k = 20; k < a.len - 20; k += 10) {
        const t = { x: 0, z: 0, dx: 1, dz: 0, seg: 0 };
        const p = (pa: typeof a, s: number) => {
          const c = pa.cum;
          let j = 0;
          while (j < c.length - 2 && s > c[j + 1]) j++;
          const l = c[j + 1] - c[j] || 1;
          const u = (s - c[j]) / l;
          t.x = pa.pts[j][0] + (pa.pts[j + 1][0] - pa.pts[j][0]) * u;
          t.z = pa.pts[j][1] + (pa.pts[j + 1][1] - pa.pts[j][1]) * u;
          t.dx = (pa.pts[j + 1][0] - pa.pts[j][0]) / l;
          t.dz = (pa.pts[j + 1][1] - pa.pts[j][1]) / l;
          return t;
        };
        const q = p(a, k);
        const [x, z, dx, dz] = [q.x, q.z, q.dx, q.dz];
        for (let j = 0; j < infos.length; j++) {
          const b = infos[j];
          if (j === i || !b.road.oneway) continue;
          let best = Infinity;
          let bd = 0;
          for (let m = 0; m < b.pts.length - 1; m++) {
            const [x0, z0] = b.pts[m];
            const ex = b.pts[m + 1][0] - x0;
            const ez = b.pts[m + 1][1] - z0;
            const l2 = ex * ex + ez * ez || 1;
            const u = Math.max(0, Math.min(1, ((x - x0) * ex + (z - z0) * ez) / l2));
            const d = Math.hypot(x - x0 - ex * u, z - z0 - ez * u);
            if (d < best) {
              best = d;
              bd = (dx * ex + dz * ez) / Math.sqrt(l2);
            }
          }
          if (best < 3 || best > 30 || bd > -0.95) continue; // not an opposite twin here
          pairs++;
          if (best < (a.road.width + b.road.width) / 2 - 0.5) overlaps++;
        }
      }
    }
    expect(pairs).toBeGreaterThan(1000);
    expect(overlaps / pairs).toBeLessThan(0.01);
  });

  it('lifts expressways and flyovers onto decks, keeps river bridges as streets', () => {
    const decks = net.roads.filter((r) => r.deck);
    expect(decks.length).toBeGreaterThan(20);
    const names = new Set(decks.map((d) => d.nameJa));
    for (const n of ['新御堂筋', '阪神高速11号池田線', '国道176号']) expect(names.has(n), n).toBe(true);
    // 大江橋 (御堂筋) and 渡辺橋 (四つ橋筋) cross the 堂島川 at street level.
    expect(names.has('御堂筋')).toBe(false);
    expect(names.has('四つ橋筋')).toBe(false);
    for (const d of decks) {
      const h = d.deck as number[];
      expect(h.length).toBe(d.points.length);
      for (let i = 0; i < h.length; i++) {
        expect(h[i]).toBeGreaterThanOrEqual(0);
        expect(h[i]).toBeLessThanOrEqual(18.5);
        if (i === 0) continue;
        // Ramps no steeper than 6 % (heights are rounded to 0.1 m).
        const run = Math.hypot(d.points[i][0] - d.points[i - 1][0], d.points[i][1] - d.points[i - 1][1]);
        expect(Math.abs(h[i] - h[i - 1]), d.id).toBeLessThanOrEqual(0.06 * run + 0.11);
      }
    }
    // Most of the decks are well above the street.
    const high = decks.filter((d) => Math.max(...(d.deck as number[])) >= 6);
    expect(high.length / decks.length).toBeGreaterThan(0.7);
  });

  it('credits OpenStreetMap in the data sources', () => {
    expect(umeda.sources.some((s) => /OpenStreetMap/.test(s.title) && /ODbL/.test(s.note ?? ''))).toBe(true);
    expect(umeda.caveats.some((c) => /OpenStreetMap/.test(c) && /Overture/.test(c))).toBe(true);
  });

  it('puts the mapped crosswalks on the carriageways they cross', () => {
    const roads = net.roads.filter((r) => r.crosswalks?.length);
    const all = roads.flatMap((r) => r.crosswalks ?? []);
    expect(all.length).toBeGreaterThan(100);
    const index = new RoadIndex(analyseRoads(net.roads.filter((r) => !r.deck)).infos);
    let on = 0;
    for (const [x0, z0, x1, z1] of all) if (index.onRoad((x0 + x1) / 2, (z0 + z1) / 2)) on++;
    expect(on / all.length).toBeGreaterThan(0.95);
  });
});

describe('city heights and massing', () => {
  it('stretches the podium with the exaggeration and keeps towers at true height', () => {
    expect(sceneHeight(7, 4)).toBe(28);
    expect(sceneHeight(14, 4)).toBe(56);
    expect(sceneHeight(179, 4)).toBe(56 + 165);
    expect(sceneHeight(179, 1)).toBe(179);
    for (const ex of [1, 1.5, 4]) for (const h of [0, 3, 14, 60, 190]) expect(realHeight(sceneHeight(h, ex), ex)).toBeCloseTo(h, 9);
  });

  it('gives every building a massing with a look, towers on landmark podiums', () => {
    for (const f of osm.slice(0, 400)) {
      const m = massing(f, 1);
      expect(m.parts.length).toBeGreaterThan(0);
      for (const p of m.parts) {
        expect(p.y1).toBeGreaterThan(p.y0);
        expect(['curtain', 'grid', 'band', 'stone']).toContain(p.look.style);
      }
    }
    const ngb = massing(byName('ノースゲートビルディング') as Footprint, 0).parts;
    expect(ngb.some((p) => p.look.style === 'curtain' && p.y1 >= 140)).toBe(true);
    expect(ngb.some((p) => p.look.style === 'band' && p.y1 < 100)).toBe(true);
    // Canopies (building=roof) are thin slabs.
    const canopy = osm.find((f) => f.use === 'roof') as Footprint;
    expect(canopy.y1 - canopy.y0).toBeLessThanOrEqual(1.2);
    expect(massing(canopy, 0).parts[0].look.roof).toBe('canopy');
  });
});

describe('polygon buildings', () => {
  // An L-shaped block with a courtyard hole.
  const L: P2[] = [
    [0, 0],
    [30, 0],
    [30, 10],
    [10, 10],
    [10, 30],
    [0, 30],
  ];

  it('tests points and segments against rings with holes', () => {
    const hole: P2[] = [
      [2, 2],
      [2, 6],
      [6, 6],
      [6, 2],
    ];
    expect(insideRings([L], 5, 20)).toBe(true);
    expect(insideRings([L], 20, 20)).toBe(false);
    expect(insideRings([L, hole], 4, 4)).toBe(false);
    const iv = insideIntervals([L], -5, 5, 35, 5);
    expect(iv).toHaveLength(1);
    expect(iv[0][0]).toBeCloseTo(5 / 40, 9);
    expect(iv[0][1]).toBeCloseTo(35 / 40, 9);
    // Through the notch: in, out, in.
    expect(insideIntervals([L], 5, 25, 25, 5).length).toBe(2);
  });

  it('cuts walls clear of a station area and faces the cut into it', () => {
    const cutter: P2[] = [
      [20, -5],
      [40, -5],
      [40, 15],
      [20, 15],
    ];
    const segs = prismWalls(L, [], [cutter]);
    // Nothing stands inside the cutter.
    for (const s of segs) {
      const mx = (s.ax + s.bx) / 2;
      const mz = (s.az + s.bz) / 2;
      expect(mx > 20.01 && mx < 39.99 && mz > -4.99 && mz < 14.99).toBe(false);
    }
    // The new face along x = 20 (z 0…10) points into the cutter (+x).
    const cut = segs.find((s) => Math.abs(s.ax - 20) < 1e-6 && Math.abs(s.bx - 20) < 1e-6);
    expect(cut).toBeDefined();
    const c = cut as (typeof segs)[number];
    const len = Math.hypot(c.bx - c.ax, c.bz - c.az);
    expect(len).toBeCloseTo(10, 6);
    expect((c.bz - c.az) / len).toBeGreaterThan(0.99); // outward normal (dz, −dx)/len = (+1, 0)
    // Total facade length: the L's perimeter minus 20 m cut away plus the 10 m cut face.
    const total = segs.reduce((s, q) => s + Math.hypot(q.bx - q.ax, q.bz - q.az), 0);
    expect(total).toBeCloseTo(120 - 10 - 10 - 10 + 10, 6);
    // Uncut: the plain ring edges.
    expect(prismWalls(L, [], [])).toHaveLength(6);
  });

  it('finds the oriented box of a rotated rectangle', () => {
    const a = Math.PI / 6;
    const pts: P2[] = [
      [-20, -5],
      [20, -5],
      [20, 5],
      [-20, 5],
    ].map(([x, z]) => [100 + x * Math.cos(a) - z * Math.sin(a), 50 + x * Math.sin(a) + z * Math.cos(a)]);
    const o = orientedBox(pts);
    expect(o.hl).toBeCloseTo(20, 6);
    expect(o.hw).toBeCloseTo(5, 6);
    expect(o.cx).toBeCloseTo(100, 6);
    expect(o.cz).toBeCloseTo(50, 6);
    expect(Math.abs(o.ux * Math.cos(a) + o.uz * Math.sin(a))).toBeCloseTo(1, 6);
  });
});

describe('camera cut-away', () => {
  it('detects segments through a prism', () => {
    expect(segmentHitsPrism(-30, 10, 0, 30, 10, 0, box)).toBe(true);
    expect(segmentHitsPrism(-30, 60, 0, 30, 60, 0, box)).toBe(false);
    expect(segmentHitsPrism(-30, 10, 8, 30, 10, 8, box)).toBe(false);
    expect(segmentHitsPrism(-30, 10, 0, -12, 10, 0, box)).toBe(false);
    // Grazing a facade (inside by less than 2 × pad) is not a hit.
    expect(segmentHitsPrism(-30, 10, 4.8, 30, 10, 4.8, box, 0.4)).toBe(true);
    expect(segmentHitsPrism(-30, 10, 0, -9.7, 10, 0, box, 0.4)).toBe(false);
    expect(distanceToPrism(0, 10, 0, box)).toBe(0);
    expect(distanceToPrism(13, 10, 0, box)).toBeCloseTo(3);
    expect(distanceToPrism(0, 53, 0, box)).toBeCloseTo(3);
  });

  it('ghosts buildings between the camera and the walker, not the others', () => {
    const walk = (camera: { x: number; y: number; z: number }) => fadeTarget([box], { camera, focus: { x: 30, y: 1.5, z: 0 }, route: [], walk: true });
    expect(walk({ x: -30, y: 8, z: 0 })).toBeLessThanOrEqual(GHOST_OPACITY);
    expect(walk({ x: 50, y: 8, z: 0 })).toBe(1);
    // Camera inside the building.
    expect(walk({ x: 0, y: 8, z: 0 })).toBeLessThanOrEqual(GHOST_OPACITY);
  });

  it('keeps the overview semi-solid and clears buildings on the route', () => {
    const o = (route: { x: number; y: number; z: number }[], rest?: number) =>
      fadeTarget([box], { camera: { x: 500, y: 500, z: 500 }, focus: { x: 400, y: 0, z: 400 }, route, walk: false }, rest);
    expect(o([])).toBe(OVERVIEW_OPACITY);
    expect(o([], 0.3)).toBe(0.3);
    expect(o([{ x: 5, y: 20, z: 0 }])).toBeLessThan(OVERVIEW_OPACITY);
  });

  it('approaches targets smoothly and frame-rate independently', () => {
    expect(approach(1, 0, 0)).toBe(1);
    const a = approach(approach(1, 0, 0.05), 0, 0.05);
    expect(a).toBeCloseTo(approach(1, 0, 0.1), 9);
    expect(approach(1, 0, 10)).toBeLessThan(1e-6);
  });

  it('finds the buildings along a sight line with a grid, once each', () => {
    const boxes = [
      [0, 10, 0, 10],
      [100, 110, 0, 10],
      [50, 60, 200, 210],
      [0, 200, -5, 5],
    ];
    const g = new BoxGrid(boxes, 40);
    const out = new Int32Array(16);
    g.begin();
    let n = g.segment(-20, 5, 130, 5, out, 0);
    n = g.box(0, 5, 0, 5, out, n);
    const ids = [...out.slice(0, n)].sort();
    expect(ids).toEqual([0, 1, 3]);
  });
});

describe('streets', () => {
  const { infos, junctions } = analyseRoads(net.roads.filter((r) => !r.deck));

  it('finds the 梅田 junction where 御堂筋, 国道176号 and the others meet', () => {
    const umedaX = junctions.filter((j) => Math.hypot(j.x - 250, j.z - 75) < 30);
    expect(umedaX.length).toBeGreaterThan(0);
    const names = new Set(umedaX.flatMap((j) => j.roads.map((r) => infos[r].road.nameJa)));
    expect(names.has('御堂筋')).toBe(true);
    expect(names.has('国道176号')).toBe(true);
    for (const i of infos) for (const p of i.pts) expect(Number.isFinite(p[0] + p[1])).toBe(true);
  });

  it('runs one-way traffic one way and two-way traffic on the left', () => {
    expect(laneLayout({ id: 'a', nameJa: '', points: [], width: 10.5, oneway: true }).every((l) => l.dir === 1)).toBe(true);
    const two = laneLayout({ id: 'b', nameJa: '', points: [], width: 16 });
    expect(two.filter((l) => l.dir === 1).every((l) => l.lat > 0)).toBe(true);
    expect(two.filter((l) => l.dir === -1).every((l) => l.lat < 0)).toBe(true);
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
    const long = [{ road: { id: 'x', nameJa: '', points: [[0, 0], [600, 0]] as [number, number][], width: 10 }, pts: [[0, 0], [600, 0]] as [number, number][], cum: [0, 600], len: 600 }];
    const vehicles: Vehicle[] = [];
    for (let k = 0; k < 8; k++) vehicles.push({ lane: 0, s: 280 - k * 12, v: 8, type: 0, len: 4.6 });
    const byLane = [vehicles.map((_, i) => i)];
    // Red for phase 0 from t = 26 s: everyone queues behind the stop line.
    for (let t = 30; t < 55; t += 0.05) stepTraffic(lanes, long, vehicles, byLane, t, 0.05);
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

  it('holds traffic short of a network crossing while someone is on it', () => {
    const long = [{ road: { id: 'x', nameJa: '', points: [[0, 0], [600, 0]] as [number, number][], width: 10 }, pts: [[0, 0], [600, 0]] as [number, number][], cum: [0, 600], len: 600 }];
    const lanes: Lane[] = [{ road: 0, dir: 1, lat: 2, stops: [], phase: 0, holds: [{ s: 300, c: 0 }] }];
    const vehicles: Vehicle[] = [];
    for (let k = 0; k < 4; k++) vehicles.push({ lane: 0, s: 280 - k * 12, v: 8, type: 0, len: 4.6 });
    const byLane = [vehicles.map((_, i) => i)];
    // Green for phase 0 during t < 26, but the crossing is held: nobody passes the stop line.
    for (let t = 0; t < 20; t += 0.05) stepTraffic(lanes, long, vehicles, byLane, t, 0.05, [1]);
    for (const v of vehicles) expect(v.s + v.len / 2).toBeLessThan(300.6);
    // Released on green: they drive on.
    for (let t = 0; t < 10; t += 0.05) stepTraffic(lanes, long, vehicles, byLane, t, 0.05, [0]);
    expect(Math.max(...vehicles.map((v) => v.s))).toBeGreaterThan(300);
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
      const t0 = performance.now();
      const city = buildCity(net, { dark: false, night: false, ex: walk ? 1.5 : 4, walk });
      const ms = performance.now() - t0;
      const day = city.stats();
      expect(day.buildings).toBeGreaterThanOrEqual(3000);
      expect(day.trees).toBeGreaterThan(300);
      expect(day.vehicles).toBeGreaterThan(200);
      expect(day.drawCalls).toBeLessThanOrEqual(40);
      expect(day.triangles).toBeLessThanOrEqual(900_000);
      // Generous for loaded CI machines; ≈1 s on a desktop.
      expect(ms).toBeLessThan(6000);
      city.setNight(true);
      const night = city.stats();
      expect(night.drawCalls).toBeLessThanOrEqual(40);
      expect(night.triangles).toBeLessThanOrEqual(900_000);
      let bad = 0;
      city.object.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const a = m.geometry.getAttribute('position').array;
        for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) bad++;
      });
      expect(bad).toBe(0);
      city.dispose();
    }, 30_000);
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
  }, 30_000);

  it('keeps the overview readable: landmarks semi-solid, small low blocks fainter', () => {
    const city = buildCity(net, { dark: false, night: false, ex: 4, walk: false });
    const ngb = city.buildingFade((byName('ノースゲートビルディング') as Footprint).id) as number;
    expect(ngb).toBeCloseTo(OVERVIEW_OPACITY, 2);
    // Low blocks near the stations (within 100 m of a network node) sit well below that.
    const low = osm.filter((f) => f.y1 < 20 && !f.parts && f.use !== 'roof' && net.nodes.some((n) => Math.hypot(n.x - f.poly[0][0], n.z - f.poly[0][1]) < 100)).slice(0, 20);
    expect(low.length).toBeGreaterThan(5);
    for (const f of low) expect(city.buildingFade(f.id) as number).toBeLessThan(OVERVIEW_OPACITY * 0.6);
    city.dispose();
  }, 30_000);

  it('fades thousands of buildings: the one between camera and walker ghosts, drawn in the blended pass only', () => {
    const city = buildCity(net, { dark: false, night: false, ex: 1.5, walk: true });
    const yodo = (byName('ヨドバシ梅田タワー') as Footprint).id;
    const hep = (byName('HEP FIVE') as Footprint).id;
    expect(city.stats().buildings).toBeGreaterThan(FADE_TEX_WIDTH * 4);
    const solid = () => city.object.getObjectByName('city-curtain-solid') as THREE.Mesh;
    const drawnBefore = solid().geometry.drawRange.count;
    // Camera north of ヨドバシ, walker south of it: the tower is in the way.
    const cam = new THREE.PerspectiveCamera();
    cam.position.set(49, 20, -330);
    cam.updateMatrixWorld();
    for (let i = 0; i < 40; i++) city.update(cam, new THREE.Vector3(49, 0, -110), 1 / 30);
    expect(city.buildingFade(yodo) as number).toBeLessThan(0.2);
    expect(city.buildingFade(hep)).toBe(1);
    // Its facades left the opaque pass and joined the blended one.
    expect(solid().geometry.drawRange.count).toBeLessThan(drawnBefore);
    const ghost = city.object.getObjectByName('city-curtain-ghost') as THREE.Mesh;
    expect(ghost.visible).toBe(true);
    expect(ghost.geometry.drawRange.count).toBeGreaterThan(0);
    // Walk away (the camera behind the walker, south): it comes back solid.
    cam.position.set(49, 20, 60);
    cam.updateMatrixWorld();
    for (let i = 0; i < 120; i++) city.update(cam, new THREE.Vector3(49, 0, 40), 1 / 30);
    expect(city.buildingFade(yodo)).toBe(1);
    expect(solid().geometry.drawRange.count).toBe(drawnBefore);
    city.dispose();
  }, 30_000);
});

describe('buildCity in walkable space', () => {
  const ex = 1.5;
  const city = buildCity(net, { dark: false, night: false, ex, walk: true });
  const space = WalkSpace.of(net);

  /** World-space triangles of the named meshes (instances expanded, draw ranges honoured), bucketed on a 4 m grid. */
  function soup(test: RegExp): { tri: Float32Array; grid: Map<string, number[]> } {
    const out: number[] = [];
    const m4 = new THREE.Matrix4();
    const inst = new THREE.Matrix4();
    const v = new THREE.Vector3();
    city.object.updateMatrixWorld(true);
    city.object.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.visible || !test.test(mesh.name)) return;
      const pos = mesh.geometry.getAttribute('position');
      const idx = mesh.geometry.getIndex();
      const im = mesh as THREE.InstancedMesh;
      for (let k = 0; k < (im.isInstancedMesh ? im.count : 1); k++) {
        m4.copy(mesh.matrixWorld);
        if (im.isInstancedMesh) m4.multiply((im.getMatrixAt(k, inst), inst));
        const n = idx ? Math.min(idx.count, mesh.geometry.drawRange.count) : pos.count;
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
      if ((x1 - x0) * (z1 - z0) > 4000) continue;
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
    const solid = soup(/^city-((curtain|grid|band|stone|roofs)-solid|ground|roads|sidewalks|markings|wheel|viaducts)$/);
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

  it('keeps every mapped building out of the elevated stations’ platforms', () => {
    const s = soup(/^city-((curtain|grid|band|stone|roofs)-solid)$/);
    const plats = net.platforms.filter((p) => p.stationId === 'jr' || p.stationId === 'hankyu');
    const rects = plats.map((p) => ({ p, rect: inflateConvex(platformRect(p), -0.3) }));
    // Only the 阪急 station block (concourse under the platforms, shed over them) may be there.
    const hk = net.footprints.find((f) => f.id === 'hankyu:bldg') as Footprint;
    const bad: string[] = [];
    for (let t = 0; t < s.tri.length / 9; t++) {
      const x = (s.tri[t * 9] + s.tri[t * 9 + 3] + s.tri[t * 9 + 6]) / 3;
      const y = (s.tri[t * 9 + 1] + s.tri[t * 9 + 4] + s.tri[t * 9 + 7]) / 3;
      const z = (s.tri[t * 9 + 2] + s.tri[t * 9 + 5] + s.tri[t * 9 + 8]) / 3;
      for (const { p, rect } of rects) {
        if (y < p.y * ex - 1 || y > (p.y + 10) * ex) continue;
        if (!insideConvex(rect, x, z)) continue;
        if (p.stationId === 'hankyu' && (insideRings([hk.poly], x, z) || distanceToEdges([hk.poly], x, z) < 0.6)) continue;
        bad.push(`${p.id} ${x.toFixed(1)},${y.toFixed(1)},${z.toFixed(1)}`);
      }
      if (bad.length > 5) break;
    }
    expect(bad).toEqual([]);
  });

  it('lays pavements beside the roads, never through a building', () => {
    // Street-level volumes, as the city lays them out (parts from the ground up, no canopies).
    const plan = new PlanIndex(
      net.footprints
        .filter((f) => f.kind === 'building' || f.kind === 'station')
        .flatMap((f, i) => massing(f, i).parts)
        .filter((p) => p.y0 < 1 && p.look.roof !== 'canopy')
        .map((p) => [p.poly, ...p.holes]),
    );
    const walks = soup(/^city-sidewalks$/);
    let tops = 0;
    let inside = 0;
    for (let t = 0; t < walks.tri.length / 9; t++) {
      const y = walks.tri[t * 9 + 1];
      if (Math.abs(y - 0.15) > 1e-3 || Math.abs(walks.tri[t * 9 + 4] - 0.15) > 1e-3) continue; // pavement tops only
      tops++;
      const x = (walks.tri[t * 9] + walks.tri[t * 9 + 3] + walks.tri[t * 9 + 6]) / 3;
      const z = (walks.tri[t * 9 + 2] + walks.tri[t * 9 + 5] + walks.tri[t * 9 + 8]) / 3;
      if (plan.inside(x, z)) inside++;
    }
    expect(tops).toBeGreaterThan(1000);
    expect(inside / tops).toBeLessThan(0.005);
  });

  it('keeps traffic off walking lines and pavements out of street-level concourses', () => {
    const crossingIds = new Set(net.edges.filter((e) => e.kind === 'crossing').map((e) => e.id));
    /** Is (x, z) on a street-level walking line other than a crossing (indoor ones only)? */
    const onWalk = (x: number, z: number, indoorOnly: boolean) =>
      space.query(x, x, z, z).some((p) => {
        if (p.kind !== 'corridor' || crossingIds.has(p.id) || (indoorOnly && !p.indoor)) return false;
        const f = p.f0 + p.fx * x + p.fz * z;
        return f > -0.6 && f < 1.2 && insideConvex(p.poly, x, z);
      });
    const cam = new THREE.PerspectiveCamera();
    cam.position.set(200, 10, 0);
    cam.updateMatrixWorld();
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    let shown = 0;
    const bad: string[] = [];
    for (let step = 0; step < 4; step++) {
      for (let i = 0; i < 30; i++) city.update(cam, new THREE.Vector3(230, 0, 0), 1 / 10);
      for (const name of ['city-cars', 'city-buses']) {
        const mesh = city.object.getObjectByName(name) as THREE.InstancedMesh;
        for (let i = 0; i < mesh.count; i++) {
          mesh.getMatrixAt(i, m);
          if (Math.abs(m.determinant()) < 1e-9) continue;
          shown++;
          p.setFromMatrixPosition(m);
          if (onWalk(p.x, p.z, false)) bad.push(`${name} ${i} at ${p.x.toFixed(1)},${p.z.toFixed(1)}`);
        }
      }
    }
    expect(shown).toBeGreaterThan(500);
    expect(bad).toEqual([]);
    const walks = soup(/^city-sidewalks$/);
    let inConcourse = 0;
    for (let t = 0; t < walks.tri.length / 9; t++) {
      if (Math.abs(walks.tri[t * 9 + 1] - 0.15) > 1e-3) continue;
      const x = (walks.tri[t * 9] + walks.tri[t * 9 + 3] + walks.tri[t * 9 + 6]) / 3;
      const z = (walks.tri[t * 9 + 2] + walks.tri[t * 9 + 5] + walks.tri[t * 9 + 8]) / 3;
      if (onWalk(x, z, true)) inConcourse++;
    }
    expect(inConcourse).toBe(0);
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
    // The wheel stands on HEP FIVE.
    const hep = byName('HEP FIVE') as Footprint;
    const c = wheel.getCenter(new THREE.Vector3());
    expect(insideRings([hep.poly], c.x, c.z)).toBe(true);
  });
});
