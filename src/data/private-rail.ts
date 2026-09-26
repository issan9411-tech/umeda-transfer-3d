import { NetBuilder, offset, type LatLon } from './builder';

/**
 * 阪急大阪梅田 (elevated terminus, 3F) and 阪神大阪梅田 (underground terminus, B1).
 */

const HK3 = 11; // 3F platforms / 3階改札 (≈ +10–11 m)
const HK2 = 5.5; // 2階中央改札・茶屋町口

export function addHankyu(b: NetBuilder): void {
  const st = 'hankyu';
  // Line groups from east to west: 京都線 (1–3号線), 宝塚線 (4–6号線), 神戸線 (7–9号線).
  const groups: { id: string; nameJa: string; line: string; dir: string; S: LatLon; N: LatLon }[] = [
    { id: 'hk-kyoto', nameJa: '1〜3号線', line: 'hankyu-kyoto', dir: '京都線（十三・淡路・高槻市・京都河原町）', S: [34.7051, 135.4991], N: [34.7071, 135.4987] },
    { id: 'hk-takarazuka', nameJa: '4〜6号線', line: 'hankyu-takarazuka', dir: '宝塚線（十三・石橋阪大前・宝塚／箕面）', S: [34.7051, 135.4986], N: [34.7071, 135.4982] },
    { id: 'hk-kobe', nameJa: '7〜9号線', line: 'hankyu-kobe', dir: '神戸線（十三・西宮北口・神戸三宮）', S: [34.7051, 135.4981], N: [34.7071, 135.4977] },
  ];
  const stops: Record<string, Record<string, string>> = {};
  for (const gr of groups) {
    stops[gr.id] = b.platform({
      id: gr.id,
      station: st,
      nameJa: gr.nameJa,
      lines: [gr.line],
      directions: gr.dir,
      level: '3F',
      y: HK3,
      a: gr.S,
      b: gr.N,
      width: 30,
      busy: 3,
      stops: [
        // Stop positions moved ≈14 m north in 2026, so the first car stops a little away from the gate.
        { key: 's', t: 0.12, name: '南端（3階改札口寄り・先頭車）' },
        { key: 'm', t: 0.5, name: '中ほど（2階中央改札口への階段付近）' },
        { key: 'n', t: 0.88, name: '北端（茶屋町口寄り・最後尾）' },
      ],
    });
  }

  // 3F: platform heads join a step-free in-gate concourse, then the 43-machine gate line.
  const heads: string[] = [];
  for (const gr of groups) {
    const id = `hk_head_${gr.id}`;
    b.node(id, 'junction', `3階 ${gr.nameJa}ホーム端`, offset(gr.S, 190, 6), '3F', { station: st, paid: true, y: HK3 });
    b.walk(stops[gr.id].s, id, { busy: 3, width: 25 });
    heads.push(id);
  }
  b.path([heads[0], heads[1], heads[2]], { name: '3階改札内コンコース', busy: 3, width: 25 });
  b.node('hk_3f_in', 'gate', '阪急 3階改札口', [34.70495, 135.49855], '3F', { station: st, paid: true, label: true, y: HK3 });
  for (const h of heads) b.walk(h, 'hk_3f_in', { busy: 3, width: 25 });
  b.node('hk_3f_out', 'junction', '3階改札前コンコース', [34.70472, 135.4985], '3F', { station: st, y: HK3 });
  b.gate('hk_3f_in', 'hk_3f_out', '阪急 3階改札口', { busy: 3, width: 40 });

  // Grand staircase / escalator bank down to 1F (紀伊國屋・BIGMAN前), plus elevators.
  b.node('hk_1f_foot', 'vertical', '阪急 3階改札前エスカレーター下（BIGMAN前）', [34.70445, 135.4984], '1F', { station: st, label: true });
  b.vertical('hk_3f_out', 'hk_1f_foot', ['stairs', 'esc', 'elev'], { name: '3階改札前 大階段・エスカレーター', busy: 3, width: 12 });
  b.node('hk_tb_ev1', 'vertical', '阪急ターミナルビル エレベーター（1階）', [34.7049, 135.4977], '1F', { station: st });
  b.node('hk_tb_ev3', 'vertical', '阪急ターミナルビル エレベーター（3階）', [34.70488, 135.49772], '3F', { station: st, y: HK3 });
  b.walk('hk_3f_out', 'hk_tb_ev3', { name: '3階コンコース' });
  b.elev('hk_tb_ev3', 'hk_tb_ev1', { name: '阪急ターミナルビル エレベーター' });
  b.walk('hk_tb_ev1', 'hk_1f_foot', { name: '阪急17番街前' });

  // 2F 中央改札口: stairs/escalators from mid-platform.
  const mids: string[] = [];
  for (const gr of groups) {
    const id = `hk_2f_${gr.id}`;
    b.node(id, 'vertical', `2階中央改札内（${gr.nameJa}への階段下）`, offset(gr.S, 350, 105), '2F', { station: st, paid: true, y: HK2 });
    b.vertical(stops[gr.id].m, id, ['stairs', 'esc'], { busy: 2 });
    mids.push(id);
  }
  b.path(mids, { name: '2階中央改札内コンコース', busy: 2, width: 15 });
  b.node('hk_2f_in', 'gate', '阪急 2階中央改札口', [34.7058, 135.49845], '2F', { station: st, paid: true, label: true, y: HK2 });
  b.walk(mids[1], 'hk_2f_in', { busy: 2 });
  b.node('hk_2f_out', 'junction', '2階中央改札前（NORIBA10前）', [34.70562, 135.4983], '2F', { station: st, y: HK2 });
  b.gate('hk_2f_in', 'hk_2f_out', '阪急 2階中央改札口', { busy: 2, width: 25 });
  b.node('hk_1f_sanbangai', 'junction', '阪急三番街 1階（大階段下）', [34.7055, 135.4982], '1F', { station: st });
  b.stairs('hk_2f_out', 'hk_1f_sanbangai', { name: '2階中央改札前 大階段', width: 10 });
  b.esc('hk_2f_out', 'hk_1f_sanbangai', 'both', { name: '三番街エスカレーター' });

  // 茶屋町口 (north, 2F): stairs from the north ends; no elevator yet (under construction 2026).
  const norths: string[] = [];
  for (const gr of groups) {
    const id = `hk_ch_${gr.id}`;
    b.node(id, 'vertical', `茶屋町口改札内（${gr.nameJa}北端の階段下）`, offset(gr.N, 170, 8), '2F', { station: st, paid: true, y: HK2 });
    b.stairs(stops[gr.id].n, id);
    norths.push(id);
  }
  b.path(norths, { name: '茶屋町口改札内通路' });
  b.node('hk_ch_in', 'gate', '阪急 茶屋町口改札口', [34.70685, 135.4991], '2F', { station: st, paid: true, label: true, y: HK2 });
  b.walk(norths[0], 'hk_ch_in');
  b.node('hk_ch_out', 'junction', '茶屋町口改札前', [34.70688, 135.49935], '2F', { station: st, y: HK2 });
  b.gate('hk_ch_in', 'hk_ch_out', '阪急 茶屋町口改札口', { busy: 1 });
  b.node('hk_chaya_1f', 'entrance', '茶屋町（NU茶屋町・ロフト方面）', [34.707, 135.4997], '1F', { label: true });
  b.stairs('hk_ch_out', 'hk_chaya_1f', { indoor: false });
  b.esc('hk_ch_out', 'hk_chaya_1f', 'both', { indoor: false });
}

