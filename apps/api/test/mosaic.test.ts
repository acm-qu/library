import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assets, events, renditions } from '@acm/core/db';
import { newId } from '@acm/core/ids';
import { assetDir } from '@acm/core/paths';
import { afterAll, describe, expect, it } from 'vitest';
import { buildMosaic } from '../src/routes/mosaic.ts';
import { addUser, db, useApp } from './helpers.ts';

const t = useApp();
const media = '/tmp';
const made: string[] = [];
afterAll(() => Promise.all(made.map((id) => rm(assetDir(media, id), { recursive: true, force: true }))));

async function photo(eventId: string, uploaderId: string, o: Partial<typeof assets.$inferInsert> = {}) {
  const id = newId();
  made.push(id);
  await db.insert(assets).values({ id, eventId, kind: 'image', tier: 'member', status: 'ready', originalFilename: 'p.jpg', originalExt: 'jpg', uploaderId, ...o });
  await db.insert(renditions).values({ id: newId(), assetId: id, kind: 'image_thumb', bytes: 4, relPath: 'r0/thumb.webp', width: 480, height: 320, settingsVersion: 1 });
  await mkdir(path.join(assetDir(media, id), 'r0'), { recursive: true });
  await writeFile(path.join(assetDir(media, id), 'r0/thumb.webp'), id); // the file's bytes are its id, so we can tell which came back
  return id;
}

describe('sign-in mosaic', () => {
  it('inlines only ready public non-girls-only photos, in one response', async () => {
    const u = await addUser('c@qu.edu.qa', { role: 'core' });
    const ev = newId();
    await db.insert(events).values({ id: ev, title: 'E', slug: 'e', startsOn: '2026-10-10', createdBy: u.id });
    const pub = await photo(ev, u.id);
    await photo(ev, u.id, { tier: 'core' });
    await photo(ev, u.id, { girlsOnly: true });
    await photo(ev, u.id, { status: 'processing' });
    await photo(ev, u.id, { deletedAt: new Date() });

    const m = await buildMosaic(db, media);
    expect(m.images).toHaveLength(1);
    expect(m.images[0]).toMatchObject({ width: 480, height: 320 });
    expect(Buffer.from(m.images[0]!.src.replace('data:image/webp;base64,', ''), 'base64').toString()).toBe(pub);

    const res = await t.app.inject({ method: 'GET', url: '/api/public/login-mosaic' }); // signed out
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toContain('max-age=600');
    expect(res.json().images).toHaveLength(1);
  });
});
