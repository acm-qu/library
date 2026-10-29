import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ServerConfig } from '@acm/core/config';
import type { Db } from '@acm/core/db';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { registerSessions } from './auth/plugin.ts';
import { registerCsrf } from './lib/csrf.ts';
import { HttpError, registerErrorHandling } from './lib/errors.ts';
import { LIMITS } from './lib/limits.ts';
import { createMailer, type Mailer } from './mail/mailer.ts';
import { adminRoutes } from './routes/admin.ts';
import { assetRoutes } from './routes/assets.ts';
import { authRoutes } from './routes/auth.ts';
import { eventRoutes } from './routes/events.ts';
import { healthRoutes } from './routes/health.ts';
import { mediaRoutes } from './routes/media.ts';
import { meRoutes } from './routes/me.ts';
import { uploadRoutes } from './routes/uploads.ts';

export type AppDeps = {
  cfg: ServerConfig;
  db: Db;
  mailer?: Mailer;
  logger?: FastifyServerOptions['logger'];
  /** Tests shorten the request-code timing floor. */
  requestCodeFloorMs?: number;
};

export const LOG_REDACT = [
  'req.headers.cookie',
  'req.headers.authorization',
  'res.headers["set-cookie"]',
  'req.body.code',
  'req.body.email',
  '*.fileKey',
  '*.hlsKey',
  '*.masterKey',
];

const CSP = {
  defaultSrc: ["'self'"],
  mediaSrc: ["'self'", 'blob:'],
  workerSrc: ["'self'", 'blob:'],
  imgSrc: ["'self'", 'blob:', 'data:'],
  fontSrc: ["'self'"],
  styleSrc: ["'self'"],
  scriptSrc: ["'self'"],
  connectSrc: ["'self'"],
  objectSrc: ["'none'"],
  frameAncestors: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"],
};

export async function buildApp(deps: AppDeps) {
  const { cfg, db } = deps;
  const app = Fastify({
    logger: deps.logger ?? { level: cfg.NODE_ENV === 'production' ? 'info' : 'debug', redact: LOG_REDACT },
    // Apache hands requests to Passenger over loopback; the client address is in X-Forwarded-For.
    trustProxy: '127.0.0.1',
    // Short ids like 7F3A-21C9: shown to users as "Reference" on server errors and greppable in the log.
    genReqId: () => randomBytes(4).toString('hex').toUpperCase().replace(/^(.{4})/, '$1-'),
    requestIdHeader: false,
    bodyLimit: 64 * 1024,
  });
  const mailer = deps.mailer ?? createMailer(cfg, app.log);

  registerErrorHandling(app);
  await app.register(helmet, {
    contentSecurityPolicy: { useDefaults: false, directives: CSP },
    referrerPolicy: { policy: 'same-origin' },
    // HSTS is turned on once AutoSSL is confirmed for library.qu.acm.org.
    strictTransportSecurity: false,
    crossOriginEmbedderPolicy: false,
  });
  await app.register(cookie);
  await app.register(rateLimit, {
    ...LIMITS.global,
    // Media byte ranges and 8 MiB upload PATCHes would exhaust a request budget; both are authenticated anyway.
    allowList: (req) => !req.url.startsWith('/api/') || req.url.startsWith('/api/media/') || req.url.startsWith('/api/uploads'),
    errorResponseBuilder: (_req, ctx) =>
      new HttpError('rate_limited', { retry_after: Math.ceil(ctx.ttl / 1000) }, `Try again in ${ctx.after}.`),
  });
  registerCsrf(app);
  registerSessions(app, db, cfg);

  authRoutes(app, { db, cfg, mailer, floorMs: deps.requestCodeFloorMs });
  meRoutes(app, { db });
  eventRoutes(app, { db });
  assetRoutes(app, { db });
  uploadRoutes(app, { db, cfg });
  mediaRoutes(app, { db, cfg });
  adminRoutes(app, { db, cfg });
  healthRoutes(app, { db, cfg });

  const web = cfg.WEB_ROOT && existsSync(cfg.WEB_ROOT) ? cfg.WEB_ROOT : null;
  if (web) await serveWeb(app, web);
  app.setNotFoundHandler((req, reply) => {
    // Page URLs (no file extension) get the SPA; a missing /assets/x.js must stay a 404, not HTML.
    const isPage = !req.url.startsWith('/api/') && !/\.[a-z0-9]+$/i.test(req.url.split('?')[0]!);
    if (web && (req.method === 'GET' || req.method === 'HEAD') && isPage) {
      return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
    }
    const e = new HttpError('not_found');
    return reply.code(e.status).send(e.body());
  });
  return app;
}

/** The built SPA: hashed assets are immutable; other non-API GETs get index.html (see the not-found handler). */
async function serveWeb(app: FastifyInstance, root: string) {
  await app.register(fastifyStatic, {
    root: path.resolve(root),
    setHeaders(reply, file) {
      reply.header('Cache-Control', file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  });
}
