import { describe, expect, it } from 'vitest';
import { aspect, justify } from '../src/ui/justify.ts';

describe('justify', () => {
  it('fills full rows exactly and keeps the last row at the target height', () => {
    const items = [1.5, 0.75, 1.5, 1.33, 0.75, 1.78, 1.5, 1].map((ar, i) => ({ id: String(i), ar }));
    const rows = justify(items, 1000, 170, 6);
    for (const r of rows.slice(0, -1)) {
      const used = r.items.reduce((s, it) => s + it.w, 0) + 6 * (r.items.length - 1);
      expect(used).toBeCloseTo(1000, 6);
      expect(r.height).toBeLessThanOrEqual(170);
    }
    expect(rows.at(-1)!.height).toBeLessThanOrEqual(170);
    expect(rows.flatMap((r) => r.items.map((i) => i.id))).toEqual(items.map((i) => i.id));
    expect(rows[1]!.top).toBeCloseTo(rows[0]!.height + 6);
  });
  it('clamps extreme or missing dimensions', () => {
    expect(aspect(10000, 10)).toBe(3);
    expect(aspect(10, 10000)).toBe(0.4);
    expect(aspect(null, 10)).toBeCloseTo(4 / 3);
  });
});
