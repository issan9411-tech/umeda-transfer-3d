import { platformPieces, type EdgeKind, type Footprint, type Level, type Line, type NetEdge, type NetNode, type Network, type NodeKind, type Platform, type Road, type Station } from '../core/types';
import { alongOf, corners, detour, inflate, insideRect, lateralOf, rectFromFrame, rectsOverlap, segmentHitsRect, type ORect } from './flight-layout';

/** Local tangent plane centred on JR Osaka Station (Mapion reference point 34.70249, 135.49567). */
export const ORIGIN = { lat: 34.7025, lon: 135.4957 };
const M_PER_DEG_LAT = 110936;
const M_PER_DEG_LON = 111320 * Math.cos((ORIGIN.lat * Math.PI) / 180);

export type LatLon = [number, number];
export type XZ = { x: number; z: number };
export type Pos = LatLon | XZ;

/** WGS84 → local metres (x = east, z = south). */
export function ll(lat: number, lon: number): XZ {
  return { x: (lon - ORIGIN.lon) * M_PER_DEG_LON, z: -(lat - ORIGIN.lat) * M_PER_DEG_LAT };
}

export function toXZ(p: Pos): XZ {
  return Array.isArray(p) ? ll(p[0], p[1]) : p;
}

/** Point at `dist` metres from p along compass bearing `deg` (0 = north, 90 = east). */
export function offset(p: Pos, deg: number, dist: number): XZ {
  const q = toXZ(p);
  const r = (deg * Math.PI) / 180;
  return { x: q.x + Math.sin(r) * dist, z: q.z - Math.cos(r) * dist };
}

export function lerp(a: Pos, b: Pos, t: number): XZ {
  const p = toXZ(a);
  const q = toXZ(b);
  return { x: p.x + (q.x - p.x) * t, z: p.z + (q.z - p.z) * t };
}

interface NodeOpts {
  station?: string;
  paid?: boolean;
  label?: boolean;
  /** Elevation override (m); defaults to the level's elevation. */
  y?: number;
}

interface EdgeOpts {
  name?: string;
  indoor?: boolean;
  width?: number;
  busy?: number;
  length?: number;
  waitS?: number;
}

/**
 * Where a vertical connection physically is. By default the builder derives it from the two
 * landings (see `layoutFlights`); surveyed data can pin it down.
 */
export interface FlightOpts {
  /** Compass bearing (0 = north, 90 = east) of the walking direction when going UP. */
  bearingUp?: number;
  /**
   * Which end of the flight sits on its node: 'top' = the head is at the upper node (platform
   * stair heads, street exits), 'bottom' = the foot is at the lower node, 'mid' = centred
   * between the two nodes.
   */
  anchor?: 'top' | 'bottom' | 'mid';
}

type VerticalMode = { kind: 'stairs' | 'escalator' | 'elevator'; dir?: NetEdge['dir']; o: EdgeOpts };

interface VerticalSpec {
  a: string;
  b: string;
  modes: VerticalMode[];
  o: EdgeOpts & FlightOpts;
}

/**
 * A flight or shaft already laid out: its plan rectangle, the height of its walking surface along
 * it (linear from y0 at s = 0 to y1 at s = len, along axis u from o), and the parts that other
 * walkways must avoid on each level: `low` (less than head room above the lower floor) and `well`
 * (the opening in the upper floor, where the flight is less than head room below it).
 */
interface Placed {
  full: ORect;
  low: ORect;
  well: ORect;
  o: XZ;
  u: XZ;
  len: number;
  y0: number;
  y1: number;
  shaft: boolean;
}

/** Head room plus slab: an upper floor may run over a flight only this far above its surface. */
export const WELL_HEADROOM = 2.6;

/** Whether two flights / shafts would occupy the same space (surfaces closer than head room). */
function clash(a: Placed, b: Placed): boolean {
  if (!rectsOverlap(inflate(a.full, 0.2), b.full)) return false;
  const n = { x: -a.u.z, z: a.u.x };
  const hw = a.full.hn;
  for (let s = 0; s <= a.len + 1e-6; s += 0.5) {
    const ha = a.shaft ? null : a.y0 + ((a.y1 - a.y0) * s) / Math.max(a.len, 1e-6);
    for (const t of [-hw, 0, hw]) {
      const p = { x: a.o.x + a.u.x * s + n.x * t, z: a.o.z + a.u.z * s + n.z * t };
      if (!insideRect(inflate(b.full, 0.2), p)) continue;
      if (b.shaft || a.shaft) {
        const [lo, hi] = a.shaft ? [a.y0, a.y1] : [ha as number, ha as number];
        if (hi > b.y0 - WELL_HEADROOM && lo < b.y1 + WELL_HEADROOM) return true;
        continue;
      }
      const sb = alongOf(b.o, b.u, p);
      const hb = b.y0 + ((b.y1 - b.y0) * Math.max(0, Math.min(b.len, sb))) / Math.max(b.len, 1e-6);
      if (Math.abs((ha as number) - hb) < WELL_HEADROOM) return true;
    }
  }
  return false;
}

