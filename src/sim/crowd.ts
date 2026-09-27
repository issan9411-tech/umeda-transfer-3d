import { demandAt, speedFactor, type DayType } from '../core/congestion';
import {
  arcIndex,
  buildCostModel,
  CROSSING_WAIT_S,
  DEFAULT_OPTIONS,
  ELEVATOR_DWELL_S,
  ELEVATOR_WAIT_S,
  ESCALATOR_BOARD_S,
  type CostModel,
} from '../core/cost';
import { transferBans, type Graph } from '../core/graph';
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
  /** Stable id (renderers key appearance and animation state on it). */
  id: number;
  /** Preferred lane across walkways, −1 (left) … 1 (right) of the direction of travel. */
  lane: number;
  /** Last horizontal heading, kept while moving vertically (elevators). */
  heading: number;
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
  /** Current edge index per live agent (same packing as `positions`). */
  readonly edgeOf: Int32Array;
  /** Per live agent: heading (yaw, 0 = +z), walking speed in m/s (0 while waiting or riding an
   * escalator / elevator), stable id, stairs direction (+1 up, −1 down, 0) and lateral offset in
   * metres to the right of the direction of travel (people spread across corridors). */
  readonly headings: Float32Array;
  readonly speeds: Float32Array;
  readonly ids: Uint32Array;
  readonly climbs: Int8Array;
  readonly lateral: Float32Array;
  count = 0;
  private nextId = 1;
  /** Node indices of each arc's start and end (arc index = edge * 2 + dir). */
  private arcFrom: Int32Array;
  private arcTo: Int32Array;
  /** Fixed wait at the start of each arc (signal, elevator, escalator boarding), seconds. */
  private hold: Float64Array;
  /** Arc → all usable parallel arcs between the same two nodes (stairs / escalator / elevator). */
  private parallel = new Map<number, number[]>();
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
    this.edgeOf = new Int32Array(this.opts.maxAgents);
    this.headings = new Float32Array(this.opts.maxAgents);
    this.speeds = new Float32Array(this.opts.maxAgents);
    this.ids = new Uint32Array(this.opts.maxAgents);
    this.climbs = new Int8Array(this.opts.maxAgents);
    this.lateral = new Float32Array(this.opts.maxAgents);

    this.arcFrom = new Int32Array(E * 2);
    this.arcTo = new Int32Array(E * 2);
    this.hold = new Float64Array(E * 2);
    g.edges.forEach((e, i) => {
      const a = g.nodeIndex.get(e.a) as number;
      const b = g.nodeIndex.get(e.b) as number;
      this.arcFrom[arcIndex(i, 1)] = a;
      this.arcTo[arcIndex(i, 1)] = b;
      this.arcFrom[arcIndex(i, -1)] = b;
      this.arcTo[arcIndex(i, -1)] = a;
      let w = 0;
      if (e.kind === 'crossing') w = e.waitS ?? CROSSING_WAIT_S;
      else if (e.kind === 'elevator') w = (e.waitS ?? ELEVATOR_WAIT_S) + ELEVATOR_DWELL_S;
      else if (e.kind === 'escalator') w = ESCALATOR_BOARD_S;
      for (const k of [arcIndex(i, 1), arcIndex(i, -1)]) {
        const t = this.free.time[k];
        this.hold[k] = Number.isFinite(t) ? Math.min(w, t * 0.9) : 0;
      }
    });
    g.adj.forEach((list) => {
      const byTo = new Map<number, number[]>();
      for (const a of list) {
        const k = arcIndex(a.edge, a.dir);
        if (!Number.isFinite(this.free.time[k])) continue;
        const ks = byTo.get(a.to) ?? [];
        ks.push(k);
        byTo.set(a.to, ks);
      }
      for (const ks of byTo.values()) if (ks.length > 1) for (const k of ks) this.parallel.set(k, ks);
    });
  }

  /**
   * Splits flow across parallel stairs / escalators / elevators with a logit choice on
   * free-flow time plus the current crowd delay, so busy stairs push people onto escalators.
   */
  private choose(k: number): number {
    const alts = this.parallel.get(k);
    if (!alts) return k;
    const cost = (a: number) => {
      const e = a >> 1;
      const kind = this.g.edges[e].kind;
      const rho = this.density[e];
      const t = this.free.time[a];
      return kind === 'escalator' || kind === 'elevator' ? t + Math.min(60, rho * rho * 6) : t / speedFactor(rho);
    };
    const c = alts.map(cost);
    const m = Math.min(...c);
    const w = c.map((x) => Math.exp(-(x - m) / 8));
    let r = this.rand() * w.reduce((s, x) => s + x, 0);
    for (let i = 0; i < alts.length; i++) if ((r -= w[i]) <= 0) return alts[i];
    return alts[alts.length - 1];
  }

  reset(): void {
    this.agents = [];
    this.count = 0;
    this.completed = 0;
    this.spawnDebt = 0;
    this.nextId = 1;
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
      t = shortestTree(this.g, this.free, [src.node], transferBans(this.g, src.stationId, dst.stationId));
      this.trees.set(key, t);
    }
    return t;
  }

  /** Spawns one agent; returns false when no valid origin/destination pair was found. */
  private spawn(): boolean {
    const o = this.pick();
    for (let tries = 0; tries < 8; tries++) {
      const d = this.pick();
      if (d.node === o.node || (d.stationId && d.stationId === o.stationId)) continue;
      const t = this.tree(o, d);
      // e.g. a street entrance reachable only through another operator's paid area
      if (!Number.isFinite(t.dist[d.node])) continue;
      const path = reconstruct(t, d.node);
      if (path.steps.length === 0) continue;
      const arcs = Int32Array.from(path.steps.map((s) => this.choose(arcIndex(s.edge, s.dir))));
      const color = this.stationColors.get(d.stationId ?? '') ?? 0x8a96a3;
      const id = this.nextId++;
      // Lane from the id (not the shared PRNG, so trips stay as before), biased to keep right.
      const lane = Math.max(-0.95, Math.min(0.95, hashUnit(id) * 1.8 - 0.9 + 0.2));
      const agent: Agent = { alive: true, arcs, seg: 0, prog: 0, speed: 0.8 + this.rand() * 0.4, color, id, lane, heading: 0 };
      this.edgeCount[arcs[0] >> 1] += 1;
      // Spread new agents along their first arc so the network does not pulse.
      agent.prog = this.rand() * this.free.time[arcs[0]] * 0.5;
      this.agents.push(agent);
      return true;
    }
    return false;
  }

  /** Advance the simulation by dt seconds of simulated time. */
  step(dt: number): void {
    const demand = demandAt(this.hour, this.day);
    const inflowAgents = (this.opts.peakInflow * demand) / this.opts.peoplePerAgent;
    this.spawnDebt += inflowAgents * dt;
    // `agents` holds live agents only (finished ones are dropped every step), so the cap is exact.
    while (this.spawnDebt >= 1 && this.agents.length < this.opts.maxAgents) {
      this.spawnDebt -= 1;
      if (!this.spawn()) break;
    }
    this.spawnDebt = Math.min(this.spawnDebt, 5);

    // Density from occupancy, exponentially smoothed.
    const alpha = Math.min(1, dt / 20);
    const ppa = this.opts.peoplePerAgent;
    for (let i = 0; i < this.density.length; i++) {
      const rho = (this.edgeCount[i] * ppa) / this.edgeArea[i];
      this.density[i] += (rho - this.density[i]) * alpha;
    }

    let w = 0;
    let keep = 0;
    for (const a of this.agents) {
      if (!a.alive) continue;
      let remaining = dt;
      while (remaining > 0 && a.alive) {
        const k = a.arcs[a.seg];
        const e = k >> 1;
        const tFree = Math.max(0.5, this.free.time[k]);
        const kind = this.g.edges[e].kind;
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
      // Interpolate position; during a fixed wait (signal, elevator) the agent stays at the start.
      const k = a.arcs[a.seg];
      const na = this.g.nodes[this.arcFrom[k]];
      const nb = this.g.nodes[this.arcTo[k]];
      const tF = Math.max(0.5, this.free.time[k]);
      const h = this.hold[k];
      const f = Math.min(1, Math.max(0, a.prog - h) / Math.max(0.5, tF - h));
      this.positions[w * 3] = na.x + (nb.x - na.x) * f;
      this.positions[w * 3 + 1] = na.y + (nb.y - na.y) * f;
      this.positions[w * 3 + 2] = na.z + (nb.z - na.z) * f;
      this.colors[w] = a.color;
      this.edgeOf[w] = k >> 1;
      // Motion for animated figures: displacement rate of the interpolation above.
      const edge = this.g.edges[k >> 1];
      const run = Math.hypot(nb.x - na.x, nb.z - na.z);
      if (run > 0.3) a.heading = Math.atan2(nb.x - na.x, nb.z - na.z);
      const riding = edge.kind === 'escalator' || edge.kind === 'elevator';
      const moving = a.prog > h && f < 1 && !riding;
      const rate = a.speed * (edge.kind === 'crossing' ? 1 : speedFactor(this.density[k >> 1]));
      this.headings[w] = a.heading;
      this.speeds[w] = moving ? (run * rate) / Math.max(0.5, tF - h) : 0;
      this.ids[w] = a.id;
      this.climbs[w] = edge.kind === 'stairs' ? Math.sign(nb.y - na.y) : 0;
      let room = lateralRoom(edge.kind, edge.width);
      if (edge.room) {
        // Stair wells / lift shafts beside the walkway: keep to the free side's width.
        const fwd = (k & 1) === 0;
        const side = a.lane < 0 === fwd ? edge.room[0] : edge.room[1];
        room = Math.min(room, side);
      }
      let lat = room > 0 ? a.lane * room : 0;
      // Through a gate line people use the aisles between the machines (walkway.ts: 0.9 m pitch,
      // an aisle on the centre line).
      if (edge.kind === 'gate') lat = Math.round(lat / GATE_AISLE_PITCH) * GATE_AISLE_PITCH;
      this.lateral[w] = lat;
      w++;
      this.agents[keep++] = a;
    }
    this.agents.length = keep;
    this.count = w;
  }

  /** Real pedestrians currently walking in the network. */
  get people(): number {
    return this.count * this.opts.peoplePerAgent;
  }
}

/** Uniform [0, 1) hash of an integer (lanes and other per-agent traits). */
export function hashUnit(n: number): number {
  let h = Math.imul(n ^ 0x5bd1e995, 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca77);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/** Spacing of fare-gate aisles (walkway.ts draws the machines at this pitch). */
export const GATE_AISLE_PITCH = 0.9;

/** How far from the centre line people may walk on an edge (metres; 0 on stairs and lifts). */
export function lateralRoom(kind: string, width: number | undefined): number {
  const w = Math.min(16, Math.max(3, width ?? defaultWidth(kind)));
  switch (kind) {
    case 'walk':
      return Math.max(0, w / 2 - 0.7);
    case 'crossing':
      return Math.max(0, Math.min(w, 8) / 2 - 0.7);
    case 'platform':
      // The walking line runs 1.6 m inside the platform edge, beside the stair wells: keep to a
      // 1.2 m band on it (behind the tactile strip, clear of the wells).
      return Math.max(0, Math.min(0.6, w / 2 - 1.6));
    case 'gate':
      return Math.max(0, Math.min(w / 1.4, 14) / 2 - 0.6);
    default:
      return 0;
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
