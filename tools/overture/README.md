# 周辺の建物・道路データ（OpenStreetMap / Overture Maps）

3D表示の街並み（`src/data/osm/buildings.ts`・`roads.ts`・`malls.ts`）は、OpenStreetMap のデータ
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
TLS の検証にはシステムの証明書を使います。通信を中継するプロキシの証明書が必要な環境では
`--ca-bundle ファイル`（または環境変数 `OVERTURE_CA_BUNDLE`・`SSL_CERT_FILE`）で追加の CA を指定します。
`HTTPS_PROXY` は自動で使われます。座標は `builder.ts` の `ll()` と同じ変換（原点 北緯34.7025°・
東経135.4957°、x = 東、z = 南）です。生成は同じ入力からは毎回同じ出力になります。

`gen_osm.py` がしていること：

- **建物**：出典が OpenStreetMap のみの地上の建物。外形は約0.4 mで簡略化して0.1 m単位に丸め、
  小屋・塀のような細片は除外。高さは `height`、なければ階数×3.5 m（事務所・商業は階数×4 m）、
  どちらもなければ用途と面積からの推定値（`estimated` フラグ付き）。`height` が階数に対して
  低すぎる（1階あたり2.6 m未満。例：48階建てが100 m）ときは階数から求めます。ただし塔の乗る
  低層部の高さが塔の `min_height` と一致する場合はそのまま使います。`building:part` があれば
  それを立体の形に使います。JR大阪駅の駅舎（`station.ts` が描く）は除き、阪急大阪梅田・阪神梅田本店は
  名前と位置（重心から120 m以内）で見分けて `context.ts` が駅として扱います。20 m²未満の屋根
  （`building=roof`）は除外します（それより大きな屋根には描画側で細い柱を立て、歩行者の通り道をまたいで
  柱を立てる場所がない屋根は描きません）。
- **高さの補正表**（`HEIGHTS`）：OpenStreetMap の値が明らかに違うランドマークだけ、公表されている
  屋上高さに合わせます（塔の部分を比例で伸ばします）。ブリーゼタワー 175 m、グランフロント大阪
  オーナーズタワー 174.2 m・タワーA（南館）179.5 m、梅田阪急ビル（ツインタワーズ・ノース）187 m、
  サウスゲートビルディング 122 m、ハービスOSAKA 190 m・ハービスENT 133 m、梅田センタービル 134.7 m、
  阪急グランドビル 127 m。
- **道路**：幹線〜生活道路（trunk / primary / secondary / tertiary / unclassified / residential / service）
  の地上部分の中心線。トンネル・地下・高架部と、屋根の下を通る（`is_covered`）service 道路は除外。
  長さの半分以上が建物の中を通る service 道路（駐車場の通路・荷さばき場への引き込みなど）は除き、
  それ以外の service 道路も建物の中を3 m以上通る部分は描きません。一方通行は区間指定（`between`）も
  含めて取り込みます。上下線が別に描かれた道路（新御堂筋・曽根崎通・国道176号・御堂筋の梅田新道以北など）
  は一方通行の2本のまま扱い、並走区間では車道同士が重ならない幅に調整します。横断歩道
  （footway=crossing）の位置も取り込みます。川を渡る短い橋（大江橋・渡辺橋など）は地上の道路のままです。
- **高架道路**：阪神高速・新御堂筋の高架・国道176号の跨線橋などは、登録された階層（layer）から決めた
  高さの高架として出力し、地上の道路とつながる所は勾配6 %以内のランプで下ろします。
- **地下街**：ホワイティうめだ・ディアモール大阪は、地図の範囲（landuse=retail の区域）をそのまま
  地下1階の外形として出力します（`malls.ts`）。
- 出力は可変長整数の base64 文字列（`src/data/osm/codec.ts` で復号）と小さな座標表で、合計約150 KBです。

描画する範囲は `src/render/city-layout.ts` の `CITY_SQUARE`（中心 x 160・z −10、一辺1,700 m の正方形）で
固定です。ネットワークの節点が動いても建物が増減しないよう、取得・生成する範囲（`DEFAULT_BBOX`）は
これを20〜30 m の余裕をもって覆います。