/** Stair going per metre of rise (30 cm treads, 16 cm risers ≈ 28°). */
export const STAIR_RUN_PER_RISE = 1.875;
/** Escalators are inclined at 30°. */
export const ESCALATOR_RUN_PER_RISE = Math.sqrt(3);
/** A landing at least every 4 m of rise (Building Standards Order art. 24), 1.6 m deep. */
export const STAIR_LANDING_EVERY = 4;
export const STAIR_LANDING_DEPTH = 1.6;
/** Plan widths of the parallel lanes of a bundle (m). */
const LANE_WIDTH = { stairs: 3.2, escalator: 1.6, elevator: 2.6 } as const;
const LANE_GAP = 0.5;

/** Walking line on a platform: 1.6 m inside one edge (beside the stair wells); wide bays keep the centre. */
export function platformWalkOffset(p: Platform): number {
  return p.width >= 16 ? 0 : Math.max(0, p.width / 2 - 1.6);
}

/** Platform axis frame: o = end a, u = unit a→b, n = u rotated +90°, len. */
export function platformFrame(p: Platform): { o: XZ; u: XZ; n: XZ; len: number } {
  const ax = p.b[0] - p.a[0];
  const az = p.b[1] - p.a[1];
  const len = Math.hypot(ax, az) || 1;
  const u = { x: ax / len, z: az / len };
  return { o: { x: p.a[0], z: p.a[1] }, u, n: { x: -u.z, z: u.x }, len };
}

/** Horizontal run of a flight of the given kind and rise (landings included). */
export function flightRun(kind: VerticalMode['kind'], rise: number): number {
  if (kind === 'elevator') return 0;
  if (kind === 'escalator') return rise * ESCALATOR_RUN_PER_RISE;
  const landings = Math.max(0, Math.ceil(rise / STAIR_LANDING_EVERY - 1e-6) - 1);
  return rise * STAIR_RUN_PER_RISE + landings * STAIR_LANDING_DEPTH;
}

export interface PlatformSpec {
  id: string;
  station: string;
  nameJa: string;
  lines: string[];
  directions: string;
  level: string;
  /** End points (lat/lon or local). */
  a: Pos;
  b: Pos;
  width: number;
  y?: number;
  /** Boarding positions as fractions along a→b with human-readable names. */
  stops: { key: string; t: number; name: string }[];
  busy?: number;
  /** Further slab pieces where the platform narrows or shifts (no stops, no tracks). */
  sections?: { a: Pos; b: Pos; width: number }[];
}

/**
 * Small DSL for hand-building the pedestrian network with readable ids.
 * Nodes inherit their elevation from the level unless given explicitly.
 */
export class NetBuilder {
  readonly levels: Level[];
  readonly lines: Line[] = [];
  readonly stations: Station[] = [];
  readonly platforms: Platform[] = [];
  readonly nodes: NetNode[] = [];
  readonly edges: NetEdge[] = [];
  readonly footprints: Footprint[] = [];
  readonly roads: Road[] = [];
  private byId = new Map<string, NetNode>();
  private edgeSeq = 0;

  constructor(levels: Level[]) {
    this.levels = levels;
  }

  levelY(id: string): number {
    const l = this.levels.find((x) => x.id === id);
    if (!l) throw new Error(`unknown level ${id}`);
    return l.y;
  }

