// Locale-aware formatting. Everything user-visible that is a date, number, size or duration goes through here.
import i18n from './index.ts';

export const loc = () => (i18n.language === 'en' ? 'en-GB' : i18n.language); // "17 Oct 2026"

/** One part of a 'YYYY-MM-DD' day ("October 2026", "Mo", "17"), read in UTC so the day never shifts. */
export const fmtDayPart = (iso: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(loc(), { ...o, timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));

export const fmtDate = (iso: string | Date) =>
  new Intl.DateTimeFormat(loc(), { day: 'numeric', month: 'short', year: 'numeric', timeZone: typeof iso === 'string' && iso.length === 10 ? 'UTC' : undefined }).format(
    typeof iso === 'string' ? new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso) : iso,
  );

export const fmtDateTime = (iso: string) =>
  new Intl.DateTimeFormat(loc(), { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

export const fmtTime = (d: Date) => new Intl.DateTimeFormat(loc(), { hour: '2-digit', minute: '2-digit' }).format(d);

/** "1:06", "22:15", "1:02:03". */
export function fmtDuration(seconds: number) {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function fmtBytes(n: number) {
  const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const;
  let i = 0;
  let v = n;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return new Intl.NumberFormat(loc(), { style: 'unit', unit: units[i], unitDisplay: 'short', maximumFractionDigits: v < 10 && i > 0 ? 1 : 0 }).format(v);
}

/** Clock time when something `inS` seconds from now will be ready. */
export const readyAt = (inS: number) => fmtTime(new Date(Date.now() + inS * 1000));
