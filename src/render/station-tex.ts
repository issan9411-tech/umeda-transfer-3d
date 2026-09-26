import * as THREE from 'three';

/**
 * Procedural textures for the station module: ballast / slab track beds and one atlas holding
 * every 駅名標 and platform-number sign. Canvases are created lazily on first use (never at import
 * time), so the module also loads under vitest/node, where every getter returns null and callers
 * fall back to plain colours.
 */

export const hasDom = (): boolean => typeof document !== 'undefined' && typeof document.createElement === 'function';

export const JP_FONT = '"Hiragino Sans","Hiragino Kaku Gothic ProN","Noto Sans JP","Yu Gothic","Meiryo","IPAGothic","IPAPGothic","WenQuanYi Zen Hei",sans-serif';

export function makeCanvas(w: number, h: number): { c: HTMLCanvasElement; g: CanvasRenderingContext2D } | null {
  if (!hasDom()) return null;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  return g ? { c, g } : null;
}

/** Deterministic LCG so textures look the same on every build. */
export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ------------------------------------------------------------------------------------------------
// Track beds

/** Texture layout: u spans the 3 m wide bed across the track, v spans 2.6 m along it (4 sleepers). */
export const BED_WIDTH = 3;
export const BED_REPEAT = 2.6;

const bedCache: Partial<Record<'ballast' | 'slab', THREE.Texture | null>> = {};

