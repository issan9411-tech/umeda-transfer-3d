import { it } from 'vitest';
import { buildCostModel, DEFAULT_OPTIONS } from '../src/core/cost';
import { buildGraph, nodeIdx, transferBans } from '../src/core/graph';
import { shortestPath } from '../src/core/search';
import { umeda } from '../src/data/umeda';
it('route', () => {
  const g = buildGraph(umeda.network);
  const model = buildCostModel(g, { ...DEFAULT_OPTIONS, congestion: false, hour: 11 });
  const [a, b, f, t] = (process.env.R ?? 'jr_nishi_in,uk_gate_in,jr,umekita').split(',');
  const p = shortestPath(g, model, [nodeIdx(g, a)], [nodeIdx(g, b)], transferBans(g, f, t))!;
  let tot = 0;
  for (const s of p.steps) {
    const e = g.edges[s.edge];
    const tm = (model.time as any)[s.edge * 2 + (s.dir === 1 ? 0 : 1)] ?? 0;
    tot += tm;
    const na = g.nodes[s.from], nb = g.nodes[s.to];
    console.log(e.kind.padEnd(9), (tm as number).toFixed(1).padStart(6), Math.hypot(nb.x - na.x, nb.z - na.z).toFixed(1).padStart(6), `${na.y}->${nb.y}`, e.id.slice(0, 70));
  }
  console.log('total', (tot / 60).toFixed(2));
});
