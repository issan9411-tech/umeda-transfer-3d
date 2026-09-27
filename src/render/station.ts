import * as THREE from 'three';
import type { EdgeKind, Line, NetEdge, NetNode, Network, Platform } from '../core/types';
import { clipToRect, frameOf, gaps, hash01, Lines, Mesher, P, rectMinusHoles, toLocal, toWorld, type Frame, type Rect, type V3 } from './station-geo';
import { BED_REPEAT, BED_WIDTH, signAtlas, trackBedTexture, type NameSign, type NumberSign, type SignSpec, type SignStyle } from './station-tex';
import { carsFor, liveryFor, placeSoup, trainLength, trainMaterials, trainParts } from './train';
import { CLEARANCE, flightWidth, WalkSpace, type WalkPiece } from './walk-space';
import { verticalLaneOffsets } from './walkway';
import { WELL_HEADROOM } from '../data/builder';

export { disposeStationTextures } from './station-tex';
export { disposeTrainTextures } from './train';

/**
 * Station architecture and rolling stock for the eight Umeda stations.
 *
 * - JR大阪駅: viaduct deck with ballasted tracks, platform slabs (white edge, yellow tactile strip,
 *   stairwell openings with parapets), canopies with columns and light strips outside the 大屋根,
 *   the arched glass-and-steel 大屋根 itself, the 3F 橋上駅舎 deck, catenary portals and wires.
 * - 阪急大阪梅田: the 3F terminus (10 platforms / 9 tracks), a train shed with skylights over the
 *   gate end, canopies beyond, buffer stops at the gate end.
 * - Underground stations: a box per station whose walls and ceiling face INWARD only (single-sided),
 *   so the overview camera above still looks in; pillars, light strips, slab track, platform doors,
 *   wall-mounted 駅名標 and advertising panels, tunnel mouths, a vaulted ceiling at 御堂筋線梅田.
 * - Hanging / standing 駅名標 and platform-number signs from one canvas atlas.
 * - Stationary trains on a deterministic subset of tracks (train.ts).
 *
 * In the walk-through the architecture gives way to the space people walk through (walk-space.ts):
 * slabs open over whole staircases and are recessed over passages below them (the 桜橋口 中2階
 * under the viaduct), walls get doorways with sills and lintels where walkways pass, beams and
 * barriers are trimmed, piers and roof supports move aside, and platform columns keep off the
 * walking lines. The walker, who follows the network's centre lines, never passes through them.
 *
 * Vertical sizes: positions come from `Y()`; local sizes (platform height, canopies, trains) are
 * scaled by `hs = min(ex, 2)`, i.e. real ×1.5 while walking (matching people and stairs) and
 * capped in the overview so trains don't turn into towers.
 *
 * Everything is merged into ~15 draw calls; all geometries and materials hang off the returned
 * group (the view's clearGroup disposes them); the shared canvas textures are cached per module
 * and released by disposeStationTextures()/disposeTrainTextures().
 */

export interface StationOptions {
  /** Maps a real elevation (m) to scene Y. */
  Y: (y: number) => number;
  /** Vertical exaggeration currently applied. */
  ex: number;
  dark: boolean;
  levelVisible: (level: string) => boolean;
  /** Walk-through mode: full detail (platform tops, signs, pillars, doors, bogies). */
  walk: boolean;
  /** Tracks where the caller parks its own trains (buildTrainModel): kept free here. */
  occupied?: { platformId: string; side: 1 | -1 }[];
  /** Platforms near the route: in walk mode both of their tracks get a train. */
  focus?: string[];
  /** Edge ids of the selected route (its stair flights are centred, as in walkway.ts). */
  routeEdges?: ReadonlySet<string>;
}

export interface TrainModelOptions {
  Y: (y: number) => number;
  ex: number;
  dark: boolean;
  /** Which side of the platform: 1 = left of a→b, −1 = right. Snaps to the side that has a track. */
  side?: 1 | -1;
  /** Car count override (default: line formation capped by platform length). */
  cars?: number;
  /** Bogies and wheels (default true). */
  detail?: boolean;
}

// ------------------------------------------------------------------------------------------------
// Station configuration

interface StationCfg {
  kind: 'elevated' | 'underground';
  style: SignStyle;
  /** Track run beyond the platform ends (a-end, b-end); 0 = terminus with buffer stops there. */
  ext: [number, number];
  /** Canopy (elevated) or ceiling (underground) height above the platform (m). */
  ceil: number;
  /** Extra rise of a vaulted ceiling (m). */
  vault?: number;
  doors?: 'half' | 'full';
  power: 'overhead' | 'rigid' | 'third';
  /** Platforms with a track on one side only (1 = left, −1 = right). */
  oneSide?: Record<string, 1 | -1>;
  /** Platform records are 3-track groups (阪急). */
  groups?: boolean;
  pillars?: boolean;
  wall: [string, string];
  kanji: string;
  kana: string;
  roman: string;
}

const STATIONS: Record<string, StationCfg> = {
  jr: { kind: 'elevated', style: 'jr', ext: [90, 90], ceil: 4.2, power: 'overhead', oneSide: { 'jr-11': -1 }, wall: ['#e7e4dd', '#66645f'], kanji: '大阪', kana: 'おおさか', roman: 'Ōsaka' },
  umekita: { kind: 'underground', style: 'jr', ext: [14, 14], ceil: 5.2, doors: 'full', power: 'rigid', pillars: true, wall: ['#e9e7e2', '#5f6064'], kanji: '大阪', kana: 'おおさか', roman: 'Ōsaka' },
  kitashinchi: { kind: 'underground', style: 'jr', ext: [14, 14], ceil: 4.6, doors: 'half', power: 'rigid', pillars: true, wall: ['#e6e2da', '#615e59'], kanji: '北新地', kana: 'きたしんち', roman: 'Kitashinchi' },
  hankyu: { kind: 'elevated', style: 'hankyu', ext: [0, 110], ceil: 4.2, power: 'overhead', groups: true, wall: ['#e7e4dd', '#66645f'], kanji: '大阪梅田', kana: 'おおさかうめだ', roman: 'Ōsaka-umeda' },
  hanshin: { kind: 'underground', style: 'hanshin', ext: [14, 0], ceil: 4.4, power: 'rigid', pillars: true, wall: ['#e4e6e8', '#5c6066'], kanji: '大阪梅田', kana: 'おおさかうめだ', roman: 'Ōsaka-umeda' },
  umeda: { kind: 'underground', style: 'metro', ext: [14, 14], ceil: 4.3, vault: 2.6, doors: 'half', power: 'third', wall: ['#ece7df', '#65615b'], kanji: '梅田', kana: 'うめだ', roman: 'Umeda' },
  higashiumeda: { kind: 'underground', style: 'metro', ext: [14, 14], ceil: 4.2, doors: 'half', power: 'third', pillars: true, wall: ['#e8e4ec', '#625e68'], kanji: '東梅田', kana: 'ひがしうめだ', roman: 'Higashi-Umeda' },
  nishiumeda: { kind: 'underground', style: 'metro', ext: [14, 0], ceil: 4.2, doors: 'half', power: 'third', pillars: true, wall: ['#e2e8ee', '#5b6167'], kanji: '西梅田', kana: 'にしうめだ', roman: 'Nishi-Umeda' },
};

/** Station number and neighbouring stations shown on the 駅名標, per line. */
const LINE_SIGN: Record<string, { number?: string; prev?: string; next?: string; short: string }> = {
  'jr-loop': { number: 'O11', prev: '福島', next: '天満', short: '環状線' },
  'jr-kobe': { number: 'A47', prev: '塚本', next: '新大阪', short: '神戸線' },
  'jr-kyoto': { number: 'A47', prev: '塚本', next: '新大阪', short: '京都線' },
  'jr-takarazuka': { number: 'G47', prev: '塚本', next: '新大阪', short: '宝塚線' },
  'jr-ltd': { number: 'A47', next: '新大阪', short: '特急' },
  'jr-umekita': { number: 'A47', prev: '西九条', next: '新大阪', short: '特急はるか' },
  'jr-higashi': { next: '新大阪', short: 'おおさか東線' },
  'jr-tozai': { number: 'H44', prev: '海老江', next: '大阪天満宮', short: 'JR東西線' },
  'hankyu-kyoto': { number: 'HK01', next: '十三', short: '京都線' },
  'hankyu-takarazuka': { number: 'HK01', next: '中津', short: '宝塚線' },
  'hankyu-kobe': { number: 'HK01', next: '中津', short: '神戸線' },
  hanshin: { number: 'HS01', next: '福島', short: '本線' },
  midosuji: { number: 'M16', prev: '中津', next: '淀屋橋', short: '御堂筋線' },
  tanimachi: { number: 'T20', prev: '中崎町', next: '南森町', short: '谷町線' },
  yotsubashi: { number: 'Y11', next: '肥後橋', short: '四つ橋線' },
};

/** Short destination text per track on the hanging number signs. */
const TRACK_TEXT: Record<string, string> = {
  'jr:1': '環状線 天王寺方面',
  'jr:2': '環状線 京橋方面',
  'jr:3': '宝塚線 宝塚方面',
  'jr:4': '神戸線 三ノ宮方面',
  'jr:5': '神戸線 姫路方面',
  'jr:6': '神戸線・宝塚線',
  'jr:7': '京都線 高槻方面',
  'jr:8': '京都線 京都方面',
  'jr:9': '京都線 京都方面',
  'jr:10': '特急・始発',
  'jr:11': '特急 敦賀・高山',
  'umekita:21': 'はるか 関西空港',
  'umekita:22': 'おおさか東線',
  'umekita:23': 'おおさか東線',
  'umekita:24': 'はるか 京都方面',
  'kitashinchi:1': '尼崎・宝塚方面',
  'kitashinchi:2': '京橋・木津方面',
  'umeda:1': 'なんば・天王寺',
  'umeda:2': '新大阪・千里中央',
  'higashiumeda:1': '天王寺・八尾南',
  'higashiumeda:2': '都島・大日',
  'nishiumeda:1': 'なんば方面',
  'nishiumeda:2': 'なんば方面',
};

/** Distance from a platform edge to the centre of the adjacent track (m). */
const EDGE_TO_TRACK = 1.65;
/** Candidate tracks closer than this are one shared track (e.g. between 阪神's two platforms). */
const MERGE_TRACKS = 3.4;
/** Platform height above rail top (m). */
const PLAT_H = 1.15;

// ------------------------------------------------------------------------------------------------
// Layout (pure plan data; exported for tests)

export interface Surf {
  /** Platform record this surface belongs to (for signs and route focus). */
  p: Platform;
  t0: number;
  t1: number;
  s0: number;
  s1: number;
  /** Terminal concourse slab joining the platform ends. */
  head?: boolean;
  /** A narrower or shifted piece of the platform (Platform.sections): a walkway, no stops. */
  section?: boolean;
  /** Track index on each side (−1 = right/t0 side, 1 = left/t1 side). */
  track: { [side: number]: number | undefined };
}

export interface Track {
  t: number;
  s0: number;
  s1: number;
  buf0: boolean;
  buf1: boolean;
  lineId: string;
  label: string;
  /** Surfaces (index, side of the surface) facing this track. */
  surfs: [number, 1 | -1][];
}

export interface StationLayout {
  id: string;
  cfg: StationCfg;
  f: Frame;
  level: string;
  /** Platform elevation (m). */
  py: number;
  surfs: Surf[];
  tracks: Track[];
  /** Deck (elevated) or box (underground) extent. */
  box: Rect;
}

const layoutCache = new WeakMap<Network, StationLayout[]>();

export function stationLayouts(net: Network): StationLayout[] {
  const hit = layoutCache.get(net);
  if (hit) return hit;
  const out: StationLayout[] = [];
  for (const [id, cfg] of Object.entries(STATIONS)) {
    const l = layoutStation(net, id, cfg);
    if (l) out.push(l);
  }
  layoutCache.set(net, out);
  // Remember each platform's tracks so buildTrainModel can stand a train exactly on the rails.
  for (const l of out) {
    for (const s of l.surfs) {
      if (s.head || s.section) continue;
      const [sa, ta] = toLocal(l.f, s.p.a[0], s.p.a[1]);
      const [sb, tb] = toLocal(l.f, s.p.b[0], s.p.b[1]);
      const centre = (ta + tb) / 2;
      const sign = sb >= sa ? 1 : -1;
      const rec = trackMemo.get(s.p) ?? {};
      for (const side of [1, -1] as const) {
        const ti = s.track[side];
        if (ti === undefined) continue;
        const tr = l.tracks[ti];
        // In the platform's own a→b frame; a group record (阪急) spans several surfaces, so keep
        // the nearest track on each side of its centreline.
        const off = (tr.t - centre) * sign;
        const key = off >= 0 ? 1 : -1;
        const prev = rec[key];
        const [a0, a1] = [(tr.s0 - sa) * sign, (tr.s1 - sa) * sign];
        if (!prev || Math.abs(off) < Math.abs(prev.off)) rec[key] = { off, s0: Math.min(a0, a1), s1: Math.max(a0, a1), buf0: sign > 0 ? tr.buf0 : tr.buf1, buf1: sign > 0 ? tr.buf1 : tr.buf0, t: tr.t };
      }
      trackMemo.set(s.p, rec);
    }
  }
  return out;
}

/** Per platform: lateral offset of the track on each side (along the platform's own a→b axis). */
const trackMemo = new WeakMap<Platform, Record<number, { off: number; s0: number; s1: number; buf0: boolean; buf1: boolean; t: number }>>();

