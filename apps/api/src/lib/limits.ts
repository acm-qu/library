// Named rate limits. @fastify/rate-limit runs only one route limiter per request, so the auth limits are
// checked explicitly with createRateLimit (sharing the plugin's in-memory store; keys are namespaced).
// The store is per process, which is why Passenger is pinned to one instance.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { HttpError } from './errors.ts';
import { HOUR, MINUTE } from './time.ts';

type Check = (req: FastifyRequest) => Promise<{ isAllowed: boolean; isExceeded: boolean; ttlInSeconds: number }>;

export const LIMITS = {
  global: { max: 600, timeWindow: MINUTE },
  requestCodeEmail: { max: 3, timeWindow: 15 * MINUTE },
  requestCodeIp: { max: 10, timeWindow: HOUR },
  verifyIp: { max: 20, timeWindow: 15 * MINUTE },
} as const;

export function makeLimiter(app: FastifyInstance, name: keyof typeof LIMITS, key: (req: FastifyRequest) => string) {
  const check = (app as unknown as { createRateLimit(o: object): Check }).createRateLimit({
    ...LIMITS[name],
    keyGenerator: (req: FastifyRequest) => `${name}:${key(req)}`,
  });
  return async (req: FastifyRequest) => {
    const r = await check(req);
    if (!r.isAllowed && r.isExceeded) throw new HttpError('rate_limited', { retry_after: r.ttlInSeconds }, `Try again in ${Math.ceil(r.ttlInSeconds / 60)} minutes.`);
  };
}
