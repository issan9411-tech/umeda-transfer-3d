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
  b.j('f_chuo_s', '中央南口', [34.70195, 135.4968], '1F', { label: true });
  b.j('f_chuo_n', '中央北口', [34.70315, 135.49655], '1F', { label: true });
  b.path(['f_chuo_s', 'jr_chuo_out', 'f_chuo_n'], { name: '中央コンコース', busy: 3, width: 25 });
  b.j('f_mido_s', '御堂筋南口', [34.7023, 135.4976], '1F', { label: true });
  b.j('f_mido_n', '御堂筋北口', [34.70305, 135.4976], '1F', { label: true });
  b.path(['f_mido_s', 'jr_mido_out', 'f_mido_n'], { name: '御堂筋口コンコース', busy: 3, width: 15 });

  // South side along the bus terminal (canopy, but open to the street).
  b.j('f_s_west', '大阪駅南側（エキマルシェ前）', [34.70188, 135.4958], '1F');
  b.path(['jr_sak_out', 'f_s_west', 'f_chuo_s', 'jr_minami_out', 'f_mido_s'], { name: '大阪駅前 バスターミナル沿い', indoor: false, busy: 2, width: 8 });
  b.walk('jr_ekim_out', 'f_s_west', { name: 'エキマルシェ大阪' });

  // ------------------------------------------------------------------ 阪急方面 (1F / 2F)
  b.j('f_hk_w', '阪急うめだ本店 西側', [34.7032, 135.49865], '1F', { label: true });
  b.cross('f_mido_n', 'f_hk_w', '阪急百貨店前 横断歩道', 40, { busy: 3, width: 12 });
  // Japan's first moving walkway (1967): model the belts as a shorter effective length.
  b.walk('f_hk_w', 'hk_1f_foot', { name: '阪急 動く歩道', length: 95, busy: 3, width: 10 });
  b.walk('hk_1f_foot', 'hk_1f_sanbangai', { name: '阪急三番街 1階', busy: 2 });
  b.j('f_hk_sw', '阪急うめだ本店 南西角', [34.70268, 135.499], '1F');
  b.walk('f_hk_w', 'f_hk_sw', { name: '阪急うめだ本店前', indoor: false });

  // Open-air 2F slope from 御堂筋北口 up to the Hankyu 2F central gate.
  b.j('f_deck_jr', '御堂筋北口 2階デッキ', [34.7034, 135.4977], '2F', D2);
  b.vertical('f_mido_n', 'f_deck_jr', ['stairs', 'esc'], { indoor: false });
  b.j('f_deck_mid', 'ヨドバシ前 2階デッキ', [34.7046, 135.49795], '2F', D2);
  b.path(['f_deck_jr', 'f_deck_mid'], { name: '2階歩道橋（屋根なし）', indoor: false, busy: 1 });
  b.walk('f_deck_mid', 'hk_2f_out', { name: '2階スロープ（屋根なし）', indoor: false, busy: 1 });

  // 梅田新歩道橋 (2F) over the 梅田 intersection.
  b.j('f_bridge', '梅田新歩道橋', [34.70205, 135.4986], '2F', { ...D2, label: true });
  b.j('f_bridge_nw', '梅田新歩道橋 北西', [34.70225, 135.4979], '2F', D2);
  b.j('f_bridge_ne', '梅田新歩道橋 北東', [34.7026, 135.4991], '2F', D2);
  b.j('f_bridge_sw', '梅田新歩道橋 南西', [34.7014, 135.49805], '2F', D2);
  b.j('f_bridge_se', '梅田新歩道橋 南東', [34.70155, 135.49945], '2F', D2);
  for (const leg of ['f_bridge_nw', 'f_bridge_ne', 'f_bridge_sw', 'f_bridge_se']) b.walk('f_bridge', leg, { name: '梅田新歩道橋', indoor: false, busy: 2 });
  b.stairs('f_bridge_nw', 'f_mido_s', { indoor: false });
  b.stairs('f_bridge_ne', 'f_hk_sw', { indoor: false });
  b.esc('f_bridge_ne', 'f_hk_sw', 'both', { indoor: false });
  b.j('f_hs_ne', '阪神梅田本店 北東角', [34.70135, 135.4979], '1F');
  b.stairs('f_bridge_sw', 'f_hs_ne', { indoor: false });
  b.j('f_umeda_se', '梅田交差点 南東（新御堂筋側）', [34.7015, 135.4996], '1F');
  b.stairs('f_bridge_se', 'f_umeda_se', { indoor: false });

  // Street crossings in front of the station.
  b.cross('f_mido_s', 'f_hs_ne', '大阪駅前 横断歩道（御堂筋南口→阪神）', 35, { busy: 2 });
  b.j('f_hs_n', '阪神梅田本店 北側', [34.70135, 135.4967], '1F');
  b.cross('f_chuo_s', 'f_hs_n', 'バスターミナル前 横断歩道', 35, { busy: 2 });
  b.walk('f_hs_n', 'f_hs_ne', { name: '阪神梅田本店前', indoor: false });

  // ------------------------------------------------------------------ JR大阪駅 north side (2F/3F decks)
  b.j('f_br_n', '南北連絡橋 北端（ルクア3階）', [34.7032, 135.4955], '3F', { y: 15 });
  b.j('f_br_s', '南北連絡橋 南端（大丸3階）', [34.70185, 135.4955], '3F', { y: 15 });
  b.path(['f_br_s', 'jr_br_out', 'f_br_n'], { name: '南北連絡橋', busy: 2, width: 12 });
  b.j('f_atrium', 'アトリウム広場（ノースゲートビル2階）', [34.7033, 135.4959], '2F', { label: true });
  b.vertical('f_br_n', 'f_atrium', ['stairs', 'esc', 'elev']);
  b.vertical('f_chuo_n', 'f_atrium', ['esc', 'elev']);
  b.j('f_daimaru1', '大丸梅田店 1階', [34.70175, 135.4963], '1F');
  b.vertical('f_br_s', 'f_daimaru1', ['esc', 'elev'], { name: '大丸梅田店 店内' });
  b.walk('f_daimaru1', 'f_chuo_s', { name: '大丸梅田店前' });
  b.j('f_gfo2', 'グランフロント大阪 南館2階デッキ', [34.704, 135.4951], '2F');
  b.walk('f_atrium', 'f_gfo2', { name: 'ノースゲート〜グランフロント 2階デッキ', indoor: false, busy: 2 });
  b.j('f_inogate2', 'イノゲート大阪 2階', [34.7029, 135.49385], '2F');
  b.walk('f_atrium', 'f_inogate2', { name: 'ノースゲート〜イノゲート 2階デッキ', indoor: false });

  // ------------------------------------------------------------------ 西口 / うめきた (1F)
  b.j('f_inogate1', 'イノゲート大阪 1階', [34.7028, 135.4938], '1F');
  b.walk('jr_nishi_out', 'f_inogate1', { name: '西口 南北通路' });
  b.vertical('f_inogate1', 'f_inogate2', ['esc', 'elev']);
  b.j('f_ugp1', 'うめきたグリーンプレイス 1階', [34.7033, 135.4934], '1F');
  b.walk('f_inogate1', 'f_ugp1', { name: 'うめきたグリーンプレイス前', indoor: false });
  b.vertical('f_ugp1', 'uk_gate_out', ['stairs', 'esc', 'elev'], { name: 'うめきた地上出口' });
  b.j('f_kitte1', 'KITTE大阪 1階', [34.7013, 135.4942], '1F');
  b.walk('jr_nishi_out', 'f_kitte1', { name: '西口 南北通路' });
  b.j('f_gfo1', 'グランフロント大阪 うめきた広場', [34.70348, 135.49455], '1F', { label: true });
  b.vertical('f_gfo2', 'f_gfo1', ['stairs', 'esc']);
  b.walk('f_gfo1', 'f_ugp1', { name: 'うめきた広場〜グリーンプレイス', indoor: false });

  // ------------------------------------------------------------------ B1: north (ルクア・グランフロント・阪急三番街)
  b.j('f_lucua_b1', 'ルクア地下1階（バルチカ）', [34.7033, 135.4966], 'B1', B1);
  b.vertical('f_chuo_n', 'f_lucua_b1', ['stairs', 'esc']);
  b.j('f_gfo_b1', 'グランフロント大阪 南館地下1階', [34.7041, 135.4949], 'B1', B1);
  b.path(['f_lucua_b1', 'f_gfo_b1', 'uk_gate_out'], { name: 'ルクア〜グランフロント地下通路', busy: 1 });
  b.vertical('f_gfo1', 'f_gfo_b1', ['stairs', 'esc', 'elev']);
  b.j('f_midon_b1', 'JR御堂筋北口 地下', [34.7032, 135.4977], 'B1', B1);
  b.walk('f_lucua_b1', 'f_midon_b1', { name: 'ルクア地下通路', busy: 2 });
  b.vertical('f_mido_n', 'f_midon_b1', ['stairs', 'esc', 'elev']);
  b.walk('f_midon_b1', 'm_n_out', { name: '御堂筋線北改札前通路', busy: 3 });
  b.j('f_hkd_b1', '阪急うめだ本店 地下1階前', [34.7033, 135.4989], 'B1', { ...B1, label: false });
  b.walk('m_n_out', 'f_hkd_b1', { busy: 3 });
  b.vertical('f_hk_w', 'f_hkd_b1', ['stairs', 'esc', 'elev'], { busy: 3 });
  b.j('f_3b_b1', '阪急三番街 地下1階', [34.7054, 135.4983], 'B1', B1);
  b.vertical('hk_1f_sanbangai', 'f_3b_b1', ['stairs', 'esc', 'elev']);
  b.j('f_3b_s', '阪急三番街 南端（地下1階）', [34.7042, 135.49855], 'B1', B1);
  b.path(['f_3b_b1', 'f_3b_s', 'm_n_out'], { name: '阪急三番街', busy: 2 });

  // ------------------------------------------------------------------ B1: JR大阪駅前 / 阪神 / ホワイティうめだ
  b.j('f_jrf_b1', 'JR大阪駅前 地下（御堂筋南口下）', [34.7021, 135.49775], 'B1', { ...B1, label: false });
  b.vertical('f_mido_s', 'f_jrf_b1', ['stairs', 'esc', 'elev'], { busy: 3 });
  b.walk('f_jrf_b1', 'm_c_out', { busy: 3 });
  b.j('f_hsne_b1', '阪神梅田本店 東側地下', [34.7012, 135.4981], 'B1', B1);
  b.path(['f_jrf_b1', 'f_hsne_b1', 'hs_e_out', 'm_s_out'], { name: '梅田地下街（阪神東口）', busy: 3 });
  b.j('f_chuo_b1', '阪神百貨店口前 地下', [34.70158, 135.4968], 'B1', B1);
  b.vertical('f_chuo_s', 'f_chuo_b1', ['stairs', 'esc']);
  b.vertical('f_hs_n', 'f_chuo_b1', ['stairs']);
  b.j('f_hsnw_b1', '阪神梅田本店 西側地下', [34.70142, 135.4958], 'B1', B1);
  b.path(['f_hsnw_b1', 'f_chuo_b1', 'f_hsne_b1'], { name: '阪神梅田本店 北側地下通路', busy: 2 });
  b.walk('f_hsnw_b1', 'hs_w_out', { busy: 1 });
  b.vertical('f_hs_ne', 'f_hsne_b1', ['stairs']);

  // ホワイティうめだ: north mall along the east side of the 御堂筋線, then east to 泉の広場.
  b.j('f_wh_n', 'ホワイティうめだ ノースモール', [34.7021, 135.49915], 'B1', { ...B1, label: true });
  b.j('f_wh_sw', 'ホワイティうめだ 御堂筋線南改札前', [34.70055, 135.4989], 'B1', B1);
  b.j('f_wh_c', 'ホワイティうめだ センターモール', [34.70075, 135.4998], 'B1', B1);
  b.j('f_izumi', '泉の広場', [34.70155, 135.5017], 'B1', { ...B1, label: true });
  b.path(['f_hkd_b1', 'f_wh_n', 'f_wh_c'], { name: 'ホワイティうめだ', busy: 2 });
  b.path(['m_s_out', 'f_wh_sw', 'f_wh_c', 't_n_out', 'f_izumi'], { name: 'ホワイティうめだ', busy: 2 });

  // ディアモール大阪 (south of 阪神) and the corridor down to 北新地.
  b.j('f_dm_w', 'ディアモール大阪 西（西梅田側）', [34.69995, 135.4957], 'B1', B1);
  b.j('f_dm_c', 'ディアモール 円形広場', [34.6999, 135.497], 'B1', { ...B1, label: true });
  b.j('f_dm_e', 'ディアモール大阪 東', [34.6999, 135.4983], 'B1', B1);
  b.path(['f_dm_w', 'f_dm_c', 'f_dm_e'], { name: 'ディアモール大阪', busy: 2, width: 12 });
  b.walk('hs_c_out', 'f_dm_c', { busy: 2 });
  b.walk('f_dm_e', 'm_s_out', { busy: 2 });
  b.walk('f_dm_e', 'f_wh_sw', { name: 'ディアモール〜ホワイティ連絡' });
  b.walk('f_dm_w', 'y_n_out', { busy: 2 });
  b.walk('hs_w_out', 'y_n_out', { name: '西梅田・阪神西口連絡通路', busy: 1 });
  b.j('f_dm_s', 'ディアモール 南北通路（北新地方面）', [34.6991, 135.4969], 'B1', B1);
  b.walk('f_dm_c', 'f_dm_s', { name: 'ディアモール大阪（北新地方面）', busy: 2 });
  b.vertical('f_dm_s', 'ks_mid_out', ['stairs', 'esc'], { name: '北新地駅への階段' });

  // 大阪駅前ビル地下 (第2〜第4ビル) → 東梅田 南改札.
  b.j('f_ek2_b2', '大阪駅前第2ビル 地下2階入口', [34.6988, 135.4981], 'B2', { y: -10 });
  b.walk('ks_e_out', 'f_ek2_b2', { name: '北新地駅 東口通路' });
  b.j('f_ek2_b1', '大阪駅前第2ビル 地下1階', [34.69925, 135.4982], 'B1', B1);
  b.vertical('f_ek2_b2', 'f_ek2_b1', ['stairs', 'esc', 'elev']);
  b.walk('f_ek2_b1', 'f_dm_e', { name: '大阪駅前ビル〜ディアモール' });
  b.j('f_ek4_b1', '大阪駅前第4ビル 地下1階', [34.6993, 135.4999], 'B1', B1);
  b.path(['f_ek2_b1', 'f_ek4_b1', 't_s_out'], { name: '大阪駅前ビル地下', busy: 1 });

  // 北新地 西改札 ↔ 西梅田 南改札 (1–3 min).
  b.vertical('ks_w_out', 'y_s_out', ['stairs', 'esc'], { name: '地下鉄（西梅田）連絡口' });

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
  ent('e_gfo', 'グランフロント大阪', [34.7047, 135.4944], 'f_gfo1');
  ent('e_park', 'うめきた公園', [34.70351, 135.49263], 'f_ugp1');
  ent('e_kitte', 'KITTE大阪・JPタワー', [34.70105, 135.4938], 'f_kitte1');
  ent('e_herbis', 'ハービスOSAKA', [34.7003, 135.4944], 'f_dm_w', 'B1');
  ent('e_sakurabashi', '桜橋（北新地西）', [34.6982, 135.4953], 'y_s_out', 'B1');
  ent('e_shindo', '梅田新道', [34.6985, 135.4999], 'f_ek4_b1', 'B1');
  ent('e_ohatsu', 'お初天神・曽根崎', [34.7015, 135.5029], 'f_izumi', 'B1');
  ent('e_hep', 'HEP FIVE・東通り', [34.7035, 135.5003], 'f_wh_n', 'B1');
  ent('e_hanshin', '阪神梅田本店', [34.7007, 135.4972], 'f_hs_n');
  ent('e_daimaru', '大丸梅田店', [34.7015, 135.4962], 'f_daimaru1');
}
