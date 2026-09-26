import * as THREE from 'three';

/**
 * Procedural surface textures, drawn on canvases the first time they are asked for (never at
 * import time, so node-side tests keep working) and cached until `disposeTextures()`.
 *
 * Most textures are *detail* maps: light, near-neutral images (mean luminance ≈ 0.85–0.95)
 * that the material colour or per-vertex colour tints. That way one floor-tile map serves both
 * the beige paid concourse and the grey free corridor. The facade maps carry their own colour.
 *
 * Every texture also records how many metres one repeat covers (`userData.metres`), which the
 * world-space (triplanar) mapping in look.ts uses to keep real-world scale.
 */

export type TextureId =
  | 'floorTile'
  | 'terrazzo'
  | 'tactileDots'
  | 'tactileBars'
  | 'asphalt'
  | 'pavers'
  | 'concrete'
  | 'brushedMetal'
  | 'escalatorTread'
  | 'facadeDay'
  | 'facadeNight';

/** Real-world size of one texture repeat [width, height] in metres. */
export const TEXTURE_METRES: Record<TextureId, [number, number]> = {
  floorTile: [2.4, 2.4], // 4×4 tiles of 60 cm
  terrazzo: [2, 2],
  tactileDots: [0.3, 0.3],
  tactileBars: [0.3, 0.3],
  asphalt: [4, 4],
  pavers: [1.2, 1.2],
  concrete: [3.6, 3.6],
  brushedMetal: [1, 1],
  escalatorTread: [0.4, 0.4],
  facadeDay: [12, 16], // 8 mullion bays of 1.5 m × 4 storeys of 4 m
  facadeNight: [12, 16],
};

const SIZE: Record<TextureId, number> = {
  floorTile: 512,
  terrazzo: 512,
  tactileDots: 128,
  tactileBars: 128,
  asphalt: 512,
  pavers: 512,
  concrete: 512,
  brushedMetal: 256,
  escalatorTread: 128,
  facadeDay: 512,
  facadeNight: 512,
};

/** Small deterministic PRNG so textures look the same on every load. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Ctx = CanvasRenderingContext2D;
type Painter = (ctx: Ctx, s: number, rnd: () => number) => void;

const grey = (v: number, a = 1) => {
  const c = Math.round(Math.max(0, Math.min(1, v)) * 255);
  return `rgba(${c},${c},${c},${a})`;
};

/** Fine per-pixel grain: adds ±amp brightness noise over the whole canvas. */
function grain(ctx: Ctx, s: number, rnd: () => number, amp: number): void {
  const img = ctx.getImageData(0, 0, s, s);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rnd() - 0.5) * 2 * amp * 255;
    d[i] += n;
    d[i + 1] += n;
    d[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
}

/** Soft blotches (for concrete / asphalt mottling). Wraps around the edges so it tiles. */
function blotches(ctx: Ctx, s: number, rnd: () => number, count: number, rMin: number, rMax: number, lum: [number, number], alpha: number): void {
  for (let i = 0; i < count; i++) {
    const x = rnd() * s;
    const y = rnd() * s;
    const r = rMin + rnd() * (rMax - rMin);
    const v = lum[0] + rnd() * (lum[1] - lum[0]);
    for (const ox of [-s, 0, s]) {
      for (const oy of [-s, 0, s]) {
        const cx = x + ox;
        const cy = y + oy;
        if (cx + r < 0 || cx - r > s || cy + r < 0 || cy - r > s) continue;
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
        g.addColorStop(0, grey(v, alpha));
        g.addColorStop(1, grey(v, 0));
        ctx.fillStyle = g;
        ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
      }
    }
  }
}

