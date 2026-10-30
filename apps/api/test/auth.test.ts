import { otpCodes, sessions, users } from '@acm/core/db';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { addUser, db, H, sid, testConfig, useApp } from './helpers.ts';

const t = useApp();
const request = (email: string, ip = '10.0.0.1') =>
  t.app.inject({ method: 'POST', url: '/api/auth/request-code', headers: { ...H, 'x-forwarded-for': ip }, remoteAddress: '127.0.0.1', payload: { email } });
const verify = (email: string, code: string, ip = '10.0.0.1') =>
  t.app.inject({ method: 'POST', url: '/api/auth/verify', headers: { ...H, 'x-forwarded-for': ip }, remoteAddress: '127.0.0.1', payload: { email, code } });
const me = (cookie?: string) => t.app.inject({ method: 'GET', url: '/api/me', cookies: cookie ? { sid: cookie } : {} });
const wrong = (code: string) => (code === '000000' ? '000001' : '000000');

async function signIn(email: string) {
  await request(email);
  const res = await verify(email, (await t.lastCode())!);
  expect(res.statusCode).toBe(200);
  return sid(res)!;
}

describe('request-code', () => {
  it('answers 204 for known and unknown emails, but only mails the known one', async () => {
    await addUser('sara@qu.edu.qa');
    expect((await request('Sara@QU.edu.qa ')).statusCode).toBe(204);
    expect((await request('nobody@qu.edu.qa')).statusCode).toBe(204);
    await t.lastCode();
    expect(t.sent.map((m) => m.to)).toEqual(['sara@qu.edu.qa']);
    // The unknown address still gets a (decoy) row, so verify behaves the same for it.
    const rows = await db.select().from(otpCodes);
    expect(rows.map((r) => r.email).sort()).toEqual(['nobody@qu.edu.qa', 'sara@qu.edu.qa']);
  });

  it('treats a leftover member account like an unknown email', async () => {
    await addUser('old@qu.edu.qa', { role: 'member' });
    expect((await request('old@qu.edu.qa')).statusCode).toBe(204);
    await t.lastCode();
    expect(t.sent).toEqual([]);
  });

  it('keeps only the newest code valid', async () => {
    await addUser('sara@qu.edu.qa');
    await request('sara@qu.edu.qa');
    const first = (await t.lastCode())!;
    await request('sara@qu.edu.qa');
    const second = (await t.lastCode())!;
    if (first !== second) expect((await verify('sara@qu.edu.qa', first)).statusCode).toBe(400);
    expect((await verify('sara@qu.edu.qa', second)).statusCode).toBe(200);
  });

  it('limits 3 per email per 15 minutes with retry_after', async () => {
    for (let i = 0; i < 3; i++) expect((await request('a@qu.edu.qa', `10.0.0.${i}`)).statusCode).toBe(204);
    const res = await request('a@qu.edu.qa', '10.0.0.9');
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ error: 'rate_limited' });
    expect(res.json().retry_after).toBeGreaterThan(800);
    expect(res.headers['retry-after']).toBe(String(res.json().retry_after));
  });

  it('limits 10 per IP per hour, using X-Forwarded-For from the local proxy', async () => {
    for (let i = 0; i < 10; i++) expect((await request(`u${i}@qu.edu.qa`, '10.9.9.9')).statusCode).toBe(204);
    expect((await request('u10@qu.edu.qa', '10.9.9.9')).statusCode).toBe(429);
    expect((await request('u10@qu.edu.qa', '10.9.9.8')).statusCode).toBe(204);
  });

  it('pads to the timing floor', async () => {
    const app = await buildApp({ cfg: testConfig(), db, mailer: { sendSignInCode: async () => {} }, logger: false });
    const start = performance.now();
    await app.inject({ method: 'POST', url: '/api/auth/request-code', headers: H, payload: { email: 'x@qu.edu.qa' } });
    expect(performance.now() - start).toBeGreaterThanOrEqual(340);
    await app.close();
  });

  it('requires the CSRF header', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/request-code', payload: { email: 'a@qu.edu.qa' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('csrf');
  });

  it('rejects a malformed email with 400', async () => {
    const res = await request('not-an-email');
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'bad_request', fields: { email: expect.any(String) } });
  });
});

