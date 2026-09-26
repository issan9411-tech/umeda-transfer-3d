import {
  CROSSING_WAIT_S,
  DEFAULT_OPTIONS,
  ELEVATOR_WAIT_S,
  ESCALATOR_SPEED,
  GATE_S,
  PROFILES,
  STAIRS_DOWN_VV,
  STAIRS_UP_VV,
} from '../core/cost';
import type { Graph } from '../core/graph';
import { transferMatrix } from '../core/matrix';
import type { DataSet } from '../data/dataset';
import { escapeHtml, jpDuration, readableOn } from './format';

/** Calibration rows: published transfer times vs. the model under standard, off-peak conditions. */
export function calibrationRows(g: Graph, data: DataSet) {
  const m = transferMatrix(g, { ...DEFAULT_OPTIONS, congestion: false, hour: 11 });
  const idx = new Map(m.stations.map((s, i) => [s, i]));
  return data.reference.map((ref) => {
    const cell = m.cells[idx.get(ref.from) ?? -1]?.[idx.get(ref.to) ?? -1];
    const typicalMin = cell ? cell.typicalS / 60 : NaN;
    const ok = typicalMin >= ref.range[0] && typicalMin <= ref.range[1];
    return { ref, cell, typicalMin, ok };
  });
}

export function renderAbout(g: Graph, data: DataSet): string {
  const net = g.net;
  const st = (id: string) => net.stations.find((s) => s.id === id);
  const lineName = (id: string) => net.lines.find((l) => l.id === id)?.nameJa ?? id;
  const lvlName = (id: string) => net.levels.find((l) => l.id === id)?.nameJa ?? id;
  const badge = (id: string) => {
    const s = st(id);
    return s ? `<span class="badge" style="background:${s.color};color:${readableOn(s.color)}">${escapeHtml(s.badge)}</span>` : '';
  };

  const stationRows = net.stations
    .map((s) => {
      const ps = net.platforms.filter((p) => p.stationId === s.id);
      const lv = [...new Set(ps.map((p) => lvlName(p.level)))].join('・');
      const plats = ps.map((p) => `${escapeHtml(p.nameJa)}：${escapeHtml(p.lineIds.map(lineName).join('・'))}`).join('<br>');
      return `<tr><td>${badge(s.id)}${escapeHtml(s.nameJa)}</td><td>${escapeHtml(lv)}</td><td>${plats}</td></tr>`;
    })
    .join('');

  const calib = calibrationRows(g, data)
    .map(
      ({ ref, cell, typicalMin, ok }) =>
        `<tr><td>${badge(ref.from)}→${badge(ref.to)}</td><td>${ref.minutes}分</td><td>${cell ? jpDuration(cell.typicalS) : '—'}<br><span style="opacity:.7">最短 ${cell ? jpDuration(cell.bestS) : '—'}</span></td><td>${ok ? '✓' : `△ (${typicalMin.toFixed(1)}分)`}</td><td style="font-size:11px">${escapeHtml(ref.source)}</td></tr>`,
    )
    .join('');

  const profiles = Object.values(PROFILES)
    .map((p) => `<li><b>${escapeHtml(p.nameJa)}</b>：${escapeHtml(p.descJa)}</li>`)
    .join('');

  const sources = data.sources
    .map((s) => `<li>${s.url ? `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener">${escapeHtml(s.title)}</a>` : escapeHtml(s.title)}${s.note ? ` — ${escapeHtml(s.note)}` : ''}</li>`)
    .join('');

  return `
    <h2>このシミュレーターについて</h2>
    <p>梅田エリアの8駅（JR大阪駅・同うめきたエリア・阪急大阪梅田・阪神大阪梅田・Osaka Metro 梅田／東梅田／西梅田・JR北新地）を、ホーム・改札・通路・階段・エスカレーター・エレベーター・横断歩道からなる3次元の歩行者ネットワーク（${net.nodes.length}ノード・${net.edges.length}リンク）としてモデル化し、ホームからホームまでの最適な乗換ルートを計算します。</p>

    <h2>計算方法</h2>
    <ul>
      <li>経路探索：多始点ダイクストラ法。出発ホームの全乗車位置を始点にすると「乗換に便利な乗車位置」が同時に求まります。</li>
      <li>代替ルート：使った通路のコストを段階的に上げて再探索し、重なりが65%以下の経路だけを採用（地下経由・地上経由などの選択肢を提示）。</li>
      <li>乗換時間表：駅ごとに最短経路木を作り、全駅間を一括計算。「標準」は各ホームの中ほどで降りた場合の平均値です。</li>
      <li>混雑：平日・土休日の時間帯別需要と、通路ごとの混雑度から歩行者密度を推定し、Weidmannの歩行速度–密度関係で速度を落とします。群衆シミュレーションを動かすと、その実測密度を経路計算に反映できます。</li>
    </ul>

    <h2>移動時間の前提</h2>
    <div class="table-wrap"><table>
      <tr><th>要素</th><th>値</th></tr>
      <tr><td>平地の歩行</td><td>標準 ${PROFILES.standard.speed} m/s（歩き方で変更）</td></tr>
      <tr><td>階段</td><td>上り 高さ${STAIRS_UP_VV} m/s・下り ${STAIRS_DOWN_VV} m/s（1階分 約6mで上り20秒）</td></tr>
      <tr><td>エスカレーター</td><td>傾斜30°、${ESCALATOR_SPEED} m/s、乗り口待ち4秒（歩かない想定）</td></tr>
      <tr><td>エレベーター</td><td>平均待ち${ELEVATOR_WAIT_S}秒＋乗降10秒＋1 m/s</td></tr>
      <tr><td>改札通過</td><td>${GATE_S}秒（ICカード）</td></tr>
      <tr><td>横断歩道</td><td>平均信号待ち${CROSSING_WAIT_S}秒前後</td></tr>
    </table></div>
    <ul>${profiles}</ul>

    <h2>駅とホーム</h2>
    <div class="table-wrap"><table>
      <tr><th>駅</th><th>ホーム階</th><th>のりば</th></tr>
      ${stationRows}
    </table></div>

    <h2>公表値との比較</h2>
    <p>乗換案内サービスや駅の案内で一般に示される乗換時間と、本モデルの「標準」値（平日11時・混雑なし・標準の歩き方）の比較です。</p>
    <div class="table-wrap"><table>
      <tr><th>区間</th><th>公表値</th><th>モデル</th><th>判定</th><th>出典</th></tr>
      ${calib}
    </table></div>

    <h2>注意事項</h2>
    <ul>${data.caveats.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ul>

    <h2>参考にした情報</h2>
    <ul>${sources}</ul>
  `;
}
