import { describe, expect, it } from 'vitest';
import { buildGraph } from '../src/core/graph';
import { ESCALATOR_RUN_PER_RISE, flightRun, STAIR_LANDING_EVERY, STAIR_RUN_PER_RISE } from '../src/data/builder';
import { detour, rectFromFrame, rectsOverlap, segmentHitsRect } from '../src/data/flight-layout';
import { umeda } from '../src/data/umeda';
import { WalkSpace } from '../src/render/walk-space';

const g = buildGraph(umeda.network);
const node = (id: string) => g.nodes[g.nodeIndex.get(id)!];

describe('physical flights', () => {
  it('builds stairs at 28°, escalators at 30° and vertical lift shafts', () => {
    for (const [i, e] of g.edges.entries()) {
      const rise = Math.abs(g.rise[i]);
      const run = g.hlen[i];
      if (e.kind === 'elevator') expect(run).toBeLessThan(0.2);
      if (rise < 1.2) continue;
      if (e.kind === 'stairs') expect(Math.abs(run - rise * STAIR_RUN_PER_RISE)).toBeLessThan(0.25);
      if (e.kind === 'escalator') expect(Math.abs(run - rise * ESCALATOR_RUN_PER_RISE)).toBeLessThan(0.25);
    }
  });

  it('puts a landing at least every 4 m of rise', () => {
    for (const [i, e] of g.edges.entries()) {
      if (e.kind === 'stairs') expect(Math.abs(g.rise[i])).toBeLessThanOrEqual(STAIR_LANDING_EVERY + 1e-6);
    }
    expect(flightRun('stairs', 7.5)).toBeCloseTo(7.5 * STAIR_RUN_PER_RISE + 1.6);
  });

  it('keeps every node off the stair wells and above a floor', () => {
    const space = WalkSpace.of(g.net);
    for (const n of g.nodes) {
      if (n.landing) continue;
      // Some walking surface carries the node at its own height.
      expect(space.floorAt(n.x, n.z, n.y, 0.3, 0.3), n.id).not.toBeNull();
    }
    void node;
  });
});

describe('flight layout geometry', () => {
  const u = { x: 1, z: 0 };
  const r = rectFromFrame({ x: 0, z: 0 }, u, 0, 10, -1, 1);

  it('tests segments against oriented rectangles', () => {
    expect(segmentHitsRect(r, { x: -5, z: 0 }, { x: 15, z: 0 })).toBe(true);
    expect(segmentHitsRect(r, { x: 10, z: 0 }, { x: 12, z: 3 })).toBe(false); // leaving from the edge
    expect(segmentHitsRect(r, { x: 10, z: 0 }, { x: 5, z: 0 })).toBe(true); // entering from the edge
    expect(rectsOverlap(r, rectFromFrame({ x: 0, z: 0 }, u, 5, 6, 0.5, 3))).toBe(true);
    expect(rectsOverlap(r, rectFromFrame({ x: 0, z: 0 }, u, 11, 12, -1, 1))).toBe(false);
  });

  it('routes around a well instead of across it', () => {
    const via = detour({ x: 10, z: 0 }, { x: 2, z: 1.5 }, [rectFromFrame({ x: 0, z: 0 }, u, 0.2, 9.8, -1, 1)]);
    expect(via.length).toBeGreaterThan(0);
    const pts = [{ x: 10, z: 0 }, ...via, { x: 2, z: 1.5 }];
    for (let i = 0; i + 1 < pts.length; i++) expect(segmentHitsRect(rectFromFrame({ x: 0, z: 0 }, u, 0.2, 9.8, -1, 1), pts[i], pts[i + 1])).toBe(false);
    expect(detour({ x: 12, z: 0 }, { x: 20, z: 0 }, [r])).toEqual([]);
  });
});

describe('walk space', () => {
  const space = WalkSpace.of(g.net);

  it('opens corridor walls where another walkway crosses them', () => {
    // A wall across a whole corridor is blocked where the corridor is, open elsewhere.
    const e = g.edges.find((x) => x.kind === 'walk' && (x.width ?? 6) >= 6 && g.hlen[g.edgeIndex.get(x.id)!] > 20)!;
    const a = node(e.a);
    const b = node(e.b);
    const mx = (a.x + b.x) / 2;
    const mz = (a.z + b.z) / 2;
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const nx = -(b.z - a.z) / len;
    const nz = (b.x - a.x) / len;
    const ends = [mx - nx * 30, mz - nz * 30, mx + nx * 30, mz + nz * 30] as const;
    const blocked = space.blocked(ends[0], ends[1], ends[2], ends[3], a.y, a.y + 3);
    expect(blocked.length).toBeGreaterThan(0);
    // The corridor's own centre (t = 0.5) is inside a blocked run.
    expect(blocked.some(([t0, t1]) => t0 < 0.5 && t1 > 0.5)).toBe(true);
    // Far above the corridor (another level) nothing is blocked by it.
    expect(space.blocked(ends[0], ends[1], ends[2], ends[3], a.y + 30, a.y + 33, (p) => p.id !== e.id)).toEqual([]);
  });
});
