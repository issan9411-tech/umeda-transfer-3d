import { arcIndex, type CostModel } from './cost';
import type { Graph } from './graph';
import { MinHeap } from './heap';
import { shortestPath, sumArcs, toMap, type Path, type PathStep } from './search';

/** Identity of a path by its source and arcs (parallel edges such as stairs vs escalator count as different). */
const pathKey = (p: Path): string => `${p.nodes[0]}:${p.steps.map((s) => arcIndex(s.edge, s.dir)).join(',')}`;

function trueCost(model: CostModel, sources: Map<number, number>, p: Path): number {
  return (sources.get(p.nodes[0]) ?? 0) + sumArcs(model.cost, p);
}

/**
 * Yen's K shortest loopless paths for a multi-source / multi-target query.
 * The source set behaves like a virtual super-source whose out-arcs carry the initial costs.
 */
export function yenKShortest(
  g: Graph,
  model: CostModel,
  sourcesIn: number[] | Map<number, number>,
  targetsIn: number[] | Set<number>,
  K: number,
  globalBans: Set<number> = new Set(),
): Path[] {
  const sources = toMap(sourcesIn);
  const targets = targetsIn instanceof Set ? targetsIn : new Set(targetsIn);
  const first = shortestPath(g, model, sources, targets, { bannedNodes: globalBans });
  if (!first) return [];
  const A: Path[] = [first];
  const seen = new Set([pathKey(first)]);
  const B = new MinHeap<Path>();

  while (A.length < K) {
    const prev = A[A.length - 1];
    for (let i = -1; i < prev.nodes.length - 1; i++) {
      const rootNodes = i < 0 ? [] : prev.nodes.slice(0, i + 1);
      const rootSteps: PathStep[] = i < 0 ? [] : prev.steps.slice(0, i);
      const bannedArcs = new Set<number>();
      const bannedStarts = new Set<number>();
      for (const p of A) {
        if (p.nodes.length <= i + 1) continue;
        let same = true;
        for (let j = 0; j <= i; j++) {
          if (p.nodes[j] !== rootNodes[j] || (j < i && p.steps[j].edge !== rootSteps[j].edge)) {
            same = false;
            break;
          }
        }
        if (!same) continue;
        if (i < 0) bannedStarts.add(p.nodes[0]);
        else bannedArcs.add(arcIndex(p.steps[i].edge, p.steps[i].dir));
      }
      const bannedNodes = new Set([...globalBans, ...rootNodes.slice(0, -1)]);
      let spurSources: Map<number, number>;
      if (i < 0) {
        spurSources = new Map([...sources].filter(([s]) => !bannedStarts.has(s)));
        if (spurSources.size === 0) continue;
      } else {
        spurSources = new Map([[rootNodes[i], 0]]);
      }
      const spur = shortestPath(g, model, spurSources, targets, { bannedArcs, bannedNodes });
      if (!spur) continue;
      const total: Path = {
        nodes: i < 0 ? spur.nodes : [...rootNodes.slice(0, -1), ...spur.nodes],
        steps: [...rootSteps, ...spur.steps],
        cost: 0,
      };
      total.cost = trueCost(model, sources, total);
      const key = pathKey(total);
      if (seen.has(key)) continue;
      seen.add(key);
      B.push(total.cost, total);
    }
    const next = B.pop();
    if (!next) break;
    A.push(next.value);
  }
  return A;
}

/** Share of `a`'s length (m) that also lies on `b`. */
export function overlapRatio(g: Graph, a: Path, b: Path): number {
  const inB = new Set(b.steps.map((s) => s.edge));
  let shared = 0;
  let total = 0;
  for (const s of a.steps) {
    const len = g.hlen[s.edge] + Math.abs(g.rise[s.edge]);
    total += len;
    if (inB.has(s.edge)) shared += len;
  }
  return total > 0 ? shared / total : 1;
}

export interface DiverseOptions {
  /** Maximum overlap with any already accepted route (0–1). */
  maxOverlap?: number;
  /** Penalty added to used arcs, as a fraction of their cost. */
  penalty?: number;
  /** Reject routes more than this factor slower than the best. */
  maxDetour?: number;
  maxIterations?: number;
  /** Nodes that may not be used at all (e.g. other operators' paid areas). */
  bannedNodes?: Set<number>;
}

/**
 * Meaningfully different alternatives via iterative penalisation: after each route is found,
 * its arcs get more expensive, which pushes the next search onto other corridors.
 * Routes are returned sorted by their true (unpenalised) cost.
 */
export function diverseRoutes(
  g: Graph,
  model: CostModel,
  sourcesIn: number[] | Map<number, number>,
  targetsIn: number[] | Set<number>,
  K: number,
  opts: DiverseOptions = {},
): Path[] {
  const { maxOverlap = 0.65, penalty = 0.7, maxDetour = 2.0, maxIterations = 14, bannedNodes } = opts;
  const sources = toMap(sourcesIn);
  const targets = targetsIn instanceof Set ? targetsIn : new Set(targetsIn);
  const arcPenalty = new Float64Array(model.cost.length);
  const out: Path[] = [];
  const keys = new Set<string>();
  let best = Infinity;

  for (let it = 0; it < maxIterations && out.length < K; it++) {
    const p = shortestPath(g, model, sources, targets, { arcPenalty, bannedNodes });
    if (!p) break;
    p.cost = trueCost(model, sources, p);
    if (it === 0) best = p.cost;
    const key = pathKey(p);
    if (!keys.has(key) && p.cost <= best * maxDetour + 30) {
      keys.add(key);
      if (out.every((q) => overlapRatio(g, p, q) <= maxOverlap && overlapRatio(g, q, p) <= maxOverlap)) out.push(p);
    }
    for (const s of p.steps) {
      for (const dir of [1, -1] as const) {
        const k = arcIndex(s.edge, dir);
        const c = model.cost[k];
        if (Number.isFinite(c)) arcPenalty[k] += c * penalty + 5;
      }
    }
  }
  return out.sort((a, b) => a.cost - b.cost);
}