describe('verify', () => {
  it('signs in, sets an HttpOnly Lax cookie, and /me returns the user', async () => {
    await addUser('sara@qu.edu.qa', { role: 'core' });
    await request('sara@qu.edu.qa');
    const res = await verify('sara@qu.edu.qa', (await t.lastCode())!);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: expect.any(String), email: 'sara@qu.edu.qa', name: 'sara', role: 'core', isAdmin: false });
    const c = res.cookies.find((x) => x.name === 'sid')!;
    expect(c).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
    expect((await me(c.value)).json().email).toBe('sara@qu.edu.qa');
    const [u] = await db.select().from(users);
    expect(u!.lastLoginAt).not.toBeNull();
    const [s] = await db.select().from(sessions);
    expect(s!.ip).toBe('10.0.0.1');
  });

  it('counts attempts down, then locks the code', async () => {
    await addUser('sara@qu.edu.qa');
    await request('sara@qu.edu.qa');
    const code = (await t.lastCode())!;
    for (let left = 4; left >= 1; left--) {
      const r = await verify('sara@qu.edu.qa', wrong(code));
      expect(r.statusCode).toBe(400);
      expect(r.json()).toMatchObject({ error: 'wrong_code', attemptsLeft: left });
    }
    expect((await verify('sara@qu.edu.qa', wrong(code))).json().error).toBe('too_many_attempts');
    expect((await verify('sara@qu.edu.qa', code)).json().error).toBe('expired_code');
  });

  it('answers an unknown email exactly like a known one', async () => {
    await addUser('sara@qu.edu.qa');
    await request('sara@qu.edu.qa');
    await request('ghost@qu.edu.qa');
    const known = await verify('sara@qu.edu.qa', '123456');
    const unknown = await verify('ghost@qu.edu.qa', '123456');
    if (known.statusCode !== 200) expect(unknown.json()).toEqual(known.json());
    expect(unknown.json()).toMatchObject({ error: 'wrong_code', attemptsLeft: 4 });
  });

  it('expires codes after 10 minutes', async () => {
    await addUser('sara@qu.edu.qa');
    await request('sara@qu.edu.qa');
    await db.update(otpCodes).set({ expiresAt: sql`now() - interval '1 second'` });
    expect((await verify('sara@qu.edu.qa', (await t.lastCode())!)).json().error).toBe('expired_code');
  });

  it('refuses a disabled user even with the right code', async () => {
    const u = await addUser('sara@qu.edu.qa');
    await request('sara@qu.edu.qa');
    const code = (await t.lastCode())!;
    await db.update(users).set({ status: 'disabled' }).where(eq(users.id, u.id));
    expect((await verify('sara@qu.edu.qa', code)).json().error).toBe('wrong_code');
  });

  it('limits verify to 20 per IP per 15 minutes', async () => {
    for (let i = 0; i < 20; i++) await verify(`v${i}@qu.edu.qa`, '123456', '10.7.7.7');
    expect((await verify('v20@qu.edu.qa', '123456', '10.7.7.7')).statusCode).toBe(429);
  });
});

