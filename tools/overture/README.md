# 周辺の建物・道路データ（OpenStreetMap / Overture Maps）

3D表示の街並み（`src/data/osm/buildings.ts`・`roads.ts`）は、OpenStreetMap のデータ
（© OpenStreetMap contributors, [ODbL 1.0](https://opendatacommons.org/licenses/odbl/)）を
[Overture Maps](https://overturemaps.org/) の配布版（GeoParquet）から取り出して生成しています。
生成物は手で編集せず、次の2段階で作り直してください（Python 3 + `pyarrow`・`shapely`）。

```sh
# 1. 梅田周辺（東経135.484–135.510・北緯34.690–34.714）を取得し、アプリのローカル座標（m）の JSON に変換
python3 tools/overture/fetch.py /tmp/umeda-osm            # --release 2026-09-23.1 が既定

# 2. TypeScript モジュールを生成（src/data/osm/ に書き出す）
python3 tools/overture/gen_osm.py /tmp/umeda-osm
```

`fetch.py` は S3 の公開バケットから HTTP レンジ要求で必要な行グループだけを読みます（認証不要）。
座標は `builder.ts` の `ll()` と同じ変換（原点 北緯34.7025°・東経135.4957°、x = 東、z = 南）です。

`gen_osm.py` がしていること：

- **建物**：出典が OpenStreetMap のみの地上の建物。外形は約0.4 mで簡略化して0.1 m単位に丸め、
  小屋・塀のような細片は除外。高さは `height`、なければ階数×3.5 m、どちらもなければ用途と面積からの
  推定値（`estimated` フラグ付き）。`building:part` があればそれを立体の形に使います。JR大阪駅の
  駅舎（`station.ts` が描く）は除き、阪急大阪梅田・阪神梅田本店は `context.ts` が駅として扱います。
- **道路**：幹線〜生活道路（trunk / primary / secondary / tertiary / unclassified / residential / service）
  の地上部分の中心線。トンネル・地下・高架部は除外。上下線が別に描かれた道路（新御堂筋・曽根崎通・
  国道176号・御堂筋の梅田新道以北など）は一方通行の2本のまま扱い、並走区間では車道同士が重ならない
  幅に調整します。横断歩道（footway=crossing）の位置も取り込みます。川を渡る短い橋（大江橋・渡辺橋など）は
  地上の道路のままです。
- **高架道路**：阪神高速・新御堂筋の高架・国道176号の跨線橋などは、登録された階層（layer）から決めた
  高さの高架として出力し、地上の道路とつながる所は勾配6 %以内のランプで下ろします。
- 出力は可変長整数の base64 文字列（`src/data/osm/codec.ts` で復号）で、合計約150 KBです。