function layoutStation(net: Network, id: string, cfg: StationCfg): StationLayout | null {
  const plats = net.platforms.filter((p) => p.stationId === id);
  if (plats.length === 0) return null;
  const f = frameOf(plats[0].a, plats[0].b);
  const loc = (p: Platform) => {
    const [sa, ta] = toLocal(f, p.a[0], p.a[1]);
    const [sb, tb] = toLocal(f, p.b[0], p.b[1]);
    return { s0: Math.min(sa, sb), s1: Math.max(sa, sb), t: (ta + tb) / 2 };
  };
  const surfs: Surf[] = [];
  const tracks: Track[] = [];
  const extend = (s0: number, s1: number) => ({
    s0: cfg.ext[0] > 0 ? s0 - cfg.ext[0] : s0 + 1.5,
    s1: cfg.ext[1] > 0 ? s1 + cfg.ext[1] : s1 - 1.5,
    buf0: cfg.ext[0] === 0,
    buf1: cfg.ext[1] === 0,
  });

  if (cfg.groups) {
    // Each record is a 3-track group, width = two track pitches: tracks at centre ± w/4 and a
    // third midway to the next group, so the walk centreline lies on a platform between tracks.
    const gs = plats.map((p) => ({ p, ...loc(p) })).sort((a, b) => a.t - b.t);
    const ts: { t: number; p: Platform; s0: number; s1: number }[] = [];
    gs.forEach((g, i) => {
      const q = g.p.width / 4;
      const nx = gs[i + 1];
      ts.push({ t: g.t - q, p: g.p, s0: g.s0, s1: g.s1 }, { t: g.t + q, p: g.p, s0: g.s0, s1: g.s1 });
      ts.push({ t: nx ? (g.t + q + nx.t - nx.p.width / 4) / 2 : g.t + 3 * q, p: g.p, s0: g.s0, s1: g.s1 });
    });
    ts.forEach((x, i) => tracks.push({ t: x.t, ...extend(x.s0, x.s1), lineId: x.p.lineIds[0], label: String(i + 1), surfs: [] }));
    const outer = 7.5;
    const edges = [ts[0].t - EDGE_TO_TRACK - outer, ...ts.map((x) => x.t), ts[ts.length - 1].t + EDGE_TO_TRACK + outer];
    for (let i = 0; i < edges.length - 1; i++) {
      const t0 = i === 0 ? edges[0] : edges[i] + EDGE_TO_TRACK;
      const t1 = i === edges.length - 2 ? edges[i + 1] : edges[i + 1] - EDGE_TO_TRACK;
      const mid = (t0 + t1) / 2;
      const g = gs.reduce((best, x) => (Math.abs(x.t - mid) < Math.abs(best.t - mid) ? x : best));
      surfs.push({ p: g.p, t0, t1, s0: g.s0, s1: g.s1, track: { [-1]: i > 0 ? i - 1 : undefined, [1]: i < ts.length ? i : undefined } });
    }
  } else {
    const cand: { t: number; s0: number; s1: number; lineId: string; label: string; surf: number; side: 1 | -1 }[] = [];
    for (const p of plats) {
      const q = loc(p);
      const si = surfs.push({ p, t0: q.t - p.width / 2, t1: q.t + p.width / 2, s0: q.s0, s1: q.s1, track: {} }) - 1;
      const nums = p.nameJa.match(/\d+/g) ?? [];
      for (const side of [-1, 1] as const) {
        if (cfg.oneSide?.[p.id] && cfg.oneSide[p.id] !== side) continue;
        const t = q.t + side * (p.width / 2 + EDGE_TO_TRACK);
        const lineId = p.lineIds[side === -1 ? 0 : Math.min(1, p.lineIds.length - 1)];
        const label = (side === -1 ? nums[0] : nums[nums.length - 1]) ?? '';
        cand.push({ t, s0: q.s0, s1: q.s1, lineId, label, surf: si, side });
      }
    }
    cand.sort((a, b) => a.t - b.t);
    for (const c of cand) {
      const last = tracks[tracks.length - 1];
      if (last && c.t - last.t < MERGE_TRACKS) {
        const n = last.surfs.length;
        last.t = (last.t * n + c.t) / (n + 1);
        const e = extend(c.s0, c.s1);
        last.s0 = Math.min(last.s0, e.s0);
        last.s1 = Math.max(last.s1, e.s1);
        last.surfs.push([c.surf, c.side]);
      } else tracks.push({ t: c.t, ...extend(c.s0, c.s1), lineId: c.lineId, label: c.label, surfs: [[c.surf, c.side]] });
      surfs[c.surf].track[c.side] = tracks.length - 1;
    }
    // Platform sections (narrow walkways beyond the stopping area) add no tracks: an edge faces
    // the track that runs 1.65 m from it, if any.
    for (const p of plats) {
      for (const sec of p.sections ?? []) {
        const [sa, ta] = toLocal(f, sec.a[0], sec.a[1]);
        const [sb, tb] = toLocal(f, sec.b[0], sec.b[1]);
        const t = (ta + tb) / 2;
        const sf: Surf = { p, t0: t - sec.width / 2, t1: t + sec.width / 2, s0: Math.min(sa, sb), s1: Math.max(sa, sb), section: true, track: {} };
        for (const side of [-1, 1] as const) {
          const want = (side === 1 ? sf.t1 : sf.t0) + side * EDGE_TO_TRACK;
          const i = tracks.findIndex((tr) => Math.abs(tr.t - want) < 0.6 && tr.s0 < sf.s0 && tr.s1 > sf.s1);
          if (i >= 0) sf.track[side] = i;
        }
        surfs.push(sf);
      }
    }
  }
  if (cfg.groups) tracks.forEach((tr, i) => surfs.forEach((s, si) => [-1, 1].forEach((side) => s.track[side] === i && tr.surfs.push([si, side as 1 | -1]))));

  // Terminal head slab across all platforms beyond the buffer stops.
  const ps0 = Math.min(...surfs.map((s) => s.s0));
  const ps1 = Math.max(...surfs.map((s) => s.s1));
  const tr0 = Math.min(...tracks.map((t) => t.t)) - 2.4;
  const tr1 = Math.max(...tracks.map((t) => t.t)) + 2.4;
  const bt0 = Math.min(tr0, ...surfs.map((s) => s.t0));
  const bt1 = Math.max(tr1, ...surfs.map((s) => s.t1));
  const head = cfg.kind === 'underground' ? 6 : 9;
  if (cfg.ext[0] === 0) {
    for (const s of surfs) s.s0 = Math.max(s.s0, ps0 + 1);
    surfs.push({ p: plats[0], t0: bt0, t1: bt1, s0: ps0 - head, s1: ps0 + 1, head: true, track: {} });
  }
  if (cfg.ext[1] === 0) {
    for (const s of surfs) if (!s.head) s.s1 = Math.min(s.s1, ps1 - 1);
    surfs.push({ p: plats[0], t0: bt0, t1: bt1, s0: ps1 - 1, s1: ps1 + head, head: true, track: {} });
  }
  const box: Rect = {
    s0: Math.min(...tracks.map((t) => t.s0), ...surfs.map((s) => s.s0)),
    s1: Math.max(...tracks.map((t) => t.s1), ...surfs.map((s) => s.s1)),
    t0: bt0,
    t1: bt1,
  };
  return { id, cfg, f, level: plats[0].level, py: plats[0].y, surfs, tracks, box };
}

// ------------------------------------------------------------------------------------------------
// Stairwells: footprints of the stairs / escalators / elevators drawn by walkway.ts

export interface Well {
  kind: EdgeKind;
  /** Plan corners (x, z) of the whole staircase (foot to head). */
  corners: [number, number][];
  /** Scene Y of the foot and the head of the whole staircase. */
  lo: number;
  hi: number;
  /** Head position (x, z): the side people step off at, left open by the parapets. */
  head: [number, number];
  /** Opening this staircase needs in a slab at scene height y (plan corners). */
  at: (y: number) => [number, number][];
}

const VERTICAL = new Set<EdgeKind>(['stairs', 'escalator', 'elevator']);

/**
 * The openings flights need in the slabs they pass through. builder.ts lays a staircase out as
 * straight flights joined by level landings (nodes flagged `landing`); like walkway.ts, a slab is
 * cut only where the staircase is less than head room (WELL_HEADROOM) below it, up to where it
 * comes through: a platform keeps its floor over the lower flights and landings. Plan outline as
 * walkway.ts's floor wells (0.05 m before the head, 0.15 m beside the flight); lane offsets from
 * the shared table (route flight centred).
 */
export function computeWells(net: Network, o: Pick<StationOptions, 'Y' | 'levelVisible' | 'routeEdges'>): Well[] {
  const byId = new Map(net.nodes.map((n) => [n.id, n]));
  const lanes = verticalLaneOffsets(net, o.routeEdges);
  const vertAt = new Map<string, number[]>();
  net.edges.forEach((e, i) => {
    if (!VERTICAL.has(e.kind)) return;
    for (const id of [e.a, e.b]) vertAt.set(id, [...(vertAt.get(id) ?? []), i]);
  });
  const headroom = o.Y(WELL_HEADROOM) - o.Y(0);
  const used = new Set<number>();
  const wells: Well[] = [];
  net.edges.forEach((e, ei) => {
    if (!VERTICAL.has(e.kind) || used.has(ei)) return;
    used.add(ei);
    // The chain of nodes from one end of the staircase to the other, through its landings.
    const sides: NetNode[][] = [];
    for (const start of [e.a, e.b]) {
      const seq: NetNode[] = [byId.get(start) as NetNode];
      let at = start;
      let prev = ei;
      while ((byId.get(at) as NetNode).landing) {
        const next = (vertAt.get(at) ?? []).find((i) => i !== prev && !used.has(i));
        if (next === undefined) break;
        used.add(next);
        prev = next;
        at = net.edges[next].a === at ? net.edges[next].b : net.edges[next].a;
        seq.push(byId.get(at) as NetNode);
      }
      sides.push(seq);
    }
    let chain = [...sides[0].reverse(), ...sides[1]];
    if (chain[0].y > chain[chain.length - 1].y) chain = chain.reverse();
    const lo = chain[0];
    const hi = chain[chain.length - 1];
    if (!o.levelVisible(lo.level) && !o.levelVisible(hi.level)) return;
    let dx = hi.x - lo.x;
    let dz = hi.z - lo.z;
    const run = Math.hypot(dx, dz);
    if (run < 1e-3) [dx, dz] = [1, 0];
    else [dx, dz] = [dx / run, dz / run];
    const [lx, lz] = [dz, -dx];
    const ax = lo.x + lanes[ei * 2];
    const az = lo.z + lanes[ei * 2 + 1];
    const bx = hi.x + lanes[ei * 2];
    const bz = hi.z + lanes[ei * 2 + 1];
    const hw = flightWidth(e) / 2 + 0.15;
    const rect = (s0: number, s1: number): [number, number][] => [
      [ax + dx * s0 + lx * hw, az + dz * s0 + lz * hw],
      [ax + dx * s0 - lx * hw, az + dz * s0 - lz * hw],
      [ax + dx * s1 - lx * hw, az + dz * s1 - lz * hw],
      [ax + dx * s1 + lx * hw, az + dz * s1 + lz * hw],
    ];
    if (e.kind === 'elevator' || run < 0.5) {
      const mx = (ax + bx) / 2;
      const mz = (az + bz) / 2;
      const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]): [number, number] => [mx + dx * u * hw + lx * v * hw, mz + dz * u * hw + lz * v * hw]);
      wells.push({ kind: e.kind, corners, lo: o.Y(lo.y), hi: o.Y(hi.y), head: [bx, bz], at: () => corners });
      return;
    }
    // Height profile along the staircase (scene Y against the distance from its foot).
    const prof = chain.map((n) => ({ s: Math.max(0, Math.min(run, (n.x - lo.x) * dx + (n.z - lo.z) * dz)), y: o.Y(n.y) }));
    const sAt = (y: number) => {
      if (y <= prof[0].y) return -0.1;
      for (let i = 1; i < prof.length; i++) {
        const p0 = prof[i - 1];
        const p1 = prof[i];
        if (y > p1.y) continue;
        return p1.y - p0.y < 1e-6 ? p0.s : p0.s + ((y - p0.y) / (p1.y - p0.y)) * (p1.s - p0.s);
      }
      return run - 0.05;
    };
    const top = run - 0.05;
    wells.push({
      kind: e.kind,
      corners: rect(-0.1, top),
      lo: o.Y(lo.y),
      hi: o.Y(hi.y),
      head: [bx, bz],
      at: (y) => rect(Math.max(-0.1, sAt(y - headroom) - 0.1), Math.min(top, Math.max(sAt(y), sAt(y - headroom) + 0.3))),
    });
  });
  return wells;
}

/**
 * Walking lines along a station's platforms (builder.ts runs them beside the stair wells) in its
 * frame, with how far people stray from them (crowd.ts lateralRoom for platforms, capped at 2 m).
 */
function walkingLines(net: Network, l: StationLayout): { t: number; s0: number; s1: number; room: number }[] {
  const byId = new Map(net.nodes.map((n) => [n.id, n]));
  const plats = new Set(l.surfs.map((s) => s.p.id));
  const out: { t: number; s0: number; s1: number; room: number }[] = [];
  for (const e of net.edges) {
    if (e.kind !== 'platform') continue;
    const a = byId.get(e.a) as NetNode;
    const b = byId.get(e.b) as NetNode;
    // Boarding positions carry their platform; stair heads and the steps onto a platform's
    // narrower walkway (JR 西口) only their station.
    if (!(a.platformId ? plats.has(a.platformId) : a.stationId === l.id)) continue;
    const [sa, ta] = toLocal(l.f, a.x, a.z);
    const [sb, tb] = toLocal(l.f, b.x, b.z);
    const w = Math.min(16, Math.max(3, e.width ?? 6));
    const room = Math.min(2, Math.max(0, w / 2 - 1.6));
    // A line that steps sideways is kept as short pieces, each at its own lateral position.
    const n = Math.max(1, Math.ceil(Math.abs(tb - ta) / 0.5));
    for (let i = 0; i < n; i++) {
      const s0 = sa + ((sb - sa) * i) / n;
      const s1 = sa + ((sb - sa) * (i + 1)) / n;
      out.push({ t: ta + ((tb - ta) * (i + 0.5)) / n, s0: Math.min(s0, s1), s1: Math.max(s0, s1), room });
    }
  }
  return out;
}

/**
 * Lateral positions of the column lines along platform surface s: each wanted line moved as little
 * as possible (towards the platform's middle first) so that columns of half-width r keep clear of
 * the people on the walking lines and 1.5 m from edges facing a track. Lines left without room,
 * or closer than 1.5 m to one already placed, are dropped.
 */
function columnRows(ctx: Ctx, l: StationLayout, s: Surf, want: number[], r: number): number[] {
  const lines = (ctx.lines.get(l) ?? []).filter((x) => x.s1 > s.s0 && x.s0 < s.s1);
  const lo = s.t0 + (s.track[-1] !== undefined ? 1.5 : 0.5) + r;
  const hi = s.t1 - (s.track[1] !== undefined ? 1.5 : 0.5) - r;
  const ok = (t: number) => t >= lo && t <= hi && lines.every((x) => Math.abs(t - x.t) >= x.room + 0.3 + r);
  const mid = (s.t0 + s.t1) / 2;
  const rows: number[] = [];
  for (const t of want) {
    let best: number | null = null;
    for (let d = 0; d <= s.t1 - s.t0 && best === null; d += 0.25) {
      const inward = t < mid ? 1 : -1;
      best = [t + inward * d, t - inward * d].find(ok) ?? null;
    }
    if (best !== null && rows.every((x) => Math.abs(x - (best as number)) >= 1.5)) rows.push(best);
  }
  return rows;
}

/** Local bounding rectangle of a well. */
function wellRect(f: Frame, w: Well, y?: number): Rect {
  const pts = (y === undefined ? w.corners : w.at(y)).map(([x, z]) => toLocal(f, x, z));
  return { s0: Math.min(...pts.map((p) => p[0])), s1: Math.max(...pts.map((p) => p[0])), t0: Math.min(...pts.map((p) => p[1])), t1: Math.max(...pts.map((p) => p[1])) };
}

/** Wells that cut through a horizontal surface at scene height y. */
function wellsThrough(wells: Well[], y: number): Well[] {
  return wells.filter((w) => w.lo < y - 0.3 && w.hi > y - 0.3);
}

const overlaps = (a: Rect, b: Rect, m = 0) => a.s0 < b.s1 + m && a.s1 > b.s0 - m && a.t0 < b.t1 + m && a.t1 > b.t0 - m;

// ------------------------------------------------------------------------------------------------
// Walkable space (walk-space.ts) seen from a station's plan frame. In the walk-through every slab,
// wall, beam and column is kept out of it, so the walker never passes through the architecture.

type Skip = (p: WalkPiece) => boolean;

/** Where a walk piece's clear volume meets a frame rectangle (real metres). */
export interface Hit {
  p: WalkPiece;
  /** Bounding rectangle of the overlap in the frame. */
  r: Rect;
  /** Lowest floor and highest head room (floor + clearance) over the overlap. */
  lo: number;
  hi: number;
}

/** Vertical part of a panel or post: u range along it (s0/s1) and real heights (t0/t1). */
export type Part = Rect;

export class FrameSpace {
  private readonly local = new Map<WalkPiece, { poly: [number, number][]; g0: number; gs: number; gt: number }>();

  constructor(
    readonly space: WalkSpace,
    readonly f: Frame,
  ) {}

  private toLocal(p: WalkPiece) {
    let l = this.local.get(p);
    if (!l) {
      const { ox, oz, dx, dz } = this.f;
      // Floor plane f0 + fx·x + fz·z with x = ox + dx·s + dz·t, z = oz + dz·s − dx·t.
      l = { poly: p.poly.map(([x, z]) => toLocal(this.f, x, z)), g0: p.f0 + p.fx * ox + p.fz * oz, gs: p.fx * dx + p.fz * dz, gt: p.fx * dz - p.fz * dx };
      this.local.set(p, l);
    }
    return l;
  }

