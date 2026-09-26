import * as THREE from 'three';
import { rng, type FacadeStyle } from './city-layout';

/**
 * Procedural canvas textures for the city (facades by day and by night, asphalt, paving,
 * lamp light pools). Created lazily: nothing touches `document` until a texture is requested,
 * and without a DOM (vitest) every factory returns null so callers fall back to plain colours.
 */

export const canPaint = (): boolean => typeof document !== 'undefined' && typeof document.createElement === 'function';

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] | null {
  if (!canPaint()) return null;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  return ctx ? [c, ctx] : null;
}

function toTexture(c: HTMLCanvasElement, srgb = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/** Facade tile geometry: bays × floors per texture repeat, and their size in metres. */
export const FACADE_TILE: Record<FacadeStyle, { bays: number; floors: number; bay: number; floor: number }> = {
  curtain: { bays: 8, floors: 8, bay: 3.2, floor: 4.2 },
  grid: { bays: 8, floors: 8, bay: 3.6, floor: 3.9 },
  band: { bays: 4, floors: 8, bay: 7.2, floor: 4.6 },
  stone: { bays: 4, floors: 8, bay: 7.5, floor: 5.2 },
};

const S = 512;

/**
 * Day (albedo) and night (emissive) textures of one facade style. Glass is painted as a
 * sky reflection that brightens towards the top of each pane with per-pane variation, so a
 * curtain wall reads as glass without an environment map; the night map lights a random
 * subset of windows in warm and cool office colours.
 */
export function facadeTextures(style: FacadeStyle, seed = 7): { day: THREE.CanvasTexture; night: THREE.CanvasTexture } | null {
  const a = canvas(S, S);
  const b = canvas(S, S);
  if (!a || !b) return null;
  const [dc, d] = a;
  const [nc, n] = b;
  const r = rng(seed + style.length * 101);
  const { bays, floors } = FACADE_TILE[style];
  const cw = S / bays;
  const ch = S / floors;
  n.fillStyle = '#040608';
  n.fillRect(0, 0, S, S);

  // Low-frequency "cloud" reflection field shared by all panes.
  const cloud = (x: number, y: number) =>
    0.5 + 0.25 * Math.sin(x * 0.013 + y * 0.004 + seed) + 0.25 * Math.sin(x * 0.004 - y * 0.011 + seed * 2);

  const glass = (x: number, y: number, w: number, h: number, base: [number, number, number], lift: number) => {
    const k = 0.85 + r() * 0.3;
    const cl = cloud(x + w / 2, y + h / 2);
    const g = d.createLinearGradient(0, y, 0, y + h);
    const top = base.map((c) => Math.min(255, (c + lift * cl) * k));
    const bot = base.map((c) => Math.min(255, c * 0.72 * k));
    g.addColorStop(0, `rgb(${top.join(',')})`);
    g.addColorStop(1, `rgb(${bot.join(',')})`);
    d.fillStyle = g;
    d.fillRect(x, y, w, h);
  };
  const lit = (x: number, y: number, w: number, h: number, p: number) => {
    if (r() > p) {
      // Dark office: faint blue from screens / emergency lights.
      n.fillStyle = r() < 0.3 ? '#0d1520' : '#06090d';
    } else {
      const warm = r() < 0.6;
      const v = 0.65 + r() * 0.35;
      n.fillStyle = warm ? `rgb(${255 * v},${214 * v},${150 * v})` : `rgb(${215 * v},${232 * v},${255 * v})`;
    }
    n.fillRect(x, y, w, h);
  };

  if (style === 'curtain') {
    d.fillStyle = '#c7cdd2';
    d.fillRect(0, 0, S, S);
    for (let f = 0; f < floors; f++) {
      const rowP = r() < 0.15 ? 0.1 : 0.62; // some floors empty after hours
      for (let i = 0; i < bays; i++) {
        const x = i * cw + 2;
        const y = f * ch + 7;
        glass(x, y, cw - 4, ch - 9, [118, 146, 170], 70);
        // Spandrel line (slab edge) behind the glass.
        d.fillStyle = 'rgba(40,52,64,0.55)';
        d.fillRect(x, f * ch + 1, cw - 4, 5);
        lit(x, y, cw - 4, ch - 9, rowP);
      }
    }
  } else if (style === 'grid') {
    d.fillStyle = '#d8d2c6';
    d.fillRect(0, 0, S, S);
    // Tile joints.
    d.fillStyle = 'rgba(0,0,0,0.05)';
    for (let y = 0; y < S; y += 8) d.fillRect(0, y, S, 1);
    for (let f = 0; f < floors; f++) {
      for (let i = 0; i < bays; i++) {
        const x = i * cw + cw * 0.18;
        const y = f * ch + ch * 0.22;
        const w = cw * 0.64;
        const h = ch * 0.52;
        d.fillStyle = 'rgba(0,0,0,0.18)';
        d.fillRect(x - 2, y - 2, w + 4, h + 5);
        glass(x, y, w, h, [70, 86, 100], 55);
        d.fillStyle = '#eee9df';
        d.fillRect(x - 3, y + h + 1, w + 6, 3); // sill
        d.fillStyle = 'rgba(30,30,30,0.35)';
        d.fillRect(x + w / 2 - 1, y, 2, h); // mullion
        lit(x, y, w, h, 0.5);
      }
    }
  } else if (style === 'band') {
    d.fillStyle = '#bfc5ca';
    d.fillRect(0, 0, S, S);
    for (let f = 0; f < floors; f++) {
      const y = f * ch + ch * 0.36;
      const h = ch * 0.6;
      for (let i = 0; i < bays * 4; i++) {
        glass((i * cw) / 4, y, cw / 4, h, [84, 104, 122], 60);
        lit((i * cw) / 4, y, cw / 4, h, 0.55);
      }
      // Mullions and the spandrel panel joints.
      d.fillStyle = 'rgba(40,46,52,0.6)';
      for (let x = 0; x < S; x += cw / 4) d.fillRect(x, y, 2, h);
      d.fillStyle = 'rgba(0,0,0,0.08)';
      d.fillRect(0, f * ch + ch * 0.18, S, 1);
    }
  } else {
    // Stone: department-store walls with vertical slots and a few recessed windows.
    d.fillStyle = '#d9d0c1';
    d.fillRect(0, 0, S, S);
    for (let y = 0; y < S; y += ch / 3) {
      d.fillStyle = 'rgba(0,0,0,0.07)';
      d.fillRect(0, y, S, 1);
    }
    for (let x = 0; x < S; x += cw / 2) {
      d.fillStyle = 'rgba(0,0,0,0.06)';
      d.fillRect(x, 0, 1, S);
    }
    for (let i = 0; i < bays; i++) {
      const x = i * cw + cw * 0.42;
      d.fillStyle = 'rgba(60,56,50,0.55)';
      d.fillRect(x, 0, cw * 0.16, S);
      for (let f = 0; f < floors; f++) {
        glass(x + 1, f * ch + 6, cw * 0.16 - 2, ch - 12, [70, 80, 90], 40);
        lit(x + 1, f * ch + 6, cw * 0.16 - 2, ch - 12, 0.7);
      }
    }
  }
  return { day: toTexture(dc), night: toTexture(nc) };
}

/** Asphalt: dark grey with aggregate speckle and faint tyre-worn streaks. */
export function asphaltTexture(): THREE.CanvasTexture | null {
  const cv = canvas(256, 256);
  if (!cv) return null;
  const [c, x] = cv;
  const r = rng(11);
  x.fillStyle = '#6a6e72';
  x.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 5000; i++) {
    const v = 70 + r() * 70;
    x.fillStyle = `rgba(${v},${v},${v + 4},${0.25 + r() * 0.4})`;
    x.fillRect(r() * 256, r() * 256, 1 + r() * 1.5, 1 + r() * 1.5);
  }
  for (let i = 0; i < 6; i++) {
    x.fillStyle = `rgba(20,20,24,${0.03 + r() * 0.04})`;
    x.fillRect(0, r() * 256, 256, 6 + r() * 20);
  }
  return toTexture(c);
}

