#!/usr/bin/env python3
"""
Generates src/data/osm/{buildings,roads}.ts — the city context of 梅田のりかえ3D — from
OpenStreetMap data as distributed by Overture Maps (© OpenStreetMap contributors, ODbL).

Input: a directory of JSON files already converted to the app's local metres (x = east,
z = south, origin 34.7025 N 135.4957 E, exactly builder.ts ll()), as written by fetch.py:

  buildings.json  building footprints (id, names, height, min_height, num_floors, class, …, geom)
  parts.json      building:part records (building_id, height, min_height, num_floors, min_floor, geom)
  segments.json   transportation segments incl. road_flags, level_rules, width_rules and
                  access_restrictions (one-way streets)
  infra.json      base/infrastructure (platform polygons, helipads)

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

# The walk-mode ground square is the network's extent + 320 m (city.ts); a little margin on top
# lets the network move a few tens of metres without regenerating.
DEFAULT_BBOX = (-720.0, 1030.0, -890.0, 870.0)

FLOOR_H = 3.5  # metres per storey when only a floor count is known
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

# Station footprints context.ts keeps under its own ids (with their own massing).
ROLES = {'大阪梅田': 1, '大阪梅田ツインタワーズ・サウス': 2}
# The JR 大阪駅 station building itself is drawn by station.ts.
SKIP_NAMES = {'大阪駅'}


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
    """(y0, y1, estimated) in real metres for a whole building."""
    h = b.get('height')
    fl = b.get('num_floors')
    y0 = b.get('min_height') or 0.0
    if h:
        return y0, float(h), False
    if fl:
        return y0, fl * FLOOR_H, False
    return y0, estimate_height(b, area), True


def storey(parent):
    """Storey height of a building: its measured height over its floor count when both are
    mapped (and plausible), else FLOOR_H."""
    h, fl = parent.get('height'), parent.get('num_floors')
    if h and fl and 2.8 <= h / fl <= 6.0:
        return h / fl
    return FLOOR_H


def part_heights(p, parent, area):
    st = storey(parent)
    h = p.get('height')
    fl = p.get('num_floors')
    y0 = p.get('min_height')
    if y0 is None:
        y0 = (p.get('min_floor') or 0) * st
    if h:
        return y0, float(h), False
    if fl:
        return y0, max(y0 + st, fl * st), False
    return y0, max(y0 + FLOOR_H, min(14.0, estimate_height(parent, area))), True


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
        if ROLES.get((b.get('names') or {}).get('primary'), 0) or b.get('class') in ('roof', 'train_station'):
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
        role = ROLES.get(name, 0)
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
        for p in parts_by.get(b['id'], []):
            for pp in to_polys(p['geom']):
                if pp.area < 4:
                    continue
                r = prepare(pp)
                if not r:
                    continue
                py0, py1, pest = part_heights(p, b, pp.area)
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


def keep_ranges(ex):
    ex = sorted(ex)
    out = []
    t = 0.0
    for a, b in ex:
        if a > t + 1e-6:
            out.append((t, a))
        t = max(t, b)
    if t < 1 - 1e-6:
        out.append((t, 1.0))
    return out


def is_oneway(s):
    for a in s.get('access_restrictions') or []:
        w = a.get('when') or {}
        if a.get('access_type') == 'denied' and w.get('heading') == 'backward' and not w.get('mode') and not w.get('using') and not w.get('vehicle') and not w.get('during'):
            return True
    return False


def seg_width(s):
    for wr in s.get('width_rules') or []:
        if wr.get('value') and not wr.get('between'):
            return float(wr['value'])
    return None


def key(p):
    return (round(p[0], 2), round(p[1], 2))


def gen_roads(data, bbox):
    X0, X1, Z0, Z1 = bbox
    area_box = Polygon([(X0 - 60, Z0 - 60), (X1 + 60, Z0 - 60), (X1 + 60, Z1 + 60), (X0 - 60, Z1 + 60)])
    pieces = []  # {pts, cls, name, oneway, width}
    for s in data['segments']:
        if s.get('subtype') != 'road' or s.get('class') not in ROAD_CLASS:
            continue
        if s['class'] == 'service' and s.get('subclass') in ('parking_aisle', 'driveway'):
            continue
        g = s['geom']
        lines = [g['pts']] if g['type'] == 'LineString' else g.get('lines', [])
        ranges = keep_ranges(excluded_ranges(s))
        name = (s.get('names') or {}).get('primary')
        for ln in lines:
            if len(ln) < 2:
                continue
            L = LineString(ln)
            if not L.intersects(area_box) or L.length < 0.5:
                continue
            for a, b in ranges:
                part = substring(L, a, b, normalized=True) if (a, b) != (0.0, 1.0) else L
                if part.is_empty or part.length < 1.0 or part.geom_type != 'LineString':
                    continue
                pieces.append({'pts': [tuple(c) for c in part.coords], 'cls': s['class'], 'name': name, 'oneway': is_oneway(s), 'width': seg_width(s)})

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

    # Widths by class, then no two roads may overlap where they run side by side (dual
    # carriageways, side roads).
    for s in strokes:
        two, one = ROAD_WIDTH[s['cls']]
        w = one if s['oneway'] else two
        if s['name'] in NAMED_WIDTH:
            w = NAMED_WIDTH[s['name']]
        elif s['wr'] and s['wr'] >= 3:
            w = s['wr']
        s['w'] = w
    lines = [LineString(s['pts']) for s in strokes]
    tree = STRtree(lines)
    constraints = defaultdict(list)
    for i, s in enumerate(strokes):
        L = lines[i]
        # Arc positions of this stroke's junctions: roads converge there, so samples near them
        # say nothing about roads running side by side.
        cum = [0.0]
        for a, b in zip(s['pts'], s['pts'][1:]):
            cum.append(cum[-1] + math.hypot(b[0] - a[0], b[1] - a[1]))
        joints = [cum[k] for k, f in enumerate(s['fixed']) if f]
        n = int(L.length // 4)
        for k in range(1, n):
            if any(abs(k * 4 - j) < 25 for j in joints):
                continue
            p = L.interpolate(k * 4)
            q = L.interpolate(k * 4 + 1)
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
                constraints[(min(i, j), max(i, j))].append(d)
    rank = {c: k for k, c in enumerate(ROAD_CLASS)}
    for _ in range(3):
        for (i, j), ds in constraints.items():
            if len(ds) < 6:
                continue
            ds = sorted(ds)
            d = ds[len(ds) // 2]
            a, b = strokes[i], strokes[j]
            room = 2 * (d - 0.8)  # room for the two widths together
            if a['w'] + b['w'] <= room:
                continue
            # The lower-class road gives way first, then both shrink alike.
            lo, hi = (a, b) if rank[a['cls']] > rank[b['cls']] else (b, a)
            lo_min = MIN_WIDTH[1 if lo['oneway'] else 0]
            hi_min = MIN_WIDTH[1 if hi['oneway'] else 0]
            if rank[a['cls']] != rank[b['cls']]:
                lo['w'] = max(lo_min, room - hi['w'])
            if lo['w'] + hi['w'] > room:
                f = room / (lo['w'] + hi['w'])
                lo['w'] = max(lo_min, lo['w'] * f)
                hi['w'] = max(hi_min, hi['w'] * f)

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
    return strokes, ncw


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
    ap.add_argument('data', help='directory with buildings.json, parts.json, segments.json, infra.json')
    ap.add_argument('--out', default=os.path.join(os.path.dirname(__file__), '..', '..', 'src', 'data', 'osm'))
    ap.add_argument('--bbox', nargs=4, type=float, default=DEFAULT_BBOX, metavar=('X0', 'X1', 'Z0', 'Z1'))
    ap.add_argument('--debug-json', help='also write the final records as JSON (for previews)')
    a = ap.parse_args()
    data = {}
    for k in ('buildings', 'parts', 'segments', 'infra'):
        with open(os.path.join(a.data, f'{k}.json')) as f:
            data[k] = json.load(f)
    if not any('access_restrictions' in s for s in data['segments'][:200]):
        sys.exit('segments.json lacks access_restrictions (one-way streets): re-fetch with fetch.py (see README.md)')
    bbox = tuple(a.bbox)
    recs, bstats = gen_buildings(data, bbox, LANDMARK_NAMES)
    btxt, bnames = encode_buildings(recs)
    strokes, ncw = gen_roads(data, bbox)
    rtxt, rnames = encode_roads(strokes)
    head = ('// Generated by tools/overture/gen_osm.py from OpenStreetMap data via Overture Maps\n'
            '// (© OpenStreetMap contributors, ODbL 1.0). Do not edit: re-run the generator.\n')
    os.makedirs(a.out, exist_ok=True)
    with open(os.path.join(a.out, 'buildings.ts'), 'w') as f:
        f.write(head + f'// {len(recs)} buildings, {sum(len(r["parts"]) for r in recs)} building parts; decode with codec.ts.\n\n')
        f.write('export const BUILDING_NAMES: string[] = ' + json.dumps(bnames, ensure_ascii=False) + ';\n\n')
        f.write(ts_string('BUILDING_DATA', btxt))
    with open(os.path.join(a.out, 'roads.ts'), 'w') as f:
        f.write(head + f'// {len(strokes)} carriageways, {ncw} crosswalks; decode with codec.ts.\n\n')
        f.write('export const ROAD_NAMES: string[] = ' + json.dumps(rnames, ensure_ascii=False) + ';\n\n')
        f.write(ts_string('ROAD_DATA', rtxt))
    if a.debug_json:
        with open(a.debug_json, 'w') as f:
            json.dump({
                'buildings': [{'name': r['name'], 'cls': r['cls'], 'y0': r['y0'], 'y1': r['y1'], 'est': r['est'], 'rings': r['rings'],
                               'parts': [{'y0': p['y0'], 'y1': p['y1'], 'rings': p['rings']} for p in r['parts']], 'role': r['role'], 'heli': r['heli']} for r in recs],
                'roads': [{'cls': s['cls'], 'name': s['name'], 'oneway': s['oneway'], 'w': s['w'], 'pts': s['pts'], 'cw': s['cw']} for s in strokes],
            }, f, ensure_ascii=False)
    print('buildings', dict(bstats), 'encoded', len(btxt), 'chars,', len(bnames), 'names')
    print('roads', len(strokes), 'strokes,', ncw, 'crosswalks, encoded', len(rtxt), 'chars,', len(rnames), 'names')


if __name__ == '__main__':
    main()
