import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assets, events, jobs, renditions } from '@acm/core/db';
import { newId } from '@acm/core/ids';
import { assetDir, originalPath } from '@acm/core/paths';
import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSession } from '../../api/src/auth/sessions.ts';
import { addUser, db, resetDb, testConfig, useApp } from '../../api/test/helpers.ts';
import type { Ctx } from '../src/context.ts';
import { silent } from '../src/log.ts';
import { claim, resetStale, runJob, runUntil } from '../src/runner.ts';

const PY = path.resolve('py/mediaworker/.venv/bin/python');
const media = await mkdtemp(path.join(tmpdir(), 'acm-worker-'));
const fx = await mkdtemp(path.join(tmpdir(), 'acm-wfx-'));
const cfg = testConfig({ MEDIA_ROOT: media, PYTHON: PY });
const ctx: Ctx = { db, cfg, log: silent };
const t = useApp({ MEDIA_ROOT: media });
const SAMPLE_HEIC = path.join(process.env.HOME ?? '', 'Downloads/IMG_0231.HEIC');

beforeAll(() => {
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=3000x2000', '-frames:v', '1', '-y', `${fx}/big.jpg`]);
});

let uploader: string;
let eventId: string;
beforeEach(async () => {
  await resetDb();
  uploader = (await addUser('c@x.qa', { role: 'core' })).id;
  eventId = newId();
  await db.insert(events).values({ id: eventId, title: 'E', slug: 'e', startsOn: '2026-10-10', createdBy: uploader });
});

async function queuedImage(file: string, ext = 'jpg', o: Partial<typeof assets.$inferInsert> = {}) {
  const id = newId();
  await db.insert(assets).values({ id, eventId, kind: 'image', tier: 'member', status: 'queued', originalFilename: `x.${ext}`, originalExt: ext, uploaderId: uploader, ...o });
  await mkdir(assetDir(media, id), { recursive: true });
  await copyFile(file, originalPath(media, id, ext, false));
  const jobId = newId();
  await db.insert(jobs).values({ id: jobId, assetId: id, kind: 'process', priority: 100 });
  return { id, jobId };
}

