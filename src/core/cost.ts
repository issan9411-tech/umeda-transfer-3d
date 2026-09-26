import { demandAt, densityFor, speedFactor, type DayType } from './congestion';
import { arcIndex, type Graph } from './graph';

export type ProfileId = 'standard' | 'hurry' | 'luggage' | 'senior' | 'stepfree';
export type Objective = 'time' | 'distance' | 'comfort';

export interface Profile {
  id: ProfileId;
  nameJa: string;
  descJa: string;
  /** Default walking speed on level ground, m/s. */
  speed: number;
  stairs: 'ok' | 'avoid' | 'forbid';
  escalator: 'ok' | 'forbid';
  /** Multiplier on vertical speed on stairs (1 = typical adult). */
  stairsSpeed: number;
}

export const PROFILES: Record<ProfileId, Profile> = {
  standard: {
    id: 'standard',
    nameJa: '標準',
    descJa: '一般的な歩行者（1.3 m/s）。階段・エスカレーターとも利用',
    speed: 1.3,
    stairs: 'ok',
    escalator: 'ok',
    stairsSpeed: 1,
  },
  hurry: {
    id: 'hurry',
    nameJa: '急ぎ',
    descJa: '早歩き（1.6 m/s）。階段も駆け上がる想定',
    speed: 1.6,
    stairs: 'ok',
    escalator: 'ok',
    stairsSpeed: 1.35,
  },
  luggage: {
    id: 'luggage',
    nameJa: '大きな荷物',
    descJa: 'スーツケース等（1.1 m/s）。階段はなるべく避ける',
    speed: 1.1,
    stairs: 'avoid',
    escalator: 'ok',
    stairsSpeed: 0.6,
  },
  senior: {
    id: 'senior',
    nameJa: 'ゆっくり',
    descJa: '高齢の方・子ども連れ（1.0 m/s）。階段は負担として評価',
    speed: 1.0,
    stairs: 'avoid',
    escalator: 'ok',
    stairsSpeed: 0.7,
  },
  stepfree: {
    id: 'stepfree',
    nameJa: '段差なし',
    descJa: '車いす・ベビーカー（1.0 m/s）。エレベーターとスロープのみ',
    speed: 1.0,
    stairs: 'forbid',
    escalator: 'forbid',
    stairsSpeed: 0,
  },
};

export interface CostOptions {
  profile: ProfileId;
  /** Override of the profile's level walking speed, m/s. */
  speed?: number;
  objective: Objective;
  /** Rain: strongly prefer weather-protected corridors. */
  rain: boolean;
  /** Fractional hour of day for the demand profile (8.5 = 8:30). */
  hour: number;
  day: DayType;
  /** Apply time-of-day crowding to walking speed. */
  congestion: boolean;
  /** Optional per-edge density (persons/m²) measured by the crowd simulation. Raises the time-of-day density where the simulation measures more crowding. */
  liveDensity?: Float32Array | null;
}

export const DEFAULT_OPTIONS: CostOptions = {
  profile: 'standard',
  objective: 'time',
  rain: false,
  hour: 10,
  day: 'weekday',
  congestion: true,
};

/** Vertical speeds on stairs (m of height per second) for a typical adult. */
export const STAIRS_UP_VV = 0.3;
export const STAIRS_DOWN_VV = 0.38;
/** Escalator: 30° incline at 0.5 m/s along the incline. */
export const ESCALATOR_SPEED = 0.5;
export const ESCALATOR_BOARD_S = 4;
/** Elevator: mean wait + door dwell, then 1 m/s travel. */
export const ELEVATOR_WAIT_S = 40;
export const ELEVATOR_DWELL_S = 10;
export const ELEVATOR_SPEED = 1;
/** Passing a fare gate with an IC card. */
export const GATE_S = 3;
/** Mean wait at a signalised crossing if the edge does not specify one. */
export const CROSSING_WAIT_S = 35;