  get(id: string): NetNode {
    const n = this.byId.get(id);
    if (!n) throw new Error(`unknown node ${id}`);
    return n;
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  line(l: Line): this {
    this.lines.push(l);
    return this;
  }

  station(s: Station): this {
    this.stations.push(s);
    return this;
  }

  node(id: string, kind: NodeKind, name: string, at: Pos, level: string, o: NodeOpts = {}): string {
    if (this.byId.has(id)) throw new Error(`duplicate node ${id}`);
    const p = toXZ(at);
    const n: NetNode = {
      id,
      kind,
      name,
      x: Math.round(p.x * 10) / 10,
      y: o.y ?? this.levelY(level),
      z: Math.round(p.z * 10) / 10,
      level,
      stationId: o.station,
      paid: o.paid,
      label: o.label,
    };
    this.nodes.push(n);
    this.byId.set(id, n);
    return id;
  }

  /** Junction shorthand. */
  j(id: string, name: string, at: Pos, level: string, o: NodeOpts = {}): string {
    return this.node(id, 'junction', name, at, level, o);
  }

  private edge(kind: EdgeKind, a: string, b: string, o: EdgeOpts & { dir?: NetEdge['dir'] } = {}): string {
    this.get(a);
    this.get(b);
    const id = `${kind}:${a}~${b}#${this.edgeSeq++}`;
    this.edges.push({
      id,
      a,
      b,
      kind,
      name: o.name,
      indoor: o.indoor ?? true,
      width: o.width,
      busy: o.busy,
      length: o.length,
      waitS: o.waitS,
      dir: o.dir,
    });
    return id;
  }

  /** Walking along a platform between two points on it (not a boarding position). */
  platformWalk(a: string, b: string, o: EdgeOpts = {}): this {
    this.edge('platform', a, b, o);
    return this;
  }

  walk(a: string, b: string, o: EdgeOpts = {}): this {
    this.edge('walk', a, b, o);
    return this;
  }

  /** Walkway through a sequence of nodes. */
  path(ids: string[], o: EdgeOpts = {}): this {
    for (let i = 0; i < ids.length - 1; i++) this.edge('walk', ids[i], ids[i + 1], o);
    return this;
  }

  stairs(a: string, b: string, o: EdgeOpts & FlightOpts = {}): this {
    return this.addVertical(a, b, [{ kind: 'stairs' }], o);
  }

  esc(a: string, b: string, dir: 'up' | 'down' | 'both' = 'both', o: EdgeOpts & FlightOpts = {}): this {
    return this.addVertical(a, b, [{ kind: 'escalator', dir }], o);
  }

  elev(a: string, b: string, o: EdgeOpts & FlightOpts = {}): this {
    return this.addVertical(a, b, [{ kind: 'elevator' }], o);
  }

  private readonly verticals: VerticalSpec[] = [];
  /** Footprints of flights already laid out (bundles must not overlap). */
  private readonly placedFlights: Placed[] = [];

  private addVertical(a: string, b: string, modes: Omit<VerticalMode, 'o'>[], o: EdgeOpts & FlightOpts): this {
    this.get(a);
    this.get(b);
    const { bearingUp, anchor, ...edgeOpts } = o;
    const list = modes.map((m) => ({ ...m, o: edgeOpts }));
    // Separate calls for the same pair of landings form one bundle, laid out side by side.
    const same = this.verticals.find((v) => (v.a === a && v.b === b) || (v.a === b && v.b === a));
    if (same) {
      same.modes.push(...list);
      same.o = { ...same.o, bearingUp: same.o.bearingUp ?? bearingUp, anchor: same.o.anchor ?? anchor, width: Math.max(same.o.width ?? 0, o.width ?? 0) || undefined };
    } else {
      this.verticals.push({ a, b, modes: list, o: { ...o } });
    }
    return this;
  }

  gate(paidSide: string, freeSide: string, name: string, o: EdgeOpts = {}): this {
    this.edge('gate', paidSide, freeSide, { name, ...o });
    return this;
  }

  cross(a: string, b: string, name: string, waitS = 35, o: EdgeOpts = {}): this {
    this.edge('crossing', a, b, { name, waitS, indoor: false, ...o });
    return this;
  }

  /**
   * Vertical connection bundle: stairs, escalator and/or elevator between two landings.
   * Creates separate landing nodes per mode so the renderer can show them side by side.
   */
  vertical(a: string, b: string, modes: ('stairs' | 'esc' | 'esc-up' | 'esc-down' | 'elev')[], o: EdgeOpts & FlightOpts = {}): this {
    const list: Omit<VerticalMode, 'o'>[] = modes.map((m) =>
      m === 'stairs'
        ? { kind: 'stairs' }
        : m === 'elev'
          ? { kind: 'elevator' }
          : { kind: 'escalator', dir: m === 'esc-up' ? 'up' : m === 'esc-down' ? 'down' : 'both' },
    );
    return this.addVertical(a, b, list, o);
  }

  /**
   * Turns every recorded vertical connection into physical flights: stairs at 28° with a landing
   * every 4 m of rise, escalators at 30°, elevators as vertical shafts. The declared nodes are
   * joined to each flight's ends by level walkways that go around the stair wells (never over a
   * well, never under the low end of a flight), so the walker, the crowd and the renderer all
   * follow something that could really be built.
   */
  private layoutFlights(): void {
    this.alignPlatformWalks();
    for (const v of this.verticals) this.layoutBundle(v);
    this.verticals.length = 0;
  }

  /**
   * People walk along an island platform beside its stair wells, not over them: every node on a
   * platform (boarding positions, stair heads) moves onto a walking line 1.6 m inside one edge.
   * Very wide platform groups (Hankyu's merged 3-platform bays) keep their centre line.
   */
  private alignPlatformWalks(): void {
    for (const n of this.nodes) {
      const p = this.platformUnder(n);
      if (!p) continue;
      const f = platformFrame(p);
      const lat = lateralOf(f.o, f.u, n);
      const want = platformWalkOffset(p);
      if (Math.abs(lat - want) < 0.05) continue;
      n.x = Math.round((n.x + f.n.x * (want - lat)) * 10) / 10;
      n.z = Math.round((n.z + f.n.z * (want - lat)) * 10) / 10;
    }
  }

  private layoutBundle(v: VerticalSpec): void {
    const na = this.get(v.a);
    const nb = this.get(v.b);
    const [L, U] = na.y <= nb.y ? [na, nb] : [nb, na];
    // A few steps (or a ramp) between nearly level nodes: keep the direct link.
    if (U.y - L.y < 1.2) {
      for (const m of v.modes) this.edge(m.kind, v.a, v.b, { ...m.o, dir: m.dir });
      return;
    }
    // Try the natural direction first; if the bundle cannot be placed clear of every corridor,
    // also try it reversed (and, off platforms, turned by 90°) and keep the best.
    const f0 = this.bundleFrame(L, U, v, 0);
    const turns = v.o.bearingUp !== undefined ? [0] : f0.platform ? [0, Math.PI] : [0, Math.PI, Math.PI / 2, -Math.PI / 2];
    let best = { cost: Infinity, turn: 0 };
    for (const turn of turns) {
      const cost = this.placeBundle(L, U, v, this.bundleFrame(L, U, v, turn), true);
      if (cost < best.cost) best = { cost, turn };
      if (cost === 0) break;
    }
    this.placeBundle(L, U, v, this.bundleFrame(L, U, v, best.turn), false);
  }

  /** Lays a bundle out in frame f; with `dry` only returns its conflict count. */
  private placeBundle(L: NetNode, U: NetNode, v: VerticalSpec, f: ReturnType<NetBuilder['bundleFrame']>, dry: boolean): number {
    const rise = U.y - L.y;
    // Flights first (inner lanes), elevators after them (outer lane / beyond the anchored end).
    const flights = v.modes.map((m, k) => ({ m, k })).filter(({ m }) => m.kind !== 'elevator');
    const lifts = v.modes.map((m, k) => ({ m, k })).filter(({ m }) => m.kind === 'elevator');
    const widthOf = (m: VerticalMode) => (m.kind === 'stairs' ? Math.min(8, Math.max(1.8, m.o.width ?? LANE_WIDTH.stairs)) : LANE_WIDTH[m.kind]);
    const lanes = f.platform ? flights : [...flights, ...lifts];
    const total = lanes.reduce((s, { m }) => s + widthOf(m), 0) + LANE_GAP * Math.max(0, lanes.length - 1);
    const center = f.center(total);
    const lat = new Map<number, number>();
    let acc = center - total / 2;
    for (const { m, k } of lanes) {
      lat.set(k, acc + widthOf(m) / 2);
      acc += widthOf(m) + LANE_GAP;
    }
    const at = (s: number, l: number): XZ => ({ x: f.o.x + f.u.x * s + f.n.x * l, z: f.o.z + f.u.z * s + f.n.z * l });
    const tag = (k: number) => `${v.a}~${v.b}#${k}`;
    const station = L.stationId ?? U.stationId;
    const newNode = (id: string, p: XZ, level: NetNode, name: string, y = level.y) =>
      this.node(id, 'vertical', name, p, level.level, { station: level.stationId ?? station, paid: level.paid, y });

    // Longitudinal extent of each flight: aligned at the anchored end, 1.2 m clear of the node.
    const CLEAR = 1.2;
    const liftRoom = 0;
    const span = new Map<number, [number, number]>();
    const shafts: { k: number; s: number; l: number; rect: ORect }[] = [];
    const place = (ds: number, dl: number) => {
      for (const { m, k } of flights) {
        const R = flightRun(m.kind, rise);
        const s0 = (f.anchor === 'bottom' ? CLEAR + liftRoom : f.anchor === 'top' ? f.len - CLEAR - liftRoom - R : (f.len - R) / 2) + ds;
        span.set(k, [s0, s0 + R]);
      }
      for (const [k, l] of baseLat) lat.set(k, l + dl);
      shafts.length = 0;
      lifts.forEach(({ k }, i) => {
        const h = LANE_WIDTH.elevator / 2;
        let sc: number;
        let l: number;
        if (f.platform) {
          // On a platform the shaft stands on the flights' line beyond their far end, clear of
          // the space where people step on and off the flights.
          const ends = [...span.values()];
          sc = f.anchor === 'bottom' ? Math.max(...ends.map((e) => e[1])) + 4 + h : Math.min(...ends.map((e) => e[0])) - 4 - h;
          if (!ends.length) sc = (f.anchor === 'bottom' ? CLEAR + h : f.len - CLEAR - h) + ds;
          l = center + i * (LANE_WIDTH.elevator + LANE_GAP) + dl;
        } else {
          sc = (f.anchor === 'bottom' ? CLEAR + h : f.anchor === 'top' ? f.len - CLEAR - h : f.len / 2) + ds;
          l = lat.get(k) as number;
        }
        shafts.push({ k, s: sc, l, rect: rectFromFrame(f.o, f.u, sc - h, sc + h, l - h, l + h) });
      });
    };
    const baseLat = new Map(lat);
    const lowPart = (k: number, m: VerticalMode): ORect => {
      const [s0, s1] = span.get(k) as [number, number];
      const w = widthOf(m);
      // Headroom under a flight starts ≈2.3 m above the lower floor.
      const sLow = s0 + (s1 - s0) * Math.min(1, 2.3 / rise);
      // Obstacles stop 0.2 m short of the flight's ends: the end nodes (rounded to 0.1 m by
      // node()) must lie outside, or no walkway could leave them.
      return rectFromFrame(f.o, f.u, s0 + 0.2, sLow, (lat.get(k) as number) - w / 2 - 0.15, (lat.get(k) as number) + w / 2 + 0.15);
    };
    // The upper floor opens only where the flight is less than head room below it.
    const well = (k: number, m: VerticalMode): ORect => {
      const [s0, s1] = span.get(k) as [number, number];
      const w = widthOf(m);
      const sw = s1 - (s1 - s0) * Math.min(1, WELL_HEADROOM / rise);
      return rectFromFrame(f.o, f.u, Math.max(s0 + 0.2, sw), s1 - 0.2, (lat.get(k) as number) - w / 2 - 0.15, (lat.get(k) as number) + w / 2 + 0.15);
    };
    const placed = (k: number, m: VerticalMode): Placed => {
      const [s0, s1] = span.get(k) as [number, number];
      const w = widthOf(m);
      const l = lat.get(k) as number;
      const o = { x: f.o.x + f.u.x * s0 + f.n.x * l, z: f.o.z + f.u.z * s0 + f.n.z * l };
      return { full: rectFromFrame(f.o, f.u, s0, s1, l - w / 2 - 0.15, l + w / 2 + 0.15), low: lowPart(k, m), well: well(k, m), o, u: f.u, len: s1 - s0, y0: L.y, y1: U.y, shaft: false };
    };
    const placedShaft = (r: ORect): Placed => ({ full: r, low: r, well: r, o: r.c, u: r.u, len: 0, y0: L.y, y1: U.y, shaft: true });
    // Slide the bundle along (and, off platforms, across) its line until no corridor centre line
    // on either level runs through a flight (its low end below, its well above) and it does not
    // overlap flights laid out before it.
    {
      const near = (n: NetNode) => Math.min(Math.hypot(n.x - L.x, n.z - L.z), Math.hypot(n.x - U.x, n.z - U.z)) < 60 + flightRun('stairs', rise);
      const lines: { a: XZ; b: XZ; level: 'low' | 'high' }[] = [];
      for (const e of this.edges) {
        if (e.kind === 'stairs' || e.kind === 'escalator' || e.kind === 'elevator') continue;
        const a = this.get(e.a);
        const b = this.get(e.b);
        if (!near(a) && !near(b)) continue;
        if (Math.abs(a.y - L.y) < 0.6 && Math.abs(b.y - L.y) < 0.6) lines.push({ a, b, level: 'low' });
        else if (Math.abs(a.y - U.y) < 0.6 && Math.abs(b.y - U.y) < 0.6) lines.push({ a, b, level: 'high' });
      }
      const others = this.placedFlights.filter((p) => p.y0 < U.y + WELL_HEADROOM && p.y1 > L.y - WELL_HEADROOM);
      const cost = () => {
        let c = 0;
        for (const { m, k } of flights) {
          const lo = inflate(lowPart(k, m), 0.6);
          const hi = inflate(well(k, m), 0.4);
          for (const ln of lines) if (segmentHitsRect(ln.level === 'low' ? lo : hi, ln.a, ln.b)) c++;
          const me = placed(k, m);
          for (const o of others) if (clash(me, o)) c++;
        }
        for (const sh of shafts) {
          const r = inflate(sh.rect, 0.5);
          for (const ln of lines) if (segmentHitsRect(r, ln.a, ln.b)) c++;
          const me = placedShaft(sh.rect);
          for (const o of others) if (clash(me, o)) c++;
        }
        return c;
      };
      const steps = f.anchor === 'top' ? [0, -1, -2, -3, -4, -5, -6, -8, -10, -12, -15, -18, -22] : f.anchor === 'bottom' ? [0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 18, 22] : [0, 1, -1, 2, -2, 3, -3, 5, -5, 8, -8, 12, -12];
      const across = f.platform ? [0, 0.5, -0.5, 1, -1] : [0, 1.5, -1.5, 3, -3, 5, -5, 8, -8];
      let best = { c: Infinity, ds: 0, dl: 0, score: Infinity };
      for (const ds of steps) {
        for (const dl of across) {
          place(ds, dl);
          const c = cost();
          const score = c * 1000 + Math.abs(ds) + 1.5 * Math.abs(dl);
          if (score < best.score) best = { c, ds, dl, score };
          if (c === 0) break;
        }
        if (best.c === 0) break;
      }
      place(best.ds, best.dl);
      if (dry) return best.c;
      for (const { m, k } of flights) this.placedFlights.push(placed(k, m));
      for (const sh of shafts) this.placedFlights.push(placedShaft(sh.rect));
    }
    const lowObstacles = [...flights.map(({ m, k }) => lowPart(k, m)), ...shafts.map((x) => x.rect)];
    const highObstacles = [...flights.map(({ m, k }) => well(k, m)), ...shafts.map((x) => x.rect)];

    /**
     * Level walkway from a flight end (or shaft) to a node, around wells and other shafts. The
     * last / first 1.2 m run straight along the flight (`approach`), as people step on and off.
     */
    const link = (from: string, to: string, level: 'low' | 'high', m: VerticalMode, w: number, own?: ORect, approach?: { at: XZ; near: 'from' | 'to' }) => {
      if (approach) {
        const end = this.get(approach.near === 'from' ? from : to);
        const other = this.get(approach.near === 'from' ? to : from);
        if (Math.hypot(other.x - approach.at.x, other.z - approach.at.z) > 0.6) {
          const id = `${end.id}:step`;
          const n = this.has(id) ? id : newNode(id, approach.at, end, end.name);
          const opts = { indoor: m.o.indoor, busy: m.o.busy, width: Math.max(w, 2.4) };
          // Only the step through the shaft's own door may cross the shaft; the rest avoids it.
          if (approach.near === 'from') {
            this.edge('walk', from, n, opts);
            link(n, to, level, m, w);
          } else {
            link(from, n, level, m, w);
            this.edge('walk', n, to, opts);
          }
          return;
        }
      }
      const a = this.get(from);
      const b = this.get(to);
      const obstacles = (level === 'low' ? lowObstacles : highObstacles).filter((r) => r !== own);
      // 0.9 m clear of a well: the crowd spreads up to 0.8 m either side of a walkway's line.
      const via = detour(a, b, obstacles, 0.9);
      const opts = { indoor: m.o.indoor, busy: m.o.busy, width: Math.max(w, 2.4) };
      let prev = from;
      via.forEach((p, i) => {
        const id = `${from}>${to}~${i}`;
        const n = this.has(id) ? id : newNode(id, p, a, a.name);
        this.edge('walk', prev, n, opts);
        prev = n;
      });
      if (prev !== to) this.edge('walk', prev, to, opts);
    };

    for (const { m, k } of flights) {
      const [s0, s1] = span.get(k) as [number, number];
      const l = lat.get(k) as number;
      const label = m.o.name ?? (m.kind === 'stairs' ? '階段' : 'エスカレーター');
      const foot = newNode(`${tag(k)}:foot`, at(s0, l), L, `${label}（${L.level}側）`);
      const head = newNode(`${tag(k)}:head`, at(s1, l), U, `${label}（${U.level}側）`);
      const opts = { ...m.o, dir: m.dir };
      if (m.kind === 'stairs') {
        const n = Math.max(0, Math.ceil(rise / STAIR_LANDING_EVERY - 1e-6) - 1);
        const segRise = rise / (n + 1);
        const segRun = segRise * STAIR_RUN_PER_RISE;
        let prev = foot;
        let s = s0;
        for (let i = 1; i <= n; i++) {
          const y = L.y + segRise * i;
          const a1 = newNode(`${tag(k)}:l${i}a`, at(s + segRun, l), L, `${label} 踊り場`, y);
          const b1 = newNode(`${tag(k)}:l${i}b`, at(s + segRun + STAIR_LANDING_DEPTH, l), L, `${label} 踊り場`, y);
          this.get(a1).landing = true;
          this.get(b1).landing = true;
          this.edge('stairs', prev, a1, opts);
          this.edge('stairs', a1, b1, opts);
          prev = b1;
          s += segRun + STAIR_LANDING_DEPTH;
        }
        this.edge('stairs', prev, head, opts);
      } else {
        this.edge('escalator', foot, head, opts);
      }
      link(L.id, foot, 'low', m, widthOf(m), undefined, { at: at(s0 - 1.2, l), near: 'to' });
      link(head, U.id, 'high', m, widthOf(m), undefined, { at: at(s1 + 1.2, l), near: 'from' });
    }
    for (const sh of shafts) {
      const m = v.modes[sh.k];
      const label = m.o.name ?? 'エレベーター';
      // The cabin rides at the shaft centre; the renderer draws the shaft around it.
      const c = at(sh.s, sh.l);
      const foot = newNode(`${tag(sh.k)}:foot`, c, L, `${label}（${L.level}）`);
      const head = newNode(`${tag(sh.k)}:head`, c, U, `${label}（${U.level}）`);
      this.edge('elevator', foot, head, { ...m.o });
      // Doors face the anchored end (the node side): step out 2 m through that face.
      const out = f.anchor === 'top' ? 1 : -1;
      const door = at(sh.s + out * (LANE_WIDTH.elevator / 2 + 0.8), sh.l);
      link(L.id, foot, 'low', m, LANE_WIDTH.elevator, sh.rect, { at: door, near: 'to' });
      link(head, U.id, 'high', m, LANE_WIDTH.elevator, sh.rect, { at: door, near: 'from' });
    }
    return 0;
  }

  /**
   * Plan frame of a bundle: origin o (s = 0 where L projects), unit u pointing the way people
   * walk UP, n = u rotated +90°, len = where U projects, the anchor, and where the lanes go
   * across (center(totalWidth) → lateral offset of the bundle's centre line).
   */
  private bundleFrame(
    L: NetNode,
    U: NetNode,
    v: VerticalSpec,
    turn = 0,
  ): { o: XZ; u: XZ; n: XZ; len: number; anchor: 'top' | 'bottom' | 'mid'; platform: Platform | null; center: (w: number) => number } {
    const dx = U.x - L.x;
    const dz = U.z - L.z;
    const d = Math.hypot(dx, dz);
    const pU = this.platformUnder(U);
    const pL = this.platformUnder(L);
    const plat = pU && pL ? null : (pU ?? pL ?? null);
    const maxRun = Math.max(...v.modes.map((m) => flightRun(m.kind, U.y - L.y)));
    let u: XZ;
    if (v.o.bearingUp !== undefined) {
      const r = (v.o.bearingUp * Math.PI) / 180;
      u = { x: Math.sin(r), z: -Math.cos(r) };
    } else if (plat) {
      // Platform stairs run along the platform, inside its outline, ending towards the other node.
      const pf = platformFrame(plat);
      const on = plat === pU ? U : L;
      const other = plat === pU ? L : U;
      const t = alongOf(pf.o, pf.u, on);
      const tOther = alongOf(pf.o, pf.u, other);
      const score = (sg: 1 | -1) => {
        // The flight leaves the platform node's end towards the other node's side.
        const far = plat === pU ? tOther + sg * (maxRun + 5) : tOther - sg * (maxRun + 5);
        const out = Math.max(0, -far, far - pf.len);
        return out * 100 + Math.abs(far - t);
      };
      const sg = score(1) <= score(-1) ? 1 : -1;
      u = { x: pf.u.x * sg, z: pf.u.z * sg };
    } else if (d >= 1.5) {
      u = { x: dx / d, z: dz / d };
    } else {
      // Stacked landings: continue straight on from the longest corridor arriving at the top.
      let best: NetNode | null = null;
      for (const e of this.edges) {
        const other = e.a === U.id ? e.b : e.b === U.id ? e.a : null;
        if (!other || e.kind === 'stairs' || e.kind === 'escalator' || e.kind === 'elevator') continue;
        const n = this.get(other);
        if (!best || Math.hypot(n.x - U.x, n.z - U.z) > Math.hypot(best.x - U.x, best.z - U.z)) best = n;
      }
      const bx = best ? best.x - U.x : 0;
      const bz = best ? best.z - U.z : -1;
      const bl = Math.hypot(bx, bz) || 1;
      u = { x: bx / bl, z: bz / bl };
    }
    if (turn) {
      const c = Math.cos(turn);
      const sn = Math.sin(turn);
      u = { x: u.x * c - u.z * sn, z: u.x * sn + u.z * c };
    }
    const n = { x: -u.z, z: u.x };
    const len = dx * u.x + dz * u.z;
    // Platform bundles are anchored at the concourse end (people walk along the platform to the
    // stair head); otherwise at a declared landing node, else centred when there is room.
    const anchor: 'top' | 'bottom' | 'mid' =
      v.o.anchor ??
      (plat === pU && plat ? 'bottom' : plat === pL && plat ? 'top' : L.kind === 'vertical' && U.kind !== 'vertical' ? 'bottom' : U.kind === 'vertical' && L.kind !== 'vertical' ? 'top' : len >= maxRun + 2.4 ? 'mid' : 'top');
    const through = anchor === 'top' ? U : anchor === 'bottom' ? L : { x: (L.x + U.x) / 2, z: (L.z + U.z) / 2 };
    const sAt = anchor === 'top' ? len : anchor === 'bottom' ? 0 : len / 2;
    const o = { x: through.x - u.x * sAt, z: through.z - u.z * sAt };
    let center: (w: number) => number = () => 0;
    if (plat) {
      // Across the platform: the walking line is at +walk (platform frame); keep 0.9 m clear of
      // it and 0.7 m from the far edge.
      const pf = platformFrame(plat);
      const walk = platformWalkOffset(plat);
      const sameSide = pf.n.x * n.x + pf.n.z * n.z > 0 ? 1 : -1;
      const oLat = lateralOf(pf.o, pf.u, o);
      center = (w) => {
        const lim = Math.max(0, plat.width / 2 - 0.7 - w / 2);
        const want = Math.max(-lim, Math.min(lim, walk - 0.9 - w / 2));
        return (want - oLat) * sameSide;
      };
    }
    return { o, u, n, len, anchor, platform: plat, center };
  }

  /**
   * Records, per level walkway, how far people can spread to either side before reaching a stair
   * well or lift shaft laid out beside it (the crowd keeps within this; see sim/crowd.ts).
   */
  private limitRooms(): void {
    for (const e of this.edges) {
      if (e.kind === 'stairs' || e.kind === 'escalator' || e.kind === 'elevator') continue;
      const a = this.get(e.a);
      const b = this.get(e.b);
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len < 0.3) continue;
      const u = { x: (b.x - a.x) / len, z: (b.z - a.z) / len };
      const y = (a.y + b.y) / 2;
      let left = Infinity;
      let right = Infinity;
      for (const f of this.placedFlights) {
        if (y < f.y0 - 0.3 || y > f.y1 + 0.3) continue;
        // On the lower floor the flight's low end is in the way, on the upper one its opening.
        const rect = f.shaft ? f.full : Math.abs(y - f.y0) < 0.6 ? f.low : Math.abs(y - f.y1) < 0.6 ? f.well : null;
        if (!rect) continue;
        const cs = corners(rect);
        const ss = cs.map((p) => alongOf(a, u, p));
        if (Math.max(...ss) < -0.5 || Math.min(...ss) > len + 0.5) continue;
        const ts = cs.map((p) => lateralOf(a, u, p));
        const t0 = Math.min(...ts);
        const t1 = Math.max(...ts);
        if (t0 >= 0) right = Math.min(right, t0 - 0.5);
        else if (t1 <= 0) left = Math.min(left, -t1 - 0.5);
        else left = right = 0;
      }
      // On a platform people keep 1 m back from its edges (screens, tactile strip, the tracks),
      // and beyond its end they keep back from the ends of the tracks.
      if (e.kind !== 'gate') {
        const n = { x: -u.z, z: u.x }; // the edge's right-hand side
        for (const plat of this.platforms.flatMap(platformPieces)) {
          if (Math.abs(plat.y - y) > 0.6) continue;
          const pl = Math.hypot(plat.b[0] - plat.a[0], plat.b[1] - plat.a[1]) || 1;
          const po = { x: plat.a[0], z: plat.a[1] };
          const pu = { x: (plat.b[0] - plat.a[0]) / pl, z: (plat.b[1] - plat.a[1]) / pl };
          // A 阪急-style group record is walked on its middle platform, between two tracks.
          const hw = plat.width >= 16 ? plat.width / 4 - 1.65 : plat.width / 2;
          const cq = n.x * -pu.z + n.z * pu.x; // lateral rate of the right-hand side
          const ct = n.x * pu.x + n.z * pu.z; // along-platform rate of the right-hand side
          const steps = Math.max(1, Math.ceil(len));
          for (let k = 0; k <= steps; k++) {
            const p = { x: a.x + (b.x - a.x) * (k / steps), z: a.z + (b.z - a.z) * (k / steps) };
            const t = alongOf(po, pu, p);
            const q = lateralOf(po, pu, p);
            if (Math.abs(q) > hw + 0.5) continue;
            if (t >= 0 && t <= pl) {
              if (Math.abs(cq) < 0.05) continue;
              right = Math.min(right, (cq > 0 ? hw - q : q + hw) / Math.abs(cq) - 1);
              left = Math.min(left, (cq > 0 ? q + hw : hw - q) / Math.abs(cq) - 1);
            } else {
              const gap = t < 0 ? -t : t - pl;
              if (gap > 12 || Math.abs(ct) < 0.05) continue;
              // Buffer stops stand ≈1.5 m inside the platform end; trains stop short of them.
              const d = gap / Math.abs(ct) + 0.5;
              if ((t < 0) === (ct > 0)) right = Math.min(right, d);
              else left = Math.min(left, d);
            }
          }
        }
      }
      if (left < 8 || right < 8) e.room = [Math.max(0, Math.min(8, left)), Math.max(0, Math.min(8, right))];
    }
  }

