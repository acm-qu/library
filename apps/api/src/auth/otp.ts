// Email one-time codes. Unknown, disabled and (before launch) non-allowlisted emails get a decoy row, so
// request-code and verify behave identically for every address and never reveal who is registered.
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { type Db, otpCodes, users } from '@acm/core/db';
import { newId } from '@acm/core/ids';
import type { User } from '@acm/core/db';
import { and, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { HttpError } from '../lib/errors.ts';
import { MINUTE } from '../lib/time.ts';

export const CODE_TTL = 10 * MINUTE;
export const MAX_ATTEMPTS = 5;

export type OtpDeps = { db: Db; pepper: Buffer; allowlist: readonly string[] };

const hashCode = (pepper: Buffer, email: string, code: string) =>
  createHmac('sha256', pepper).update(`${email}:${code}`).digest();

export const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

/** Whether this address may sign in right now. Only core accounts sign in; everyone else browses signed out. */
export function canSignIn(user: Pick<User, 'email' | 'status' | 'role'> | undefined, allowlist: readonly string[]): user is User {
  return !!user && user.status === 'active' && user.role === 'core' && (allowlist.length === 0 || allowlist.includes(user.email));
}

/** Issue a code. Returns the code only for an address that can sign in; the caller mails it. */
export async function issueCode(d: OtpDeps, email: string, ip: string | null, now = new Date()): Promise<{ code: string; user: User } | null> {
  const [user] = await d.db.select().from(users).where(eq(users.email, email));
  const real = canSignIn(user, d.allowlist);
  const code = newCode();
  const codeHash = real ? hashCode(d.pepper, email, code) : randomBytes(32);
  await d.db.transaction(async (tx) => {
    // Only the newest code is ever valid; older ones (and stale rows) are removed.
    await tx.delete(otpCodes).where(or(and(eq(otpCodes.email, email), isNull(otpCodes.consumedAt)), lt(otpCodes.expiresAt, new Date(now.getTime() - 24 * 60 * MINUTE))));
    await tx.insert(otpCodes).values({ id: newId(), email, codeHash, expiresAt: new Date(now.getTime() + CODE_TTL), createdAt: now, requestIp: ip });
  });
  return real ? { code, user: user! } : null;
}

/** Check a code. Throws HttpError for every failure; returns the user on success (code consumed). */
export async function verifyCode(d: OtpDeps, email: string, code: string, now = new Date()): Promise<User> {
  // Failures are returned, not thrown, inside the transaction: a throw would roll back the attempt count.
  const result = await d.db.transaction(async (tx): Promise<User | HttpError> => {
    const [row] = await tx
      .select()
      .from(otpCodes)
      .where(and(eq(otpCodes.email, email), isNull(otpCodes.consumedAt)))
      .orderBy(desc(otpCodes.createdAt))
      .limit(1)
      .for('update');
    if (!row || row.expiresAt <= now) return new HttpError('expired_code');

    const attempts = row.attempts + 1;
    const ok = timingSafeEqual(row.codeHash, hashCode(d.pepper, email, code));
    const [user] = await tx.select().from(users).where(eq(users.email, email));
    if (ok && canSignIn(user, d.allowlist)) {
      await tx.update(otpCodes).set({ attempts, consumedAt: now }).where(eq(otpCodes.id, row.id));
      await tx.update(users).set({ lastLoginAt: now }).where(eq(users.id, user.id));
      return user;
    }

    const attemptsLeft = MAX_ATTEMPTS - attempts;
    if (attemptsLeft <= 0) {
      await tx.update(otpCodes).set({ attempts, consumedAt: now }).where(eq(otpCodes.id, row.id));
      return new HttpError('too_many_attempts');
    }
    await tx.update(otpCodes).set({ attempts: sql`${otpCodes.attempts} + 1` }).where(eq(otpCodes.id, row.id));
    return new HttpError('wrong_code', { attemptsLeft });
  });
  if (result instanceof HttpError) throw result;
  return result;
}
