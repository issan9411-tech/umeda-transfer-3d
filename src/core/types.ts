/**
 * Core data model of the Umeda pedestrian network.
 *
 * Coordinates are local metres: x = east, y = up (0 = street level), z = south.
 * (z points south so that north is "into the screen" for a default three.js camera.)
 */

export interface Level {
  id: string;
  /** Label shown in the UI, e.g. "地下1階". */
  nameJa: string;
  /** Elevation in metres relative to street level. */
  y: number;
}

export type NodeKind =
  | 'platform' // a boarding position on a platform
  | 'gate' // a fare gate (改札) line
  | 'junction' // corridor intersection / plaza
  | 'entrance' // street-level access point or building entrance
  | 'vertical'; // landing of stairs / escalators / elevators

export interface NetNode {
  id: string;
  kind: NodeKind;
  name: string;
  x: number;
  y: number;
  z: number;
  level: string;
  stationId?: string;
  platformId?: string;
  /** True when the node is inside the fare-paid area of `stationId`. */
  paid?: boolean;
  /** Show a text label in the 3D view. */
  label?: boolean;
  /** Intermediate stair landing between two levels (its y lies between them). */
  landing?: boolean;
}

export type EdgeKind =
  | 'walk' // level (or gently sloped) walkway
  | 'platform' // walking along a platform
  | 'stairs'
  | 'escalator'
  | 'elevator'
  | 'gate' // passing through fare gates
  | 'crossing'; // signalised street crossing

export interface NetEdge {
  id: string;
  a: string;
  b: string;
  kind: EdgeKind;
  /** Corridor / facility name used in turn-by-turn instructions. */
  name?: string;
  /** Horizontal length override in metres (default: straight-line distance between nodes). */
  length?: number;
  /** Weather protected. */
  indoor: boolean;
  /** Direction restriction for escalators: 'up' = only from lower to higher node. */
  dir?: 'up' | 'down' | 'both';
  /** Effective walkable width in metres, used for crowd density. */
  width?: number;
  /** Relative peak-hour pedestrian load, 0 (quiet) … 3 (packed). */
  busy?: number;
  /** Fixed waiting time in seconds (signal cycles, elevator waits). */
  waitS?: number;
  /**
   * How far people may stray from the centre line to the left / right when walking a→b (metres),
   * where a stair well or lift shaft beside the walkway limits it (set by the builder).
   */
  room?: [number, number];
}

export interface Line {
  id: string;
  nameJa: string;
  nameEn: string;
  operator: string;
  color: string;
}

export interface Platform {
  id: string;
  stationId: string;
  /** e.g. "1・2番のりば" */
  nameJa: string;
  lineIds: string[];
  /** Directions / destinations served, e.g. "京都・高槻方面". */
  directions: string;
  level: string;
  /** Platform centreline end points (local metres). */
  a: [number, number];
  b: [number, number];
  y: number;
  width: number;
  /**
   * Further slab pieces of the same platform where it narrows or shifts sideways (JR大阪駅's
   * screened walkways towards 西口): part of the platform people walk on, with no boarding
   * positions and no tracks of their own.
   */
  sections?: PlatformSection[];
}

export interface PlatformSection {
  a: [number, number];
  b: [number, number];
  width: number;
}

/**
 * Every slab piece of a platform as a platform record of its own (the body first, then its
 * sections, which carry the parent's id): for code that only needs where people can stand.
 */
export function platformPieces(p: Platform): Platform[] {
  if (!p.sections?.length) return [p];
  return [p, ...p.sections.map((s) => ({ ...p, a: s.a, b: s.b, width: s.width, sections: undefined }))];
}

export interface Station {
  id: string;
  nameJa: string;
  nameEn: string;
  operator: string;
  lineIds: string[];
  /** Short badge text, e.g. "JR", "阪急", "M16". */
  badge: string;
  /** Short display name for compact tables, e.g. "東梅田". */
  short: string;
  color: string;
  /** Label anchor for the 3D view. */
  anchor: [number, number, number];
  /** One-line description of the station's structure. */
  note: string;
  /**
   * Stations sharing a fare zone have connected paid areas (e.g. JR大阪 and its うめきたエリア).
   * Defaults to the station id.
   */
  fareZone?: string;
}

export interface Footprint {
  id: string;
  nameJa: string;
  /** Polygon (x, z) in local metres. */
  poly: [number, number][];
  /** Bottom and top elevation of the block. */
  y0: number;
  y1: number;
  kind: 'station' | 'building' | 'mall' | 'deck';
  /** Inner rings (courtyards), clockwise when `poly` is counter-clockwise. */
  holes?: [number, number][][];
  /**
   * Massing of mapped buildings (OSM building:part), real metres: when present these replace
   * the outline for the 3D volume; the outline still marks the plot.
   */
  parts?: FootprintPart[];
  /** Height not in the source data (no height or storey count): estimated. */
  estimated?: boolean;
  /** Where the outline comes from, e.g. 'osm' (OpenStreetMap via Overture Maps). */
  source?: string;
  /** Mapped building use (OSM building class), e.g. 'commercial', 'residential', 'roof' (a canopy). */
  use?: string;
  /** A helicopter landing pad is mapped on the roof. */
  helipad?: boolean;
}

export interface FootprintPart {
  poly: [number, number][];
  holes?: [number, number][][];
  /** Bottom and top elevation (real metres). */
  y0: number;
  y1: number;
  estimated?: boolean;
}

export type RoadClass = 'motorway' | 'trunk' | 'primary' | 'secondary' | 'tertiary' | 'unclassified' | 'residential' | 'service';

export interface Road {
  id: string;
  nameJa: string;
  points: [number, number][];
  /** Carriageway width (kerb to kerb). */
  width: number;
  /** Road class (OSM highway=*); hand-placed roads leave it out. */
  cls?: RoadClass;
  /** One-way carriageway: traffic runs from the first point to the last. */
  oneway?: boolean;
  /** Mapped crosswalks on this carriageway: [x0, z0, x1, z1, width] (the walking line, kerb to kerb). */
  crosswalks?: [number, number, number, number, number][];
  /** Buses and taxis wait along it (bus terminal / taxi rank). */
  terminal?: boolean;
  /** Where the centreline comes from, e.g. 'osm'. */
  source?: string;
  /**
   * An elevated carriageway (expressway, viaduct, flyover), not a street: the deck's top at each
   * point, real metres above the street (ramps come down to 0 where they meet a street).
   */
  deck?: number[];
}

export interface Network {
  levels: Level[];
  lines: Line[];
  stations: Station[];
  platforms: Platform[];
  nodes: NetNode[];
  edges: NetEdge[];
  footprints: Footprint[];
  roads: Road[];
}
