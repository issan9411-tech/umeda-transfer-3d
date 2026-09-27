#!/usr/bin/env python3
"""
Fetches the OpenStreetMap-derived Overture Maps data around 梅田 that gen_osm.py turns into
src/data/osm/*.ts, and writes it as JSON in the app's local metres.

Usage:  python3 tools/overture/fetch.py OUT_DIR [--release 2026-09-23.1] [--only buildings,...]

Reads the public GeoParquet release straight from s3://overturemaps-us-west-2 over HTTPS range
requests (no credentials, no full download): for each data set it lists the release's files,
keeps the row groups whose bbox statistics overlap the area, and reads only those. Needs
pyarrow and shapely. Writes buildings.json, parts.json, segments.json and infra.json:

  x = east, z = south (metres), origin 34.7025 N 135.4957 E — exactly builder.ts ll().

Data: OpenStreetMap © OpenStreetMap contributors (ODbL 1.0), distributed by Overture Maps.
"""
import argparse
import io
import json
import math
import os
import re
import ssl
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

BASE = 'https://overturemaps-us-west-2.s3.amazonaws.com/'
# Area (lon0, lon1, lat0, lat1): about 2.4 × 2.7 km around the stations.
AREA = (135.484, 135.510, 34.690, 34.714)
ORIGIN = (34.7025, 135.4957)

DATASETS = {
    'buildings': ('buildings', 'building', 'id,height,min_height,num_floors,num_floors_underground,level,is_underground,subtype,class,has_parts,roof_shape,roof_height,facade_color,facade_material,roof_color,sources,names'),
    'parts': ('buildings', 'building_part', 'id,building_id,height,min_height,num_floors,min_floor,level,is_underground,roof_shape,facade_color,facade_material,names'),
    'segments': ('transportation', 'segment', 'id,subtype,class,subclass,road_flags,level_rules,width_rules,access_restrictions,connectors,sources,names'),
    'infra': ('base', 'infrastructure', 'id,subtype,class,level,names'),
}

_ctx = ssl.create_default_context()
_bundle = os.environ.get('SSL_CERT_FILE') or ('/root/.ccr/ca-bundle.crt' if os.path.exists('/root/.ccr/ca-bundle.crt') else None)
if _bundle:
    _ctx.load_verify_locations(_bundle)
_opener = urllib.request.build_opener(urllib.request.ProxyHandler(), urllib.request.HTTPSHandler(context=_ctx))


def get(key, start=None, end=None, tries=5):
    for i in range(tries):
        try:
            req = urllib.request.Request(BASE + key)
            if start is not None:
                req.add_header('Range', f'bytes={start}-{end}')
            with _opener.open(req, timeout=120) as r:
                return r.read()
        except Exception:
            if i == tries - 1:
                raise
            time.sleep(2 ** i)


class RangeFile(io.RawIOBase):
    """Seekable read-only file over HTTP range requests, with a block cache."""

    def __init__(self, key, size, block=1 << 20):
        self.key, self.size, self.pos, self.block, self.cache = key, size, 0, block, {}

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, off, whence=0):
        self.pos = off if whence == 0 else self.pos + off if whence == 1 else self.size + off
        return self.pos

    def _blk(self, i):
        if i not in self.cache:
            s = i * self.block
            self.cache[i] = get(self.key, s, min(self.size, s + self.block) - 1)
        return self.cache[i]

    def read(self, n=-1):
        if n < 0:
            n = self.size - self.pos
        n = min(n, self.size - self.pos)
        out = bytearray()
        while n > 0:
            i, o = divmod(self.pos, self.block)
            b = self._blk(i)[o:o + n]
            out += b
            self.pos += len(b)
            n -= len(b)
        return bytes(out)

    def readinto(self, b):
        d = self.read(len(b))
        b[:len(d)] = d
        return len(d)


def listing(prefix):
    keys, token = [], None
    while True:
        q = f'?list-type=2&prefix={prefix}' + (f'&continuation-token={urllib.request.quote(token)}' if token else '')
        t = get(q).decode()
        keys += re.findall(r'<Key>([^<]+)</Key>.*?<Size>(\d+)</Size>', t)
        m = re.search(r'<NextContinuationToken>([^<]+)</NextContinuationToken>', t)
        if not m:
            return [(k, int(s)) for k, s in keys if k.endswith('.parquet')]
        token = m.group(1)


