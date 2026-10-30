import { loadConfig, type ServerConfig } from '@acm/core/config';
import { createDb, users } from '@acm/core/db';
import { newId } from '@acm/core/ids';
import { sql } from 'drizzle-orm';
import { afterAll, beforeEach } from 'vitest';
import { buildApp } from '../src/app.ts';
import type { Mailer } from '../src/mail/mailer.ts';

const key = Buffer.alloc(32, 7).toString('base64');
export const testConfig = (over: Partial<Record<string, string>> = {}): ServerConfig =>
  loadConfig({
    NODE_ENV: 'test',
    PUBLIC_ORIGIN: 'http://localhost:5180',
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://acm:acm@127.0.0.1:55496/acm_media_test',
    MASTER_KEY: key,
    OTP_PEPPER: key,
    SMTP_FROM: 'QU ACM Media Library <noreply@qu.acm.org>',
    MAIL_TRANSPORT: 'log',
    MEDIA_ROOT: '/tmp',
    KEYS_DIR: '/tmp',
    ...over,
  });

const { db, pool } = createDb(testConfig().DATABASE_URL, 4);
export { db };
afterAll(() => pool.end());

export async function resetDb() {
  await db.execute(sql`truncate users, access_requests, otp_codes, sessions, events, assets, renditions, processing_runs, jobs, asset_keys, audit_log, app_settings cascade`);
}

export function useApp(over: Partial<Record<string, string>> = {}) {
  const sent: { to: string; code: string }[] = [];
  const approved: string[] = [];
  const mailer: Mailer = { sendSignInCode: async (to, code) => void sent.push({ to, code }), sendApproved: async (to) => void approved.push(to) };
  const ctx = {
    sent,
    approved,
    app: null as unknown as Awaited<ReturnType<typeof buildApp>>,
    async lastCode() {
      await new Promise((r) => setImmediate(r)); // mail is sent after the response
      return sent.at(-1)?.code;
    },
  };
  beforeEach(async () => {
    await resetDb();
    sent.length = 0;
    approved.length = 0;
    await ctx.app?.close();
    ctx.app = await buildApp({ cfg: testConfig(over), db, mailer, logger: false, requestCodeFloorMs: 0 });
  });
  afterAll(() => ctx.app?.close());
  return ctx;
}

export async function addUser(email: string, opts: Partial<typeof users.$inferInsert> = {}) {
  const [u] = await db.insert(users).values({ id: newId(), email, name: email.split('@')[0]!, role: 'core', isFemale: true, ...opts }).returning();
  return u!;
}

export const H = { 'x-requested-with': 'acm-media' };

/** The `sid` cookie value from a response, if one was set. */
export function sid(res: { cookies: { name: string; value: string }[] }) {
  return res.cookies.find((c) => c.name === 'sid')?.value;
}
