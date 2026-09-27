import { NetBuilder, offset, toXZ, type LatLon, type XZ } from './builder';

/**
 * JR大阪駅 (ground platforms 1–11), the うめきたエリア underground platforms (21–24)
 * and JR北新地 (JR東西線).
 *
 * Geometry follows the research notes: the elevated platforms run ENE–WSW (bearing ≈76°),
 * ≈340 m long, numbered 1 (south) to 11 (north). Stair banks from west to east:
 * 西口, 桜橋口 (via 中2階), 連絡橋口 (up to 3F), 中央口, 御堂筋口・南口.
 */

const PLAT_Y = 7.5;
const MEZZ_Y = 3.8;
const BRIDGE_Y = 15;

interface JrPlatform {
  id: string;
  nameJa: string;
  lines: string[];
  directions: string;
  W: LatLon;
  E: LatLon;
  width: number;
  busy: number;
}

export const JR_PLATFORMS: JrPlatform[] = [
  {
    id: 'jr-1-2',
    nameJa: '1・2番のりば',
    lines: ['jr-loop'],
    directions: '1番 環状線内回り（西九条・天王寺）・ゆめ咲線・大和路快速・関空/紀州路快速／2番 環状線外回り（京橋・鶴橋）',
    W: [34.70176, 135.4942],
    E: [34.7025, 135.49781],
    width: 10,
    busy: 3,
  },
  {
    id: 'jr-3-4',
    nameJa: '3・4番のりば',
    lines: ['jr-takarazuka', 'jr-kobe'],
    directions: 'JR宝塚線（丹波路快速・特急こうのとり）・JR神戸線（始発・一部列車）',
    W: [34.70193, 135.49415],
    E: [34.70267, 135.49776],
    width: 10,
    busy: 2,
  },
  {
    id: 'jr-5-6',
    nameJa: '5・6番のりば',
    lines: ['jr-kobe', 'jr-takarazuka'],
    directions: '5番 JR神戸線 新快速・快速（三ノ宮・姫路）／6番 JR神戸線 普通・JR宝塚線（宝塚・新三田）',
    W: [34.70209, 135.4941],
    E: [34.70283, 135.49771],
    width: 11,
    busy: 3,
  },
  {
    id: 'jr-7-8',
    nameJa: '7・8番のりば',
    lines: ['jr-kyoto'],
    directions: '7番 JR京都線 普通（高槻・京都）／8番 JR京都線 新快速・快速（京都・米原）',
    W: [34.70226, 135.49405],
    E: [34.703, 135.49766],
    width: 11,
    busy: 3,
  },
  {
    id: 'jr-9-10',
    nameJa: '9・10番のりば',
    lines: ['jr-kyoto'],
    directions: '9番 JR京都線（朝夕の新快速）／10番 特急らくラクびわこ・始発列車',
    W: [34.70243, 135.494],
    E: [34.70317, 135.49761],
    width: 10,
    busy: 2,
  },
  {
    id: 'jr-11',
    nameJa: '11番のりば',
    lines: ['jr-ltd'],
    directions: '特急サンダーバード（敦賀）・ひだ（高山）・サンライズ瀬戸/出雲（東京）',
    W: [34.70259, 135.49394],
    E: [34.70333, 135.49755],
    width: 8,
    busy: 1,
  },
];

/** Longitudes of the stair banks (they line up N–S across all islands). */
const BANK = {
  nishi: 135.4944,
  sakura: 135.4953,
  bridge: 135.4959,
  chuo: 135.49635,
  mido: 135.4971,
} as const;

type BankKey = keyof typeof BANK;

const STOP_NAMES: Record<BankKey, string> = {
  nishi: '西寄り（西口・うめきた方面の階段まで約60m）',
  sakura: '西寄り（桜橋口階段付近）',
  bridge: '中ほど（連絡橋口エスカレーター付近）',
  chuo: '中ほど東寄り（中央口階段付近）',
  mido: '東寄り（御堂筋口・南口階段付近）',
};

/** Point on a platform axis at the given longitude. */
function atLon(p: JrPlatform, lon: number): LatLon {
  const t = (lon - p.W[1]) / (p.E[1] - p.W[1]);
  return [p.W[0] + (p.E[0] - p.W[0]) * t, lon];
}

