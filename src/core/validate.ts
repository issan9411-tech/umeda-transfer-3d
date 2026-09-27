import { buildCostModel, DEFAULT_OPTIONS } from './cost';
import { components, fareZoneOf, transferBans, type Graph } from './graph';
import { platformNodes } from './planner';
import { shortestTree } from './search';

/**
 * Structural checks for a hand-built network. Returns human-readable problems (empty = OK).
 * Used by the unit tests and logged at start-up.
 */
export function validateNetwork(g: Graph): string[] {
  const out: string[] = [];
  const net = g.net;
  const levelY = new Map(net.levels.map((l) => [l.id, l.y]));

  for (const n of g.nodes) {
    const y = levelY.get(n.level);
    if (y === undefined) out.push(`node ${n.id}: unknown level ${n.level}`);
    else if (!n.landing && Math.abs(y - n.y) > 4) out.push(`node ${n.id}: y=${n.y} far from level ${n.level} (${y})`);
    if (n.stationId && !net.stations.some((s) => s.id === n.stationId)) out.push(`node ${n.id}: unknown station ${n.stationId}`);
    if (n.kind === 'platform' && !net.platforms.some((p) => p.id === n.platformId)) out.push(`node ${n.id}: unknown platform ${n.platformId}`);
  }

  g.edges.forEach((e, i) => {
    const a = g.nodes[g.nodeIndex.get(e.a) as number];
    const b = g.nodes[g.nodeIndex.get(e.b) as number];
    const rise = Math.abs(g.rise[i]);
    const vertical = e.kind === 'stairs' || e.kind === 'escalator' || e.kind === 'elevator';
    // A stair landing (between two flights) is level by design.
    if (vertical && rise < 1 && !(a.landing && b.landing)) out.push(`edge ${e.id}: ${e.kind} with no height change`);
    if (!vertical && e.kind !== 'gate' && g.hlen[i] < 0.5 && rise < 0.5) out.push(`edge ${e.id}: zero-length ${e.kind}`);
    if (!vertical && rise > 3.5) out.push(`edge ${e.id}: ${e.kind} climbs ${rise.toFixed(1)} m without stairs/escalator/elevator`);
    if (e.kind === 'gate') {
      if (!!a.paid === !!b.paid) out.push(`edge ${e.id}: gate must join paid and unpaid areas`);
    } else if (!!a.paid !== !!b.paid) {
      out.push(`edge ${e.id}: ${e.kind} crosses the fare line without a gate (${e.a} → ${e.b})`);
    } else if (a.paid && b.paid && a.stationId && b.stationId && fareZoneOf(g, a.stationId) !== fareZoneOf(g, b.stationId)) {
      out.push(`edge ${e.id}: joins paid areas of different stations (${a.stationId} / ${b.stationId})`);
    }
    if (g.hlen[i] > 400) out.push(`edge ${e.id}: suspiciously long (${Math.round(g.hlen[i])} m)`);
  });

  for (const p of net.platforms) {
    const ns = platformNodes(g, p.id);
    if (ns.length === 0) out.push(`platform ${p.id}: no boarding nodes`);
    for (const i of ns) {
      const n = g.nodes[i];
      const d = distToSegment(n.x, n.z, p.a, p.b);
      if (d > p.width) out.push(`platform node ${n.id}: ${d.toFixed(0)} m off platform ${p.id}`);
    }
  }

  const comps = components(g);
  if (comps.length > 1) {
    const small = comps.slice(1).map((c) => c.map((i) => g.nodes[i].id).slice(0, 4).join(','));
    out.push(`network has ${comps.length} components; e.g. ${small.join(' | ')}`);
  }

  // Every station must be reachable from every other for the standard and step-free profiles.
  for (const profile of ['standard', 'stepfree'] as const) {
    const m = buildCostModel(g, { ...DEFAULT_OPTIONS, profile, congestion: false });
    for (const from of net.stations) {
      const src = net.platforms.filter((p) => p.stationId === from.id).flatMap((p) => platformNodes(g, p.id));
      for (const p of net.platforms) {
        if (p.stationId === from.id) continue;
        const tree = shortestTree(g, m, src, transferBans(g, from.id, p.stationId));
        if (!platformNodes(g, p.id).some((i) => Number.isFinite(tree.dist[i]))) out.push(`${profile}: ${from.id} cannot reach platform ${p.id}`);
      }
    }
  }
  return out;
}

function distToSegment(x: number, z: number, a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const len2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / len2));
  return Math.hypot(x - (a[0] + t * dx), z - (a[1] + t * dz));
}
