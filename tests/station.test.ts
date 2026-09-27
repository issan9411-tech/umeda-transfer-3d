import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { NetEdge, NetNode, Network } from '../src/core/types';
import { umeda } from '../src/data/umeda';
import { buildStations, buildTrainModel, computeWells, FrameSpace, stationLayouts } from '../src/render/station';
import { clipToRect, frameOf, gaps, hash01, rectArea, rectMinusHoles, toLocal, toWorld } from '../src/render/station-geo';
import { signAtlas } from '../src/render/station-tex';
import { bodyProfile, carsFor, liveryFor, trainLength, trainParts } from '../src/render/train';
import { WalkSpace } from '../src/render/walk-space';
import { verticalLaneOffsets } from '../src/render/walkway';

const net = umeda.network;
const walkOpts = { Y: (y: number) => y * 1.5, ex: 1.5, dark: false, levelVisible: () => true, walk: true };

function stats(g: THREE.Object3D): { meshes: number; tris: number; finite: boolean } {
  let meshes = 0;
  let tris = 0;
  let finite = true;
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.geometry) return;
    meshes++;
    const pos = m.geometry.getAttribute('position');
    tris += pos.count / 3;
    for (let i = 0; i < pos.array.length; i++) if (!Number.isFinite(pos.array[i])) finite = false;
    const nor = m.geometry.getAttribute('normal');
    if (nor) for (let i = 0; i < nor.array.length; i++) if (!Number.isFinite(nor.array[i])) finite = false;
  });
  return { meshes, tris, finite };
}

describe('plan helpers', () => {
  it('round-trips frame coordinates with t to the left of a→b', () => {
    const f = frameOf([10, 5], [110, 5]);
    const [x, z] = toWorld(f, 30, 4);
    // Heading east (+x), left is north (−z).
    expect(x).toBeCloseTo(40);
    expect(z).toBeCloseTo(1);
    const [s, t] = toLocal(f, x, z);
    expect(s).toBeCloseTo(30);
    expect(t).toBeCloseTo(4);
  });

  it('subtracts overlapping holes from a slab exactly', () => {
    const outer = { s0: 0, s1: 100, t0: 0, t1: 10 };
    const holes = [
      { s0: 10, s1: 20, t0: 2, t1: 6 },
      { s0: 15, s1: 30, t0: 4, t1: 8 },
      { s0: 90, s1: 120, t0: -5, t1: 15 }, // clipped to the outer edge
    ];
    const parts = rectMinusHoles(outer, holes);
    // Union of the holes inside: 40 + 60 − 10 (overlap) + 100.
    expect(rectArea(parts)).toBeCloseTo(1000 - 190);
    for (const r of parts) {
      expect(r.s1).toBeGreaterThan(r.s0);
      expect(r.t1).toBeGreaterThan(r.t0);
    }
    expect(rectMinusHoles(outer, [])).toEqual([outer]);
  });

  it('clips convex polygons to rectangles', () => {
    const tri: [number, number][] = [
      [0, 0],
      [4, 0],
      [0, 4],
    ];
    const q = clipToRect(tri, { s0: 1, s1: 5, t0: -1, t1: 1 });
    // Trapezoid 1 ≤ s ≤ 4 − t, 0 ≤ t ≤ 1: area (3 + 2) / 2.
    let area = 0;
    q.forEach(([a, b], i) => {
      const [c, d] = q[(i + 1) % q.length];
      area += a * d - c * b;
    });
    expect(Math.abs(area) / 2).toBeCloseTo(2.5);
    expect(clipToRect(tri, { s0: 5, s1: 6, t0: 0, t1: 1 })).toEqual([]);
    expect(clipToRect(tri, { s0: 4, s1: 6, t0: 0, t1: 1 })).toEqual([]); // touching only
  });

  it('lists the gaps between covered intervals', () => {
    expect(gaps(0, 10, [[2, 3], [2.5, 5], [9, 12]])).toEqual([[0, 2], [5, 9]]);
    expect(gaps(0, 10, [[2, 3]], 2.5)).toEqual([[3, 10]]);
    expect(gaps(0, 10, [[-1, 11]])).toEqual([]);
  });

  it('hashes deterministically into [0, 1)', () => {
    expect(hash01('jr:3:train')).toBe(hash01('jr:3:train'));
    for (const k of ['a', 'b', 'hankyu:8:dir', '']) {
      expect(hash01(k)).toBeGreaterThanOrEqual(0);
      expect(hash01(k)).toBeLessThan(1);
    }
  });
});

