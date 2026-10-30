import i18n from '../i18n/index.ts';

/** "12 min" / "1 h 10 min" for an ETA in seconds. */
export function fmtEta(seconds: number) {
  if (!Number.isFinite(seconds)) return '—'; // never "Infinity h NaN min"
  const m = Math.max(1, Math.round(seconds / 60));
  return m < 60 ? i18n.t('upload.minutes', { n: m }) : i18n.t('upload.hoursMinutes', { h: Math.floor(m / 60), m: m % 60 });
}
