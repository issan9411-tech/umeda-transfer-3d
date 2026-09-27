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
}

export interface Road {
  id: string;
  nameJa: string;
  points: [number, number][];
  width: number;
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