// ------------------------------------------------------------------------------------------------

const HS_PLAT = -7;
const HS_CONC = -6;

export function addHanshin(b: NetBuilder): void {
  const st = 'hanshin';
  // Terminal under 阪神梅田本店; tracks head east, trains leave westward (bearing ≈ 277°).
  const W: LatLon = [34.70105, 135.4963];
  const E: LatLon = [34.7009, 135.4978];
  const plats = [
    { id: 'hs-1-2', nameJa: '1・2番線', side: 9 },
    { id: 'hs-3-5', nameJa: '3〜5番線', side: -9 },
  ];
  const stops: Record<string, Record<string, string>> = {};
  for (const p of plats) {
    stops[p.id] = b.platform({
      id: p.id,
      station: st,
      nameJa: p.nameJa,
      lines: ['hanshin'],
      directions: '阪神本線（尼崎・甲子園・神戸三宮方面）',
      level: 'B1',
      y: HS_PLAT,
      a: offset(W, 7, p.side),
      b: offset(E, 7, p.side),
      width: 12,
      busy: 2,
      stops: [
        { key: 'w', t: 0.1, name: '西端（西改札寄り・最後尾）' },
        { key: 'm', t: 0.5, name: '中ほど（中央改札付近）' },
        { key: 'e', t: 0.92, name: '東端（東改札寄り・先頭車）' },
      ],
    });
  }
  // East head concourse (in-gate), linking both platforms.
  b.node('hs_head', 'junction', '阪神 東改札内コンコース', offset(E, 97, 8), 'B1', { station: st, paid: true, y: HS_CONC });
  for (const p of plats) b.walk(stops[p.id].e, 'hs_head', { busy: 2, width: 15 });
  b.node('hs_e_in', 'gate', '阪神 東改札', [34.7009, 135.49805], 'B1', { station: st, paid: true, label: true, y: HS_CONC });
  b.walk('hs_head', 'hs_e_in');
  b.node('hs_e_out', 'junction', '阪神 東改札前', [34.70092, 135.4983], 'B1', { station: st, y: HS_CONC });
  b.gate('hs_e_in', 'hs_e_out', '阪神 東改札', { busy: 3, width: 20 });

  // Middle gate on the south side (toward ディアモール円形広場).
  b.node('hs_c_conc', 'junction', '阪神 中央改札内', [34.70062, 135.4970], 'B1', { station: st, paid: true, y: HS_CONC });
  b.walk(stops['hs-3-5'].m, 'hs_c_conc');
  b.node('hs_c_in', 'gate', '阪神 中央改札', [34.70045, 135.497], 'B1', { station: st, paid: true, label: true, y: HS_CONC });
  b.walk('hs_c_conc', 'hs_c_in');
  b.node('hs_c_out', 'junction', '阪神 中央改札前', [34.70025, 135.497], 'B1', { station: st, y: HS_CONC });
  b.gate('hs_c_in', 'hs_c_out', '阪神 中央改札', { busy: 2 });
  // The north platform reaches the middle gate by an in-gate passage at the west end.
  b.walk(stops['hs-1-2'].w, stops['hs-3-5'].w, { name: '阪神 西側連絡通路' });

  // West gate.
  b.node('hs_w_in', 'gate', '阪神 西改札', [34.70108, 135.49605], 'B1', { station: st, paid: true, label: true, y: HS_CONC });
  b.walk(stops['hs-1-2'].w, 'hs_w_in');
  b.walk(stops['hs-3-5'].w, 'hs_w_in');
  b.node('hs_w_out', 'junction', '阪神 西改札前', [34.70112, 135.4958], 'B1', { station: st, y: HS_CONC });
  b.gate('hs_w_in', 'hs_w_out', '阪神 西改札', { busy: 1 });
}
