import { arcIndex, buildCostModel, type CostModel, type CostOptions } from './cost';
import { transferBans, type Graph } from './graph';
import { buildInstructions, type Instruction } from './instructions';
import { diverseRoutes } from './ksp';
import type { Path } from './search';
import type { NetNode, Platform } from './types';

export interface Endpoint {
  stationId: string;
  /** A specific platform; omitted = any platform of the station. */
  platformId?: string;
}

export type Boarding = 'best' | 'middle';

export interface RouteQuery {
  from: Endpoint;
  to: Endpoint;
  options: CostOptions;
  /** 'best' lets the planner pick the most convenient car position on the origin platform. */
  boarding: Boarding;
  alternatives: number;
}

export interface Keyframe {
  x: number;
  y: number;
  z: number;
  t: number;
}

export interface RouteSummary {
  path: Path;
  timeS: number;
  distM: number;
  cost: number;
  climbUpM: number;
  climbDownM: number;
  counts: { stairs: number; escalator: number; elevator: number; gate: number; crossing: number };
  outdoorM: number;
  /** Distinct levels in visiting order. */
  levels: string[];
  boardingNode: NetNode;
  alightNode: NetNode;
  maxDensity: number;
  instructions: Instruction[];
  keyframes: Keyframe[];
  /** Short tag like "地下経由" / "2階デッキ経由". */
  tag: string;
}

export interface RoutePlan {
  query: RouteQuery;
  model: CostModel;
  routes: RouteSummary[];
}

export function platformsOf(g: Graph, ep: Endpoint): Platform[] {
  const ps = g.net.platforms.filter((p) => p.stationId === ep.stationId && (!ep.platformId || p.id === ep.platformId));
  if (ps.length === 0) throw new Error(`no platform for ${ep.stationId}/${ep.platformId ?? '*'}`);
  return ps;
}

/** Boarding-position nodes of a platform. */
export function platformNodes(g: Graph, platformId: string): number[] {
  const out: number[] = [];
  g.nodes.forEach((n, i) => {
    if (n.kind === 'platform' && n.platformId === platformId) out.push(i);
  });
  return out;
}