def local(c):
    olat, olon = ORIGIN
    return [round((c[0] - olon) * 111320 * math.cos(olat * math.pi / 180), 2), round(-(c[1] - olat) * 110936, 2)]


def convert(g):
    t = g.geom_type
    if t == 'Polygon':
        return {'type': t, 'rings': [[local(c) for c in g.exterior.coords]] + [[local(c) for c in r.coords] for r in g.interiors]}
    if t == 'MultiPolygon':
        return {'type': t, 'polys': [convert(p)['rings'] for p in g.geoms]}
    if t == 'LineString':
        return {'type': t, 'pts': [local(c) for c in g.coords]}
    if t == 'MultiLineString':
        return {'type': t, 'lines': [[local(c) for c in ln.coords] for ln in g.geoms]}
    if t == 'Point':
        return {'type': t, 'pt': local(g.coords[0])}
    return {'type': t}


def names(n):
    if not n:
        return None
    out = {'primary': n.get('primary')}
    for kv in n.get('common') or []:
        k, v = kv if isinstance(kv, tuple) else (kv['key'], kv['value'])
        if k in ('ja', 'en'):
            out[k] = v
    return out


def fetch(release, theme, typ, cols):
    import pyarrow.parquet as pq
    from shapely import wkb
    from shapely.geometry import box

    x0, x1, y0, y1 = AREA
    aoi = box(x0, y0, x1, y1)
    files = listing(f'release/{release}/theme={theme}/type={typ}/')
    if not files:
        sys.exit(f'no files for {theme}/{typ} in release {release}')

    def scan(kv):
        k, size = kv
        md = pq.ParquetFile(RangeFile(k, size, block=1 << 18)).metadata
        rg0 = md.row_group(0)
        names_ = [rg0.column(j).path_in_schema for j in range(rg0.num_columns)]
        ix = {n: names_.index(n) for n in ('bbox.xmin', 'bbox.xmax', 'bbox.ymin', 'bbox.ymax')}
        hits = []
        for i in range(md.num_row_groups):
            st = {n: md.row_group(i).column(j).statistics for n, j in ix.items()}
            if st['bbox.xmin'].min <= x1 and st['bbox.xmax'].max >= x0 and st['bbox.ymin'].min <= y1 and st['bbox.ymax'].max >= y0:
                hits.append(i)
        return k, size, hits

    with ThreadPoolExecutor(24) as ex:
        groups = [g for g in ex.map(scan, files) if g[2]]
    out = []
    for k, size, hits in groups:
        pf = pq.ParquetFile(RangeFile(k, size))
        for i in hits:
            for r in pf.read_row_group(i, columns=cols + ['geometry', 'bbox']).to_pylist():
                b = r['bbox']
                if b['xmax'] < x0 or b['xmin'] > x1 or b['ymax'] < y0 or b['ymin'] > y1:
                    continue
                g = wkb.loads(r['geometry'])
                if not g.intersects(aoi):
                    continue
                d = {c: r[c] for c in cols if c not in ('names', 'sources')}
                if 'sources' in cols:
                    d['src'] = sorted({s['dataset'] for s in (r['sources'] or [])})
                if 'names' in cols:
                    d['names'] = names(r['names'])
                d['geom'] = convert(g)
                out.append(d)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('out', help='directory for the JSON files')
    ap.add_argument('--release', default='2026-09-23.1')
    ap.add_argument('--only', help='comma-separated subset of ' + ','.join(DATASETS))
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    for name in (a.only.split(',') if a.only else DATASETS):
        theme, typ, cols = DATASETS[name]
        t = time.time()
        rows = fetch(a.release, theme, typ, cols.split(','))
        with open(os.path.join(a.out, f'{name}.json'), 'w') as f:
            json.dump(rows, f, ensure_ascii=False, default=str)
        print(f'{name}: {len(rows)} features ({time.time() - t:.0f} s)', flush=True)


if __name__ == '__main__':
    main()
