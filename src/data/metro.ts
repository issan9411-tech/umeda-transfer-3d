import { NetBuilder, offset, type Pos, type XZ } from './builder';

/**
 * Osaka Metro: 梅田 (御堂筋線, NNW under 国道176号 between JR 御堂筋口 and 阪急うめだ本店, gates on
 * the B1 mall floor), 東梅田 (谷町線, B2) and 西梅田 (四つ橋線, B2 under 四つ橋筋).
 * Positions follow the subway lines as mapped in OpenStreetMap (via Overture Maps; local metres,
 * x = east, z = south). Sources for the layouts: osaka-transfer.com (阪急 → 北改札), the 桜橋口 →
 * ハービス guide (西梅田 北改札).
 */

/** Compass bearing from a to b (0 = north, 90 = east). */
function bearingOf(a: XZ, b: XZ): number {
  return ((Math.atan2(b.x - a.x, -(b.z - a.z)) * 180) / Math.PI + 360) % 360;
}

export function addMidosujiUmeda(b: NetBuilder): void {
  const st = 'umeda';
  // OSM: the line runs dead straight at 344° from the curve under 梅田新歩道橋 (where it swings east
  // towards 御堂筋 and 淀屋橋) north under 国道176号 past the JR viaduct. The platform (≈180 m) ends
  // at that curve in the south, by the 阪神 東口; its north end and 北改札 are under the road between
  // JR 御堂筋北口 and 阪急うめだ本店 (west of the store's B1, south of 阪急三番街), not under the store.
  const S: XZ = { x: 224.5, z: 78.0 };
  const N: XZ = { x: 174.5, z: -95.0 };
  const up = bearingOf(S, N);
  const s = b.platform({
    id: 'm-1-2',
    station: st,
    nameJa: '1・2番線',
    lines: ['midosuji'],
    directions: '1番線 なんば・天王寺・なかもず方面／2番線 新大阪・千里中央方面',
    level: 'B1',
    // Deep enough for the B1 in-gate concourses (at −6, the mall floor) to pass over the tracks
    // that continue beyond both platform ends.
    y: -9.5,
    a: S,
    b: N,
    width: 14,
    busy: 3,
    stops: [
      { key: 's', t: 0.1, name: '南寄り（南改札・阪神方面）' },
      { key: 'm', t: 0.5, name: '中ほど（中改札・JR方面）' },
      { key: 'n', t: 0.9, name: '北寄り（北改札・阪急方面）' },
    ],
  });
  /** A gate with its in-gate concourse; the stairs come up onto the concourse at `concAt`. */
  const gate = (key: string, at: Pos, outAt: Pos, concAt: Pos, name: string, stop: string, busy: number, bearingUp?: number) => {
    const inId = `m_${key}_in`;
    const conc = `m_${key}_conc`;
    // Gates and the in-gate concourse are on the same B1 floor as the malls outside them.
    b.node(conc, 'vertical', `${name}内コンコース`, concAt, 'B1', { station: st, paid: true, y: -6 });
    b.vertical(stop, conc, ['stairs', 'esc'], { busy, bearingUp, anchor: 'top' });
    b.node(inId, 'gate', `御堂筋線 ${name}`, at, 'B1', { station: st, paid: true, label: true, y: -6 });
    b.walk(conc, inId, { busy, width: 16 });
    b.node(`m_${key}_out`, 'junction', `御堂筋線 ${name}前`, outAt, 'B1', { station: st, y: -6 });
    b.gate(inId, `m_${key}_out`, `御堂筋線梅田 ${name}`, { busy, width: 20 });
  };
  // 北改札 and 南改札 lie beyond the platform ends (stairs go down facing along the platform);
  // 中改札 faces west towards JR 御堂筋南口, its stairs come up on the platform's west half.
  gate('n', offset(N, up, 10), offset(N, up, 18), offset(N, up, 2), '北改札', s.n, 3, up);
  const mid = { x: (S.x + N.x) / 2, z: (S.z + N.z) / 2 };
  gate('c', offset(mid, up - 90, 13), offset(mid, up - 90, 21), offset(mid, up - 90, 4), '中改札', s.m, 2);
  gate('s', offset(S, up + 180, 10), offset(S, up + 180, 18), offset(S, up + 180, 2), '南改札', s.s, 3, up + 180);
  // Step-free: one elevator from the middle of the platform to the 中改札 concourse.
  b.elev(s.m, 'm_c_conc', { anchor: 'top' });
}