const AXIS = 76; // bearing of the platforms (ENE)
/** ≈60 m along the platform axis, in degrees of longitude. */
const NISHI_DOOR_DLON = 0.00064;

export function addJrOsaka(b: NetBuilder): void {
  const st = 'jr';
  const stops: Record<string, Record<string, string>> = {};

  for (const p of JR_PLATFORMS) {
    const len = Math.hypot(toXZ(p.E).x - toXZ(p.W).x, toXZ(p.E).z - toXZ(p.W).z);
    const keys: BankKey[] = ['nishi', 'sakura', 'bridge', 'chuo', 'mido'];
    stops[p.id] = b.platform({
      id: p.id,
      station: st,
      nameJa: p.nameJa,
      lines: p.lines,
      directions: p.directions,
      level: '2F',
      y: PLAT_Y,
      a: p.W,
      b: p.E,
      width: p.width,
      busy: p.busy,
      stops: keys.map((k) => {
        // Trains stop ≈60 m short of the 西口 stairs at the platform's far west end.
        const q = toXZ(atLon(p, k === 'nishi' ? BANK.nishi + NISHI_DOOR_DLON : BANK[k]));
        const a = toXZ(p.W);
        const t = Math.hypot(q.x - a.x, q.z - a.z) / len;
        return { key: k, t, name: STOP_NAMES[k] };
      }),
    });
  }

  // 西口 stair heads at the far west end of each platform (not a boarding position).
  const nishiTop = (p: JrPlatform) => `jr_nishiTop_${p.id}`;
  for (const p of JR_PLATFORMS) {
    b.node(nishiTop(p), 'junction', `${p.nameJa} 西口階段上`, atLon(p, BANK.nishi), '2F', { station: st, paid: true, y: PLAT_Y });
    b.platformWalk(stops[p.id].nishi, nishiTop(p), { busy: p.busy, width: p.width * 0.6 });
  }

  const islands = JR_PLATFORMS.filter((p) => p.id !== 'jr-11');
  const landing = (p: JrPlatform, bank: BankKey, along: number): XZ => offset(atLon(p, BANK[bank]), AXIS, along);

  // --- 1F paid concourses under the tracks (one per stair bank) --------------------------------
  const chain = (bank: 'nishi' | 'chuo' | 'mido', along: number, label: string, modes: ('stairs' | 'esc' | 'elev')[]) => {
    const ids: string[] = [];
    for (const p of islands) {
      const id = `jr_${bank}1_${p.id}`;
      b.node(id, 'vertical', `${label}（${p.nameJa}への階段下）`, landing(p, bank, along), '1F', { station: st, paid: true });
      b.vertical(bank === 'nishi' ? nishiTop(p) : stops[p.id][bank], id, modes, { busy: p.busy });
      ids.push(id);
    }
    b.path(ids, { name: `${label}改札内コンコース`, busy: 2, width: 12 });
    return ids;
  };

  const chuo = chain('chuo', -12, '中央口', ['stairs', 'esc', 'elev']);
  const mido = chain('mido', -12, '御堂筋口', ['stairs', 'esc', 'elev']);
  const nishi = chain('nishi', 14, '西口', ['stairs', 'esc', 'elev']);

  // 中央口 gate → free 中央コンコース (N–S under the tracks)
  b.node('jr_chuo_in', 'gate', '中央口改札', [34.70252, 135.49648], '1F', { station: st, paid: true, label: true });
  b.walk(chuo[2], 'jr_chuo_in', { busy: 2 });
  b.walk(chuo[1], 'jr_chuo_in', { busy: 2 });
  b.node('jr_chuo_out', 'junction', '中央口前（中央コンコース）', [34.70252, 135.49668], '1F', { station: st });
  b.gate('jr_chuo_in', 'jr_chuo_out', 'JR 中央口改札', { busy: 3, width: 14 });

  // エキマルシェ大阪口 (west side of the 中央口 paid area)
  b.node('jr_ekim_in', 'gate', 'エキマルシェ大阪口改札', [34.70222, 135.4959], '1F', { station: st, paid: true });
  b.walk(chuo[0], 'jr_ekim_in');
  b.node('jr_ekim_out', 'junction', 'エキマルシェ大阪', [34.70212, 135.4957], '1F', { station: st });
  b.gate('jr_ekim_in', 'jr_ekim_out', 'JR エキマルシェ大阪口改札', { busy: 1 });

  // 御堂筋口 gate (east) and 南口 gate (south)
  b.node('jr_mido_in', 'gate', '御堂筋口改札', [34.7027, 135.49728], '1F', { station: st, paid: true, label: true });
  b.walk(mido[2], 'jr_mido_in', { busy: 2 });
  b.walk(mido[3], 'jr_mido_in', { busy: 2 });
  b.node('jr_mido_out', 'junction', '御堂筋口前', [34.7027, 135.4975], '1F', { station: st });
  b.gate('jr_mido_in', 'jr_mido_out', 'JR 御堂筋口改札', { busy: 3, width: 14 });
  b.node('jr_minami_in', 'gate', '南口改札', [34.70225, 135.49695], '1F', { station: st, paid: true });
  b.walk(mido[0], 'jr_minami_in');
  b.node('jr_minami_out', 'junction', '南口前（バスターミナル側）', [34.70205, 135.49695], '1F', { station: st });
  b.gate('jr_minami_in', 'jr_minami_out', 'JR 南口改札', { busy: 2 });

  // 桜橋口: platform stairs → paid 中2階 N–S passage → stairs → 1F gate
  const sak: string[] = [];
  for (const p of JR_PLATFORMS) {
    const id = `jr_sakM_${p.id}`;
    b.node(id, 'vertical', `桜橋口中2階（${p.nameJa}への階段下）`, landing(p, 'sakura', -10), 'M2', { station: st, paid: true, y: MEZZ_Y });
    b.stairs(stops[p.id].sakura, id);
    sak.push(id);
  }
  b.path(sak, { name: '桜橋口中2階通路', busy: 1, width: 8 });
  b.node('jr_sak_in', 'gate', '桜橋口改札', [34.70198, 135.49518], '1F', { station: st, paid: true, label: true });
  b.stairs(sak[0], 'jr_sak_in', { name: '桜橋口階段' });
  b.esc(sak[1], 'jr_sak_in', 'both', { name: '桜橋口エスカレーター' });
  b.node('jr_sak_out', 'junction', '桜橋口前', [34.70172, 135.4951], '1F', { station: st });
  b.gate('jr_sak_in', 'jr_sak_out', 'JR 桜橋口改札', { busy: 2 });

  // 西口 gate and the paid passage to うめきた
  b.node('jr_nishi_in', 'gate', '西口改札', [34.70215, 135.49428], '1F', { station: st, paid: true, label: true });
  b.walk(nishi[2], 'jr_nishi_in');
  b.walk(nishi[1], 'jr_nishi_in');
  b.node('jr_nishi_out', 'junction', '西口前（イノゲート・KITTE連絡通路）', [34.70215, 135.49402], '1F', { station: st });
  b.gate('jr_nishi_in', 'jr_nishi_out', 'JR 西口改札', { busy: 1 });

  // 11番のりば access
  const p11 = JR_PLATFORMS[5];
  b.node('jr_11_nishi', 'vertical', '西口（11番のりばへのES・EV下）', landing(p11, 'nishi', 14), '1F', { station: st, paid: true });
  b.vertical(nishiTop(p11), 'jr_11_nishi', ['esc', 'elev']);
  b.walk(nishi[nishi.length - 1], 'jr_11_nishi', { name: '西口改札内コンコース' });
  b.node('jr_11_mc', 'vertical', '11番のりば連絡中2階（中央口側）', landing(p11, 'chuo', -12), 'M2', { station: st, paid: true, y: MEZZ_Y });
  b.vertical(chuo[chuo.length - 1], 'jr_11_mc', ['stairs', 'esc', 'elev']);
  b.vertical('jr_11_mc', stops['jr-11'].chuo, ['stairs', 'esc', 'elev']);
  b.node('jr_11_mm', 'vertical', '11番のりば連絡中2階（御堂筋口側）', landing(p11, 'mido', -12), 'M2', { station: st, paid: true, y: MEZZ_Y });
  b.vertical(mido[mido.length - 1], 'jr_11_mm', ['stairs', 'esc']);
  b.vertical('jr_11_mm', stops['jr-11'].mido, ['stairs', 'esc']);

  // 3F 橋上駅舎 (連絡橋口): ES/EV/stairs from every platform near mid-platform
  const br: string[] = [];
  for (const p of JR_PLATFORMS) {
    const id = `jr_br_${p.id}`;
    b.node(id, 'vertical', `連絡橋口改札内（${p.nameJa}への階段上）`, landing(p, 'bridge', 10), '3F', { station: st, paid: true, y: BRIDGE_Y });
    b.vertical(stops[p.id].bridge, id, ['stairs', 'esc', 'elev'], { busy: p.busy });
    br.push(id);
  }
  b.path(br, { name: '連絡橋口改札内コンコース', busy: 2, width: 20 });
  b.node('jr_br_in', 'gate', '連絡橋口改札', [34.70252, 135.49572], '3F', { station: st, paid: true, label: true, y: BRIDGE_Y });
  b.walk(br[2], 'jr_br_in');
  b.walk(br[3], 'jr_br_in');
  b.node('jr_br_out', 'junction', '連絡橋口前（南北連絡橋）', [34.70252, 135.4955], '3F', { station: st, y: BRIDGE_Y });
  b.gate('jr_br_in', 'jr_br_out', 'JR 連絡橋口改札', { busy: 2 });
}

