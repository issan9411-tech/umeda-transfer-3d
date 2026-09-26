import * as THREE from 'three';

/**
 * Procedural textures for the walk-through interiors, drawn on canvases the first time a walk
 * scene is built (never at import time, so the module loads under node / vitest). Without a DOM
 * every factory returns null and the materials fall back to plain colours.
 *
 * Scales (the builder maps UVs in metres with these): floor tiles repeat every TILE_M, stone
 * every STONE_M, …; the shop and sign atlases are addressed by cell.
 */

export const TILE_M = 2.4;
export const STONE_M = 3.2;
export const PAVER_M = 2.4;
export const ASPHALT_M = 3;
export const TACTILE_M = 0.3;
export const WALL_M = 2.4;
export const CEIL_M = 2.4;
/** Length of one escalator step along the incline (scene units per texture repeat). */
export const ESC_STEP = 0.6;

export const SHOP_COLS = 4;
export const SHOP_ROWS = 4;
/** Atlas cells 0…11 are shopfronts, 12…14 wall adverts, 15 a pair of glass entrance doors. */
export const SHOP_CELLS = 12;
export const AD_CELLS = [12, 13, 14];
export const DOOR_CELL = 15;

export const SIGN_COLS = 4;
export const SIGN_W = 512;
export const SIGN_H = 64;

type Ctx = CanvasRenderingContext2D;

function canvas(w: number, h: number): { c: HTMLCanvasElement; x: Ctx } | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const x = c.getContext('2d');
  return x ? { c, x } : null;
}

function texture(c: HTMLCanvasElement, repeat = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.anisotropy = 8;
  return t;
}

/** Small deterministic PRNG so textures look the same on every build. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rgb = (r: number, g: number, b: number, a = 1) => `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${a})`;

function speckle(x: Ctx, w: number, h: number, n: number, r: () => number, colors: string[], size: [number, number]): void {
  for (let i = 0; i < n; i++) {
    x.fillStyle = colors[Math.floor(r() * colors.length)];
    const s = size[0] + r() * (size[1] - size[0]);
    x.fillRect(r() * w, r() * h, s, s);
  }
}

/** Paid-area station floor: 30 cm porcelain tiles with grout lines. */
export function tileTexture(): THREE.CanvasTexture | null {
  const k = canvas(512, 512);
  if (!k) return null;
  const { c, x } = k;
  const r = rng(11);
  const n = 8;
  const s = 512 / n;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const v = 214 + (r() - 0.5) * 10;
      x.fillStyle = rgb(v, v - 4, v - 11);
      x.fillRect(i * s, j * s, s, s);
    }
  }
  speckle(x, 512, 512, 2600, r, ['rgba(120,110,95,0.18)', 'rgba(255,255,255,0.25)', 'rgba(90,85,80,0.12)'], [1, 2.2]);
  x.fillStyle = 'rgba(150,142,130,0.9)';
  for (let i = 0; i <= n; i++) {
    x.fillRect(i * s - 1, 0, 2, 512);
    x.fillRect(0, i * s - 1, 512, 2);
  }
  return texture(c);
}

/** Mall floor: polished terrazzo slabs in a faint checker with stone chips. */
export function stoneTexture(): THREE.CanvasTexture | null {
  const k = canvas(512, 512);
  if (!k) return null;
  const { c, x } = k;
  const r = rng(23);
  const n = 2;
  const s = 512 / n;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const d = (i + j) % 2 ? -9 : 0;
      const g = x.createLinearGradient(i * s, j * s, (i + 1) * s, (j + 1) * s);
      g.addColorStop(0, rgb(222 + d, 212 + d, 196 + d));
      g.addColorStop(1, rgb(210 + d, 200 + d, 184 + d));
      x.fillStyle = g;
      x.fillRect(i * s, j * s, s, s);
    }
  }
  speckle(x, 512, 512, 5200, r, ['rgba(120,100,80,0.35)', 'rgba(250,248,240,0.55)', 'rgba(70,65,60,0.3)', 'rgba(160,120,90,0.3)'], [1, 3.5]);
  x.strokeStyle = 'rgba(140,128,110,0.8)';
  x.lineWidth = 2;
  for (let i = 0; i <= n; i++) {
    x.beginPath();
    x.moveTo(i * s, 0);
    x.lineTo(i * s, 512);
    x.moveTo(0, i * s);
    x.lineTo(512, i * s);
    x.stroke();
  }
  return texture(c);
}