/** The boarding node closest to the middle of the platform. */
export function middleNode(g: Graph, p: Platform): number {
  const mx = (p.a[0] + p.b[0]) / 2;
  const mz = (p.a[1] + p.b[1]) / 2;
  let best = -1;
  let bd = Infinity;
  for (const i of platformNodes(g, p.id)) {
    const n = g.nodes[i];
    const d = Math.hypot(n.x - mx, n.z - mz);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

export function endpointSources(g: Graph, ep: Endpoint, boarding: Boarding): number[] {
  const ps = platformsOf(g, ep);
  if (boarding === 'middle') return ps.map((p) => middleNode(g, p)).filter((i) => i >= 0);
  return ps.flatMap((p) => platformNodes(g, p.id));
}

export function endpointTargets(g: Graph, ep: Endpoint): number[] {
  return platformsOf(g, ep).flatMap((p) => platformNodes(g, p.id));
}

export function summarize(g: Graph, model: CostModel, path: Path): RouteSummary {
  let timeS = 0;
  let distM = 0;
  let climbUpM = 0;
  let climbDownM = 0;
  let outdoorM = 0;
  let maxDensity = 0;
  const counts = { stairs: 0, escalator: 0, elevator: 0, gate: 0, crossing: 0 };
  const levels: string[] = [];
  const keyframes: Keyframe[] = [];
  const pushLevel = (l: string) => {
    if (levels[levels.length - 1] !== l) levels.push(l);
  };
  const n0 = g.nodes[path.nodes[0]];
  pushLevel(n0.level);
  keyframes.push({ x: n0.x, y: n0.y, z: n0.z, t: 0 });

  let prevKind = '';
  for (const st of path.steps) {
    const e = g.edges[st.edge];
    const k = arcIndex(st.edge, st.dir);
    const a = g.nodes[st.from];
    const b = g.nodes[st.to];
    const t = model.time[k];
    const t0 = timeS;
    timeS += t;
    distM += model.dist[k];
    const dy = b.y - a.y;
    if (dy > 0) climbUpM += dy;
    else climbDownM -= dy;
    if (!e.indoor) outdoorM += model.dist[k];
    maxDensity = Math.max(maxDensity, model.density[st.edge]);
    if (e.kind in counts && (e.kind !== prevKind || e.kind === 'gate' || e.kind === 'crossing')) {
      counts[e.kind as keyof typeof counts]++;
    }
    prevKind = e.kind;
    pushLevel(b.level);

    // Keyframes: waits happen at the start node, then movement.
    let wait = 0;
    if (e.kind === 'elevator') wait = Math.max(0, t - Math.abs(dy) - g.hlen[st.edge] / 1.2);
    else if (e.kind === 'crossing') wait = Math.max(0, e.waitS ?? 35);
    else if (e.kind === 'escalator') wait = 4;
    wait = Math.min(wait, t * 0.9);
    if (wait > 0) keyframes.push({ x: a.x, y: a.y, z: a.z, t: t0 + wait });
    keyframes.push({ x: b.x, y: b.y, z: b.z, t: timeS });
  }

  const boardingNode = g.nodes[path.nodes[0]];
  const alightNode = g.nodes[path.nodes[path.nodes.length - 1]];
  const summary: RouteSummary = {
    path,
    timeS,
    distM,
    cost: path.cost,
    climbUpM,
    climbDownM,
    counts,
    outdoorM,
    levels,
    boardingNode,
    alightNode,
    maxDensity,
    instructions: buildInstructions(g, model, path),
    keyframes,
    tag: '',
  };
  summary.tag = routeTagCandidates(g, summary)[0];
  return summary;
}

/**
 * Candidate tags for a route, best first: the named public corridors it spends most of its
 * walking on (e.g. "ホワイティうめだ経由"), then a level-based fallback ("地下経由").
 */
export function routeTagCandidates(g: Graph, r: RouteSummary): string[] {
  const byName = new Map<string, number>();
  const byLevel = new Map<string, number>();
  for (const st of r.path.steps) {
    const e = g.edges[st.edge];
    if (e.kind !== 'walk' && e.kind !== 'crossing') continue;
    const a = g.nodes[st.from];
    const b = g.nodes[st.to];
    const len = g.hlen[st.edge];
    if (e.name && !(a.paid && b.paid)) byName.set(e.name, (byName.get(e.name) ?? 0) + len + (e.kind === 'crossing' ? 40 : 0));
    byLevel.set(b.level, (byLevel.get(b.level) ?? 0) + len);
  }
  const names = [...byName.entries()].filter(([, len]) => len >= 25).sort((x, y) => y[1] - x[1]).map(([n]) => `${n}経由`);
  let top = '';
  let topLen = 0;
  for (const [l, len] of byLevel) {
    if (len > topLen) {
      top = l;
      topLen = len;
    }
  }
  const y = g.net.levels.find((l) => l.id === top)?.y ?? 0;
  const level = !top ? '構内のみ' : y < 0 ? '地下経由' : y === 0 ? (r.outdoorM > 30 ? '地上経由' : '1階経由') : `${g.net.levels.find((l) => l.id === top)?.nameJa ?? top}経由`;
  return [...names, level];
}

/** Assigns each route its first tag candidate not already used by a better route. */
export function assignTags(g: Graph, routes: RouteSummary[]): void {
  const used = new Set<string>();
  for (const r of routes) {
    const cands = routeTagCandidates(g, r);
    r.tag = cands.find((c) => !used.has(c)) ?? cands[0];
    used.add(r.tag);
  }
}

export function planRoute(g: Graph, query: RouteQuery, model?: CostModel): RoutePlan {
  const m = model ?? buildCostModel(g, query.options);
  const sources = endpointSources(g, query.from, query.boarding);
  const targets = endpointTargets(g, query.to);
  const bans = transferBans(g, query.from.stationId, query.to.stationId);
  const paths = diverseRoutes(g, m, sources, targets, Math.max(1, query.alternatives), bans);
  const routes = paths.map((p) => summarize(g, m, p));
  assignTags(g, routes);
  return { query, model: m, routes };
}
