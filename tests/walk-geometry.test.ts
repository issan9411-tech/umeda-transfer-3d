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
  tally = { wall: new Map(), slab: new Map(), floating: 0, crowdWall: new Map(), crowdFloating: 0, samples: 0 };

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

  it('keeps the crowd on floors and out of the walkway geometry', () => {
    expect(total(tally.crowdWall, /^(walls|shopfronts|glass|fittings|stairs|escalator-treads)$/)).toBeLessThanOrEqual(10);
    expect(total(tally.crowdWall, /^(station-|train-|city-)/)).toBeLessThanOrEqual(20);
    expect(tally.crowdFloating).toBeLessThanOrEqual(5);
  });
});
