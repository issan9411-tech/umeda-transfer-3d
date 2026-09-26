import { describe, expect, it } from 'vitest';
import { buildGraph, nodeIdx } from '../src/core/graph';
import { validateNetwork } from '../src/core/validate';
import { CrowdSim } from '../src/sim/crowd';
import { sampleKeyframes } from '../src/core/keyframes';
import { fixtureNetwork } from './fixture';

describe('crowd simulation', () => {
  const g = buildGraph(fixtureNetwork());
  const endpoints = [
    { node: nodeIdx(g, 'pa1'), weight: 1, stationId: 'A' },
    { node: nodeIdx(g, 'pa3'), weight: 1, stationId: 'A' },
    { node: nodeIdx(g, 'pb2'), weight: 1, stationId: 'B' },
  ];

  it('spawns agents at peak, keeps them on the network and measures density', () => {
    const sim = new CrowdSim(g, endpoints, new Map([['A', 0xff0000], ['B', 0x0000ff]]), { peakInflow: 200, peoplePerAgent: 5 });
    sim.hour = 8.5;
    for (let i = 0; i < 600; i++) sim.step(1);
    expect(sim.count).toBeGreaterThan(10);
    expect(sim.completed).toBeGreaterThan(0);
    const maxX = Math.max(...g.nodes.map((n) => n.x));
    for (let i = 0; i < sim.count; i++) {
      const x = sim.positions[i * 3];
      expect(x).toBeGreaterThanOrEqual(-1);
      expect(x).toBeLessThanOrEqual(maxX + 1);
    }
    expect(Math.max(...sim.density)).toBeGreaterThan(0);
  });

  it('is quiet at night and deterministic for a seed', () => {
    const run = () => {
      const sim = new CrowdSim(g, endpoints, new Map(), { seed: 3 });
      sim.hour = 3;
      for (let i = 0; i < 100; i++) sim.step(1);
      return sim.count;
    };
    expect(run()).toBe(run());
    expect(run()).toBeLessThan(5);
  });
});

describe('crowd simulation: motion outputs for animated figures', () => {
  const g = buildGraph(fixtureNetwork());
  const endpoints = [
    { node: nodeIdx(g, 'pa1'), weight: 1, stationId: 'A' },
    { node: nodeIdx(g, 'pa3'), weight: 1, stationId: 'A' },
    { node: nodeIdx(g, 'pb2'), weight: 1, stationId: 'B' },
  ];

  it('reports finite headings, plausible walking speeds, stable unique ids and lanes', () => {
    const sim = new CrowdSim(g, endpoints, new Map(), { peakInflow: 200, peoplePerAgent: 5 });
    sim.hour = 8.5;
    for (let i = 0; i < 200; i++) sim.step(1);
    const snapshot = new Map<number, number>();
    for (let i = 0; i < sim.count; i++) {
      expect(Number.isFinite(sim.headings[i])).toBe(true);
      expect(sim.speeds[i]).toBeGreaterThanOrEqual(0);
      expect(sim.speeds[i]).toBeLessThan(3);
      expect([-1, 0, 1]).toContain(sim.climbs[i]);
      expect(Math.abs(sim.lateral[i])).toBeLessThanOrEqual(8);
      const kind = g.edges[sim.edgeOf[i]].kind;
      if (kind === 'escalator' || kind === 'elevator') expect(sim.speeds[i]).toBe(0);
      if (kind !== 'stairs') expect(sim.climbs[i]).toBe(0);
      if (kind === 'stairs' || kind === 'escalator' || kind === 'elevator') expect(sim.lateral[i]).toBe(0);
      snapshot.set(sim.ids[i], sim.positions[i * 3]);
    }
    expect(snapshot.size).toBe(sim.count); // unique
    expect(Math.max(...sim.speeds.subarray(0, sim.count))).toBeGreaterThan(0.5);
    // Ids follow their agent when the arrays are compacted.
    sim.step(0.2);
    let kept = 0;
    for (let i = 0; i < sim.count; i++) {
      const before = snapshot.get(sim.ids[i]);
      if (before === undefined) continue;
      kept++;
      expect(Math.abs(sim.positions[i * 3] - before)).toBeLessThan(2);
    }
    expect(kept).toBeGreaterThan(sim.count * 0.8);
  });
});

describe('network validation', () => {
  it('accepts the fixture', () => {
    expect(validateNetwork(buildGraph(fixtureNetwork()))).toEqual([]);
  });

  it('flags a walkway that bypasses the fare gate', () => {
    const net = fixtureNetwork();
    net.edges.push({ id: 'leak', a: 'a_con1', b: 'j1', kind: 'walk', indoor: true });
    const problems = validateNetwork(buildGraph(net));
    expect(problems.some((p) => p.includes('crosses the fare line'))).toBe(true);
  });
});

describe('keyframe sampling', () => {
  it('interpolates and clamps', () => {
    const kf = [
      { x: 0, y: 0, z: 0, t: 0 },
      { x: 10, y: 0, z: 0, t: 10 },
      { x: 10, y: 6, z: 0, t: 20 },
    ];
    expect(sampleKeyframes(kf, -5).x).toBe(0);
    expect(sampleKeyframes(kf, 5).x).toBeCloseTo(5);
    expect(sampleKeyframes(kf, 15).y).toBeCloseTo(3);
    expect(sampleKeyframes(kf, 99).y).toBe(6);
  });
});