/** Outdoor pavement: granite-coloured pavers in running bond. */
export function paverTexture(): THREE.CanvasTexture | null {
  const k = canvas(512, 512);
  if (!k) return null;
  const { c, x } = k;
  const r = rng(37);
  x.fillStyle = '#8d8a84';
  x.fillRect(0, 0, 512, 512);
  const bw = 64;
  const bh = 32;
  for (let j = 0; j < 512 / bh; j++) {
    const off = j % 2 ? bw / 2 : 0;
    for (let i = -1; i < 512 / bw + 1; i++) {
      const v = 168 + (r() - 0.5) * 34;
      const warm = r() * 10;
      x.fillStyle = rgb(v + warm, v + warm * 0.5, v - 4);
      x.fillRect(i * bw + off + 1.5, j * bh + 1.5, bw - 3, bh - 3);
    }
  }
  speckle(x, 512, 512, 3000, r, ['rgba(60,60,60,0.2)', 'rgba(255,255,255,0.18)'], [1, 2]);
  return texture(c);
}

export function asphaltTexture(): THREE.CanvasTexture | null {
  const k = canvas(256, 256);
  if (!k) return null;
  const { c, x } = k;
  const r = rng(41);
  x.fillStyle = '#4c4f53';
  x.fillRect(0, 0, 256, 256);
  speckle(x, 256, 256, 4000, r, ['rgba(20,20,22,0.35)', 'rgba(150,150,150,0.25)', 'rgba(90,90,95,0.4)'], [1, 2.5]);
  return texture(c);
}

/** Yellow tactile paving (warning dots). */
export function tactileTexture(): THREE.CanvasTexture | null {
  const k = canvas(128, 128);
  if (!k) return null;
  const { c, x } = k;
  x.fillStyle = '#e9b400';
  x.fillRect(0, 0, 128, 128);
  x.fillStyle = 'rgba(0,0,0,0.25)';
  x.fillRect(0, 126, 128, 2);
  x.fillRect(126, 0, 2, 128);
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 5; j++) {
      const cx = 13 + i * 25.5;
      const cy = 13 + j * 25.5;
      x.fillStyle = 'rgba(120,80,0,0.45)';
      x.beginPath();
      x.arc(cx + 1.5, cy + 1.5, 7.5, 0, Math.PI * 2);
      x.fill();
      x.fillStyle = '#ffd23a';
      x.beginPath();
      x.arc(cx, cy, 7, 0, Math.PI * 2);
      x.fill();
    }
  }
  return texture(c);
}

/**
 * Wall panels: 1.2 m enamel panels with seams, a stainless skirting and a top trim. U repeats
 * every WALL_M metres, V spans the full wall height (0 = floor).
 */
export function wallTexture(): THREE.CanvasTexture | null {
  const k = canvas(512, 256);
  if (!k) return null;
  const { c, x } = k;
  const r = rng(53);
  const g = x.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, '#f2f1ed');
  g.addColorStop(1, '#e2e0da');
  x.fillStyle = g;
  x.fillRect(0, 0, 512, 256);
  speckle(x, 512, 256, 900, r, ['rgba(0,0,0,0.04)', 'rgba(255,255,255,0.3)'], [1, 3]);
  x.fillStyle = 'rgba(120,120,115,0.55)';
  for (const px of [0, 256]) x.fillRect(px, 0, 3, 256);
  x.fillRect(0, 92, 512, 2);
  // Skirting (bottom) and ceiling trim (top): canvas y grows downwards, V = 1 at the top.
  x.fillStyle = '#6a6e72';
  x.fillRect(0, 238, 512, 18);
  x.fillStyle = 'rgba(255,255,255,0.35)';
  x.fillRect(0, 238, 512, 2);
  x.fillStyle = '#c9c7c1';
  x.fillRect(0, 0, 512, 7);
  const t = texture(c);
  t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/** System ceiling: 60 cm boards with perforations and T-bars. */
export function ceilingTexture(): THREE.CanvasTexture | null {
  const k = canvas(512, 512);
  if (!k) return null;
  const { c, x } = k;
  const r = rng(61);
  x.fillStyle = '#ecebe6';
  x.fillRect(0, 0, 512, 512);
  speckle(x, 512, 512, 7000, r, ['rgba(0,0,0,0.12)', 'rgba(0,0,0,0.06)'], [1, 1.6]);
  x.fillStyle = '#b9b8b2';
  const s = 512 / 4;
  for (let i = 0; i <= 4; i++) {
    x.fillRect(i * s - 2, 0, 4, 512);
    x.fillRect(0, i * s - 2, 512, 4);
  }
  return texture(c);
}

