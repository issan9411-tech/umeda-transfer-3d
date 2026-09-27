import type { NetBuilder } from './builder';
import type { Footprint } from '../core/types';
import { decodeBuildings, decodeRoads } from './osm/codec';
import { BUILDING_DATA, BUILDING_NAMES } from './osm/buildings';
import { ROAD_DATA, ROAD_NAMES } from './osm/roads';

/**
 * Map context (not routable): the stations' own blocks, the underground malls, and every
 * building and street around them as mapped in OpenStreetMap (via Overture Maps; see
 * tools/overture/gen_osm.py). Building heights are real metres (roof height; storeys × 3.5 m
 * where only a floor count is mapped, else estimated and flagged); streets are carriageway
 * centrelines at ground level with their mapped crosswalks.
 */
export function addContext(b: NetBuilder): void {
  // Stations
  b.rect('jr:roof', 'JR大阪駅 大屋根', [34.70255, 135.4959], 180, 100, 76, 22, 23, 'deck');
  const osm = decodeBuildings(BUILDING_DATA, BUILDING_NAMES);
  // 阪急大阪梅田駅 (with 阪急三番街 below the 3F platforms): the mapped outline; the city draws its
  // concourse block and train shed. The 阪急ターミナルビル rising from its south end is a building
  // of its own.
  if (osm.hankyu) {
    const { parts, ...outline } = osm.hankyu;
    b.footprints.push({ ...outline, id: 'hankyu:bldg', nameJa: '阪急大阪梅田駅・阪急三番街', y0: 0, y1: 11, kind: 'station' });
    for (const p of parts ?? []) {
      if (p.y1 <= 30) continue;
      b.footprints.push({ id: 'osm:hankyu-terminal', nameJa: '阪急ターミナルビル', poly: p.poly, y0: Math.max(10.4, p.y0), y1: p.y1, kind: 'building', source: 'osm', use: 'commercial' });
    }
  }
  // 阪神梅田本店 (大阪梅田ツインタワーズ・サウス): store podium and tower as mapped. The terminus
  // platforms lie a floor below the B1 malls.
  if (osm.hanshin) b.footprints.push({ ...osm.hanshin, id: 'hanshin:bldg', nameJa: '阪神梅田本店（大阪梅田ツインタワーズ・サウス）', y0: -13, y1: 14, kind: 'station' });

  // Underground malls (drawn at B1)
  b.rect('whity', 'ホワイティうめだ', [34.7012, 135.4996], 230, 26, 60, -6.5, -1, 'mall');
  b.rect('diamor', 'ディアモール大阪', [34.69985, 135.4970], 280, 30, 97, -6.5, -1, 'mall');

  // Buildings and streets
  const buildings: Footprint[] = osm.buildings;
  b.footprints.push(...buildings);
  b.roads.push(...decodeRoads(ROAD_DATA, ROAD_NAMES));
}
