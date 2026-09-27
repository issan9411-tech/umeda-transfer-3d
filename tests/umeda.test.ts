import { describe, expect, it } from 'vitest';
import { DEFAULT_OPTIONS } from '../src/core/cost';
import { buildGraph } from '../src/core/graph';
import { transferMatrix } from '../src/core/matrix';
import { planRoute } from '../src/core/planner';
import { validateNetwork } from '../src/core/validate';
import { JR_AXIS } from '../src/data/jr';
import { umeda } from '../src/data/umeda';
import { calibrationRows } from '../src/ui/about';

const g = buildGraph(umeda.network);

describe('Umeda network', () => {
  it('passes structural validation', () => {
    expect(validateNetwork(g)).toEqual([]);
  });

  it('has all 8 stations with platforms', () => {
    expect(umeda.network.stations.map((s) => s.id).sort()).toEqual(
      ['hankyu', 'hanshin', 'higashiumeda', 'jr', 'kitashinchi', 'nishiumeda', 'umeda', 'umekita'].sort(),
    );
    for (const s of umeda.network.stations) expect(umeda.network.platforms.some((p) => p.stationId === s.id)).toBe(true);
  });

  it('lays the JR 大屋根 along the tracks (station frame)', () => {
    const roof = umeda.network.footprints.find((f) => f.id === 'jr:roof');
    expect(roof?.poly.length).toBe(4);
    const p = roof!.poly;
    // Long side: the longer of two adjacent edges; its compass bearing, modulo 180°.
    const sides = [0, 1].map((i) => ({ dx: p[i + 1][0] - p[i][0], dz: p[i + 1][1] - p[i][1] }));
    const long = sides.reduce((a, b) => (Math.hypot(b.dx, b.dz) > Math.hypot(a.dx, a.dz) ? b : a));
    const bearing = (((Math.atan2(long.dx, -long.dz) * 180) / Math.PI) % 180 + 180) % 180;
    expect(Math.abs(bearing - (JR_AXIS % 180))).toBeLessThan(0.5);
    expect(Math.hypot(long.dx, long.dz)).toBeGreaterThan(170);
  });

  it('reference bands contain their own quoted figure', () => {
    for (const r of umeda.reference) {
      expect(r.minutes).toBeGreaterThanOrEqual(r.range[0]);
      expect(r.minutes).toBeLessThanOrEqual(r.range[1]);
    }
  });

  it('reproduces published transfer times within ±40 %', () => {
    const rows = calibrationRows(g, umeda);
    const bad = rows.filter((r) => !r.ok).map((r) => `${r.ref.from}→${r.ref.to}${r.gateToGate ? ' (gates)' : ''}: model ${r.modelMin.toFixed(1)} min, quoted ${r.ref.minutes}`);
    expect(bad).toEqual([]);
  });

  it('JR loop line platform to Umekita 23/24 matches the JR West figure (~8 min) for travellers with luggage', () => {
    const minutes = (profile: 'standard' | 'luggage') =>
      planRoute(g, {
        from: { stationId: 'jr', platformId: 'jr-1-2' },
        to: { stationId: 'umekita', platformId: 'uk-23-24' },
        options: { ...DEFAULT_OPTIONS, profile, congestion: true, hour: 11 },
        boarding: 'middle',
        alternatives: 1,
      }).routes[0].timeS / 60;
    expect(minutes('standard')).toBeGreaterThan(5.5);
    expect(minutes('standard')).toBeLessThan(8);
    expect(minutes('luggage')).toBeGreaterThan(7);
    expect(minutes('luggage')).toBeLessThan(9.5);
  });

  it('never routes through the paid area of a third station', () => {
    const plan = planRoute(g, {
      from: { stationId: 'jr', platformId: 'jr-5-6' },
      to: { stationId: 'kitashinchi' },
      options: { ...DEFAULT_OPTIONS, congestion: false },
      boarding: 'middle',
      alternatives: 3,
    });
    for (const r of plan.routes) {
      const stations = new Set(r.path.nodes.map((i) => g.nodes[i]).filter((n) => n.paid).map((n) => n.stationId));
      expect([...stations].sort()).toEqual(['jr', 'kitashinchi']);
    }
  });

  it('step-free routes use no stairs or escalators', () => {
    const plan = planRoute(g, {
      from: { stationId: 'hankyu' },
      to: { stationId: 'higashiumeda' },
      options: { ...DEFAULT_OPTIONS, profile: 'stepfree', congestion: false },
      boarding: 'best',
      alternatives: 2,
    });
    expect(plan.routes.length).toBeGreaterThan(0);
    for (const r of plan.routes) {
      expect(r.counts.stairs).toBe(0);
      expect(r.counts.escalator).toBe(0);
    }
  });

  it('every station pair has a finite transfer time for every profile', () => {
    for (const profile of ['standard', 'hurry', 'luggage', 'senior', 'stepfree'] as const) {
      const m = transferMatrix(g, { ...DEFAULT_OPTIONS, profile, congestion: false });
      m.cells.forEach((row, i) =>
        row.forEach((c, j) => {
          if (i !== j) expect(Number.isFinite(c.typicalS), `${profile} ${c.from}→${c.to}`).toBe(true);
        }),
      );
    }
  });

  it('rain mode keeps routes indoors wherever an indoor alternative exists', () => {
    const plan = planRoute(g, {
      from: { stationId: 'jr' },
      to: { stationId: 'hanshin' },
      options: { ...DEFAULT_OPTIONS, rain: true, congestion: false },
      boarding: 'best',
      alternatives: 1,
    });
    expect(plan.routes[0].outdoorM).toBe(0);
  });
});

