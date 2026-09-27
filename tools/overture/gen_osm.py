#!/usr/bin/env python3
"""
Generates src/data/osm/{buildings,roads,malls}.ts — the city context of 梅田のりかえ3D — from
OpenStreetMap data as distributed by Overture Maps (© OpenStreetMap contributors, ODbL):
buildings (outlines, heights, building:parts, landmark names), street-level carriageways (widths,
one-way, crosswalks), the elevated decks of expressways and flyovers (height per vertex) and the
outlines of the underground malls.

Input: a directory of JSON files already converted to the app's local metres (x = east,
z = south, origin 34.7025 N 135.4957 E, exactly builder.ts ll()), as written by fetch.py in this
directory (see README.md here):

  buildings.json  building footprints (id, names, height, min_height, num_floors, class, …, geom)
  parts.json      building:part records (building_id, height, min_height, num_floors, min_floor, geom)
  segments.json   transportation segments incl. road_flags, level_rules, width_rules and
                  access_restrictions (one-way streets)
  infra.json      base/infrastructure (platform polygons, helipads)
  landuse.json    base/land_use polygons (the underground malls' outlines)

Usage:  python3 tools/overture/gen_osm.py DATA_DIR [--out src/data/osm] [--bbox X0 X1 Z0 Z1]

Only OpenStreetMap-sourced features are used. Geometry is simplified (buildings ≈0.4 m, roads
≈0.3 m, junction vertices kept) and rounded to 0.1 m, then packed as zig-zag varints in a
base64url alphabet (see src/data/osm/codec.ts, which decodes it).
"""
import argparse
import json
import math
import os
import sys
from collections import defaultdict

from shapely.geometry import LineString, MultiLineString, MultiPolygon, Point, Polygon
from shapely.geometry.polygon import orient
from shapely.ops import substring, unary_union
from shapely.strtree import STRtree

# The city draws a fixed square (city-layout.ts CITY_SQUARE: centre x 160, z −10, half 850 m,
# i.e. x −690…1010, z −860…840); the data covers it with a margin of 20–30 m.
DEFAULT_BBOX = (-720.0, 1030.0, -890.0, 870.0)

# Metres per storey when only a floor count is known (or the mapped height is implausibly low
# for it): offices and shops have taller floors than flats.
FLOOR_H = 3.5
FLOOR_H_COMMERCIAL = 4.0
COMMERCIAL = {'commercial', 'retail', 'office'}
# A mapped height below this per mapped storey is a mistake (e.g. a 48-storey tower drawn 100 m
# tall): the floor count wins.
MIN_STOREY = 2.6
SIMPLIFY_BLD = 0.4
SIMPLIFY_ROAD = 0.3

# ----------------------------------------------------------------------------- codec

ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'


class Writer:
    """Unsigned / zig-zag varints, 5 payload bits per base64url character."""

    def __init__(self):
        self.out = []
        self.cx = 0
        self.cz = 0

    def u(self, n):
        n = int(n)
        assert n >= 0, n
        while True:
            c = n & 31
            n >>= 5
            if n:
                c |= 32
            self.out.append(ALPHABET[c])
            if not n:
                break

    def s(self, n):
        n = int(n)
        self.u(n * 2 if n >= 0 else -n * 2 - 1)

    def pt(self, x, z):
        """A point in decimetres, delta-coded against the previous point written."""
        xi = int(round(x * 10))
        zi = int(round(z * 10))
        self.s(xi - self.cx)
        self.s(zi - self.cz)
        self.cx, self.cz = xi, zi

    def text(self):
        return ''.join(self.out)


def ts_string(name, s, width=120):
    lines = [s[i:i + width] for i in range(0, len(s), width)]
    body = ',\n'.join(f"  '{ln}'" for ln in lines)
    return f'export const {name} = [\n{body},\n].join(\'\');\n'


# ----------------------------------------------------------------------------- helpers


def rings_of(geom):
    if geom['type'] == 'Polygon':
        return [geom['rings']]
    if geom['type'] == 'MultiPolygon':
        return geom['polys']
    return []


def to_polys(geom):
    out = []
    for rings in rings_of(geom):
        if len(rings[0]) < 4:
            continue
        p = Polygon(rings[0], [r for r in rings[1:] if len(r) >= 4])
        if not p.is_valid:
            p = p.buffer(0)
        if p.is_empty:
            continue
        out.extend(list(p.geoms) if isinstance(p, MultiPolygon) else [p])
    return out


def clean_ring(coords):
    """Rounded to 0.1 m, consecutive duplicates and collinear points dropped, open ring."""
    pts = []
    for x, z in coords[:-1] if coords[0] == coords[-1] else coords:
        q = (round(x, 1), round(z, 1))
        if not pts or q != pts[-1]:
            pts.append(q)
    if len(pts) > 1 and pts[0] == pts[-1]:
        pts.pop()
    changed = True
    while changed and len(pts) > 3:
        changed = False
        for i in range(len(pts)):
            a, b, c = pts[i - 1], pts[i], pts[(i + 1) % len(pts)]
            cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
            if abs(cross) < 0.02:
                pts.pop(i)
                changed = True
                break
    return pts


def signed_area(pts):
    return sum(pts[i][0] * pts[(i + 1) % len(pts)][1] - pts[(i + 1) % len(pts)][0] * pts[i][1] for i in range(len(pts))) / 2


def prepare(poly, tol=SIMPLIFY_BLD):
    """Simplified, oriented (outer counter-clockwise in x/z, holes clockwise) rings, or None."""
    s = poly.simplify(tol, preserve_topology=True)
    if s.is_empty:
        return None
    if isinstance(s, MultiPolygon):
        s = max(s.geoms, key=lambda g: g.area)
    s = orient(s, 1.0)
    outer = clean_ring(list(s.exterior.coords))
    if len(outer) < 3 or signed_area(outer) <= 0:
        return None
    holes = []
    for r in s.interiors:
        h = clean_ring(list(r.coords))
        if len(h) >= 3 and abs(signed_area(h)) >= 4:
            if signed_area(h) > 0:
                h.reverse()
            holes.append(h)
    return [outer] + holes


def sliver(poly):
    """Too small or too thin to be worth drawing (sheds, walls mapped as buildings)."""
    a = poly.area
    return a < 12 or a / max(poly.length, 1e-6) < 0.55


# Smallest canopy (building=roof, m²) kept; the city stands larger ones on thin posts.
MIN_CANOPY = 20.0


# ----------------------------------------------------------------------------- buildings

BUILDING_CLASS = {
    'commercial': 1, 'retail': 1, 'office': 1, 'hotel': 1, 'supermarket': 1, 'kiosk': 1,
    'apartments': 2, 'residential': 2, 'house': 2, 'detached': 2, 'dormitory': 2, 'terrace': 2,
    'parking': 3,
    'temple': 4, 'shrine': 4, 'church': 4, 'religious': 4,
    'school': 5, 'college': 5, 'university': 5, 'hospital': 5, 'public': 5, 'civic': 5,
    'post_office': 5, 'library': 5, 'kindergarten': 5, 'government': 5,
    'warehouse': 6, 'industrial': 6, 'service': 6, 'shed': 6, 'garage': 6, 'cabin': 6,
    'train_station': 7, 'transportation': 7,
}

