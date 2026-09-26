import { buildCostModel, type CostModel, type CostOptions } from './cost';
import { transferBans, type Graph } from './graph';
import { middleNode, platformNodes } from './planner';
import { reconstruct, shortestTree, sumArcs } from './search';

export interface MatrixCell {
  from: string;
  to: string;
  /** Fastest possible: boarding the most convenient car, to the nearest destination platform (s). */
  bestS: number;
  /** Typical: alighting mid-train, averaged over the origin station's platforms (s). */
  typicalS: number;
  /** Slowest origin platform (mid-train) to its nearest destination platform (s). */
  worstS: number;
  distM: number;
}

export interface TransferMatrix {
  stations: string[];
  cells: MatrixCell[][];
}

/**
 * Station-to-station transfer times: one shortest-path tree per origin platform and destination
 * station, O(#platforms · #stations · E log V) — a few hundred small Dijkstra runs.
 */
export function transferMatrix(g: Graph, options: CostOptions, model?: CostModel): TransferMatrix {
  const m = model ?? buildCostModel(g, options);
  const stations = g.net.stations.map((s) => s.id);
  const platformsBy = new Map(stations.map((s) => [s, g.net.platforms.filter((p) => p.stationId === s)]));
  const targetNodes = new Map(stations.map((s) => [s, (platformsBy.get(s) ?? []).flatMap((p) => platformNodes(g, p.id))]));

  const cells: MatrixCell[][] = stations.map((from) =>
    stations.map((to) => ({ from, to, bestS: NaN, typicalS: NaN, worstS: NaN, distM: NaN })),
  );

  stations.forEach((from, i) => {
    const plats = platformsBy.get(from) ?? [];
    const allBoarding = plats.flatMap((p) => platformNodes(g, p.id));
    stations.forEach((to, j) => {
      if (i === j) return;
      // Other operators' paid areas are off-limits, so each pair gets its own search space.
      const opts = transferBans(g, from, to);
      const targets = targetNodes.get(to) ?? [];
      const pick = (tree: ReturnType<typeof shortestTree>) => {
        let bt = -1;
        let bc = Infinity;
        for (const t of targets) {
          if (tree.dist[t] < bc) {
            bc = tree.dist[t];
            bt = t;
          }
        }
        if (bt < 0) return null;
        const path = reconstruct(tree, bt);
        return { time: sumArcs(m.time, path), dist: sumArcs(m.dist, path) };
      };
      const best = pick(shortestTree(g, m, allBoarding, opts));
      const mids = plats
        .map((p) => pick(shortestTree(g, m, [middleNode(g, p)], opts)))
        .filter((x): x is { time: number; dist: number } => x !== null);
      const cell = cells[i][j];
      if (best) {
        cell.bestS = best.time;
        cell.distM = best.dist;
      }
      if (mids.length) {
        cell.typicalS = mids.reduce((s, x) => s + x.time, 0) / mids.length;
        cell.worstS = Math.max(...mids.map((x) => x.time));
      }
    });
  });
  return { stations, cells };
}
