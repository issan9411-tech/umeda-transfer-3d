/** 6:05 style clock for seconds. */
export function mmss(s: number): string {
  if (!Number.isFinite(s)) return '—';
  const t = Math.max(0, Math.round(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

/** "6分05秒" / "45秒" */
export function jpDuration(s: number): string {
  if (!Number.isFinite(s)) return '—';
  const t = Math.max(0, Math.round(s));
  const m = Math.floor(t / 60);
  const r = t % 60;
  if (m === 0) return `${r}秒`;
  return r === 0 ? `${m}分` : `${m}分${String(r).padStart(2, '0')}秒`;
}

/** Rounded minutes like a timetable ("約6分"). */
export function minutes(s: number): string {
  if (!Number.isFinite(s)) return '—';
  return `${Math.max(1, Math.round(s / 60))}`;
}

export function hourLabel(h: number): string {
  const hh = Math.floor(h) % 24;
  const mm = Math.round((h - Math.floor(h)) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

export function meters(m: number): string {
  return `${Math.round(m).toLocaleString('ja-JP')}m`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

/** Relative luminance-based text colour for a background hex. */
export function readableOn(hex: string): string {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum > 0.6 ? '#111' : '#fff';
}