describe('image jobs', () => {
  it('hashes, renders view/thumb, swaps renditions in and marks ready', async () => {
    const { id, jobId } = await queuedImage(`${fx}/big.jpg`);
    expect(await runUntil(ctx)).toBe(1);
    const [a] = await db.select().from(assets).where(eq(assets.id, id));
    expect(a).toMatchObject({ status: 'ready', width: 3000, height: 2000, renditionRev: 1 });
    expect(a!.originalSha256).toHaveLength(32);
    const rs = await db.select().from(renditions).where(eq(renditions.assetId, id));
    expect(rs.map((r) => [r.kind, r.relPath, r.width]).sort()).toEqual([
      ['image_thumb', 'r1/thumb.webp', 480],
      ['image_view', 'r1/view.webp', 2560],
    ]);
    expect(await readdir(assetDir(media, id))).toEqual(['original.jpg', 'r1']);
    const [j] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(j).toMatchObject({ state: 'done', outcome: 'ok', attempts: 1 });
    expect(existsSync(path.join(media, 'tmp', jobId))).toBe(false);
  });

  it('flags a byte-identical upload in the same event as a duplicate', async () => {
    const first = await queuedImage(`${fx}/big.jpg`);
    const second = await queuedImage(`${fx}/big.jpg`);
    await runUntil(ctx);
    const [b] = await db.select().from(assets).where(eq(assets.id, second.id));
    expect(b!.duplicateOf).toBe(first.id);
  });

  it('re-processing a ready item swaps to r2 and removes r1', async () => {
    const { id } = await queuedImage(`${fx}/big.jpg`);
    await runUntil(ctx);
    await db.insert(jobs).values({ id: newId(), assetId: id, kind: 'reprocess', priority: 100 });
    await runUntil(ctx);
    const [a] = await db.select().from(assets).where(eq(assets.id, id));
    expect([a!.status, a!.renditionRev]).toEqual(['ready', 2]);
    expect((await readdir(assetDir(media, id))).sort()).toEqual(['original.jpg', 'r2']);
  });

  it.runIf(existsSync(SAMPLE_HEIC))('processes HEIC into WebP copies and reads capture metadata', async () => {
    const { id } = await queuedImage(SAMPLE_HEIC, 'heic');
    await runUntil(ctx);
    const [a] = await db.select().from(assets).where(eq(assets.id, id));
    expect(a!.status).toBe('ready');
    expect(a!.capturedAt).not.toBeNull();
    expect((await db.select().from(renditions).where(eq(renditions.assetId, id))).map((r) => r.kind).sort()).toEqual(['image_thumb', 'image_view']);
  });

  it('fails an undecodable file at once, without retries', async () => {
    const bad = path.join(fx, 'bad.jpg');
    await writeFile(bad, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(500, 7)]));
    const { id, jobId } = await queuedImage(bad);
    await runUntil(ctx);
    expect((await db.select().from(jobs).where(eq(jobs.id, jobId)))[0]).toMatchObject({ state: 'failed', lastError: 'decode_failed', attempts: 1 });
    expect((await db.select().from(assets).where(eq(assets.id, id)))[0]!.status).toBe('failed');
  });

  it('retries transient errors with backoff, then fails after max attempts', async () => {
    const { id, jobId } = await queuedImage(`${fx}/big.jpg`);
    const broken: Ctx = { ...ctx, cfg: { ...cfg, PYTHON: '/nonexistent/python' } };
    await runUntil(broken);
    let [j] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(j).toMatchObject({ state: 'queued', attempts: 1, lastError: 'spawn_failed' });
    expect(j!.runAfter.getTime()).toBeGreaterThan(Date.now() + 4 * 60_000);
    for (let i = 0; i < 2; i++) {
      await db.update(jobs).set({ runAfter: new Date(0) }).where(eq(jobs.id, jobId));
      await runUntil(broken);
    }
    [j] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(j).toMatchObject({ state: 'failed', attempts: 3 });
    expect((await db.select().from(assets).where(eq(assets.id, id)))[0]!.status).toBe('failed');
  });

  it('honours cancellation between steps', async () => {
    const { id, jobId } = await queuedImage(`${fx}/big.jpg`);
    const job = (await claim(ctx))!;
    await db.update(jobs).set({ state: 'cancelled' }).where(eq(jobs.id, jobId));
    await runJob(ctx, job);
    expect((await db.select().from(jobs).where(eq(jobs.id, jobId)))[0]!.state).toBe('cancelled');
    expect((await db.select().from(assets).where(eq(assets.id, id)))[0]!.status).toBe('failed');
  });

  it('requeues jobs left running by a dead runner without spending another attempt', async () => {
    const { jobId } = await queuedImage(`${fx}/big.jpg`);
    await claim(ctx); // attempts = 1, then the "runner dies"
    await resetStale(ctx);
    expect((await db.select().from(jobs).where(eq(jobs.id, jobId)))[0]).toMatchObject({ state: 'queued', attempts: 1 });
  });

  it('claims photos before videos, then oldest first', async () => {
    const vid = newId();
    await db.insert(assets).values({ id: vid, eventId, kind: 'video', tier: 'member', status: 'queued', originalFilename: 'v.mov', originalExt: 'mov', uploaderId: uploader });
    await db.insert(jobs).values({ id: newId(), assetId: vid, kind: 'process', priority: 0, createdAt: new Date(Date.now() - 60_000) });
    const { jobId } = await queuedImage(`${fx}/big.jpg`);
    expect((await claim(ctx))!.id).toBe(jobId);
  });

  it('stops claiming after the deadline', async () => {
    await queuedImage(`${fx}/big.jpg`);
    expect(await runUntil(ctx, Date.now() - 1)).toBe(0);
  });
});

