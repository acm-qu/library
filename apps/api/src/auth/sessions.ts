// Opaque session tokens: the cookie holds 32 random bytes, the database holds their SHA-256.
// Sessions slide: expires_at is pushed out at most once an hour, last_seen_at at most every 5 minutes.
import { createHash, randomBytes } from 'node:crypto';
import { type Db, sessions, users } from '@acm/core/db';
import { newId } from '@acm/core/ids';
import type { Viewer } from '@acm/core/schemas';
import { and, eq, lt, sql } from 'drizzle-orm';
import { DAY, HOUR, MINUTE } from '../lib/time.ts';

export const SESSION_COOKIE = 'sid';
export const SESSION_TTL = 30 * DAY;
const EXTEND_EVERY = HOUR;
const SEEN_EVERY = 5 * MINUTE;

export const hashToken = (token: string) => createHash('sha256').update(token).digest();

export type SessionMeta = { ip: string | null; userAgent: string | null };

export async function createSession(db: Db, userId: string, meta: SessionMeta, now = new Date()) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + SESSION_TTL);
  await db.insert(sessions).values({
    id: newId(),
    tokenHash: hashToken(token),
    userId,
    expiresAt,
    lastSeenAt: now,
    ip: meta.ip,
    userAgent: meta.userAgent?.slice(0, 512) ?? null,
  });
  return { token, expiresAt };
}

export type SessionLookup = { viewer: Viewer; sessionId: string; refreshedExpiry: Date | null };

/** Resolve a cookie token to an active viewer, sliding the session. Returns null for anything invalid. */
export async function lookupSession(db: Db, token: string | undefined, now = new Date()): Promise<SessionLookup | null> {
  if (!token || token.length > 128) return null;
  const [row] = await db
    .select({
      sessionId: sessions.id,
      expiresAt: sessions.expiresAt,
      lastSeenAt: sessions.lastSeenAt,
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      isAdmin: users.isAdmin,
      status: users.status,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.tokenHash, hashToken(token)));
  if (!row) return null;
  if (row.expiresAt <= now || row.status !== 'active') {
    await db.delete(sessions).where(eq(sessions.id, row.sessionId));
    return null;
  }

  const extend = row.expiresAt.getTime() - now.getTime() < SESSION_TTL - EXTEND_EVERY;
  const seen = now.getTime() - row.lastSeenAt.getTime() >= SEEN_EVERY;
  let refreshedExpiry: Date | null = null;
  if (extend || seen) {
    refreshedExpiry = extend ? new Date(now.getTime() + SESSION_TTL) : null;
    await db
      .update(sessions)
      .set({ lastSeenAt: now, ...(refreshedExpiry ? { expiresAt: refreshedExpiry } : {}) })
      .where(eq(sessions.id, row.sessionId));
  }

  const { sessionId, expiresAt: _e, lastSeenAt: _l, ...viewer } = row;
  return { viewer, sessionId, refreshedExpiry };
}

export const deleteSession = (db: Db, sessionId: string) => db.delete(sessions).where(eq(sessions.id, sessionId));
export const deleteUserSessions = (db: Db, userId: string) => db.delete(sessions).where(eq(sessions.userId, userId));
export const purgeExpiredSessions = (db: Db, now = new Date()) => db.delete(sessions).where(lt(sessions.expiresAt, now));

/** Count of a user's live sessions (Account screen). */
export async function countSessions(db: Db, userId: string, now = new Date()) {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), sql`${sessions.expiresAt} > ${now}`));
  return r?.n ?? 0;
}