/**
 * Stair atlas (no repeat): the top half is the tread with anti-slip grooves and a contrasting
 * nosing strip at V = 1 (front edge), the next quarter the riser, the bottom quarter concrete.
 */
export function stairTexture(): THREE.CanvasTexture | null {
  const k = canvas(256, 256);
  if (!k) return null;
  const { c, x } = k;
  const r = rng(71);
  // Tread (canvas y 0…128)
  x.fillStyle = '#a7a39b';
  x.fillRect(0, 0, 256, 128);
  speckle(x, 256, 128, 900, r, ['rgba(0,0,0,0.12)', 'rgba(255,255,255,0.2)'], [1, 2]);
  x.fillStyle = '#e0a100';
  x.fillRect(0, 0, 256, 18);
  x.fillStyle = 'rgba(0,0,0,0.35)';
  for (let yy = 3; yy < 18; yy += 5) x.fillRect(0, yy, 256, 1.5);
  // Riser (128…192)
  x.fillStyle = '#c2beb6';
  x.fillRect(0, 128, 256, 64);
  x.fillStyle = 'rgba(0,0,0,0.18)';
  x.fillRect(0, 128, 256, 3);
  // Concrete (192…256)
  x.fillStyle = '#8f8c86';
  x.fillRect(0, 192, 256, 64);
  speckle(x, 256, 64, 500, r, ['rgba(0,0,0,0.15)'], [1, 2]);
  return texture(c, false);
}

/** Escalator tread: grooved aluminium cleats with yellow demarcation; V repeats per step. */
export function escalatorTexture(): THREE.CanvasTexture | null {
  const k = canvas(128, 128);
  if (!k) return null;
  const { c, x } = k;
  x.fillStyle = '#3a3d41';
  x.fillRect(0, 0, 128, 128);
  for (let i = 10; i < 118; i += 4) {
    x.fillStyle = '#8b9096';
    x.fillRect(i, 0, 2, 128);
  }
  x.fillStyle = '#f2c200';
  x.fillRect(0, 0, 9, 128);
  x.fillRect(119, 0, 9, 128);
  x.fillRect(0, 0, 128, 7);
  x.fillStyle = '#15171a';
  x.fillRect(0, 124, 128, 4);
  return texture(c);
}

interface ShopStyle {
  name: string;
  sub: string;
  band: string;
  ink: string;
  interior: [string, string];
  goods: 'shelves' | 'counter' | 'racks' | 'cases';
  awning?: string;
}

const SHOPS: ShopStyle[] = [
  { name: 'カフェ', sub: 'CAFE', band: '#2f5d3a', ink: '#f4efe2', interior: ['#fff0d2', '#e9c58f'], goods: 'counter', awning: '#2f5d3a' },
  { name: 'ベーカリー', sub: 'BAKERY', band: '#f3e6cc', ink: '#6a3b17', interior: ['#fff3da', '#f1cf94'], goods: 'cases' },
  { name: 'ドラッグ', sub: 'DRUG STORE', band: '#d7262e', ink: '#ffffff', interior: ['#ffffff', '#e8eef2'], goods: 'shelves' },
  { name: '書店', sub: 'BOOKS', band: '#1f3552', ink: '#ffffff', interior: ['#fff6e6', '#ecd8b2'], goods: 'shelves' },
  { name: 'たこ焼', sub: 'TAKOYAKI', band: '#f0b400', ink: '#3a1f00', interior: ['#fff2d0', '#f2c77a'], goods: 'counter', awning: '#c7372f' },
  { name: 'シューズ', sub: 'SHOES', band: '#222222', ink: '#ffffff', interior: ['#fbfbfb', '#dedede'], goods: 'racks' },
  { name: '洋菓子', sub: 'PATISSERIE', band: '#f6d3dc', ink: '#7a2f45', interior: ['#fff5f2', '#f6d9cf'], goods: 'cases', awning: '#e7a3b5' },
  { name: 'コンビニ', sub: 'STORE 24', band: '#1d7fc4', ink: '#ffffff', interior: ['#ffffff', '#eef3f6'], goods: 'shelves' },
  { name: 'めがね', sub: 'OPTICAL', band: '#e9e9e4', ink: '#1d2a38', interior: ['#ffffff', '#e9e6df'], goods: 'racks' },
  { name: '和菓子', sub: 'WAGASHI', band: '#5b3a29', ink: '#f7ecd9', interior: ['#fff3dc', '#e8cf9f'], goods: 'cases', awning: '#3b2a20' },
  { name: '洋食', sub: 'RESTAURANT', band: '#8a1f24', ink: '#f7e9c8', interior: ['#ffe8c2', '#e0a860'], goods: 'counter', awning: '#8a1f24' },
  { name: '雑貨', sub: 'GOODS', band: '#e8742a', ink: '#ffffff', interior: ['#fffaf0', '#f0e2c8'], goods: 'shelves' },
];

