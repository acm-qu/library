// Resolves the session cookie to `req.viewer` and provides the role guards used by every route.
import type { ServerConfig } from '@acm/core/config';
import type { Db } from '@acm/core/db';
import type { Viewer } from '@acm/core/schemas';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { HttpError, notFound } from '../lib/errors.ts';
import { lookupSession, SESSION_COOKIE, SESSION_TTL } from './sessions.ts';

declare module 'fastify' {
  interface FastifyRequest {
    viewer: Viewer | null;
    sessionId: string | null;
  }
}

export function cookieOptions(cfg: ServerConfig, expires?: Date) {
  return {
    path: '/',
    httpOnly: true,
    secure: cfg.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    ...(expires ? { expires } : { maxAge: SESSION_TTL / 1000 }),
  };
}

export function registerSessions(app: FastifyInstance, db: Db, cfg: ServerConfig) {
  app.decorateRequest('viewer', null);
  app.decorateRequest('sessionId', null);
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    const token = req.cookies[SESSION_COOKIE];
    if (!token) return;
    const s = await lookupSession(db, token);
    if (!s || (cfg.PRELAUNCH_ALLOWLIST.length > 0 && !cfg.PRELAUNCH_ALLOWLIST.includes(s.viewer.email))) {
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return;
    }
    req.viewer = s.viewer;
    req.sessionId = s.sessionId;
    if (s.refreshedExpiry) reply.setCookie(SESSION_COOKIE, token, cookieOptions(cfg, s.refreshedExpiry));
  });
}

export async function requireUser(req: FastifyRequest, _reply: FastifyReply) {
  if (!req.viewer) throw new HttpError('unauthorized');
}

/** Core-only routes answer members with 404, like everything else they may not see. */
export async function requireCore(req: FastifyRequest, _reply: FastifyReply) {
  if (!req.viewer) throw new HttpError('unauthorized');
  if (req.viewer.role !== 'core') throw notFound();
}

export async function requireAdmin(req: FastifyRequest, _reply: FastifyReply) {
  if (!req.viewer) throw new HttpError('unauthorized');
  if (!req.viewer.isAdmin) throw notFound();
}

export function viewerOf(req: FastifyRequest): Viewer {
  if (!req.viewer) throw new HttpError('unauthorized');
  return req.viewer;
}
