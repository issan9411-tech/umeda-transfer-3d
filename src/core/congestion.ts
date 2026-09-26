/**
 * Pedestrian congestion model.
 *
 * Demand follows a weekday profile with morning (8–9 h) and evening (17:30–19:30) peaks.
 * Walking speed under crowding follows Weidmann's fundamental diagram
 * v(ρ) = v0 · (1 − exp(−1.913 · (1/ρ − 1/ρmax))), ρmax = 5.4 persons/m².
 */

const RHO_MAX = 5.4;
const GAMMA = 1.913;

/** Hourly demand factor for a weekday, 0 … 1 (1 = heaviest commuter peak). */
const WEEKDAY: number[] = [
  0.05, 0.02, 0.01, 0.01, 0.02, 0.08, // 0–5
  0.25, 0.7, 1.0, 0.75, 0.45, 0.45, // 6–11
  0.55, 0.5, 0.45, 0.5, 0.6, 0.85, // 12–17
  0.95, 0.8, 0.6, 0.5, 0.4, 0.2, // 18–23
];

const HOLIDAY: number[] = [
  0.05, 0.02, 0.01, 0.01, 0.01, 0.03, // 0–5
  0.08, 0.15, 0.25, 0.4, 0.55, 0.7, // 6–11
  0.8, 0.85, 0.85, 0.85, 0.8, 0.75, // 12–17
  0.7, 0.6, 0.45, 0.35, 0.25, 0.12, // 18–23
];

export type DayType = 'weekday' | 'holiday';

/** Demand factor for a fractional hour (e.g. 8.5 = 8:30), linearly interpolated. */
export function demandAt(hour: number, day: DayType = 'weekday'): number {
  const table = day === 'weekday' ? WEEKDAY : HOLIDAY;
  const h = ((hour % 24) + 24) % 24;
  const i = Math.floor(h);
  const f = h - i;
  return table[i] * (1 - f) + table[(i + 1) % 24] * f;
}

/** Speed ratio v/v0 at density rho (persons/m²), clamped to [0.15, 1]. */
export function speedFactor(rho: number): number {
  if (rho <= 0.05) return 1;
  if (rho >= RHO_MAX) return 0.15;
  const f = 1 - Math.exp(-GAMMA * (1 / rho - 1 / RHO_MAX));
  return Math.min(1, Math.max(0.15, f));
}

/**
 * Expected density on a corridor with the given busy level (0–3) at a demand factor.
 * busy 3 at the heaviest peak gives ~1.2 p/m² (dense but free-moving, e.g. 阪急 3F concourse at 8:30),
 * which slows walkers to roughly two thirds of their free speed.
 */
export function densityFor(busy: number, demand: number): number {
  return 0.4 * busy * demand;
}

/** Human-readable congestion band for a density. */
export function densityBand(rho: number): { label: string; level: 0 | 1 | 2 | 3 } {
  if (rho < 0.3) return { label: '空いている', level: 0 };
  if (rho < 0.8) return { label: 'やや混雑', level: 1 };
  if (rho < 1.5) return { label: '混雑', level: 2 };
  return { label: '非常に混雑', level: 3 };
}
