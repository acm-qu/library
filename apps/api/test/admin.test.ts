import { accessRequests, appSettings, assets, auditLog, events, jobs, sessions, users } from '@acm/core/db';
import { newId } from '@acm/core/ids';
import { eq, inArray } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createSession } from '../src/auth/sessions.ts';
import { addUser, db, H, useApp } from './helpers.ts';

const t = useApp({ SUPERADMINS: 'tech@qu.acm.org' });
let admin: { id: string; sid: string }; // the super admin
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
    expect((await call('POST', '/api/admin/users', core.sid, { email: 'x@y.qa' })).statusCode).toBe(404);
  });
});

describe('access requests', () => {
  async function pending(email: string, name = 'Huda') {
    const id = newId();
    await db.insert(accessRequests).values({ id, email, name, isFemale: true });
    return id;
  }

  it('lists pending first and hides from non-admins', async () => {
    const old = await pending('old@qu.edu.qa');
    await db.update(accessRequests).set({ status: 'rejected' }).where(eq(accessRequests.id, old));
    await pending('new@qu.edu.qa');
    const r = (await call('GET', '/api/admin/access-requests', admin.sid)).json();
    expect(r.items.map((x: { email: string; status: string }) => [x.email, x.status])).toEqual([['new@qu.edu.qa', 'pending'], ['old@qu.edu.qa', 'rejected']]);
    expect(r.pending).toBe(1);
    expect((await call('GET', '/api/admin/access-requests', core.sid)).statusCode).toBe(404);
    expect((await call('POST', `/api/admin/access-requests/${old}/approve`, core.sid)).statusCode).toBe(404);
  });

  it('approve creates an active core user with the name and isFemale, audits and mails', async () => {
    const id = await pending('huda@qu.edu.qa');
    expect((await call('POST', `/api/admin/access-requests/${id}/approve`, admin.sid)).statusCode).toBe(200);
    const [u] = await db.select().from(users).where(eq(users.email, 'huda@qu.edu.qa'));
    expect(u).toMatchObject({ name: 'Huda', isFemale: true, role: 'core', isAdmin: false, status: 'active', createdBy: admin.id });
    expect((await db.select().from(accessRequests))[0]).toMatchObject({ status: 'approved', decidedBy: admin.id });
    expect((await db.select().from(auditLog).where(eq(auditLog.action, 'access_request.approve'))).length).toBe(1);
    await new Promise((r) => setImmediate(r));
    expect(t.approved).toEqual(['huda@qu.edu.qa']);
    expect((await call('POST', `/api/admin/access-requests/${id}/approve`, admin.sid)).statusCode).toBe(404);
  });

  it('approve answers 409 when the email became a user meanwhile', async () => {
    const id = await pending('late@qu.edu.qa');
    await addUser('late@qu.edu.qa');
    expect((await call('POST', `/api/admin/access-requests/${id}/approve`, admin.sid)).statusCode).toBe(409);
    expect(t.approved).toEqual([]);
  });

  it('reject marks it rejected and audits; a second pending row for one email is refused by the index', async () => {
    const id = await pending('no@qu.edu.qa');
    await expect(pending('no@qu.edu.qa')).rejects.toThrow();
    expect((await call('POST', `/api/admin/access-requests/${id}/reject`, admin.sid)).statusCode).toBe(200);
    expect((await db.select().from(accessRequests))[0]).toMatchObject({ status: 'rejected', decidedBy: admin.id });
    expect((await db.select().from(auditLog).where(eq(auditLog.action, 'access_request.reject'))).length).toBe(1);
    expect((await call('POST', `/api/admin/access-requests/${id}/reject`, admin.sid)).statusCode).toBe(404);
    await pending('no@qu.edu.qa'); // allowed again once the old one is decided
  });
});