  /**
   * The platform slab a node stands on (same height, inside its outline), if any: the platform
   * record itself or, on a section of it, that section as a record of its own.
   */
  private platformUnder(n: NetNode): Platform | undefined {
    if (n.platformId) return this.platforms.find((p) => p.id === n.platformId);
    if (this.pieceCache?.n !== this.platforms.length) this.pieceCache = { n: this.platforms.length, pieces: this.platforms.flatMap(platformPieces) };
    return this.pieceCache.pieces.find((p) => {
      if (Math.abs(p.y - n.y) > 0.6) return false;
      const ax = p.b[0] - p.a[0];
      const az = p.b[1] - p.a[1];
      const al = Math.hypot(ax, az) || 1;
      const t = ((n.x - p.a[0]) * ax + (n.z - p.a[1]) * az) / al;
      const lat = Math.abs(((n.x - p.a[0]) * az - (n.z - p.a[1]) * ax) / al);
      return t >= -2 && t <= al + 2 && lat <= p.width / 2 + 0.5;
    });
  }

  private pieceCache: { n: number; pieces: Platform[] } | null = null;

  /** Adds a platform with boarding nodes along it, chained by platform edges. Returns node ids by key. */
  platform(s: PlatformSpec): Record<string, string> {
    const a = toXZ(s.a);
    const b = toXZ(s.b);
    const y = s.y ?? this.levelY(s.level);
    this.platforms.push({
      id: s.id,
      stationId: s.station,
      nameJa: s.nameJa,
      lineIds: s.lines,
      directions: s.directions,
      level: s.level,
      a: [Math.round(a.x * 10) / 10, Math.round(a.z * 10) / 10],
      b: [Math.round(b.x * 10) / 10, Math.round(b.z * 10) / 10],
      y,
      width: s.width,
      ...(s.sections?.length
        ? {
            sections: s.sections.map((q) => {
              const qa = toXZ(q.a);
              const qb = toXZ(q.b);
              return { a: [Math.round(qa.x * 10) / 10, Math.round(qa.z * 10) / 10] as [number, number], b: [Math.round(qb.x * 10) / 10, Math.round(qb.z * 10) / 10] as [number, number], width: q.width };
            }),
          }
        : {}),
    });
    const out: Record<string, string> = {};
    const stops = [...s.stops].sort((p, q) => p.t - q.t);
    for (const st of stops) {
      const id = `${s.id}@${st.key}`;
      this.node(id, 'platform', `${s.nameJa} ${st.name}`, lerp(a, b, st.t), s.level, { station: s.station, paid: true, y });
      this.get(id).platformId = s.id;
      out[st.key] = id;
    }
    for (let i = 0; i < stops.length - 1; i++) {
      this.edge('platform', out[stops[i].key], out[stops[i + 1].key], { busy: s.busy ?? 1, width: s.width * 0.6 });
    }
    return out;
  }

