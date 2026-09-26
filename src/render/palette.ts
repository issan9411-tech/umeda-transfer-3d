import * as THREE from 'three';
import type { EdgeKind } from '../core/types';

/** Reads a CSS custom property from :root as a three.js colour. */
export function cssColor(name: string, fallback: string): THREE.Color {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  try {
    return new THREE.Color(v || fallback);
  } catch {
    return new THREE.Color(fallback);
  }
}

export interface ScenePalette {
  bg: THREE.Color;
  ground: THREE.Color;
  grid: THREE.Color;
  road: THREE.Color;
  building: THREE.Color;
  slab: THREE.Color;
  walk: THREE.Color;
  ink: THREE.Color;
  accent: THREE.Color;
  alt: THREE.Color;
  dark: boolean;
}

export function readPalette(): ScenePalette {
  return {
    bg: cssColor('--scene-bg', '#dfe5ea'),
    ground: cssColor('--scene-ground', '#e9edf0'),
    grid: cssColor('--scene-grid', '#c9d1d8'),
    road: cssColor('--scene-road', '#cfd6dc'),
    building: cssColor('--scene-building', '#b8c2cb'),
    slab: cssColor('--scene-slab', '#8fa1b2'),
    walk: cssColor('--scene-walk', '#5d6d7c'),
    ink: cssColor('--ink', '#111a22'),
    accent: cssColor('--accent', '#ffc400'),
    alt: cssColor('--scene-alt', '#6b7c8c'),
    dark: document.documentElement.dataset.theme === 'dark' ||
      (document.documentElement.dataset.theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches),
  };
}

/** Network edge colours by kind (kept constant across themes, chosen to read on both). */
export const KIND_COLORS: Record<EdgeKind, number> = {
  walk: 0x7a8a99,
  platform: 0x7a8a99,
  stairs: 0xe36c2f,
  escalator: 0x13a3a8,
  elevator: 0x2fa84f,
  gate: 0xf2b200,
  crossing: 0xd64f8a,
};

/** Green → amber → red ramp for crowd density (persons/m²). */
export function heatColor(rho: number, out = new THREE.Color()): THREE.Color {
  const t = Math.max(0, Math.min(1, rho / 2));
  if (t < 0.5) return out.setRGB(0.12 + t * 1.6, 0.66 - t * 0.1, 0.35 - t * 0.5);
  const u = (t - 0.5) * 2;
  return out.setRGB(0.92, 0.61 - u * 0.4, 0.1 + u * 0.12);
}