const ADS: { text: string; sub: string; a: string; b: string; ink: string }[] = [
  { text: '夏のバーゲン', sub: 'SUMMER SALE', a: '#ff7a3d', b: '#ffcf3d', ink: '#ffffff' },
  { text: 'NEW OPEN', sub: '梅田に新しいお店', a: '#2e7bd6', b: '#6fd0e6', ink: '#ffffff' },
  { text: '旅に出よう', sub: 'TRAVEL', a: '#1e8a5a', b: '#bfe38a', ink: '#ffffff' },
];

function fitText(x: Ctx, text: string, max: number, px: number, weight = 'bold'): void {
  let s = px;
  x.font = `${weight} ${s}px "Hiragino Sans","Noto Sans JP","Yu Gothic","Meiryo","IPAGothic",sans-serif`;
  while (x.measureText(text).width > max && s > 10) {
    s -= 2;
    x.font = `${weight} ${s}px "Hiragino Sans","Noto Sans JP","Yu Gothic","Meiryo","IPAGothic",sans-serif`;
  }
}

function drawShop(x: Ctx, s: ShopStyle, w: number, h: number, r: () => number): void {
  // Pilasters and bulkhead.
  x.fillStyle = '#d9d4ca';
  x.fillRect(0, 0, w, h);
  const band = Math.round(h * 0.22);
  x.fillStyle = s.band;
  x.fillRect(10, 6, w - 20, band);
  x.fillStyle = s.ink;
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  fitText(x, s.name, w * 0.55, band * 0.62);
  x.fillText(s.name, w / 2 - 36, 6 + band * 0.5);
  fitText(x, s.sub, w * 0.3, band * 0.3, '600');
  x.fillText(s.sub, w - 90, 6 + band * 0.55);
  let top = band + 8;
  if (s.awning) {
    x.fillStyle = s.awning;
    x.fillRect(8, top, w - 16, 16);
    x.fillStyle = 'rgba(255,255,255,0.35)';
    for (let i = 8; i < w - 16; i += 28) x.fillRect(i, top, 14, 16);
    top += 18;
  }
  // Warm lit interior.
  const g = x.createLinearGradient(0, top, 0, h);
  g.addColorStop(0, s.interior[0]);
  g.addColorStop(1, s.interior[1]);
  x.fillStyle = g;
  x.fillRect(12, top, w - 24, h - top - 6);
  const ih = h - top - 6;
  const palette = ['#d9483b', '#3b7dd9', '#e3b43a', '#4aa36b', '#8b5bd6', '#f08a5d', '#2c2c2c', '#ffffff'];
  if (s.goods === 'shelves' || s.goods === 'racks') {
    for (let row = 0; row < 3; row++) {
      const yy = top + 10 + row * (ih / 3.2);
      x.fillStyle = 'rgba(90,80,70,0.55)';
      x.fillRect(20, yy + ih / 3.2 - 12, w - 40, 3);
      for (let px = 24; px < w - 30; px += 7 + r() * 9) {
        const bh = 10 + r() * (ih / 3.2 - 26);
        x.fillStyle = palette[Math.floor(r() * palette.length)];
        x.globalAlpha = s.goods === 'racks' ? 0.7 : 0.85;
        x.fillRect(px, yy + ih / 3.2 - 12 - bh, s.goods === 'racks' ? 5 : 6 + r() * 4, bh);
        x.globalAlpha = 1;
      }
    }
  } else if (s.goods === 'cases') {
    x.fillStyle = 'rgba(255,255,255,0.7)';
    x.fillRect(24, top + ih * 0.52, w - 48, ih * 0.38);
    for (let px = 30; px < w - 40; px += 16 + r() * 10) {
      x.fillStyle = palette[Math.floor(r() * 6)];
      x.beginPath();
      x.arc(px, top + ih * 0.62, 5 + r() * 3, 0, Math.PI * 2);
      x.fill();
    }
    x.fillStyle = 'rgba(80,60,40,0.35)';
    x.fillRect(24, top + ih * 0.9, w - 48, 6);
  } else {
    // Counter with pendant lamps.
    x.fillStyle = 'rgba(90,60,40,0.75)';
    x.fillRect(30, top + ih * 0.58, w * 0.55, ih * 0.3);
    for (let i = 0; i < 4; i++) {
      const lx = 60 + i * ((w - 120) / 3);
      x.fillStyle = 'rgba(60,40,20,0.7)';
      x.fillRect(lx - 1, top, 2, ih * 0.25);
      x.fillStyle = '#fff4c8';
      x.beginPath();
      x.arc(lx, top + ih * 0.28, 9, 0, Math.PI * 2);
      x.fill();
    }
    x.fillStyle = 'rgba(40,40,40,0.5)';
    x.fillRect(w * 0.7, top + ih * 0.2, w * 0.18, ih * 0.3);
  }
  // Glass mullions, door and reflections.
  x.fillStyle = 'rgba(60,62,66,0.9)';
  const bays = 3 + Math.floor(r() * 2);
  for (let i = 0; i <= bays; i++) x.fillRect(12 + (i * (w - 28)) / bays, top, 4, ih);
  x.fillRect(12, h - 12, w - 24, 6);
  const door = Math.floor(r() * bays);
  x.fillStyle = 'rgba(255,255,255,0.35)';
  x.fillRect(16 + (door * (w - 28)) / bays, top + 4, (w - 28) / bays - 4, ih - 10);
  x.fillStyle = 'rgba(255,255,255,0.18)';
  x.beginPath();
  x.moveTo(w * 0.15, top);
  x.lineTo(w * 0.3, top);
  x.lineTo(w * 0.12, h - 8);
  x.lineTo(w * 0.02, h - 8);
  x.fill();
}

