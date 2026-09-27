import { NetBuilder, offset, type LatLon } from './builder';

/**
 * Osaka Metro: 梅田 (御堂筋線, NNW under 御堂筋 / 国道176号 between JR 御堂筋口 and 阪急うめだ本店,
 * gates on the B1 mall floor), 東梅田 (谷町線, B2) and 西梅田 (四つ橋線, B2 under 四つ橋筋).
 * Sources: osaka-transfer.com (阪急 → 北改札), the 桜橋口 → ハービス guide (西梅田 北改札).
 */

export function addMidosujiUmeda(b: NetBuilder): void {
  const st = 'umeda';
  // The line runs under 御堂筋 / 国道176号 (NNW, ≈354°): the north end and 北改札 sit under the
  // road between JR 御堂筋北口 and 阪急うめだ本店, not under the store.
  const S: LatLon = [34.70082, 135.49847];
  const N: LatLon = [34.7031, 135.49817];
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
  const gate = (key: string, at: LatLon, outAt: LatLon, concAt: LatLon, name: string, stop: string, busy: number, up?: number) => {
    const inId = `m_${key}_in`;
    const conc = `m_${key}_conc`;
    // Gates and the in-gate concourse are on the same B1 floor as the malls outside them.
    b.node(conc, 'vertical', `${name}内コンコース`, concAt, 'B1', { station: st, paid: true, y: -6 });
    b.vertical(stop, conc, ['stairs', 'esc'], { busy, bearingUp: up, anchor: 'top' });
    b.node(inId, 'gate', `御堂筋線 ${name}`, at, 'B1', { station: st, paid: true, label: true, y: -6 });
    b.walk(conc, inId, { busy, width: 16 });
    b.node(`m_${key}_out`, 'junction', `御堂筋線 ${name}前`, outAt, 'B1', { station: st, y: -6 });
    b.gate(inId, `m_${key}_out`, `御堂筋線梅田 ${name}`, { busy, width: 20 });
  };
  // 北改札 and 南改札 lie beyond the platform ends (stairs go down facing along the platform);
  // 中改札 faces west towards JR 御堂筋南口, its stairs come up on the platform's west half.
  gate('n', [34.703423, 135.498128], [34.703593, 135.498105], [34.703118, 135.498168], '北改札', s.n, 3, 354);
  gate('c', [34.7019, 135.49805], [34.7019, 135.4978], [34.701896, 135.498284], '中改札', s.m, 2);
  gate('s', [34.700551, 135.498505], [34.70039, 135.498527], [34.700802, 135.498472], '南改札', s.s, 3, 174);
  // Step-free: one elevator from the middle of the platform to the 中改札 concourse.
  b.elev(s.m, 'm_c_conc', { anchor: 'top' });
}

export function addHigashiUmeda(b: NetBuilder): void {
  const st = 'higashiumeda';
  const center: LatLon = [34.70015, 135.50065];
  const axis = 12;
  const s = b.platform({
    id: 't-1-2',
    station: st,
    nameJa: '1・2番線',
    lines: ['tanimachi'],
    directions: '1番線 天満橋・天王寺・八尾南方面／2番線 都島・大日方面',
    level: 'B2',
    y: -12.5,
    a: offset(center, axis + 180, 75),
    b: offset(center, axis, 75),
    width: 10,
    busy: 2,
    stops: [
      { key: 's', t: 0.15, name: '南寄り（南改札・駅前第4ビル方面）' },
      { key: 'm', t: 0.5, name: '中ほど' },
      { key: 'n', t: 0.85, name: '北寄り（北改札・ホワイティうめだ方面）' },
    ],
  });
  b.node('t_n_conc', 'vertical', '東梅田 北改札内', offset(center, axis, 70), 'B1', { station: st, paid: true, y: -6 });
  // B2 island: going up to the gates heads along the platform towards its ends.
  b.vertical(s.n, 't_n_conc', ['stairs', 'esc', 'elev'], { busy: 2, bearingUp: axis, anchor: 'top' });
  b.node('t_n_in', 'gate', '東梅田 北改札', offset(center, axis, 82), 'B1', { station: st, paid: true, label: true, y: -6 });
  b.walk('t_n_conc', 't_n_in');
  b.node('t_n_out', 'junction', '東梅田 北改札前', offset(center, axis, 94), 'B1', { station: st, y: -6 });
  b.gate('t_n_in', 't_n_out', '谷町線東梅田 北改札', { busy: 2 });

  b.node('t_s_conc', 'vertical', '東梅田 南改札内', offset(center, axis + 180, 70), 'B1', { station: st, paid: true, y: -6 });
  b.vertical(s.s, 't_s_conc', ['stairs', 'esc'], { bearingUp: axis + 180, anchor: 'top' });
  b.node('t_s_in', 'gate', '東梅田 南改札', offset(center, axis + 180, 82), 'B1', { station: st, paid: true, label: true, y: -6 });
  b.walk('t_s_conc', 't_s_in');
  b.node('t_s_out', 'junction', '東梅田 南改札前', offset(center, axis + 180, 94), 'B1', { station: st, y: -6 });
  b.gate('t_s_in', 't_s_out', '谷町線東梅田 南改札', { busy: 1 });
}

export function addNishiUmeda(b: NetBuilder): void {
  const st = 'nishiumeda';
  const N: LatLon = [34.70045, 135.49545];
  // South gate ≈70 m north of JR北新地 西改札 (sources: 1–2 min, ≈100 m gate to gate).
  const S: LatLon = [34.6994, 135.4956];
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
  // bumpers (north) or the running tracks towards 肥後橋 (south).
  b.node('y_n_conc', 'vertical', '西梅田 北改札内', [34.700432, 135.495453], 'B1', { station: st, paid: true, y: -6 });
  b.vertical(s.n, 'y_n_conc', ['stairs', 'esc', 'elev'], { busy: 2, bearingUp: 353, anchor: 'top' });
  b.node('y_n_in', 'gate', '西梅田 北改札', offset(N, 0, 22), 'B1', { station: st, paid: true, label: true, y: -6 });
  b.walk('y_n_conc', 'y_n_in');
  b.node('y_n_out', 'junction', '西梅田 北改札前', offset(N, 0, 34), 'B1', { station: st, y: -6 });
  b.gate('y_n_in', 'y_n_out', '四つ橋線西梅田 北改札', { busy: 2 });

  b.node('y_s_conc', 'vertical', '西梅田 南改札内', [34.699418, 135.495597], 'B1', { station: st, paid: true, y: -6 });
  b.vertical(s.s, 'y_s_conc', ['stairs', 'esc'], { bearingUp: 173, anchor: 'top' });
  b.node('y_s_in', 'gate', '西梅田 南改札', offset(S, 180, 16), 'B1', { station: st, paid: true, label: true, y: -6 });
  b.walk('y_s_conc', 'y_s_in');
  b.node('y_s_out', 'junction', '西梅田 南改札前', offset(S, 180, 26), 'B1', { station: st, y: -6 });
  b.gate('y_s_in', 'y_s_out', '四つ橋線西梅田 南改札', { busy: 1 });
}
