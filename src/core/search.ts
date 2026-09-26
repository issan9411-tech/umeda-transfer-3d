import { arcIndex, type CostModel } from './cost';
import type { Graph } from './graph';
import { MinHeap } from './heap';

export interface PathStep {
  edge: number;
  dir: 1 | -1;
  from: number;
  to: number;
}

export interface Path {
  /** Node indices from source to target (inclusive). */
  nodes: number[];
  steps: PathStep[];
  /** Objective cost (includes any initial cost of the chosen source). */
  cost: number;
}

export interface SearchOptions {
  /** Arc indices (see arcIndex) that may not be used. */
  bannedArcs?: Set<number>;
  /** Node indices that may not be entered. */
  bannedNodes?: Set<number>;
  /** Extra cost per arc (used to generate diverse alternatives). */
  arcPenalty?: Float64Array;
}

export interface Tree {
  dist: Float64Array;
  prevArc: Int32Array;
  prevNode: Int32Array;
}

/**
 * Multi-source Dijkstra. Every source starts with its given initial cost.
 * When `targets` is provided the search stops at the first settled target.
 */
function run(
  g: Graph,
  model: CostModel,
  sources: Map<number, number>,
  targets: Set<number> | null,
  opts: SearchOptions,
): { tree: Tree; reached: number } {
  const n = g.nodes.length;
  const dist = new Float64Array(n).fill(Infinity);
  const prevArc = new Int32Array(n).fill(-1);
  const prevNode = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  const heap = new MinHeap<number>();
  const { bannedArcs, bannedNodes, arcPenalty } = opts;

  for (const [s, c0] of sources) {
    if (bannedNodes?.has(s)) continue;
    if (c0 < dist[s]) {
      dist[s] = c0;
      heap.push(c0, s);
    }
  }

  let reached = -1;
  while (heap.size) {
    const top = heap.pop() as { priority: number; value: number };
    const u = top.value;
    if (done[u]) continue;
    done[u] = 1;
    if (targets && targets.has(u)) {
      reached = u;
      break;
    }
    const du = dist[u];
    for (const arc of g.adj[u]) {
      const v = arc.to;
      if (done[v]) continue;
      if (bannedNodes?.has(v)) continue;
      const k = arcIndex(arc.edge, arc.dir);
      if (bannedArcs?.has(k)) continue;
      let w = model.cost[k];
      if (!Number.isFinite(w)) continue;
      if (arcPenalty) w += arcPenalty[k];
      const nd = du + w;
      if (nd < dist[v]) {
        dist[v] = nd;
        prevArc[v] = k;
        prevNode[v] = u;
        heap.push(nd, v);
      }
    }
  }
  return { tree: { dist, prevArc, prevNode }, reached };
}

export function toMap(sources: number[] | Map<number, number>): Map<number, number> {
  if (sources instanceof Map) return sources;
  return new Map(sources.map((s) => [s, 0]));
}

export function reconstruct(tree: Tree, target: number): Path {
  const nodes: number[] = [target];
  const steps: PathStep[] = [];
  let v = target;
  while (tree.prevNode[v] >= 0) {
    const u = tree.prevNode[v];
    const k = tree.prevArc[v];
    steps.push({ edge: k >> 1, dir: (k & 1) === 0 ? 1 : -1, from: u, to: v });
    nodes.push(u);
    v = u;
  }
  nodes.reverse();
  steps.reverse();
  return { nodes, steps, cost: tree.dist[target] };
}

export function shortestPath(
  g: Graph,
  model: CostModel,
  sources: number[] | Map<number, number>,
  targets: number[] | Set<number>,
  opts: SearchOptions = {},
): Path | null {
  const tset = targets instanceof Set ? targets : new Set(targets);
  const { tree, reached } = run(g, model, toMap(sources), tset, opts);
  if (reached < 0) return null;
  return reconstruct(tree, reached);
}

/** Full shortest-path tree from a set of sources. */
export function shortestTree(
  g: Graph,
  model: CostModel,
  sources: number[] | Map<number, number>,
  opts: SearchOptions = {},
): Tree {
  return run(g, model, toMap(sources), null, opts).tree;
}

/** Sum of a per-arc quantity (time, dist, cost) along a path. */
export function sumArcs(values: Float64Array, path: Path): number {
  let s = 0;
  for (const st of path.steps) s += values[arcIndex(st.edge, st.dir)];
  return s;
}