export function addHigashiUmeda(b: NetBuilder): void {
  const st = 'higashiumeda';
  // OSM: the 谷町線 comes south from 中崎町 under the east side of 梅田 and runs SSE (163°) through
  // 東梅田 (station point ≈ 377, 211) towards 曽根崎通, where it turns east to 南森町. The island sits
  // on that straight, ≈150 m long, its north end under ホワイティうめだ.
  const Sp: XZ = { x: 397.8, z: 284.9 };
  const Np: XZ = { x: 353.9, z: 139.6 };
  const axis = bearingOf(Sp, Np);
  const s = b.platform({
    id: 't-1-2',
    station: st,
    nameJa: '1・2番線',
    lines: ['tanimachi'],
    directions: '1番線 天満橋・天王寺・八尾南方面／2番線 都島・大日方面',
    level: 'B2',
    y: -12.5,
    a: Sp,
    b: Np,
    width: 10,
    busy: 2,
    stops: [
      { key: 's', t: 0.15, name: '南寄り（南改札・駅前第4ビル方面）' },
      { key: 'm', t: 0.5, name: '中ほど' },
      { key: 'n', t: 0.85, name: '北寄り（北改札・ホワイティうめだ方面）' },
    ],
  });
  b.node('t_n_conc', 'vertical', '東梅田 北改札内', offset(Np, axis + 180, 5), 'B1', { station: st, paid: true, y: -6 });
  // B2 island: going up to the gates heads along the platform towards its ends.
  b.vertical(s.n, 't_n_conc', ['stairs', 'esc', 'elev'], { busy: 2, bearingUp: axis, anchor: 'top' });
  b.node('t_n_in', 'gate', '東梅田 北改札', offset(Np, axis, 7), 'B1', { station: st, paid: true, label: true, y: -6 });
  b.walk('t_n_conc', 't_n_in');
  b.node('t_n_out', 'junction', '東梅田 北改札前', offset(Np, axis, 17), 'B1', { station: st, y: -6 });
  b.gate('t_n_in', 't_n_out', '谷町線東梅田 北改札', { busy: 2 });

  b.node('t_s_conc', 'vertical', '東梅田 南改札内', offset(Sp, axis, 5), 'B1', { station: st, paid: true, y: -6 });
  b.vertical(s.s, 't_s_conc', ['stairs', 'esc'], { bearingUp: axis + 180, anchor: 'top' });
  b.node('t_s_in', 'gate', '東梅田 南改札', offset(Sp, axis + 180, 7), 'B1', { station: st, paid: true, label: true, y: -6 });
  b.walk('t_s_conc', 't_s_in');
  b.node('t_s_out', 'junction', '東梅田 南改札前', offset(Sp, axis + 180, 17), 'B1', { station: st, y: -6 });
  b.gate('t_s_in', 't_s_out', '谷町線東梅田 南改札', { busy: 1 });
}

export function addNishiUmeda(b: NetBuilder): void {
  const st = 'nishiumeda';
  // OSM: the 四つ橋線 terminus under 四つ橋筋; the tracks end at the north (bumpers ≈ z 259) and run
  // on south towards 肥後橋. The platform ends ≈ 70 m short of JR北新地 西改札 (sources: 1–2 min,
  // ≈100 m gate to gate).
  const N: XZ = { x: -0.6, z: 262.0 };
  const S: XZ = { x: -7.5, z: 378.0 };
  const up = bearingOf(S, N);
  const s = b.platform({
    id: 'y-1-2',
    station: st,
    nameJa: '1・2番線',
    lines: ['yotsubashi'],
    directions: '1・2番線とも 肥後橋・なんば・住之江公園方面（当駅始発）',
    level: 'B2',
    y: -12,
    a: S,
    b: N,
    width: 10,
    busy: 2,
    stops: [
      { key: 's', t: 0.12, name: '南寄り（南改札・北新地方面）' },
      { key: 'm', t: 0.5, name: '中ほど' },
      { key: 'n', t: 0.88, name: '北寄り（北改札・阪神・JR方面）' },
    ],
  });
  // Stair heads just inside the platform ends: the flights lie on the platform, not over the
  // bumpers (north) or the running tracks towards 肥後橋 (south). The gates open onto the B1
  // corridor under 四つ橋筋 (OSM) that runs over the station from ガーデンアベニュー to ドーチカ.
  b.node('y_n_conc', 'vertical', '西梅田 北改札内', offset(N, up + 180, 2), 'B1', { station: st, paid: true, y: -6 });
  b.vertical(s.n, 'y_n_conc', ['stairs', 'esc', 'elev'], { busy: 2, bearingUp: up, anchor: 'top' });
  b.node('y_n_in', 'gate', '西梅田 北改札', offset(N, up, 9), 'B1', { station: st, paid: true, label: true, y: -6 });
  b.walk('y_n_conc', 'y_n_in');
  b.node('y_n_out', 'junction', '西梅田 北改札前', offset(N, up, 18), 'B1', { station: st, y: -6 });
  b.gate('y_n_in', 'y_n_out', '四つ橋線西梅田 北改札', { busy: 2 });

  b.node('y_s_conc', 'vertical', '西梅田 南改札内', offset(S, up, 2), 'B1', { station: st, paid: true, y: -6 });
  b.vertical(s.s, 'y_s_conc', ['stairs', 'esc'], { bearingUp: up + 180, anchor: 'top' });
  b.node('y_s_in', 'gate', '西梅田 南改札', offset(S, up + 180, 12), 'B1', { station: st, paid: true, label: true, y: -6 });
  b.walk('y_s_conc', 'y_s_in');
  b.node('y_s_out', 'junction', '西梅田 南改札前', offset(S, up + 180, 21), 'B1', { station: st, y: -6 });
  b.gate('y_s_in', 'y_s_out', '四つ橋線西梅田 南改札', { busy: 1 });
}
