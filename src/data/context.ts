import type { NetBuilder } from './builder';

/**
 * Map context only (not routable): building podiums and road centrelines, drawn schematically.
 * Heights are clipped to the podium (≈3F) so the network stays readable.
 */
export function addContext(b: NetBuilder): void {
  // Stations
  b.rect('jr:roof', 'JR大阪駅 大屋根', [34.70255, 135.4959], 180, 100, 76, 22, 23, 'deck');
  // Along the platforms (350.6°), from the 1F BIGMAN plaza and the 3F gate concourse (south) to
  // the 茶屋町口 (north).
  b.rect('hankyu:bldg', '阪急大阪梅田駅・阪急三番街', [34.70581, 135.49858], 320, 150, 351, 0, 11, 'station');
  // The terminus platforms lie a floor below the B1 malls.
  b.rect('hanshin:bldg', '阪神梅田本店（大阪梅田ツインタワーズ・サウス）', [34.70085, 135.49705], 210, 75, 97, -13, 14, 'station');

  // Buildings
  const bl = (id: string, name: string, c: [number, number], l: number, w: number, bearing: number, h = 14) =>
    b.rect(id, name, c, l, w, bearing, 0, h, 'building');
  bl('ngb', 'ノースゲートビルディング（ルクア）', [34.70365, 135.4958], 170, 60, 76);
  bl('sgb', 'サウスゲートビルディング（大丸梅田店）', [34.7013, 135.4962], 140, 50, 76);
  bl('gfo-s', 'グランフロント大阪 南館', [34.70425, 135.4952], 110, 80, 355);
  bl('gfo-n', 'グランフロント大阪 北館', [34.70635, 135.4946], 190, 85, 355);
  bl('inogate', 'イノゲート大阪', [34.7028, 135.49375], 70, 40, 76);
  // A long N–S building over the うめきた underground station box (NAVITIME tenant points), north of イノゲート.
  bl('ugp', 'うめきたグリーンプレイス', [34.70345, 135.49362], 100, 40, 10, 10);
  bl('ggo-s', 'グラングリーン大阪 南館', [34.70231, 135.49163], 90, 70, 0);
  bl('kitte', 'JPタワー大阪（KITTE大阪）', [34.7012, 135.4941], 80, 60, 0);
  bl('yodobashi', 'ヨドバシ梅田タワー', [34.70455, 135.49665], 130, 95, 355);
  bl('hk-dept', '阪急うめだ本店', [34.70325, 135.49955], 110, 85, 355);
  bl('herbis', 'ハービスOSAKA', [34.7004, 135.4941], 90, 70, 0);
  bl('ekimae1', '大阪駅前第1ビル', [34.6996, 135.4958], 80, 40, 97, 12);
  bl('ekimae2', '大阪駅前第2ビル', [34.69945, 135.4972], 90, 40, 97, 12);
  bl('ekimae3', '大阪駅前第3ビル', [34.6994, 135.4987], 90, 40, 97, 12);
  bl('ekimae4', '大阪駅前第4ビル', [34.6993, 135.5001], 90, 40, 97, 12);
  bl('hepfive', 'HEP FIVE', [34.70375, 135.50055], 70, 60, 0);

  // Underground malls (drawn at B1)
  b.rect('whity', 'ホワイティうめだ', [34.7012, 135.4996], 230, 26, 60, -6.5, -1, 'mall');
  b.rect('diamor', 'ディアモール大阪', [34.69985, 135.4970], 280, 30, 97, -6.5, -1, 'mall');

  // Roads
  b.road('midosuji', '御堂筋', [[34.6935, 135.5003], [34.6977, 135.4998], [34.7018, 135.4988]], 40);
  // Passes between JR 御堂筋北口 and 阪急うめだ本店, where the 阪急百貨店前 crosswalk spans it.
  b.road('r176', '国道176号', [[34.7018, 135.4988], [34.70335, 135.49814], [34.7042, 135.4976], [34.7078, 135.4957]], 28);
  b.road('shinmidosuji', '新御堂筋', [[34.7018, 135.4988], [34.7035, 135.5009], [34.7080, 135.5022]], 36);
  b.road('ekimae', '大阪駅前（バスターミナル前）', [[34.7018, 135.4935], [34.70175, 135.4960], [34.7019, 135.4985]], 26);
  b.road('sonezaki', '国道2号（曽根崎通）', [[34.6988, 135.4925], [34.69849, 135.49556], [34.698055, 135.498509], [34.6977, 135.4998], [34.6972, 135.5035]], 36);
  b.road('yotsubashi', '四つ橋筋', [[34.6955, 135.4957], [34.69849, 135.49556], [34.7018, 135.4952]], 30);
  b.road('umekita-w', '市道九条梅田線', [[34.7005, 135.4929], [34.7040, 135.4930], [34.7080, 135.4933]], 22);
}