describe('station layouts', () => {
  const byId = new Map(stationLayouts(net).map((l) => [l.id, l]));

  it('lays out every station with the right number of tracks', () => {
    expect([...byId.keys()].sort()).toEqual(['hankyu', 'hanshin', 'higashiumeda', 'jr', 'kitashinchi', 'nishiumeda', 'umeda', 'umekita']);
    expect(byId.get('jr')!.tracks).toHaveLength(11); // 5 islands + platform 11 (one side)
    expect(byId.get('hankyu')!.tracks).toHaveLength(9);
    expect(byId.get('hankyu')!.surfs.filter((s) => !s.head)).toHaveLength(10); // 10面9線
    expect(byId.get('hanshin')!.tracks).toHaveLength(3); // the middle track is shared
    expect(byId.get('umekita')!.tracks).toHaveLength(4);
    for (const id of ['kitashinchi', 'umeda', 'higashiumeda', 'nishiumeda']) expect(byId.get(id)!.tracks).toHaveLength(2);
  });

  it('numbers JR tracks 1 (south) to 11 (north) and keeps them clear of the platforms', () => {
    const jr = byId.get('jr')!;
    expect(jr.tracks.map((t) => t.label)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11']);
    for (const tr of jr.tracks) for (const s of jr.surfs) expect(tr.t > s.t1 + 1.4 || tr.t < s.t0 - 1.4).toBe(true);
  });

  it('puts buffer stops at the terminal ends only', () => {
    expect(byId.get('hankyu')!.tracks.every((t) => t.buf0 && !t.buf1)).toBe(true);
    expect(byId.get('hanshin')!.tracks.every((t) => !t.buf0 && t.buf1)).toBe(true);
    expect(byId.get('nishiumeda')!.tracks.every((t) => !t.buf0 && t.buf1)).toBe(true);
    expect(byId.get('jr')!.tracks.some((t) => t.buf0 || t.buf1)).toBe(false);
  });

  it('keeps the 阪急 walk centrelines on a platform between two tracks', () => {
    const hk = byId.get('hankyu')!;
    for (const p of net.platforms.filter((x) => x.stationId === 'hankyu')) {
      const [, t] = toLocal(hk.f, (p.a[0] + p.b[0]) / 2, (p.a[1] + p.b[1]) / 2);
      const surf = hk.surfs.find((s) => !s.head && t > s.t0 + 2 && t < s.t1 - 2);
      expect(surf).toBeDefined();
    }
  });
});

describe('buildStations', () => {
  it('builds finite geometry in few draw calls and within the triangle budget', () => {
    for (const walk of [false, true]) {
      for (const dark of [false, true]) {
        const g = buildStations(net, { ...walkOpts, walk, dark, Y: (y) => y * (walk ? 1.5 : 4), ex: walk ? 1.5 : 4 });
        const s = stats(g);
        expect(s.finite).toBe(true);
        expect(s.meshes).toBeGreaterThanOrEqual(8);
        expect(s.meshes).toBeLessThanOrEqual(20);
        expect(s.tris).toBeLessThan(400_000);
      }
    }
  });

  it('hides stations on hidden levels', () => {
    const all = stats(buildStations(net, walkOpts)).tris;
    const noUnderground = stats(buildStations(net, { ...walkOpts, levelVisible: (l) => !l.startsWith('B') })).tris;
    expect(noUnderground).toBeLessThan(all);
    const none = buildStations(net, { ...walkOpts, levelVisible: () => false });
    expect(stats(none).meshes).toBe(0);
  });

  it('keeps occupied tracks free for the caller’s own trains', () => {
    const count = (g: THREE.Group) => ((g.getObjectByName('train-bodies') as THREE.Mesh | undefined)?.geometry.getAttribute('position').count ?? 0);
    const focus = ['ks-1-2'];
    const a = count(buildStations(net, { ...walkOpts, focus }));
    const b = count(buildStations(net, { ...walkOpts, focus, occupied: [{ platformId: 'ks-1-2', side: 1 }] }));
    expect(b).toBeLessThan(a);
  });
});

describe('walkable space', () => {
  /** A 4 m wide corridor along x from −10 to 10 at street level. */
  const corridor = (): Network => {
    const n = (id: string, x: number): NetNode => ({ id, kind: 'junction', name: id, x, y: 0, z: 0, level: '1F' });
    const e: NetEdge = { id: 'c', a: 'a', b: 'b', kind: 'walk', indoor: true, width: 4 };
    return { levels: [], lines: [], stations: [], platforms: [], nodes: [n('a', -10), n('b', 10)], edges: [e], footprints: [], roads: [] };
  };
  // s along +x from x = −20, t = −z.
  const fs = new FrameSpace(WalkSpace.of(corridor()), frameOf([-20, 0], [20, 0]));

  it('opens a wall where a walkway passes, keeping the sill and a lintel above its head room', () => {
    const parts = fs.panel('t', 20, -5, 5, -1, 4);
    const at = (u: number) => parts.filter((q) => q.s0 < u && q.s1 > u);
    // Beside the corridor the wall is whole.
    expect(at(-4)).toEqual([{ s0: -5, s1: expect.closeTo(-2, 5), t0: -1, t1: 4 }]);
    expect(at(4)[0].t0).toBe(-1);
    // Across it: sill up to the floor, lintel from the head room up.
    const cut = at(0).sort((a, b) => a.t0 - b.t0);
    expect(cut).toHaveLength(2);
    expect(cut[0].t1).toBeCloseTo(-0.01);
    expect(cut[1].t0).toBeCloseTo(2.31);
    expect(cut[1].t1).toBe(4);
  });

  it('trims long boxes, recesses slabs over head room and holes them where walkways pass through', () => {
    const runs = fs.runs('s', { s0: 0, s1: 40, t0: -0.1, t1: 0.1 }, 0.5, 1.5);
    expect(runs.length).toBe(2);
    expect(runs[0][1]).toBeLessThan(10);
    expect(runs[1][0]).toBeGreaterThan(30);
    const over = fs.slab({ s0: 0, s1: 40, t0: -5, t1: 5 }, 1.5, 3);
    expect(over.holes).toEqual([]);
    expect(over.recesses.length).toBeGreaterThan(0);
    for (const r of over.recesses) expect(r.y).toBeCloseTo(0 + 2.3 + 0.02);
    const low = fs.slab({ s0: 0, s1: 40, t0: -5, t1: 5 }, 1.5, 2.0);
    expect(low.recesses).toEqual([]);
    expect(low.holes.length).toBeGreaterThan(0);
    // Far above, nothing to give up.
    expect(fs.slab({ s0: 0, s1: 40, t0: -5, t1: 5 }, 5, 6)).toEqual({ holes: [], recesses: [] });
    expect(fs.post({ s0: 19.8, s1: 20.2, t0: -0.2, t1: 0.2 }, 0, 4)).toEqual([[expect.closeTo(2.31, 5), 4]]);
  });

  it('cuts one well over a whole staircase, landings included', () => {
    const wells = computeWells(net, walkOpts);
    const vertical = net.edges.filter((e) => e.kind === 'stairs' || e.kind === 'escalator' || e.kind === 'elevator').length;
    const landings = net.nodes.filter((n) => n.landing);
    expect(landings.length).toBeGreaterThan(10);
    // Each landing node joins two flights of the same staircase.
    expect(wells).toHaveLength(vertical - landings.length);
    const inside = (c: [number, number][], x: number, z: number) => {
      let sign = 0;
      for (let i = 0; i < c.length; i++) {
        const [ax, az] = c[i];
        const [bx, bz] = c[(i + 1) % c.length];
        const k = Math.sign((bx - ax) * (z - az) - (bz - az) * (x - ax));
        if (k && sign && k !== sign) return false;
        sign ||= k;
      }
      return true;
    };
    for (const n of landings) expect(wells.some((w) => inside(w.corners, n.x, n.z) && w.lo < 1.5 * n.y && w.hi > 1.5 * n.y), n.id).toBe(true);
  });

  it('never stands in the walker’s way: no slab, wall, column or screen across any walkway', () => {
    // Walk every edge as the walk-through does (centre line, stair lanes, feet just above the
    // floor) and test the body against the station's solid meshes: horizontal faces between the
    // knees and the head, vertical faces crossed at three body heights.
    const group = buildStations(net, walkOpts);
    const tris: number[] = [];
    for (const name of ['station-structure', 'station-shell', 'station-glass']) {
      const pos = (group.getObjectByName(name) as THREE.Mesh).geometry.getAttribute('position').array;
      for (let i = 0; i < pos.length; i++) tris.push(pos[i]);
    }
    const cell = 4;
    const grid = new Map<string, number[]>();
    for (let t = 0; t < tris.length / 9; t++) {
      const xs = [tris[t * 9], tris[t * 9 + 3], tris[t * 9 + 6]];
      const zs = [tris[t * 9 + 2], tris[t * 9 + 5], tris[t * 9 + 8]];
      const [x0, x1, z0, z1] = [Math.floor(Math.min(...xs) / cell), Math.floor(Math.max(...xs) / cell), Math.floor(Math.min(...zs) / cell), Math.floor(Math.max(...zs) / cell)];
      if ((x1 - x0 + 1) * (z1 - z0 + 1) > 4000) continue;
      for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) grid.set(`${x},${z}`, [...(grid.get(`${x},${z}`) ?? []), t]);
    }
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const n = new THREE.Vector3();
    const ray = new THREE.Ray();
    const hit = new THREE.Vector3();
    /** Whether segment p→q crosses a triangle that is horizontal (flat) or vertical (!flat). */
    const crosses = (p: THREE.Vector3, q: THREE.Vector3, flat: boolean) => {
      const len = p.distanceTo(q);
      ray.set(p, q.clone().sub(p).normalize());
      const seen = new Set<number>();
      for (let x = Math.floor(Math.min(p.x, q.x) / cell); x <= Math.floor(Math.max(p.x, q.x) / cell); x++) {
        for (let z = Math.floor(Math.min(p.z, q.z) / cell); z <= Math.floor(Math.max(p.z, q.z) / cell); z++) {
          for (const t of grid.get(`${x},${z}`) ?? []) {
            if (seen.has(t)) continue;
            seen.add(t);
            a.fromArray(tris, t * 9);
            b.fromArray(tris, t * 9 + 3);
            c.fromArray(tris, t * 9 + 6);
            n.subVectors(b, a).cross(c.clone().sub(a)).normalize();
            if (Math.abs(n.y) >= 0.5 !== flat) continue;
            const r = ray.intersectTriangle(a, b, c, false, hit);
            if (r && p.distanceTo(hit) > 1e-6 && p.distanceTo(hit) < len - 1e-6) return true;
          }
        }
      }
      return false;
    };
    const lanes = verticalLaneOffsets({ edges: net.edges, nodes: net.nodes });
    const byId = new Map(net.nodes.map((x) => [x.id, x]));
    const bad: string[] = [];
    net.edges.forEach((e, i) => {
      const na = byId.get(e.a)!;
      const nb = byId.get(e.b)!;
      const lift = 0.09 + (e.kind === 'stairs' ? 0.135 : e.kind === 'escalator' ? 0.35 : 0);
      const A = new THREE.Vector3(na.x + lanes[i * 2], na.y * 1.5 + lift, na.z + lanes[i * 2 + 1]);
      const B = new THREE.Vector3(nb.x + lanes[i * 2], nb.y * 1.5 + lift, nb.z + lanes[i * 2 + 1]);
      const steps = Math.max(1, Math.ceil(A.distanceTo(B) / 0.5));
      for (let k = 0; k <= steps; k++) {
        const p = A.clone().lerp(B, k / steps);
        if (e.kind !== 'elevator' && crosses(p.clone().setY(p.y + 0.35), p.clone().setY(p.y + 2), true)) {
          bad.push(`${e.id} slab`);
          return;
        }
        if (k === steps) continue;
        const q = A.clone().lerp(B, (k + 1) / steps);
        if ([0.7, 1.3, 1.9].some((h) => crosses(p.clone().setY(p.y + h), q.clone().setY(q.y + h), false))) {
          bad.push(`${e.id} wall`);
          return;
        }
      }
    });
    expect(bad).toEqual([]);
  }, 60_000);
});

