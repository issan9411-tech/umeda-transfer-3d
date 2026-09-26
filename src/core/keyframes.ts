import type { Keyframe } from './planner';

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

/** Position on a keyframe track at time t (linear between keyframes, clamped at both ends). */
export function sampleKeyframes(kf: Keyframe[], t: number, out: Point3 = { x: 0, y: 0, z: 0 }): Point3 {
  const set = (x: number, y: number, z: number) => {
    out.x = x;
    out.y = y;
    out.z = z;
    return out;
  };
  if (kf.length === 0) return set(0, 0, 0);
  if (t <= kf[0].t) return set(kf[0].x, kf[0].y, kf[0].z);
  const last = kf[kf.length - 1];
  if (t >= last.t) return set(last.x, last.y, last.z);
  let lo = 0;
  let hi = kf.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (kf[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = kf[lo];
  const b = kf[hi];
  const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1;
  return set(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f, a.z + (b.z - a.z) * f);
}