  /** Clear volumes that reach into the box r (shrunk by eps, or epsS / epsT) × real heights [y0, y1]. */
  hits(r: Rect, y0: number, y1: number, skip?: Skip, eps = 0.02, epsT = eps): Hit[] {
    const rr: Rect = { s0: r.s0 + eps, s1: r.s1 - eps, t0: r.t0 + epsT, t1: r.t1 - epsT };
    if (rr.s1 <= rr.s0 || rr.t1 <= rr.t0) return [];
    const cs = [toWorld(this.f, rr.s0, rr.t0), toWorld(this.f, rr.s1, rr.t0), toWorld(this.f, rr.s1, rr.t1), toWorld(this.f, rr.s0, rr.t1)];
    const xs = cs.map((c) => c[0]);
    const zs = cs.map((c) => c[1]);
    const out: Hit[] = [];
    for (const p of this.space.query(Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs))) {
      if (skip?.(p)) continue;
      const l = this.toLocal(p);
      const q = clipToRect(l.poly, rr);
      if (!q.length) continue;
      const b: Rect = { s0: Infinity, s1: -Infinity, t0: Infinity, t1: -Infinity };
      let lo = Infinity;
      let hi = -Infinity;
      for (const [s, t] of q) {
        const y = l.g0 + l.gs * s + l.gt * t;
        lo = Math.min(lo, y);
        hi = Math.max(hi, y);
        b.s0 = Math.min(b.s0, s);
        b.s1 = Math.max(b.s1, s);
        b.t0 = Math.min(b.t0, t);
        b.t1 = Math.max(b.t1, t);
      }
      hi += p.clear;
      // Same tolerance as WalkSpace.intersectsBox: touching the floor or the head room is fine.
      if (y1 > lo + 0.05 && y0 < hi - 0.05) out.push({ p, r: b, lo, hi });
    }
    return out;
  }

  /**
   * A vertical panel on the line t = at (running along s: axis 's') or s = at (axis 't') from u0
   * to u1, real heights y0…y1, minus the walkable space it would stand in: full-height runs where
   * nothing passes and, over each passage, a sill below its floor and a lintel above its head room.
   */
  panel(axis: 's' | 't', at: number, u0: number, u1: number, y0: number, y1: number, skip?: Skip): Part[] {
    const full: Part = { s0: u0, s1: u1, t0: y0, t1: y1 };
    if (u1 - u0 < 1e-3 || y1 - y0 < 1e-3) return [];
    const r: Rect = axis === 's' ? { s0: u0, s1: u1, t0: at - 0.05, t1: at + 0.05 } : { s0: at - 0.05, s1: at + 0.05, t0: u0, t1: u1 };
    // Shrunk across the wall only: a walkway that reaches the end of the wall opens it to the end.
    const spans = this.hits(r, y0, y1, skip, axis === 's' ? 0 : 0.02, axis === 's' ? 0.02 : 0).map((h) => ({ a: axis === 's' ? h.r.s0 : h.r.t0, b: axis === 's' ? h.r.s1 : h.r.t1, lo: h.lo, hi: h.hi }));
    if (!spans.length) return [full];
    const cuts = [...new Set([u0, u1, ...spans.flatMap((x) => [x.a, x.b]).filter((u) => u > u0 && u < u1)])].sort((a, b) => a - b);
    const out: Part[] = [];
    const push = (a: number, b: number, ya: number, yb: number) => {
      if (yb - ya < 0.03 || b - a < 1e-4) return;
      const prev = out.find((q) => Math.abs(q.s1 - a) < 1e-6 && Math.abs(q.t0 - ya) < 1e-6 && Math.abs(q.t1 - yb) < 1e-6);
      if (prev) prev.s1 = b;
      else out.push({ s0: a, s1: b, t0: ya, t1: yb });
    };
    for (let i = 0; i < cuts.length - 1; i++) {
      const [a, b] = [cuts[i], cuts[i + 1]];
      if (b - a < 1e-4) continue;
      const m = (a + b) / 2;
      const cov = spans.filter((x) => x.a <= m && x.b >= m);
      if (!cov.length) {
        push(a, b, y0, y1);
        continue;
      }
      push(a, b, y0, Math.min(y1, Math.min(...cov.map((x) => x.lo)) - 0.01));
      push(a, b, Math.max(y0, Math.max(...cov.map((x) => x.hi)) + 0.01), y1);
    }
    // No slivers of wall standing at the edge of an opening.
    return out.filter((q) => q.s1 - q.s0 >= 0.05);
  }

  /** Real height ranges of a post (plan box r, real heights y0…y1) outside walkable space. */
  post(r: Rect, y0: number, y1: number, skip?: Skip): [number, number][] {
    const hs = this.hits(r, y0, y1, skip);
    if (!hs.length) return [[y0, y1]];
    const lo = Math.min(...hs.map((h) => h.lo)) - 0.01;
    const hi = Math.max(...hs.map((h) => h.hi)) + 0.01;
    return ([[y0, Math.min(y1, lo)], [Math.max(y0, hi), y1]] as [number, number][]).filter(([a, b]) => b - a >= 0.03);
  }

  /** Runs of a long box (plan r, real heights) along `axis` that stay clear of walkable space. */
  runs(axis: 's' | 't', r: Rect, y0: number, y1: number, skip?: Skip, minLen = 0.3): [number, number][] {
    const iv = this.hits(r, y0, y1, skip).map((h): [number, number] => (axis === 's' ? [h.r.s0 - 0.05, h.r.s1 + 0.05] : [h.r.t0 - 0.05, h.r.t1 + 0.05]));
    return axis === 's' ? gaps(r.s0, r.s1, iv, minLen) : gaps(r.t0, r.t1, iv, minLen);
  }

  /**
   * What a horizontal slab (plan r, real heights y0…y1) must give up: holes where walkable space
   * passes through it, and recesses (raised undersides at real height y) where head room below
   * reaches into it, e.g. the 桜橋口 中2階 passage under the viaduct.
   */
  slab(r: Rect, y0: number, y1: number, skip?: Skip): { holes: Rect[]; recesses: { r: Rect; y: number }[] } {
    const holes: Rect[] = [];
    const recesses: { r: Rect; y: number }[] = [];
    for (const h of this.hits(r, y0, y1, skip)) {
      if (h.hi < y1 - 0.03 && h.lo < y0 + 0.05) recesses.push({ r: h.r, y: h.hi + 0.02 });
      else holes.push(h.r);
    }
    return { holes, recesses };
  }
}

// ------------------------------------------------------------------------------------------------
// Drawing context

interface Palette {
  surface: THREE.Color;
  coping: THREE.Color;
  white: THREE.Color;
  tactile: THREE.Color;
  platSide: THREE.Color;
  recess: THREE.Color;
  deckTop: THREE.Color;
  deckSide: THREE.Color;
  deckBottom: THREE.Color;
  parapet: THREE.Color;
  pier: THREE.Color;
  steel: THREE.Color;
  steelDark: THREE.Color;
  column: THREE.Color;
  canopyUnder: THREE.Color;
  canopyTop: THREE.Color;
  fascia: THREE.Color;
  rail: THREE.Color;
  ceiling: THREE.Color;
  pit: THREE.Color;
  tunnel: THREE.Color;
  light: THREE.Color;
  glass: THREE.Color;
  signFrame: THREE.Color;
  red: THREE.Color;
  bufferWhite: THREE.Color;
  doorBody: THREE.Color;
  ad: THREE.Color[];
}

function palette(dark: boolean): Palette {
  const C = (l: string, d: string) => new THREE.Color(dark ? d : l);
  return {
    surface: C('#d4ccbe', '#57524b'),
    coping: C('#eeece6', '#8f8c86'),
    white: C('#fbfbf7', '#d6d6d0'),
    tactile: C('#f3c300', '#d8ab00'),
    platSide: C('#a7a298', '#58554f'),
    recess: C('#5e5a54', '#2a2826'),
    deckTop: C('#7d766b', '#3d3a36'),
    deckSide: C('#c2bdb4', '#5d5a55'),
    deckBottom: C('#b1aca3', '#4a4743'),
    parapet: C('#cdcac3', '#63615c'),
    pier: C('#b8b3aa', '#56534e'),
    steel: C('#e4e7e9', '#9aa3aa'),
    steelDark: C('#586067', '#3d434a'),
    column: C('#d9dcde', '#858d94'),
    canopyUnder: C('#eff1f0', '#757b80'),
    canopyTop: C('#a4aaae', '#565c61'),
    fascia: C('#c5cacd', '#6d757b'),
    rail: C('#7d8186', '#6a6e73'),
    ceiling: C('#e2e3e2', '#5f6366'),
    pit: C('#67645e', '#34322f'),
    tunnel: C('#1a1c1e', '#0b0c0d'),
    light: new THREE.Color('#fff6de'),
    glass: C('#c3dceb', '#8eb0c4'),
    signFrame: C('#3b4047', '#2c3036'),
    red: new THREE.Color('#c8262b'),
    bufferWhite: new THREE.Color('#f2f2ee'),
    doorBody: C('#eef0f1', '#a3abb1'),
    ad: ['#f6d9a8', '#bfe3f2', '#f2c6cf', '#d7eec5', '#f4efe1', '#c9d2f4'].map((c) => new THREE.Color(c)),
  };
}

interface Ctx {
  o: StationOptions;
  hs: number;
  c: Palette;
  wells: Well[];
  /** Walkable space in each station's frame (walk-through only; null in the overview). */
  spaces: Map<StationLayout, FrameSpace> | null;
  /** Walk pieces people stand on at a platform: the slab itself and the walking lines along it. */
  onPlatform: Skip;
  /** Network lookups. */
  nodeById: Map<string, NetNode>;
  edgeById: Map<string, NetEdge>;
  /** Walking lines along each platform (frame t, s range) and how far people stray from them. */
  lines: Map<StationLayout, { t: number; s0: number; s1: number; room: number }[]>;
  st: Mesher;
  shell: Mesher;
  glass: Mesher;
  lights: Mesher;
  roofTop: Mesher;
  signs: { key: string; q: [V3, V3, V3, V3] }[];
  signSpecs: SignSpec[];
  ballast: Mesher;
  slab: Mesher;
  wires: Lines;
  grid: Lines;
  trainBody: Mesher;
  trainEquip: Mesher;
  net: Network;
}

// Frame-aligned primitives ------------------------------------------------------------------------

const UP: V3 = [0, 1, 0];

/**
 * Horizontal rectangle at height y facing up (+1) or down (−1). `lit` shades a downward face as
 * if it faced up: ceilings and canopy soffits are lit by the station's own lamps, which the
 * scene's sun/hemisphere lighting cannot provide.
 */
function hRect(m: Mesher, f: Frame, r: Rect, y: number, face: 1 | -1, color: THREE.Color, uv?: number[], lit = false): void {
  const a = P(f, r.s0, y, r.t0);
  const b = P(f, r.s1, y, r.t0);
  const c = P(f, r.s1, y, r.t1);
  const d = P(f, r.s0, y, r.t1);
  if (face === 1) m.quad(a, b, c, d, color, uv);
  else m.quad(a, d, c, b, color, uv && [uv[0], uv[1], uv[6], uv[7], uv[4], uv[5], uv[2], uv[3]], lit ? UP : undefined);
}

/** Vertical quad on the line t = T for s0…s1, y0…y1, facing +t (1) or −t (−1). */
function tWall(m: Mesher, f: Frame, T: number, s0: number, s1: number, y0: number, y1: number, face: 1 | -1, color: THREE.Color): void {
  const a = P(f, s0, y0, T);
  const b = P(f, s1, y0, T);
  const c = P(f, s1, y1, T);
  const d = P(f, s0, y1, T);
  if (face === -1) m.quad(a, b, c, d, color);
  else m.quad(b, a, d, c, color);
}

/** Vertical quad on the line s = S for t0…t1, y0…y1, facing +s (1) or −s (−1). */
function sWall(m: Mesher, f: Frame, S: number, t0: number, t1: number, y0: number, y1: number, face: 1 | -1, color: THREE.Color, uv?: number[]): void {
  const a = P(f, S, y0, t0);
  const b = P(f, S, y0, t1);
  const c = P(f, S, y1, t1);
  const d = P(f, S, y1, t0);
  if (face === 1) m.quad(a, b, c, d, color, uv);
  else m.quad(b, a, d, c, color, uv);
}

/** Frame-aligned box. */
function fBox(m: Mesher, f: Frame, s0: number, s1: number, y0: number, y1: number, t0: number, t1: number, color: THREE.Color, skip = 0): void {
  if (s1 - s0 < 1e-4 || y1 - y0 < 1e-4 || t1 - t0 < 1e-4) return;
  m.box(P(f, (s0 + s1) / 2, (y0 + y1) / 2, (t0 + t1) / 2), [f.dx, 0, f.dz], [0, 1, 0], s1 - s0, y1 - y0, t1 - t0, color, skip);
}

function clipHoles(r: Rect, holes: Rect[], margin = 0): Rect[] {
  return holes
    .map((h) => ({ s0: Math.max(h.s0, r.s0 + margin), s1: Math.min(h.s1, r.s1 - margin), t0: Math.max(h.t0, r.t0 + margin), t1: Math.min(h.t1, r.t1 - margin) }))
    .filter((h) => h.s1 - h.s0 > 0.4 && h.t1 - h.t0 > 0.4);
}

// Primitives that give way to walkable space ------------------------------------------------------
// Heights are scene heights here; FrameSpace works in real metres (scene = Y(real)).

const realY = (ctx: Ctx, y: number) => (y - ctx.o.Y(0)) / ctx.o.ex;

function frameSpace(ctx: Ctx, l: StationLayout): FrameSpace | null {
  return ctx.spaces?.get(l) ?? null;
}

/** Parts (u range, scene heights) of a vertical panel that stand outside walkable space. */
function wallParts(ctx: Ctx, l: StationLayout, axis: 's' | 't', at: number, u0: number, u1: number, y0: number, y1: number, skip?: Skip): Rect[] {
  const fs = frameSpace(ctx, l);
  if (!fs) return [{ s0: u0, s1: u1, t0: y0, t1: y1 }];
  return fs.panel(axis, at, u0, u1, realY(ctx, y0), realY(ctx, y1), skip).map((q) => ({ s0: q.s0, s1: q.s1, t0: ctx.o.Y(q.t0), t1: ctx.o.Y(q.t1) }));
}

/** tWall with openings (sill and lintel kept) wherever a walkway passes through it. */
function tWallW(ctx: Ctx, l: StationLayout, m: Mesher, T: number, s0: number, s1: number, y0: number, y1: number, face: 1 | -1, color: THREE.Color, skip?: Skip): void {
  for (const q of wallParts(ctx, l, 's', T, s0, s1, y0, y1, skip)) tWall(m, l.f, T, q.s0, q.s1, q.t0, q.t1, face, color);
}

/** sWall with openings (sill and lintel kept) wherever a walkway passes through it. */
function sWallW(ctx: Ctx, l: StationLayout, m: Mesher, S: number, t0: number, t1: number, y0: number, y1: number, face: 1 | -1, color: THREE.Color, skip?: Skip): void {
  for (const q of wallParts(ctx, l, 't', S, t0, t1, y0, y1, skip)) sWall(m, l.f, S, q.s0, q.s1, q.t0, q.t1, face, color);
}

/** Whether a frame-aligned box stays out of walkable space. */
function boxClear(ctx: Ctx, l: StationLayout, s0: number, s1: number, y0: number, y1: number, t0: number, t1: number, skip?: Skip): boolean {
  const fs = frameSpace(ctx, l);
  return !fs || fs.hits({ s0, s1, t0, t1 }, realY(ctx, y0), realY(ctx, y1), skip).length === 0;
}

/** A long frame-aligned box (along s or t) trimmed to the runs clear of walkable space. */
function fBoxRuns(ctx: Ctx, l: StationLayout, m: Mesher, axis: 's' | 't', s0: number, s1: number, y0: number, y1: number, t0: number, t1: number, color: THREE.Color, faces = 0, skip?: Skip): void {
  const fs = frameSpace(ctx, l);
  const runs = fs ? fs.runs(axis, { s0, s1, t0, t1 }, realY(ctx, y0), realY(ctx, y1), skip) : [axis === 's' ? [s0, s1] : [t0, t1]];
  for (const [a, b] of runs) {
    if (axis === 's') fBox(m, l.f, a, b, y0, y1, t0, t1, color, faces);
    else fBox(m, l.f, s0, s1, y0, y1, a, b, color, faces);
  }
}

/**
 * Runs along `axis` of a low frame-aligned box (a parapet at real floor height y) left standing
 * where no walkway centre line comes within d of it; where one does, a doorway at least 2·w wide
 * opens. A walkway's full width may brush the parapet (people keep off it); only paths that
 * actually cross it open it.
 */
