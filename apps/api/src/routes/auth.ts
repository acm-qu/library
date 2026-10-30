import type { ServerConfig } from '@acm/core/config';
import { accessRequests, type Db, legacyGender, users } from '@acm/core/db';
import { newId } from '@acm/core/ids';
import { Me, RequestAccessBody, RequestCodeBody, VerifyBody } from '@acm/core/schemas';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { issueCode, type OtpDeps, verifyCode } from '../auth/otp.ts';
import { cookieOptions, isSuperadmin, requireUser, viewerOf } from '../auth/plugin.ts';
import { createSession, deleteSession, deleteUserSessions, SESSION_COOKIE } from '../auth/sessions.ts';
import { audit } from '../lib/audit.ts';
import { HttpError } from '../lib/errors.ts';
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
  const perEmailDay = makeLimiter(app, 'requestCodeEmailDay', emailOf);
  const perIp = makeLimiter(app, 'requestCodeIp', (req) => req.ip);
  const verifyPerIp = makeLimiter(app, 'verifyIp', (req) => req.ip);
  const accessPerIp = makeLimiter(app, 'requestAccessIp', (req) => req.ip);
  const accessPerEmail = makeLimiter(app, 'requestAccessEmailDay', emailOf);

  app.post('/api/auth/request-code', async (req, reply) => {
    const { email } = RequestCodeBody.parse(req.body);
    await perIp(req);
    await perEmail(req);
    await perEmailDay(req);
    const issued = await withFloor(deps.floorMs ?? REQUEST_CODE_FLOOR_MS, () => issueCode(otp, email, req.ip));
    if (issued) {
      // After the response, so SMTP latency can't be timed either.
      setImmediate(() => mailer.sendSignInCode(email, issued.code).catch((err) => req.log.error({ err }, 'sign-in mail failed')));
    }
    return reply.code(204).send();
  });

  // Same answer and timing floor for a new address, an existing account and a pending request.
  app.post('/api/auth/request-access', async (req, reply) => {
    const body = RequestAccessBody.parse(req.body);
    await accessPerIp(req);
    await accessPerEmail(req);
    await withFloor(deps.floorMs ?? REQUEST_CODE_FLOOR_MS, async () => {
      const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, body.email));
      if (user) return;
      const [pending] = await db.select({ id: accessRequests.id }).from(accessRequests).where(and(eq(accessRequests.email, body.email), eq(accessRequests.status, 'pending')));
      if (pending) return;
      // The partial unique index settles a race between two identical requests.
      await db.insert(accessRequests).values({ id: newId(), ...body, gender: legacyGender(body.isFemale), requestIp: req.ip }).onConflictDoNothing();
    });
    return reply.code(204).send();
  });

  app.post('/api/auth/verify', async (req, reply) => {
    await verifyPerIp(req);
    const { email, code } = VerifyBody.parse(req.body);
    const user = await verifyCode(otp, email, code).catch((err: unknown) => {
      if (err instanceof HttpError) req.log.warn({ evt: 'otp_fail', reason: err.code, ip: req.ip }, 'sign-in code rejected');
      throw err;
    });
    // A browser that already held a session (another user on a shared PC) doesn't keep it.
    if (req.sessionId) await deleteSession(db, req.sessionId);
    await audit(db, user.id, 'auth.login', { type: 'user', id: user.id }, { ip: req.ip });
    const s = await createSession(db, user.id, { ip: req.ip, userAgent: req.headers['user-agent'] ?? null });
    reply.setCookie(SESSION_COOKIE, s.token, cookieOptions(cfg, s.expiresAt));
    return Me.parse({ ...user, isSuperadmin: isSuperadmin(cfg, user) });
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