describe('trains', () => {
  it('fits whole cars on the platform, capped by the line’s formation', () => {
    expect(carsFor('jr-kobe', 340)).toBe(12);
    expect(carsFor('jr-loop', 340)).toBe(8);
    expect(carsFor('hanshin', 138)).toBe(6);
    expect(carsFor('jr-kobe', 60)).toBe(2);
    const l = liveryFor('midosuji');
    expect(trainLength(l, 10)).toBeCloseTo(10 * l.carLen + 9 * 0.5);
  });

  it('builds a closed, symmetric body profile', () => {
    const ring = bodyProfile(2.95);
    expect(ring[0][0]).toBeCloseTo(-ring[ring.length - 1][0]);
    expect(Math.max(...ring.map((p) => p[1]))).toBeLessThanOrEqual(3.72 + 1e-9);
    expect(Math.max(...ring.map((p) => Math.abs(p[0])))).toBeCloseTo(2.95 / 2);
  });

  it('adds wheels only in detail mode', () => {
    const lo = trainParts('jr-kobe', 4, false);
    const hi = trainParts('jr-kobe', 4, true);
    expect(hi.equip.vertexCount).toBeGreaterThan(lo.equip.vertexCount * 2);
    expect(lo.body.vertexCount).toBe(hi.body.vertexCount);
    expect(lo.body.uv.length / 2).toBe(lo.body.vertexCount);
  });

  it('stands a train on the rails beside its platform', () => {
    stationLayouts(net);
    const p = net.platforms.find((x) => x.id === 'jr-11')!;
    const line = net.lines.find((x) => x.id === 'jr-ltd')!;
    // Platform 11 has a track on its south (right) side only: side 1 snaps there.
    const g = buildTrainModel(p, line, { Y: (y) => y * 1.5, ex: 1.5, dark: false, side: 1 });
    expect(g.children).toHaveLength(2);
    const s = stats(g);
    expect(s.finite).toBe(true);
    const box = new THREE.Box3().setFromObject(g);
    const c = box.getCenter(new THREE.Vector3());
    const f = frameOf(p.a, p.b);
    const [, t] = toLocal(f, c.x, c.z);
    expect(t).toBeCloseTo(-(p.width / 2 + 1.65), 0);
    // Floor at platform height: body bottom a little below the platform edge (7.5 m × 1.5).
    expect(box.min.y).toBeGreaterThan(7.5 * 1.5 - 1.15 * 1.5 - 0.1);
  });
});

describe('sign atlas', () => {
  it('assigns every sign a UV cell even without a DOM', () => {
    const a = signAtlas([
      { kind: 'name', key: 'n1', style: 'jr', color: '#f07f1b', kanji: '大阪', kana: 'おおさか', roman: 'Ōsaka' },
      { kind: 'num', key: 'k1', style: 'metro', color: '#e5171f', items: [{ no: '1', text: 'なんば' }] },
    ]);
    expect(a.texture).toBeNull();
    for (const k of ['n1', 'k1']) {
      const [u0, v0, u1, v1] = a.uv.get(k)!;
      expect(u1).toBeGreaterThan(u0);
      expect(v1).toBeGreaterThan(v0);
    }
  });
});