const painters: Record<TextureId, Painter> = {
  floorTile(ctx, s, rnd) {
    // 4×4 polished porcelain tiles, each with a slightly different shade, 2 px grout.
    const n = 4;
    const t = s / n;
    ctx.fillStyle = grey(0.62);
    ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const v = 0.84 + (rnd() - 0.5) * 0.06;
        ctx.fillStyle = grey(v);
        ctx.fillRect(i * t + 1.5, j * t + 1.5, t - 3, t - 3);
        // Faint polish sheen along one diagonal.
        const g = ctx.createLinearGradient(i * t, j * t, (i + 1) * t, (j + 1) * t);
        g.addColorStop(0, grey(1, 0.06));
        g.addColorStop(0.5, grey(1, 0));
        g.addColorStop(1, grey(0, 0.04));
        ctx.fillStyle = g;
        ctx.fillRect(i * t + 1.5, j * t + 1.5, t - 3, t - 3);
      }
    }
    // Speckle of the porcelain body.
    for (let k = 0; k < 2600; k++) {
      ctx.fillStyle = grey(rnd() < 0.5 ? 0.72 : 1, 0.35);
      ctx.fillRect(rnd() * s, rnd() * s, 1.2, 1.2);
    }
    grain(ctx, s, rnd, 0.015);
  },

  terrazzo(ctx, s, rnd) {
    ctx.fillStyle = grey(0.93);
    ctx.fillRect(0, 0, s, s);
    const chips = ['#6f6a64', '#2b2b2d', '#b9a88f', '#d9d2c6', '#8c8f93', '#c4b39a', '#ffffff'];
    for (let k = 0; k < 5200; k++) {
      const x = rnd() * s;
      const y = rnd() * s;
      const r = 0.6 + rnd() ** 3 * 4.5;
      ctx.fillStyle = chips[Math.floor(rnd() * chips.length)];
      ctx.globalAlpha = 0.55 + rnd() * 0.4;
      ctx.beginPath();
      // Irregular 5-gon chips read as crushed stone rather than dots.
      for (let v = 0; v < 5; v++) {
        const a = (v / 5) * Math.PI * 2 + rnd();
        const rr = r * (0.6 + rnd() * 0.5);
        const px = x + Math.cos(a) * rr;
        const py = y + Math.sin(a) * rr;
        if (v === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    // Brass divider strips every metre.
    ctx.fillStyle = 'rgba(176,150,96,0.8)';
    ctx.fillRect(0, 0, s, 1.5);
    ctx.fillRect(0, s / 2, s, 1.5);
    ctx.fillRect(0, 0, 1.5, s);
    ctx.fillRect(s / 2, 0, 1.5, s);
    grain(ctx, s, rnd, 0.012);
  },

  tactileDots(ctx, s, rnd) {
    // One 30 cm block with 5×5 truncated domes; lit from the upper left.
    ctx.fillStyle = grey(0.86);
    ctx.fillRect(0, 0, s, s);
    ctx.strokeStyle = grey(0.55);
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, s - 2, s - 2);
    const step = s / 5;
    const r = step * 0.3;
    for (let i = 0; i < 5; i++) {
      for (let j = 0; j < 5; j++) {
        const cx = (i + 0.5) * step;
        const cy = (j + 0.5) * step;
        ctx.fillStyle = grey(0.6);
        ctx.beginPath();
        ctx.arc(cx + 1.5, cy + 1.5, r, 0, Math.PI * 2);
        ctx.fill();
        const g = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.35, 0, cx, cy, r);
        g.addColorStop(0, grey(1));
        g.addColorStop(1, grey(0.84));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    grain(ctx, s, rnd, 0.02);
  },

  tactileBars(ctx, s, rnd) {
    // Directional block: 4 raised bars running along +v (the walking direction).
    ctx.fillStyle = grey(0.86);
    ctx.fillRect(0, 0, s, s);
    ctx.strokeStyle = grey(0.55);
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, s - 2, s - 2);
    const step = s / 4;
    const w = step * 0.36;
    for (let i = 0; i < 4; i++) {
      const cx = (i + 0.5) * step;
      ctx.fillStyle = grey(0.6);
      ctx.fillRect(cx - w / 2 + 1.5, s * 0.1 + 1.5, w, s * 0.8);
      const g = ctx.createLinearGradient(cx - w / 2, 0, cx + w / 2, 0);
      g.addColorStop(0, grey(1));
      g.addColorStop(1, grey(0.82));
      ctx.fillStyle = g;
      ctx.fillRect(cx - w / 2, s * 0.1, w, s * 0.8);
    }
    grain(ctx, s, rnd, 0.02);
  },

  asphalt(ctx, s, rnd) {
    ctx.fillStyle = grey(0.82);
    ctx.fillRect(0, 0, s, s);
    blotches(ctx, s, rnd, 60, 20, 90, [0.7, 0.95], 0.25);
    // Aggregate: dense light and dark specks.
    for (let k = 0; k < 16000; k++) {
      ctx.fillStyle = grey(rnd() < 0.55 ? 0.55 + rnd() * 0.15 : 0.95 + rnd() * 0.05, 0.6);
      const r = 0.5 + rnd() * 1.4;
      ctx.fillRect(rnd() * s, rnd() * s, r, r);
    }
    // A couple of sealed cracks.
    ctx.strokeStyle = grey(0.45, 0.5);
    ctx.lineWidth = 1.4;
    for (let c = 0; c < 3; c++) {
      let x = rnd() * s;
      let y = rnd() * s;
      ctx.beginPath();
      ctx.moveTo(x, y);
      for (let k = 0; k < 14; k++) {
        x += (rnd() - 0.5) * 30;
        y += (rnd() - 0.2) * 22;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    grain(ctx, s, rnd, 0.04);
  },

  pavers(ctx, s, rnd) {
    // Interlocking 20×10 cm pavers in a basket weave (pairs alternate direction) with sand joints.
    ctx.fillStyle = grey(0.66);
    ctx.fillRect(0, 0, s, s);
    const u = s / 12; // 10 cm
    const tints = [
      [0.95, 0.93, 0.9],
      [0.9, 0.88, 0.86],
      [0.98, 0.95, 0.9],
      [0.86, 0.86, 0.87],
      [0.96, 0.9, 0.86],
    ];
    const brick = (x: number, y: number, w: number, h: number) => {
      const t = tints[Math.floor(rnd() * tints.length)];
      const k = 0.94 + rnd() * 0.08;
      ctx.fillStyle = `rgb(${Math.round(t[0] * k * 255)},${Math.round(t[1] * k * 255)},${Math.round(t[2] * k * 255)})`;
      ctx.fillRect(x + 1, y + 1, w - 2, h - 2);
      // Chamfered edge: a lighter top-left, darker bottom-right.
      ctx.fillStyle = grey(1, 0.12);
      ctx.fillRect(x + 1, y + 1, w - 2, 1.5);
      ctx.fillStyle = grey(0, 0.1);
      ctx.fillRect(x + 1, y + h - 2.5, w - 2, 1.5);
    };
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 6; j++) {
        const x = i * 2 * u;
        const y = j * 2 * u;
        if ((i + j) % 2 === 0) {
          brick(x, y, 2 * u, u);
          brick(x, y + u, 2 * u, u);
        } else {
          brick(x, y, u, 2 * u);
          brick(x + u, y, u, 2 * u);
        }
      }
    }
    grain(ctx, s, rnd, 0.03);
  },

  concrete(ctx, s, rnd) {
    ctx.fillStyle = grey(0.88);
    ctx.fillRect(0, 0, s, s);
    blotches(ctx, s, rnd, 90, 10, 70, [0.75, 1], 0.22);
    for (let k = 0; k < 900; k++) {
      ctx.fillStyle = grey(0.55, 0.35);
      const r = 0.6 + rnd() * 1.5;
      ctx.beginPath();
      ctx.arc(rnd() * s, rnd() * s, r, 0, Math.PI * 2);
      ctx.fill();
    }
    // Formwork panel joints (1.8 × 0.9 m) and tie holes.
    ctx.strokeStyle = grey(0.62, 0.55);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(0.75, 0.75, s / 2 - 1.5, s / 4 - 1.5);
    for (let i = 0; i < 2; i++) for (let j = 0; j < 4; j++) ctx.strokeRect((i * s) / 2, (j * s) / 4, s / 2, s / 4);
    ctx.fillStyle = grey(0.5, 0.7);
    for (let i = 0; i < 2; i++) {
      for (let j = 0; j < 4; j++) {
        for (const [fx, fy] of [[0.2, 0.25], [0.8, 0.25], [0.2, 0.75], [0.8, 0.75]]) {
          ctx.beginPath();
          ctx.arc(((i + fx) * s) / 2, ((j + fy) * s) / 4, 2.2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    grain(ctx, s, rnd, 0.03);
  },

  brushedMetal(ctx, s, rnd) {
    ctx.fillStyle = grey(0.86);
    ctx.fillRect(0, 0, s, s);
    for (let k = 0; k < 1400; k++) {
      const y = rnd() * s;
      const len = s * (0.2 + rnd() * 0.8);
      const x = rnd() * s;
      ctx.fillStyle = grey(rnd() < 0.5 ? 0.74 : 1, 0.18);
      ctx.fillRect(x, y, len, 0.8);
      ctx.fillRect(x - s, y, len, 0.8);
    }
    grain(ctx, s, rnd, 0.01);
  },

  escalatorTread(ctx, s) {
    // Cleats along the direction of travel (v), with a comb-plate shadow line at each step edge.
    ctx.fillStyle = grey(0.5);
    ctx.fillRect(0, 0, s, s);
    const n = 16;
    for (let i = 0; i < n; i++) {
      const x = (i / n) * s;
      const g = ctx.createLinearGradient(x, 0, x + s / n, 0);
      g.addColorStop(0, grey(0.98));
      g.addColorStop(0.55, grey(0.84));
      g.addColorStop(0.56, grey(0.45));
      g.addColorStop(1, grey(0.5));
      ctx.fillStyle = g;
      ctx.fillRect(x, 0, s / n, s);
    }
    ctx.fillStyle = grey(0.25, 0.8);
    ctx.fillRect(0, s - 3, s, 3);
  },

  facadeDay(ctx, s, rnd) {
    // Curtain wall: 8 bays × 4 storeys. Each pane reflects a slightly different patch of sky.
    const bays = 8;
    const floors = 4;
    const bw = s / bays;
    const fh = s / floors;
    ctx.fillStyle = '#5f6d79';
    ctx.fillRect(0, 0, s, s);
    for (let f = 0; f < floors; f++) {
      for (let b = 0; b < bays; b++) {
        const x = b * bw;
        const y = f * fh;
        const tint = 0.9 + rnd() * 0.2;
        const g = ctx.createLinearGradient(x, y, x + bw * 0.4, y + fh);
        g.addColorStop(0, `rgb(${Math.round(178 * tint)},${Math.round(200 * tint)},${Math.round(214 * tint)})`);
        g.addColorStop(0.6, `rgb(${Math.round(120 * tint)},${Math.round(140 * tint)},${Math.round(160 * tint)})`);
        g.addColorStop(1, `rgb(${Math.round(92 * tint)},${Math.round(108 * tint)},${Math.round(126 * tint)})`);
        ctx.fillStyle = g;
        ctx.fillRect(x + 2, y + 2, bw - 4, fh * 0.78 - 2);
        // Opaque spandrel panel hiding the floor slab.
        ctx.fillStyle = '#46515b';
        ctx.fillRect(x + 2, y + fh * 0.78 + 1, bw - 4, fh * 0.22 - 3);
      }
    }
    // Mullions (vertical, deeper) and transoms.
    ctx.fillStyle = '#c9d0d6';
    for (let b = 0; b <= bays; b++) ctx.fillRect(b * bw - 2, 0, 4, s);
    for (let f = 0; f <= floors; f++) {
      ctx.fillRect(0, f * fh - 2, s, 4);
      ctx.fillRect(0, f * fh + fh * 0.78 - 1, s, 2);
    }
  },

  facadeNight(ctx, s, rnd) {
    // Emissive map: black frame, a random mix of warm / cool / dark offices, some with blinds.
    const bays = 8;
    const floors = 4;
    const bw = s / bays;
    const fh = s / floors;
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, s, s);
    for (let f = 0; f < floors; f++) {
      for (let b = 0; b < bays; b++) {
        const x = b * bw + 3;
        const y = f * fh + 3;
        const w = bw - 6;
        const h = fh * 0.78 - 4;
        const r = rnd();
        if (r < 0.3) continue; // unlit office
        const warm = r < 0.62;
        const k = 0.55 + rnd() * 0.45;
        const [cr, cg, cb] = warm ? [255, 214, 160] : [214, 230, 255];
        const g = ctx.createLinearGradient(0, y, 0, y + h);
        g.addColorStop(0, `rgb(${Math.round(cr * k)},${Math.round(cg * k)},${Math.round(cb * k)})`);
        g.addColorStop(1, `rgb(${Math.round(cr * k * 0.7)},${Math.round(cg * k * 0.7)},${Math.round(cb * k * 0.7)})`);
        ctx.fillStyle = g;
        // Half the lit windows have blinds partly drawn.
        const blind = rnd() < 0.5 ? h * (0.15 + rnd() * 0.5) : 0;
        ctx.fillRect(x, y + blind, w, h - blind);
        if (blind > 0) {
          ctx.fillStyle = `rgba(${cr},${cg},${cb},0.18)`;
          ctx.fillRect(x, y, w, blind);
        }
      }
    }
  },
};

const cache = new Map<TextureId, THREE.Texture>();
let anisotropy = 8;

/** True where a canvas can be created (browser); false under node / vitest. */
export function canPaint(): boolean {
  return typeof document !== 'undefined' && typeof document.createElement === 'function';
}

/** Sets the anisotropy used for new (and already created) textures. */
export function setTextureAnisotropy(a: number): void {
  anisotropy = Math.max(1, a);
  for (const t of cache.values()) {
    t.anisotropy = anisotropy;
    t.needsUpdate = true;
  }
}

/**
 * Returns the (cached) texture, painting it on first use. Returns null when no canvas is
 * available so callers can fall back to plain colours.
 */
export function getTexture(id: TextureId): THREE.Texture | null {
  const hit = cache.get(id);
  if (hit) return hit;
  if (!canPaint()) return null;
  const s = SIZE[id];
  const canvas = document.createElement('canvas');
  canvas.width = s;
  canvas.height = s;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  painters[id](ctx, s, mulberry32(hashId(id)));
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = anisotropy;
  tex.name = `look:${id}`;
  tex.userData.metres = TEXTURE_METRES[id];
  cache.set(id, tex);
  return tex;
}

/** Disposes every cached texture (they are re-painted on the next `getTexture`). */
export function disposeTextures(): void {
  for (const t of cache.values()) t.dispose();
  cache.clear();
}

function hashId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return h >>> 0;
}