// ------------------------------------------------------------------------------------------------

/**
 * うめきたエリア (opened 2023-03-18): 2 island platforms (tracks 21–24) on B2 ≈ −15 m, ≈200 m long,
 * with the うめきた地下口 gate concourse on B1 ≈ −7 m. The box lies under うめきたグリーンプレイス,
 * just west of the N–S road through 梅田ランプ東 (lon ≈135.4939, Mapion/NAVITIME), on a gently
 * curved NNE–SSW alignment.
 *
 * Islands from east to west: 21・22 | 23・24 (left-hand running on a N–S line: 21 = southbound はるか・
 * くろしお, 24 = northbound). The gate is at the NORTH end of the paid concourse (you face south
 * entering, north leaving). Each island has a stair+escalator pair at the gate end (手前) and one at
 * the far end (奥), with a lift between them; the paid passage from 西口 arrives at the far end on the
 * 21・22 side (station guides; travel.watch.impress.co.jp).
 */
export function addUmekita(b: NetBuilder): void {
  const st = 'umekita';
  const center: LatLon = [34.70345, 135.49345];
  const axis = 10; // NNE–SSW
  const half = 100;
  /** Point u m along the axis (north +) and v m across it (east +) from the box centre. */
  const U = (u: number, v: number): XZ => offset(offset(center, axis, u), axis + 90, v);
  const islands = [
    { id: 'uk-21-22', nameJa: '21・22番のりば', lines: ['jr-umekita', 'jr-higashi'], directions: '21番 はるか・くろしお（関西空港・和歌山）／22番 おおさか東線 直通快速・まほろば', side: 9 },
    { id: 'uk-23-24', nameJa: '23・24番のりば', lines: ['jr-higashi', 'jr-umekita'], directions: '23番 おおさか東線 普通／24番 はるか・くろしお（新大阪・京都）', side: -9 },
  ];
  const stops: Record<string, Record<string, string>> = {};
  for (const is of islands) {
    const c = U(0, is.side);
    stops[is.id] = b.platform({
      id: is.id,
      station: st,
      nameJa: is.nameJa,
      lines: is.lines,
      directions: is.directions,
      level: 'B2',
      y: -15,
      a: offset(c, axis + 180, half),
      b: offset(c, axis, half),
      width: 9,
      busy: 1,
      stops: [
        { key: 's', t: 0.2, name: '南寄り（西九条・関空方）' },
        { key: 'm', t: 0.5, name: '中ほど（うめきた地下口への階段付近）' },
        { key: 'n', t: 0.8, name: '北寄り（新大阪方）' },
      ],
    });
  }

  // B1 paid concourse: gate at the north end, the 西口 passage at the south-east corner.
  const paid = { station: st, paid: true, y: -7 };
  b.node('uk_conc', 'junction', 'うめきた地下口 改札内コンコース', [34.703397, 135.493439], 'B1', paid);
  b.node('uk_conc_s', 'junction', 'うめきた地下口 改札内コンコース（西口連絡通路側）', [34.703166, 135.493389], 'B1', paid);
  b.node('uk_gate_in', 'gate', 'うめきた地下口改札', [34.70369, 135.493501], 'B1', { ...paid, label: true });
  b.walk('uk_conc', 'uk_gate_in');
  b.walk('uk_conc', 'uk_conc_s');
  for (const is of islands) {
    const hN = `uk_land_${is.id}`;
    const hS = `uk_landS_${is.id}`;
    const ev = `uk_ev_${is.id}`;
    b.node(hN, 'vertical', `${is.nameJa}への階段上（改札寄り）`, U(18, is.side), 'B1', paid);
    b.node(hS, 'vertical', `${is.nameJa}への階段上（西口連絡通路寄り）`, U(-30, is.side), 'B1', paid);
    b.node(ev, 'vertical', `${is.nameJa}へのエレベーター`, U(-6, is.side), 'B1', paid);
    b.walk('uk_gate_in', hN);
    b.walk('uk_conc_s', hS);
    b.walk('uk_conc', ev);
    // 手前 pair rises north toward the gate from the platform middle; 奥 pair rises south toward
    // the 西口 passage, reached along the platform edge (clear of the lift between them).
    const okuFoot = `uk_okuFoot_${is.id}`;
    b.node(okuFoot, 'junction', `${is.nameJa} 西口連絡通路寄り階段下`, U(-11, is.side), 'B2', { station: st, paid: true, y: -15 });
    b.platformWalk(stops[is.id].m, okuFoot, { busy: 1, width: 9 * 0.6 });
    b.vertical(stops[is.id].m, hN, ['stairs', 'esc'], { bearingUp: axis, anchor: 'top' });
    b.vertical(okuFoot, hS, ['stairs', 'esc'], { bearingUp: axis + 180, anchor: 'top' });
    b.vertical(stops[is.id].m, ev, ['elev'], { anchor: 'top' });
  }

  // Paid passage from JR 西口 (1F): a deep flight down to B2 (≈ −11 m, to pass under the sewer main
  // of the E–W road), ≈60–70 m north-west, then up into the concourse (≈2 min, travel.watch.impress.co.jp).
  b.node('uk_pass_top', 'vertical', '西口 うめきた連絡通路入口', [34.70246, 135.49412], '1F', { station: 'jr', paid: true });
  b.walk('jr_nishi1_jr-9-10', 'uk_pass_top', { name: '西口改札内コンコース' });
  b.walk('jr_nishi_in', 'uk_pass_top', { name: '西口改札内コンコース' });
  b.node('uk_pass_s', 'vertical', 'うめきた連絡通路（南端）', [34.70262, 135.49398], 'B2', { station: 'jr', paid: true, y: -11 });
  // Head in the north part of the 西口 concourse; it descends NNW, so going up you face SE.
  b.vertical('uk_pass_top', 'uk_pass_s', ['stairs', 'esc', 'elev'], { name: '西口連絡通路', bearingUp: 144, anchor: 'top' });
  b.node('uk_pass_n', 'vertical', 'うめきた連絡通路（北端）', [34.703055, 135.493623], 'B2', { station: 'jr', paid: true, y: -11 });
  b.walk('uk_pass_s', 'uk_pass_n', { name: 'うめきた地下連絡通路（改札内）', width: 8 });
  // The passage belongs to both paid areas; model the station boundary as open (same fare system).
  b.node('uk_pass_up', 'vertical', 'うめきた地下口コンコース（連絡通路側）', [34.703129, 135.493581], 'B1', paid);
  b.vertical('uk_pass_n', 'uk_pass_up', ['stairs', 'esc', 'elev'], { bearingUp: 335, anchor: 'top' });
  b.walk('uk_pass_up', 'uk_conc_s');
  b.walk('uk_pass_up', 'uk_landS_uk-21-22');

  // Gate and the free B1 corridor in front of it (E–W): west to うめきた公園 and グラングリーン大阪
  // 南館, east to the ground exit into うめきたグリーンプレイス and on to グランフロント大阪 B1.
  b.node('uk_gate_out', 'junction', 'うめきた地下口前', [34.703761, 135.493516], 'B1', { station: st, y: -7 });
  b.gate('uk_gate_in', 'uk_gate_out', 'JR うめきた地下口改札', { busy: 1 });
  b.node('uk_sp_b1', 'junction', 'うめきた地下口前（うめきた公園・南館方面）', [34.703761, 135.493243], 'B1', { station: st, y: -7 });
  b.walk('uk_gate_out', 'uk_sp_b1', { name: 'うめきた地下口前通路' });
  b.node('uk_b1_e', 'junction', 'うめきた地下口前通路（グランフロント・地上出口方面）', [34.703761, 135.493756], 'B1', { station: st, y: -7 });
  b.walk('uk_gate_out', 'uk_b1_e', { name: 'うめきた地下口前通路' });
}

