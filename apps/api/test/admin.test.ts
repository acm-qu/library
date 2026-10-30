import { appSettings, assets, auditLog, events, jobs, sessions, users } from '@acm/core/db';
import { newId } from '@acm/core/ids';
import { eq, inArray } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createSession } from '../src/auth/sessions.ts';
import { addUser, db, H, useApp } from './helpers.ts';

const t = useApp();
let admin: { id: string; sid: string };
let core: { id: string; sid: string };
let eventId: string;

async function who(email: string, o: Partial<typeof users.$inferInsert>) {
  const u = await addUser(email, o);
  return { id: u.id, sid: (await createSession(db, u.id, { ip: null, userAgent: null })).token };
}
const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, sid: string, payload?: object) =>
  t.app.inject({ method, url, headers: method === 'GET' ? {} : H, cookies: { sid }, ...(payload ? { payload } : {}) });

beforeEach(async () => {
  admin = await who('tech@qu.acm.org', { role: 'core', isAdmin: true });
  core = await who('c@qu.edu.qa', { role: 'core' });
  eventId = newId();
  await db.insert(events).values({ id: eventId, title: 'Hack Night', slug: 'hack', startsOn: '2026-10-10', createdBy: admin.id });
});

async function asset(o: Partial<typeof assets.$inferInsert> = {}) {
  const id = newId();
  await db.insert(assets).values({ id, eventId, kind: 'video', tier: 'member', status: 'queued', originalFilename: 'v.mov', originalExt: 'mov', uploaderId: core.id, durationS: 60, ...o });
  return id;
}

describe('access', () => {
  it('is invisible to non-admins', async () => {
    for (const url of ['/api/admin/users', '/api/admin/jobs', '/api/admin/storage', '/api/admin/settings']) expect((await call('GET', url, core.sid)).statusCode).toBe(404);
    expect((await call('POST', '/api/admin/users', core.sid, { email: 'x@y.qa', role: 'member' })).statusCode).toBe(404);
  });
});

describe('members', () => {
  it('adds one member, refuses duplicates and non-core admins', async () => {
    expect((await call('POST', '/api/admin/users', admin.sid, { email: 'New@QU.edu.qa', name: 'New', role: 'member' })).statusCode).toBe(201);
    expect((await call('POST', '/api/admin/users', admin.sid, { email: 'new@qu.edu.qa', role: 'member' })).statusCode).toBe(409);
    expect((await call('POST', '/api/admin/users', admin.sid, { email: 'a@qu.edu.qa', role: 'member', isAdmin: true })).statusCode).toBe(400);
    const list = (await call('GET', '/api/admin/users?q=new', admin.sid)).json();
    expect(list.items.map((u: { email: string }) => u.email)).toEqual(['new@qu.edu.qa']);
    expect(list.counts).toMatchObject({ all: 3, core: 2, admins: 1 });
  });

  it('bulk-adds a pasted list and explains what it skipped', async () => {
    const r = (await call('POST', '/api/admin/users/bulk', admin.sid, { emails: ['a@qu.edu.qa, B@qu.edu.qa\nnot-an-email', 'a@qu.edu.qa', 'c@qu.edu.qa'], role: 'member' })).json();
    expect(r.created).toBe(2);
    expect(r.skipped).toEqual(expect.arrayContaining([{ email: 'not-an-email', reason: 'invalid' }, { email: 'a@qu.edu.qa', reason: 'duplicate' }, { email: 'c@qu.edu.qa', reason: 'exists' }]));
  });

  it('keeps at least one admin, demotes admin with role, and ends sessions on disable', async () => {
    expect((await call('PATCH', `/api/admin/users/${admin.id}`, admin.sid, { isAdmin: false })).statusCode).toBe(403);
    expect((await call('PATCH', `/api/admin/users/${admin.id}`, admin.sid, { status: 'disabled' })).statusCode).toBe(403);
    expect((await call('PATCH', `/api/admin/users/${core.id}`, admin.sid, { isAdmin: true })).statusCode).toBe(200);
    expect((await call('PATCH', `/api/admin/users/${admin.id}`, admin.sid, { role: 'member' })).statusCode).toBe(200);
    const [demoted] = await db.select().from(users).where(eq(users.id, admin.id));
    expect([demoted!.role, demoted!.isAdmin]).toEqual(['member', false]);
    expect((await call('PATCH', `/api/admin/users/${admin.id}`, core.sid, { status: 'disabled' })).statusCode).toBe(200);
    expect(await db.select().from(sessions).where(eq(sessions.userId, admin.id))).toHaveLength(0);
    expect((await db.select().from(auditLog)).map((a) => a.action).filter((a) => a === 'user.update')).toHaveLength(3);
  });
});

