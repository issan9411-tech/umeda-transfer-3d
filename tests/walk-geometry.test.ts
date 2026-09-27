import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../src/core/graph';
import { umeda } from '../src/data/umeda';
import { buildCity } from '../src/render/city';
import { buildStations } from '../src/render/station';
import { buildWalkway, verticalLaneOffsets } from '../src/render/walkway';
import { lateralRoom } from '../src/sim/crowd';
import { Soup, type Tri } from './support/soup';

/**
 * Physical consistency of the walk-through (the user's complaint: 「壁を抜けたり、階段の位置が
 * おかしい」): build the walk-mode scene exactly as the view does, walk every edge of the network
 * the way the walker does (and along the outermost lanes the crowd uses), and check that nothing
 * solid stands in the way — walkway, station or city — nothing horizontal cuts through a body,
 * and there is always a floor.
 */

const EX = 1.5;
const Y = (y: number) => y * EX;
const FLOOR_LIFT = 0.09;

const WALLISH = /^(walls|shopfronts|glass|fittings|stairs|escalator-treads|station-structure|station-shell|station-glass|train-bodies|train-equipment|city-.*-solid|city-roofs-solid|city-trunks|city-lamp-poles|city-wheel)$/;
const FLOORISH = /^(floor-.*|markings|stairs|escalator-treads|station-structure|station-shell|track-ballast|track-slab|city-ground)$/;
const SLABISH = /^(floor-.*|ceilings|stairs|escalator-treads|station-structure|station-shell|station-roof-top|city-ground|city-roofs-solid|city-.*-solid)$/;

interface Tally {
  wall: Map<string, number>;
  slab: Map<string, number>;
  floating: number;
  crowdWall: Map<string, number>;
  crowdFloating: number;
  samples: number;
  /** Underground corridors (≥ 9 m): share of samples with no wall within reach on each side. */
  sides: Map<string, { a: string; b: string; open: [number, number] }>;
  /** Underground junctions: the widest sweep (degrees) that sees neither a corridor nor a wall. */
  hubs: Map<string, number>;
}

const g = buildGraph(umeda.network);
let tally: Tally;

function bump(m: Map<string, number>, k: string): void {
  m.set(k, (m.get(k) ?? 0) + 1);
}