describe('members', () => {
  it('adds core accounts or admins (never members) and refuses duplicates', async () => {
    expect((await call('POST', '/api/admin/users', admin.sid, { email: 'New@QU.edu.qa', name: 'New', role: 'member' })).statusCode).toBe(201);
    expect((await call('POST', '/api/admin/users', admin.sid, { email: 'new@qu.edu.qa' })).statusCode).toBe(409);
    expect((await call('POST', '/api/admin/users', admin.sid, { email: 'boss@qu.edu.qa', isAdmin: true, isFemale: false })).statusCode).toBe(201);
    expect((await call('POST', '/api/admin/users', admin.sid, { email: 'x@qu.edu.qa', isFemale: 'other' })).statusCode).toBe(400);
    expect((await call('GET', '/api/admin/users?q=boss', admin.sid)).json().items[0].isFemale).toBe(false);
    expect((await db.select().from(users).where(eq(users.email, 'boss@qu.edu.qa')))[0]).toMatchObject({ isFemale: false });
    const list = (await call('GET', '/api/admin/users?q=new', admin.sid)).json();
    expect(list.items.map((u: { email: string; role: string }) => [u.email, u.role])).toEqual([['new@qu.edu.qa', 'core']]);
    expect(list.counts).toMatchObject({ all: 4, core: 4, admins: 2 });
  });

  it('bulk-adds a pasted list and explains what it skipped', async () => {
    const r = (await call('POST', '/api/admin/users/bulk', admin.sid, { emails: ['a@qu.edu.qa, B@qu.edu.qa\nnot-an-email', 'a@qu.edu.qa', 'c@qu.edu.qa'], isAdmin: true })).json();
    expect(r.created).toBe(2);
    expect((await db.select().from(users).where(eq(users.email, 'b@qu.edu.qa')))[0]).toMatchObject({ role: 'core', isAdmin: true });
    expect(r.skipped).toEqual(expect.arrayContaining([{ email: 'not-an-email', reason: 'invalid' }, { email: 'a@qu.edu.qa', reason: 'duplicate' }, { email: 'c@qu.edu.qa', reason: 'exists' }]));
  });

  it('keeps at least one admin, demotes an admin to core, and ends sessions on disable', async () => {
    expect((await call('PATCH', `/api/admin/users/${core.id}`, admin.sid, { isAdmin: true })).statusCode).toBe(200);
    expect((await call('PATCH', `/api/admin/users/${core.id}`, admin.sid, { isAdmin: false })).statusCode).toBe(200);
    const [demoted] = await db.select().from(users).where(eq(users.id, core.id));
    expect([demoted!.role, demoted!.isAdmin]).toEqual(['core', false]);
    expect((await call('PATCH', `/api/admin/users/${core.id}`, admin.sid, { isAdmin: true })).statusCode).toBe(200);
    // With the super admin disabled outside the API, the last active admin can't disable themselves.
    await db.update(users).set({ status: 'disabled' }).where(eq(users.id, admin.id));
    const last = await call('PATCH', `/api/admin/users/${core.id}`, core.sid, { status: 'disabled' });
    expect([last.statusCode, last.json().message]).toEqual([403, 'There has to be at least one admin.']);
    await db.update(users).set({ status: 'active' }).where(eq(users.id, admin.id));
    admin.sid = (await createSession(db, admin.id, { ip: null, userAgent: null })).token;
    expect((await call('PATCH', `/api/admin/users/${core.id}`, admin.sid, { status: 'disabled' })).statusCode).toBe(200);
    expect(await db.select().from(sessions).where(eq(sessions.userId, core.id))).toHaveLength(0);
    expect((await db.select().from(auditLog)).map((a) => a.action).filter((a) => a === 'user.update')).toHaveLength(4);
  });
});

