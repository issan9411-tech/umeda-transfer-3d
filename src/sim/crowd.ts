import { demandAt, speedFactor, type DayType } from '../core/congestion';
import { arcIndex, buildCostModel, DEFAULT_OPTIONS, type CostModel } from '../core/cost';
import { paidAreaBans, type Graph } from '../core/graph';
import { shortestTree, reconstruct, type Tree } from '../core/search';

/**
 * Agent-based crowd simulation on the pedestrian graph.
 *
 * Each agent stands for `peoplePerAgent` real pedestrians travelling between a random origin
 * and destination (station platforms and street entrances), weighted by station ridership.
 * Agents follow free-flow shortest paths and slow down according to the density they measure
 * on their current edge (Weidmann), which in turn feeds the congestion heat map and, optionally,
 * the route planner.
 */

export interface Endpoint {
  node: number;
  weight: number;
  stationId?: string;
}

interface Agent {
  alive: boolean;
  /** Sequence of arcs (edge index + direction) to walk. */
  arcs: Int32Array;
  seg: number;
  /** Progress along the current arc in seconds of free-flow time. */
  prog: number;
  speed: number;
  color: number;
}

export interface CrowdOptions {
  maxAgents: number;
  peoplePerAgent: number;
  /** Pedestrians entering the network per second at demand 1.0 (real people). */
  peakInflow: number;
  seed: number;
}

export const DEFAULT_CROWD: CrowdOptions = {
  maxAgents: 1400,
  peoplePerAgent: 20,
  peakInflow: 70,
  seed: 7,
};

