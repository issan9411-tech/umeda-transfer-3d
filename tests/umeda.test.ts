import { describe, expect, it } from 'vitest';
import { DEFAULT_OPTIONS } from '../src/core/cost';
import { buildGraph } from '../src/core/graph';
import { transferMatrix } from '../src/core/matrix';
import { planRoute } from '../src/core/planner';
import { validateNetwork } from '../src/core/validate';
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

  it('reproduces published transfer times within tolerance', () => {
    const rows = calibrationRows(g, umeda);
    const bad = rows.filter((r) => !r.ok).map((r) => `${r.ref.from}→${r.ref.to}: model ${r.typicalMin.toFixed(1)} min, expected ${r.ref.range.join('–')}`);
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