function pathRuns(ctx: Ctx, l: StationLayout, axis: 's' | 't', r: Rect, y: number, d: number, w: number): [number, number][] {
  const [u0, u1] = axis === 's' ? [r.s0, r.s1] : [r.t0, r.t1];
  const fs = frameSpace(ctx, l);
  if (!fs) return [[u0, u1]];
  const band = axis === 's' ? [r.t0 - d, r.t1 + d] : [r.s0 - d, r.s1 + d];
  const blocked: [number, number][] = [];
  for (const h of fs.hits({ s0: r.s0 - d, s1: r.s1 + d, t0: r.t0 - d, t1: r.t1 + d }, y, y + 1)) {
    const e = h.p.kind === 'corridor' ? ctx.edgeById.get(h.p.id) : undefined;
    if (!e) continue;
    const [a, b] = [e.a, e.b].map((id) => ctx.nodeById.get(id) as NetNode).map((n) => toLocal(l.f, n.x, n.z));
    // Parameter range of a→b inside the band across the parapet, then its extent along it.
    const [pa, pb, qa, qb] = axis === 's' ? [a[1], b[1], a[0], b[0]] : [a[0], b[0], a[1], b[1]];
    let [w0, w1] = [0, 1];
    if (Math.abs(pb - pa) < 1e-9) {
      if (pa < band[0] || pa > band[1]) continue;
    } else {
      const x0 = (band[0] - pa) / (pb - pa);
      const x1 = (band[1] - pa) / (pb - pa);
      [w0, w1] = [Math.max(0, Math.min(x0, x1)), Math.min(1, Math.max(x0, x1))];
      if (w1 < w0) continue;
    }
    const [c0, c1] = [qa + (qb - qa) * w0, qa + (qb - qa) * w1];
    blocked.push([Math.min(c0, c1) - w, Math.max(c0, c1) + w]);
  }
  return gaps(u0, u1, blocked, 0.3);
}

/** A post (column, mullion) from y0 to y1 cut back to above or below any walkway it would stand in. */
function postParts(ctx: Ctx, l: StationLayout, r: Rect, y0: number, y1: number, skip?: Skip): [number, number][] {
  const fs = frameSpace(ctx, l);
  if (!fs) return [[y0, y1]];
  return fs.post(r, realY(ctx, y0), realY(ctx, y1), skip).map(([a, b]) => [ctx.o.Y(a), ctx.o.Y(b)]);
}

/** The first offset at which `ok` holds (structure moved aside), or null. */
function aside(offsets: number[], ok: (d: number) => boolean): number | null {
  for (const d of offsets) if (ok(d)) return d;
  return null;
}

/** Extends a cut that ends within a few centimetres of the slab edge to the edge itself. */
function snap(q: Rect, r: Rect): Rect {
  const e = 0.06;
  return { s0: q.s0 - r.s0 < e ? r.s0 : q.s0, s1: r.s1 - q.s1 < e ? r.s1 : q.s1, t0: q.t0 - r.t0 < e ? r.t0 : q.t0, t1: r.t1 - q.t1 < e ? r.t1 : q.t1 };
}

/** Holes and recesses (scene heights) a slab r × [y0, y1] must give walkable space. */
function slabCuts(ctx: Ctx, l: StationLayout, r: Rect, y0: number, y1: number, skip?: Skip): { holes: Rect[]; recesses: { r: Rect; y: number }[] } {
  const fs = frameSpace(ctx, l);
  if (!fs) return { holes: [], recesses: [] };
  const c = fs.slab(r, realY(ctx, y0), realY(ctx, y1), skip);
  return { holes: c.holes.map((q) => snap(q, r)), recesses: c.recesses.map((x) => ({ r: snap(x.r, r), y: ctx.o.Y(x.y) })) };
}

/** Undersides of a slab: its bottom at y0 minus holes, raised to y inside each recess (highest wins). */
function undersides(r: Rect, holes: Rect[], recesses: { r: Rect; y: number }[], y0: number): { q: Rect; y: number }[] {
  const out = rectMinusHoles(r, [...holes, ...recesses.map((x) => x.r)]).map((q) => ({ q, y: y0 }));
  recesses.forEach((rc, i) => {
    const higher = recesses.filter((x, j) => x.y > rc.y || (x.y === rc.y && j > i)).map((x) => x.r);
    for (const q of rectMinusHoles(rc.r, [...holes, ...higher])) out.push({ q, y: rc.y });
  });
  return out;
}

/**
 * Vertical faces around rectangle h (hole liners, recess steps) from y0 to y1, facing into it; the
 * parts that lie inside another open rectangle, on the slab's outer edge or in walkable space are
 * left out.
 */
function ring(ctx: Ctx, l: StationLayout, m: Mesher, h: Rect, y0: number, y1: number, color: THREE.Color, open: Rect[], outer?: Rect): void {
  if (y1 - y0 < 0.02) return;
  const e = 1e-3;
  const along = (u0: number, u1: number, cover: (o: Rect) => [number, number] | null) => gaps(u0, u1, open.filter((o) => o !== h).map(cover).filter((x): x is [number, number] => x !== null), 0.05);
  for (const [T, face] of [[h.t0, 1], [h.t1, -1]] as const) {
    if (outer && (Math.abs(T - outer.t0) < e || Math.abs(T - outer.t1) < e)) continue;
    for (const [a, b] of along(h.s0, h.s1, (o) => (o.t0 < T - e && o.t1 > T + e ? [o.s0, o.s1] : null))) tWallW(ctx, l, m, T, a, b, y0, y1, face, color);
  }
  for (const [S, face] of [[h.s0, 1], [h.s1, -1]] as const) {
    if (outer && (Math.abs(S - outer.s0) < e || Math.abs(S - outer.s1) < e)) continue;
    for (const [a, b] of along(h.t0, h.t1, (o) => (o.s0 < S - e && o.s1 > S + e ? [o.t0, o.t1] : null))) sWallW(ctx, l, m, S, a, b, y0, y1, face, color);
  }
}

/**
 * Box-with-holes slab: top and bottom faces minus holes, outer sides and hole liners. In the
 * walk-through it also gives way to walkable space: holes where a walkway passes through it, a
 * raised underside (with step faces) where the head room below reaches into it, openings in its
 * vertical faces.
 */
function slab(ctx: Ctx, l: StationLayout, m: Mesher, r: Rect, y0: number, y1: number, holes: Rect[], top: THREE.Color, side: THREE.Color, bottom: THREE.Color | null, sides = true): void {
  const f = l.f;
  const cut = slabCuts(ctx, l, r, y0, y1);
  const all = [...holes, ...cut.holes];
  for (const q of rectMinusHoles(r, all)) hRect(m, f, q, y1, 1, top);
  // A raised soffit is the ceiling of the passage beneath: lit like the station's own ceilings.
  if (bottom) for (const { q, y } of undersides(r, all, cut.recesses, y0)) hRect(m, f, q, y, -1, y > y0 ? ctx.c.ceiling : bottom, undefined, y > y0);
  if (sides) {
    tWallW(ctx, l, m, r.t1, r.s0, r.s1, y0, y1, 1, side);
    tWallW(ctx, l, m, r.t0, r.s0, r.s1, y0, y1, -1, side);
    sWallW(ctx, l, m, r.s1, r.t0, r.t1, y0, y1, 1, side);
    sWallW(ctx, l, m, r.s0, r.t0, r.t1, y0, y1, -1, side);
  }
  // Hole liners and recess steps face into the opening.
  const lined = clipHoles(r, all);
  for (const h of lined) ring(ctx, l, m, h, y0, y1, side, lined);
  for (const rc of cut.recesses) ring(ctx, l, m, rc.r, y0, rc.y, side, lined, r);
}

// ------------------------------------------------------------------------------------------------
// Public API

/**
 * Builds every station visible under the current level filter. In the overview (`walk: false`)
 * platform tops, signs, pillars and doors are skipped: the view's coloured platform boxes stay
 * the readable (and pickable) platforms there.
 */
export function buildStations(net: Network, o: StationOptions): THREE.Group {
  const group = new THREE.Group();
  group.name = 'stations';
  const layouts = stationLayouts(net);
  const space = WalkSpace.of(net);
  const lineIds = new Set<string>();
  for (const e of net.edges) if (e.kind === 'platform') lineIds.add(e.id).add(`node:${e.a}`).add(`node:${e.b}`);
  const ctx: Ctx = {
    o,
    hs: Math.min(o.ex, 2),
    c: palette(o.dark),
    wells: computeWells(net, o),
    // Only the walk-through has a walker; the overview's heights are exaggerated anyway.
    spaces: o.walk ? new Map(layouts.map((l) => [l, new FrameSpace(space, l.f)])) : null,
    onPlatform: (p) => p.kind === 'platform' || lineIds.has(p.id),
    nodeById: new Map(net.nodes.map((n) => [n.id, n])),
    edgeById: new Map(net.edges.map((e) => [e.id, e])),
    lines: new Map(layouts.map((l) => [l, walkingLines(net, l)])),
    st: new Mesher(),
    shell: new Mesher(),
    glass: new Mesher(),
    lights: new Mesher(),
    roofTop: new Mesher(),
    signs: [],
    signSpecs: [],
    ballast: new Mesher(),
    slab: new Mesher(),
    wires: new Lines(),
    grid: new Lines(),
    trainBody: new Mesher(),
    trainEquip: new Mesher(),
    net,
  };
  for (const l of layouts) {
    if (!o.levelVisible(l.level)) continue;
    drawTracks(ctx, l);
    if (l.cfg.kind === 'elevated') drawElevated(ctx, l);
    else drawUnderground(ctx, l);
    drawPower(ctx, l);
    if (o.walk) drawSigns(ctx, l);
    placeTrains(ctx, l, o.occupied);
  }
  finish(ctx, group);
  return group;
}

/** A stationary train beside platform `p` (replaces walkway.ts buildTrain). */
export function buildTrainModel(p: Platform, line: Line, opts: TrainModelOptions): THREE.Group {
  const group = new THREE.Group();
  group.name = 'train';
  const hs = Math.min(opts.ex, 2);
  const memo = trackMemo.get(p);
  let side: 1 | -1 = opts.side ?? 1;
  if (memo && !memo[side] && memo[-side]) side = -side as 1 | -1;
  const f = frameOf(p.a, p.b);
  const len = Math.hypot(p.b[0] - p.a[0], p.b[1] - p.a[1]);
  const m = memo?.[side];
  const off = m?.off ?? side * (p.width / 2 + EDGE_TO_TRACK);
  const cars = opts.cars ?? carsFor(line.id, len);
  const parts = trainParts(line.id, cars, opts.detail ?? true);
  const s0 = trainStart(m?.buf0 ? m.s0 : null, m?.buf1 ? m.s1 : null, 0, len, parts.length);
  const railY = opts.Y(p.y) - PLAT_H * hs;
  const body = new Mesher();
  const equip = new Mesher();
  placeSoup(parts.body, body, f, s0, off, railY, hs, parts.length);
  placeSoup(parts.equip, equip, f, s0, off, railY, hs, parts.length);
  const mats = trainMaterials(opts.dark);
  const bg = body.geometry({ uv: true });
  const eg = equip.geometry({ color: true });
  if (bg) group.add(new THREE.Mesh(bg, mats.body));
  if (eg) group.add(new THREE.Mesh(eg, mats.equip));
  return group;
}

/** Where a train of `len` starts: against a buffer stop if there is one, else centred on the platform. */
function trainStart(buf0: number | null, buf1: number | null, p0: number, p1: number, len: number): number {
  if (buf0 !== null) return buf0 + 1;
  if (buf1 !== null) return buf1 - 1 - len;
  return (p0 + p1) / 2 - len / 2;
}

// ------------------------------------------------------------------------------------------------
// Heights

function heights(ctx: Ctx, l: StationLayout) {
  const plat = ctx.o.Y(l.py);
  const rail = plat - PLAT_H * ctx.hs;
  const bed = rail - 0.17 * ctx.hs;
  return { plat, rail, bed };
}

// ------------------------------------------------------------------------------------------------
// Tracks: bed strips (textured), rails, buffer stops

function drawTracks(ctx: Ctx, l: StationLayout): void {
  const { f } = l;
  const { rail, bed } = heights(ctx, l);
  const c = ctx.c;
  const gauge = liveryFor(l.tracks[0].lineId).gauge;
  const bedM = l.cfg.kind === 'elevated' ? ctx.ballast : ctx.slab;
  const white = new THREE.Color('#ffffff');
  for (const tr of l.tracks) {
    const r: Rect = { s0: tr.s0, s1: tr.s1, t0: tr.t - BED_WIDTH / 2, t1: tr.t + BED_WIDTH / 2 };
    // u across the bed, v along it (texture repeats every BED_REPEAT metres).
    hRect(bedM, f, r, bed, 1, white, [0, tr.s0 / BED_REPEAT, 0, tr.s1 / BED_REPEAT, 1, tr.s1 / BED_REPEAT, 1, tr.s0 / BED_REPEAT]);
    for (const sx of [-1, 1]) {
      const t = tr.t + (sx * gauge) / 2;
      // Rail: web + a slightly wider, brighter head.
      fBox(ctx.st, f, tr.s0, tr.s1, bed, rail - 0.03 * ctx.hs, t - 0.04, t + 0.04, c.rail, 1 << 3);
      fBox(ctx.st, f, tr.s0, tr.s1, rail - 0.03 * ctx.hs, rail, t - 0.036, t + 0.036, c.steel, 1 << 3);
    }
    for (const [on, s, dir] of [[tr.buf0, tr.s0, 1], [tr.buf1, tr.s1, -1]] as const) {
      if (!on) continue;
      // Buffer stop: steel frame over the rail ends with a red/white striped plate and a lamp.
      const s1 = s + dir * 0.35;
      for (const sx of [-1, 1]) fBox(ctx.st, f, Math.min(s, s1), Math.max(s, s1), bed, rail + 0.9 * ctx.hs, tr.t + (sx * gauge) / 2 - 0.12, tr.t + (sx * gauge) / 2 + 0.12, c.steelDark);
      const n = 6;
      const w = gauge + 1.0;
      for (let k = 0; k < n; k++) {
        const t0 = tr.t - w / 2 + (w * k) / n;
        fBox(ctx.st, f, Math.min(s - dir * 0.05, s), Math.max(s - dir * 0.05, s), rail + 0.35 * ctx.hs, rail + 0.95 * ctx.hs, t0, t0 + w / n, k % 2 ? c.bufferWhite : c.red);
      }
      fBox(ctx.lights, f, s - 0.1, s + 0.1, rail + 1.0 * ctx.hs, rail + 1.18 * ctx.hs, tr.t - 0.1, tr.t + 0.1, c.red);
    }
  }
}

// ------------------------------------------------------------------------------------------------
// Platform slabs (both kinds)