// ------------------------------------------------------------------------------------------------

/**
 * JR北新地: island platform ≈ −23 m under 曽根崎通 (国道2号, bearing ≈101°), gates at both ends.
 * Both gates open NORTH onto one free E–W corridor along the north side of the box (at the level
 * of the 大阪駅前ビル B2 floors): 西改札 just east of 四つ橋筋 with the 西梅田連絡口 beside it,
 * 東改札 facing the 大阪駅前第2ビル B2 entrance, and the ディアモール spine arriving between them
 * at the big 北新地駅 sign (ja.wikipedia.org, osaka-station.net). The platform stair banks rise
 * outward, toward the end gates.
 */
export function addKitashinchi(b: NetBuilder): void {
  const st = 'kitashinchi';
  const center: LatLon = [34.69831, 135.49702];
  const axis = 101;
  const s = b.platform({
    id: 'ks-1-2',
    station: st,
    nameJa: '1・2番のりば',
    lines: ['jr-tozai'],
    directions: '1番 JR東西線 尼崎・宝塚・神戸方面／2番 京橋・松井山手・木津方面',
    level: 'B3',
    y: -23,
    a: offset(center, axis + 180, 85),
    b: offset(center, axis, 85),
    width: 9,
    busy: 2,
    stops: [
      // At the feet of the end banks, so nobody doubles back under a well.
      { key: 'w', t: 0.18, name: '西寄り（西改札・西梅田方面）' },
      { key: 'm', t: 0.5, name: '中ほど' },
      { key: 'e', t: 0.82, name: '東寄り（東改札・東梅田方面）' },
    ],
  });
  // Bank heads 3 m inside the platform ends; the 13 m rise needs ≈25–30 m of run.
  b.node('ks_wc', 'junction', '北新地 西改札内コンコース', [34.698451, 135.49614], 'B2', { station: st, paid: true, y: -10 });
  b.node('ks_ec', 'junction', '北新地 東改札内コンコース', [34.698169, 135.4979], 'B2', { station: st, paid: true, y: -10 });
  b.vertical(s.w, 'ks_wc', ['stairs', 'esc'], { bearingUp: 281, anchor: 'top' });
  b.vertical(s.e, 'ks_ec', ['stairs', 'esc', 'elev'], { bearingUp: 101, anchor: 'top' });

  b.node('ks_w_in', 'gate', '北新地 西改札', [34.69857, 135.495857], 'B2', { station: st, paid: true, label: true, y: -10 });
  b.walk('ks_wc', 'ks_w_in');
  b.node('ks_w_out', 'junction', '北新地 西改札前', [34.698632, 135.495871], 'B2', { station: st, y: -10 });
  b.gate('ks_w_in', 'ks_w_out', 'JR北新地 西改札', { busy: 2 });

  b.node('ks_e_in', 'gate', '北新地 東改札', [34.698246, 135.497932], 'B2', { station: st, paid: true, label: true, y: -10 });
  b.walk('ks_ec', 'ks_e_in');
  b.node('ks_e_out', 'junction', '北新地 東改札前（駅前第2ビル入口）', [34.69832, 135.49795], 'B2', { station: st, y: -10 });
  b.gate('ks_e_in', 'ks_e_out', 'JR北新地 東改札', { busy: 2 });

  // Where the ディアモール N–S spine arrives (outside the gates): right to 西改札, left to 東改札.
  b.node('ks_mid_out', 'junction', '北新地駅 中央（ディアモール通路突き当たり）', [34.698446, 135.49696], 'B2', { station: st, y: -10 });
  b.walk('ks_w_out', 'ks_mid_out', { name: '北新地駅 改札外通路', busy: 2 });
  b.walk('ks_mid_out', 'ks_e_out', { name: '北新地駅 改札外通路', busy: 2 });
}