beforeAll(() => {
  const walk = buildWalkway(g, { Y, ex: EX, dark: false, levelVisible: () => true });
  const st = buildStations(g.net, { Y, ex: EX, dark: false, levelVisible: () => true, walk: true });
  const city = buildCity(g.net, { dark: false, night: false, ex: EX, walk: true });
  const soup = new Soup();
  for (const o of [walk, st, city.object]) soup.addObject(o, (m) => m.name || null);
  const lanes = verticalLaneOffsets(g);
  const wallF = (t: Tri) => Math.abs(t.n.y) < 0.5 && WALLISH.test(t.tag);
  const slabF = (t: Tri) => Math.abs(t.n.y) >= 0.5 && SLABISH.test(t.tag);
  const floorF = (t: Tri) => Math.abs(t.n.y) >= 0.5 && FLOORISH.test(t.tag);
  const shafts = g.edges.filter((e) => e.kind === 'elevator').map((e) => g.nodes[g.nodeIndex.get(e.a)!]);
  const inShaft = (p: THREE.Vector3) => shafts.some((n) => Math.abs(p.x - n.x) < 1.35 && Math.abs(p.z - n.z) < 1.35);
  const hasFloor = (p: THREE.Vector3) =>
    [
      [0, 0],
      [0.12, 0.05],
      [-0.1, -0.08],
    ].some(([ox, oz]) => soup.hit(new THREE.Vector3(p.x + ox, p.y + 0.45, p.z + oz), new THREE.Vector3(p.x + ox, p.y - 0.7, p.z + oz), floorF));
  tally = { wall: new Map(), slab: new Map(), floating: 0, crowdWall: new Map(), crowdFloating: 0, samples: 0, sides: new Map(), hubs: new Map() };

  // Side walls: from points along each underground corridor, look sideways at head height for a
  // wall within the corridor's half width + 2.5 m. A corridor that sees none on one side for much
  // of its length looks out across empty space (a junction left open behind, a missing wall).
  for (const e of g.edges) {
    if (e.kind !== 'walk') continue;
    const a = g.nodes[g.nodeIndex.get(e.a)!];
    const b = g.nodes[g.nodeIndex.get(e.b)!];
    if (a.y > -3 || b.y > -3) continue;
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 9) continue;
    const dx = (b.x - a.x) / len;
    const dz = (b.z - a.z) / len;
    const reach = Math.max(4, (e.width ?? 4) / 2 + 2.5);
    const n = Math.max(2, Math.floor(len / 3));
    const open: [number, number] = [0, 0];
    for (let i = 1; i < n; i++) {
      const f = i / n;
      const p = new THREE.Vector3(a.x + (b.x - a.x) * f, Y(a.y + (b.y - a.y) * f) + 1.3, a.z + (b.z - a.z) * f);
      [-1, 1].forEach((side, k) => {
        const q = p.clone().add(new THREE.Vector3(-dz * side * reach, 0, dx * side * reach));
        if (!soup.hit(p, q, (t) => Math.abs(t.n.y) < 0.5)) open[k]++;
      });
    }
    tally.sides.set(e.id, { a: e.a, b: e.b, open: [open[0] / (n - 1), open[1] / (n - 1)] });
  }
  // Junction hubs: from each underground junction look out at head height all round. A direction
  // that runs along no corridor must meet a wall within the widest corridor's half width + 3 m.
  const arms = new Map<string, { ang: number; w: number; len: number }[]>();
  for (const e of g.edges) {
    if (e.kind === 'stairs' || e.kind === 'escalator' || e.kind === 'elevator') continue;
    const a = g.nodes[g.nodeIndex.get(e.a)!];
    const b = g.nodes[g.nodeIndex.get(e.b)!];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 0.5) continue;
    for (const [p, q] of [
      [a, b],
      [b, a],
    ]) {
      const l = arms.get(p.id) ?? [];
      l.push({ ang: Math.atan2(q.z - p.z, q.x - p.x), w: e.width ?? 6, len });
      arms.set(p.id, l);
    }
  }
  for (const [id, l] of arms) {
    const n = g.nodes[g.nodeIndex.get(id)!];
    // Named junctions only: the steps at the ends of flights stand in the open halls of stations.
    if (n.y > -3 || l.length < 2 || n.platformId || id.includes(':') || id.includes('>')) continue;
    const R = Math.max(...l.map((x) => x.w)) / 2 + 3;
    const p = new THREE.Vector3(n.x, Y(n.y) + 1.3, n.z);
    const K = 36;
    const open: boolean[] = [];
    for (let k = 0; k < K; k++) {
      const t = (2 * Math.PI * k) / K - Math.PI;
      const along = l.some((x) => {
        const d = Math.abs(((t - x.ang + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
        return d < Math.atan2(x.w / 2 + 0.5, Math.min(R, x.len)) + 0.05;
      });
      open.push(!along && !soup.hit(p, p.clone().add(new THREE.Vector3(Math.cos(t) * R, 0, Math.sin(t) * R)), (tr) => Math.abs(tr.n.y) < 0.5));
    }
    let best = 0;
    let run = 0;
    for (let k = 0; k < 2 * K; k++) {
      run = open[k % K] ? run + 1 : 0;
      best = Math.max(best, Math.min(run, K));
    }
    tally.hubs.set(id, (best * 360) / K);
  }

  g.edges.forEach((e, ei) => {
    const na = g.nodes[g.nodeIndex.get(e.a)!];
    const nb = g.nodes[g.nodeIndex.get(e.b)!];
    const lift = FLOOR_LIFT + (e.kind === 'stairs' ? 0.09 * EX : e.kind === 'escalator' ? 0.35 : 0);
    const A = new THREE.Vector3(na.x + lanes[ei * 2], Y(na.y) + lift, na.z + lanes[ei * 2 + 1]);
    const B = new THREE.Vector3(nb.x + lanes[ei * 2], Y(nb.y) + lift, nb.z + lanes[ei * 2 + 1]);
    const len = A.distanceTo(B);
    const n = Math.max(1, Math.ceil(len / 0.5));
    for (let i = 0; i <= n; i++) {
      const p = A.clone().lerp(B, i / n);
      tally.samples++;
      if (e.kind !== 'elevator' && !inShaft(p)) {
        if (!hasFloor(p)) tally.floating++;
        const s = soup.hit(p.clone().setY(p.y + 0.35), p.clone().setY(p.y + 2.0), slabF);
        if (s) bump(tally.slab, s.tri.tag);
      }
      if (i < n) {
        const q = A.clone().lerp(B, (i + 1) / n);
        for (const h of [0.7, 1.3, 1.9]) {
          const w = soup.hit(p.clone().setY(p.y + h), q.clone().setY(q.y + h), wallF);
          if (w) {
            bump(tally.wall, w.tri.tag);
            break;
          }
        }
      }
    }
    // The crowd's outermost lanes.
    const room = lateralRoom(e.kind, e.width);
    if (room <= 0 || len < 0.5) return;
    const dx = (B.x - A.x) / len;
    const dz = (B.z - A.z) / len;
    for (const side of [-1, 1]) {
      let r = Math.min(room, e.room ? e.room[side < 0 ? 0 : 1] : room);
      if (e.kind === 'gate') r = Math.floor((r * 0.95) / 0.9 + 0.5) * 0.9;
      const off = new THREE.Vector3(-dz * r * side, 0, dx * r * side);
      for (let i = 0; i <= n; i++) {
        const p = A.clone().lerp(B, i / n).add(off);
        if (!inShaft(p) && !hasFloor(p)) tally.crowdFloating++;
        if (i < n) {
          const q = A.clone().lerp(B, (i + 1) / n).add(off);
          const w = soup.hit(p.clone().setY(p.y + 1.3), q.clone().setY(q.y + 1.3), wallF);
          if (w) bump(tally.crowdWall, w.tri.tag);
        }
      }
    }
  });
}, 120_000);

const total = (m: Map<string, number>, re: RegExp = /./) => [...m].filter(([k]) => re.test(k)).reduce((s, [, v]) => s + v, 0);

describe('walking through the 3D model', () => {
  it('never walks the walker through the walkway geometry (walls, shops, glass, fittings, flights)', () => {
    expect(total(tally.wall, /^(walls|shopfronts|glass|fittings|stairs|escalator-treads)$/)).toBeLessThanOrEqual(3);
    expect(total(tally.slab, /^(floor-|ceilings|stairs|escalator-treads)/)).toBeLessThanOrEqual(3);
  });

  it('never walks the walker through a station or a building (structure, glass, trains, facades, roofs)', () => {
    expect(total(tally.wall, /^(station-|train-|city-)/)).toBeLessThanOrEqual(2);
    expect(total(tally.slab, /^(station-|city-)/)).toBeLessThanOrEqual(2);
  });

  it('always has a floor under the walker', () => {
    expect(tally.floating / tally.samples).toBeLessThan(0.001);
  });

  it('closes the open sides of underground junctions', () => {
    // A side with no corridor gets a wall round the back (walkway.ts gapWall): nowhere does the
    // walker look out of a junction across more than a quarter turn of empty underground space.
    const open = [...tally.hubs].filter(([, deg]) => deg >= 90).map(([id, deg]) => `${id} ${deg}°`);
    expect(open).toEqual([]);
  });

  it('keeps walls beside the underground corridors', () => {
    const sides = [...tally.sides.values()];
    // Junction hubs close any side without a corridor (walkway.ts); what is left open is mostly
    // the big in-station halls around the metro and 阪神 gates.
    expect(sides.filter((x) => Math.max(...x.open) > 0.4).length).toBeLessThanOrEqual(30);
    // Corridors reviewers found open onto the void: the B1 of 大阪駅前第2ビル on the 阪神→北新地
    // route, the 西梅田連絡口 junction, the うめきた corridor south of the gate.
    for (const [a, b] of [
      ['f_ek2_b1s', 'f_ek2_b1'],
      ['f_ksw_b1', 'y_s_out'],
      ['uk_b1_e', 'uk_b1_se'],
    ]) {
      const x = sides.find((y) => (y.a === a && y.b === b) || (y.a === b && y.b === a));
      expect(x, `${a}–${b}`).toBeDefined();
      expect(Math.max(...x!.open), `${a}–${b}`).toBeLessThanOrEqual(0.2);
    }
  });

  it('keeps the crowd on floors and out of the walkway geometry', () => {
    expect(total(tally.crowdWall, /^(walls|shopfronts|glass|fittings|stairs|escalator-treads)$/)).toBeLessThanOrEqual(10);
    expect(total(tally.crowdWall, /^(station-|train-|city-)/)).toBeLessThanOrEqual(20);
    expect(tally.crowdFloating).toBeLessThanOrEqual(5);
  });
});