function drawPlatforms(ctx: Ctx, l: StationLayout, bottomY: number, underside: boolean): void {
  const { f } = l;
  const { plat } = heights(ctx, l);
  const c = ctx.c;
  const hs = ctx.hs;
  const downWells = wellsThrough(ctx.wells, plat);
  const down = downWells.map((w) => wellRect(f, w, plat));
  // In the overview the view's coloured boxes are the platforms: keep ours just inside them.
  const inset = ctx.o.walk ? 0 : 0.08;
  const top = ctx.o.walk ? plat : plat - 0.06;
  for (const s of l.surfs) {
    const r: Rect = { s0: s.s0 + inset, s1: s.s1 - inset, t0: s.t0 + inset, t1: s.t1 - inset };
    // Stair openings over the whole staircase, and whatever else walkable space needs: passages
    // underneath (the 桜橋口 中2階) raise the underside instead.
    const cut = slabCuts(ctx, l, r, bottomY, top);
    const holes = [...clipHoles(r, down.filter((d) => overlaps(d, r)), 0.3), ...cut.holes];
    const lip = 0.25 * hs;
    for (const q of rectMinusHoles(r, holes)) hRect(ctx.st, f, q, top, 1, c.surface);
    if (underside) for (const { q, y } of undersides(r, holes, cut.recesses, bottomY)) hRect(ctx.st, f, q, y, -1, y > bottomY ? c.ceiling : c.deckBottom, undefined, y > bottomY);
    // Long sides: coping lip at the top, recessed wall below (the refuge space under the edge).
    for (const side of [-1, 1] as const) {
      const T = side === 1 ? r.t1 : r.t0;
      const hasTrack = s.track[side] !== undefined;
      if (hasTrack) {
        tWallW(ctx, l, ctx.st, T, r.s0, r.s1, top - lip, top, side, c.coping);
        hRect(ctx.st, f, { s0: r.s0, s1: r.s1, t0: Math.min(T, T - side * 0.35), t1: Math.max(T, T - side * 0.35) }, top - lip, -1, c.recess);
        tWallW(ctx, l, ctx.st, T - side * 0.35, r.s0, r.s1, bottomY, top - lip, side, c.platSide);
      } else tWallW(ctx, l, ctx.st, T, r.s0, r.s1, bottomY, top, side, c.platSide);
    }
    for (const [S, face] of [[r.s0, -1], [r.s1, 1]] as const) sWallW(ctx, l, ctx.st, S, r.t0, r.t1, bottomY, top, face, c.platSide);
    // Stairwell liners and recess steps.
    const lined = clipHoles(r, holes);
    for (const h of lined) ring(ctx, l, ctx.st, h, bottomY, top, c.platSide, lined);
    if (underside) for (const rc of cut.recesses) ring(ctx, l, ctx.st, rc.r, bottomY, rc.y, c.platSide, lined, r);
    if (ctx.o.walk) {
      // Parapets around the stair openings, open at the head, and opened where a path crosses.
      const parapet = (axis: 's' | 't', b: Rect) => {
        for (const [u, v] of pathRuns(ctx, l, axis, b, l.py, 0.15, 0.6)) {
          if (axis === 's') fBox(ctx.st, f, u, v, top, top + 1.1 * hs, b.t0, b.t1, c.parapet, 8);
          else fBox(ctx.st, f, b.s0, b.s1, top, top + 1.1 * hs, u, v, c.parapet, 8);
        }
      };
      downWells.forEach((w, i) => {
        if (w.kind === 'elevator') return;
        const h = clipHoles(r, [down[i]], 0.3)[0];
        if (!h) return;
        const [ts, tt] = toLocal(f, w.head[0], w.head[1]);
        const alongS = h.s1 - h.s0 >= h.t1 - h.t0;
        const entry = alongS ? (Math.abs(ts - h.s0) < Math.abs(ts - h.s1) ? 's0' : 's1') : Math.abs(tt - h.t0) < Math.abs(tt - h.t1) ? 't0' : 't1';
        const th = 0.12;
        if (entry !== 't0') parapet('s', { s0: h.s0, s1: h.s1, t0: h.t0 - th, t1: h.t0 });
        if (entry !== 't1') parapet('s', { s0: h.s0, s1: h.s1, t0: h.t1, t1: h.t1 + th });
        if (entry !== 's0') parapet('t', { s0: h.s0 - th, s1: h.s0, t0: h.t0 - th, t1: h.t1 + th });
        if (entry !== 's1') parapet('t', { s0: h.s1, s1: h.s1 + th, t0: h.t0 - th, t1: h.t1 + th });
      });
      // A section is a screened walkway: screens along both long sides, opened where a path crosses.
      if (s.section) {
        for (const side of [-1, 1] as const) {
          const T = side === 1 ? r.t1 - 0.3 : r.t0 + 0.3;
          const b: Rect = { s0: r.s0, s1: r.s1, t0: Math.min(T, T - side * 0.08), t1: Math.max(T, T - side * 0.08) };
          for (const [u, v] of pathRuns(ctx, l, 's', b, l.py, 0.15, 0.6)) {
            for (const q of rectMinusHoles({ ...b, s0: u, s1: v }, holes)) fBox(ctx.st, f, q.s0, q.s1, top, top + 1.3 * hs, q.t0, q.t1, c.parapet, 8);
          }
        }
      }
      // Markings on edges that face a track: coping band, white line, yellow tactile strip.
      if (!s.head) {
        for (const side of [-1, 1] as const) {
          if (s.track[side] === undefined) continue;
          const T = side === 1 ? r.t1 : r.t0;
          const band = (a: number, b: number, color: THREE.Color, lift: number) => {
            const t0 = T - side * a;
            const t1 = T - side * b;
            const br: Rect = { s0: r.s0, s1: r.s1, t0: Math.min(t0, t1), t1: Math.max(t0, t1) };
            for (const q of rectMinusHoles(br, holes)) hRect(ctx.st, f, q, top + lift, 1, color);
          };
          band(0, 0.3, c.coping, 0.012);
          band(0.3, 0.42, c.white, 0.016);
          band(0.8, 1.12, c.tactile, 0.02);
          band(1.16, 1.2, c.tactile, 0.02);
        }
      }
    }
  }
}

// ------------------------------------------------------------------------------------------------
// Elevated stations: viaduct deck, platforms, canopies, roofs, bridge

function drawElevated(ctx: Ctx, l: StationLayout): void {
  const { f, box } = l;
  const { plat, bed } = heights(ctx, l);
  const c = ctx.c;
  const hs = ctx.hs;
  const Y = ctx.o.Y;
  const deckTop = bed - 0.03;
  const deckBot = deckTop - 1.3 * hs;
  const surfRects = l.surfs.map((s) => ({ s0: s.s0, s1: s.s1, t0: s.t0, t1: s.t1 }));
  // Deck = everything under the tracks that is not a platform (platforms carry their own slabs).
  const deckHoles = [...surfRects, ...wellsThrough(ctx.wells, deckTop).map((w) => wellRect(f, w, deckTop))];
  slab(ctx, l, ctx.st, box, deckBot, deckTop, deckHoles, c.deckTop, c.deckSide, c.deckBottom, true);
  // Noise barriers along the outer edges beyond the platforms.
  const ps0 = Math.min(...surfRects.map((s) => s.s0));
  const ps1 = Math.max(...surfRects.map((s) => s.s1));
  for (const [a, b] of [[box.s0, ps0], [ps1, box.s1]]) {
    if (b - a < 1) continue;
    fBoxRuns(ctx, l, ctx.st, 's', a, b, deckTop, deckTop + 1.6 * hs, box.t0, box.t0 + 0.2, c.parapet);
    fBoxRuns(ctx, l, ctx.st, 's', a, b, deckTop, deckTop + 1.6 * hs, box.t1 - 0.2, box.t1, c.parapet);
    // Viaduct piers every 15 m, moved along the viaduct off the streets and passages below.
    const ground = Y(0);
    for (let s = a + 6; s < b - 3; s += 15) {
      for (const t of [box.t0 + 2, (box.t0 + box.t1) / 2, box.t1 - 2]) {
        const d = aside([0, 1.5, -1.5, 3, -3, 4.5, -4.5, 6, -6], (d) => boxClear(ctx, l, s + d - 0.7, s + d + 0.7, ground, deckBot, t - 0.9, t + 0.9));
        if (d !== null) fBox(ctx.st, f, s + d - 0.7, s + d + 0.7, ground, deckBot, t - 0.9, t + 0.9, c.pier, 12);
      }
    }
  }
  drawPlatforms(ctx, l, deckBot, true);

  // Covered ranges (大屋根 / 阪急 train shed) where platforms need no canopy.
  const covered: Rect[] = [];
  if (l.id === 'jr') {
    const roof = drawBigRoof(ctx, l);
    if (roof) covered.push(roof);
    drawBridge(ctx, l);
  }
  if (l.id === 'hankyu') covered.push(drawShed(ctx, l));

  const canopyY = plat + l.cfg.ceil * hs;
  for (const s of l.surfs) {
    // s-ranges of this platform that are not under a covering roof.
    let ranges: [number, number][] = [[s.s0, s.s1]];
    for (const cv of covered) {
      if (cv.t0 > (s.t0 + s.t1) / 2 || cv.t1 < (s.t0 + s.t1) / 2) continue;
      ranges = ranges.flatMap(([a, b]) => {
        const out: [number, number][] = [];
        if (cv.s0 > a) out.push([a, Math.min(b, cv.s0)]);
        if (cv.s1 < b) out.push([Math.max(a, cv.s1), b]);
        return out.filter(([x, y]) => y - x > 4);
      });
    }
    for (const [a, b] of ranges) drawCanopy(ctx, l, { s0: a, s1: b, t0: s.t0 - 0.25, t1: s.t1 + 0.25 }, canopyY, s);
  }
}

/** A platform canopy: roof slab, fascia, one or two column rows, light strips underneath. */
function drawCanopy(ctx: Ctx, l: StationLayout, r: Rect, y: number, sf: Surf): void {
  const { f } = l;
  const c = ctx.c;
  const hs = ctx.hs;
  const { plat } = heights(ctx, l);
  const th = 0.28 * hs;
  const w = sf.t1 - sf.t0;
  // Open where a flight rises through the roof (to the 3F bridge).
  const cut = slabCuts(ctx, l, r, y, y + th);
  const holes = [...wellsThrough(ctx.wells, y).map((wl) => wellRect(f, wl, y)).filter((h) => overlaps(h, r)), ...cut.holes, ...cut.recesses.map((x) => x.r)];
  for (const q of rectMinusHoles(r, holes)) {
    hRect(ctx.st, f, q, y, -1, c.canopyUnder, undefined, true);
    // Seen from the chase camera just above it the top is drawn as faint glazing only.
    hRect(ctx.o.walk ? ctx.glass : ctx.roofTop, f, q, y + th, 1, ctx.o.walk ? c.glass : c.canopyTop);
  }
  tWallW(ctx, l, ctx.st, r.t1, r.s0, r.s1, y, y + th, 1, c.fascia);
  tWallW(ctx, l, ctx.st, r.t0, r.s0, r.s1, y, y + th, -1, c.fascia);
  sWallW(ctx, l, ctx.st, r.s0, r.t0, r.t1, y, y + th, -1, c.fascia);
  sWallW(ctx, l, ctx.st, r.s1, r.t0, r.t1, y, y + th, 1, c.fascia);
  const tc = (r.t0 + r.t1) / 2;
  const rows = sf.head ? [] : columnRows(ctx, l, sf, w < 7 ? [tc] : [tc - Math.max(1.2, w / 2 - 2.3), tc + Math.max(1.2, w / 2 - 2.3)], 0.2);
  const pitch = 12;
  const n = Math.max(1, Math.round((r.s1 - r.s0 - 4) / pitch));
  const allWells = ctx.wells.map((wl) => wellRect(f, wl));
  for (let k = 0; k <= n && rows.length; k++) {
    const s = r.s0 + 2 + ((r.s1 - r.s0 - 4) * k) / n;
    const colR: Rect = { s0: s - 0.4, s1: s + 0.4, t0: Math.min(...rows) - 0.4, t1: Math.max(...rows) + 0.4 };
    if (allWells.some((h) => overlaps(h, colR, 0.6))) continue;
    // Columns stay off the paths to the stair heads; a bay without any keeps no cross beam.
    const cols = rows.filter((t) => boxClear(ctx, l, s - 0.2, s + 0.2, plat, y, t - 0.2, t + 0.2, ctx.onPlatform));
    if (!cols.length) continue;
    for (const t of cols) {
      if (ctx.o.walk) ctx.st.prism(P(f, s, plat, t), P(f, s, y, t), 0.16, 8, c.column, false);
      else fBox(ctx.st, f, s - 0.2, s + 0.2, plat - 0.2, y, t - 0.2, t + 0.2, c.column, 12);
    }
    // Cross beam under the roof.
    fBoxRuns(ctx, l, ctx.st, 't', s - 0.1, s + 0.1, y - 0.25 * hs, y, r.t0 + 0.3, r.t1 - 0.3, c.fascia, 4);
  }
  if (ctx.o.walk) {
    for (const t of w < 7 ? [tc] : [tc - w / 4, tc + w / 4]) {
      for (const q of rectMinusHoles({ s0: r.s0 + 1, s1: r.s1 - 1, t0: t - 0.12, t1: t + 0.12 }, holes)) hRect(ctx.lights, f, q, y - 0.02, -1, c.light);
    }
  }
}

/** JR大阪駅 大屋根: an arched glass-and-steel vault across the tracks. Returns its plan rect. */
function drawBigRoof(ctx: Ctx, l: StationLayout): Rect | null {
  const fp = ctx.net.footprints.find((x) => x.id === 'jr:roof');
  if (!fp) return null;
  const { f } = l;
  const c = ctx.c;
  const hs = ctx.hs;
  const Y = ctx.o.Y;
  const pts = fp.poly.map(([x, z]) => toLocal(f, x, z));
  const r: Rect = {
    s0: Math.min(...pts.map((p) => p[0])),
    s1: Math.max(...pts.map((p) => p[0])),
    // Span the whole track field (the roof rests on the buildings north and south of it).
    t0: Math.min(...pts.map((p) => p[1]), l.box.t0 - 1.5),
    t1: Math.max(...pts.map((p) => p[1]), l.box.t1 + 1.5),
  };
  // Heights above the 3F deck (15 m) use the local scale, so the roof stays near its real ~50 m.
  const base = Y(15);
  const eave = base + (27 - 15) * hs;
  const crown = base + (48 - 15) * hs;
  const tc = (r.t0 + r.t1) / 2;
  const half = (r.t1 - r.t0) / 2;
  const hAt = (t: number) => eave + (crown - eave) * Math.pow(Math.max(0, 1 - ((t - tc) / half) ** 2), 0.7);
  const nt = 24;
  const ns = 15;
  const tAt = (j: number) => r.t0 + ((r.t1 - r.t0) * j) / nt;
  const sAt = (i: number) => r.s0 + ((r.s1 - r.s0) * i) / ns;
  // Glazing (double-sided, faint).
  for (let i = 0; i < ns; i++) {
    for (let j = 0; j < nt; j++) {
      const a = P(f, sAt(i), hAt(tAt(j)), tAt(j));
      const b = P(f, sAt(i + 1), hAt(tAt(j)), tAt(j));
      const cc = P(f, sAt(i + 1), hAt(tAt(j + 1)), tAt(j + 1));
      const d = P(f, sAt(i), hAt(tAt(j + 1)), tAt(j + 1));
      ctx.glass.quad(a, b, cc, d, c.glass);
    }
  }
  // Arch ribs at every bay line; purlins along every third panel line; eave girders.
  const ribW = ctx.o.walk ? 0.7 : 1.2;
  for (let i = 0; i <= ns; i++) {
    for (let j = 0; j < nt; j++) ctx.st.beam(P(f, sAt(i), hAt(tAt(j)) - 0.6, tAt(j)), P(f, sAt(i), hAt(tAt(j + 1)) - 0.6, tAt(j + 1)), ribW, 1.3, c.steel);
  }
  for (let j = 0; j <= nt; j += 3) {
    for (let i = 0; i < ns; i++) ctx.st.beam(P(f, sAt(i), hAt(tAt(j)) - 0.3, tAt(j)), P(f, sAt(i + 1), hAt(tAt(j)) - 0.3, tAt(j)), 0.35, 0.5, c.steel);
  }
  for (const t of [r.t0, r.t1]) fBox(ctx.st, f, r.s0, r.s1, eave - 2.2, eave, t - 0.9, t + 0.9, c.steel);
  // Mullion grid (1 px lines read as the fine glazing bars).
  for (let j = 0; j <= nt; j++) ctx.grid.seg(P(f, r.s0, hAt(tAt(j)), tAt(j)), P(f, r.s1, hAt(tAt(j)), tAt(j)));
  for (let s = r.s0; s <= r.s1 + 0.01; s += (r.s1 - r.s0) / (ns * 4)) {
    for (let j = 0; j < nt; j++) ctx.grid.seg(P(f, s, hAt(tAt(j)), tAt(j)), P(f, s, hAt(tAt(j + 1)), tAt(j + 1)));
  }
  // Supports at the eaves: tapered steel columns standing beside the track field, moved along the
  // eave girder off the streets and decks below.
  for (const k of [0.08, 0.5, 0.92]) {
    for (const t of [r.t0, r.t1]) {
      const s0 = r.s0 + (r.s1 - r.s0) * k;
      const d = aside([0, 3, -3, 6, -6, 9, -9, 12, -12, 15, -15], (d) => boxClear(ctx, l, s0 + d - 0.6, s0 + d + 0.6, Y(0), eave - 1, t - 1.8, t + 1.8));
      if (d === null) continue;
      const s = s0 + d;
      ctx.st.beam(P(f, s, Y(0), t - 1.2), P(f, s, eave - 1, t), 1.1, 1.1, c.steel);
      ctx.st.beam(P(f, s, Y(0), t + 1.2), P(f, s, eave - 1, t), 1.1, 1.1, c.steel);
    }
  }
  return r;
}

