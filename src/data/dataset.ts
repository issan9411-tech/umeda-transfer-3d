import type { Network } from '../core/types';

/** Published or commonly quoted transfer time between two stations, used to calibrate the model. */
export interface ReferenceTime {
  from: string;
  to: string;
  /** Minutes quoted by the source. */
  minutes: number;
  /** Acceptable band for the model value, in minutes (always contains `minutes`). */
  range: [number, number];
  source: string;
  /**
   * For figures measured gate to gate: the model is evaluated between these two nodes
   * instead of platform to platform.
   */
  fromNode?: string;
  toNode?: string;
}

export interface DataSource {
  title: string;
  url?: string;
  note?: string;
}

export interface DataSet {
  network: Network;
  /** Relative daily ridership per station (drives crowd simulation demand). */
  ridership: Record<string, number>;
  /** Weight of street entrances as crowd origins/destinations, relative to one station unit. */
  entranceWeight: number;
  reference: ReferenceTime[];
  sources: DataSource[];
  caveats: string[];
  /** Select values for the initial route, e.g. "platform:hankyu-kyoto". */
  defaultRoute: { from: string; to: string };
}
