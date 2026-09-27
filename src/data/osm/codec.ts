import type { Footprint, FootprintPart, Road, RoadClass } from '../../core/types';

/**
 * Decoder for the packed OpenStreetMap context (buildings.ts / roads.ts, written by
 * tools/overture/gen_osm.py): unsigned and zig-zag varints, 5 payload bits per base64url
 * character (bit 5 = more to come); points are decimetres, delta-coded against the previous
 * point of the same stream.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const VALUE = new Int8Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) VALUE[ALPHABET.charCodeAt(i)] = i;

export class Reader {
  private i = 0;
  private cx = 0;
  private cz = 0;

  constructor(private readonly s: string) {}

  get done(): boolean {
    return this.i >= this.s.length;
  }

  u(): number {
    let out = 0;
    let mul = 1;
    for (;;) {
      if (this.i >= this.s.length) throw new Error('osm data: truncated');
      const v = VALUE[this.s.charCodeAt(this.i++)];
      if (v < 0) throw new Error('osm data: bad character');
      out += (v & 31) * mul;
      mul *= 32;
      if (!(v & 32)) return out;
    }
  }

  s32(): number {
    const n = this.u();
    return n % 2 ? -(n + 1) / 2 : n / 2;
  }

  /** Next point (metres). */
  pt(): [number, number] {
    this.cx += this.s32();
    this.cz += this.s32();
    return [this.cx / 10, this.cz / 10];
  }
}

const BUILDING_USE = ['', 'commercial', 'residential', 'parking', 'religious', 'public', 'industrial', 'station', 'roof'];
const ROAD_CLASSES: RoadClass[] = ['trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'service'];

export interface OsmContext {
  /** Every mapped building (kind 'building', real heights, id `osm:<n>`). */
  buildings: Footprint[];
  /** The two station buildings context.ts keeps under their own ids. */
  hankyu: Footprint | null;
  hanshin: Footprint | null;
  roads: Road[];
}

function rings(r: Reader): { poly: [number, number][]; holes?: [number, number][][] } {
  const n = r.u();
  const out: [number, number][][] = [];
  for (let k = 0; k < n; k++) {
    const m = r.u();
    const ring: [number, number][] = [];
    for (let i = 0; i < m; i++) ring.push(r.pt());
    out.push(ring);
  }
  return out.length > 1 ? { poly: out[0], holes: out.slice(1) } : { poly: out[0] };
}

export function decodeBuildings(data: string, names: string[]): Pick<OsmContext, 'buildings' | 'hankyu' | 'hanshin'> {
  const r = new Reader(data);
  const n = r.u();
  const buildings: Footprint[] = [];
  let hankyu: Footprint | null = null;
  let hanshin: Footprint | null = null;
  for (let b = 0; b < n; b++) {
    const flags = r.u();
    const use = BUILDING_USE[r.u()] ?? '';
    const name = flags & 4 ? names[r.u()] : '';
    const y0 = r.u() / 2;
    const y1 = r.u() / 2;
    const f: Footprint = { id: `osm:${b}`, nameJa: name, ...rings(r), y0, y1, kind: 'building', source: 'osm' };
    if (use) f.use = use;
    if (flags & 1) f.estimated = true;
    if (flags & 64) f.helipad = true;
    if (flags & 8) {
      const np = r.u();
      const parts: FootprintPart[] = [];
      for (let k = 0; k < np; k++) {
        const est = r.u() & 1;
        const p0 = r.u() / 2;
        const p1 = r.u() / 2;
        const part: FootprintPart = { ...rings(r), y0: p0, y1: p1 };
        if (est) part.estimated = true;
        parts.push(part);
      }
      f.parts = parts;
    }
    const role = (flags >> 4) & 3;
    if (role === 1) hankyu = f;
    else if (role === 2) hanshin = f;
    else buildings.push(f);
  }
  if (!r.done) throw new Error('osm buildings: trailing data');
  return { buildings, hankyu, hanshin };
}

const DECK_CLASSES: RoadClass[] = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential'];

/** Elevated carriageways (roads.ts VIADUCT_DATA): Road records with a deck height per point. */
export function decodeViaducts(data: string, names: string[]): Road[] {
  const r = new Reader(data);
  const n = r.u();
  const out: Road[] = [];
  for (let k = 0; k < n; k++) {
    const cls = DECK_CLASSES[r.u()];
    const flags = r.u();
    const name = flags & 2 ? names[r.u()] : '';
    const width = r.u() / 4;
    const np = r.u();
    const points: [number, number][] = [];
    const deck: number[] = [];
    for (let i = 0; i < np; i++) {
      points.push(r.pt());
      deck.push(r.u() / 10);
    }
    const road: Road = { id: `osm-deck:${k}`, nameJa: name, points, width, cls, source: 'osm', deck };
    if (flags & 1) road.oneway = true;
    out.push(road);
  }
  if (!r.done) throw new Error('osm viaducts: trailing data');
  return out;
}

export function decodeRoads(data: string, names: string[]): Road[] {
  const r = new Reader(data);
  const n = r.u();
  const roads: Road[] = [];
  for (let k = 0; k < n; k++) {
    const cls = ROAD_CLASSES[r.u()];
    const flags = r.u();
    const name = flags & 2 ? names[r.u()] : '';
    const width = r.u() / 4;
    const np = r.u();
    const points: [number, number][] = [];
    for (let i = 0; i < np; i++) points.push(r.pt());
    const nc = r.u();
    const road: Road = { id: `osm-road:${k}`, nameJa: name, points, width, cls, source: 'osm' };
    if (flags & 1) road.oneway = true;
    if (flags & 4) road.terminal = true;
    if (nc) {
      road.crosswalks = [];
      for (let i = 0; i < nc; i++) {
        const [x0, z0] = r.pt();
        const [x1, z1] = r.pt();
        road.crosswalks.push([x0, z0, x1, z1, r.u() / 2]);
      }
    }
    roads.push(road);
  }
  if (!r.done) throw new Error('osm roads: trailing data');
  return roads;
}