/** JR 3F 橋上駅舎 / 連絡橋: deck across the platforms with glass walls and a ceiling. */
function drawBridge(ctx: Ctx, l: StationLayout): void {
  const { f } = l;
  const c = ctx.c;
  const hs = ctx.hs;
  const Y = ctx.o.Y;
  const ns = ctx.net.nodes.filter((n) => n.stationId === l.id && n.y > l.py + 3 && n.level === '3F');
  if (ns.length < 2 || !ctx.o.levelVisible('3F')) return;
  const loc = ns.map((n) => toLocal(f, n.x, n.z));
  const y = Y(Math.max(...ns.map((n) => n.y)));
  // The paid concourse spans every stair head and bridge landing inside the gates.
  const paid = ns.filter((n) => n.paid).map((n) => toLocal(f, n.x, n.z)[0]);
  const sm = loc.reduce((a, p) => a + p[0], 0) / loc.length;
  const [ps0, ps1] = paid.length >= 2 ? [Math.min(...paid) - 4, Math.max(...paid) + 4] : [sm - 11, sm + 11];
  const r: Rect = { s0: Math.min(ps0, sm - 11), s1: Math.max(ps1, sm + 11), t0: Math.min(l.box.t0, ...loc.map((p) => p[1])) - 6, t1: Math.max(l.box.t1, ...loc.map((p) => p[1])) + 6 };
  const holes = wellsThrough(ctx.wells, y - 0.05).map((w) => wellRect(f, w, y - 0.05)).filter((h) => overlaps(h, r));
  slab(ctx, l, ctx.st, r, y - 1.5 * hs, y - 0.03, clipHoles(r, holes, 0.2), c.surface, c.deckSide, c.deckBottom);
  const wallH = 3.4 * hs;
  const ceilY = y + 4.8 * hs;
  // Glass end walls with doorways (glass kept above them) where walkways and flights come in.
  for (const S of [r.s0, r.s1]) {
    sWallW(ctx, l, ctx.glass, S, r.t0, r.t1, y, ceilY, 1, c.glass);
    for (let t = r.t0; t <= r.t1 + 0.01; t += 3) {
      for (const [a, b] of postParts(ctx, l, { s0: S - 0.08, s1: S + 0.08, t0: t - 0.08, t1: t + 0.08 }, y, ceilY)) fBox(ctx.st, f, S - 0.08, S + 0.08, a, b, t - 0.08, t + 0.08, c.steel);
    }
    fBoxRuns(ctx, l, ctx.st, 't', S - 0.1, S + 0.1, y + wallH * 0.33, y + wallH * 0.33 + 0.08, r.t0, r.t1, c.steel);
  }
  // Ceiling (faces down only, so a camera above still sees in) with light strips.
  const ch = wellsThrough(ctx.wells, ceilY).map((w) => wellRect(f, w, ceilY)).filter((h) => overlaps(h, r));
  for (const q of rectMinusHoles(r, ch)) hRect(ctx.st, f, q, ceilY, -1, c.ceiling, undefined, true);
  if (!ctx.o.walk) hRect(ctx.roofTop, f, r, ceilY + 1.2 * hs, 1, c.canopyTop);
  else for (let s = r.s0 + 6; s < r.s1 - 4; s += 5) hRect(ctx.lights, f, { s0: s - 0.15, s1: s + 0.15, t0: r.t0 + 2, t1: r.t1 - 2 }, ceilY - 0.03, -1, c.light);
}

/** 阪急 train shed over the gate end: skylights over the tracks, trusses, columns on the platforms. */
function drawShed(ctx: Ctx, l: StationLayout): Rect {
  const { f, box } = l;
  const c = ctx.c;
  const hs = ctx.hs;
  const { plat } = heights(ctx, l);
  const s0 = Math.min(...l.surfs.map((s) => s.s0));
  const r: Rect = { s0: s0 + 2, s1: s0 + 150, t0: box.t0 - 1, t1: box.t1 + 1 };
  const y = plat + 9.5 * hs;
  const th = 0.5 * hs;
  const sky = l.tracks.map((tr) => ({ s0: r.s0, s1: r.s1, t0: tr.t - 2.1, t1: tr.t + 2.1 }));
  for (const q of rectMinusHoles(r, sky)) {
    hRect(ctx.st, f, q, y, -1, c.canopyUnder, undefined, true);
    hRect(ctx.roofTop, f, q, y + th, 1, c.canopyTop);
  }
  for (const q of sky) hRect(ctx.glass, f, q, y + th, 1, c.glass);
  tWall(ctx.st, f, r.t1, r.s0, r.s1, y, y + th, 1, c.fascia);
  tWall(ctx.st, f, r.t0, r.s0, r.s1, y, y + th, -1, c.fascia);
  sWall(ctx.st, f, r.s1, r.t0, r.t1, y - 1.2 * hs, y + th, 1, c.fascia);
  sWall(ctx.st, f, r.s0, r.t0, r.t1, y - 1.2 * hs, y + th, -1, c.fascia);
  const allWells = ctx.wells.map((wl) => wellRect(f, wl));
  const rows = l.surfs.map((sf) => {
    if (sf.head) return [];
    const w = sf.t1 - sf.t0;
    const tc = (sf.t0 + sf.t1) / 2;
    return columnRows(ctx, l, sf, w > 12 ? [tc - w / 2 + 2.6, tc + w / 2 - 2.6] : [tc - Math.max(1.2, w / 2 - 2.3), tc + Math.max(1.2, w / 2 - 2.3)], 0.25);
  });
  for (let s = r.s0 + 4; s < r.s1; s += 15) {
    // Truss: top and bottom chords with a web of diagonals.
    fBox(ctx.st, f, s - 0.2, s + 0.2, y - 0.25, y, r.t0, r.t1, c.steel, 4);
    fBox(ctx.st, f, s - 0.2, s + 0.2, y - 1.4 * hs, y - 1.4 * hs + 0.3, r.t0, r.t1, c.steel);
    if (ctx.o.walk) for (let t = r.t0; t < r.t1 - 2; t += 3) ctx.st.beam(P(f, s, y - 1.4 * hs + 0.3, t), P(f, s, y - 0.25, t + 3), 0.12, 0.12, c.steel);
    rows.forEach((ts) => {
      for (const t of ts) {
        if (allWells.some((h) => overlaps(h, { s0: s - 0.5, s1: s + 0.5, t0: t - 0.5, t1: t + 0.5 }, 0.5))) continue;
        if (!boxClear(ctx, l, s - 0.25, s + 0.25, plat, y - 1.4 * hs, t - 0.25, t + 0.25, ctx.onPlatform)) continue;
        if (ctx.o.walk) ctx.st.prism(P(f, s, plat, t), P(f, s, y - 1.4 * hs, t), 0.22, 8, c.column, false);
        else fBox(ctx.st, f, s - 0.25, s + 0.25, plat - 0.2, y - 1.4 * hs, t - 0.25, t + 0.25, c.column, 12);
      }
    });
  }
  if (ctx.o.walk) {
    for (const sf of l.surfs) {
      if (sf.head || sf.s0 > r.s1) continue;
      const tc = (sf.t0 + sf.t1) / 2;
      hRect(ctx.lights, f, { s0: Math.max(r.s0, sf.s0) + 1, s1: Math.min(r.s1, sf.s1) - 1, t0: tc - 0.15, t1: tc + 0.15 }, y - 1.4 * hs - 0.05, -1, c.light);
    }
  }
  return r;
}

// ------------------------------------------------------------------------------------------------
// Underground stations: inward-facing box, pillars, lights, doors, tunnel mouths

/** A cell of an underground ceiling: plan rectangle and flat cap (scene height, Infinity = none). */
interface CeilCell extends Rect {
  cap: number;
}

interface CeilingField {
  /** s breakpoints shared by every band. */
  ss: number[];
  /** Bands across t, each a row of cells between consecutive ss (null = open). */
  bands: { t0: number; t1: number; cells: (CeilCell | null)[] }[];
  /** Ceiling height at a plan point (the plain vault where open or outside). */
  at: (s: number, t: number) => number;
}

/**
 * The underground ceiling as cells over the station box: the vault (or flat ceiling) `ceilAt`,
 * open over stairwells and wherever a flight rises through it, and capped as a flat soffit under
 * walkways that pass above the platforms (the 梅田 vault under the B1 concourse), never lower than
 * the platform's head room.
 */
function ceilingField(ctx: Ctx, l: StationLayout, ceilAt: (t: number) => number, nt: number, wellHoles: Rect[]): CeilingField {
  const { box } = l;
  const { plat } = heights(ctx, l);
  const fs = frameSpace(ctx, l);
  const holes = [...wellHoles];
  const caps: { r: Rect; y: number }[] = [];
  const tAt = (j: number) => box.t0 + ((box.t1 - box.t0) * j) / nt;
  const tc = (box.t0 + box.t1) / 2;
  if (fs) {
    const lowest = realY(ctx, plat) + CLEARANCE + 0.05;
    for (let j = 0; j < nt; j++) {
      const [t0, t1] = [tAt(j), tAt(j + 1)];
      const y0 = Math.min(ceilAt(t0), ceilAt(t1));
      const y1 = tc > t0 && tc < t1 ? ceilAt(tc) : Math.max(ceilAt(t0), ceilAt(t1));
      const strip: Rect = { s0: box.s0, s1: box.s1, t0, t1 };
      for (const h of fs.hits(strip, realY(ctx, y0) - 0.01, realY(ctx, y1) + 0.01, undefined, 0)) {
        const cap = h.lo - 0.15;
        if (cap >= lowest) caps.push({ r: snap(h.r, strip), y: ctx.o.Y(cap) });
        else holes.push(snap(h.r, strip));
      }
    }
  }
  const cuts = [...holes, ...caps.map((x) => x.r)];
  const uniq = (xs: number[]) => [...new Set(xs.map((x) => Math.round(x * 1e4) / 1e4))].sort((a, b) => a - b);
  const ss = uniq([box.s0, box.s1, ...cuts.flatMap((q) => [q.s0, q.s1]).filter((s) => s > box.s0 && s < box.s1)]);
  const ts = uniq([...Array.from({ length: nt + 1 }, (_, j) => tAt(j)), ...cuts.flatMap((q) => [q.t0, q.t1]).filter((t) => t > box.t0 && t < box.t1)]);
  const inside = (q: Rect, s: number, t: number) => s > q.s0 && s < q.s1 && t > q.t0 && t < q.t1;
  const bands: CeilingField['bands'] = [];
  for (let j = 0; j < ts.length - 1; j++) {
    const [t0, t1] = [ts[j], ts[j + 1]];
    if (t1 - t0 < 1e-3) continue;
    const tm = (t0 + t1) / 2;
    const cells: (CeilCell | null)[] = [];
    for (let i = 0; i < ss.length - 1; i++) {
      const sm = (ss[i] + ss[i + 1]) / 2;
      if (holes.some((q) => inside(q, sm, tm))) cells.push(null);
      else cells.push({ s0: ss[i], s1: ss[i + 1], t0, t1, cap: Math.min(Infinity, ...caps.filter((x) => inside(x.r, sm, tm)).map((x) => x.y)) });
    }
    bands.push({ t0, t1, cells });
  }
  const at = (s: number, t: number) => {
    const b = bands.find((x) => t >= x.t0 && t <= x.t1);
    const i = ss.findIndex((x, k) => k < ss.length - 1 && s >= x && s <= ss[k + 1]);
    const cell = b && i >= 0 ? b.cells[i] : null;
    return Math.min(cell ? cell.cap : Infinity, ceilAt(t));
  };
  return { ss, bands, at };
}

/** Vertical quad on the line s = S from t0 to t1, bottom and top heights given at each end. */
function sQuad(m: Mesher, f: Frame, S: number, t0: number, t1: number, b0: number, b1: number, h0: number, h1: number, face: 1 | -1, color: THREE.Color): void {
  const a = P(f, S, b0, t0);
  const b = P(f, S, b1, t1);
  const c = P(f, S, h1, t1);
  const d = P(f, S, h0, t0);
  if (face === 1) m.quad(a, b, c, d, color);
  else m.quad(b, a, d, c, color);
}

/** sQuad minus walkable space (the parts of its bounding panel that stay, trimmed to the quad). */
function sQuadW(ctx: Ctx, l: StationLayout, m: Mesher, S: number, t0: number, t1: number, b0: number, b1: number, h0: number, h1: number, face: 1 | -1, color: THREE.Color): void {
  const lerp = (a: number, b: number, t: number) => a + ((b - a) * (t - t0)) / (t1 - t0 || 1);
  for (const q of wallParts(ctx, l, 't', S, t0, t1, Math.min(b0, b1), Math.max(h0, h1))) {
    const [lo0, lo1] = [Math.max(q.t0, lerp(b0, b1, q.s0)), Math.max(q.t0, lerp(b0, b1, q.s1))];
    const [hi0, hi1] = [Math.min(q.t1, lerp(h0, h1, q.s0)), Math.min(q.t1, lerp(h0, h1, q.s1))];
    if (hi0 - lo0 > 0.01 || hi1 - lo1 > 0.01) sQuad(m, l.f, S, q.s0, q.s1, lo0, lo1, Math.max(lo0, hi0), Math.max(lo1, hi1), face, color);
  }
}

/** The ceiling cells as downward faces, with steps where a flat soffit meets the vault. */
function drawCeiling(ctx: Ctx, l: StationLayout, field: CeilingField, ceilAt: (t: number) => number, color: THREE.Color): void {
  const { f } = l;
  const { ss, bands } = field;
  const h = (c: CeilCell, t: number) => Math.min(c.cap, ceilAt(t));
  for (const b of bands) {
    for (let i = 0; i < b.cells.length; ) {
      const c0 = b.cells[i];
      let j = i + 1;
      while (j < b.cells.length && (b.cells[j]?.cap ?? null) === (c0?.cap ?? null)) j++;
      if (c0) {
        const [h0, h1] = [h(c0, b.t0), h(c0, b.t1)];
        const a = P(f, ss[i], h0, b.t0);
        const bb = P(f, ss[j], h0, b.t0);
        const cc = P(f, ss[j], h1, b.t1);
        const d = P(f, ss[i], h1, b.t1);
        ctx.shell.quad(a, d, cc, bb, color, undefined, UP);
      }
      // Step to the next run, seen from under the higher side.
      const c1 = b.cells[j];
      if (c0 && c1) {
        const [a0, a1, b0, b1] = [h(c0, b.t0), h(c0, b.t1), h(c1, b.t0), h(c1, b.t1)];
        if (Math.max(Math.abs(a0 - b0), Math.abs(a1 - b1)) > 0.01) {
          const up = a0 + a1 > b0 + b1;
          sQuadW(ctx, l, ctx.shell, ss[j], b.t0, b.t1, Math.min(a0, b0), Math.min(a1, b1), Math.max(a0, b0), Math.max(a1, b1), up ? -1 : 1, color);
        }
      }
      i = j;
    }
  }
  for (let k = 1; k < bands.length; k++) {
    const [A, B] = [bands[k - 1], bands[k]];
    if (Math.abs(A.t1 - B.t0) > 1e-6) continue;
    const T = B.t0;
    for (let i = 0; i < ss.length - 1; i++) {
      const ca = A.cells[i];
      const cb = B.cells[i];
      if (!ca || !cb || ca.cap === cb.cap) continue;
      const [ha, hb] = [h(ca, T), h(cb, T)];
      if (Math.abs(ha - hb) < 0.01) continue;
      tWallW(ctx, l, ctx.shell, T, ss[i], ss[i + 1], Math.min(ha, hb), Math.max(ha, hb), ha > hb ? -1 : 1, color);
    }
  }
}