/** Interlocking paving for sidewalks (30 × 15 cm blocks in two tones). */
export function pavingTexture(): THREE.CanvasTexture | null {
  const cv = canvas(256, 256);
  if (!cv) return null;
  const [c, x] = cv;
  const r = rng(23);
  x.fillStyle = '#b3aea6';
  x.fillRect(0, 0, 256, 256);
  const bw = 32;
  const bh = 16;
  for (let row = 0; row < 256 / bh; row++) {
    const off = (row % 2) * (bw / 2);
    for (let col = -1; col < 256 / bw + 1; col++) {
      const v = 196 + r() * 26 - (r() < 0.1 ? 22 : 0);
      x.fillStyle = `rgb(${v},${v - 4},${v - 10})`;
      x.fillRect(col * bw + off + 1, row * bh + 1, bw - 2, bh - 2);
    }
  }
  return toTexture(c);
}

/** Soft radial light pool (alpha) for street lamps at night. */
export function glowTexture(): THREE.CanvasTexture | null {
  const cv = canvas(128, 128);
  if (!cv) return null;
  const [c, x] = cv;
  const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,220,160,1)');
  g.addColorStop(0.4, 'rgba(255,200,130,0.45)');
  g.addColorStop(1, 'rgba(255,190,120,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 128, 128);
  const t = toTexture(c);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

export interface CityTextures {
  facade: Map<FacadeStyle, { day: THREE.CanvasTexture; night: THREE.CanvasTexture }>;
  asphalt: THREE.CanvasTexture | null;
  paving: THREE.CanvasTexture | null;
  glow: THREE.CanvasTexture | null;
}

let shared: CityTextures | null = null;
let users = 0;

/**
 * Shared, reference-counted texture set: rebuilding the city (theme, exaggeration or walk
 * mode changes) reuses the painted canvases instead of repainting them. Pair every call with
 * releaseCityTextures(); the last release disposes them.
 */
export function acquireCityTextures(): CityTextures {
  if (!shared) {
    const facade = new Map<FacadeStyle, { day: THREE.CanvasTexture; night: THREE.CanvasTexture }>();
    (['curtain', 'grid', 'band', 'stone'] as FacadeStyle[]).forEach((s, i) => {
      const t = facadeTextures(s, 3 + i * 17);
      if (t) facade.set(s, t);
    });
    shared = { facade, asphalt: asphaltTexture(), paving: pavingTexture(), glow: glowTexture() };
  }
  users++;
  return shared;
}

export function releaseCityTextures(): void {
  users = Math.max(0, users - 1);
  if (users > 0 || !shared) return;
  for (const t of shared.facade.values()) {
    t.day.dispose();
    t.night.dispose();
  }
  shared.asphalt?.dispose();
  shared.paving?.dispose();
  shared.glow?.dispose();
  shared = null;
}