describe('sessions', () => {
  it('401s without a cookie and after disabling the user', async () => {
    expect((await me()).statusCode).toBe(401);
    const u = await addUser('sara@qu.edu.qa');
    const c = await signIn('sara@qu.edu.qa');
    await db.update(users).set({ status: 'disabled' }).where(eq(users.id, u.id));
    expect((await me(c)).statusCode).toBe(401);
    expect(await db.select().from(sessions)).toHaveLength(0);
  });

  it('slides the expiry and re-sets the cookie when more than an hour has passed', async () => {
    await addUser('sara@qu.edu.qa');
    const c = await signIn('sara@qu.edu.qa');
    expect(sid(await me(c))).toBeUndefined();
    await db.update(sessions).set({ expiresAt: sql`now() + interval '29 days'`, lastSeenAt: sql`now() - interval '1 day'` });
    const res = await me(c);
    expect(sid(res)).toBe(c);
    const [s] = await db.select().from(sessions);
    expect(s!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 29.9 * 86400_000);
  });

  it('expires after 30 days', async () => {
    await addUser('sara@qu.edu.qa');
    const c = await signIn('sara@qu.edu.qa');
    await db.update(sessions).set({ expiresAt: sql`now() - interval '1 second'` });
    expect((await me(c)).statusCode).toBe(401);
  });

  it('logout ends one session; logout-all ends every session', async () => {
    await addUser('sara@qu.edu.qa');
    const a = await signIn('sara@qu.edu.qa');
    const b = await signIn('sara@qu.edu.qa');
    const out = (url: string, c: string) => t.app.inject({ method: 'POST', url, headers: H, cookies: { sid: c } });
    expect((await out('/api/auth/logout', a)).statusCode).toBe(204);
    expect((await me(a)).statusCode).toBe(401);
    expect((await me(b)).statusCode).toBe(200);
    const c = await signIn('sara@qu.edu.qa');
    expect((await out('/api/auth/logout-all', c)).statusCode).toBe(204);
    expect((await me(b)).statusCode).toBe(401);
  });

  it('PATCH /me renames the user', async () => {
    await addUser('sara@qu.edu.qa');
    const c = await signIn('sara@qu.edu.qa');
    const res = await t.app.inject({ method: 'PATCH', url: '/api/me', headers: H, cookies: { sid: c }, payload: { name: '  Sara A.  ' } });
    expect(res.json().name).toBe('Sara A.');
  });
});

describe('prelaunch allowlist', () => {
  const p = useApp({ PRELAUNCH_ALLOWLIST: 'tech@qu.acm.org' });
  it('only mails allowlisted admins', async () => {
    await addUser('tech@qu.acm.org', { role: 'core', isAdmin: true });
    await addUser('sara@qu.edu.qa');
    for (const email of ['tech@qu.acm.org', 'sara@qu.edu.qa'])
      await p.app.inject({ method: 'POST', url: '/api/auth/request-code', headers: H, payload: { email } });
    await p.lastCode();
    expect(p.sent.map((m) => m.to)).toEqual(['tech@qu.acm.org']);
  });
});

describe('misc', () => {
  it('unknown API routes are JSON 404s and security headers are set', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found', message: 'Not found.' });
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['referrer-policy']).toBe('same-origin');
  });

  it('health reports the database', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.json()).toMatchObject({ ok: true, db: true });
  });
});

describe('server errors', () => {
  it('answer 500 with a reference that matches the request id', async () => {
    t.app.get('/api/boom', async () => {
      throw new Error('kaboom');
    });
    const res = await t.app.inject({ method: 'GET', url: '/api/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: 'internal', reference: expect.stringMatching(/^[0-9A-F]{4}-[0-9A-F]{4}$/) });
    expect(res.body).not.toContain('kaboom');
  });
});

describe('web app serving', () => {
  it('serves the SPA for page URLs and 404s missing assets', async () => {
    const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(`${tmpdir()}/web-`);
    await mkdir(`${dir}/assets`);
    await writeFile(`${dir}/index.html`, '<!doctype html><title>x</title>');
    await writeFile(`${dir}/assets/app-1.js`, 'console.log(1)');
    const app = await buildApp({ cfg: { ...testConfig(), WEB_ROOT: dir }, db, mailer: { sendSignInCode: async () => {} }, logger: false });
    const page = await app.inject({ method: 'GET', url: '/events/2026-10-17-hackathon-day-1?kind=video' });
    expect([page.statusCode, page.headers['content-type']]).toEqual([200, 'text/html; charset=utf-8']);
    await writeFile(`${dir}/assets/app-2.js`, 'console.log(2)'); // added after start, like a rebuild
    const js = await app.inject({ method: 'GET', url: '/assets/app-2.js' });
    expect([js.statusCode, js.headers['cache-control']]).toEqual([200, 'public, max-age=31536000, immutable']);
    expect((await app.inject({ method: 'GET', url: '/assets/missing.js' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/missing' })).json().error).toBe('not_found');
    await app.close();
  });
});