function drawUnderground(ctx: Ctx, l: StationLayout): void {
  const { f, box, cfg } = l;
  const c = ctx.c;
  const hs = ctx.hs;
  const { plat, rail, bed } = heights(ctx, l);
  const walk = ctx.o.walk;
  const pit = bed - 0.03;
  // Keep the ceiling below corridors that pass over the platforms (other than our own stairs).
  const own = new Set(ctx.net.edges.filter((e) => VERTICAL.has(e.kind)).flatMap((e) => [e.a, e.b]));
  const ps0 = Math.min(...l.surfs.map((s) => s.s0));
  const ps1 = Math.max(...l.surfs.map((s) => s.s1));
  let ceil = plat + cfg.ceil * hs;
  for (const n of ctx.net.nodes) {
    if (own.has(n.id)) continue;
    const [s, t] = toLocal(f, n.x, n.z);
    if (s < ps0 || s > ps1 || t < box.t0 || t > box.t1) continue;
    const y = ctx.o.Y(n.y);
    if (y > plat + 1.5 * hs) ceil = Math.min(ceil, y - 0.8 * hs);
  }
  const vault = cfg.vault ? Math.min(cfg.vault * hs, ceil - plat) : 0;
  const tc = (box.t0 + box.t1) / 2;
  const half = (box.t1 - box.t0) / 2;
  const ceilAt = (t: number) => ceil + vault * Math.sqrt(Math.max(0, 1 - ((t - tc) / half) ** 2));
  const wallC = new THREE.Color(ctx.o.dark ? cfg.wall[1] : cfg.wall[0]);
  const lineC = new THREE.Color(ctx.net.lines.find((x) => x.id === l.tracks[0].lineId)?.color ?? '#888888');

  // Floor of the track pit (walk only: from above it would veil the levels below).
  if (walk) hRect(ctx.shell, f, box, pit, 1, c.pit);
  drawPlatforms(ctx, l, pit, false);

  // Walls: inward faces, with openings (sill and lintel kept) where walkways and flights pass
  // through them, and the tunnel mouths at the open ends.
  const top = ceil;
  const tunnelEnds = [cfg.ext[0] > 0, cfg.ext[1] > 0];
  const tunnelTop = rail + 4.9 * hs;
  /** Parts of the wall on t = at (axis 's') or s = at (axis 't'). */
  const wallRects = (axis: 's' | 't', at: number, u0: number, u1: number, tunnels: boolean) => {
    const holes = tunnels ? l.tracks.map((tr) => ({ s0: tr.t - 2.3, s1: tr.t + 2.3, t0: pit, t1: tunnelTop })) : [];
    return wallParts(ctx, l, axis, at, u0, u1, pit, top).flatMap((q) => rectMinusHoles(q, holes));
  };
  for (const [T, face] of [[box.t0, 1], [box.t1, -1]] as const) {
    for (const q of wallRects('s', T, box.s0, box.s1, false)) tWall(ctx.shell, f, T, q.s0, q.s1, q.t0, q.t1, face, wallC);
  }
  for (const [S, face, tun] of [[box.s0, 1, tunnelEnds[0]], [box.s1, -1, tunnelEnds[1]]] as const) {
    for (const q of wallRects('t', S, box.t0, box.t1, tun)) sWall(ctx.shell, f, S, q.s0, q.s1, q.t0, q.t1, face, wallC);
    if (tun) {
      // Tunnel mouths: a short dark tube behind each opening.
      for (const tr of l.tracks) {
        const d = -face * 6;
        const S1 = S + d;
        const [a, b] = [Math.min(S, S1), Math.max(S, S1)];
        sWallW(ctx, l, ctx.shell, S1, tr.t - 2.3, tr.t + 2.3, pit, tunnelTop, face, c.tunnel);
        tWallW(ctx, l, ctx.shell, tr.t - 2.3, a, b, pit, tunnelTop, 1, c.tunnel);
        tWallW(ctx, l, ctx.shell, tr.t + 2.3, a, b, pit, tunnelTop, -1, c.tunnel);
        const roof: Rect = { s0: a, s1: b, t0: tr.t - 2.3, t1: tr.t + 2.3 };
        const cut = slabCuts(ctx, l, roof, tunnelTop - 0.02, tunnelTop);
        for (const q of rectMinusHoles(roof, [...cut.holes, ...cut.recesses.map((x) => x.r)])) hRect(ctx.shell, f, q, tunnelTop, -1, c.tunnel);
      }
    }
  }
  // Vault / flat ceiling above the wall tops, facing down, open over the stairwells.
  const holes = wellsThrough(ctx.wells, ceil).map((w) => wellRect(f, w, ceil)).filter((h) => overlaps(h, box));
  const field = ceilingField(ctx, l, ceilAt, vault > 0 ? 14 : 1, holes);
  drawCeiling(ctx, l, field, ceilAt, c.ceiling);
  const soffits = field.bands.flatMap((b) => b.cells.filter((x): x is CeilCell => !!x && x.cap < Infinity));
  const open = [...holes, ...field.bands.flatMap((b) => b.cells.map((x, i) => (x ? null : { s0: field.ss[i], s1: field.ss[i + 1], t0: b.t0, t1: b.t1 })).filter((x): x is Rect => !!x))];
  if (vault > 0) {
    // Vault end walls (gable segments above the flat wall tops), following the ceiling cells.
    for (const [S, face, i] of [[box.s0, 1, 0], [box.s1, -1, field.ss.length - 2]] as const) {
      for (const b of field.bands) {
        const cell = b.cells[i];
        if (!cell) continue;
        const [h0, h1] = [Math.min(cell.cap, ceilAt(b.t0)), Math.min(cell.cap, ceilAt(b.t1))];
        if (Math.max(h0, h1) <= top + 0.01) continue;
        sQuadW(ctx, l, ctx.shell, S, b.t0, b.t1, top, top, Math.max(top, h0), Math.max(top, h1), face, wallC);
      }
    }
  }
  if (!walk) return;

  // Track walls: dado band in the line colour, advertising light boxes, wall 駅名標.
  const sign = nameSignFor(l, l.tracks[0].lineId);
  ctx.signSpecs.push(sign);
  for (const [T, face] of [[box.t0, 1], [box.t1, -1]] as const) {
    const nearTrack = l.tracks.some((tr) => Math.abs(tr.t - T) < 3);
    if (!nearTrack) continue;
    const off = face * 0.03;
    tWallW(ctx, l, ctx.shell, T + off, box.s0, box.s1, pit, plat, face, c.pit);
    tWallW(ctx, l, ctx.shell, T + off, box.s0, box.s1, plat + 0.4 * hs, plat + 0.6 * hs, face, lineC);
    for (let s = ps0 + 6, k = 0; s < ps1 - 6; s += 9, k++) {
      // Nothing hangs in a doorway.
      if (!boxClear(ctx, l, s - 1.6, s + 1.6, plat + 1.1 * hs, plat + 1.1 * hs + 1.4, T - 0.1, T + 0.1)) continue;
      if (k % 4 === 2) {
        // 駅名標 on the wall, facing the platform across the track.
        const y0 = plat + 1.3 * hs;
        const q = signQuad(f, s, T + face * 0.05, y0, 2.6, 0.65, face === 1 ? 1 : -1);
        ctx.signs.push({ key: sign.key, q });
        continue;
      }
      const ad = c.ad[Math.floor(hash01(`${l.id}${s}${T}`) * c.ad.length)];
      const r0 = T + off * 2;
      const a = P(f, s - 1.5, plat + 1.1 * hs, r0);
      const b = P(f, s + 1.5, plat + 1.1 * hs, r0);
      const cc = P(f, s + 1.5, plat + 1.1 * hs + 1.4, r0);
      const d = P(f, s - 1.5, plat + 1.1 * hs + 1.4, r0);
      if (face === -1) ctx.lights.quad(a, b, cc, d, ad);
      else ctx.lights.quad(b, a, d, cc, ad);
    }
  }

  // Pillars, ceiling lights and platform doors per platform.
  const allWells = ctx.wells.map((w) => wellRect(f, w));
  for (const s of l.surfs) {
    if (s.head) continue;
    const w = s.t1 - s.t0;
    const mid = (s.t0 + s.t1) / 2;
    if (cfg.pillars && w >= 7) {
      // Two pillar lines, moved off the walking line beside the stair wells.
      for (const t of columnRows(ctx, l, s, [mid - (w / 2 - 2.1), mid + (w / 2 - 2.1)], 0.43)) {
        for (let x = s.s0 + 5; x < s.s1 - 3; x += 9) {
          if (allWells.some((h) => overlaps(h, { s0: x - 0.5, s1: x + 0.5, t0: t - 0.5, t1: t + 0.5 }, 0.8))) continue;
          const yTop = field.at(x, t);
          if (!boxClear(ctx, l, x - 0.43, x + 0.43, plat, yTop, t - 0.43, t + 0.43, ctx.onPlatform)) continue;
          fBox(ctx.st, f, x - 0.4, x + 0.4, plat, yTop, t - 0.4, t + 0.4, c.column, 12);
          fBox(ctx.st, f, x - 0.43, x + 0.43, plat + 1.9 * hs, plat + 2.1 * hs, t - 0.43, t + 0.43, lineC, 12);
          fBox(ctx.st, f, x - 0.42, x + 0.42, plat, plat + 0.15, t - 0.42, t + 0.42, c.platSide, 12);
        }
      }
    }
    // Light strips (or pendant lights along the crown of the vault), none over openings or under
    // the soffits of passages above.
    const lightY = (t: number) => ceilAt(t) - 0.04;
    const dark = [...open, ...soffits];
    if (vault > 0) {
      for (let x = s.s0 + 6; x < s.s1 - 4; x += 12) {
        if (field.at(x, mid) < ceilAt(mid) - 0.01 || dark.some((q) => overlaps(q, { s0: x - 0.6, s1: x + 0.6, t0: mid - 0.6, t1: mid + 0.6 }))) continue;
        // Pendant lamp: a shallow shade with a glowing bowl beneath.
        fBox(ctx.st, f, x - 0.55, x + 0.55, lightY(mid) - 0.95 * hs, lightY(mid) - 0.85 * hs, mid - 0.55, mid + 0.55, c.steelDark);
        fBox(ctx.lights, f, x - 0.4, x + 0.4, lightY(mid) - 1.05 * hs, lightY(mid) - 0.95 * hs, mid - 0.4, mid + 0.4, c.light);
        fBox(ctx.st, f, x - 0.03, x + 0.03, lightY(mid) - 0.85 * hs, lightY(mid), mid - 0.03, mid + 0.03, c.steelDark);
      }
      for (const t of [mid - w / 3, mid + w / 3]) {
        for (const q of rectMinusHoles({ s0: s.s0 + 1, s1: s.s1 - 1, t0: t - 0.12, t1: t + 0.12 }, dark)) hRect(ctx.lights, f, q, lightY(t), -1, c.light);
      }
    } else {
      for (const t of [mid - w / 4, mid + w / 4]) {
        const r: Rect = { s0: s.s0 + 1, s1: s.s1 - 1, t0: t - 0.14, t1: t + 0.14 };
        for (const q of rectMinusHoles(r, dark)) hRect(ctx.lights, f, q, lightY(t), -1, c.light);
      }
    }
    if (cfg.doors) drawDoors(ctx, l, s, lineC);
  }
}

/** Platform screen doors: half-height ホーム柵 or full-height (うめきた) glass screens. */
function drawDoors(ctx: Ctx, l: StationLayout, s: Surf, lineC: THREE.Color): void {
  const { f } = l;
  const c = ctx.c;
  const hs = ctx.hs;
  const { plat } = heights(ctx, l);
  const full = l.cfg.doors === 'full';
  const H = (full ? 2.4 : 1.3) * hs;
  const fs = frameSpace(ctx, l);
  for (const side of [-1, 1] as const) {
    const ti = s.track[side];
    if (ti === undefined) continue;
    const T = (side === 1 ? s.t1 : s.t0) - side * 0.45;
    const tr = l.tracks[ti];
    const lv = liveryFor(tr.lineId);
    // Door openings follow the car doors of a formation centred like placeTrains does.
    const cars = carsFor(tr.lineId, s.s1 - s.s0);
    const len = trainLength(lv, cars);
    const start = trainStart(tr.buf0 ? tr.s0 : null, tr.buf1 ? tr.s1 : null, s.s0, s.s1, len);
    const pitch = lv.carLen + 0.5;
    const doorsAt: number[] = [];
    for (let k = 0; k < cars; k++) for (let d = 0; d < lv.doors; d++) doorsAt.push(start + k * pitch + (lv.carLen * (d + 0.5)) / lv.doors);
    const t0 = Math.min(T, T - side * 0.25);
    const t1 = Math.max(T, T - side * 0.25);
    // The line of doors opens only where a path actually runs across it or along it (the walking
    // lines along the platform stay well inside it); a walkway's outline merely brushing the door
    // band keeps the doors.
    const runs = fs ? pathRuns(ctx, l, 's', { s0: s.s0 + 1, s1: s.s1 - 1, t0, t1 }, l.py, 0.6, 0.8) : [[s.s0 + 1, s.s1 - 1]];
    const within = (a: number, b: number) => runs.flatMap(([u, v]): [number, number][] => (Math.min(b, v) - Math.max(a, u) > 0.05 ? [[Math.max(a, u), Math.min(b, v)]] : []));
    const inside = (a: number, b: number) => runs.some(([u, v]) => a >= u - 1e-6 && b <= v + 1e-6);
    if (full) {
      // Continuous glass screen with mullions and a header in the line colour.
      for (const [a, b] of runs) {
        tWall(ctx.glass, f, T, a, b, plat, plat + H, side, c.glass);
        for (let x = s.s0 + 1; x <= s.s1 - 1; x += 1.6) if (x >= a - 0.05 && x <= b + 0.05) fBox(ctx.st, f, x - 0.05, x + 0.05, plat, plat + H, t0 + 0.05, t1 - 0.05, c.steel);
      }
      fBoxRuns(ctx, l, ctx.st, 's', s.s0 + 1, s.s1 - 1, plat + H, plat + H + 0.45 * hs, t0, t1, c.doorBody);
      fBoxRuns(ctx, l, ctx.st, 's', s.s0 + 1, s.s1 - 1, plat + H + 0.12 * hs, plat + H + 0.22 * hs, side === 1 ? t0 - 0.01 : t0, side === 1 ? t1 : t1 + 0.01, lineC);
      continue;
    }
    // Half height: a door pocket on each side of every opening, glass panels in between.
    let prev = s.s0 + 1;
    for (const d of doorsAt) {
      if (d < s.s0 + 2 || d > s.s1 - 2) continue;
      const p0 = d - 1.0;
      const p1 = d + 1.0;
      if (p0 - 1.1 > prev) {
        for (const [a, b] of within(prev, p0 - 1.1)) {
          tWall(ctx.glass, f, T, a, b, plat + 0.1, plat + H - 0.1 * hs, side, c.glass);
          fBox(ctx.st, f, a, b, plat + H - 0.1 * hs, plat + H, t0 + 0.05, t1 - 0.05, c.steel);
        }
      }
      for (const [a, b] of [[p0 - 1.1, p0], [p1, p1 + 1.1]]) {
        if (!inside(a, b)) continue;
        fBox(ctx.st, f, a, b, plat, plat + H, t0, t1, c.doorBody);
        fBox(ctx.st, f, a, b, plat + H - 0.12 * hs, plat + H, side === 1 ? t0 - 0.01 : t0, side === 1 ? t1 : t1 + 0.01, lineC);
      }
      // Closed door leaves in the opening.
      if (inside(p0, p1)) fBox(ctx.st, f, p0, p1, plat + 0.1, plat + H * 0.9, t0 + 0.08, t1 - 0.08, c.doorBody);
      prev = p1 + 1.1;
    }
  }
}

// ------------------------------------------------------------------------------------------------
// Catenary / third rail

