import type { EdgeKind, Footprint, Level, Line, NetEdge, NetNode, Network, NodeKind, Platform, Road, Station } from '../core/types';

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

  walk(a: string, b: string, o: EdgeOpts = {}): this {
    this.edge('walk', a, b, o);
    return this;
  }

  /** Walkway through a sequence of nodes. */
  path(ids: string[], o: EdgeOpts = {}): this {
    for (let i = 0; i < ids.length - 1; i++) this.edge('walk', ids[i], ids[i + 1], o);
    return this;
  }

  stairs(a: string, b: string, o: EdgeOpts = {}): this {
    this.edge('stairs', a, b, o);
    return this;
  }

  esc(a: string, b: string, dir: 'up' | 'down' | 'both' = 'both', o: EdgeOpts = {}): this {
    this.edge('escalator', a, b, { ...o, dir });
    return this;
  }

  elev(a: string, b: string, o: EdgeOpts = {}): this {
    this.edge('elevator', a, b, o);
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
  vertical(a: string, b: string, modes: ('stairs' | 'esc' | 'esc-up' | 'esc-down' | 'elev')[], o: EdgeOpts = {}): this {
    for (const m of modes) {
      if (m === 'stairs') this.stairs(a, b, o);
      else if (m === 'esc') this.esc(a, b, 'both', o);
      else if (m === 'esc-up') this.esc(a, b, 'up', o);
      else if (m === 'esc-down') this.esc(a, b, 'down', o);
      else this.elev(a, b, o);
    }
    return this;
  }

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