  footprint(f: Omit<Footprint, 'poly'> & { poly: Pos[] }): this {
    this.footprints.push({ ...f, poly: f.poly.map((p) => {
      const q = toXZ(p);
      return [Math.round(q.x), Math.round(q.z)] as [number, number];
    }) });
    return this;
  }

  /** Rectangle footprint from centre, size and rotation (bearing of the long side). */
  rect(id: string, nameJa: string, center: Pos, long: number, short: number, bearing: number, y0: number, y1: number, kind: Footprint['kind']): this {
    const c = toXZ(center);
    const r = (bearing * Math.PI) / 180;
    const ux = Math.sin(r);
    const uz = -Math.cos(r);
    const vx = -uz;
    const vz = ux;
    const h = long / 2;
    const w = short / 2;
    const pts: XZ[] = [
      { x: c.x + ux * h + vx * w, z: c.z + uz * h + vz * w },
      { x: c.x + ux * h - vx * w, z: c.z + uz * h - vz * w },
      { x: c.x - ux * h - vx * w, z: c.z - uz * h - vz * w },
      { x: c.x - ux * h + vx * w, z: c.z - uz * h + vz * w },
    ];
    return this.footprint({ id, nameJa, poly: pts, y0, y1, kind });
  }

  road(id: string, nameJa: string, points: Pos[], width: number): this {
    this.roads.push({ id, nameJa, width, points: points.map((p) => {
      const q = toXZ(p);
      return [Math.round(q.x), Math.round(q.z)] as [number, number];
    }) });
    return this;
  }

  build(): Network {
    this.layoutFlights();
    this.limitRooms();
    return {
      levels: this.levels,
      lines: this.lines,
      stations: this.stations,
      platforms: this.platforms,
      nodes: this.nodes,
      edges: this.edges,
      footprints: this.footprints,
      roads: this.roads,
    };
  }
}
