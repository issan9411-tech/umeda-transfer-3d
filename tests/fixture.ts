import type { NetEdge, NetNode, Network } from '../src/core/types';

/**
 * A small two-station network used by the algorithm tests.
 *
 *   Station A (platform at 2F, y=6)            Station B (platform at B1, y=-6)
 *   pa1 —— pa2 —— pa3                           pb1 —— pb2
 *          |stairs  |elevator                    |stairs  (esc down only from ga_out side)
 *   A-gate (1F) → street junctions → B-gate (B1)
 *   Two street options: an outdoor shortcut (crossing) and an indoor detour.
 */
export function fixtureNetwork(): Network {
  const n = (id: string, kind: NetNode['kind'], x: number, y: number, z: number, level: string, extra: Partial<NetNode> = {}): NetNode => ({
    id,
    kind,
    name: id,
    x,
    y,
    z,
    level,
    ...extra,
  });
  const nodes: NetNode[] = [
    n('pa1', 'platform', 0, 6, 0, '2F', { stationId: 'A', platformId: 'A1', paid: true }),
    n('pa2', 'platform', 50, 6, 0, '2F', { stationId: 'A', platformId: 'A1', paid: true }),
    n('pa3', 'platform', 100, 6, 0, '2F', { stationId: 'A', platformId: 'A1', paid: true }),
    n('a_con1', 'vertical', 50, 0, 10, '1F', { stationId: 'A', paid: true }),
    n('a_con3', 'vertical', 100, 0, 10, '1F', { stationId: 'A', paid: true }),
    n('a_gate_in', 'gate', 75, 0, 20, '1F', { stationId: 'A', paid: true }),
    n('a_gate_out', 'gate', 75, 0, 25, '1F', { stationId: 'A' }),
    n('j1', 'junction', 75, 0, 100, '1F'),
    n('j2', 'junction', 175, 0, 100, '1F'),
    n('j_in1', 'junction', 75, 0, 160, '1F'),
    n('j_in2', 'junction', 175, 0, 160, '1F'),
    n('b_top', 'vertical', 200, 0, 100, '1F'),
    n('b_gate_out', 'gate', 200, -6, 120, 'B1', { stationId: 'B' }),
    n('b_gate_in', 'gate', 200, -6, 125, 'B1', { stationId: 'B', paid: true }),
    n('pb1', 'platform', 200, -6, 140, 'B1', { stationId: 'B', platformId: 'B1', paid: true }),
    n('pb2', 'platform', 260, -6, 140, 'B1', { stationId: 'B', platformId: 'B1', paid: true }),
  ];
  const e = (id: string, a: string, b: string, kind: NetEdge['kind'], extra: Partial<NetEdge> = {}): NetEdge => ({
    id,
    a,
    b,
    kind,
    indoor: true,
    ...extra,
  });
  const edges: NetEdge[] = [
    e('pa12', 'pa1', 'pa2', 'platform'),
    e('pa23', 'pa2', 'pa3', 'platform'),
    e('st_a', 'pa2', 'a_con1', 'stairs', { length: 12 }),
    e('el_a', 'pa3', 'a_con3', 'elevator', { length: 2 }),
    e('a_c1g', 'a_con1', 'a_gate_in', 'walk'),
    e('a_c3g', 'a_con3', 'a_gate_in', 'walk'),
    e('a_gate', 'a_gate_in', 'a_gate_out', 'gate', { name: 'A改札' }),
    e('a_j1', 'a_gate_out', 'j1', 'walk'),
    e('cross', 'j1', 'j2', 'crossing', { indoor: false, name: '横断歩道', waitS: 30 }),
    e('j2_b', 'j2', 'b_top', 'walk', { indoor: false }),
    e('in1', 'j1', 'j_in1', 'walk', { name: '地下街' }),
    e('in2', 'j_in1', 'j_in2', 'walk', { name: '地下街' }),
    e('in3', 'j_in2', 'b_top', 'walk', { name: '地下街' }),
    e('b_st', 'b_top', 'b_gate_out', 'stairs', { length: 20 }),
    e('b_esc', 'b_top', 'b_gate_out', 'escalator', { length: 12, dir: 'down' }),
    e('b_el', 'b_top', 'b_gate_out', 'elevator', { length: 3 }),
    e('b_gate', 'b_gate_out', 'b_gate_in', 'gate', { name: 'B改札' }),
    e('b_gp', 'b_gate_in', 'pb1', 'walk'),
    e('pb12', 'pb1', 'pb2', 'platform'),
  ];
  return {
    levels: [
      { id: 'B1', nameJa: '地下1階', y: -6 },
      { id: '1F', nameJa: '1階', y: 0 },
      { id: '2F', nameJa: '2階', y: 6 },
    ],
    lines: [
      { id: 'LA', nameJa: 'A線', nameEn: 'A Line', operator: 'X', color: '#f00' },
      { id: 'LB', nameJa: 'B線', nameEn: 'B Line', operator: 'Y', color: '#00f' },
    ],
    stations: [
      { id: 'A', nameJa: 'A駅', nameEn: 'A', operator: 'X', lineIds: ['LA'], badge: 'A', short: 'A', color: '#f00', anchor: [50, 10, 0], note: '' },
      { id: 'B', nameJa: 'B駅', nameEn: 'B', operator: 'Y', lineIds: ['LB'], badge: 'B', short: 'B', color: '#00f', anchor: [230, 0, 140], note: '' },
    ],
    platforms: [
      { id: 'A1', stationId: 'A', nameJa: '1番', lineIds: ['LA'], directions: '', level: '2F', a: [0, 0], b: [100, 0], y: 6, width: 8 },
      { id: 'B1', stationId: 'B', nameJa: '1番', lineIds: ['LB'], directions: '', level: 'B1', a: [200, 140], b: [260, 140], y: -6, width: 8 },
    ],
    nodes,
    edges,
    footprints: [],
    roads: [],
  };
}
