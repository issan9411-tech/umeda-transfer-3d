import { describe, expect, it } from 'vitest';
import { demandAt, speedFactor } from '../src/core/congestion';
import { arcIndex, buildCostModel, DEFAULT_OPTIONS, type CostOptions } from '../src/core/cost';
import { buildGraph, nodeIdx, type Graph } from '../src/core/graph';
import { MinHeap } from '../src/core/heap';
import { compass } from '../src/core/instructions';
import { diverseRoutes, overlapRatio, yenKShortest } from '../src/core/ksp';
import { transferMatrix } from '../src/core/matrix';
import { planRoute } from '../src/core/planner';
import { shortestPath, sumArcs, type Path } from '../src/core/search';
import { fixtureNetwork } from './fixture';

const opts = (o: Partial<CostOptions> = {}): CostOptions => ({ ...DEFAULT_OPTIONS, congestion: false, ...o });
const edgeIds = (g: Graph, p: Path) => p.steps.map((s) => g.edges[s.edge].id);

/** Brute-force enumeration of all simple paths (for checking Yen). */
function allSimplePaths(g: Graph, sources: number[], targets: Set<number>, model: ReturnType<typeof buildCostModel>): number[] {
  const costs: number[] = [];
  const visit = (u: number, seen: Set<number>, c: number) => {
    if (targets.has(u)) {
      costs.push(c);
      return;
    }
    for (const arc of g.adj[u]) {
      if (seen.has(arc.to)) continue;
      const w = model.cost[arcIndex(arc.edge, arc.dir)];
      if (!Number.isFinite(w)) continue;
      seen.add(arc.to);
      visit(arc.to, seen, c + w);
      seen.delete(arc.to);
    }
  };
  for (const s of sources) visit(s, new Set([s]), 0);
  return costs.sort((a, b) => a - b);
}

describe('MinHeap', () => {
  it('pops in ascending priority order', () => {
    const h = new MinHeap<number>();
    const xs = [5, 3, 9, 1, 7, 3, 0, 12, 4];
    xs.forEach((x) => h.push(x, x));
    const out: number[] = [];
    while (h.size) out.push((h.pop() as { priority: number }).priority);
    expect(out).toEqual([...xs].sort((a, b) => a - b));
  });
});

describe('congestion model', () => {
  it('has commuter peaks on weekdays', () => {
    expect(demandAt(8.5)).toBeGreaterThan(0.8);
    expect(demandAt(18)).toBeGreaterThan(0.8);
    expect(demandAt(3)).toBeLessThan(0.05);
  });
  it('slows walking monotonically with density', () => {
    expect(speedFactor(0)).toBe(1);
    const xs = [0.3, 0.8, 1.5, 2.5, 4].map(speedFactor);
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeLessThan(xs[i - 1]);
    expect(speedFactor(10)).toBeCloseTo(0.15);
  });
});

describe('graph + shortest path', () => {
  const g = buildGraph(fixtureNetwork());

  it('respects one-way escalators', () => {
    const esc = g.edgeIndex.get('b_esc') as number;
    const top = nodeIdx(g, 'b_top');
    const bottom = nodeIdx(g, 'b_gate_out');
    expect(g.adj[top].some((a) => a.edge === esc)).toBe(true);
    expect(g.adj[bottom].some((a) => a.edge === esc)).toBe(false);
  });

  it('finds the fastest route (outdoor crossing beats the long indoor detour)', () => {
    const m = buildCostModel(g, opts());
    const p = shortestPath(g, m, [nodeIdx(g, 'pa2')], [nodeIdx(g, 'pb1'), nodeIdx(g, 'pb2')]);
    expect(p).not.toBeNull();
    const ids = edgeIds(g, p as Path);
    expect(ids).toContain('cross');
    expect(ids).toContain('st_a');
    // Going down one level, stairs (≈23 s) beat standing on the escalator (≈29 s).
    expect(ids).toContain('b_st');
    expect((p as Path).cost).toBeCloseTo(sumArcs(m.cost, p as Path));
  });

  it('rain mode prefers weather-protected corridors', () => {
    const m = buildCostModel(g, opts({ rain: true }));
    const p = shortestPath(g, m, [nodeIdx(g, 'pa2')], [nodeIdx(g, 'pb1')]) as Path;
    const ids = edgeIds(g, p);
    expect(ids).not.toContain('cross');
    expect(ids).toEqual(expect.arrayContaining(['in1', 'in2', 'in3']));
  });

  it('step-free profile uses only elevators', () => {
    const m = buildCostModel(g, opts({ profile: 'stepfree' }));
    const p = shortestPath(g, m, [nodeIdx(g, 'pa1'), nodeIdx(g, 'pa2'), nodeIdx(g, 'pa3')], [nodeIdx(g, 'pb1')]) as Path;
    const kinds = p.steps.map((s) => g.edges[s.edge].kind);
    expect(kinds).not.toContain('stairs');
    expect(kinds).not.toContain('escalator');
    expect(kinds.filter((k) => k === 'elevator')).toHaveLength(2);
    expect(g.nodes[p.nodes[0]].id).toBe('pa3');
  });

  it('distance objective minimises metres', () => {
    const m = buildCostModel(g, opts({ objective: 'distance' }));
    const p = shortestPath(g, m, [nodeIdx(g, 'pa2')], [nodeIdx(g, 'pb1')]) as Path;
    const brute = allSimplePaths(g, [nodeIdx(g, 'pa2')], new Set([nodeIdx(g, 'pb1')]), m);
    expect(p.cost).toBeCloseTo(brute[0]);
  });

  it('congestion at the morning peak makes the same route slower', () => {
    const calm = buildCostModel(g, opts({ congestion: true, hour: 3 }));
    const peak = buildCostModel(g, opts({ congestion: true, hour: 8.5 }));
    const p = shortestPath(g, calm, [nodeIdx(g, 'pa2')], [nodeIdx(g, 'pb1')]) as Path;
    expect(sumArcs(peak.time, p)).toBeGreaterThan(sumArcs(calm.time, p));
  });
});

