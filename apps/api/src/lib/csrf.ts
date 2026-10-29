import type { FastifyInstance } from 'fastify';
import { HttpError } from './errors.ts';

export const CSRF_HEADER = 'x-requested-with';
export const CSRF_VALUE = 'acm-media';
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Every state-changing /api request must carry `X-Requested-With: acm-media`. Browsers can't add a custom header
 * cross-origin without a CORS preflight, which this API never grants, so a forged form post fails here.
 */
export function registerCsrf(app: FastifyInstance) {
  app.addHook('onRequest', async (req) => {
    if (SAFE.has(req.method) || !req.url.startsWith('/api/')) return;
    if (req.headers[CSRF_HEADER] !== CSRF_VALUE) throw new HttpError('csrf');
  });
}