function drawPower(ctx: Ctx, l: StationLayout): void {
  const { f, cfg } = l;
  const c = ctx.c;
  const hs = ctx.hs;
  const { rail, bed } = heights(ctx, l);
  if (cfg.power === 'third') {
    // Third rail on the side away from the platform, with its protective cover board.
    for (const tr of l.tracks) {
      const plSide = tr.surfs.length ? tr.surfs[0][1] : 1;
      const t = tr.t + plSide * 1.5; // surface side +1 means the platform is at lower t
      fBox(ctx.st, f, tr.s0, tr.s1, bed, rail + 0.12 * hs, t - 0.06, t + 0.06, c.rail, 8);
      fBox(ctx.st, f, tr.s0, tr.s1, rail + 0.22 * hs, rail + 0.25 * hs, t - 0.22, t + 0.22, new THREE.Color('#d9c77a'), 8);
    }
    return;
  }
  if (cfg.power === 'rigid') {
    // Rigid overhead conductor bar under the ceiling with hangers.
    for (const tr of l.tracks) {
      // Bar bottom at the pantograph head height (5.05 m above rail, see train.ts).
      const y = rail + 5.06 * hs;
      fBox(ctx.st, f, tr.s0, tr.s1, y, y + 0.18, tr.t - 0.06, tr.t + 0.06, c.steelDark);
      for (let s = tr.s0 + 2; s < tr.s1; s += 8) ctx.wires.seg(P(f, s, y + 0.18, tr.t), P(f, s, rail + 5.2 * hs, tr.t));
    }
    return;
  }
  // Overhead catenary: portals every 50 m, messenger (sagging) and contact wires with droppers.
  const s0 = Math.min(...l.tracks.map((t) => t.s0));
  const s1 = Math.max(...l.tracks.map((t) => t.s1));
  const ts = l.tracks.map((t) => t.t).sort((a, b) => a - b);
  const onSurf = (t: number) => l.surfs.some((s) => !s.head && t > s.t0 && t < s.t1);
  // Outer masts stand beyond the outermost track, and beyond a platform on that side (JR 11番).
  const beyond = (t: number, dir: 1 | -1) => {
    let x = t;
    for (const s of l.surfs) if (!s.head && x > s.t0 && x < s.t1) x = dir > 0 ? s.t1 + 0.6 : s.t0 - 0.6;
    return x;
  };
  const cols = [beyond(ts[0] - 2.6, -1), beyond(ts[ts.length - 1] + 2.6, 1)];
  for (let i = 0; i < ts.length - 1; i++) {
    const m = (ts[i] + ts[i + 1]) / 2;
    if (ts[i + 1] - ts[i] > 5 && !onSurf(m)) cols.push(m);
  }
  if (l.cfg.groups) for (const s of l.surfs) if (!s.head && (s.t1 - s.t0) > 6) cols.push(s.t1 - 1.8);
  const bridge = ctx.net.nodes.filter((n) => n.stationId === l.id && n.level === '3F' && n.y > l.py + 3).map((n) => toLocal(f, n.x, n.z)[0]);
  const shedEnd = l.id === 'hankyu' ? Math.min(...l.surfs.map((s) => s.s0)) + 152 : -Infinity;
  const beamY = rail + 7.2 * hs;
  const contact = rail + 5.1 * hs;
  const messenger = rail + 6.3 * hs;
  const portals: number[] = [];
  for (let s = s0 + 5; s < s1; s += 50) {
    if (bridge.some((b) => Math.abs(b - s) < 14)) continue;
    if (s < shedEnd) continue;
    portals.push(s);
    for (const t of cols) {
      if (!boxClear(ctx, l, s - 0.2, s + 0.2, bed, beamY + 0.4 * hs, t - 0.2, t + 0.2, ctx.onPlatform)) continue;
      fBox(ctx.st, f, s - 0.2, s + 0.2, bed, beamY + 0.4 * hs, t - 0.2, t + 0.2, c.steelDark, 8);
    }
    fBox(ctx.st, f, s - 0.15, s + 0.15, beamY, beamY + 0.35 * hs, Math.min(...cols), Math.max(...cols), c.steelDark);
    for (const t of ts) ctx.wires.seg(P(f, s, beamY, t), P(f, s, contact, t));
  }
  const sag = 0.7 * hs;
  const step = 5;
  for (const tr of l.tracks) {
    ctx.wires.seg(P(f, tr.s0, contact, tr.t), P(f, tr.s1, contact, tr.t));
    for (let s = tr.s0; s < tr.s1; s += step) {
      const my = (x: number) => {
        const p0 = portals.filter((p) => p <= x).pop() ?? tr.s0;
        const p1 = portals.find((p) => p > x) ?? tr.s1;
        const u = (x - p0) / Math.max(1, p1 - p0);
        return messenger - sag * 4 * u * (1 - u);
      };
      const e = Math.min(tr.s1, s + step);
      ctx.wires.seg(P(f, s, my(s), tr.t), P(f, e, my(e), tr.t));
      ctx.wires.seg(P(f, s, my(s), tr.t), P(f, s, contact, tr.t));
    }
  }
}

// ------------------------------------------------------------------------------------------------
// Signs

function nameSignFor(l: StationLayout, lineId: string): NameSign {
  const ls = LINE_SIGN[lineId] ?? { short: '' };
  const color = lineColour(lineId);
  return {
    kind: 'name',
    key: `name:${l.id}:${lineId}`,
    style: l.cfg.style,
    color,
    kanji: l.cfg.kanji,
    kana: l.cfg.kana,
    roman: l.cfg.roman,
    number: ls.number,
    prev: ls.prev,
    next: ls.next,
  };
}

const LINE_COLOURS: Record<string, string> = {
  'jr-loop': '#f07f1b',
  'jr-kobe': '#1d7fc4',
  'jr-kyoto': '#0b5da8',
  'jr-takarazuka': '#e8b500',
  'jr-ltd': '#3e4c8a',
  'jr-umekita': '#2e6fb5',
  'jr-higashi': '#3a9e9a',
  'jr-tozai': '#d0287e',
  hanshin: '#0a5baa',
  midosuji: '#e5171f',
  tanimachi: '#6a2c8e',
  yotsubashi: '#0078ba',
};

function lineColour(lineId: string): string {
  return LINE_COLOURS[lineId] ?? '#8c1d2e';
}

/** Quad for a sign centred at (s, t) facing +t (face 1) or −t (−1); width along s. */
function signQuad(f: Frame, s: number, t: number, y0: number, w: number, h: number, face: 1 | -1): [V3, V3, V3, V3] {
  // Seen from the +t side (looking along −t) the reader's left is +s.
  const a = P(f, s + (face * w) / 2, y0, t);
  const b = P(f, s - (face * w) / 2, y0, t);
  const c = P(f, s - (face * w) / 2, y0 + h, t);
  const d = P(f, s + (face * w) / 2, y0 + h, t);
  return [a, b, c, d];
}

/** Quad for a sign centred at (s, t) facing +s (face 1) or −s (−1); width along t. */
function signQuadS(f: Frame, s: number, t: number, y0: number, w: number, h: number, face: 1 | -1): [V3, V3, V3, V3] {
  const a = P(f, s, y0, t - (face * w) / 2);
  const b = P(f, s, y0, t + (face * w) / 2);
  const c = P(f, s, y0 + h, t + (face * w) / 2);
  const d = P(f, s, y0 + h, t - (face * w) / 2);
  return [a, b, c, d];
}

function drawSigns(ctx: Ctx, l: StationLayout): void {
  const { f } = l;
  const c = ctx.c;
  const hs = ctx.hs;
  const { plat } = heights(ctx, l);
  const allWells = ctx.wells.map((w) => wellRect(f, w));
  const clear = (s: number, t0: number, t1: number) => !allWells.some((h) => overlaps(h, { s0: s - 1.6, s1: s + 1.6, t0, t1 }, 0.5));
  const covered = l.id === 'jr' ? ctx.net.footprints.find((x) => x.id === 'jr:roof')?.poly.map(([x, z]) => toLocal(f, x, z)[0]) : undefined;
  const underRoof = (s: number) => !!covered && s > Math.min(...covered) && s < Math.max(...covered);
  // What hanging signs hang from: the canopy, the 阪急 shed trusses or the underground ceiling.
  const shedEnd = l.id === 'hankyu' ? Math.min(...l.surfs.map((s) => s.s0)) + 152 : -Infinity;
  const hangFrom = (s: number) => plat + (s < shedEnd ? 9.5 - 1.4 : l.cfg.ceil) * hs;
  for (const s of l.surfs) {
    if (s.head || s.section) continue;
    const mid = (s.t0 + s.t1) / 2;
    const w = s.t1 - s.t0;
    const lineL = s.track[1] !== undefined ? l.tracks[s.track[1] as number].lineId : s.p.lineIds[0];
    const lineR = s.track[-1] !== undefined ? l.tracks[s.track[-1] as number].lineId : s.p.lineIds[0];
    const len = s.s1 - s.s0;
    // 駅名標: every ~60 m, double-faced along the centreline (hanging) or standing near the edges.
    for (let x = s.s0 + len * 0.18; x < s.s1 - 8; x += Math.max(45, len / 5)) {
      if (!clear(x, s.t0, s.t1)) continue;
      const standing = l.cfg.kind === 'elevated' && underRoof(x);
      for (const side of [1, -1] as const) {
        if (s.track[side] === undefined) continue;
        const sign = nameSignFor(l, side === 1 ? lineL : lineR);
        ctx.signSpecs.push(sign);
        if (standing) {
          // Standing signs keep off the walking line and the paths to the stair heads, like columns.
          const t = columnRows(ctx, l, s, [mid + side * Math.max(0.8, w / 2 - 2.4)], 0.1)[0];
          const y0 = plat + 1.05 * hs;
          if (t === undefined || !boxClear(ctx, l, x - 1.3, x + 1.3, plat, y0 + 0.66, t - 0.1, t + 0.1, ctx.onPlatform)) continue;
          ctx.signs.push({ key: sign.key, q: signQuad(f, x, t + side * 0.06, y0, 2.4, 0.6, side) });
          fBox(ctx.st, f, x - 1.3, x + 1.3, y0 - 0.06, y0 + 0.66, t - 0.05, t + 0.05, c.signFrame);
          for (const sx of [-1.1, 1.1]) fBox(ctx.st, f, x + sx - 0.05, x + sx + 0.05, plat, y0, t - 0.05, t + 0.05, c.signFrame, 8);
        } else {
          const y0 = plat + 2.5 * hs;
          ctx.signs.push({ key: sign.key, q: signQuad(f, x, mid + side * 0.07, y0, 2.4, 0.6, side) });
          if (side === 1) {
            fBox(ctx.st, f, x - 1.25, x + 1.25, y0 - 0.05, y0 + 0.65, mid - 0.06, mid + 0.06, c.signFrame);
            for (const sx of [-0.9, 0.9]) fBox(ctx.st, f, x + sx - 0.02, x + sx + 0.02, y0 + 0.65, hangFrom(x), mid - 0.02, mid + 0.02, c.steelDark, 12);
          }
        }
      }
    }
    // Hanging platform-number signs across the platform (both faces, numbers toward their track).
    const nL = s.track[1] !== undefined ? l.tracks[s.track[1] as number].label : '';
    const nR = s.track[-1] !== undefined ? l.tracks[s.track[-1] as number].label : '';
    const item = (no: string, lineId: string) => ({ no, text: TRACK_TEXT[`${l.id}:${no}`] ?? LINE_SIGN[lineId]?.short ?? '' });
    const itemsA = [nL && item(nL, lineL), nR && item(nR, lineR)].filter(Boolean) as { no: string; text: string }[];
    if (itemsA.length === 0) continue;
    const specA: NumberSign = { kind: 'num', key: `num:${l.id}:${nL}:${nR}`, style: l.cfg.style, color: lineColour(lineL), items: itemsA };
    const specB: NumberSign = { ...specA, key: `num:${l.id}:${nR}:${nL}`, items: [...itemsA].reverse() };
    ctx.signSpecs.push(specA, specB);
    for (const k of [0.3, 0.7]) {
      const x = s.s0 + len * k;
      if (!clear(x, mid - 1, mid + 1) || (l.cfg.kind === 'elevated' && underRoof(x))) continue;
      const y0 = plat + 2.55 * hs;
      const sw = Math.min(w - 1.5, 2.2);
      const sh = 0.42;
      // Face +s is read by people walking toward −s: their left is −t (specB lists that track first).
      ctx.signs.push({ key: specB.key, q: signQuadS(f, x + 0.07, mid, y0, sw, sh, 1) });
      ctx.signs.push({ key: specA.key, q: signQuadS(f, x - 0.07, mid, y0, sw, sh, -1) });
      fBox(ctx.st, f, x - 0.06, x + 0.06, y0 - 0.04, y0 + sh + 0.04, mid - sw / 2 - 0.04, mid + sw / 2 + 0.04, c.signFrame);
      for (const tx of [-sw / 3, sw / 3]) fBox(ctx.st, f, x - 0.02, x + 0.02, y0 + sh, hangFrom(x), mid + tx - 0.02, mid + tx + 0.02, c.steelDark, 12);
    }
  }
}

// ------------------------------------------------------------------------------------------------
// Trains

function placeTrains(ctx: Ctx, l: StationLayout, occupied: StationOptions['occupied']): void {
  const focus = new Set(ctx.o.focus ?? []);
  const { rail } = heights(ctx, l);
  const pct = ctx.o.walk ? 0.55 : 0.42;
  // Tracks the caller fills itself, resolved the same way buildTrainModel picks its track.
  const taken = new Set<number>();
  for (const oc of occupied ?? []) {
    const p = l.surfs.find((s) => s.p.id === oc.platformId)?.p;
    const memo = p && trackMemo.get(p);
    if (!memo) continue;
    const side = memo[oc.side] ? oc.side : -oc.side;
    const m = memo[side];
    if (m) taken.add(l.tracks.findIndex((tr) => Math.abs(tr.t - m.t) < 0.01));
  }
  l.tracks.forEach((tr, i) => {
    if (taken.has(i)) return;
    const adj = tr.surfs.map(([si, side]) => ({ s: l.surfs[si], side }));
    const forced = ctx.o.walk && adj.some(({ s }) => focus.has(s.p.id));
    if (!forced && hash01(`${l.id}:${i}:train`) > pct) return;
    const surf = adj[0]?.s;
    if (!surf) return;
    const cars = carsFor(tr.lineId, surf.s1 - surf.s0);
    const parts = trainParts(tr.lineId, cars, ctx.o.walk);
    const s0 = trainStart(tr.buf0 ? tr.s0 : null, tr.buf1 ? tr.s1 : null, surf.s0, surf.s1, parts.length);
    const rev = hash01(`${l.id}:${i}:dir`) > 0.5;
    placeSoup(parts.body, ctx.trainBody, l.f, s0, tr.t, rail, ctx.hs, parts.length, rev);
    placeSoup(parts.equip, ctx.trainEquip, l.f, s0, tr.t, rail, ctx.hs, parts.length, rev);
  });
}

// ------------------------------------------------------------------------------------------------
// Materials and meshes

function finish(ctx: Ctx, group: THREE.Group): void {
  const { o, c } = ctx;
  const add = (m: THREE.Object3D | null, name: string, order = 0) => {
    if (!m) return;
    m.name = name;
    m.renderOrder = order;
    group.add(m);
  };
  const mesh = (soup: Mesher, mat: THREE.Material, attrs: { color?: boolean; uv?: boolean } = { color: true }) => {
    const g = soup.geometry(attrs);
    if (!g) {
      mat.dispose();
      return null;
    }
    return new THREE.Mesh(g, mat);
  };
  add(mesh(ctx.st, new THREE.MeshLambertMaterial({ vertexColors: true })), 'station-structure');
  const shellMat = new THREE.MeshLambertMaterial({
    vertexColors: true,
    transparent: !o.walk,
    opacity: o.walk ? 1 : o.dark ? 0.22 : 0.3,
    depthWrite: o.walk,
    emissive: new THREE.Color(o.dark ? '#1a1a1a' : '#2a2a2a'),
  });
  add(mesh(ctx.shell, shellMat), 'station-shell', o.walk ? 0 : 2);
  const bedMat = (kind: 'ballast' | 'slab') => {
    const tex = trackBedTexture(kind);
    return new THREE.MeshLambertMaterial({ map: tex, color: tex ? new THREE.Color(o.dark ? '#8c8c8c' : '#ffffff') : kind === 'ballast' ? c.deckTop : c.pit });
  };
  add(mesh(ctx.ballast, bedMat('ballast'), { uv: true }), 'track-ballast');
  add(mesh(ctx.slab, bedMat('slab'), { uv: true }), 'track-slab');
  add(mesh(ctx.glass, new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: o.walk ? 0.22 : 0.14, depthWrite: false, side: THREE.DoubleSide })), 'station-glass', 3);
  add(mesh(ctx.lights, new THREE.MeshBasicMaterial({ vertexColors: true })), 'station-lights');
  add(mesh(ctx.roofTop, new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: o.walk ? 0.35 : o.dark ? 0.38 : 0.45, depthWrite: false })), 'station-roof-top', 3);
  const lineMat = (color: string, opacity: number) => new THREE.LineBasicMaterial({ color, transparent: true, opacity });
  const wires = ctx.wires.geometry();
  if (wires) add(new THREE.LineSegments(wires, lineMat(o.dark ? '#a3acb4' : '#2f353b', o.walk ? 0.85 : 0.3)), 'catenary');
  const grid = ctx.grid.geometry();
  if (grid) add(new THREE.LineSegments(grid, lineMat(o.dark ? '#c3ccd3' : '#8e9aa4', o.walk ? 0.5 : 0.35)), 'roof-mullions', 3);
  // Signs: one atlas, quads with the UVs of their cell.
  if (ctx.signs.length) {
    const atlas = signAtlas(ctx.signSpecs);
    const m = new Mesher();
    const white = new THREE.Color('#ffffff');
    for (const s of ctx.signs) {
      const uv = atlas.uv.get(s.key);
      if (!uv) continue;
      const [u0, v0, u1, v1] = uv;
      m.quad(s.q[0], s.q[1], s.q[2], s.q[3], white, [u0, v0, u1, v0, u1, v1, u0, v1]);
    }
    add(mesh(m, new THREE.MeshBasicMaterial({ map: atlas.texture, color: atlas.texture ? 0xffffff : 0xdddddd }), { uv: true }), 'station-signs');
  }
  const tm = trainMaterials(o.dark);
  add(mesh(ctx.trainBody, tm.body, { uv: true }), 'train-bodies');
  add(mesh(ctx.trainEquip, tm.equip), 'train-equipment');
}
