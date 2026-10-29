import type { ServerConfig } from '@acm/core/config';
import type { Db } from '@acm/core/db';
import { Me, RequestCodeBody, VerifyBody } from '@acm/core/schemas';
import type { FastifyInstance } from 'fastify';
import { issueCode, type OtpDeps, verifyCode } from '../auth/otp.ts';
import { cookieOptions, requireUser, viewerOf } from '../auth/plugin.ts';
import { createSession, deleteSession, deleteUserSessions, SESSION_COOKIE } from '../auth/sessions.ts';
import { makeLimiter } from '../lib/limits.ts';
import { withFloor } from '../lib/time.ts';
import type { Mailer } from '../mail/mailer.ts';

/** request-code always takes at least this long, so the known-email branch can't be timed. */
export const REQUEST_CODE_FLOOR_MS = 350;

export function authRoutes(app: FastifyInstance, deps: { db: Db; cfg: ServerConfig; mailer: Mailer; floorMs?: number }) {
  const { db, cfg, mailer } = deps;
  const otp: OtpDeps = { db, pepper: Buffer.from(cfg.OTP_PEPPER, 'base64'), allowlist: cfg.PRELAUNCH_ALLOWLIST };
  const emailOf = (req: { body: unknown }) => RequestCodeBody.safeParse(req.body).data?.email ?? '-';
  const perEmail = makeLimiter(app, 'requestCodeEmail', emailOf);
  const perIp = makeLimiter(app, 'requestCodeIp', (req) => req.ip);
  const verifyPerIp = makeLimiter(app, 'verifyIp', (req) => req.ip);

  app.post('/api/auth/request-code', async (req, reply) => {
    const { email } = RequestCodeBody.parse(req.body);
    await perIp(req);
    await perEmail(req);
    const issued = await withFloor(deps.floorMs ?? REQUEST_CODE_FLOOR_MS, () => issueCode(otp, email, req.ip));
    if (issued) {
      // After the response, so SMTP latency can't be timed either.
      setImmediate(() => mailer.sendSignInCode(email, issued.code).catch((err) => req.log.error({ err }, 'sign-in mail failed')));
    }
    return reply.code(204).send();
  });

  app.post('/api/auth/verify', async (req, reply) => {
    await verifyPerIp(req);
    const { email, code } = VerifyBody.parse(req.body);
    const user = await verifyCode(otp, email, code);
    const s = await createSession(db, user.id, { ip: req.ip, userAgent: req.headers['user-agent'] ?? null });
    reply.setCookie(SESSION_COOKIE, s.token, cookieOptions(cfg, s.expiresAt));
    return Me.parse(user);
  });

  app.post('/api/auth/logout', { preHandler: requireUser }, async (req, reply) => {
    await deleteSession(db, req.sessionId!);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.code(204).send();
  });

  app.post('/api/auth/logout-all', { preHandler: requireUser }, async (req, reply) => {
    await deleteUserSessions(db, viewerOf(req).id);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.code(204).send();
  });
}