describe('purge', () => {
  it('removes files and rows', async () => {
    const { id } = await queuedImage(`${fx}/big.jpg`);
    await runUntil(ctx);
    await db.update(assets).set({ status: 'deleting' }).where(eq(assets.id, id));
    await db.insert(jobs).values({ id: newId(), assetId: id, kind: 'purge', priority: 100 });
    await runUntil(ctx);
    expect(existsSync(assetDir(media, id))).toBe(false);
    expect(await db.select().from(assets).where(eq(assets.id, id))).toHaveLength(0);
  });
});

describe('media routes after processing', () => {
  it('serves thumbs with immutable caching and Range, originals as attachments, and 404s core items for members', async () => {
    const { id } = await queuedImage(`${fx}/big.jpg`, 'jpg', { originalFilename: 'Hackathon – day 1.JPG', originalMime: 'image/jpeg' });
    const core = await queuedImage(`${fx}/big.jpg`, 'jpg', { tier: 'core' });
    await runUntil(ctx);
    const m = await addUser('m@x.qa', { role: 'member' });
    const sid = (await createSession(db, m.id, { ip: null, userAgent: null })).token;
    const get = (url: string, headers: Record<string, string> = {}) => t.app.inject({ method: 'GET', url, headers, cookies: { sid } });

    const thumb = await get(`/api/media/${id}/thumb?v=1`);
    expect([thumb.statusCode, thumb.headers['content-type'], thumb.headers['cache-control']]).toEqual([200, 'image/webp', 'private, max-age=31536000, immutable']);
    expect(thumb.rawPayload.subarray(0, 4).toString()).toBe('RIFF');

    const part = await get(`/api/media/${id}/original`, { range: 'bytes=0-9' });
    expect([part.statusCode, part.rawPayload.length]).toEqual([206, 10]);
    expect(part.headers['content-range']).toMatch(/^bytes 0-9\/\d+$/);
    expect(part.headers['content-disposition']).toContain("filename*=UTF-8''Hackathon%20%E2%80%93%20day%201.JPG");
    expect((await get(`/api/media/${id}/original`, { range: 'bytes=99999999-' })).statusCode).toBe(416);

    expect((await get(`/api/media/${core.id}/thumb`)).statusCode).toBe(404);
    expect((await get(`/api/media/${core.id}/original`)).statusCode).toBe(404);
    expect((await get(`/api/media/${id}/jpeg`)).statusCode).toBe(404); // no JPEG copy for a JPEG original
    expect((await get(`/api/media/${id}/secret`)).statusCode).toBe(404);
  });
});

describe('cleanup', () => {
  it('drops uploads abandoned for 48 h with their tus files, and expired sessions', async () => {
    const { cleanup } = await import('../src/cleanup.ts');
    const tus = path.join(media, 'tus');
    await mkdir(tus, { recursive: true });
    const oldId = newId();
    await db.insert(assets).values({ id: oldId, eventId, kind: 'image', tier: 'member', status: 'uploading', originalFilename: 'a.jpg', originalExt: 'jpg', uploaderId: uploader, uploadId: 'abc123', createdAt: new Date(Date.now() - 49 * 3600_000) });
    const fresh = newId();
    await db.insert(assets).values({ id: fresh, eventId, kind: 'image', tier: 'member', status: 'uploading', originalFilename: 'b.jpg', originalExt: 'jpg', uploaderId: uploader, uploadId: 'def456' });
    await writeFile(path.join(tus, 'abc123'), 'x');
    await writeFile(path.join(tus, 'abc123.json'), '{}');
    await createSession(db, uploader, { ip: null, userAgent: null }, new Date(Date.now() - 31 * 86400_000));
    const r = await cleanup(ctx);
    expect(r).toMatchObject({ abandoned: 1, sessions: 1 });
    expect(existsSync(path.join(tus, 'abc123'))).toBe(false);
    expect((await db.select().from(assets)).map((a) => a.id)).toEqual([fresh]);
  });
});
