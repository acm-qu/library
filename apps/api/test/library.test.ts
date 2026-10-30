import { appSettings, assets, auditLog, events, jobs, renditions, users } from '@acm/core/db';
import { newId } from '@acm/core/ids';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createSession } from '../src/auth/sessions.ts';
import { addUser, db, H, useApp } from './helpers.ts';

const t = useApp();
let member: string, core: string, admin: string, coreId: string, adminId: string;

async function cookieFor(email: string, role: 'member' | 'core', isAdmin = false, isFemale = true) {
  const u = await addUser(email, { role, isAdmin, isFemale });
  return { id: u.id, sid: (await createSession(db, u.id, { ip: null, userAgent: null })).token };
}
const get = (url: string, sid: string) => t.app.inject({ method: 'GET', url, cookies: { sid } });
const send = (method: 'POST' | 'PATCH' | 'DELETE', url: string, sid: string, payload?: object) =>
  t.app.inject({ method, url, headers: H, cookies: { sid }, ...(payload ? { payload } : {}) });

async function addEvent(title: string, startsOn: string, by = coreId) {
  const id = newId();
  await db.insert(events).values({ id, title, slug: `${startsOn}-${title.toLowerCase().replace(/\W+/g, '-')}`, startsOn, createdBy: by });
  return id;
}
async function addAsset(eventId: string, o: Partial<typeof assets.$inferInsert> = {}) {
  const id = newId();
  await db.insert(assets).values({ id, eventId, kind: 'image', tier: 'member', status: 'ready', originalFilename: 'IMG.HEIC', originalExt: 'heic', uploaderId: coreId, width: 4032, height: 3024, ...o });
  return id;
}

beforeEach(async () => {
  ({ sid: member } = await cookieFor('m@qu.edu.qa', 'member'));
  ({ sid: core, id: coreId } = await cookieFor('c@qu.edu.qa', 'core'));
  ({ sid: admin, id: adminId } = await cookieFor('a@qu.edu.qa', 'core', true));
});

describe('GET /events', () => {
  it('counts and covers per viewer, and hides core-only events from members', async () => {
    const hack = await addEvent('Hackathon day 1', '2026-10-17');
    const retreat = await addEvent('Core team retreat', '2026-08-28');
    await addEvent('Empty', '2026-01-01');
    const coreCover = await addAsset(hack, { tier: 'core', capturedAt: new Date('2026-10-17T08:00:00Z') });
    const memberPhoto = await addAsset(hack, { capturedAt: new Date('2026-10-17T09:00:00Z') });
    await addAsset(hack, { kind: 'video', durationS: 30 });
    await addAsset(hack, { status: 'processing' });
    await addAsset(retreat, { tier: 'core' });
    await db.update(events).set({ coverAssetId: coreCover }).where(eq(events.id, hack));

    const m = (await get('/api/events', member)).json();
    expect(m.items.map((e: { title: string }) => e.title)).toEqual(['Hackathon day 1']);
    expect(m.items[0]).toMatchObject({ photoCount: 1, videoCount: 1, hasCore: false, coverUrl: `/api/media/${memberPhoto}/thumb?v=0` });

    const c = (await get('/api/events', core)).json();
    expect(c.items.map((e: { title: string }) => e.title)).toEqual(['Hackathon day 1', 'Core team retreat', 'Empty']);
    expect(c.items[0]).toMatchObject({ photoCount: 2, videoCount: 1, hasCore: true, coverUrl: `/api/media/${coreCover}/thumb?v=0` });
  });

  it('pages with an opaque cursor and filters by year, search and videos', async () => {
    for (let i = 1; i <= 5; i++) await addEvent(`Workshop ${i}`, `2025-0${i}-10`);
    const hack = await addEvent('Hack Night', '2026-03-01');
    await addAsset(hack, { kind: 'video', durationS: 5 });
    const p1 = (await get('/api/events?limit=4', core)).json();
    const p2 = (await get(`/api/events?limit=4&cursor=${p1.nextCursor}`, core)).json();
    expect([...p1.items, ...p2.items].map((e: { title: string }) => e.title)).toEqual(['Hack Night', 'Workshop 5', 'Workshop 4', 'Workshop 3', 'Workshop 2', 'Workshop 1']);
    expect(p2.nextCursor).toBeNull();
    expect((await get('/api/events?year=2025', core)).json().items).toHaveLength(5);
    expect((await get('/api/events?q=hack%20nig', core)).json().items.map((e: { title: string }) => e.title)).toEqual(['Hack Night']);
    expect((await get('/api/events?hasVideos=true', core)).json().items).toHaveLength(1);
    expect((await get('/api/events?cursor=garbage', core)).statusCode).toBe(200);
    expect((await get('/api/events/years', core)).json().years).toEqual([2026, 2025]);
  });

  it('404s a member on an event with nothing visible, by id and by slug', async () => {
    const retreat = await addEvent('Core team retreat', '2026-08-28');
    await addAsset(retreat, { tier: 'core' });
    expect((await get(`/api/events/${retreat}`, member)).statusCode).toBe(404);
    expect((await get('/api/events/2026-08-28-core-team-retreat', member)).statusCode).toBe(404);
    expect((await get('/api/events/2026-08-28-core-team-retreat', core)).json().id).toBe(retreat);
  });
});