/** Per-arc cost tables. Arc index = edge * 2 + (dir === 1 ? 0 : 1). Forbidden arcs are Infinity. */
export interface CostModel {
  options: CostOptions;
  /** Objective value used by the search. */
  cost: Float64Array;
  /** Expected traversal time in seconds. */
  time: Float64Array;
  /** Walking distance in metres (horizontal + vertical). */
  dist: Float64Array;
  /** Density used for each edge (persons/m²). */
  density: Float32Array;
}

export { arcIndex };

export function buildCostModel(g: Graph, options: CostOptions): CostModel {
  const profile = PROFILES[options.profile];
  const v0 = options.speed ?? profile.speed;
  const speedScale = v0 / 1.3;
  const demand = demandAt(options.hour, options.day);
  const E = g.edges.length;
  const cost = new Float64Array(E * 2);
  const time = new Float64Array(E * 2);
  const dist = new Float64Array(E * 2);
  const density = new Float32Array(E);

  for (let i = 0; i < E; i++) {
    const e = g.edges[i];
    const h = g.hlen[i];
    const dy = Math.abs(g.rise[i]);
    let rho = options.congestion ? densityFor(e.busy ?? 1, demand) : 0;
    if (options.liveDensity) rho = Math.max(rho, options.liveDensity[i] ?? 0);
    density[i] = rho;
    const crowd = speedFactor(rho);
    const v = v0 * crowd;
    // Queueing in front of bottlenecks grows with density.
    const queue = Math.min(60, rho * rho * 6);

    for (const dir of [1, -1] as const) {
      const k = arcIndex(i, dir);
      const up = g.rise[i] * dir > 0;
      let t: number;
      let c: number | null = null;
      switch (e.kind) {
        case 'walk':
        case 'platform':
          t = h / v;
          break;
        case 'crossing':
          t = h / v + (e.waitS ?? CROSSING_WAIT_S);
          break;
        case 'gate':
          t = h / v + GATE_S + queue * 0.5;
          break;
        case 'stairs': {
          if (profile.stairs === 'forbid') {
            t = Infinity;
            break;
          }
          const vv = (up ? STAIRS_UP_VV : STAIRS_DOWN_VV) * speedScale * profile.stairsSpeed * Math.max(0.5, crowd);
          const run = Math.max(0, h - 1.8 * dy);
          t = dy / vv + run / v;
          if (profile.stairs === 'avoid') c = t * 2 + 45;
          break;
        }
        case 'escalator': {
          if (profile.escalator === 'forbid') {
            t = Infinity;
            break;
          }
          const run = Math.max(0, h - 1.73 * dy);
          t = ESCALATOR_BOARD_S + (2 * dy) / ESCALATOR_SPEED + run / v + queue;
          break;
        }
        case 'elevator':
          t = (e.waitS ?? ELEVATOR_WAIT_S) + ELEVATOR_DWELL_S + dy / ELEVATOR_SPEED + h / v0 + queue * 0.5;
          break;
      }
      const d = h + dy;
      if (!Number.isFinite(t)) {
        cost[k] = Infinity;
        time[k] = Infinity;
        dist[k] = d;
        continue;
      }
      if (c === null) c = t;
      if (options.objective === 'distance') {
        // Metres, tie-broken by the profile-weighted cost (which carries the stairs-avoid penalty).
        const weighted = c;
        c = d + weighted * 1e-3;
        if (e.kind === 'stairs' && profile.stairs === 'avoid') c += 45 + dy * 10;
      } else if (options.objective === 'comfort') {
        if (e.kind === 'stairs') c += dy * (up ? 12 : 6);
        if (e.kind === 'escalator' || e.kind === 'elevator') c += dy * 1.5;
        if (e.kind === 'crossing') c += 25;
        c += h * rho * 0.4;
      }
      if (options.rain && !e.indoor) c = c * 3 + 30;
      cost[k] = c;
      time[k] = t;
      dist[k] = d;
    }
  }
  return { options, cost, time, dist, density };
}