# Station footprints context.ts keeps under their own ids (with their own massing): mapped name
# and where the outline's centroid is (names are matched only within ROLE_RADIUS of it, as the
# area is 2.4 km across).
ROLES = {'大阪梅田': (1, 245.0, -301.0), '大阪梅田ツインタワーズ・サウス': (2, 236.0, 164.0)}
ROLE_RADIUS = 120.0
# The JR 大阪駅 station building itself is drawn by station.ts.
SKIP_NAMES = {'大阪駅'}

# Published roof heights (m) of landmarks OpenStreetMap has wrong — usually tagged with a floor
# count only, which at 3.5–4 m per storey falls well short of an office tower's 4.5 m storeys
# and crown. Matched by name within 60 m of the spot; the tower parts (and the outline) are
# scaled so the tallest reaches the height. Sources: the owners' and operators' building data
# (as listed by the Japanese high-rise databases, e.g. skyskysky.net, blue-style.com).
HEIGHTS = {
    'ブリーゼタワー': (-159.0, 428.0, 175.0),  # 34F; OSM: 33 levels only (115.5 m)
    'グランフロント大阪 オーナーズタワー': (-155.0, -529.0, 174.2),  # 48F; OSM part: 100 m with 48 levels
    '南館': (-94.0, -193.0, 179.5),  # グランフロント大阪 タワーA, 38F; OSM: 166 m
    '大阪梅田ツインタワーズ・ノース': (274.0, -23.0, 187.0),  # 梅田阪急ビル, 41F; OSM: levels only
    'サウスゲートビルディング': (79.0, 91.0, 122.0),  # 27F; OSM: levels only
    'ハービスOSAKA': (-261.0, 433.0, 190.0),  # 40F; OSM: levels only
    'ハービスENT': (-115.0, 313.0, 133.0),  # 28F; OSM: levels only
    '梅田センタービル': (555.0, -368.0, 134.7),  # 32F; OSM: 125.45 m
    '阪急グランドビル': (310.0, -61.0, 127.0),  # 32F; OSM: 31 levels only (108.5 m)
}


def role_of(b, poly):
    """Station role (1 = 阪急大阪梅田, 2 = 阪神) of a building by name and place, else 0."""
    r = ROLES.get((b.get('names') or {}).get('primary'))
    if not r:
        return 0
    c = poly.centroid
    return r[0] if math.hypot(c.x - r[1], c.y - r[2]) < ROLE_RADIUS else 0


def floor_height(cls):
    return FLOOR_H_COMMERCIAL if cls in COMMERCIAL else FLOOR_H


def estimate_height(b, area):
    cls = b.get('class')
    if cls in ('house', 'detached'):
        return 7.0
    if cls in ('shed', 'garage', 'cabin'):
        return 3.5
    if cls in ('temple', 'shrine', 'church'):
        return 9.0
    if area < 60:
        return 7.0
    if area < 300:
        return 14.0
    if area < 1500:
        return 21.0
    return 24.0


def building_heights(b, area):
    """(y0, y1, estimated) in real metres for a whole building: the mapped height, unless it is
    implausibly low for the mapped floor count (then, like a floor count alone, storeys ×
    floor_height of its use)."""
    h = b.get('height')
    fl = b.get('num_floors')
    y0 = b.get('min_height') or 0.0
    if h and not (fl and h / fl < MIN_STOREY):
        return y0, float(h), False
    if fl:
        return y0, fl * floor_height(b.get('class')), False
    return y0, estimate_height(b, area), True


def storey(parent):
    """Storey height of a building: its measured height over its floor count when both are
    mapped (and plausible), else floor_height of its use."""
    h, fl = parent.get('height'), parent.get('num_floors')
    if h and fl and 2.8 <= h / fl <= 6.0:
        return h / fl
    return floor_height(parent.get('class'))


def part_heights(p, parent, area, bases):
    """(y0, y1, estimated) of a building:part. `bases` are the min_heights of the building's other
    parts: a part whose low height is where another part starts (a podium under a tower) keeps
    it even when its floor count says otherwise."""
    st = storey(parent)
    h = p.get('height')
    fl = p.get('num_floors')
    y0 = p.get('min_height')
    if y0 is None:
        y0 = (p.get('min_floor') or 0) * st
    if h and fl and h / fl < MIN_STOREY and not any(abs(h - m) < 0.5 for m in bases):
        h = None
    if h:
        return y0, float(h), False
    if fl:
        return y0, max(y0 + st, fl * st), False
    return y0, max(y0 + FLOOR_H, min(14.0, estimate_height(parent, area))), True


def published_height(name, poly):
    """HEIGHTS override for a named building at this place, or None."""
    if name not in HEIGHTS:
        return None
    x, z, h = HEIGHTS[name]
    c = poly.centroid
    return h if math.hypot(c.x - x, c.y - z) < 60 else None


def load_jr_exclusion(data):
    """The real JR 大阪駅 platforms (elevated platform polygons around the station)."""
    zones = []
    for i in data['infra']:
        if i.get('class') != 'platform' or not i.get('level') or i['level'] < 1:
            continue
        for p in to_polys(i['geom']):
            x0, z0, x1, z1 = p.bounds
            if x1 > -260 and x0 < 220 and z1 > -130 and z0 < 170:
                zones.append(p)
    return unary_union(zones).buffer(1.0) if zones else None


