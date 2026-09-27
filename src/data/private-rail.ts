import { lerp, NetBuilder, offset, type XZ } from './builder';

/**
 * 阪急大阪梅田 (elevated terminus, 3F) and 阪神大阪梅田 (underground terminus below the B1 malls).
 *
 * Positions follow OpenStreetMap (via Overture Maps; local metres, x = east, z = south): the mapped
 * platform outlines, tracks and station buildings. The layouts themselves (which stairs go where,
 * which way they rise, which gate faces which passage) follow the station research.
 */

/** Compass bearing from a to b (0 = north, 90 = east). */
function bearingOf(a: XZ, b: XZ): number {
  return ((Math.atan2(b.x - a.x, -(b.z - a.z)) * 180) / Math.PI + 360) % 360;
}

const HK3 = 11; // 3F platforms / 3階改札 (≈ +10–11 m)
const HK2 = 5.5; // 2階中央改札・茶屋町口

export function addHankyu(b: NetBuilder): void {
  const st = 'hankyu';
  // Line groups from east to west: 京都線 (1–3号線), 宝塚線 (4–6号線), 神戸線 (7–9号線). OSM maps the
  // ten platforms (every track between two of them) fanning out slightly (347.8°–350.5°): their
  // south ends lie on one line ≈ 70 m inside the station building's south face (which faces the JR
  // viaduct), their north ends ≈ 190 m further on at the building's north end (茶屋町). Each record
  // runs along the middle of its group of four platforms (the groups share their outer platforms);
  // the records are kept parallel (349.5°, the middle group's bearing: the station renderer lays
  // all tracks out in one frame), which leaves them within ≈2 m of the fan.
  const groups: { id: string; nameJa: string; line: string; dir: string; S: XZ; N: XZ }[] = [
    { id: 'hk-kyoto', nameJa: '1〜3号線', line: 'hankyu-kyoto', dir: '京都線（十三・淡路・高槻市・京都河原町）', S: { x: 290.3, z: -246.9 }, N: { x: 254.7, z: -438.4 } },
    { id: 'hk-takarazuka', nameJa: '4〜6号線', line: 'hankyu-takarazuka', dir: '宝塚線（十三・石橋阪大前・宝塚／箕面）', S: { x: 263.8, z: -242.6 }, N: { x: 228.4, z: -433.2 } },
    { id: 'hk-kobe', nameJa: '7〜9号線', line: 'hankyu-kobe', dir: '神戸線（十三・西宮北口・神戸三宮）', S: { x: 233.3, z: -237.3 }, N: { x: 198.8, z: -422.6 } },
  ];
  /** Bearing of each group's platforms (a→b); going UP towards the 3F / 2F gates runs this way. */
  const axisOf = (gr: (typeof groups)[number]) => bearingOf(gr.S, gr.N);
  /** The middle group's bearing, used for the flights that serve the whole station. */
  const HK_AXIS = axisOf(groups[1]);
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
        { key: 's', t: 0.12, name: '南寄り（3階改札口寄り・先頭車）' },
        { key: 'm', t: 0.5, name: '中ほど（2階中央改札口への階段付近）' },
        { key: 'n', t: 0.88, name: '北寄り（茶屋町口寄り・最後尾）' },
      ],
    });
  }

  // 3F: platform heads join a step-free in-gate concourse across the south ends, then the
  // 43-machine gate line; south of it the gate-front concourse over the south part of the building.
  const heads: string[] = [];
  for (const gr of groups) {
    const id = `hk_head_${gr.id}`;
    b.node(id, 'junction', `3階 ${gr.nameJa}ホーム端`, offset(gr.S, axisOf(gr) + 180, 6), '3F', { station: st, paid: true, y: HK3 });
    b.walk(stops[gr.id].s, id, { busy: 3, width: 25 });
    heads.push(id);
  }
  b.path([heads[0], heads[1], heads[2]], { name: '3階改札内コンコース', busy: 3, width: 25 });
  b.node('hk_3f_in', 'gate', '阪急 3階改札口', { x: 262.0, z: -226.0 }, '3F', { station: st, paid: true, label: true, y: HK3 });
  for (const h of heads) b.walk(h, 'hk_3f_in', { busy: 3, width: 25 });
  b.node('hk_3f_out', 'junction', '3階改札前コンコース', { x: 262.0, z: -217.0 }, '3F', { station: st, y: HK3 });
  b.gate('hk_3f_in', 'hk_3f_out', '阪急 3階改札口', { busy: 3, width: 40 });

  // Grand staircase / escalator bank down to 1F (紀伊國屋・BIGMAN前), plus elevators beside it.
  // The flights start right in front of the gates and go down facing south; at their foot, just
  // inside the building's south face, the moving-walkway concourse continues straight on south
  // under the JR viaduct (hankyu.co.jp barrier-free route A).
  b.node('hk_1f_foot', 'vertical', '阪急 3階改札前エスカレーター下（BIGMAN前）', { x: 267.0, z: -187.0 }, '1F', { station: st, label: true });
  b.vertical('hk_3f_out', 'hk_1f_foot', ['stairs', 'esc', 'elev'], { name: '3階改札前 大階段・エスカレーター', busy: 3, width: 12, bearingUp: HK_AXIS, anchor: 'top' });
  // Side passage west of the bank (紀伊國屋書店・17番街), past the escalator down to 阪急三番街 B1:
  // 「エスカレーターを下りたら右折し、地下街に続くエスカレーターの横の通路を直進」.
  b.node('hk_1f_w', 'junction', '阪急 1階 紀伊國屋書店前通路（エスカレーター西側）', { x: 243.0, z: -184.0 }, '1F', { station: st });
  // 阪急ターミナルビル low-rise lifts (17番街 entrance, the building's south-west part) also stop
  // at 3F: one vertical shaft.
  b.node('hk_tb_ev1', 'vertical', '阪急ターミナルビル エレベーター（1階）', { x: 219.0, z: -208.0 }, '1F', { station: st });
  b.node('hk_tb_ev3', 'vertical', '阪急ターミナルビル エレベーター（3階）', { x: 219.0, z: -208.0 }, '3F', { station: st, y: HK3 });
  b.walk('hk_3f_out', 'hk_tb_ev3', { name: '3階コンコース' });
  // Door side unknown: the shaft stands beside the west end of the 3F concourse.
  b.elev('hk_tb_ev3', 'hk_tb_ev1', { name: '阪急ターミナルビル エレベーター', anchor: 'top', bearingUp: 180 });
  b.walk('hk_tb_ev1', 'hk_1f_w', { name: '阪急17番街前' });

  // 2F 中央改札口 (under the platforms): stairs/escalators down from mid-platform, facing south
  // towards the gate; the in-gate corridor runs E–W just south of their feet.
  const mids: string[] = [];
  for (const gr of groups) {
    const id = `hk_2f_${gr.id}`;
    b.node(id, 'vertical', `2階中央改札内（${gr.nameJa}への階段下）`, offset(lerp(gr.S, gr.N, 0.5), axisOf(gr) + 180, 18), '2F', { station: st, paid: true, y: HK2 });
    b.vertical(stops[gr.id].m, id, ['stairs', 'esc'], { busy: 2, bearingUp: axisOf(gr), anchor: 'top' });
    mids.push(id);
  }
  b.path(mids, { name: '2階中央改札内コンコース', busy: 2, width: 15 });
  const mid2 = b.get(mids[1]);
  b.node('hk_2f_in', 'gate', '阪急 2階中央改札口', offset(mid2, HK_AXIS + 180, 8), '2F', { station: st, paid: true, label: true, y: HK2 });
  b.walk(mids[1], 'hk_2f_in', { busy: 2 });
  b.node('hk_2f_out', 'junction', '2階中央改札前（NORIBA10前）', offset(mid2, HK_AXIS + 180, 15), '2F', { station: st, y: HK2 });
  b.gate('hk_2f_in', 'hk_2f_out', '阪急 2階中央改札口', { busy: 2, width: 25 });
  // The 大階段 / escalator starts right in front of the gate and goes down (facing south) to
  // 三番街 1F; BIGMAN is about 2 min further south.
  b.node('hk_1f_sanbangai', 'junction', '阪急三番街 1階（大階段下）', offset(mid2, HK_AXIS + 180, 32), '1F', { station: st });
  b.stairs('hk_2f_out', 'hk_1f_sanbangai', { name: '2階中央改札前 大階段', width: 10, bearingUp: HK_AXIS, anchor: 'top' });
  b.esc('hk_2f_out', 'hk_1f_sanbangai', 'both', { name: '三番街エスカレーター' });

  // 茶屋町口 (north, 2F): stairs down from the platforms' north ends to an E–W corridor just north
  // of their feet; no elevator yet (under construction 2026).
  const norths: string[] = [];
  for (const gr of groups) {
    const id = `hk_ch_${gr.id}`;
    b.node(id, 'vertical', `茶屋町口改札内（${gr.nameJa}北端の階段下）`, offset(gr.N, axisOf(gr) + 180, 8), '2F', { station: st, paid: true, y: HK2 });
    b.stairs(stops[gr.id].n, id, { bearingUp: axisOf(gr) - 180, anchor: 'top' });
    norths.push(id);
  }
  b.path(norths, { name: '茶屋町口改札内通路' });
  // The gate is at the east end of that corridor, just inside the building's east face near its
  // north-east corner (OSM outline).
  b.node('hk_ch_in', 'gate', '阪急 茶屋町口改札口', { x: 260.0, z: -427.0 }, '2F', { station: st, paid: true, label: true, y: HK2 });
  b.walk(norths[0], 'hk_ch_in');
  b.node('hk_ch_out', 'junction', '茶屋町口改札前', { x: 264.0, z: -423.5 }, '2F', { station: st, y: HK2 });
  b.gate('hk_ch_in', 'hk_ch_out', '阪急 茶屋町口改札口', { busy: 1 });
  // Outside the gate the stairs and escalators start at once: turn left and go down (north) along
  // the east façade towards NU茶屋町・ロフト, landing on the north-east corner by the 茶屋町
  // crosswalks. Back to 三番街 1F along the narrow east sidewalk (OSM covered footway, the road
  // runs close by), across the side street and in through the 1F passage that crosses the
  // building (OSM).
  // The flights stand inside the building's north-east corner, west of the covered sidewalk that
  // runs along the east façade (OSM), so that sidewalk passes beside them, not under them.
  b.node('hk_ch_1f', 'junction', '茶屋町口 階段下', { x: 261.0, z: -439.0 }, '1F', { station: st });
  b.stairs('hk_ch_out', 'hk_ch_1f', { indoor: false, bearingUp: HK_AXIS - 180, anchor: 'bottom' });
  b.esc('hk_ch_out', 'hk_ch_1f', 'both', { indoor: false });
  b.node('hk_chaya_1f', 'entrance', '茶屋町（NU茶屋町・ロフト方面）', { x: 265.0, z: -440.5 }, '1F', { label: true });
  b.walk('hk_ch_1f', 'hk_chaya_1f', { name: '茶屋町口', indoor: false });
  b.node('hk_1f_ne', 'junction', '阪急大阪梅田駅 東側 歩道', { x: 282.5, z: -377.7 }, '1F');
  b.node('hk_1f_ex', 'junction', '阪急大阪梅田駅 東側 横断歩道 北詰', { x: 290.4, z: -349.6 }, '1F');
  b.path(['hk_chaya_1f', 'hk_1f_ne', 'hk_1f_ex'], { name: '茶屋町 地上通路（駅東側の歩道）', indoor: false });
  b.node('hk_1f_e', 'junction', '阪急大阪梅田駅 1階 東口（茶屋町側）', { x: 294.5, z: -335.5 }, '1F', { station: st });
  b.cross('hk_1f_ex', 'hk_1f_e', '阪急大阪梅田駅 東側 横断歩道', 10);
  b.walk('hk_1f_e', 'hk_1f_sanbangai', { name: '阪急三番街 1階 東西通路' });
}

