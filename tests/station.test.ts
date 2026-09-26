import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { umeda } from '../src/data/umeda';
import { buildStations, buildTrainModel, stationLayouts } from '../src/render/station';
import { frameOf, hash01, rectArea, rectMinusHoles, toLocal, toWorld } from '../src/render/station-geo';
import { signAtlas } from '../src/render/station-tex';
import { bodyProfile, carsFor, liveryFor, trainLength, trainParts } from '../src/render/train';

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