describe('super admin', () => {
  let lead: { id: string; sid: string };
  beforeEach(async () => {
    lead = await who('lead@qu.edu.qa', { role: 'core', isAdmin: true });
  });
  const refused = (r: { statusCode: number; json: () => { error: string } }) => expect([r.statusCode, r.json().error]).toEqual([403, 'not_allowed']);

  it('alone makes and removes admins, and owns their own account', async () => {
    refused(await call('PATCH', `/api/admin/users/${core.id}`, lead.sid, { isAdmin: true }));
    refused(await call('PATCH', `/api/admin/users/${lead.id}`, lead.sid, { isAdmin: false }));
    refused(await call('POST', '/api/admin/users', lead.sid, { email: 'boss@qu.edu.qa', isAdmin: true }));
    refused(await call('POST', '/api/admin/users/bulk', lead.sid, { emails: ['b@qu.edu.qa'], isAdmin: true }));
    expect(await db.select().from(users).where(inArray(users.email, ['boss@qu.edu.qa', 'b@qu.edu.qa']))).toHaveLength(0);
    for (const b of [{ status: 'disabled' }, { name: 'X' }, { isAdmin: false }]) refused(await call('PATCH', `/api/admin/users/${admin.id}`, lead.sid, b));
    // Everything else stays open to every admin.
    expect((await call('POST', '/api/admin/users', lead.sid, { email: 'plain@qu.edu.qa' })).statusCode).toBe(201);
    expect((await call('POST', '/api/admin/users/bulk', lead.sid, { emails: ['b@qu.edu.qa'] })).json().created).toBe(1);
    expect((await call('PATCH', `/api/admin/users/${core.id}`, lead.sid, { name: 'Core', isAdmin: false })).statusCode).toBe(200);

    expect((await call('PATCH', `/api/admin/users/${core.id}`, admin.sid, { isAdmin: true })).statusCode).toBe(200);
    expect((await call('PATCH', `/api/admin/users/${lead.id}`, admin.sid, { isAdmin: false })).statusCode).toBe(200);
    const flags = await db.select({ email: users.email, isAdmin: users.isAdmin }).from(users).where(inArray(users.id, [core.id, lead.id]));
    expect(Object.fromEntries(flags.map((u) => [u.email, u.isAdmin]))).toEqual({ 'c@qu.edu.qa': true, 'lead@qu.edu.qa': false });
    // Configured in SUPERADMINS, so not demotable or disablable here, even by themselves.
    refused(await call('PATCH', `/api/admin/users/${admin.id}`, admin.sid, { isAdmin: false }));
    refused(await call('PATCH', `/api/admin/users/${admin.id}`, admin.sid, { status: 'disabled' }));
    expect((await call('PATCH', `/api/admin/users/${admin.id}`, admin.sid, { name: 'Tech' })).statusCode).toBe(200);
  });

  it('is reported by /api/me and the members list', async () => {
    for (const [v, want] of [[admin, true], [lead, false], [core, false]] as const) expect((await call('GET', '/api/me', v.sid)).json().isSuperadmin).toBe(want);
    const items: { email: string; isSuperadmin: boolean }[] = (await call('GET', '/api/admin/users', lead.sid)).json().items;
    expect(Object.fromEntries(items.map((u) => [u.email, u.isSuperadmin]))).toEqual({ 'tech@qu.acm.org': true, 'lead@qu.edu.qa': false, 'c@qu.edu.qa': false });
  });

  it('leaves approvals to every admin, always as core non-admins', async () => {
    const id = newId();
    await db.insert(accessRequests).values({ id, email: 'huda@qu.edu.qa', name: 'Huda', isFemale: true });
    expect((await call('POST', `/api/admin/access-requests/${id}/approve`, lead.sid)).statusCode).toBe(200);
    expect((await db.select().from(users).where(eq(users.email, 'huda@qu.edu.qa')))[0]).toMatchObject({ role: 'core', isAdmin: false });
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
    // No worker heartbeat yet: no ETAs, rather than a clock that slides forward.
    expect(q.items.map((j: { readyInS: number | null }) => j.readyInS)).toEqual([null, null]);
    await db.insert(appSettings).values({ key: 'worker_tick', value: new Date().toISOString() });
    q = (await call('GET', '/api/admin/jobs?tab=queued', admin.sid)).json();
    expect(q.items[1].readyInS).toBeGreaterThan(q.items[0].readyInS);
    // A job waiting out a retry backoff has no ETA and doesn't delay the others.
    const before = q.items[1].readyInS;
    await db.update(jobs).set({ runAfter: new Date(Date.now() + 300_000) }).where(eq(jobs.id, j1));
    q = (await call('GET', '/api/admin/jobs?tab=queued', admin.sid)).json();
    expect(q.items[0].readyInS).toBeNull();
    expect(q.items[1].readyInS).toBeLessThan(before);
    await db.update(jobs).set({ runAfter: new Date() }).where(eq(jobs.id, j1));

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
  it('reports nightly stats and allows auto curves before the validation gate', async () => {
    await db.insert(appSettings).values({ key: 'storage_stats', value: { at: '2026-10-29T02:00:00Z', bytesOriginals: 100, bytesRenditions: 20, files: 7 } });
    expect((await call('GET', '/api/admin/storage', admin.sid)).json()).toMatchObject({ bytesOriginals: 100, files: 7, inodeLimit: null });
    expect((await call('PATCH', '/api/admin/settings', admin.sid, { tonemapAuto: true })).statusCode).toBe(200);
    expect((await call('PATCH', '/api/admin/settings', admin.sid, { inodeLimit: 250000 })).statusCode).toBe(200);
    expect((await call('GET', '/api/admin/settings', admin.sid)).json()).toEqual({ tonemapAuto: true, tonemapGatePassed: false, inodeLimit: 250000 });
  });
});
