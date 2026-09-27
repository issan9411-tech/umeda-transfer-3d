import { ll, NetBuilder } from './builder';
import { addContext } from './context';
import type { DataSet, ReferenceTime } from './dataset';
import { addJrOsaka, addKitashinchi, addUmekita } from './jr';
import { LEVELS, LINES, STATION_META } from './meta';
import { addHigashiUmeda, addMidosujiUmeda, addNishiUmeda } from './metro';
import { addHankyu, addHanshin } from './private-rail';
import { addWalkways } from './walkways';

/** Reference transfer time with a uniform ±40 % (at least ±1 min) acceptance band. */
function ref(from: string, to: string, minutes: number, source: string, fromNode?: string, toNode?: string): ReferenceTime {
  const d = Math.max(1, minutes * 0.4);
  return { from, to, minutes, range: [Math.max(0, minutes - d), minutes + d], source, fromNode, toNode };
}

function buildNetwork() {
  const b = new NetBuilder(LEVELS);
  for (const l of LINES) b.line(l);

  addJrOsaka(b);
  addUmekita(b);
  addKitashinchi(b);
  addHankyu(b);
  addHanshin(b);
  addMidosujiUmeda(b);
  addHigashiUmeda(b);
  addNishiUmeda(b);
  addWalkways(b);
  addContext(b);

  // Station label anchors: centroid of each station's platforms, lifted above the platform level.
  for (const { labelAt, ...meta } of STATION_META) {
    const ps = b.platforms.filter((p) => p.stationId === meta.id);
    if (labelAt) {
      const q = ll(labelAt[0], labelAt[1]);
      b.station({ ...meta, anchor: [q.x, labelAt[2], q.z] });
      continue;
    }
    const x = ps.reduce((s, p) => s + (p.a[0] + p.b[0]) / 2, 0) / ps.length;
    const z = ps.reduce((s, p) => s + (p.a[1] + p.b[1]) / 2, 0) / ps.length;
    const y = Math.max(...ps.map((p) => p.y));
    b.station({ ...meta, anchor: [x, y, z] });
  }
  return b.build();
}