// ------------------------------------------------------------------------------------------------

// The gates (東口・西口・百貨店口) are on the B1 mall floor and the terminus platforms lie a floor
// below it: from the platform 「最も尼崎寄りの階段を上り「百貨店口」の改札を出ます」
// (osaka-station.net), and the public B1 passages run over the station. The platform depth is
// provisional: the sources only require it to be ≥ 4.5 m below B1.
const HS_PLAT = -11;
const HS_CONC = -6;

export function addHanshin(b: NetBuilder): void {
  const st = 'hanshin';
  // OSM maps the four tracks and their platform edges ENE–WSW (bearing ≈ 59°, parallel to JR), under
  // the plaza and road between the サウスゲートビル and 阪神梅田本店: west ends under the road in front
  // of 大阪第一生命ビル, east ends at the foot of the 梅田新歩道橋. Trains leave westward (≈ 239°).
  // Two records, each along the platform between a pair of tracks (1・2 north, 3・4 south).
  const plats = [
    { id: 'hs-1-2', nameJa: '1・2番線', W: { x: 67.8, z: 150.8 }, E: { x: 185.8, z: 80.6 } },
    { id: 'hs-3-5', nameJa: '3〜5番線', W: { x: 75.9, z: 165.2 }, E: { x: 190.7, z: 97.6 } },
  ];
  /** Platform axis W→E: the stairs rise towards the gates this way. */
  const AXIS = bearingOf(plats[0].W, plats[0].E);
  const stops: Record<string, Record<string, string>> = {};
  for (const p of plats) {
    stops[p.id] = b.platform({
      id: p.id,
      station: st,
      nameJa: p.nameJa,
      lines: ['hanshin'],
      directions: '阪神本線（尼崎・甲子園・神戸三宮方面）',
      level: 'B2',
      y: HS_PLAT,
      a: p.W,
      b: p.E,
      // Wide enough that the two records share their middle track (the station renderer's model).
      width: 12,
      busy: 2,
      stops: [
        { key: 'w', t: 0.1, name: '西端（西口・百貨店口への階段付近）' },
        { key: 'm', t: 0.5, name: '中ほど' },
        { key: 'e', t: 0.92, name: '東端（東口への階段付近）' },
      ],
    });
  }
  // East: stairs, escalators and a lift at each platform's east end rise eastwards to the B1
  // in-gate 東口 concourse over the platform ends.
  const eMid = lerp(plats[0].E, plats[1].E, 0.5);
  b.node('hs_head', 'junction', '阪神 東口改札内コンコース（地下1階）', offset(eMid, AXIS, 6), 'B1', { station: st, paid: true, y: HS_CONC });
  for (const p of plats) b.vertical(stops[p.id].e, 'hs_head', ['stairs', 'esc', 'elev'], { bearingUp: AXIS, anchor: 'bottom', busy: 2 });
  b.node('hs_e_in', 'gate', '阪神 東口改札', offset(eMid, AXIS, 11), 'B1', { station: st, paid: true, label: true, y: HS_CONC });
  b.walk('hs_head', 'hs_e_in');
  // Free side on the corridor under the 梅田新歩道橋 between 阪神 and the 御堂筋線 south gate.
  b.node('hs_e_out', 'junction', '阪神 東口改札前', offset(eMid, AXIS, 17), 'B1', { station: st, y: HS_CONC });
  b.gate('hs_e_in', 'hs_e_out', '阪神 東口改札', { busy: 3, width: 20 });

  // West: the stairs nearest 尼崎 rise to a B1 in-gate concourse between the platforms' west ends,
  // serving the 百貨店口 and the 西口.
  b.node('hs_wm', 'junction', '阪神 西側改札内コンコース（地下1階）', { x: 88.0, z: 148.4 }, 'B1', { station: st, paid: true, y: HS_CONC });
  for (const p of plats) b.vertical(stops[p.id].w, 'hs_wm', ['stairs'], { bearingUp: AXIS, anchor: 'bottom', busy: 2 });
  // 百貨店口: on the west side of the public N–S B1 passage (中央南口 → 阪神梅田本店 → 円形広場,
  // mapped in OSM) where it crosses over the platforms; walking north from 北新地 it is on your left.
  b.node('hs_c_in', 'gate', '阪神 百貨店口改札', { x: 96.0, z: 151.0 }, 'B1', { station: st, paid: true, label: true, y: HS_CONC });
  b.walk('hs_wm', 'hs_c_in');
  b.node('hs_c_out', 'junction', '阪神 百貨店口改札前', { x: 101.9, z: 149.5 }, 'B1', { station: st, y: HS_CONC });
  b.gate('hs_c_in', 'hs_c_out', '阪神 百貨店口改札', { busy: 2 });

  // 西口 (north-west, towards 西梅田): on the E–W passage along the north side of the station.
  b.node('hs_w_in', 'gate', '阪神 西口改札', { x: 57.0, z: 157.5 }, 'B1', { station: st, paid: true, label: true, y: HS_CONC });
  b.walk('hs_wm', 'hs_w_in');
  b.node('hs_w_out', 'junction', '阪神 西口改札前', { x: 52.0, z: 152.7 }, 'B1', { station: st, y: HS_CONC });
  b.gate('hs_w_in', 'hs_w_out', '阪神 西口改札', { busy: 1 });
}