def gen_buildings(data, bbox, names_keep):
    X0, X1, Z0, Z1 = bbox
    area_box = Polygon([(X0, Z0), (X1, Z0), (X1, Z1), (X0, Z1)])
    jr = load_jr_exclusion(data)
    parts_by = defaultdict(list)
    for p in data['parts']:
        if p.get('is_underground'):
            continue
        parts_by[p['building_id']].append(p)
    helipads = [Point(i['geom']['pt']) for i in data['infra'] if i.get('class') == 'helipad' and i['geom']['type'] == 'Point']
    heli_tree = STRtree(helipads) if helipads else None

    stats = defaultdict(int)
    cands = []
    for b in data['buildings']:
        if b.get('src') != ['OpenStreetMap']:
            stats['not-osm'] += 1
            continue
        if b.get('is_underground'):
            stats['underground'] += 1
            continue
        name = (b.get('names') or {}).get('primary')
        if name in SKIP_NAMES:
            stats['jr-station'] += 1
            continue
        for poly in to_polys(b['geom']):
            if poly.intersects(area_box):
                cands.append((b, poly))
    # Duplicates: a polygon (almost) wholly inside a larger building outline is the same
    # building mapped twice, or a shop mapped as a building inside a mall.
    tree = STRtree([p for _, p in cands])
    drop = set()
    for i, (b, p) in enumerate(cands):
        if role_of(b, p) or b.get('class') in ('roof', 'train_station'):
            continue
        for j in tree.query(p):
            ob, op = cands[j]
            if j == i or ob.get('class') == 'roof' or op.area <= p.area or j in drop:
                continue
            if p.intersection(op).area >= 0.9 * p.area:
                drop.add(i)
                break
    stats['duplicate'] = len(drop)

    recs = []
    for i, (b, poly) in enumerate(cands):
        if i in drop:
            continue
        name = (b.get('names') or {}).get('primary')
        role = role_of(b, poly)
        # Canopies over the JR platforms belong to the station (station.ts draws them).
        if jr is not None and b.get('class') == 'roof' and poly.intersection(jr).area > 0.3 * poly.area:
            stats['canopy-over-jr-platforms'] += 1
            continue
        if sliver(poly):
            stats['sliver'] += 1
            continue
        cls = b.get('class')
        canopy = cls == 'roof'
        y0, y1, est = building_heights(b, poly.area)
        if canopy:
            # Shelters this small (a bus stop's, a doorway's) would only be a floating slab.
            if poly.area < MIN_CANOPY:
                stats['tiny-canopy'] += 1
                continue
            top = float(b['height']) if b.get('height') else 4.5
            y0, y1, est = (b.get('min_height') or max(0.0, top - 0.6)), top, not b.get('height')
            if y1 - y0 > 1.2:
                y0 = y1 - 0.6
        elif y1 < 4 and poly.area < 30:
            stats['tiny-shed'] += 1
            continue
        rings = prepare(poly)
        if not rings:
            stats['degenerate'] += 1
            continue
        parts = []
        mine = parts_by.get(b['id'], [])
        for p in mine:
            bases = [q['min_height'] for q in mine if q is not p and q.get('min_height')]
            for pp in to_polys(p['geom']):
                if pp.area < 4:
                    continue
                r = prepare(pp)
                if not r:
                    continue
                py0, py1, pest = part_heights(p, b, pp.area, bases)
                if py1 <= py0 + 0.3:
                    continue
                parts.append({'poly': pp, 'rings': r, 'y0': py0, 'y1': py1, 'est': pest})
        # A tower part standing on a lower part (podium) starts at the podium's roof, so the
        # two never share wall planes.
        parts.sort(key=lambda q: q['y1'])
        for k, p in enumerate(parts):
            for q in parts[:k]:
                if q['y1'] < p['y1'] and q['y0'] <= p['y0'] + 0.1 and p['poly'].intersection(q['poly']).area >= 0.6 * p['poly'].area:
                    p['y0'] = max(p['y0'], q['y1'])
        # Published height of a landmark: its tower parts (and outline) scaled to reach it.
        ph = published_height(name, poly)
        if ph:
            top = max([y1] + [p['y1'] for p in parts])
            for p in parts:
                if p['y1'] >= max(40.0, 0.6 * top):
                    p['y1'] = p['y1'] * ph / top
                    p['est'] = False
            if not parts or y1 >= max(40.0, 0.6 * top):
                y1 = y1 * ph / top
                est = False
            stats['published-height'] += 1
        heli = False
        if heli_tree is not None and y1 >= 60:
            for k in heli_tree.query(poly):
                if poly.contains(helipads[k]):
                    heli = True
        recs.append({
            'name': name if (name and (name in names_keep or role or (y1 >= 60 and poly.area >= 800))) else None,
            'cls': 8 if canopy else BUILDING_CLASS.get(cls, 0),
            'est': est, 'canopy': canopy, 'role': role, 'heli': heli,
            'rings': rings, 'y0': y0, 'y1': y1, 'parts': parts,
            'c': poly.centroid,
        })
        stats['kept'] += 1
        stats['parts'] += len(parts)
    return recs, stats


def morton(x, z):
    xi = int((x + 2000) / 16)
    zi = int((z + 2000) / 16)
    r = 0
    for i in range(12):
        r |= ((xi >> i) & 1) << (2 * i) | ((zi >> i) & 1) << (2 * i + 1)
    return r


def encode_buildings(recs):
    recs.sort(key=lambda r: morton(r['c'].x, r['c'].y))
    names = sorted({r['name'] for r in recs if r['name']})
    idx = {n: i for i, n in enumerate(names)}
    w = Writer()
    w.u(len(recs))

    def rings(rs):
        w.u(len(rs))
        for ring in rs:
            w.u(len(ring))
            for x, z in ring:
                w.pt(x, z)

    def hgt(v):
        return int(round(v * 2))

    for r in recs:
        flags = (1 if r['est'] else 0) | (2 if r['canopy'] else 0) | (4 if r['name'] else 0) | (8 if r['parts'] else 0) | (r['role'] << 4) | (64 if r['heli'] else 0)
        w.u(flags)
        w.u(r['cls'])
        if r['name']:
            w.u(idx[r['name']])
        w.u(hgt(r['y0']))
        w.u(hgt(r['y1']))
        rings(r['rings'])
        if r['parts']:
            w.u(len(r['parts']))
            for p in r['parts']:
                w.u((1 if p['est'] else 0))
                w.u(hgt(p['y0']))
                w.u(hgt(p['y1']))
                rings(p['rings'])
    return w.text(), names


# ----------------------------------------------------------------------------- roads