export function trackBedTexture(kind: 'ballast' | 'slab'): THREE.Texture | null {
  if (kind in bedCache) return bedCache[kind] ?? null;
  const cv = makeCanvas(128, 256);
  if (!cv) return null;
  const { c, g } = cv;
  const r = rng(kind === 'ballast' ? 7 : 11);
  const pxPerM = 256 / BED_REPEAT;
  if (kind === 'ballast') {
    g.fillStyle = '#857e73';
    g.fillRect(0, 0, 128, 256);
    // Crushed stone: many small light/dark flecks.
    for (let i = 0; i < 2600; i++) {
      const v = 90 + Math.floor(r() * 90);
      g.fillStyle = `rgb(${v + 8},${v + 2},${v - 6})`;
      g.fillRect(r() * 128, r() * 256, 1 + r() * 2.2, 1 + r() * 2.2);
    }
    // Concrete sleepers every 0.65 m, 2.0 m long (centred), 0.24 m wide.
    for (let k = 0; k < 4; k++) {
      const y = (k + 0.5) * 0.65 * pxPerM;
      const hw = 0.12 * pxPerM;
      g.fillStyle = '#b8b3aa';
      g.fillRect(128 * (0.5 - 1 / BED_WIDTH), y - hw, (128 * 2) / BED_WIDTH, hw * 2);
      g.fillStyle = 'rgba(0,0,0,0.25)';
      g.fillRect(128 * (0.5 - 1 / BED_WIDTH), y + hw - 2, (128 * 2) / BED_WIDTH, 2);
    }
  } else {
    // Slab track (underground): concrete bed, a central drain and paired sleeper blocks.
    g.fillStyle = '#8f8d88';
    g.fillRect(0, 0, 128, 256);
    for (let i = 0; i < 900; i++) {
      const v = 120 + Math.floor(r() * 40);
      g.fillStyle = `rgba(${v},${v},${v - 4},0.5)`;
      g.fillRect(r() * 128, r() * 256, 2, 2);
    }
    g.fillStyle = '#5d5b57';
    g.fillRect(58, 0, 12, 256);
    for (let k = 0; k < 4; k++) {
      const y = (k + 0.5) * 0.65 * pxPerM;
      g.fillStyle = '#b0aea8';
      for (const cx of [0.5 - 0.72 / BED_WIDTH, 0.5 + 0.72 / BED_WIDTH]) g.fillRect(128 * cx - 14, y - 10, 28, 20);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  bedCache[kind] = tex;
  return tex;
}

// ------------------------------------------------------------------------------------------------
// Signs

export type SignStyle = 'jr' | 'hankyu' | 'hanshin' | 'metro';

/** 駅名標: station name board facing the track. */
export interface NameSign {
  kind: 'name';
  key: string;
  style: SignStyle;
  /** Line colour (band / number badge). */
  color: string;
  kanji: string;
  kana: string;
  roman: string;
  /** Station number, e.g. "A47", "M16". */
  number?: string;
  prev?: string;
  next?: string;
}

/** Hanging platform-number sign: numbers with a short destination each, left to right. */
export interface NumberSign {
  kind: 'num';
  key: string;
  style: SignStyle;
  color: string;
  items: { no: string; text: string }[];
}

export type SignSpec = NameSign | NumberSign;

/** Pixel size of an atlas cell by sign kind (name boards 4:1, number signs 5.33:1). */
const CELL = { name: [512, 128], num: [512, 96] } as const;
const ATLAS_W = 2048;

export interface SignAtlas {
  texture: THREE.Texture | null;
  /** UV rectangle [u0, v0, u1, v1] of a sign (v0 = bottom). */
  uv: Map<string, [number, number, number, number]>;
}

let atlasCache: { sig: string; atlas: SignAtlas } | null = null;

/** Packs all signs into one texture (one draw call for every sign in the scene). */
export function signAtlas(specs: SignSpec[]): SignAtlas {
  const uniq = [...new Map(specs.map((s) => [s.key, s])).values()];
  const sig = uniq.map((s) => s.key).join('|');
  if (atlasCache && atlasCache.sig === sig) return atlasCache.atlas;
  // Shelf packing: name cells first, then number cells.
  const place = new Map<string, [number, number, number, number]>();
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (const s of [...uniq.filter((q) => q.kind === 'name'), ...uniq.filter((q) => q.kind === 'num')]) {
    const [w, h] = CELL[s.kind];
    if (x + w > ATLAS_W || (rowH && h !== rowH)) {
      x = 0;
      y += rowH;
    }
    rowH = h;
    place.set(s.key, [x, y, w, h]);
    x += w;
  }
  const H = THREE.MathUtils.ceilPowerOfTwo(Math.max(64, y + rowH));
  const uv = new Map<string, [number, number, number, number]>();
  for (const [k, [px, py, w, h]] of place) uv.set(k, [(px + 1) / ATLAS_W, 1 - (py + h - 1) / H, (px + w - 1) / ATLAS_W, 1 - (py + 1) / H]);
  const cv = makeCanvas(ATLAS_W, H);
  let texture: THREE.Texture | null = null;
  if (cv) {
    for (const s of uniq) {
      const [px, py, w, h] = place.get(s.key) as [number, number, number, number];
      cv.g.save();
      cv.g.translate(px, py);
      cv.g.beginPath();
      cv.g.rect(0, 0, w, h);
      cv.g.clip();
      if (s.kind === 'name') drawNameSign(cv.g, s, w, h);
      else drawNumberSign(cv.g, s, w, h);
      cv.g.restore();
    }
    texture = new THREE.CanvasTexture(cv.c);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
  }
  atlasCache?.atlas.texture?.dispose();
  const atlas = { texture, uv };
  atlasCache = { sig, atlas };
  return atlas;
}

/** Writes text scaled down (never up) to fit `maxW`. */
function fitText(g: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number, size: number, weight = 700, align: CanvasTextAlign = 'center'): void {
  g.font = `${weight} ${size}px ${JP_FONT}`;
  const w = g.measureText(text).width;
  if (w > maxW) g.font = `${weight} ${Math.max(8, Math.floor((size * maxW) / w))}px ${JP_FONT}`;
  g.textAlign = align;
  g.textBaseline = 'middle';
  g.fillText(text, x, y);
}

function drawNameSign(g: CanvasRenderingContext2D, s: NameSign, w: number, h: number): void {
  const dark = s.style === 'hankyu';
  const bg = dark ? '#5c1322' : '#fbfbf8';
  const ink = dark ? '#ffffff' : '#15191d';
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  const band = s.style === 'jr' ? (s.color.toLowerCase() === '#f07f1b' ? s.color : '#0b64b3') : s.style === 'hanshin' ? '#0a5baa' : s.style === 'hankyu' ? '#2a0a10' : s.color;
  const bandH = 26;
  if (s.style === 'hanshin') {
    // Blue top band with an orange rule; neighbours go in the lower band.
    g.fillStyle = band;
    g.fillRect(0, 0, w, 12);
    g.fillStyle = '#f18d00';
    g.fillRect(0, 12, w, 3);
  }
  // Bottom band with the neighbouring stations.
  g.fillStyle = band;
  g.fillRect(0, h - bandH, w, bandH);
  g.fillStyle = '#ffffff';
  if (s.prev) fitText(g, `◀ ${s.prev}`, 12, h - bandH / 2, w * 0.42, 17, 700, 'left');
  if (s.next) fitText(g, `${s.next} ▶`, w - 12, h - bandH / 2, w * 0.42, 17, 700, 'right');
  // Station number badge.
  const top = s.style === 'hanshin' ? 16 : 0;
  if (s.number) {
    const bx = 16;
    const by = top + 12;
    const bs = h - bandH - by - 10;
    const [code, num] = [s.number.replace(/[0-9]+$/, ''), s.number.match(/[0-9]+$/)?.[0] ?? ''];
    if (s.style === 'metro') {
      g.beginPath();
      g.arc(bx + bs / 2, by + bs / 2, bs / 2 - 2, 0, Math.PI * 2);
      g.fillStyle = '#ffffff';
      g.fill();
      g.lineWidth = 6;
      g.strokeStyle = s.color;
      g.stroke();
      g.fillStyle = '#15191d';
    } else {
      g.fillStyle = dark ? '#ffffff' : s.style === 'jr' ? band : s.color;
      g.fillRect(bx, by, bs, bs);
      g.fillStyle = dark ? '#5c1322' : '#ffffff';
    }
    fitText(g, code, bx + bs / 2, by + bs * 0.32, bs - 8, 18);
    fitText(g, num, bx + bs / 2, by + bs * 0.68, bs - 8, 24);
  }
  // Name: kana above, kanji large, roman below.
  const cx = w / 2 + (s.number ? 24 : 0);
  const avail = h - bandH - top;
  g.fillStyle = ink;
  fitText(g, s.kana, cx, top + avail * 0.16, w * 0.6, 17, 500);
  fitText(g, s.kanji, cx, top + avail * 0.52, w * 0.62, 50, 800);
  g.fillStyle = dark ? '#f2e3e6' : '#2f363d';
  fitText(g, s.roman, cx, top + avail * 0.86, w * 0.6, 16, 600);
}

function drawNumberSign(g: CanvasRenderingContext2D, s: NumberSign, w: number, h: number): void {
  const bg = s.style === 'hankyu' ? '#2a1d20' : s.style === 'metro' ? '#2b3036' : s.style === 'hanshin' ? '#1b2c46' : '#1f2b3a';
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  g.fillStyle = s.color;
  g.fillRect(0, h - 6, w, 6);
  const n = s.items.length;
  const slot = w / n;
  s.items.forEach((it, i) => {
    const x0 = i * slot;
    // Numbers sit at the outer edges (toward their track) with the destination inboard.
    const leftSide = n === 1 || i === 0;
    const box = h - 22;
    const bx = n === 1 ? x0 + 14 : leftSide ? x0 + 12 : x0 + slot - 12 - box * Math.max(1, it.no.length * 0.55);
    const bw = box * Math.max(1, it.no.length * 0.55);
    g.fillStyle = '#ffffff';
    g.fillRect(bx, 8, bw, box);
    g.fillStyle = '#111111';
    fitText(g, it.no, bx + bw / 2, 8 + box / 2 + 1, bw - 6, box * 0.82, 800);
    g.fillStyle = '#ffffff';
    const tx0 = leftSide ? bx + bw + 10 : x0 + 10;
    const tx1 = leftSide ? x0 + slot - 10 : bx - 10;
    fitText(g, it.text, (tx0 + tx1) / 2, 8 + box / 2, tx1 - tx0, 24, 700);
  });
  if (n === 2) {
    g.fillStyle = 'rgba(255,255,255,0.35)';
    g.fillRect(w / 2 - 1, 10, 2, h - 26);
  }
}

/** Releases the cached GPU textures (the next build recreates them). */
export function disposeStationTextures(): void {
  for (const k of ['ballast', 'slab'] as const) {
    bedCache[k]?.dispose();
    delete bedCache[k];
  }
  atlasCache?.atlas.texture?.dispose();
  atlasCache = null;
}
