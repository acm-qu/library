// Pure calendar math for DateInput. Days are 'YYYY-MM-DD' strings (what the forms store) and the arithmetic runs
// on UTC midnights built from the parts, so no local-timezone or DST shift can move a day.
const DAY = 86_400_000;

const utc = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export const addDays = (d: string, n: number) => iso(utc(d) + n * DAY);

/** Same day n months away, clamped to the target month's length (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(d: string, n: number) {
  const y = +d.slice(0, 4);
  const m = +d.slice(5, 7) - 1 + n;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return iso(Date.UTC(y, m, Math.min(+d.slice(8, 10), last)));
}

/** 0 = Sunday … 6 = Saturday, like getUTCDay. */
export const weekday = (d: string) => new Date(utc(d)).getUTCDay();

/** The first day of d's week, for a week that starts on `first`. */
export const weekStart = (d: string, first: number) => addDays(d, -((weekday(d) - first + 7) % 7));

/** 42 days (6 weeks × 7) covering d's month, starting on the week start on or before the 1st. */
export function monthGrid(d: string, first: number) {
  const start = weekStart(`${d.slice(0, 7)}-01`, first);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

/** ISO dates compare as strings, so clamping is two comparisons. */
export const clampDay = (d: string, min?: string, max?: string) => (min && d < min ? min : max && d > max ? max : d);

/** The locale's first day of the week (0 = Sunday), from Intl.Locale week info where the engine has it, else Sunday. */
export function firstWeekday(locale: string) {
  try {
    const l = new Intl.Locale(locale) as Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } };
    const first = (l.getWeekInfo?.() ?? l.weekInfo)?.firstDay;
    return first ? first % 7 : 0; // week info counts Monday 1 … Sunday 7
  } catch {
    return 0;
  }
}

/** Today in the viewer's own timezone. */
export const today = (now = new Date()) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