describe('queue', () => {
  it('lists tabs with a summary, prioritises, cancels and retries', async () => {
    const a1 = await asset();
    const a2 = await asset({ durationS: 120 });
    const j1 = newId();
    const j2 = newId();
    await db.insert(jobs).values([
      { id: j1, assetId: a1, kind: 'process', createdAt: new Date(Date.now() - 1000) },
      { id: j2, assetId: a2, kind: 'process' },
    ]);
    let q = (await call('GET', '/api/admin/jobs?tab=queued', admin.sid)).json();
    expect(q.items.map((j: { id: string }) => j.id)).toEqual([j1, j2]);
    expect(q.summary).toMatchObject({ queued: 2, running: 0, queuedVideoS: 180 });
    expect(q.items[1].readyInS).toBeGreaterThan(q.items[0].readyInS);

    expect((await call('POST', `/api/admin/jobs/${j2}/prioritize`, admin.sid)).statusCode).toBe(200);
    q = (await call('GET', '/api/admin/jobs?tab=queued', admin.sid)).json();
    expect(q.items[0].id).toBe(j2);

    expect((await call('POST', `/api/admin/jobs/${j1}/cancel`, admin.sid)).statusCode).toBe(200);
    expect((await db.select().from(assets).where(eq(assets.id, a1)))[0]!.status).toBe('failed');
    await db.update(jobs).set({ state: 'failed' }).where(eq(jobs.id, j1));
    expect((await call('GET', '/api/admin/jobs?tab=failed', admin.sid)).json().items.map((j: { id: string }) => j.id)).toEqual([j1]);
    expect((await call('POST', `/api/admin/jobs/${j1}/retry`, admin.sid)).statusCode).toBe(200);
    expect((await db.select().from(assets).where(eq(assets.id, a1)))[0]!.status).toBe('queued');
    expect((await call('POST', `/api/admin/jobs/${j1}/retry`, admin.sid)).statusCode).toBe(200); // still failed → another copy is fine
  });

  it('drops deleted items from every tab and count, before and after the purge', async () => {
    const a = await asset();
    const done = await asset();
    await db.insert(jobs).values([
      { id: newId(), assetId: a, kind: 'process' },
      { id: newId(), assetId: done, kind: 'process', state: 'done', finishedAt: new Date() },
    ]);
    for (const id of [a, done]) expect((await call('DELETE', `/api/assets/${id}`, admin.sid)).statusCode).toBe(204);
    const tabs = async () => Promise.all(['running', 'queued', 'failed', 'recent'].map(async (tab) => (await call('GET', `/api/admin/jobs?tab=${tab}`, admin.sid)).json()));
    for (const q of await tabs()) {
      expect(q.items).toEqual([]);
      expect(q.summary).toMatchObject({ queued: 0, running: 0, failed: 0, drainS: 0 });
    }
    await db.delete(assets).where(inArray(assets.id, [a, done])); // what the purge job does
    for (const q of await tabs()) expect(q.items).toEqual([]);
  });

  it('resolves needs review either way', async () => {
    const a = await asset({ status: 'needs_review', reviewReason: 'unknown_transfer' });
    await db.insert(jobs).values({ id: newId(), assetId: a, kind: 'process', state: 'done', outcome: 'needs_review', finishedAt: new Date() });
    expect((await call('GET', '/api/admin/jobs?tab=needs_review', admin.sid)).json().items[0].asset).toMatchObject({ id: a, reviewReason: 'unknown_transfer' });
    expect((await call('POST', `/api/admin/assets/${a}/resolve`, admin.sid, { action: 'process_default' })).statusCode).toBe(200);
    const [j] = await db.select().from(jobs).where(eq(jobs.state, 'queued'));
    expect(j).toMatchObject({ assetId: a, kind: 'process', params: { force: true } });
    expect((await call('POST', `/api/admin/assets/${a}/resolve`, admin.sid, { action: 'original_only' })).statusCode).toBe(409);
    const b = await asset({ status: 'needs_review' });
    expect((await call('POST', `/api/admin/assets/${b}/resolve`, admin.sid, { action: 'original_only' })).statusCode).toBe(200);
    expect((await db.select().from(assets).where(eq(assets.id, b)))[0]!.status).toBe('original_only');
  });

  it('reports processing details and queues a re-process with a curve override', async () => {
    const a = await asset({ status: 'ready', hdr: 'hlg' });
    const p = (await call('GET', `/api/admin/assets/${a}/processing`, admin.sid)).json();
    expect(p.asset).toMatchObject({ id: a, eventTitle: 'Hack Night', hdr: 'hlg' });
    expect(p.reprocessEtaS).toBeGreaterThan(60);
    expect((await call('POST', `/api/admin/assets/${a}/reprocess`, admin.sid, { toneCurve: 'bt2390' })).statusCode).toBe(202);
    expect((await db.select().from(jobs))[0]).toMatchObject({ kind: 'reprocess', params: { toneCurve: 'bt2390', curveSource: 'override' } });
    expect((await call('POST', `/api/admin/assets/${a}/reprocess`, admin.sid, { toneCurve: 'magic' })).statusCode).toBe(400);
  });
});

describe('storage and settings', () => {
  it('reports nightly stats and refuses auto curves before the validation gate', async () => {
    await db.insert(appSettings).values({ key: 'storage_stats', value: { at: '2026-10-29T02:00:00Z', bytesOriginals: 100, bytesRenditions: 20, files: 7 } });
    expect((await call('GET', '/api/admin/storage', admin.sid)).json()).toMatchObject({ bytesOriginals: 100, files: 7, inodeLimit: null });
    expect((await call('PATCH', '/api/admin/settings', admin.sid, { tonemapAuto: true })).statusCode).toBe(403);
    expect((await call('PATCH', '/api/admin/settings', admin.sid, { inodeLimit: 250000 })).statusCode).toBe(200);
    expect((await call('GET', '/api/admin/settings', admin.sid)).json()).toEqual({ tonemapAuto: false, tonemapGatePassed: false, inodeLimit: 250000 });
  });
});