export const umeda: DataSet = {
  network: buildNetwork(),
  // Approximate daily users (thousands). 阪急 and 北新地 are from published figures; others are rough.
  ridership: {
    jr: 760,
    umekita: 30,
    hankyu: 470,
    hanshin: 160,
    umeda: 390,
    higashiumeda: 140,
    nishiumeda: 100,
    kitashinchi: 85,
  },
  entranceWeight: 1600,
  // Bands are a uniform ±40 % (at least ±1 min) around each quoted figure.
  reference: [
    ref('jr', 'umekita', 8, 'JR西日本（2023年3月）：環状線ホーム中央付近→23・24番ホーム中央付近 約8分（本モデルでは標準の歩き方で約6分、大きな荷物で約8分）'),
    ref('jr', 'umekita', 2.5, '西口→うめきた地下口（改札内）実測 約2〜2.5分（トラベル Watch）', 'jr_nishi_in', 'uk_gate_in'),
    ref('hankyu', 'jr', 7, '阪急3階改札→JR御堂筋口 約7分（osaka-news.jp）', 'hk_3f_in', 'jr_mido_in'),
    ref('jr', 'hankyu', 4, 'JR御堂筋口→阪急3階改札 3〜5分（案内サイト）', 'jr_mido_in', 'hk_3f_in'),
    ref('hankyu', 'umeda', 5, '阪急3階改札→御堂筋線北改札 約5分（osaka-transfer.com）', 'hk_3f_in', 'm_n_in'),
    ref('umeda', 'hankyu', 6, '御堂筋線北改札→阪急 約6分（5〜10分, osaka-news.jp）', 'm_n_in', 'hk_3f_in'),
    ref('jr', 'kitashinchi', 7, 'JR中央口→北新地 経路検索で約7分（案内記事では約12分, osaka-station.net）', 'jr_chuo_in', 'ks_w_in'),
    ref('kitashinchi', 'nishiumeda', 2, '北新地西改札⇔西梅田南改札 1〜3分（onigiriface.jp）', 'ks_w_in', 'y_s_in'),
    ref('hanshin', 'kitashinchi', 4.5, '阪神百貨店口⇔北新地西改札 4〜5分（osaka-station.net）', 'hs_c_in', 'ks_w_in'),
    ref('kitashinchi', 'hanshin', 8, '北新地→阪神大阪梅田 約8分（ホームまで, osaka-station.net）'),
    ref('kitashinchi', 'umeda', 9, '北新地→御堂筋線梅田 約9分（osaka-station.net）'),
    ref('umeda', 'umekita', 7, '御堂筋線北改札→うめきた地下口 最短約7分（tabiseason.com）', 'm_n_in', 'uk_gate_in'),
  ],
  sources: [
    { title: 'JR西日本 うめきたエリア開業（2023年3月）報道', url: 'https://news.mynavi.jp/article/20230309-2612721/', note: '環状線ホーム→23・24番 約8分' },
    { title: 'トラベル Watch：大阪駅うめきたエリア 実地ルポ', url: 'https://travel.watch.impress.co.jp/docs/news/1486649.html', note: '西口〜うめきた地下口 約2分' },
    { title: 'RMニュース：大阪駅11番のりばと西口の連絡', url: 'https://rail.hobidas.com/rmnews/456328/', note: '2024年7月9日 ES/EV供用' },
    { title: 'Wikipedia: Ōsaka Station', url: 'https://en.wikipedia.org/wiki/%C5%8Csaka_Station', note: 'のりば構成・座標' },
    { title: 'のりばナビ（大阪駅 各線のりば）', url: 'https://noriba-navi.com/osaka-kobe' },
    { title: 'おおさかニュース：阪急→JR大阪駅', url: 'https://osaka-news.jp/life/hankyu-jr/', note: '約7分' },
    { title: '大阪乗換ガイド：阪急→御堂筋線梅田', url: 'https://osaka-transfer.com/hkumum/', note: '約5分' },
    { title: '乗りものニュース：阪急大阪梅田駅 停車位置の移設（2026年）', url: 'https://trafficnews.jp/post/610009' },
    { title: 'Wikipedia: 北新地駅', url: 'https://ja.wikipedia.org/wiki/%E5%8C%97%E6%96%B0%E5%9C%B0%E9%A7%85', note: '深さ・改札' },
    { title: '大阪駅.net：JR大阪駅→北新地駅', url: 'https://osaka-station.net/archives/538' },
    { title: '大阪駅.net：阪神大阪梅田⇔北新地', url: 'https://osaka-station.net/archives/1194' },
    { title: '大阪駅.net：北新地→御堂筋線梅田', url: 'https://osaka-station.net/archives/1200' },
    { title: 'おにぎりフェイス：北新地⇔西梅田', url: 'https://onigiriface.jp/jr-kitashinchi-yotsubashi-nishiumeda.html' },
    { title: '旅シーズン：御堂筋線梅田→うめきた地下口', url: 'https://www.tabiseason.com/accsnr/asnrossri.html' },
    { title: 'OpenStreetMap（Overture Maps 経由）', url: 'https://www.openstreetmap.org/copyright', note: '周辺の建物・道路：© OpenStreetMap contributors（ODbL）' },
  ],
  caveats: [
    '位置・高さ・通路長は公開情報と推定に基づく概略モデルです（誤差は数十m程度）。実際の構内図・案内表示を優先してください。',
    '各駅の階段・改札・通路の位置と向きは、ウェブ調査（構内案内・乗換案内・地図サイトなど）で確認できた事実に合わせています。確認できなかった部分（ホームの深さ、エレベーターの位置、一部の通路の形など）は推定です。',
    'エレベーターは主要なものだけをモデル化しています。「段差なし」のルートは目安で、営業時間外の商業施設内ルート（大丸店内など）も含みます。',
    '工事による一時的な通路閉鎖（阪急茶屋町口付近 2026年9月〜など）は反映していません。',
    '乗換時間は歩行のみで、列車の待ち時間や改札内での乗車券購入などは含みません。',
    '3D表示の周辺の建物と道路は OpenStreetMap（© OpenStreetMap contributors、ODbL）を Overture Maps 経由で取得したものです。高さが登録されていない建物は階数×3.5 m または推定値です。',
  ],
  defaultRoute: { from: 'station:hankyu', to: 'station:higashiumeda' },
};
