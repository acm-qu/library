import { describe, expect, it } from 'vitest';
import { DEFAULT_RHO, jobCost, nextRho, queueEtas } from '../src/eta.ts';

describe('ETA', () => {
  it('prices jobs per the handoff formula', () => {
    expect(jobCost({ kind: 'image', hdr: null, durationS: null, progress: null }, DEFAULT_RHO)).toBe(3);
    expect(jobCost({ kind: 'video', hdr: 'sdr', durationS: 100, progress: null }, DEFAULT_RHO)).toBeCloseTo(60);
    expect(jobCost({ kind: 'video', hdr: 'hlg', durationS: 100, progress: null }, DEFAULT_RHO)).toBeCloseTo(180);
  });

  it('sums in claim order and discounts the running job by its progress', () => {
    const etas = queueEtas(
      [
        { kind: 'video', hdr: 'sdr', durationS: 100, progress: 0.5 }, // 30 left
        { kind: 'image', hdr: null, durationS: null, progress: null }, // +3
        { kind: 'video', hdr: 'pq', durationS: 10, progress: null }, // +72
      ],
      DEFAULT_RHO,
    );
    expect(etas.map((x) => Math.round(x))).toEqual([30, 33, 105]);
  });

  it('moves rho by an EMA with alpha 0.2 and ignores nonsense samples', () => {
    expect(nextRho(0.6, 100, 100)).toBeCloseTo(0.68);
    expect(nextRho(0.6, 100, 0)).toBe(0.6);
  });
});