ROAD_CLASS = ['trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'service']
# Carriageway width (m): two-way, one-way.
ROAD_WIDTH = {
    'trunk': (22.0, 10.5), 'primary': (16.0, 9.5), 'secondary': (13.0, 7.5), 'tertiary': (10.0, 6.5),
    'unclassified': (6.5, 4.5), 'residential': (5.5, 4.0), 'service': (4.5, 4.0),
}
NAMED_WIDTH = {'御堂筋': 24.0}
# Plan boxes (x0, x1, z0, z1) of the bus terminals in front of JR 大阪駅.
TERMINALS = [(100.0, 200.0, -90.0, 110.0), (-100.0, 20.0, 90.0, 200.0)]
MIN_WIDTH = (5.0, 3.5)


def flags_of(s):
    out = []
    for f in s.get('road_flags') or []:
        out.append((set(f['values']), f.get('between')))
    return out


def excluded_ranges(s):
    """Fractions of the segment that are not a street at ground level (tunnel, bridge deck above
    ground, underground, under construction)."""
    rs = []
    for vals, between in flags_of(s):
        if vals & {'is_tunnel', 'is_under_construction'}:
            rs.append(tuple(between) if between else (0.0, 1.0))
    for lr in s.get('level_rules') or []:
        if lr.get('value'):
            rs.append(tuple(lr['between']) if lr.get('between') else (0.0, 1.0))
    return rs


def oneway_runs(s, length):
    """(a, b, oneway) runs along a segment (fractions of its length): one-way where driving
    backwards (against the drawing direction) is denied to all traffic at all times — over the
    restriction's `between` range, or the whole segment. Runs shorter than 2 m join their longer
    neighbour (a one-way restriction mapped from a few centimetres past a junction)."""
    spans = []
    for a in s.get('access_restrictions') or []:
        w = a.get('when') or {}
        if a.get('access_type') == 'denied' and w.get('heading') == 'backward' and not w.get('mode') and not w.get('using') and not w.get('vehicle') and not w.get('during'):
            spans.append(tuple(a['between']) if a.get('between') else (0.0, 1.0))
    cuts = sorted({0.0, 1.0} | {c for sp in spans for c in sp})
    runs = []
    for a, b in zip(cuts, cuts[1:]):
        if b - a < 1e-9:
            continue
        m = (a + b) / 2
        ow = any(s0 <= m <= s1 for s0, s1 in spans)
        if runs and runs[-1][2] == ow:
            runs[-1] = (runs[-1][0], b, ow)
        else:
            runs.append((a, b, ow))
    while len(runs) > 1:
        k = min(range(len(runs)), key=lambda i: runs[i][1] - runs[i][0])
        if (runs[k][1] - runs[k][0]) * length >= 2.0:
            break
        # Join the shortest run to its longer neighbour (taking the neighbour's direction).
        nb = k - 1 if k == len(runs) - 1 or (k > 0 and runs[k - 1][1] - runs[k - 1][0] >= runs[k + 1][1] - runs[k + 1][0]) else k + 1
        lo, hi = min(k, nb), max(k, nb)
        runs[lo:hi + 1] = [(runs[lo][0], runs[hi][1], runs[nb][2])]
        merged = []
        for r in runs:
            if merged and merged[-1][2] == r[2]:
                merged[-1] = (merged[-1][0], r[1], r[2])
            else:
                merged.append(r)
        runs = merged
    return runs


def split_runs(ranges, runs):
    """Level ranges (a, b) cut further by one-way runs: (a, b, oneway)."""
    out = []
    for a, b in ranges:
        for c, d, ow in runs:
            lo, hi = max(a, c), min(b, d)
            if hi - lo > 1e-9:
                out.append((lo, hi, ow))
    return out


def seg_width(s):
    for wr in s.get('width_rules') or []:
        if wr.get('value') and not wr.get('between'):
            return float(wr['value'])
    return None


def key(p):
    return (round(p[0], 2), round(p[1], 2))


# Samples this close (m) to a junction say nothing about roads running side by side: roads
# converge there, and the junction's own asphalt covers them.
JOINT_SKIP = 25.0
# Kerb-to-kerb gap kept between two carriageways running side by side (a median or a kerb line).
TWIN_GAP = 1.2


def fit_widths(strokes):
    """Carriageway widths where roads run side by side (dual carriageways, side roads, ramps),
    so their asphalt never overlaps.

    Samples every 4 m along each stroke (away from its junctions) find the roads running parallel
    to it (within 20°) 2–25 m away. Each pair of strokes first shares the room between their
    centrelines at its median distance (the lower class gives way first, then both shrink alike,
    down to MIN_WIDTH). Then each stroke is looked at piece by piece between its junctions: a
    piece is narrowed by its own neighbours only (to the pair's 10th percentile distance; a brief
    encounter of 1–2 samples by its largest), starting again from its full width when enough of
    it was seen (≥ 20 m of samples), else from its stroke's shared width.
    Consecutive pieces whose widths differ by at most 1.5 m are joined again (at the narrower
    width); elsewhere the stroke is split at that junction — so 御堂筋 is narrow where its two
    carriageways run close together and wide where it continues alone."""
    lines = [LineString(s['pts']) for s in strokes]
    pieces = []
    spans = []  # per stroke: [(arc0, arc1, piece index)]
    for si, s in enumerate(strokes):
        cum = [0.0]
        for a, b in zip(s['pts'], s['pts'][1:]):
            cum.append(cum[-1] + math.hypot(b[0] - a[0], b[1] - a[1]))
        s['cum'] = cum
        s['w0'] = s['w']
        ks = [k for k, f in enumerate(s['fixed']) if f]
        sp = []
        for a, b in zip(ks, ks[1:]):
            if b > a:
                sp.append((cum[a], cum[b], len(pieces)))
                pieces.append({'s': si, 'pts': s['pts'][a:b + 1], 'len': cum[b] - cum[a]})
        spans.append(sp)

    def piece_at(si, at):
        for a0, a1, pi in spans[si]:
            if at <= a1 + 1e-6:
                return pi
        return spans[si][-1][2]

    tree = STRtree(lines)
    pair_s = defaultdict(list)
    pair_p = defaultdict(list)
    sampled = defaultdict(int)
    partners = defaultdict(set)
    for i, s in enumerate(strokes):
        L = lines[i]
        joints = [s['cum'][k] for k, f in enumerate(s['fixed']) if f]
        n = int(L.length // 4)
        for k in range(1, n):
            at = k * 4
            if any(abs(at - j) < JOINT_SKIP for j in joints):
                continue
            pi = piece_at(i, at)
            sampled[pi] += 1
            p = L.interpolate(at)
            q = L.interpolate(at + 1)
            dx, dz = q.x - p.x, q.y - p.y
            dl = math.hypot(dx, dz) or 1
            for j in tree.query(p.buffer(25)):
                if j == i:
                    continue
                M = lines[j]
                t = M.project(p)
                mp = M.interpolate(t)
                d = p.distance(mp)
                if d < 2.0 or d > 25:
                    continue
                m2 = M.interpolate(min(M.length, t + 1))
                m1 = M.interpolate(max(0, t - 1))
                ex, ez = m2.x - m1.x, m2.y - m1.y
                el = math.hypot(ex, ez) or 1
                if abs(dx * ex + dz * ez) / (dl * el) < math.cos(math.radians(20)):
                    continue
                pj = piece_at(j, t)
                pair_s[(min(i, j), max(i, j))].append(d)
                pk = (min(pi, pj), max(pi, pj))
                pair_p[pk].append(d)
                partners[pi].add(pk)
                partners[pj].add(pk)
    rank = {c: k for k, c in enumerate(ROAD_CLASS)}

    def share(a, b, room):
        """Narrows a and b (dicts with 'w', 'cls', 'oneway') to fit `room` together."""
        if a['w'] + b['w'] <= room:
            return
        lo, hi = (a, b) if rank[a['cls']] > rank[b['cls']] else (b, a)
        lo_min = MIN_WIDTH[1 if lo['oneway'] else 0]
        hi_min = MIN_WIDTH[1 if hi['oneway'] else 0]
        if rank[a['cls']] != rank[b['cls']]:
            lo['w'] = max(lo_min, room - hi['w'])
        if lo['w'] + hi['w'] > room:
            f = room / (lo['w'] + hi['w'])
            lo['w'] = max(lo_min, lo['w'] * f)
            hi['w'] = max(hi_min, hi['w'] * f)

    for _ in range(3):
        for (i, j), ds in pair_s.items():
            if len(ds) >= 6:
                ds.sort()
                share(strokes[i], strokes[j], 2 * ds[len(ds) // 2] - TWIN_GAP)
    for pi, p in enumerate(pieces):
        s = strokes[p['s']]
        p.update(cls=s['cls'], oneway=s['oneway'])
        # Enough of the piece seen to judge: it starts from its full width and only its own
        # neighbours narrow it.
        p['w'] = s['w0'] if sampled[pi] >= 5 else s['w']
    for _ in range(4):
        for (i, j), ds in pair_p.items():
            ds.sort()
            # A brief encounter (1–2 samples) counts only as far as it is sure.
            share(pieces[i], pieces[j], 2 * (ds[len(ds) // 10] if len(ds) >= 3 else ds[-1]) - TWIN_GAP)
    out = []
    for si, s in enumerate(strokes):
        cur = None
        for _, _, pi in spans[si]:
            p = pieces[pi]
            if cur is not None and abs(p['w'] - cur['w']) <= 1.5:
                cur['pts'].extend(p['pts'][1:])
                cur['w'] = min(cur['w'], p['w'])
                continue
            if cur is not None:
                out.append(cur)
            cur = {k: v for k, v in s.items() if k not in ('cum', 'w0', 'fixed')}
            cur.update(pts=list(p['pts']), w=p['w'])
        if cur is not None:
            out.append(cur)
    return out

def ground_plans(recs):
    """Street-level plans of the kept buildings (parts or outline from the ground up; canopies
    left out): what no service road may run through."""
    out = []
    for r in recs:
        if r['canopy']:
            continue
        if r['parts']:
            out.extend(p['poly'] for p in r['parts'] if p['y0'] < 1)
        elif r['y0'] < 1:
            p = Polygon(r['rings'][0], r['rings'][1:])
            out.append(p if p.is_valid else p.buffer(0))
    return out


# A service road running at least this much of its length inside buildings is a passage or a
# garage ramp mapped through them, not a street; of the others, stretches longer than
# SERVICE_CUT inside a building (a driveway into a loading bay) are left out.
SERVICE_INSIDE = 0.5
SERVICE_CUT = 3.0


def outside_runs(line, inside):
    """The line without its stretches longer than SERVICE_CUT inside buildings (`inside` =
    its intersection with them), as LineStrings at least 1 m long."""
    geoms = [inside] if inside.geom_type == 'LineString' else [g for g in getattr(inside, 'geoms', []) if g.geom_type == 'LineString']
    cuts = []
    for g in geoms:
        if g.length > SERVICE_CUT:
            a, b = sorted((line.project(Point(g.coords[0])), line.project(Point(g.coords[-1]))))
            cuts.append((a, b))
    if not cuts:
        return [line]
    cuts.sort()
    out = []
    at = 0.0
    for a, b in cuts + [(line.length, line.length)]:
        if a - at >= 1.0:
            piece = substring(line, at, a)
            if piece.geom_type == 'LineString':
                out.append(piece)
        at = max(at, b)
    return out


def gen_roads(data, bbox, levels, plans):
    X0, X1, Z0, Z1 = bbox
    area_box = Polygon([(X0 - 60, Z0 - 60), (X1 + 60, Z0 - 60), (X1 + 60, Z1 + 60), (X0 - 60, Z1 + 60)])
    plan_tree = STRtree(plans)
    dropped = 0
    pieces = []  # {pts, cls, name, oneway, width}
    for s in data['segments']:
        if s.get('subtype') != 'road' or s.get('class') not in ROAD_CLASS:
            continue
        if s.get('src') and s['src'] != ['OpenStreetMap']:
            continue
        if s['class'] == 'service' and s.get('subclass') in ('parking_aisle', 'driveway'):
            continue
        g = s['geom']
        lines = [g['pts']] if g['type'] == 'LineString' else g.get('lines', [])
        ranges = [(a, b) for a, b, lv in levels[s['id']] if lv == 0]
        name = (s.get('names') or {}).get('primary')
        for ln in lines:
            if len(ln) < 2:
                continue
            L = LineString(ln)
            if not L.intersects(area_box) or L.length < 0.5:
                continue
            for a, b, ow in split_runs(ranges, oneway_runs(s, L.length)):
                part = substring(L, a, b, normalized=True) if (a, b) != (0.0, 1.0) else L
                if part.is_empty or part.length < 1.0 or part.geom_type != 'LineString':
                    continue
                runs = [part]
                if s['class'] == 'service':
                    hits = [plans[k] for k in plan_tree.query(part)]
                    inside = part.intersection(unary_union(hits)) if hits else None
                    if inside is not None and inside.length >= SERVICE_INSIDE * part.length:
                        dropped += 1
                        continue
                    if inside is not None and inside.length > 0:
                        runs = outside_runs(part, inside)
                for run in runs:
                    pieces.append({'pts': [tuple(c) for c in run.coords], 'cls': s['class'], 'name': name, 'oneway': ow, 'width': seg_width(s)})

    # Split pieces at every vertex shared with another piece (junctions).
    count = defaultdict(int)
    for p in pieces:
        seen = set()
        for c in p['pts']:
            k = key(c)
            if k not in seen:
                count[k] += 1
                seen.add(k)
    edges = []
    for p in pieces:
        run = [p['pts'][0]]
        last = len(p['pts']) - 1
        for k, c in enumerate(p['pts'][1:], 1):
            run.append(c)
            if count[key(c)] > 1 and k < last:
                edges.append({**p, 'pts': run})
                run = [c]
        if len(run) >= 2:
            edges.append({**p, 'pts': run})
    edges = [e for e in edges if LineString(e['pts']).length > 0.05]
    at = defaultdict(list)
    for i, e in enumerate(edges):
        at[key(e['pts'][0])].append((i, 0))
        at[key(e['pts'][-1])].append((i, 1))

    def direction(pts, end):
        """Unit direction leaving the polyline at `end` (0 = start, 1 = end), outwards."""
        if end == 0:
            a, b = pts[0], pts[min(len(pts) - 1, 1)]
            dx, dz = a[0] - b[0], a[1] - b[1]
        else:
            a, b = pts[-1], pts[max(0, len(pts) - 2)]
            dx, dz = a[0] - b[0], a[1] - b[1]
        l = math.hypot(dx, dz) or 1
        return dx / l, dz / l

    used = [False] * len(edges)
    strokes = []
    fam = {'trunk': 0, 'primary': 0, 'secondary': 1, 'tertiary': 1, 'unclassified': 2, 'residential': 2, 'service': 3}

    def extend(chain_pts, cur, forward):
        """Greedy continuation from the current chain end; returns list of (edge, reversed)."""
        out = []
        while True:
            end_pt = chain_pts[-1] if forward else chain_pts[0]
            # Outward direction of the chain at that end.
            if forward:
                d = direction(chain_pts, 1)
            else:
                d = direction(chain_pts, 0)
            best = None
            for j, e_end in at[key(end_pt)]:
                if used[j]:
                    continue
                e = edges[j]
                if (e['name'] or '') != (cur['name'] or '') or fam[e['cls']] != fam[cur['cls']] or e['oneway'] != cur['oneway']:
                    continue
                # Appending needs an edge that starts at end_pt, prepending one that ends there;
                # otherwise it is reversed, which a one-way carriageway cannot be.
                rev = e_end == 1 if forward else e_end == 0
                if cur['oneway'] and rev:
                    continue
                inward = direction(e['pts'], e_end)
                # Deflection between the chain's outward direction and the edge's direction away.
                dot = d[0] * -inward[0] + d[1] * -inward[1]
                if dot < math.cos(math.radians(40)):
                    continue
                if best is None or dot > best[0]:
                    best = (dot, j, rev)
            if best is None:
                return out
            _, j, rev = best
            used[j] = True
            pts = edges[j]['pts'][::-1] if rev else edges[j]['pts']
            if forward:
                chain_pts.extend(pts[1:])
            else:
                chain_pts[:0] = pts[:-1]
            out.append(j)

    order = sorted(range(len(edges)), key=lambda i: (ROAD_CLASS.index(edges[i]['cls']), -LineString(edges[i]['pts']).length))
    for i in order:
        if used[i]:
            continue
        used[i] = True
        e = edges[i]
        pts = list(e['pts'])
        members = [i]
        members += extend(pts, e, True)
        members += extend(pts, e, False)
        widths = [edges[m]['width'] for m in members if edges[m]['width']]
        strokes.append({'pts': pts, 'cls': e['cls'], 'name': e['name'], 'oneway': e['oneway'], 'wr': max(widths) if widths else None})

    # Junction vertices: shared with another stroke.
    vcount = defaultdict(set)
    for si, s in enumerate(strokes):
        for c in s['pts']:
            vcount[key(c)].add(si)
    for s in strokes:
        s['fixed'] = [len(vcount[key(c)]) > 1 for c in s['pts']]
        s['fixed'][0] = s['fixed'][-1] = True

    # Widths by class (named avenues and mapped widths first).
    for s in strokes:
        two, one = ROAD_WIDTH[s['cls']]
        w = one if s['oneway'] else two
        if s['name'] in NAMED_WIDTH:
            w = NAMED_WIDTH[s['name']]
        elif s['wr'] and s['wr'] >= 3:
            w = s['wr']
        s['w'] = w
    strokes = fit_widths(strokes)
    vcount = defaultdict(set)
    for si, s in enumerate(strokes):
        for c in s['pts']:
            vcount[key(c)].add(si)
    for s in strokes:
        s['fixed'] = [len(vcount[key(c)]) > 1 for c in s['pts']]
        s['fixed'][0] = s['fixed'][-1] = True

    # Simplify between fixed (junction) vertices.
    for s in strokes:
        out = [s['pts'][0]]
        start = 0
        for k in range(1, len(s['pts'])):
            if s['fixed'][k]:
                run = LineString(s['pts'][start:k + 1]).simplify(SIMPLIFY_ROAD)
                out.extend(list(run.coords)[1:])
                start = k
        pts = []
        for x, z in out:
            q = (round(x, 1), round(z, 1))
            if not pts or q != pts[-1]:
                pts.append(q)
        s['pts'] = pts

    # OSM crosswalks (footway=crossing lines at street level) on the strokes they cross.
    cross_lines = []
    for sg in data['segments']:
        if sg.get('subtype') != 'road' or sg.get('class') != 'footway' or sg.get('subclass') != 'crosswalk':
            continue
        if excluded_ranges(sg):
            continue
        g = sg['geom']
        for ln in ([g['pts']] if g['type'] == 'LineString' else g.get('lines', [])):
            if len(ln) >= 2:
                cross_lines.append((LineString(ln), seg_width(sg)))
    lines = [LineString(s['pts']) for s in strokes]
    tree = STRtree(lines)
    ncw = 0
    for s in strokes:
        s['cw'] = []
    for cl, cw in cross_lines:
        for j in tree.query(cl):
            s = strokes[j]
            if s['cls'] == 'service':
                continue
            hit = cl.intersection(lines[j])
            if hit.is_empty:
                continue
            clip = cl.intersection(lines[j].buffer(s['w'] / 2 + 0.4, cap_style=2))
            segs = [clip] if clip.geom_type == 'LineString' else [g for g in getattr(clip, 'geoms', []) if g.geom_type == 'LineString']
            segs = [g for g in segs if g.length > 1.0]
            if not segs:
                continue
            g = max(segs, key=lambda q: q.length)
            (x0, z0), (x1, z1) = g.coords[0], g.coords[-1]
            s['cw'].append((x0, z0, x1, z1, cw if cw and 2 <= cw <= 10 else 4.0))
            ncw += 1

    strokes = [s for s in strokes if LineString(s['pts']).length >= 3 and LineString(s['pts']).intersects(area_box)]
    # Bus bays of the 大阪駅前 terminals (east: 市バス along 国道176号, south: 中央南口) where
    # buses wait instead of driving.
    for s in strokes:
        if s['cls'] != 'service':
            continue
        m = LineString(s['pts']).interpolate(0.5, normalized=True)
        if any(x0 <= m.x <= x1 and z0 <= m.y <= z1 for x0, x1, z0, z1 in TERMINALS):
            s['terminal'] = True
    return strokes, ncw, dropped


def encode_roads(strokes):
    strokes.sort(key=lambda s: (ROAD_CLASS.index(s['cls']), morton(*s['pts'][len(s['pts']) // 2])))
    names = sorted({s['name'] for s in strokes if s['name']})
    idx = {n: i for i, n in enumerate(names)}
    w = Writer()
    w.u(len(strokes))
    for s in strokes:
        flags = (1 if s['oneway'] else 0) | (2 if s['name'] else 0) | (4 if s.get('terminal') else 0)
        w.u(ROAD_CLASS.index(s['cls']))
        w.u(flags)
        if s['name']:
            w.u(idx[s['name']])
        w.u(int(round(s['w'] * 4)))
        w.u(len(s['pts']))
        for x, z in s['pts']:
            w.pt(x, z)
        w.u(len(s['cw']))
        for x0, z0, x1, z1, cw in s['cw']:
            w.pt(x0, z0)
            w.pt(x1, z1)
            w.u(int(round(cw * 2)))
    return w.text(), names



# ----------------------------------------------------------------------------- viaducts

DECK_CLASSES = ['motorway'] + ROAD_CLASS[:-1]
# Deck top (m above the street) by mapped level (OSM layer of the bridge).
DECK_LEVEL_H = {1: 6.5, 2: 9.5, 3: 14.0, 4: 18.5}
DECK_WIDTH = {'motorway': (17.0, 8.5), **ROAD_WIDTH}
# Steepest ramp between a deck and the street (or between two deck levels).
RAMP = 0.06
SIMPLIFY_DECK = 0.4


def level_runs(s):
    """(a, b, level) runs of a segment along its length: 0 at street level, -1 in a tunnel (or
    under construction), ≥ 1 on a bridge deck above the street."""
    rules = []
    for vals, between in flags_of(s):
        # A covered service road runs under (usually through) a building: like a tunnel.
        if vals & {'is_tunnel', 'is_under_construction'} or (s.get('class') == 'service' and 'is_covered' in vals):
            rules.append((tuple(between) if between else (0.0, 1.0), -1))
    for lr in s.get('level_rules') or []:
        if lr.get('value'):
            rules.append((tuple(lr['between']) if lr.get('between') else (0.0, 1.0), lr['value']))
    cuts = sorted({0.0, 1.0} | {c for (a, b), _ in rules for c in (a, b)})
    out = []
    for a, b in zip(cuts, cuts[1:]):
        if b - a < 1e-6:
            continue
        m = (a + b) / 2
        vs = [v for (ra, rb), v in rules if ra <= m <= rb]
        lv = -1 if (-1 in vs or any(v < 0 for v in vs)) else max(vs, default=0)
        if out and out[-1][2] == lv:
            out[-1] = (out[-1][0], b, lv)
        else:
            out.append((a, b, lv))
    return out



# Level-1 bridges this short (connected pieces together) cross a river or a canal at street level
# (大江橋, 渡辺橋, 田蓑橋 …) rather than fly over the city: they stay streets.
AT_GRADE_BRIDGE = 160.0


def is_link(s):
    return s.get('subclass') == 'link' or any('is_link' in vals for vals, _ in flags_of(s))


def seg_lines(s):
    g = s['geom']
    return [ln for ln in ([g['pts']] if g['type'] == 'LineString' else g.get('lines', [])) if len(ln) >= 2]


def street_levels(data):
    """Level runs (level_runs) of every road segment by id, with the short level-1 bridges of
    ordinary roads (not motorways or ramps) put back at street level."""
    runs = {}
    cands = []
    for sg in data['segments']:
        if sg.get('subtype') != 'road':
            continue
        rs = level_runs(sg)
        runs[sg['id']] = rs
        if sg.get('class') == 'motorway' or is_link(sg):
            continue
        for k, (a, b, lv) in enumerate(rs):
            if lv != 1:
                continue
            for ln in seg_lines(sg):
                part = substring(LineString(ln), a, b, normalized=True)
                if not part.is_empty and part.geom_type == 'LineString':
                    cands.append((sg['id'], k, part))
    parent = list(range(len(cands)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    first = {}
    for i, (_, _, part) in enumerate(cands):
        for c in (part.coords[0], part.coords[-1]):
            j = first.setdefault(key(c), i)
            parent[find(i)] = find(j)
    total = defaultdict(float)
    for i, (_, _, part) in enumerate(cands):
        total[find(i)] += part.length
    for i, (sid, k, _) in enumerate(cands):
        if total[find(i)] < AT_GRADE_BRIDGE:
            a, b, _ = runs[sid][k]
            runs[sid][k] = (a, b, 0)
    for sid, rs in runs.items():
        merged = []
        for a, b, lv in rs:
            if merged and merged[-1][2] == lv:
                merged[-1] = (merged[-1][0], b, lv)
            else:
                merged.append((a, b, lv))
        runs[sid] = merged
    return runs

def gen_viaducts(data, bbox, levels):
    """Elevated carriageways (阪神高速, the 新御堂筋 viaduct, flyovers) as decks with a height at
    every vertex: the mapped level's height, brought down along ramps (at most RAMP) to the street
    where a deck meets a street-level road, and between deck levels where they join."""
    X0, X1, Z0, Z1 = bbox
    area_box = Polygon([(X0 - 60, Z0 - 60), (X1 + 60, Z0 - 60), (X1 + 60, Z1 + 60), (X0 - 60, Z1 + 60)])
    ground = set()
    decks = []
    for sg in data['segments']:
        if sg.get('subtype') != 'road' or sg.get('class') not in ROAD_CLASS + ['motorway']:
            continue
        if sg.get('src') and sg['src'] != ['OpenStreetMap']:
            continue
        g = sg['geom']
        for ln in ([g['pts']] if g['type'] == 'LineString' else g.get('lines', [])):
            if len(ln) < 2:
                continue
            L = LineString(ln)
            if not L.intersects(area_box) or L.length < 0.5:
                continue
            for a, b, lv in levels[sg['id']]:
                part = substring(L, a, b, normalized=True) if (a, b) != (0.0, 1.0) else L
                if part.is_empty or part.geom_type != 'LineString':
                    continue
                if lv == 0:
                    for c in part.coords:
                        ground.add(key(c))
                elif lv >= 1 and sg['class'] in DECK_CLASSES and part.length >= 2:
                    two, one = DECK_WIDTH[sg['class']]
                    link = is_link(sg)
                    # One-way where the restriction covers the middle of the deck piece.
                    ow = any(c <= (a + b) / 2 <= d and o for c, d, o in oneway_runs(sg, L.length))
                    w = seg_width(sg) or (7.0 if link else one if ow else two)
                    pts = [part.coords[0]] + list(part.simplify(SIMPLIFY_DECK).coords)[1:-1] + [part.coords[-1]]
                    decks.append({'pts': pts, 'lv': min(4, lv), 'cls': sg['class'], 'name': (sg.get('names') or {}).get('primary'),
                                  'oneway': ow, 'w': w})
    # Heights: every vertex starts at its level's height (a street-level junction at 0) and is
    # lowered to within RAMP of its neighbours (Dijkstra over the deck network).
    vid = {}
    h = []
    adj = defaultdict(list)
    for d in decks:
        d['v'] = []
        for c in d['pts']:
            k = key(c)
            if k not in vid:
                vid[k] = len(h)
                h.append(DECK_LEVEL_H[d['lv']])
            i = vid[k]
            h[i] = min(h[i], 0.0 if k in ground else DECK_LEVEL_H[d['lv']])
            d['v'].append(i)
        for (i, j), (a, b) in zip(zip(d['v'], d['v'][1:]), zip(d['pts'], d['pts'][1:])):
            l = math.hypot(b[0] - a[0], b[1] - a[1])
            adj[i].append((j, l))
            adj[j].append((i, l))
    import heapq
    heap = [(v, i) for i, v in enumerate(h)]
    heapq.heapify(heap)
    while heap:
        v, i = heapq.heappop(heap)
        if v > h[i]:
            continue
        for j, l in adj[i]:
            if v + RAMP * l < h[j] - 1e-6:
                h[j] = v + RAMP * l
                heapq.heappush(heap, (h[j], j))
    out = []
    for d in decks:
        pts = [(round(x, 1), round(z, 1)) for x, z in d['pts']]
        hs = [round(h[i], 1) for i in d['v']]
        keep = [0] + [k for k in range(1, len(pts)) if pts[k] != pts[k - 1]]
        pts = [pts[k] for k in keep]
        hs = [hs[k] for k in keep]
        if len(pts) >= 2:
            out.append({**d, 'pts': pts, 'h': hs})
    return out


def encode_viaducts(decks):
    decks.sort(key=lambda d: morton(*d['pts'][len(d['pts']) // 2]))
    names = sorted({d['name'] for d in decks if d['name']})
    idx = {n: i for i, n in enumerate(names)}
    w = Writer()
    w.u(len(decks))
    for d in decks:
        w.u(DECK_CLASSES.index(d['cls']))
        w.u((1 if d['oneway'] else 0) | (2 if d['name'] else 0))
        if d['name']:
            w.u(idx[d['name']])
        w.u(int(round(d['w'] * 4)))
        w.u(len(d['pts']))
        for (x, z), hh in zip(d['pts'], d['h']):
            w.pt(x, z)
            w.u(int(round(hh * 10)))
    return w.text(), names


# ----------------------------------------------------------------------------- malls

# The underground malls context.ts draws at B1: mapped land-use outline → (app id, name).
MALLS = {'Whityうめだ': ('whity', 'ホワイティうめだ'), 'ディアモール大阪': ('diamor', 'ディアモール大阪')}


def gen_malls(data):
    """Outlines of the underground malls (the OSM landuse=retail areas named after them),
    simplified to 0.5 m and rounded to 0.1 m, counter-clockwise in x/z."""
    out = []
    for l in data['landuse']:
        name = (l.get('names') or {}).get('primary')
        if name not in MALLS or (l.get('src') and l['src'] != ['OpenStreetMap']):
            continue
        polys = to_polys(l['geom'])
        if not polys:
            continue
        rings = prepare(max(polys, key=lambda p: p.area), 0.5)
        if rings:
            out.append({'id': MALLS[name][0], 'name': MALLS[name][1], 'poly': rings[0]})
    missing = {v[0] for v in MALLS.values()} - {m['id'] for m in out}
    if missing:
        sys.exit(f'landuse.json lacks the mall outlines {sorted(missing)}: re-fetch with tools/overture/fetch.py')
    return sorted(out, key=lambda m: m['id'])


# ----------------------------------------------------------------------------- main

LANDMARK_NAMES = {
    'ノースゲートビルディング', 'サウスゲートビルディング', '南館', '北館', 'グランフロント大阪 オーナーズタワー',
    'ヨドバシ梅田タワー', '大阪梅田ツインタワーズ・ノース', '大阪梅田ツインタワーズ・サウス', 'JPタワー大阪',
    'イノゲート大阪', 'うめきたグリーンプレイス', 'グラングリーン大阪 北館', '南館 パークタワー', '南館 ゲートタワー',
    '南館 サウスタワー', 'ハービスOSAKA', 'ハービスENT', '大阪駅前第1ビル', '大阪駅前第2ビル', '大阪駅前第4ビル',
    'HEP FIVE', 'HEP NAVIO', '梅田スカイビル', 'ヒルトンプラザ イースト', 'ヒルトンプラザ ウエスト', 'ブリーゼタワー',
    '大阪梅田', '梅田DTタワー', 'E-MA', '大阪第一生命ビル', 'OSビル', '大阪富国生命ビル', '阪急茶屋町ビルディング',
    'NU茶屋町', 'チャスカ茶屋町', '梅田ロフトビル', 'ザ・梅田タワー', 'OIT梅田タワー', 'アパホテル&リゾート 大阪梅田駅タワー',
    '大阪駅 うめきた地下口', 'GRAND GREEN OSAKA THE NORTH RESIDENCE', '梅田センタービル', '堂島アバンザ',
}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('data', help='directory with buildings.json, parts.json, segments.json, infra.json, landuse.json')
    ap.add_argument('--out', default=os.path.join(os.path.dirname(__file__), '..', '..', 'src', 'data', 'osm'))
    ap.add_argument('--bbox', nargs=4, type=float, default=DEFAULT_BBOX, metavar=('X0', 'X1', 'Z0', 'Z1'))
    ap.add_argument('--debug-json', help='also write the final records as JSON (for previews)')
    a = ap.parse_args()
    data = {}
    for k in ('buildings', 'parts', 'segments', 'infra', 'landuse'):
        with open(os.path.join(a.data, f'{k}.json')) as f:
            data[k] = json.load(f)
    if not any('access_restrictions' in s for s in data['segments'][:200]):
        sys.exit('segments.json lacks access_restrictions (one-way streets): re-fetch with tools/overture/fetch.py')
    bbox = tuple(a.bbox)
    recs, bstats = gen_buildings(data, bbox, LANDMARK_NAMES)
    btxt, bnames = encode_buildings(recs)
    levels = street_levels(data)
    strokes, ncw, ndrop = gen_roads(data, bbox, levels, ground_plans(recs))
    rtxt, rnames = encode_roads(strokes)
    decks = gen_viaducts(data, bbox, levels)
    vtxt, vnames = encode_viaducts(decks)
    malls = gen_malls(data)
    head = ('// Generated by tools/overture/gen_osm.py from OpenStreetMap data via Overture Maps\n'
            '// (© OpenStreetMap contributors, ODbL 1.0). Do not edit: re-run the generator.\n')
    os.makedirs(a.out, exist_ok=True)
    with open(os.path.join(a.out, 'buildings.ts'), 'w') as f:
        f.write(head + f'// {len(recs)} buildings, {sum(len(r["parts"]) for r in recs)} building parts; decode with codec.ts.\n\n')
        f.write('export const BUILDING_NAMES: string[] = ' + json.dumps(bnames, ensure_ascii=False) + ';\n\n')
        f.write(ts_string('BUILDING_DATA', btxt))
    with open(os.path.join(a.out, 'roads.ts'), 'w') as f:
        f.write(head + f'// {len(strokes)} carriageways, {ncw} crosswalks, {len(decks)} elevated decks; decode with codec.ts.\n\n')
        f.write('export const ROAD_NAMES: string[] = ' + json.dumps(rnames, ensure_ascii=False) + ';\n\n')
        f.write(ts_string('ROAD_DATA', rtxt))
        f.write('\nexport const VIADUCT_NAMES: string[] = ' + json.dumps(vnames, ensure_ascii=False) + ';\n\n')
        f.write(ts_string('VIADUCT_DATA', vtxt))
    with open(os.path.join(a.out, 'malls.ts'), 'w') as f:
        f.write(head + '// The underground malls drawn at B1: their mapped outlines (landuse), local metres.\n\n')
        f.write('export const MALLS: { id: string; nameJa: string; poly: [number, number][] }[] = [\n')
        for m in malls:
            f.write(f"  {{\n    id: '{m['id']}',\n    nameJa: '{m['name']}',\n    poly: [\n")
            for k in range(0, len(m['poly']), 6):
                f.write('      ' + ' '.join(f'[{x:g}, {z:g}],' for x, z in m['poly'][k:k + 6]) + '\n')
            f.write('    ],\n  },\n')
        f.write('];\n')
    if a.debug_json:
        with open(a.debug_json, 'w') as f:
            json.dump({
                'buildings': [{'name': r['name'], 'cls': r['cls'], 'y0': r['y0'], 'y1': r['y1'], 'est': r['est'], 'rings': r['rings'],
                               'parts': [{'y0': p['y0'], 'y1': p['y1'], 'rings': p['rings']} for p in r['parts']], 'role': r['role'], 'heli': r['heli']} for r in recs],
                'roads': [{'cls': s['cls'], 'name': s['name'], 'oneway': s['oneway'], 'w': s['w'], 'pts': s['pts'], 'cw': s['cw']} for s in strokes],
                'viaducts': [{'cls': d['cls'], 'name': d['name'], 'oneway': d['oneway'], 'w': d['w'], 'pts': d['pts'], 'h': d['h']} for d in decks],
            }, f, ensure_ascii=False)
    print('buildings', dict(bstats), 'encoded', len(btxt), 'chars,', len(bnames), 'names')
    print('roads', len(strokes), 'strokes,', ncw, 'crosswalks,', ndrop, 'service pieces inside buildings left out, encoded', len(rtxt), 'chars,', len(rnames), 'names')
    print('viaducts', len(decks), 'decks,', sum(len(d['pts']) for d in decks), 'vertices, encoded', len(vtxt), 'chars')
    print('malls', [(m['id'], len(m['poly'])) for m in malls])


if __name__ == '__main__':
    main()
