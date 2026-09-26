import type { InstructionKind } from '../core/instructions';

const P = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';

/** Pictograms for instruction kinds (drawn after JIS Z8210 station pictograms, simplified). */
export const ICONS: Record<InstructionKind, string> = {
  start: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="6" ${P}/><circle cx="12" cy="12" r="2" fill="currentColor"/></svg>`,
  walk: `<svg viewBox="0 0 24 24"><circle cx="13" cy="4.5" r="1.8" fill="currentColor"/><path d="M11 21l2-6-3-3 1-4 3 2 3 1M10 12l-2 3-3 1M13 15l3 6" ${P}/></svg>`,
  stairs: `<svg viewBox="0 0 24 24"><path d="M3 20h5v-5h5v-5h5V5h3" ${P}/></svg>`,
  escalator: `<svg viewBox="0 0 24 24"><path d="M3 19h4l10-12h4" ${P}/><path d="M5 19l12-12" ${P} opacity=".35"/><circle cx="10" cy="8" r="1.6" fill="currentColor"/></svg>`,
  elevator: `<svg viewBox="0 0 24 24"><rect x="5" y="3" width="14" height="18" rx="2" ${P}/><path d="M9.5 9.5 12 7l2.5 2.5M9.5 14.5 12 17l2.5-2.5" ${P}/></svg>`,
  'gate-in': `<svg viewBox="0 0 24 24"><path d="M4 20V8M20 20V8M9 20v-6M15 20v-6M4 8h16" ${P}/><path d="M12 3v7m0 0-2.5-2.5M12 10l2.5-2.5" ${P}/></svg>`,
  'gate-out': `<svg viewBox="0 0 24 24"><path d="M4 20V8M20 20V8M9 20v-6M15 20v-6M4 8h16" ${P}/><path d="M12 10V3m0 0L9.5 5.5M12 3l2.5 2.5" ${P}/></svg>`,
  crossing: `<svg viewBox="0 0 24 24"><path d="M3 6h18M3 18h18" ${P}/><path d="M6 9v6M10 9v6M14 9v6M18 9v6" ${P}/></svg>`,
  arrive: `<svg viewBox="0 0 24 24"><path d="M6 21V4m0 0h11l-2 4 2 4H6" ${P}/></svg>`,
};

export const KIND_CSS: Record<InstructionKind, string> = {
  start: 'var(--from)',
  walk: 'var(--ink-3)',
  stairs: '#e36c2f',
  escalator: '#13a3a8',
  elevator: '#2fa84f',
  'gate-in': '#d9a000',
  'gate-out': '#d9a000',
  crossing: '#d64f8a',
  arrive: 'var(--to)',
};