function drawAd(x: Ctx, a: (typeof ADS)[number], w: number, h: number): void {
  x.fillStyle = '#3a3d42';
  x.fillRect(0, 0, w, h);
  const g = x.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, a.a);
  g.addColorStop(1, a.b);
  x.fillStyle = g;
  x.fillRect(10, 10, w - 20, h - 20);
  x.fillStyle = 'rgba(255,255,255,0.25)';
  x.beginPath();
  x.arc(w * 0.82, h * 0.35, h * 0.28, 0, Math.PI * 2);
  x.fill();
  x.fillStyle = a.ink;
  x.textAlign = 'left';
  x.textBaseline = 'middle';
  fitText(x, a.text, w * 0.7, 58);
  x.fillText(a.text, 34, h * 0.45);
  fitText(x, a.sub, w * 0.6, 24, '600');
  x.fillText(a.sub, 36, h * 0.72);
}

function drawDoors(x: Ctx, w: number, h: number): void {
  x.fillStyle = '#cfcac0';
  x.fillRect(0, 0, w, h);
  x.fillStyle = '#4b5057';
  x.fillRect(w * 0.12, h * 0.12, w * 0.76, h * 0.88);
  const g = x.createLinearGradient(0, h * 0.2, 0, h);
  g.addColorStop(0, '#fff3dc');
  g.addColorStop(1, '#e8d2aa');
  x.fillStyle = g;
  x.fillRect(w * 0.14, h * 0.2, w * 0.72, h * 0.78);
  x.fillStyle = '#4b5057';
  x.fillRect(w * 0.5 - 3, h * 0.2, 6, h * 0.8);
  x.fillStyle = 'rgba(255,255,255,0.3)';
  x.fillRect(w * 0.2, h * 0.24, w * 0.08, h * 0.7);
  x.fillRect(w * 0.56, h * 0.24, w * 0.08, h * 0.7);
  x.fillStyle = '#1b1d20';
  x.fillRect(w * 0.3, h * 0.02, w * 0.4, h * 0.09);
  x.fillStyle = '#ffffff';
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  fitText(x, '入口 ENTRANCE', w * 0.36, 20);
  x.fillText('入口 ENTRANCE', w / 2, h * 0.065);
}

