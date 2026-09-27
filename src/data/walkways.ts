import type { NetBuilder, Pos } from './builder';
import { JR_AXIS, JR_STACK_S, jrAt } from './jr';

/**
 * Free (outside-the-gates) pedestrian network: street level around JR大阪駅, the 2F decks,
 * 梅田新歩道橋, and the B1 malls (阪急三番街, ホワイティうめだ, ディアモール大阪, 大阪駅前ビル地下,
 * ルクア/グランフロント地下). Station gate "…_out" nodes are defined in the station modules.
 */
export function addWalkways(b: NetBuilder): void {
  const B1 = { y: -6 };
  const D2 = { y: 6 }; // outdoor decks / pedestrian bridges

  // ------------------------------------------------------------------ JR大阪駅 1F (free concourses)
  // Placed in the JR station frame (jrAt(s, t): s along the tracks, t across them; see jr.ts) on the
  // OSM map. The 中央コンコース runs square to the tracks under the 南北連絡橋, from the サウスゲートビル
  // (大丸・ホテルグランヴィア, north face t ≈ −80) to 暁の広場 under the ノースゲートビル atrium (中央北口).
  // 中央南口 is at that building's south face: the passage between 大丸 and グランヴィア carries the
  // concourse straight on south (OSM footway at s ≈ 6) to the crosswalk towards 阪神.
  b.j('f_chuo_s', '中央南口', jrAt(6, -143), '1F', { label: true });
  b.j('f_chuo_sp', '中央南口通路（大丸入口）', jrAt(8, -110), '1F');
  b.j('f_chuo_sn', '中央コンコース南端（大丸・グランヴィア前）', jrAt(JR_STACK_S, -76), '1F');
  b.path(['f_chuo_s', 'f_chuo_sp', 'f_chuo_sn'], { name: '中央南口通路（大丸・ホテルグランヴィア）', busy: 2, width: 10 });
  b.j('f_chuo_mid', '中央コンコース（地下への階段上）', jrAt(JR_STACK_S, -50), '1F');
  b.j('f_chuo_n', '中央北口（暁の広場）', jrAt(JR_STACK_S, 44), '1F', { label: true });
  b.path(['f_chuo_sn', 'f_chuo_mid', 'jr_chuo_out', 'f_chuo_n'], { name: '中央コンコース', busy: 3, width: 20 });
  // 御堂筋口: the free concourse along the east end, between the platform ends and 国道176号, from
  // 御堂筋南口 (the station's SE corner, where the covered walk to 梅田新歩道橋 starts) to 御堂筋北口
  // (the exit under the ノースゲートビル's one-storey east wing, onto the plaza with the stairs up to
  // the 2F deck).
  // The crosswalk to 阪急 starts from its south part, under the viaduct (see the street crossings).
  b.j('f_mido_s', '御堂筋南口', jrAt(149, -73), '1F', { label: true });
  b.j('f_mido_c', '御堂筋口コンコース 南側（阪急方面 横断歩道へ）', jrAt(150, -61), '1F');
  b.j('f_mido_n', '御堂筋北口', jrAt(156, 40), '1F', { label: true });
  b.path(['f_mido_s', 'f_mido_c', 'jr_mido_out', 'f_mido_n'], { name: '御堂筋口コンコース', busy: 3, width: 15 });

  // South side: the sidewalk along the station's south face west of the サウスゲートビル, the concourse
  // along that building's north face (大丸 and グランヴィア entrances), and the sidewalk along the
  // city bus terminal east of it (canopy, but open to the street).
  b.j('f_s_west', '大阪駅南側（エキマルシェ前）', jrAt(-62, -70.5), '1F');
  b.j('f_sgb_w', '大阪駅 南側コンコース 西端', jrAt(-49, -74), '1F');
  b.j('f_sgb_e', '大阪駅 南側コンコース 東端（バスターミナル前）', jrAt(74, -75.5), '1F');
  b.path(['jr_sak_out', 'f_s_west', 'f_sgb_w'], { name: '大阪駅前 歩道', indoor: false, busy: 2, width: 8 });
  b.path(['f_sgb_w', 'f_chuo_sn', 'f_sgb_e'], { name: '大阪駅 南側コンコース（大丸前）', busy: 2, width: 10 });
  b.path(['f_sgb_e', 'jr_minami_out', 'f_mido_s'], { name: '大阪駅前 バスターミナル沿い', indoor: false, busy: 2, width: 8 });
  b.walk('jr_ekim_out', 'f_s_west', { name: 'エキマルシェ大阪' });

  // ------------------------------------------------------------------ 阪急方面 (1F / 2F)
  // Positions from OpenStreetMap (via Overture Maps; local metres, x = east, z = south). 阪急うめだ本店
  // (大阪梅田ツインタワーズ・ノース) stands between 国道176号 (west) and 阪急グランドビル; the JR
  // viaduct passes along its north face, with the 阪急 station building beyond it. The covered
  // 南北コンコース runs down the store's west face (OSM covered footway), from the 東西コンコース at the
  // north-west corner to the 梅田新歩道橋 at the south-west corner; the 東西コンコース runs east along the
  // north face (the canopy between the store and the viaduct) towards HEP NAVIO.
  b.j('f_hk_x', '阪急うめだ本店 北西角（東西コンコース西端）', { x: 206.0, z: -62.0 }, '1F');
  b.j('f_hk_w', '阪急うめだ本店 北側（動く歩道前）', { x: 260.0, z: -101.0 }, '1F', { label: true });
  b.walk('f_hk_x', 'f_hk_w', { name: '東西コンコース', busy: 3, width: 12 });
  // Japan's first moving walkway (1967), north under the JR viaduct to the foot of the 3F-gate
  // escalators (≈86 m): model the belts as a shorter effective length.
  b.walk('f_hk_w', 'hk_1f_foot', { name: '阪急 動く歩道', length: 60, busy: 3, width: 10 });
  // At the foot of the 3F escalators a side passage runs west (BIGMAN / 紀伊國屋), past the
  // escalator down to the 阪急三番街 mall, then north to 三番街 1F.
  b.walk('hk_1f_foot', 'hk_1f_w', { name: 'BIGMAN前', busy: 2 });
  b.walk('hk_1f_w', 'hk_1f_sanbangai', { name: '阪急三番街 1階', busy: 2 });
  // 南北コンコース (100 m × 16.5 m, 2012) along the store, with the way down to B1 at its south end.
  b.j('f_hk_cm', '南北コンコース（阪急うめだ本店前）', { x: 227.5, z: 0.0 }, '1F');
  b.j('f_hk_sw', '阪急うめだ本店 南西角', { x: 249.4, z: 46.5 }, '1F');
  b.path(['f_hk_x', 'f_hk_cm', 'f_hk_sw'], { name: '南北コンコース（阪急うめだ本店）', indoor: true, width: 16, busy: 2 });

  // 2F: the mapped deck (OSM bridge footway, 4 m wide) leaves the ノースゲートビル at 2F, runs east
  // along its north face past ヨドバシ梅田 and 御堂筋北口 — where the escalator right in front of the
  // exit comes up to it — crosses 国道176号 and lands on the 阪急 station building's south face at 2F
  // (阪急三番街 side; the 2F passage inside leads north past the 2階中央改札). Just before the building
  // a stair goes down east to 1F: 「スロープから1階に降りるポイント」 next to the foot of the 3F escalators.
  b.j('f_deck_w', 'ノースゲートビル 2階デッキ（北面）', { x: 11.6, z: -81.6 }, '2F', D2);
  b.j('f_deck_y', 'ヨドバシ梅田前 2階デッキ', { x: 96.0, z: -134.0 }, '2F', D2);
  b.j('f_deck_jr', '御堂筋北口 2階デッキ', { x: 112.0, z: -139.0 }, '2F', D2);
  b.j('f_deck_mid', '国道176号 2階デッキ（西詰）', { x: 134.0, z: -145.5 }, '2F', D2);
  b.j('f_deck_e', '国道176号 2階デッキ（東詰・阪急前）', { x: 212.0, z: -162.0 }, '2F', D2);
  b.path(['f_deck_w', 'f_deck_y', 'f_deck_jr', 'f_deck_mid', 'f_deck_e'], { name: '2階歩道橋（屋根なし）', indoor: false, busy: 1 });
  b.vertical('f_mido_n', 'f_deck_jr', ['stairs', 'esc'], { indoor: false, bearingUp: 0, anchor: 'bottom' });
  b.j('hk_2f_w', '阪急三番街 2階 南側（歩道橋着地）', { x: 229.0, z: -172.0 }, '2F', { y: 5.5 });
  b.walk('f_deck_e', 'hk_2f_w', { name: '2階歩道橋（屋根なし）', indoor: false, busy: 1 });
  b.walk('hk_2f_w', 'hk_2f_out', { name: '2階通路' });
  b.j('f_deck_1f', '阪急大阪梅田駅 南口前（歩道橋階段下）', { x: 227.0, z: -163.0 }, '1F');
  b.stairs('f_deck_e', 'f_deck_1f', { indoor: false, bearingUp: 261, anchor: 'top' });
  b.walk('f_deck_1f', 'hk_1f_w', { name: '阪急三番街 南口' });

  // 梅田新歩道橋 (2F) over the 梅田 intersection, as mapped: a spine along 国道176号 from above JR
  // 御堂筋南口 (stairs down west to it) past 阪急うめだ本店 (arm east to the store, stairs and
  // escalator down to its south-west corner) to a hub from which arms run south to the 阪神梅田本店
  // north-east corner (stairs down west) and west to the bus terminal east of the サウスゲートビル.
  b.j('f_bridge', '梅田新歩道橋', { x: 203.0, z: 49.0 }, '2F', { ...D2, label: true });
  b.j('f_bridge_e', '梅田新歩道橋 東側（阪急うめだ本店前）', { x: 220.0, z: 36.5 }, '2F', D2);
  b.j('f_bridge_n', '梅田新歩道橋 北側（御堂筋南口前）', { x: 196.0, z: -31.0 }, '2F', D2);
  b.j('f_bridge_nw', '梅田新歩道橋 北西', { x: 184.0, z: -22.0 }, '2F', D2);
  b.j('f_bridge_ne', '梅田新歩道橋 北東（阪急うめだ本店）', { x: 237.0, z: 21.0 }, '2F', D2);
  b.j('f_bridge_sw', '梅田新歩道橋 南（阪神梅田本店）', { x: 219.0, z: 99.0 }, '2F', D2);
  b.j('f_bridge_w', '梅田新歩道橋 西（大阪駅前バスターミナル）', { x: 130.0, z: 80.0 }, '2F', D2);
  const bridge = { name: '梅田新歩道橋', indoor: false, busy: 2 };
  b.path(['f_bridge_nw', 'f_bridge_n', 'f_bridge_e', 'f_bridge', 'f_bridge_sw'], bridge);
  b.walk('f_bridge_e', 'f_bridge_ne', bridge);
  b.walk('f_bridge', 'f_bridge_w', bridge);
  b.stairs('f_bridge_nw', 'f_mido_s', { indoor: false, bearingUp: 82, anchor: 'top' });
  b.stairs('f_bridge_ne', 'f_hk_sw', { indoor: false, anchor: 'top' });
  b.esc('f_bridge_ne', 'f_hk_sw', 'both', { indoor: false });
  // No street stair down to B1 at this corner: an earlier model had one (from the station
  // research, low confidence and without a quoted source: a sidewalk stair along the façade down
  // to the B1 passage), but OSM maps no steps down here: only the stair up to the 梅田新歩道橋
  // (next line) and, ≈65 m to the north, the street stair under the bridge (f_jrs_1f → f_jrs_b1,
  // OSM steps at x 186.3, z 41.7–49.9), which is modelled. The corner is reached by the bridge
  // stair and the sidewalk from 中央南口前.
  b.j('f_hs_ne', '阪神梅田本店 北東角', { x: 206.0, z: 108.0 }, '1F');
  b.stairs('f_bridge_sw', 'f_hs_ne', { indoor: false, bearingUp: 66, anchor: 'top' });
  // The covered sidewalk along 国道176号 from 御堂筋南口 under the bridge (OSM), with stairs up to the
  // hub and a stair down to the B1 passage towards 阪神 東口.
  b.j('f_jrs_1f', '梅田新歩道橋下（御堂筋南口前 歩道）', { x: 187.5, z: 38.0 }, '1F');
  b.walk('f_mido_s', 'f_jrs_1f', { name: '御堂筋南口前 歩道（梅田新歩道橋下）', indoor: false, busy: 2 });
  b.stairs('f_bridge', 'f_jrs_1f', { indoor: false, bearingUp: 157, anchor: 'top' });
  b.j('f_brw_1f', '大阪駅前 バスターミナル東（梅田新歩道橋 西階段下）', { x: 122.0, z: 57.0 }, '1F');
  b.stairs('f_bridge_w', 'f_brw_1f', { indoor: false, bearingUp: 149, anchor: 'top' });
  b.walk('f_brw_1f', 'f_sgb_e', { name: '大阪駅前 サウスゲートビル東側', indoor: false });

  // Street crossing in front of the station: from 中央南口 (the サウスゲートビル's south face) the
  // signalled crosswalk on the east side of the junction south of it (OSM crossings at s ≈ 19,
  // t −163…−189) spans the bus lane and the 大阪駅前 road towards 阪神 (its twin at s ≈ −10 leads to
  // 大阪第一生命ビル). There is no crosswalk between 御堂筋南口 and 阪神 (the 梅田新歩道橋 spans that
  // junction).
  b.j('f_chuo_sx', '中央南口前 横断歩道 北詰', jrAt(19, -158), '1F');
  b.walk('f_chuo_s', 'f_chuo_sx', { name: '中央南口前', indoor: false, busy: 2 });
  // South end (OSM crosswalk) on the sidewalk at the store's north-west corner.
  b.j('f_hs_n', '阪神梅田本店 北側', { x: 118.0, z: 156.0 }, '1F');
  b.cross('f_chuo_sx', 'f_hs_n', '中央南口前 横断歩道', 35, { busy: 2 });
  // 御堂筋口 → 阪急うめだ本店: the signalled crosswalk over both carriageways of 国道176号 under the JR
  // viaduct (OSM footway s 170…205 at t ≈ −60, crossings at s ≈ 178 and 195), reached from the south
  // part of the 御堂筋口 concourse; its east end is the sidewalk along 阪急うめだ本店. It is the only
  // ground crossing of 国道176号 here: 御堂筋北口 (at the ノースゲートビル's east end, west of the road)
  // reaches it along the concourse, not across the road.
  b.j('f_mido_x', '御堂筋口前 横断歩道 西詰（国道176号）', jrAt(170, -59), '1F');
  b.walk('f_mido_c', 'f_mido_x', { name: '御堂筋口前（高架下）', busy: 3, width: 12 });
  b.j('f_mido_xe', '御堂筋口前 横断歩道 東詰（阪急うめだ本店前）', jrAt(205, -62), '1F');
  b.cross('f_mido_x', 'f_mido_xe', '阪急百貨店前 横断歩道（御堂筋口）', 40, { busy: 3, width: 12 });
  b.walk('f_mido_xe', 'f_hk_x', { name: '阪急うめだ本店前', indoor: false, busy: 3, width: 12 });
  b.walk('f_hs_n', 'f_hs_ne', { name: '阪神梅田本店前', indoor: false });

  // ------------------------------------------------------------------ JR大阪駅 north side (2F/3F decks)
  // The 3F 南北連絡橋 on the 中央 stack line: 大丸 4F in the south, the ルクア / ルクア1100
  // boundary (the atrium) in the north. The アトリウム広場 is straight above 暁の広場.
  // The bridge enters the ノースゲートビル at 3F (t ≈ 32) and ends at the atrium, north of the 11番
  // platform; its flights down to 2F run along the atrium's south side (descending west), clear of
  // the escalators rising north from 暁の広場 below.
  b.j('f_br_n', '南北連絡橋 北端（ルクア3階）', jrAt(JR_STACK_S, 46), '3F', { y: 15 });
  b.j('f_br_s', '南北連絡橋 南端（大丸梅田店4階）', jrAt(JR_STACK_S, -81), '3F', { y: 15 });
  b.path(['f_br_s', 'jr_br_out', 'f_br_n'], { name: '南北連絡橋', busy: 2, width: 12 });
  b.j('f_atrium', 'アトリウム広場（ノースゲートビル2階）', jrAt(JR_STACK_S, 62), '2F', { label: true, y: 7 });
  b.vertical('f_br_n', 'f_atrium', ['stairs', 'esc', 'elev'], { bearingUp: JR_AXIS, anchor: 'top' });
  b.vertical('f_chuo_n', 'f_atrium', ['esc', 'elev'], { bearingUp: JR_AXIS - 90, anchor: 'bottom' });
  b.j('f_daimaru1', '大丸梅田店 1階', jrAt(24, -110), '1F');
  b.vertical('f_br_s', 'f_daimaru1', ['esc', 'elev'], { name: '大丸梅田店 店内' });
  b.walk('f_daimaru1', 'f_chuo_sp', { name: '大丸梅田店 入口' });
  // GFO うめきた広場: the plaza between the ノースゲートビル's north face (中央北口) and グランフロント大阪
  // 南館 (OSM), with うめきたセラー on B1 beneath it and the 2F deck from the atrium crossing it. There
  // is no ground link west to うめきた here: the road north of 梅田ランプ東 has no crosswalk.
  // The atrium also opens onto the 2F deck along the north face towards 阪急 (see 阪急方面).
  b.walk('f_atrium', 'f_deck_w', { name: 'ノースゲートビル 2階', busy: 1 });
  b.j('f_gfo2', 'グランフロント大阪 南館2階デッキ', { x: -45.0, z: -130.0 }, '2F');
  b.j('f_gfo2p', 'うめきた広場 2階デッキ', { x: -20.0, z: -119.0 }, '2F');
  b.path(['f_atrium', 'f_gfo2p', 'f_gfo2'], { name: 'ノースゲート〜グランフロント 2階デッキ', indoor: false, busy: 2 });
  b.j('f_gfo1', 'グランフロント大阪 うめきた広場', { x: -34.0, z: -113.0 }, '1F', { label: true });
  b.vertical('f_gfo2p', 'f_gfo1', ['stairs', 'esc'], { anchor: 'bottom' });

  // 2F west of the ノースゲートビル (OSM bridge footways): from its west end a deck crosses 市道梅田線
  // to イノゲート大阪 2F, and another runs north across the 梅田ランプ東 junction and then west along
  // うめきたグリーンプレイス (UGP) 2F to グラングリーン大阪 南館 2F (opened 2024-12 and 2025-04-11).
  b.j('f_ngb_w2', 'ルクア1100 2階（西端）', { x: -124.0, z: 12.0 }, '2F', { y: 7 });
  b.walk('f_atrium', 'f_ngb_w2', { name: 'ルクア1100 2階', busy: 1 });
  b.j('f_dk_se', 'ノースゲートビル西端 2階デッキ', { x: -133.0, z: 23.0 }, '2F');
  b.j('f_inogate2', 'イノゲート大阪 2階', { x: -172.0, z: 45.0 }, '2F');
  b.path(['f_ngb_w2', 'f_dk_se', 'f_inogate2'], { name: 'ノースゲート〜イノゲート 2階デッキ', indoor: false });
  b.j('f_dk_ne', '梅田ランプ東 2階デッキ（北東）', { x: -146.0, z: -15.0 }, '2F', D2);
  b.j('f_ugp2', 'うめきたグリーンプレイス 2階（歩行者デッキ）', { x: -215.0, z: -35.0 }, '2F', D2);
  b.path(['f_dk_se', 'f_dk_ne', 'f_ugp2'], { name: 'イノゲート〜うめきたグリーンプレイス 歩行者デッキ', indoor: false });
  b.j('f_dk_w', 'うめきた公園 大屋根前 2階デッキ', { x: -246.0, z: -50.0 }, '2F', D2);
  b.j('f_ggo2', 'グラングリーン大阪 南館 2階', { x: -293.0, z: -23.0 }, '2F', D2);
  b.path(['f_ugp2', 'f_dk_w', 'f_ggo2'], { name: '歩行者デッキ（グラングリーン大阪 南館方面）', indoor: false });

  // ------------------------------------------------------------------ 西口 / うめきた (1F)
  // The 西口 free passage runs through イノゲート 1F (north, out at its north tip on 市道九条梅田線) and
  // on to KITTE大阪 (south). From the north tip the signalled crosswalk on the west side of 梅田ランプ東
  // (OSM) crosses 市道九条梅田線 to the corner where the うめきた corridor's exit comes up; the うめきた
  // 地下口 building of うめきたグリーンプレイス (UGP) stands just north-west of it.
  b.j('f_inogate1', 'イノゲート大阪 1階（北口）', { x: -177.0, z: 39.0 }, '1F');
  b.walk('jr_nishi_out', 'f_inogate1', { name: '西口 南北通路（イノゲート大阪 1階）' });
  b.vertical('f_inogate1', 'f_inogate2', ['esc', 'elev']);
  b.j('f_ino_x', '梅田ランプ東 横断歩道 南詰（イノゲート前）', { x: -177.0, z: 29.0 }, '1F');
  b.walk('f_inogate1', 'f_ino_x', { name: 'イノゲート大阪 北口前', indoor: false });
  b.j('f_uk_x', '梅田ランプ東 横断歩道 北詰（うめきた側）', { x: -188.0, z: -7.0 }, '1F');
  b.cross('f_ino_x', 'f_uk_x', '梅田ランプ東 横断歩道（イノゲート〜うめきた）', 40, { busy: 1 });
  // 地上出口（JR大阪駅西口方面）: from the corridor's bend, on its south (right-hand) side, up to the
  // corner (OSM: lift node there; the ground access of 2023).
  b.vertical('uk_b1_se', 'f_uk_x', ['stairs', 'elev'], { name: '地上出口（梅田ランプ東・JR大阪駅西口方面）', bearingUp: 196, anchor: 'bottom' });
  // うめきた地下口 building (UGP 1F): the stairs, escalators and lift from the corridor rise NNE into
  // it (OSM steps), just north of the gate-front corridor.
  b.j('f_ugp1', 'うめきたグリーンプレイス 1階（うめきた地下口）', { x: -200.0, z: -48.0 }, '1F');
  b.vertical('uk_b1_e', 'f_ugp1', ['stairs', 'esc', 'elev'], { name: '大阪駅（うめきたエリア）地上出口', bearingUp: 25, anchor: 'bottom' });
  b.walk('f_uk_x', 'f_ugp1', { name: 'うめきたグリーンプレイス 1階（公共広場）', indoor: false });
  b.vertical('f_ugp1', 'f_ugp2', ['esc', 'elev'], { anchor: 'top' });
  // うめきた公園 サウスパーク: turn left (west) out of the gate; the escalator ahead rises west to
  // the park under the 大屋根, and the B1 corridor carries straight on into GGO 南館.
  b.j('f_sp1', 'うめきた公園 サウスパーク（大屋根下）', { x: -253.0, z: -50.0 }, '1F', { label: true });
  b.vertical('uk_sp_b1', 'f_sp1', ['esc'], { name: 'うめきた公園への出口', bearingUp: 297.5, anchor: 'bottom' });
  b.walk('f_sp1', 'f_ugp1', { name: 'うめきたグリーンプレイス 1階（うめきた公園側）' });
  // Level with the gate-front corridor (a sloping corridor would roof over the park escalator).
  b.j('f_ggo_b1', 'グラングリーン大阪 南館 地下1階（タイムアウトマーケット）', { x: -293.0, z: -17.0 }, 'B1', { y: -7 });
  b.walk('uk_sp_b1', 'f_ggo_b1', { name: 'うめきた地下通路（グラングリーン大阪 南館方面）', busy: 1 });
  // KITTE大阪 (JPタワー大阪): the 西口 passage runs on south under the viaduct to its north entrance.
  b.j('f_kitte1', 'KITTE大阪 1階', { x: -150.0, z: 195.0 }, '1F');
  b.walk('jr_nishi_out', 'f_kitte1', { name: '西口 南北通路' });

  // ------------------------------------------------------------------ B1: north (ルクア・グランフロント・阪急三番街)
  // On the B1 passage along the ノースゲートビル (OSM, t ≈ 45); the stairs go down heading east from
  // the east side of 暁の広場, beside the escalators up to the atrium.
  b.j('f_chuo_nb', '暁の広場（地下への階段上）', jrAt(22, 40), '1F');
  b.walk('f_chuo_n', 'f_chuo_nb', { name: '暁の広場', busy: 2 });
  b.j('f_lucua_b1', 'ルクア地下1階（バルチカ）', jrAt(40, 45), 'B1', B1);
  b.vertical('f_chuo_nb', 'f_lucua_b1', ['stairs', 'esc'], { bearingUp: JR_AXIS + 180, anchor: 'top' });
  // The mapped B1 corridor (OSM) runs from the ルクア B1 along the ノースゲートビル's north face to the
  // hub under うめきた広場 (うめきたセラー, with グランフロント大阪 南館 B1 just north), then WSW to the
  // うめきた corridor's bend at 梅田ランプ東.
  b.j('f_ucellar_b1', 'うめきたセラー（うめきた広場 地下1階）', { x: -53.0, z: -100.5 }, 'B1', B1);
  b.vertical('f_gfo1', 'f_ucellar_b1', ['stairs', 'esc', 'elev'], { anchor: 'mid' });
  b.j('f_gfo_b1', 'グランフロント大阪 南館地下1階', { x: -58.0, z: -129.0 }, 'B1', B1);
  b.path(['f_lucua_b1', 'f_ucellar_b1', 'uk_b1_se'], { name: 'ルクア〜うめきた広場〜うめきた地下通路', busy: 1 });
  b.walk('f_ucellar_b1', 'f_gfo_b1', { name: 'グランフロント大阪 南館 地下1階', busy: 1 });
  // Along the ノースゲートビル's B1 (OSM) to the foot of the stairs down from 御堂筋北口.
  b.j('f_midon_b1', 'JR御堂筋北口 地下', { x: 118.0, z: -124.0 }, 'B1', B1);
  b.walk('f_lucua_b1', 'f_midon_b1', { name: 'ルクア地下通路', busy: 2 });
  // It goes down facing south, clear of the 2F-deck escalator that rises north from the same exit.
  b.vertical('f_mido_n', 'f_midon_b1', ['stairs', 'esc', 'elev'], { bearingUp: 0, anchor: 'top' });
  b.walk('f_midon_b1', 'm_n_out', { name: '御堂筋線北改札前通路', busy: 3 });
  // B1 along the north side of 阪急うめだ本店 (OSM), below the south end of the moving walkway, and
  // down its west side (below the 南北コンコース) to the south-west corner.
  b.j('f_hkd_b1', '阪急うめだ本店 地下1階前', { x: 255.0, z: -100.0 }, 'B1', { ...B1, label: false });
  b.walk('m_n_out', 'f_hkd_b1', { busy: 3 });
  b.vertical('f_hk_w', 'f_hkd_b1', ['stairs', 'esc', 'elev'], { busy: 3, anchor: 'top' });
  b.j('f_3b_b1', '阪急三番街 地下1階', { x: 245.0, z: -281.0 }, 'B1', B1);
  b.vertical('hk_1f_sanbangai', 'f_3b_b1', ['stairs', 'esc', 'elev'], { anchor: 'top' });
  // South end of 阪急三番街 B1, on the mapped corridor along the station building's south part.
  b.j('f_3b_s', '阪急三番街 南端（地下1階）', { x: 230.0, z: -192.0 }, 'B1', B1);
  b.path(['f_3b_b1', 'f_3b_s', 'm_n_out'], { name: '阪急三番街', busy: 2 });
  // 「地下街に続くエスカレーター」 beside the side passage at the foot of the 3F escalators: the
  // short way from the 3F gate down to the 御堂筋線 北改札. Only the way down is documented (no
  // stairs, no up escalator confirmed); an up escalator here would put 御堂筋線北改札→阪急3階改札
  // at ≈3.4 min, well under the published 5〜10 min.
  b.vertical('hk_1f_w', 'f_3b_s', ['esc-down'], { name: '阪急三番街（地下）へのエスカレーター', anchor: 'top' });

  // ------------------------------------------------------------------ B1: JR大阪駅前 / 阪神 / ホワイティうめだ
  // (OSM underground footways.) Below JR御堂筋南口 the corridor along the west side of the 御堂筋線
  // station runs south from its 中改札 past the 梅田新歩道橋 to the 阪神 東口 and the 御堂筋線 南改札,
  // where ホワイティうめだ (east) and ディアモール (south, round the 阪神梅田本店) branch off.
  b.j('f_jrf_b1', 'JR大阪駅前 地下（御堂筋南口下）', { x: 172.0, z: -5.0 }, 'B1', { ...B1, label: false });
  b.vertical('f_mido_s', 'f_jrf_b1', ['stairs', 'esc', 'elev'], { busy: 3, bearingUp: 328, anchor: 'top' });
  b.j('f_jrs_b1', '梅田新歩道橋下 地下通路', { x: 186.3, z: 51.0 }, 'B1', B1);
  // Street stair (OSM) from the covered sidewalk under the 梅田新歩道橋, going down facing south.
  b.vertical('f_jrs_1f', 'f_jrs_b1', ['stairs'], { bearingUp: 0, anchor: 'top' });
  b.j('f_hsne_b1', '阪神梅田本店 北東 地下（阪神東口前）', { x: 196.7, z: 68.3 }, 'B1', B1);
  b.j('f_hs_se_b1', '御堂筋線南改札前 地下（ディアモール・ホワイティ分岐）', { x: 238.4, z: 79.2 }, 'B1', B1);
  b.path(['f_jrf_b1', 'm_c_out', 'f_jrs_b1', 'f_hsne_b1', 'hs_e_out', 'm_s_out', 'f_hs_se_b1'], { name: '梅田地下街（御堂筋線西側・阪神東口）', busy: 3 });
  // The E–W passage over the 阪神 platforms (OSM), under the road between JR大阪駅 and 阪神梅田本店:
  // from 西梅田 past the 阪神 西口 and the foot of the public N–S passage to the 梅田新歩道橋.
  b.j('f_chuo_b1', '阪神梅田本店前 地下（中央南口方面）', { x: 90.3, z: 130.7 }, 'B1', B1);
  // The stairs to B1 are in the 中央コンコース ≈50 m south of the gate, going down heading south
  // into the passage under 大丸 towards 阪神.
  b.j('f_chuo_s_b1', '中央南口 地下（大丸前）', jrAt(JR_STACK_S, -66), 'B1', B1);
  b.vertical('f_chuo_mid', 'f_chuo_s_b1', ['stairs', 'esc', 'elev'], { bearingUp: JR_AXIS - 90, anchor: 'top' });
  b.walk('f_chuo_s_b1', 'f_chuo_b1', { name: '大丸梅田店 地下通路' });
  b.vertical('f_hs_n', 'f_chuo_b1', ['stairs'], { anchor: 'top' });
  b.j('f_hsnw_b1', '西梅田駅 北 地下（桜橋口・阪神西口方面）', { x: -7.0, z: 186.3 }, 'B1', B1);
  b.path(['f_hsnw_b1', 'hs_w_out', 'f_chuo_b1', 'f_hsne_b1'], { name: '阪神梅田本店 北側地下通路', busy: 2 });

  // ホワイティうめだ (OSM): from the 御堂筋線 南改札 east along the south side of 阪急うめだ本店 to the
  // 谷町線 line, where the long N–S mall runs north towards HEP and south to 東梅田; the east arm ends
  // at 泉の広場.
  b.j('f_wh_sw', 'ホワイティうめだ 御堂筋線南改札前', { x: 262.0, z: 73.0 }, 'B1', B1);
  b.j('f_wh_c', 'ホワイティうめだ センターモール', { x: 294.6, z: 67.9 }, 'B1', B1);
  b.j('f_wh_e', 'ホワイティうめだ（東梅田方面分岐）', { x: 339.7, z: 59.6 }, 'B1', B1);
  b.j('f_wh_n', 'ホワイティうめだ ノースモール', { x: 347.0, z: -40.0 }, 'B1', { ...B1, label: true });
  b.j('f_izumi', '泉の広場', { x: 556.0, z: 48.0 }, 'B1', { ...B1, label: true });
  // B1 below the south end of the 南北コンコース (阪急うめだ本店 SW corner), on the way to the mall.
  b.j('f_hksw_b1', '阪急うめだ本店 南西角 地下', { x: 262.0, z: 42.0 }, 'B1', B1);
  b.vertical('f_hk_sw', 'f_hksw_b1', ['stairs'], { anchor: 'top' });
  b.j('f_hknw_b1', '阪急うめだ本店 北西角 地下', { x: 201.0, z: -65.0 }, 'B1', B1);
  b.path(['f_hkd_b1', 'f_hknw_b1', 'f_hksw_b1'], { name: '阪急うめだ本店 地下1階前', busy: 2 });
  b.walk('f_hksw_b1', 'f_wh_c', { name: 'ホワイティうめだ', busy: 2 });
  b.path(['f_hs_se_b1', 'f_wh_sw', 'f_wh_c', 'f_wh_e', 'f_izumi'], { name: 'ホワイティうめだ', busy: 2 });
  b.path(['f_wh_n', 'f_wh_e', 't_n_out'], { name: 'ホワイティうめだ', busy: 2 });

  // ディアモール大阪 (OSM): 円形広場 south of 阪神梅田本店 is the hub. The spine runs straight south
  // (≈200 m) and drops to the 北新地 concourse right at its end, by the big 北新地 sign (西改札 to the
  // right, 東改札 to the left); a cross mall runs east along the 大阪駅前第2ビル, the diagonal south-east
  // past 梅田DTタワー, the arm east-north-east along the store's south side to ホワイティ and 東梅田,
  // and the west arm to 西梅田.
  b.j('f_dm_c', 'ディアモール 円形広場', { x: 146.8, z: 225.4 }, 'B1', { ...B1, label: true });
  b.j('f_dm_sm', 'ディアモール大阪 南北通路（中ほど）', { x: 144.5, z: 337.2 }, 'B1', B1);
  b.j('f_dm_s', 'ディアモール 南北通路（北新地方面）', { x: 143.0, z: 429.0 }, 'B1', B1);
  b.path(['f_dm_c', 'f_dm_sm', 'f_dm_s'], { name: 'ディアモール大阪（北新地方面）', busy: 2, width: 12 });
  b.vertical('f_dm_s', 'ks_mid_out', ['stairs', 'esc'], { name: '北新地駅への階段', bearingUp: 1, anchor: 'bottom' });
  b.j('f_dm_e', 'ディアモール大阪 東', { x: 205.7, z: 261.5 }, 'B1', B1);
  b.j('f_dm_se', 'ディアモール大阪 南東（大阪駅前第2ビル前）', { x: 245.8, z: 336.8 }, 'B1', B1);
  b.path(['f_dm_c', 'f_dm_e', 'f_dm_se'], { name: 'ディアモール大阪', busy: 2, width: 10 });
  b.j('f_dm_ne', 'ディアモール大阪 北東（阪神梅田本店 東側）', { x: 285.7, z: 143.1 }, 'B1', B1);
  b.path(['f_dm_c', 'f_dm_ne', 't_n_out'], { name: 'ディアモール〜東梅田 連絡通路', busy: 2 });
  b.walk('f_dm_ne', 'f_hs_se_b1', { name: 'ディアモール〜御堂筋線南改札', busy: 2 });
  // Public N–S passage from 中央南口 B1 over the 阪神 platforms and along the west side of the store
  // to 円形広場: the 百貨店口 on its west side, then the store's food floor on its east side
  // (osaka-station.net; OSM).
  b.j('f_hs_psg_b1', '阪神梅田本店 地下1階 南北通路（食品売場前）', { x: 120.5, z: 180.0 }, 'B1', B1);
  b.path(['f_chuo_b1', 'hs_c_out', 'f_hs_psg_b1', 'f_dm_c'], { name: '阪神梅田本店 地下南北通路', busy: 2, width: 8 });
  b.j('f_dm_nw', 'ディアモール大阪 西通路（北）', { x: 40.2, z: 222.1 }, 'B1', B1);
  b.j('f_dm_wc', 'ディアモール大阪 西通路', { x: 25.3, z: 268.6 }, 'B1', B1);
  b.j('f_dm_w', 'ディアモール大阪 西（西梅田側）', { x: 12.0, z: 291.8 }, 'B1', B1);
  b.path(['f_hs_psg_b1', 'f_dm_nw', 'f_dm_wc', 'f_dm_w'], { name: 'ディアモール大阪（西梅田方面）', busy: 2 });
  // 西梅田 lies under 四つ橋筋 with a free B1 corridor over it (OSM); around the gate concourses at
  // its ends the corridor keeps to the east side, outside the station box.
  b.j('f_yn_e_b1', '西梅田駅東側 地下通路（北）', { x: 12.0, z: 258.0 }, 'B1', B1);
  b.path(['f_dm_w', 'f_yn_e_b1', 'y_n_out'], { busy: 2 });

  // 大阪駅前ビル地下 (第2〜第4ビル) → 東梅田 南改札. The 第2ビル B2 entrance is 「東改札の目の前」.
  b.j('f_ek2_b2', '大阪駅前第2ビル 地下2階入口', { x: 205.0, z: 432.0 }, 'B2', { y: -10 });
  b.walk('ks_e_out', 'f_ek2_b2', { name: '北新地駅 東口通路' });
  b.j('f_ek2_b1', '大阪駅前第2ビル 地下1階', { x: 212.0, z: 352.0 }, 'B1', B1);
  b.j('f_ek2_b1s', '大阪駅前第2ビル 地下1階（北新地駅への階段上）', { x: 207.0, z: 416.0 }, 'B1', B1);
  b.vertical('f_ek2_b2', 'f_ek2_b1s', ['stairs', 'esc', 'elev'], { bearingUp: 7, anchor: 'bottom' });
  b.walk('f_ek2_b1s', 'f_ek2_b1', { name: '大阪駅前第2ビル 地下1階' });
  b.path(['f_dm_sm', 'f_ek2_b1', 'f_dm_se'], { name: 'ディアモール大阪', busy: 1 });
  b.j('f_ek3_b1', '大阪駅前第3ビル 地下1階', { x: 325.0, z: 395.0 }, 'B1', B1);
  b.j('f_ek4_b1', '大阪駅前第4ビル 地下1階', { x: 295.0, z: 300.0 }, 'B1', B1);
  b.path(['f_ek2_b1', 'f_ek3_b1', 't_s_out'], { name: '大阪駅前ビル地下', busy: 1 });
  b.path(['f_dm_se', 'f_ek4_b1', 't_s_out'], { name: '大阪駅前ビル地下（第4ビル）', busy: 1 });

  // 北新地 西改札 ↔ 西梅田 南改札 (1–3 min): the 地下鉄（西梅田）連絡口 right outside 西改札 climbs west
  // to the B1 passage under 四つ橋筋 (西梅田 南改札 to the north, ドーチカ to the south).
  b.j('f_ksw_b1', '地下鉄（西梅田）連絡口 地下1階', { x: -9.0, z: 429.0 }, 'B1', B1);
  b.vertical('ks_w_out', 'f_ksw_b1', ['stairs', 'esc'], { name: '地下鉄（西梅田）連絡口', bearingUp: 281, anchor: 'top' });
  b.walk('f_ksw_b1', 'y_s_out', { name: '西梅田 南改札への連絡通路', busy: 1 });
  // Free passage along the east side of 西梅田 station north to ディアモール西 (阪神西口・ハービス方面).
  b.j('f_ys_e_b1', '西梅田駅東側 地下通路（南）', { x: 6.0, z: 382.0 }, 'B1', B1);
  b.path(['y_s_out', 'f_ys_e_b1', 'f_dm_w'], { name: '西梅田駅東側 地下通路', busy: 1 });

  // 西梅田 北改札 ↔ JR 桜橋口 / KITTE大阪 / ハービス: north of the gate the corridor meets the
  // ガーデンアベニュー (west to ハービス, past KITTE) and the passage north-west to under 桜橋口 (OSM).
  b.j('f_ga_b1', 'ガーデンアベニュー（西梅田 北改札北側）', { x: -12.7, z: 206.4 }, 'B1', B1);
  b.j('f_sak_b1', 'JR桜橋口 地下', { x: -55.0, z: 108.0 }, 'B1', B1);
  b.path(['y_n_out', 'f_ga_b1', 'f_hsnw_b1', 'f_sak_b1'], { name: '西梅田〜桜橋口 地下通路', busy: 1 });
  b.vertical('jr_sak_out', 'f_sak_b1', ['stairs', 'esc']);
  b.j('f_ga_w', 'ガーデンアベニュー（ハービス方面）', { x: -93.6, z: 240.1 }, 'B1', B1);
  b.walk('f_ga_b1', 'f_ga_w', { name: 'ガーデンアベニュー', busy: 1 });
  b.j('f_kitte_b1', 'KITTE大阪 地下1階', { x: -135.0, z: 215.0 }, 'B1', B1);
  b.vertical('f_kitte1', 'f_kitte_b1', ['esc', 'elev']);
  b.walk('f_kitte_b1', 'f_ga_w', { name: 'KITTE大阪〜ガーデンアベニュー 地下通路' });

  // ------------------------------------------------------------------ street entrances (crowd sources/sinks)
  // On the mapped building outlines (a door) or inside a basement mall; `indoor` where the walk to the
  // network runs through the building.
  const ent = (id: string, name: string, at: Pos, to: string, level = '1F', indoor = level === 'B1') => {
    b.node(id, 'entrance', name, at, level, level === 'B1' ? B1 : level === '2F' ? D2 : {});
    b.walk(id, to, { indoor, name });
  };
  ent('e_yodobashi', 'ヨドバシ梅田', { x: 84.0, z: -168.0 }, 'f_deck_y', '2F');
  ent('e_hkdept', '阪急うめだ本店', { x: 234.0, z: 6.0 }, 'f_hk_cm');
  ent('e_gfo', 'グランフロント大阪', { x: -75.0, z: -150.0 }, 'f_gfo_b1', 'B1');
  ent('e_ggo', 'グラングリーン大阪 南館', { x: -300.0, z: -19.0 }, 'f_ggo2', '2F');
  b.node('e_ggo_b1', 'entrance', 'グラングリーン大阪 南館（地下）', { x: -301.0, z: -12.0 }, 'B1', { y: -7 });
  b.walk('e_ggo_b1', 'f_ggo_b1', { indoor: true, name: 'グラングリーン大阪 南館（地下）' });
  ent('e_park', 'うめきた公園', { x: -305.0, z: -40.0 }, 'f_sp1');
  ent('e_kitte', 'KITTE大阪・JPタワー', { x: -86.0, z: 209.0 }, 'f_kitte1', '1F', true);
  ent('e_herbis', 'ハービスOSAKA', { x: -100.0, z: 271.0 }, 'f_ga_w', 'B1');
  // Inside ドーチカ (堂島地下センター) under 四つ橋筋, ≈65 m south of 桜橋交差点.
  ent('e_sakurabashi', 'ドーチカ（堂島地下センター）・桜橋', { x: -14.7, z: 510.0 }, 'f_ksw_b1', 'B1');
  ent('e_shindo', '梅田新道', { x: 398.0, z: 448.0 }, 'f_ek3_b1', 'B1');
  ent('e_ohatsu', 'お初天神・曽根崎', [34.7015, 135.5029], 'f_izumi', 'B1');
  ent('e_hep', 'HEP FIVE・東通り', { x: 358.0, z: -75.0 }, 'f_wh_n', 'B1');
  ent('e_hanshin', '阪神梅田本店（地下1階 食品売場）', { x: 147.0, z: 181.0 }, 'f_hs_psg_b1', 'B1');
  ent('e_daimaru', '大丸梅田店', { x: 70.0, z: 122.0 }, 'f_daimaru1', '1F', true);
}
