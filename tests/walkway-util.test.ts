import { describe, expect, it } from 'vitest';
import { buildGraph } from '../src/core/graph';
import { umeda } from '../src/data/umeda';
import {
  arrowFor,
  cabinCycle,
  clipHalfPlane,
  destinationsVia,
  dominantAngle,
  hash01,
  isMallEdge,
  laneOffsets,
  mouthTrims,
  polyArea,
  subtractConvex,
  type P2,
} from '../src/render/walkway-util';

const g = buildGraph(umeda.network);
const node = (id: string) => g.nodes[g.nodeIndex.get(id)!];

describe('walkway layout helpers', () => {
  it('finds the dominant grid direction modulo 90°', () => {
    expect(dominantAngle([{ dx: 10, dz: 0 }, { dx: 0, dz: 5 }])).toBeCloseTo(0);
    const a = 0.3;
    const segs = [{ dx: Math.cos(a), dz: Math.sin(a) }, { dx: -Math.sin(a) * 2, dz: Math.cos(a) * 2 }];
    expect(dominantAngle(segs)).toBeCloseTo(a);
    expect(dominantAngle([])).toBe(0);
  });

  it('trims corridor mouths only where arms would overlap', () => {
    // Straight continuation: no trim.
    expect(mouthTrims([{ angle: 0, width: 6 }, { angle: Math.PI, width: 6 }], 20)).toEqual([0, 0]);
    // Right-angle bend: each arm stops at the other's half width.
    const t = mouthTrims([{ angle: 0, width: 6 }, { angle: Math.PI / 2, width: 10 }], 20);
    expect(t[0]).toBeCloseTo(5);
    expect(t[1]).toBeCloseTo(3);
    // Narrow angles are capped.
    expect(Math.max(...mouthTrims([{ angle: 0, width: 20 }, { angle: 0.05, width: 20 }], 12))).toBe(12);
  });

  it('puts the walked lane on the centreline and packs the others beside it', () => {
    const offs = laneOffsets([3.2, 1.7, 2.6], 1, 0.8);
    expect(offs[1]).toBe(0);
    expect(offs[0]).toBeCloseTo(1.7 / 2 + 0.8 + 1.6);
    expect(offs[2]).toBeCloseTo(-(1.7 / 2 + 0.8 + 1.3));
    // Lanes never overlap.
    const w = [3.2, 1.7, 2.6];
    const spans = offs.map((o, i) => [o - w[i] / 2, o + w[i] / 2]).sort((p, q) => p[0] - q[0]);
    for (let i = 1; i < spans.length; i++) expect(spans[i][0]).toBeGreaterThanOrEqual(spans[i - 1][1]);
  });

  it('moves elevator cabins smoothly between the landings with dwell times', () => {
    expect(cabinCycle(0, 6, 4)).toBe(0);
    expect(cabinCycle(4 + 3, 6, 4)).toBeCloseTo(0.5);
    expect(cabinCycle(4 + 6 + 2, 6, 4)).toBe(1);
    expect(cabinCycle(-1, 6, 4)).toBeGreaterThanOrEqual(0);
    let prev = cabinCycle(0, 6, 4);
    for (let t = 0.05; t < 40; t += 0.05) {
      const f = cabinCycle(t, 6, 4);
      expect(Number.isFinite(f)).toBe(true);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(1);
      expect(Math.abs(f - prev)).toBeLessThan(0.05); // no jumps
      prev = f;
    }
  });

  it('hashes deterministically into [0, 1)', () => {
    expect(hash01('a', 1)).toBe(hash01('a', 1));
    expect(hash01('a', 1)).not.toBe(hash01('a', 2));
    for (let i = 0; i < 200; i++) {
      const h = hash01('edge', i);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(1);
    }
  });

  it('recognises the underground malls', () => {
    const malls = g.edges.filter((e) => isMallEdge(e, node(e.a), node(e.b))).map((e) => e.name ?? '');
    expect(malls.some((n) => n.includes('ホワイティ'))).toBe(true);
    expect(malls.some((n) => n.includes('ディアモール'))).toBe(true);
    // Paid concourses are never malls.
    for (const e of g.edges) if (node(e.a).paid && node(e.b).paid) expect(isMallEdge(e, node(e.a), node(e.b))).toBe(false);
  });

  it('names what lies down a corridor for the hanging signs', () => {
    // From ホワイティうめだ センターモール, heading to the 東梅田 north gate.
    const j = g.nodeIndex.get('f_wh_c')!;
    const via = g.nodeIndex.get('t_n_out')!;
    const t = destinationsVia(g, j, via, 50);
    expect(t.length).toBeGreaterThan(0);
    expect(t.some((x) => x.text.includes('谷町線'))).toBe(true);
    expect(t[0].dist).toBeGreaterThan(0);
  });

  it('turns headings into sign arrows (z points south)', () => {
    expect(arrowFor(0, 0.1)).toBe(0);
    expect(arrowFor(0, Math.PI / 2)).toBe(1); // heading east, south is on the right
    expect(arrowFor(0, -Math.PI / 2)).toBe(-1);
    expect(arrowFor(0, Math.PI)).toBe(2);
  });

  it('cuts convex holes out of convex floor pieces', () => {
    const sq: P2[] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const hole: P2[] = [[3, 3], [7, 3], [7, 7], [3, 7]];
    const pieces = subtractConvex(sq, hole);
    const area = pieces.reduce((s, p) => s + polyArea(p), 0);
    expect(area).toBeCloseTo(100 - 16);
    // A hole elsewhere leaves the polygon whole; one covering it removes it.
    expect(subtractConvex(sq, [[20, 20], [30, 20], [30, 30], [20, 30]]).reduce((s, p) => s + polyArea(p), 0)).toBeCloseTo(100);
    expect(subtractConvex(sq, [[-1, -1], [11, -1], [11, 11], [-1, 11]])).toEqual([]);
    expect(polyArea(clipHalfPlane(sq, 1, 0, 4))).toBeCloseTo(40);
  });
});