/** Shopfronts, adverts and entrance doors in one 4×4 atlas (512×256 cells). */
export function shopAtlas(): THREE.CanvasTexture | null {
  const cw = 512;
  const ch = 256;
  const k = canvas(cw * SHOP_COLS, ch * SHOP_ROWS);
  if (!k) return null;
  const { c, x } = k;
  const r = rng(97);
  for (let i = 0; i < SHOP_COLS * SHOP_ROWS; i++) {
    x.save();
    x.translate((i % SHOP_COLS) * cw, Math.floor(i / SHOP_COLS) * ch);
    x.beginPath();
    x.rect(0, 0, cw, ch);
    x.clip();
    if (i < SHOP_CELLS) drawShop(x, SHOPS[i], cw, ch, r);
    else if (i === DOOR_CELL) drawDoors(x, cw, ch);
    else drawAd(x, ADS[i - SHOP_CELLS], cw, ch);
    x.restore();
  }
  return texture(c, false);
}

/** UV rectangle [u0, v0, u1, v1] of an atlas cell (row 0 at the top of the canvas). */
export function cellUV(cell: number, cols: number, rows: number, inset = 0.002): [number, number, number, number] {
  const col = cell % cols;
  const row = Math.floor(cell / cols);
  return [col / cols + inset, 1 - (row + 1) / rows + inset, (col + 1) / cols - inset, 1 - row / rows - inset];
}

export interface SignEntry {
  /** -1 left, 0 ahead, 1 right, 2 behind, null = no arrow. */
  arrow: -1 | 0 | 1 | 2 | null;
  /** Badge text and colour (station badge, or 出口 in yellow). */
  badge: string;
  badgeColor: string;
  badgeInk: string;
  text: string;
}

function drawArrow(x: Ctx, cx: number, cy: number, s: number, dir: -1 | 0 | 1 | 2): void {
  x.save();
  x.translate(cx, cy);
  x.rotate(dir === 0 ? 0 : dir === 2 ? Math.PI : (dir * Math.PI) / 2);
  x.fillStyle = '#ffffff';
  x.beginPath();
  x.moveTo(0, -s);
  x.lineTo(s * 0.8, -s * 0.1);
  x.lineTo(s * 0.28, -s * 0.1);
  x.lineTo(s * 0.28, s);
  x.lineTo(-s * 0.28, s);
  x.lineTo(-s * 0.28, -s * 0.1);
  x.lineTo(-s * 0.8, -s * 0.1);
  x.closePath();
  x.fill();
  x.restore();
}

/** One sign face per cell (SIGN_W×SIGN_H): black panel, white arrows and text, colour badges. */
export function signAtlas(faces: SignEntry[][]): { tex: THREE.CanvasTexture; rows: number } | null {
  const rows = Math.max(1, Math.ceil(faces.length / SIGN_COLS));
  const k = canvas(SIGN_W * SIGN_COLS, SIGN_H * rows);
  if (!k) return null;
  const { c, x } = k;
  x.fillStyle = '#17191c';
  x.fillRect(0, 0, c.width, c.height);
  faces.forEach((entries, i) => {
    x.save();
    x.translate((i % SIGN_COLS) * SIGN_W, Math.floor(i / SIGN_COLS) * SIGN_H);
    x.fillStyle = '#6b7178';
    x.fillRect(0, 0, SIGN_W, 3);
    x.fillRect(0, SIGN_H - 3, SIGN_W, 3);
    const slot = SIGN_W / Math.max(1, entries.length);
    entries.forEach((e, j) => {
      let px = j * slot + 12;
      const cy = SIGN_H / 2;
      if (j > 0) {
        x.fillStyle = '#5a6068';
        x.fillRect(j * slot - 1, 10, 2, SIGN_H - 20);
      }
      if (e.arrow !== null) {
        drawArrow(x, px + 13, cy, 14, e.arrow);
        px += 34;
      }
      x.font = 'bold 20px "Hiragino Sans","Noto Sans JP","Yu Gothic","Meiryo","IPAGothic",sans-serif';
      const bw = Math.max(34, x.measureText(e.badge).width + 14);
      x.fillStyle = e.badgeColor;
      x.beginPath();
      x.roundRect(px, cy - 16, bw, 32, 5);
      x.fill();
      x.fillStyle = e.badgeInk;
      x.textAlign = 'center';
      x.textBaseline = 'middle';
      x.fillText(e.badge, px + bw / 2, cy + 1);
      px += bw + 8;
      x.fillStyle = '#ffffff';
      x.textAlign = 'left';
      fitText(x, e.text, (j + 1) * slot - px - 8, 26);
      x.fillText(e.text, px, cy + 1);
    });
    x.restore();
  });
  return { tex: texture(c, false), rows };
}