/** Small deterministic PRNG so runs are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class CrowdSim {
  readonly g: Graph;
  readonly opts: CrowdOptions;
  private free: CostModel;
  private agents: Agent[] = [];
  private rand: () => number;
  private endpoints: Endpoint[];
  private totalWeight: number;
  /** Shortest-path trees keyed by origin node and destination station. */
  private trees = new Map<string, Tree>();
  private stationColors: Map<string, number>;
  private spawnDebt = 0;
  private edgeCount: Float32Array;
  private edgeArea: Float32Array;
  /** Smoothed density per edge, persons/m². */
  readonly density: Float32Array;
  /** Positions (x, y, z) per live agent, packed; see `count`. */
  readonly positions: Float32Array;
  readonly colors: Uint32Array;
  count = 0;
  hour = 8;
  day: DayType = 'weekday';
  /** Cumulative real pedestrians who completed a trip. */
  completed = 0;

  constructor(g: Graph, endpoints: Endpoint[], colors: Map<string, number>, opts: Partial<CrowdOptions> = {}) {
    this.g = g;
    this.opts = { ...DEFAULT_CROWD, ...opts };
    this.rand = mulberry32(this.opts.seed);
    this.free = buildCostModel(g, { ...DEFAULT_OPTIONS, congestion: false });
    this.endpoints = endpoints.filter((e) => e.weight > 0);
    this.totalWeight = this.endpoints.reduce((s, e) => s + e.weight, 0);
    this.stationColors = colors;
    const E = g.edges.length;
    this.edgeCount = new Float32Array(E);
    this.edgeArea = new Float32Array(E);
    this.density = new Float32Array(E);
    g.edges.forEach((e, i) => {
      const len = Math.max(8, g.hlen[i] + Math.abs(g.rise[i]));
      this.edgeArea[i] = len * (e.width ?? defaultWidth(e.kind));
    });
    this.positions = new Float32Array(this.opts.maxAgents * 3);
    this.colors = new Uint32Array(this.opts.maxAgents);
  }

  reset(): void {
    this.agents = [];
    this.count = 0;
    this.completed = 0;
    this.spawnDebt = 0;
    this.edgeCount.fill(0);
    this.density.fill(0);
    this.rand = mulberry32(this.opts.seed);
  }

  private pick(): Endpoint {
    let r = this.rand() * this.totalWeight;
    for (const e of this.endpoints) {
      r -= e.weight;
      if (r <= 0) return e;
    }
    return this.endpoints[this.endpoints.length - 1];
  }

  private tree(src: Endpoint, dst: Endpoint): Tree {
    const key = `${src.node}|${dst.stationId ?? '-'}`;
    let t = this.trees.get(key);
    if (!t) {
      // Pedestrians may only be inside the fare gates of their own origin / destination station.
      t = shortestTree(this.g, this.free, [src.node], { bannedNodes: paidAreaBans(this.g, [src.stationId, dst.stationId]) });
      this.trees.set(key, t);
    }
    return t;
  }

  private spawn(): void {
    const o = this.pick();
    let d = this.pick();
    for (let tries = 0; tries < 6 && (d.node === o.node || (d.stationId && d.stationId === o.stationId)); tries++) d = this.pick();
    if (d.node === o.node) return;
    const t = this.tree(o, d);
    if (!Number.isFinite(t.dist[d.node])) return;
    const path = reconstruct(t, d.node);
    if (path.steps.length === 0) return;
    const arcs = Int32Array.from(path.steps.map((s) => arcIndex(s.edge, s.dir)));
    const color = this.stationColors.get(d.stationId ?? '') ?? 0x8a96a3;
    const agent: Agent = { alive: true, arcs, seg: 0, prog: 0, speed: 0.8 + this.rand() * 0.4, color };
    this.edgeCount[arcs[0] >> 1] += 1;
    // Spread new agents along their first arc so the network does not pulse.
    agent.prog = this.rand() * this.free.time[arcs[0]] * 0.5;
    this.agents.push(agent);
  }

  /** Advance the simulation by dt seconds of simulated time. */
  step(dt: number): void {
    const demand = demandAt(this.hour, this.day);
    const inflowAgents = (this.opts.peakInflow * demand) / this.opts.peoplePerAgent;
    this.spawnDebt += inflowAgents * dt;
    while (this.spawnDebt >= 1) {
      this.spawnDebt -= 1;
      if (this.agents.length < this.opts.maxAgents) this.spawn();
    }

    // Density from occupancy, exponentially smoothed.
    const alpha = Math.min(1, dt / 20);
    const ppa = this.opts.peoplePerAgent;
    for (let i = 0; i < this.density.length; i++) {
      const rho = (this.edgeCount[i] * ppa) / this.edgeArea[i];
      this.density[i] += (rho - this.density[i]) * alpha;
    }

    const g = this.g;
    let w = 0;
    for (const a of this.agents) {
      if (!a.alive) continue;
      let remaining = dt;
      while (remaining > 0 && a.alive) {
        const k = a.arcs[a.seg];
        const e = k >> 1;
        const tFree = Math.max(0.5, this.free.time[k]);
        const kind = g.edges[e].kind;
        const slow = kind === 'elevator' || kind === 'escalator' || kind === 'crossing' ? 1 : speedFactor(this.density[e]);
        const rate = a.speed * slow;
        const need = (tFree - a.prog) / rate;
        if (need > remaining) {
          a.prog += remaining * rate;
          remaining = 0;
        } else {
          remaining -= need;
          this.edgeCount[e] -= 1;
          a.seg++;
          a.prog = 0;
          if (a.seg >= a.arcs.length) {
            a.alive = false;
            this.completed += ppa;
          } else {
            this.edgeCount[a.arcs[a.seg] >> 1] += 1;
          }
        }
      }
      if (!a.alive) continue;
      // Interpolate position.
      const k = a.arcs[a.seg];
      const e = k >> 1;
      const fwd = (k & 1) === 0;
      const na = g.nodes[g.nodeIndex.get(fwd ? g.edges[e].a : g.edges[e].b) as number];
      const nb = g.nodes[g.nodeIndex.get(fwd ? g.edges[e].b : g.edges[e].a) as number];
      const f = Math.min(1, a.prog / Math.max(0.5, this.free.time[k]));
      this.positions[w * 3] = na.x + (nb.x - na.x) * f;
      this.positions[w * 3 + 1] = na.y + (nb.y - na.y) * f;
      this.positions[w * 3 + 2] = na.z + (nb.z - na.z) * f;
      this.colors[w] = a.color;
      w++;
    }
    this.count = w;
    if (this.agents.length > 2 * w + 64) this.agents = this.agents.filter((a) => a.alive);
  }

  /** Real pedestrians currently walking in the network. */
  get people(): number {
    return this.count * this.opts.peoplePerAgent;
  }
}

export function defaultWidth(kind: string): number {
  switch (kind) {
    case 'stairs':
    case 'escalator':
      return 3;
    case 'elevator':
      return 1.5;
    case 'gate':
      return 8;
    case 'platform':
      return 6;
    case 'crossing':
      return 10;
    default:
      return 6;
  }
}