describe('review regressions', () => {
  const opts = { ...DEFAULT_OPTIONS, congestion: false };
  const gateCrossings = (r: { path: { steps: { edge: number; from: number }[] } }) => {
    let exits = 0;
    let entries = 0;
    for (const st of r.path.steps) {
      if (g.edges[st.edge].kind !== 'gate') continue;
      if (g.nodes[st.from].paid) exits++;
      else entries++;
    }
    return { exits, entries };
  };

  it('every suggested route is fare-valid: at most one exit and one entry, none within one fare zone', () => {
    const ids = umeda.network.stations.map((s) => s.id);
    for (const hour of [8.5, 11]) {
      for (const from of ids) {
        for (const to of ids) {
          if (from === to) continue;
          const plan = planRoute(g, { from: { stationId: from }, to: { stationId: to }, options: { ...opts, congestion: true, hour }, boarding: 'best', alternatives: 3 });
          const sameZone = ['jr', 'umekita'].includes(from) && ['jr', 'umekita'].includes(to);
          for (const r of plan.routes) {
            const { exits, entries } = gateCrossings(r);
            if (sameZone) expect(exits + entries, `${from}->${to}`).toBe(0);
            else {
              expect(exits, `${from}->${to}`).toBeLessThanOrEqual(1);
              expect(entries, `${from}->${to}`).toBeLessThanOrEqual(1);
            }
          }
        }
      }
    }
  });

  it('JR platforms to うめきた stay inside the gates for every alternative', () => {
    for (const p of umeda.network.platforms.filter((x) => x.stationId === 'jr')) {
      const plan = planRoute(g, { from: { stationId: 'jr', platformId: p.id }, to: { stationId: 'umekita' }, options: opts, boarding: 'best', alternatives: 3 });
      for (const r of plan.routes) expect(r.counts.gate).toBe(0);
    }
  });

  it('distance objective keeps the stairs-avoid preference of the luggage profile', () => {
    const count = (objective: 'time' | 'distance') => {
      let n = 0;
      const ids = umeda.network.stations.map((s) => s.id);
      for (const from of ids)
        for (const to of ids) {
          if (from === to) continue;
          const r = planRoute(g, { from: { stationId: from }, to: { stationId: to }, options: { ...opts, profile: 'luggage', objective }, boarding: 'middle', alternatives: 1 }).routes[0];
          if (r.counts.stairs > 0) n++;
        }
      return n;
    };
    expect(count('distance')).toBeLessThanOrEqual(count('time') + 3);
  });

  it('vertical instructions never merge a down-and-up into a 0 m move', () => {
    for (const profile of ['standard', 'stepfree'] as const) {
      for (const p of umeda.network.platforms.filter((x) => x.stationId === 'jr')) {
        for (const q of umeda.network.platforms.filter((x) => x.stationId === 'jr' && x.id !== p.id)) {
          const plan = planRoute(g, { from: { stationId: 'jr', platformId: p.id }, to: { stationId: 'jr', platformId: q.id }, options: { ...opts, profile }, boarding: 'middle', alternatives: 3 });
          for (const r of plan.routes) for (const ins of r.instructions) expect(ins.text, `${p.id}->${q.id}`).not.toMatch(/約0m/);
        }
      }
    }
  });

  it('alternatives do not repeat the same corridors with a parallel stairs/escalator swap', () => {
    const plan = planRoute(g, { from: { stationId: 'jr', platformId: 'jr-9-10' }, to: { stationId: 'umekita', platformId: 'uk-21-22' }, options: opts, boarding: 'best', alternatives: 3 });
    const keys = plan.routes.map((r) => r.path.nodes.join(','));
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('crowd simulation on the Umeda network', () => {
  it('stays at capacity at the peak and uses escalators beside busy stairs', async () => {
    const { CrowdSim } = await import('../src/sim/crowd');
    const endpoints = g.nodes
      .map((n, i) => ({ n, i }))
      .filter(({ n }) => n.kind === 'platform' || n.kind === 'entrance')
      .map(({ n, i }) => ({ node: i, weight: 1, stationId: n.kind === 'platform' ? n.stationId : undefined }));
    const sim = new CrowdSim(g, endpoints, new Map(), { maxAgents: 600, peakInflow: 200 });
    sim.hour = 8.5;
    let escalatorSteps = 0;
    for (let i = 0; i < 1500; i++) {
      sim.step(1.5);
      for (let k = 0; k < sim.count; k++) if (g.edges[sim.edgeOf[k]].kind === 'escalator') escalatorSteps++;
      expect(sim.count).toBeLessThanOrEqual(600);
    }
    expect(sim.count).toBeGreaterThan(540);
    expect(escalatorSteps).toBeGreaterThan(1000);
  });
});