describe('k shortest paths', () => {
  const g = buildGraph(fixtureNetwork());
  const m = buildCostModel(g, opts());
  const sources = ['pa1', 'pa2', 'pa3'].map((id) => nodeIdx(g, id));
  const targets = new Set(['pb1', 'pb2'].map((id) => nodeIdx(g, id)));

  it('Yen matches brute-force enumeration', () => {
    const K = 6;
    const ys = yenKShortest(g, m, sources, targets, K);
    const brute = allSimplePaths(g, sources, targets, m).slice(0, K);
    expect(ys.map((p) => p.cost)).toHaveLength(brute.length);
    ys.forEach((p, i) => expect(p.cost).toBeCloseTo(brute[i], 6));
    for (const p of ys) expect(new Set(p.nodes).size).toBe(p.nodes.length);
  });

  it('diverse routes respect the overlap bound and are sorted', () => {
    const rs = diverseRoutes(g, m, sources, targets, 3, { maxOverlap: 0.8 });
    expect(rs.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < rs.length; i++) expect(rs[i].cost).toBeGreaterThanOrEqual(rs[i - 1].cost);
    for (let i = 0; i < rs.length; i++)
      for (let j = i + 1; j < rs.length; j++) expect(overlapRatio(g, rs[j], rs[i])).toBeLessThanOrEqual(0.8);
  });
});

describe('planner', () => {
  const g = buildGraph(fixtureNetwork());

  it('summarises a route with counts, levels, keyframes and instructions', () => {
    const plan = planRoute(g, { from: { stationId: 'A' }, to: { stationId: 'B' }, options: opts(), boarding: 'best', alternatives: 2 });
    const r = plan.routes[0];
    expect(r.counts.gate).toBe(2);
    expect(r.counts.crossing).toBe(1);
    expect(r.levels).toEqual(['2F', '1F', 'B1']);
    expect(r.climbDownM).toBeCloseTo(12);
    expect(r.keyframes[r.keyframes.length - 1].t).toBeCloseTo(r.timeS);
    for (let i = 1; i < r.keyframes.length; i++) expect(r.keyframes[i].t).toBeGreaterThanOrEqual(r.keyframes[i - 1].t);
    const kinds = r.instructions.map((x) => x.kind);
    expect(kinds[0]).toBe('start');
    expect(kinds).toContain('gate-out');
    expect(kinds).toContain('gate-in');
    expect(kinds[kinds.length - 1]).toBe('arrive');
    const sumT = r.instructions.reduce((s, x) => s + x.timeS, 0);
    expect(sumT).toBeCloseTo(r.timeS);
  });

  it('middle boarding is never faster than best boarding', () => {
    const best = planRoute(g, { from: { stationId: 'A' }, to: { stationId: 'B' }, options: opts(), boarding: 'best', alternatives: 1 });
    const mid = planRoute(g, { from: { stationId: 'A' }, to: { stationId: 'B' }, options: opts(), boarding: 'middle', alternatives: 1 });
    expect(mid.routes[0].timeS).toBeGreaterThanOrEqual(best.routes[0].timeS - 1e-9);
  });

  it('transfer matrix is consistent with direct planning', () => {
    const tm = transferMatrix(g, opts());
    const cell = tm.cells[0][1];
    const best = planRoute(g, { from: { stationId: 'A' }, to: { stationId: 'B' }, options: opts(), boarding: 'best', alternatives: 1 });
    expect(cell.bestS).toBeCloseTo(best.routes[0].timeS);
    expect(cell.typicalS).toBeGreaterThanOrEqual(cell.bestS - 1e-9);
    expect(Number.isNaN(tm.cells[0][0].bestS)).toBe(true);
  });
});

describe('compass', () => {
  it('maps local axes to Japanese directions (z points south)', () => {
    expect(compass({ x: 0, z: 0 }, { x: 0, z: -10 })).toBe('北');
    expect(compass({ x: 0, z: 0 }, { x: 10, z: 0 })).toBe('東');
    expect(compass({ x: 0, z: 0 }, { x: 0, z: 10 })).toBe('南');
    expect(compass({ x: 0, z: 0 }, { x: -10, z: 10 })).toBe('南西');
  });
});
