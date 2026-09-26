import type { NetEdge, NetNode, Network } from './types';

/** Index of one direction of an edge in per-arc tables: edge * 2 (+1 for b→a). */
export const arcIndex = (edge: number, dir: 1 | -1): number => edge * 2 + (dir === 1 ? 0 : 1);

/** One traversable direction of an edge. dir = 1 means a→b, -1 means b→a. */
export interface Arc {
  edge: number;
  to: number;
  dir: 1 | -1;
}

export interface Graph {
  net: Network;
  nodes: NetNode[];
  edges: NetEdge[];
  nodeIndex: Map<string, number>;
  edgeIndex: Map<string, number>;
  /** Outgoing arcs per node index. */
  adj: Arc[][];
  /** Horizontal length (m) per edge index. */
  hlen: Float64Array;
  /** Signed rise (m) per edge index, b.y - a.y. */
  rise: Float64Array;
}

export function horizontalDistance(a: NetNode, b: NetNode): number {
  return Math.hypot(b.x - a.x, b.z - a.z);
}

/** Whether an escalator (or any directional edge) can be used from a→b (dir=1) or b→a (dir=-1). */
export function arcAllowed(edge: NetEdge, rise: number, dir: 1 | -1): boolean {
  if (!edge.dir || edge.dir === 'both') return true;
  const goingUp = rise * dir > 0;
  return edge.dir === 'up' ? goingUp : !goingUp;
}

export function buildGraph(net: Network): Graph {
  const nodeIndex = new Map<string, number>();
  net.nodes.forEach((n, i) => {
    if (nodeIndex.has(n.id)) throw new Error(`duplicate node id: ${n.id}`);
    nodeIndex.set(n.id, i);
  });
  const edgeIndex = new Map<string, number>();
  const adj: Arc[][] = net.nodes.map(() => []);
  const hlen = new Float64Array(net.edges.length);
  const rise = new Float64Array(net.edges.length);

  net.edges.forEach((e, i) => {
    if (edgeIndex.has(e.id)) throw new Error(`duplicate edge id: ${e.id}`);
    edgeIndex.set(e.id, i);
    const ai = nodeIndex.get(e.a);
    const bi = nodeIndex.get(e.b);
    if (ai === undefined) throw new Error(`edge ${e.id}: unknown node ${e.a}`);
    if (bi === undefined) throw new Error(`edge ${e.id}: unknown node ${e.b}`);
    if (ai === bi) throw new Error(`edge ${e.id}: self loop`);
    const a = net.nodes[ai];
    const b = net.nodes[bi];
    hlen[i] = e.length ?? horizontalDistance(a, b);
    rise[i] = b.y - a.y;
    if (arcAllowed(e, rise[i], 1)) adj[ai].push({ edge: i, to: bi, dir: 1 });
    if (arcAllowed(e, rise[i], -1)) adj[bi].push({ edge: i, to: ai, dir: -1 });
  });

  return { net, nodes: net.nodes, edges: net.edges, nodeIndex, edgeIndex, adj, hlen, rise };
}

export function nodeIdx(g: Graph, id: string): number {
  const i = g.nodeIndex.get(id);
  if (i === undefined) throw new Error(`unknown node: ${id}`);
  return i;
}

/** Undirected connected components (ignores escalator direction). */
export function components(g: Graph): number[][] {
  const seen = new Int32Array(g.nodes.length).fill(-1);
  const undirected: number[][] = g.nodes.map(() => []);
  g.edges.forEach((e) => {
    const a = g.nodeIndex.get(e.a) as number;
    const b = g.nodeIndex.get(e.b) as number;
    undirected[a].push(b);
    undirected[b].push(a);
  });
  const comps: number[][] = [];
  for (let s = 0; s < g.nodes.length; s++) {
    if (seen[s] >= 0) continue;
    const comp: number[] = [];
    const stack = [s];
    seen[s] = comps.length;
    while (stack.length) {
      const u = stack.pop() as number;
      comp.push(u);
      for (const v of undirected[u]) {
        if (seen[v] < 0) {
          seen[v] = comps.length;
          stack.push(v);
        }
      }
    }
    comps.push(comp);
  }
  return comps;
}

export function fareZoneOf(g: Graph, stationId: string): string {
  return g.net.stations.find((s) => s.id === stationId)?.fareZone ?? stationId;
}

export interface TransferBans {
  bannedNodes: Set<number>;
  bannedArcs: Set<number>;
}

/**
 * Search restrictions that keep a walk fare-valid between two stations (either may be
 * undefined for a street entrance):
 * - nothing inside the fare gates of any third fare zone (no shortcuts through another
 *   operator's concourse, e.g. in one 西梅田 gate and out the other);
 * - the origin's gates may only be passed outwards and the destination's only inwards, so a
 *   route leaves the paid area at most once and never comes back in mid-walk;
 * - within one fare zone (JR大阪 ⇄ うめきた) the walk stays inside the gates.
 */
export function transferBans(g: Graph, fromStation?: string, toStation?: string): TransferBans {
  const zf = fromStation ? fareZoneOf(g, fromStation) : undefined;
  const zt = toStation ? fareZoneOf(g, toStation) : undefined;
  const sameZone = zf !== undefined && zf === zt;
  const bannedNodes = new Set<number>();
  g.nodes.forEach((n, i) => {
    if (n.paid && n.stationId) {
      const z = fareZoneOf(g, n.stationId);
      if (z !== zf && z !== zt) bannedNodes.add(i);
    } else if (sameZone) {
      bannedNodes.add(i);
    }
  });
  const bannedArcs = new Set<number>();
  if (!sameZone) {
    g.edges.forEach((e, i) => {
      if (e.kind !== 'gate') return;
      const a = g.nodes[g.nodeIndex.get(e.a) as number];
      const b = g.nodes[g.nodeIndex.get(e.b) as number];
      const paidNode = a.paid ? a : b;
      if (!paidNode.stationId) return;
      const z = fareZoneOf(g, paidNode.stationId);
      // dir 1 is a→b; it is the exit direction when a is the paid side.
      const exitDir: 1 | -1 = a.paid ? 1 : -1;
      if (z === zf) bannedArcs.add(arcIndex(i, exitDir === 1 ? -1 : 1)); // no re-entry at the origin
      if (z === zt) bannedArcs.add(arcIndex(i, exitDir)); // no leaving the destination
    });
  }
  return { bannedNodes, bannedArcs };
}
