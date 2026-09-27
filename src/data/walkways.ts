import type { NetBuilder } from './builder';

/**
 * Free (outside-the-gates) pedestrian network: street level around JR大阪駅, the 2F decks,
 * 梅田新歩道橋, and the B1 malls (阪急三番街, ホワイティうめだ, ディアモール大阪, 大阪駅前ビル地下,
 * ルクア/グランフロント地下). Station gate "…_out" nodes are defined in the station modules.
 */
export function addWalkways(b: NetBuilder): void {
  const B1 = { y: -6 };
  const D2 = { y: 6 }; // outdoor decks / pedestrian bridges

  // ------------------------------------------------------------------ JR大阪駅 1F (free concourses)
  // The 中央コンコース runs square to the tracks under the 南北連絡橋, from 中央南口 (大丸) to
  // 暁の広場 under the ノースゲートビル atrium (中央北口).
  b.j('f_chuo_s', '中央南口', [34.70195, 135.496247], '1F', { label: true });
  b.j('f_chuo_mid', '中央コンコース（地下への階段上）', [34.70215, 135.496187], '1F');
  b.j('f_chuo_n', '中央北口（暁の広場）', [34.70315, 135.495885], '1F', { label: true });
  b.path(['f_chuo_s', 'f_chuo_mid', 'jr_chuo_out', 'f_chuo_n'], { name: '中央コンコース', busy: 3, width: 20 });
  b.j('f_mido_s', '御堂筋南口', [34.7023, 135.4976], '1F', { label: true });
  // 御堂筋北口 is the north exit of the concourse, just north of the 11番 platform.
  b.j('f_mido_n', '御堂筋北口', [34.70342, 135.49775], '1F', { label: true });
  b.path(['f_mido_s', 'jr_mido_out', 'f_mido_n'], { name: '御堂筋口コンコース', busy: 3, width: 15 });

  // South side along the bus terminal (canopy, but open to the street).
  b.j('f_s_west', '大阪駅南側（エキマルシェ前）', [34.70188, 135.4958], '1F');
  b.path(['jr_sak_out', 'f_s_west', 'f_chuo_s', 'jr_minami_out', 'f_mido_s'], { name: '大阪駅前 バスターミナル沿い', indoor: false, busy: 2, width: 8 });
  b.walk('jr_ekim_out', 'f_s_west', { name: 'エキマルシェ大阪' });

  // ------------------------------------------------------------------ 阪急方面 (1F / 2F)
  b.j('f_hk_w', '阪急うめだ本店 西側', [34.7032, 135.49865], '1F', { label: true });
  // The signalled crosswalk only spans 国道176号 (≈40 m): sidewalk at the JR end, the 東西コンコース
  // (JR大阪駅 ↔ HEP NAVIO side) at the Hankyu end.
  b.j('f_mido_n_x', '御堂筋北口前 横断歩道 西詰', [34.70338, 135.49792], '1F');
  b.j('f_hk_x', '阪急前 横断歩道 東詰（東西コンコース西端）', [34.70331, 135.49836], '1F');
  b.walk('f_mido_n', 'f_mido_n_x', { indoor: false, busy: 3, width: 12 });
  b.cross('f_mido_n_x', 'f_hk_x', '阪急百貨店前 横断歩道', 40, { busy: 3, width: 12 });
  b.walk('f_hk_x', 'f_hk_w', { name: '東西コンコース', busy: 3, width: 12 });
  // Japan's first moving walkway (1967), north under the JR tracks to the 3F-gate escalators:
  // model the belts as a shorter effective length.
  b.walk('f_hk_w', 'hk_1f_foot', { name: '阪急 動く歩道', length: 95, busy: 3, width: 10 });
  // At the foot of the 3F escalators a side passage runs west (BIGMAN / 紀伊國屋), past the
  // escalator down to the 阪急三番街 mall, then north to 三番街 1F.
  b.walk('hk_1f_foot', 'hk_1f_w', { name: 'BIGMAN前', busy: 2 });
  b.walk('hk_1f_w', 'hk_1f_sanbangai', { name: '阪急三番街 1階', busy: 2 });
  // 南北コンコース (100 m × 16.5 m, 2012) along the store, with the way down to B1 at its south end.
  b.j('f_hk_sw', '阪急うめだ本店 南西角', [34.70268, 135.499], '1F');
  b.walk('f_hk_w', 'f_hk_sw', { name: '南北コンコース（阪急うめだ本店）', indoor: true, width: 16, busy: 2 });

  // Open-air 2F slope: the escalator right in front of 御堂筋北口 goes up to a straight slope past
  // ヨドバシ梅田 that lands on the Hankyu complex at 2F (阪急三番街 side of the 2階中央改札).
  b.j('f_deck_jr', '御堂筋北口 2階デッキ', [34.70356, 135.49779], '2F', D2);
  b.vertical('f_mido_n', 'f_deck_jr', ['stairs', 'esc'], { indoor: false, bearingUp: 13, anchor: 'bottom' });
  b.j('f_deck_mid', 'ヨドバシ前 2階デッキ', [34.7046, 135.49795], '2F', D2);
  b.path(['f_deck_jr', 'f_deck_mid'], { name: '2階歩道橋（屋根なし）', indoor: false, busy: 1 });
  b.j('hk_2f_w', '阪急三番街 2階 南西（歩道橋着地）', [34.70545, 135.498], '2F', { y: 5.5 });
  b.walk('f_deck_mid', 'hk_2f_w', { name: '2階スロープ（屋根なし）', indoor: false, busy: 1 });
  b.walk('hk_2f_w', 'hk_2f_out', { name: '2階通路' });
  // 「スロープから1階に降りるポイント」 next to the foot of the 3F escalators.
  b.stairs('f_deck_mid', 'hk_1f_w', { indoor: false, anchor: 'top' });

  // 梅田新歩道橋 (2F) over the 梅田 intersection.
  b.j('f_bridge', '梅田新歩道橋', [34.70205, 135.4986], '2F', { ...D2, label: true });
  b.j('f_bridge_nw', '梅田新歩道橋 北西', [34.70225, 135.4979], '2F', D2);
  b.j('f_bridge_ne', '梅田新歩道橋 北東', [34.7026, 135.4991], '2F', D2);
  b.j('f_bridge_sw', '梅田新歩道橋 南西', [34.7014, 135.49805], '2F', D2);
  b.j('f_bridge_se', '梅田新歩道橋 南東', [34.70155, 135.49945], '2F', D2);
  for (const leg of ['f_bridge_nw', 'f_bridge_ne', 'f_bridge_sw', 'f_bridge_se']) b.walk('f_bridge', leg, { name: '梅田新歩道橋', indoor: false, busy: 2 });
  // Each leg's stair head is at the deck end; which way it runs down is not documented.
  b.stairs('f_bridge_nw', 'f_mido_s', { indoor: false, anchor: 'top' });
  b.stairs('f_bridge_ne', 'f_hk_sw', { indoor: false, anchor: 'top' });
  b.esc('f_bridge_ne', 'f_hk_sw', 'both', { indoor: false });
  b.j('f_hs_ne', '阪神梅田本店 北東角', [34.70135, 135.4979], '1F');
  b.stairs('f_bridge_sw', 'f_hs_ne', { indoor: false, anchor: 'top' });
  b.j('f_umeda_se', '梅田交差点 南東（新御堂筋側）', [34.7015, 135.4996], '1F');
  b.stairs('f_bridge_se', 'f_umeda_se', { indoor: false, anchor: 'top' });

  // Street crossings in front of the station.
  b.cross('f_mido_s', 'f_hs_ne', '大阪駅前 横断歩道（御堂筋南口→阪神）', 35, { busy: 2 });
  b.j('f_hs_n', '阪神梅田本店 北側', [34.70135, 135.4967], '1F');
  b.cross('f_chuo_s', 'f_hs_n', 'バスターミナル前 横断歩道', 35, { busy: 2 });
  b.walk('f_hs_n', 'f_hs_ne', { name: '阪神梅田本店前', indoor: false });

  // ------------------------------------------------------------------ JR大阪駅 north side (2F/3F decks)
  // The 3F 南北連絡橋 on the 中央 stack line: 大丸 4F in the south, the ルクア / ルクア1100
  // boundary (the atrium) in the north. The アトリウム広場 is straight above 暁の広場.
  b.j('f_br_n', '南北連絡橋 北端（ルクア3階）', [34.7032, 135.495765], '3F', { y: 15 });
  b.j('f_br_s', '南北連絡橋 南端（大丸梅田店4階）', [34.70185, 135.496173], '3F', { y: 15 });
  b.path(['f_br_s', 'jr_br_out', 'f_br_n'], { name: '南北連絡橋', busy: 2, width: 12 });
  b.j('f_atrium', 'アトリウム広場（ノースゲートビル2階）', [34.703305, 135.495825], '2F', { label: true, y: 7 });
  b.vertical('f_br_n', 'f_atrium', ['stairs', 'esc', 'elev'], { bearingUp: 166, anchor: 'top' });
  b.vertical('f_chuo_n', 'f_atrium', ['esc', 'elev'], { bearingUp: 346, anchor: 'bottom' });
  b.j('f_daimaru1', '大丸梅田店 1階', [34.70175, 135.4963], '1F');
  b.vertical('f_br_s', 'f_daimaru1', ['esc', 'elev'], { name: '大丸梅田店 店内' });
  b.walk('f_daimaru1', 'f_chuo_s', { name: '大丸梅田店前' });
  b.j('f_gfo2', 'グランフロント大阪 南館2階デッキ', [34.704, 135.4951], '2F');
  // The deck crosses うめきた広場 (in front of 中央北口) before turning west to GFO 南館.
  b.j('f_gfo2p', 'うめきた広場 2階デッキ', [34.7041, 135.4959], '2F');
  b.path(['f_atrium', 'f_gfo2p', 'f_gfo2'], { name: 'ノースゲート〜グランフロント 2階デッキ', indoor: false, busy: 2 });
  b.j('f_inogate2', 'イノゲート大阪 2階', [34.7029, 135.49385], '2F');
  b.walk('f_atrium', 'f_inogate2', { name: 'ノースゲート〜イノゲート 2階デッキ', indoor: false });

  // ------------------------------------------------------------------ 西口 / うめきた (1F)
  // The 西口 free passage runs N–S through イノゲート 1F (KITTE to the south); across the street to
  // the north stands うめきたグリーンプレイス (UGP), built over the うめきた地下口 concourse.
  b.j('f_inogate1', 'イノゲート大阪 1階', [34.7028, 135.4938], '1F');
  b.walk('jr_nishi_out', 'f_inogate1', { name: '西口 南北通路' });
  b.vertical('f_inogate1', 'f_inogate2', ['esc', 'elev']);
  b.j('f_uk_x', 'うめきた側 横断歩道北詰（イノゲート北）', [34.70318, 135.49376], '1F');
  b.cross('f_inogate1', 'f_uk_x', 'イノゲート前 横断歩道（梅田ランプ東方面）', 40, { busy: 1 });
  b.j('f_ugp1', 'うめきたグリーンプレイス 1階', [34.70359, 135.493756], '1F');
  b.walk('f_uk_x', 'f_ugp1', { name: 'うめきたグリーンプレイス 1階（公共広場）', indoor: false });
  // 大阪駅（うめきたエリア）地上出口: from the B1 corridor east of the gate, on its south side, up
  // into UGP 1F (rises southward; f_ugp1 is just past the head of the 7 m stair, ≈19 m south).
  b.vertical('uk_b1_e', 'f_ugp1', ['stairs', 'esc', 'elev'], { name: '大阪駅（うめきたエリア）地上出口', bearingUp: 180, anchor: 'bottom' });
  // 2F decks: イノゲート 2F → UGP 2F → グラングリーン大阪 南館 2F (opened 2024-12 and 2025-04-11).
  b.j('f_ugp2', 'うめきたグリーンプレイス 2階（歩行者デッキ）', [34.70325, 135.49368], '2F', D2);
  b.walk('f_inogate2', 'f_ugp2', { name: 'イノゲート〜うめきたグリーンプレイス 歩行者デッキ', indoor: false });
  b.vertical('f_ugp1', 'f_ugp2', ['esc', 'elev'], { anchor: 'top' });
  b.j('f_ggo2', 'グラングリーン大阪 南館 2階', [34.7033, 135.4923], '2F', D2);
  b.walk('f_ugp2', 'f_ggo2', { name: '歩行者デッキ（グラングリーン大阪 南館方面）', indoor: false });
  // うめきた公園 サウスパーク: turn left (west) out of the gate; the escalator ahead rises west to
  // the park under the 大屋根, and the B1 corridor carries straight on into GGO 南館.
  b.j('f_sp1', 'うめきた公園 サウスパーク（大屋根下）', [34.703761, 135.493101], '1F', { label: true });
  b.vertical('uk_sp_b1', 'f_sp1', ['esc'], { name: 'うめきた公園への出口', bearingUp: 270, anchor: 'bottom' });
  b.walk('f_sp1', 'f_ugp1', { name: 'うめきた公園〜グリーンプレイス', indoor: false });
  // Level with the gate-front corridor (a sloping corridor would roof over the park escalator).
  b.j('f_ggo_b1', 'グラングリーン大阪 南館 地下1階（タイムアウトマーケット）', [34.7034, 135.4922], 'B1', { y: -7 });
  b.walk('uk_sp_b1', 'f_ggo_b1', { name: 'うめきた地下通路（グラングリーン大阪 南館方面）', busy: 1 });
  b.j('f_kitte1', 'KITTE大阪 1階', [34.7013, 135.4942], '1F');
  b.walk('jr_nishi_out', 'f_kitte1', { name: '西口 南北通路' });
  // GFO うめきた広場: directly in front of JR 中央北口, with うめきたセラー on B1 beneath it.
  b.j('f_gfo1', 'グランフロント大阪 うめきた広場', [34.70425, 135.4959], '1F', { label: true });
  b.vertical('f_gfo2p', 'f_gfo1', ['stairs', 'esc'], { anchor: 'bottom' });
  b.walk('f_gfo1', 'f_ugp1', { name: 'うめきた広場〜グリーンプレイス', indoor: false });

  // ------------------------------------------------------------------ B1: north (ルクア・グランフロント・阪急三番街)
  b.j('f_lucua_b1', 'ルクア地下1階（バルチカ）', [34.703305, 135.495825], 'B1', B1);
  b.vertical('f_chuo_n', 'f_lucua_b1', ['stairs', 'esc'], { anchor: 'top' });
  b.j('f_ucellar_b1', 'うめきたセラー（うめきた広場 地下1階）', [34.7044, 135.4959], 'B1', B1);
  b.vertical('f_gfo1', 'f_ucellar_b1', ['stairs', 'esc', 'elev'], { anchor: 'mid' });
  b.j('f_gfo_b1', 'グランフロント大阪 南館地下1階', [34.7041, 135.4949], 'B1', B1);
  b.path(['f_lucua_b1', 'f_ucellar_b1', 'f_gfo_b1', 'uk_b1_e'], { name: 'ルクア〜グランフロント〜うめきた地下通路', busy: 1 });
  b.j('f_midon_b1', 'JR御堂筋北口 地下', [34.7032, 135.4977], 'B1', B1);
  b.walk('f_lucua_b1', 'f_midon_b1', { name: 'ルクア地下通路', busy: 2 });
  // Must stay clear of the 2F-slope escalator that rises NNE from the same exit.
  b.vertical('f_mido_n', 'f_midon_b1', ['stairs', 'esc', 'elev'], { anchor: 'top' });
  b.walk('f_midon_b1', 'm_n_out', { name: '御堂筋線北改札前通路', busy: 3 });
  b.j('f_hkd_b1', '阪急うめだ本店 地下1階前', [34.7033, 135.4989], 'B1', { ...B1, label: false });
  b.walk('m_n_out', 'f_hkd_b1', { busy: 3 });
  b.vertical('f_hk_w', 'f_hkd_b1', ['stairs', 'esc', 'elev'], { busy: 3, anchor: 'top' });
  b.j('f_3b_b1', '阪急三番街 地下1階', [34.7054, 135.4983], 'B1', B1);
  b.vertical('hk_1f_sanbangai', 'f_3b_b1', ['stairs', 'esc', 'elev'], { anchor: 'top' });
  b.j('f_3b_s', '阪急三番街 南端（地下1階）', [34.7042, 135.49855], 'B1', B1);
  b.path(['f_3b_b1', 'f_3b_s', 'm_n_out'], { name: '阪急三番街', busy: 2 });
  // 「地下街に続くエスカレーター」 beside the side passage at the foot of the 3F escalators: the
  // short way from the 3F gate down to the 御堂筋線 北改札. Only the way down is documented (no
  // stairs, no up escalator confirmed); an up escalator here would put 御堂筋線北改札→阪急3階改札
  // at ≈3.4 min, well under the published 5〜10 min.
  b.vertical('hk_1f_w', 'f_3b_s', ['esc-down'], { name: '阪急三番街（地下）へのエスカレーター', anchor: 'top' });

  // ------------------------------------------------------------------ B1: JR大阪駅前 / 阪神 / ホワイティうめだ
  b.j('f_jrf_b1', 'JR大阪駅前 地下（御堂筋南口下）', [34.7021, 135.49775], 'B1', { ...B1, label: false });
  b.vertical('f_mido_s', 'f_jrf_b1', ['stairs', 'esc', 'elev'], { busy: 3, bearingUp: 328, anchor: 'top' });
  // Free corridor along the west side of the 御堂筋線 station: JR御堂筋南口 → 中改札 → 阪神東口 →
  // 南改札 (where ディアモール and ホワイティ branch off), one straight chain.
  b.j('f_hsne_b1', '阪神梅田本店 東側地下', [34.70124, 135.49795], 'B1', B1);
  b.j('f_hs_se_b1', '阪神梅田本店 南東角 地下（南改札・ディアモール・ホワイティ分岐）', [34.70048, 135.49815], 'B1', B1);
  b.path(['f_jrf_b1', 'm_c_out', 'f_hsne_b1', 'hs_e_out', 'f_hs_se_b1', 'm_s_out'], { name: '梅田地下街（阪神東口）', busy: 3 });
  b.j('f_chuo_b1', '阪神梅田本店前 地下（中央南口方面）', [34.70158, 135.4968], 'B1', B1);
  // The stairs to B1 are in the 中央コンコース ≈50 m south of the gate, going down heading south
  // into the passage under 大丸 towards 阪神.
  b.j('f_chuo_s_b1', '中央南口 地下（大丸前）', [34.70201, 135.496229], 'B1', B1);
  b.vertical('f_chuo_mid', 'f_chuo_s_b1', ['stairs', 'esc', 'elev'], { bearingUp: 346, anchor: 'top' });
  b.walk('f_chuo_s_b1', 'f_chuo_b1', { name: '大丸梅田店 地下通路' });
  b.vertical('f_hs_n', 'f_chuo_b1', ['stairs'], { anchor: 'top' });
  b.j('f_hsnw_b1', '阪神梅田本店 西側地下', [34.70142, 135.4958], 'B1', B1);
  b.path(['f_hsnw_b1', 'f_chuo_b1', 'f_hsne_b1'], { name: '阪神梅田本店 北側地下通路', busy: 2 });
  b.walk('f_hsnw_b1', 'hs_w_out', { busy: 1 });
  // Sidewalk stair at the store's NE corner, parallel to the façade (up = east, towards 御堂筋).
  b.vertical('f_hs_ne', 'f_hsne_b1', ['stairs'], { bearingUp: 97, anchor: 'top' });

  // ホワイティうめだ: north mall along the east side of the 御堂筋線, then east to 泉の広場.
  b.j('f_wh_n', 'ホワイティうめだ ノースモール', [34.7021, 135.49915], 'B1', { ...B1, label: true });
  b.j('f_wh_sw', 'ホワイティうめだ 御堂筋線南改札前', [34.70055, 135.4989], 'B1', B1);
  b.j('f_wh_c', 'ホワイティうめだ センターモール', [34.70075, 135.4998], 'B1', B1);
  b.j('f_izumi', '泉の広場', [34.70155, 135.5017], 'B1', { ...B1, label: true });
  // B1 below the south end of the 南北コンコース (阪急うめだ本店 SW corner), on the way to the mall.
  b.j('f_hksw_b1', '阪急うめだ本店 南西角 地下', [34.70253, 135.49903], 'B1', B1);
  b.vertical('f_hk_sw', 'f_hksw_b1', ['stairs'], { anchor: 'top' });
  b.walk('f_hkd_b1', 'f_hksw_b1', { name: '阪急うめだ本店 地下1階前', busy: 2 });
  b.path(['f_hksw_b1', 'f_wh_n', 'f_wh_c'], { name: 'ホワイティうめだ', busy: 2 });
  b.path(['m_s_out', 'f_wh_sw', 'f_wh_c', 't_n_out', 'f_izumi'], { name: 'ホワイティうめだ', busy: 2 });

  // ディアモール大阪 (south of 阪神) and the corridor down to 北新地.
  b.j('f_dm_w', 'ディアモール大阪 西（西梅田側）', [34.69995, 135.4957], 'B1', B1);
  b.j('f_dm_c', 'ディアモール 円形広場', [34.6999, 135.497], 'B1', { ...B1, label: true });
  b.j('f_dm_e', 'ディアモール大阪 東', [34.6999, 135.4983], 'B1', B1);
  b.path(['f_dm_w', 'f_dm_c', 'f_dm_e'], { name: 'ディアモール大阪', busy: 2, width: 12 });
  // Public N–S passage from 中央南口 B1 through the store's B1 to 円形広場: the food floor opens on
  // its east side, the 百貨店口 on its west side (osaka-station.net).
  b.j('f_hs_psg_b1', '阪神梅田本店 地下1階 南北通路（食品売場前）', [34.7011, 135.49686], 'B1', B1);
  b.path(['f_chuo_b1', 'f_hs_psg_b1', 'hs_c_out', 'f_dm_c'], { name: '阪神梅田本店 地下南北通路', busy: 2, width: 8 });
  b.walk('f_dm_e', 'm_s_out', { busy: 2 });
  b.walk('f_dm_e', 'f_wh_sw', { name: 'ディアモール〜ホワイティ連絡' });
  // Along the east side of 西梅田, just outside its platform and track box.
  b.j('f_yn_e_b1', '西梅田駅東側 地下通路（北）', [34.700757, 135.495613], 'B1', B1);
  b.path(['f_dm_w', 'f_yn_e_b1', 'y_n_out'], { busy: 2 });
  b.walk('hs_w_out', 'y_n_out', { name: '西梅田・阪神西口連絡通路', busy: 1 });
  // The spine runs straight south from 円形広場 (≈200 m) and drops to the 北新地 concourse right at
  // its end, by the big 北新地 sign (西改札 to the right, 東改札 to the left).
  b.j('f_dm_s', 'ディアモール 南北通路（北新地方面）', [34.698554, 135.496965], 'B1', B1);
  b.walk('f_dm_c', 'f_dm_s', { name: 'ディアモール大阪（北新地方面）', busy: 2 });
  b.vertical('f_dm_s', 'ks_mid_out', ['stairs', 'esc'], { name: '北新地駅への階段', bearingUp: 1, anchor: 'bottom' });

  // 大阪駅前ビル地下 (第2〜第4ビル) → 東梅田 南改札. The 第2ビル B2 entrance is 「東改札の目の前」.
  b.j('f_ek2_b2', '大阪駅前第2ビル 地下2階入口', [34.69846, 135.49796], 'B2', { y: -10 });
  b.walk('ks_e_out', 'f_ek2_b2', { name: '北新地駅 東口通路' });
  b.j('f_ek2_b1', '大阪駅前第2ビル 地下1階', [34.69925, 135.4982], 'B1', B1);
  b.vertical('f_ek2_b2', 'f_ek2_b1', ['stairs', 'esc', 'elev'], { bearingUp: 7, anchor: 'bottom' });
  b.walk('f_ek2_b1', 'f_dm_e', { name: '大阪駅前ビル〜ディアモール' });
  b.j('f_ek3_b1', '大阪駅前第3ビル 地下1階', [34.69925, 135.499], 'B1', B1);
  b.j('f_ek4_b1', '大阪駅前第4ビル 地下1階', [34.6993, 135.4999], 'B1', B1);
  b.path(['f_ek2_b1', 'f_ek3_b1', 'f_ek4_b1', 't_s_out'], { name: '大阪駅前ビル地下', busy: 1 });

  // 北新地 西改札 ↔ 西梅田 南改札 (1–3 min): the 地下鉄（西梅田）連絡口 right outside 西改札 climbs west
  // to the B1 passage under 四つ橋筋 (西梅田 南改札 to the north, ドーチカ to the south).
  b.j('f_ksw_b1', '地下鉄（西梅田）連絡口 地下1階', [34.69866, 135.4957], 'B1', B1);
  b.vertical('ks_w_out', 'f_ksw_b1', ['stairs', 'esc'], { name: '地下鉄（西梅田）連絡口', bearingUp: 281, anchor: 'top' });
  b.walk('f_ksw_b1', 'y_s_out', { name: '西梅田 南改札への連絡通路', busy: 1 });
  // Free passage along the east side of 西梅田 station north to ディアモール西 (阪神西口・ハービス方面).
  b.j('f_ys_e_b1', '西梅田駅東側 地下通路（南）', [34.699183, 135.495773], 'B1', B1);
  b.path(['y_s_out', 'f_ys_e_b1', 'f_dm_w'], { name: '西梅田駅東側 地下通路', busy: 1 });

  // 西梅田 北改札 ↔ JR 桜橋口 / KITTE大阪.
  b.j('f_sak_b1', 'JR桜橋口 地下', [34.7015, 135.4953], 'B1', B1);
  b.path(['y_n_out', 'f_sak_b1', 'f_hsnw_b1'], { name: '西梅田〜桜橋口 地下通路', busy: 1 });
  b.vertical('jr_sak_out', 'f_sak_b1', ['stairs', 'esc']);
  b.j('f_kitte_b1', 'KITTE大阪 地下1階', [34.7011, 135.49445], 'B1', B1);
  b.vertical('f_kitte1', 'f_kitte_b1', ['esc', 'elev']);
  b.walk('f_kitte_b1', 'y_n_out', { name: 'KITTE大阪〜西梅田 地下通路' });

  // ------------------------------------------------------------------ street entrances (crowd sources/sinks)
  const ent = (id: string, name: string, at: [number, number], to: string, level = '1F') => {
    b.node(id, 'entrance', name, at, level, level === 'B1' ? B1 : level === '2F' ? D2 : {});
    b.walk(id, to, { indoor: level === 'B1', name });
  };
  ent('e_yodobashi', 'ヨドバシ梅田', [34.7044, 135.4968], 'f_deck_mid', '2F');
  ent('e_hkdept', '阪急うめだ本店', [34.703, 135.4994], 'f_hk_sw');
  ent('e_gfo', 'グランフロント大阪', [34.7047, 135.4944], 'f_gfo_b1', 'B1');
  ent('e_ggo', 'グラングリーン大阪 南館', [34.70345, 135.49185], 'f_ggo2', '2F');
  b.node('e_ggo_b1', 'entrance', 'グラングリーン大阪 南館（地下）', [34.70345, 135.49182], 'B1', { y: -7 });
  b.walk('e_ggo_b1', 'f_ggo_b1', { indoor: true, name: 'グラングリーン大阪 南館（地下）' });
  ent('e_park', 'うめきた公園', [34.70351, 135.49263], 'f_sp1');
  ent('e_kitte', 'KITTE大阪・JPタワー', [34.70105, 135.4938], 'f_kitte1');
  ent('e_herbis', 'ハービスOSAKA', [34.7003, 135.4944], 'f_dm_w', 'B1');
  // Inside ドーチカ (堂島地下センター) under 四つ橋筋, ≈65 m south of 桜橋交差点.
  ent('e_sakurabashi', 'ドーチカ（堂島地下センター）・桜橋', [34.6979, 135.49559], 'f_ksw_b1', 'B1');
  ent('e_shindo', '梅田新道', [34.6985, 135.4999], 'f_ek4_b1', 'B1');
  ent('e_ohatsu', 'お初天神・曽根崎', [34.7015, 135.5029], 'f_izumi', 'B1');
  ent('e_hep', 'HEP FIVE・東通り', [34.7035, 135.5003], 'f_wh_n', 'B1');
  ent('e_hanshin', '阪神梅田本店（地下1階 食品売場）', [34.70105, 135.49712], 'f_hs_psg_b1', 'B1');
  ent('e_daimaru', '大丸梅田店', [34.7015, 135.4962], 'f_daimaru1');
}
