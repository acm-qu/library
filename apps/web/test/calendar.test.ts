import { describe, expect, it } from 'vitest';
import { addDays, addMonths, clampDay, firstWeekday, monthGrid, today, weekStart } from '../src/ui/calendar.ts';

describe('calendar', () => {
  it('moves by days and months across month, year and leap boundaries', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonths('2026-01-15', -1)).toBe('2025-12-15');
    expect(addMonths('2026-03-31', -13)).toBe('2025-02-28');
  });
  it('builds a 6-week grid from the locale week start', () => {
    // 1 Oct 2026 is a Thursday.
    const sun = monthGrid('2026-10-17', 0);
    expect(sun).toHaveLength(42);
    expect(sun[0]).toBe('2026-09-27');
    expect(sun[41]).toBe('2026-11-07');
    expect(monthGrid('2026-10-17', 1)[0]).toBe('2026-09-28');
    expect(monthGrid('2026-10-17', 6)[0]).toBe('2026-09-26');
    // A month starting on the week start begins the grid on the 1st.
    expect(monthGrid('2026-02-10', 0)[0]).toBe('2026-02-01');
    expect(weekStart('2026-10-17', 1)).toBe('2026-10-12');
    expect(weekStart('2026-10-12', 1)).toBe('2026-10-12');
  });
  it('clamps to [min, max] and reads the first weekday', () => {
    expect(clampDay('2026-01-01', '2026-02-01')).toBe('2026-02-01');
    expect(clampDay('2026-05-01', undefined, '2026-04-30')).toBe('2026-04-30');
    expect(clampDay('2026-03-01', '2026-02-01', '2026-04-30')).toBe('2026-03-01');
    expect(clampDay('2026-03-01', '', '')).toBe('2026-03-01');
    expect(firstWeekday('en-US')).toBe(0);
    const hasWeekInfo = 'getWeekInfo' in Intl.Locale.prototype || 'weekInfo' in Intl.Locale.prototype;
    expect(firstWeekday('en-GB')).toBe(hasWeekInfo ? 1 : 0);
    expect(firstWeekday('not a locale')).toBe(0);
  });
  it("formats today's local date from its parts", () => {
    expect(today(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });
});