describe('signed-out visitors', () => {
  it('browse the member tier like a member, without uploader names, and get 404 for core', async () => {
    const ev = await addEvent('Hackathon', '2026-10-17');
    const pub = await addAsset(ev);
    const hidden = await addAsset(ev, { tier: 'core' });
    await addEvent('Core only', '2026-09-01').then((id) => addAsset(id, { tier: 'core' }));
    const anon = (url: string) => t.app.inject({ method: 'GET', url });

    expect((await anon('/api/events')).json().items.map((e: { title: string }) => e.title)).toEqual(['Hackathon']);
    expect((await anon(`/api/events/${ev}/assets`)).json().items.map((x: { id: string }) => x.id)).toEqual([pub]);
    const detail = await anon(`/api/assets/${pub}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ uploader: null, canEdit: false, canDelete: false });
    expect((await anon(`/api/assets/${hidden}`)).statusCode).toBe(404);
    expect((await anon(`/api/media/${hidden}/thumb`)).statusCode).toBe(404);
    expect((await get(`/api/assets/${pub}`, member)).json().uploader).toMatchObject({ id: coreId });
  });
});

describe('girls only', () => {
  it('shows girls-only items, and events holding only them, to female core members alone; the uploader keeps a status row', async () => {
    const { sid: maleAdmin } = await cookieFor('ma@qu.edu.qa', 'core', true, false);
    const { sid: maleCore, id: maleId } = await cookieFor('mc@qu.edu.qa', 'core', false, false);
    const mixed = await addEvent('Mixed', '2026-10-17');
    const girlsNight = await addEvent('Girls night', '2026-10-01');
    const pub = await addAsset(mixed);
    const girls = await addAsset(mixed, { girlsOnly: true, uploaderId: maleId });
    const onlyGirls = await addAsset(girlsNight, { tier: 'core', girlsOnly: true });
    const anon = (url: string) => t.app.inject({ method: 'GET', url });
    const titles = async (sid?: string) => (await (sid ? get('/api/events', sid) : anon('/api/events'))).json().items.map((e: { title: string; photoCount: number }) => `${e.title}:${e.photoCount}`);

    expect(await titles(core)).toEqual(['Mixed:2', 'Girls night:1']);
    expect(await titles(admin)).toEqual(['Mixed:2', 'Girls night:1']);
    for (const sid of [maleAdmin, maleCore, member, undefined]) expect(await titles(sid)).toEqual(['Mixed:1']);
    expect((await get(`/api/events/${mixed}/assets`, maleAdmin)).json().items.map((x: { id: string }) => x.id)).toEqual([pub]);
    expect((await get(`/api/events/${girlsNight}`, maleAdmin)).statusCode).toBe(404);
    // Nor can he edit or delete an event that is hidden from him.
    expect((await send('PATCH', `/api/events/${girlsNight}`, maleAdmin, { title: 'x' })).statusCode).toBe(404);
    expect((await send('DELETE', `/api/events/${girlsNight}`, maleAdmin)).statusCode).toBe(404);
    // A visible event that still holds girls-only items needs a female admin to delete it.
    expect((await send('DELETE', `/api/events/${mixed}`, maleAdmin)).statusCode).toBe(403);
    expect((await get(`/api/events/${mixed}`, maleAdmin)).statusCode).toBe(200);
    expect((await get(`/api/assets/${girls}`, core)).json()).toMatchObject({ girlsOnly: true, canEdit: false });
    for (const sid of [maleAdmin, maleCore]) expect((await get(`/api/assets/${girls}`, sid)).statusCode).toBe(404);
    expect((await anon(`/api/assets/${girls}`)).statusCode).toBe(404);
    // The male uploader still sees his upload's status (no media URLs exist on that row).
    const mine = (await get('/api/uploads/mine', maleCore)).json().items;
    expect(mine.map((i: { assetId: string; girlsOnly: boolean }) => [i.assetId, i.girlsOnly])).toEqual([[girls, true]]);
    expect((await get(`/api/uploads/existing?eventId=${mixed}`, maleCore)).json().items).toHaveLength(1);

    // Admin › Item and the queue: a male admin gets 404 for the item and a queue row without its details.
    await db.insert(jobs).values({ id: newId(), assetId: onlyGirls, kind: 'process' });
    expect((await get(`/api/admin/assets/${onlyGirls}/processing`, maleAdmin)).statusCode).toBe(404);
    expect((await get(`/api/admin/assets/${onlyGirls}/processing`, admin)).json().asset).toMatchObject({ girlsOnly: true });
    expect((await get('/api/admin/jobs?tab=queued', maleAdmin)).json().items.map((j: { asset: unknown }) => j.asset)).toEqual([null]);
    expect((await get('/api/admin/jobs?tab=queued', admin)).json().items[0].asset).toMatchObject({ id: onlyGirls });

    // Editing: a male admin can't reach it; a female admin turns it off and it's audited.
    expect((await send('PATCH', `/api/assets/${girls}`, maleAdmin, { girlsOnly: false })).statusCode).toBe(404);
    expect((await send('PATCH', `/api/assets/${girls}`, admin, { girlsOnly: false })).statusCode).toBe(200);
    expect((await get(`/api/assets/${girls}`, maleAdmin)).json()).toMatchObject({ girlsOnly: false });
    expect((await send('PATCH', `/api/assets/${pub}`, maleAdmin, { girlsOnly: true })).statusCode).toBe(200);
    expect((await get(`/api/assets/${pub}`, maleAdmin)).statusCode).toBe(404);
    expect((await db.select().from(auditLog)).map((r) => [r.action, r.data])).toEqual([
      ['asset.girls_only', { from: true, to: false }],
      ['asset.girls_only', { from: false, to: true }],
    ]);
  });

});

describe('event writes', () => {
  it('core creates events with immutable, unique slugs; members get 404', async () => {
    const body = { title: 'Hackathon, day 1', startsOn: '2026-10-28', defaultTier: 'member' };
    expect((await send('POST', '/api/events', member, body)).statusCode).toBe(404);
    const a = await send('POST', '/api/events', core, body);
    expect(a.statusCode).toBe(201);
    expect(a.json().slug).toBe('2026-10-28-hackathon-day-1');
    expect((await send('POST', '/api/events', core, body)).json().slug).toBe('2026-10-28-hackathon-day-1-2');
    const ar = (await send('POST', '/api/events', core, { ...body, title: 'هاكاثون' })).json();
    expect(ar.slug).toMatch(/^2026-10-28-[0-9a-f]{8}$/);
    const renamed = (await send('PATCH', `/api/events/${a.json().id}`, core, { title: 'Renamed' })).json();
    expect(renamed).toMatchObject({ title: 'Renamed', slug: '2026-10-28-hackathon-day-1' });
    expect((await db.select().from(auditLog)).map((r) => r.action).sort()).toEqual(['event.create', 'event.create', 'event.create', 'event.update']);
  });

  it('validates dates and covers', async () => {
    const id = await addEvent('E', '2026-10-10');
    expect((await send('PATCH', `/api/events/${id}`, core, { endsOn: '2026-10-01' })).statusCode).toBe(400);
    const other = await addEvent('Other', '2026-10-11');
    const foreign = await addAsset(other);
    expect((await send('PATCH', `/api/events/${id}`, core, { coverAssetId: foreign })).statusCode).toBe(400);
  });

  it('only admins delete; deleting queues purges and hides the event', async () => {
    const id = await addEvent('E', '2026-10-10');
    const a = await addAsset(id);
    expect((await send('DELETE', `/api/events/${id}`, core)).statusCode).toBe(404);
    expect((await send('DELETE', `/api/events/${id}`, admin)).statusCode).toBe(204);
    expect((await get(`/api/events/${id}`, admin)).statusCode).toBe(404);
    expect((await get(`/api/assets/${a}`, admin)).statusCode).toBe(404);
    const [job] = await db.select().from(jobs);
    expect(job).toMatchObject({ assetId: a, kind: 'purge', priority: 100 });
  });
});

describe('event assets', () => {
  it('lists in capture order with cursors; members see only ready member-tier', async () => {
    const ev = await addEvent('E', '2026-10-10');
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(await addAsset(ev, { capturedAt: new Date(Date.UTC(2026, 9, 10, 10, i)) }));
    await addAsset(ev, { tier: 'core', capturedAt: new Date(Date.UTC(2026, 9, 10, 11)) });
    const mine = await addAsset(ev, { status: 'processing', uploaderId: coreId });
    await db.insert(jobs).values({ id: newId(), assetId: mine, kind: 'process', state: 'running', step: 'Encoding 720p', progress: 0.5 });
    await db.insert(appSettings).values({ key: 'worker_tick', value: new Date().toISOString() });

    const p1 = (await get(`/api/events/${ev}/assets?limit=3`, member)).json();
    const p2 = (await get(`/api/events/${ev}/assets?limit=3&cursor=${p1.nextCursor}`, member)).json();
    expect([...p1.items, ...p2.items].map((x: { id: string }) => x.id)).toEqual(ids);
    expect(p1.items[0]).toMatchObject({ width: 4032, height: 3024, thumbUrl: `/api/media/${ids[0]}/thumb?v=0`, step: null });

    const c = (await get(`/api/events/${ev}/assets?limit=100`, core)).json();
    expect(c.items).toHaveLength(7);
    const tile = c.items.find((x: { id: string }) => x.id === mine);
    expect(tile).toMatchObject({ status: 'processing', step: 'Encoding 720p', progress: 0.5, thumbUrl: null });
    expect(tile.readyInS).toBeGreaterThanOrEqual(0);
    expect((await get(`/api/events/${ev}/assets?tier=core`, core)).json().items).toHaveLength(1);
    expect((await get(`/api/events/${ev}/assets?tier=core`, member)).json().items).toHaveLength(5);
    expect((await get(`/api/events/${ev}/assets?kind=video`, core)).json().items).toHaveLength(0);
  });
});

describe('asset detail and edits', () => {
  it('returns media links by access level and 404s what the viewer may not see', async () => {
    const ev = await addEvent('E', '2026-10-10');
    const heic = await addAsset(ev);
    await db.insert(renditions).values([
      { id: newId(), assetId: heic, kind: 'image_view', bytes: 1, relPath: 'r0/view.webp', settingsVersion: 1 },
    ]);
    const d = (await get(`/api/assets/${heic}`, member)).json();
    expect(d).toMatchObject({ viewUrl: `/api/media/${heic}/view?v=0`, originalUrl: `/api/media/${heic}/original`, canEdit: false, canDelete: false, downloadName: 'IMG.HEIC' });
    const coreItem = await addAsset(ev, { tier: 'core' });
    expect((await get(`/api/assets/${coreItem}`, member)).statusCode).toBe(404);
    expect((await get('/api/assets/not-a-uuid', member)).statusCode).toBe(404);
    const keepOnly = await addAsset(ev, { status: 'original_only' });
    expect((await get(`/api/assets/${keepOnly}`, member)).json()).toMatchObject({ viewUrl: null, originalUrl: `/api/media/${keepOnly}/original` });
  });

  it('lets an uploader change tier and move their own item; others get 404', async () => {
    const ev = await addEvent('E', '2026-10-10');
    const other = await addEvent('F', '2026-10-11');
    const a = await addAsset(ev, { uploaderId: coreId });
    const theirs = await addAsset(ev, { uploaderId: adminId });
    expect((await send('PATCH', `/api/assets/${theirs}`, core, { tier: 'core' })).statusCode).toBe(404);
    expect((await send('PATCH', `/api/assets/${a}`, member, { tier: 'core' })).statusCode).toBe(404);
    expect((await send('PATCH', `/api/assets/${a}`, core, { tier: 'core', eventId: other })).statusCode).toBe(200);
    expect((await get(`/api/assets/${a}`, member)).statusCode).toBe(404);
    expect((await send('PATCH', `/api/assets/${theirs}`, admin, { tier: 'core' })).statusCode).toBe(200);
    const actions = (await db.select().from(auditLog)).map((r) => r.action).sort();
    expect(actions).toEqual(['asset.move', 'asset.tier', 'asset.tier']);
  });

  it('admin delete marks deleting, cancels queued work and queues a purge', async () => {
    const ev = await addEvent('E', '2026-10-10');
    const a = await addAsset(ev, { status: 'queued' });
    await db.insert(jobs).values({ id: newId(), assetId: a, kind: 'process' });
    expect((await send('DELETE', `/api/assets/${a}`, core)).statusCode).toBe(404);
    expect((await send('DELETE', `/api/assets/${a}`, admin)).statusCode).toBe(204);
    const js = await db.select().from(jobs).where(eq(jobs.assetId, a));
    expect(js.map((j) => `${j.kind}:${j.state}`).sort()).toEqual(['process:cancelled', 'purge:queued']);
    expect((await get(`/api/assets/${a}`, admin)).statusCode).toBe(404);
  });
});
