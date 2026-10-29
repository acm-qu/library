import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assetKeys, assets, events, jobs, renditions } from '@acm/core/db';
import { newId } from '@acm/core/ids';
import { assetDir, originalPath } from '@acm/core/paths';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../api/src/app.ts';
import { createSession } from '../../api/src/auth/sessions.ts';
import { addUser, db, resetDb, testConfig } from '../../api/test/helpers.ts';
import type { Ctx } from '../src/context.ts';
import { silent } from '../src/log.ts';
import { runUntil } from '../src/runner.ts';

const PY = path.resolve('py/mediaworker/.venv/bin/python');
const media = await mkdtemp(path.join(tmpdir(), 'acm-enc-'));
const keys = await mkdtemp(path.join(tmpdir(), 'acm-keys-'));
const fx = await mkdtemp(path.join(tmpdir(), 'acm-efx-'));
const cfg = testConfig({ MEDIA_ROOT: media, KEYS_DIR: keys, PYTHON: PY });
const ctx: Ctx = { db, cfg, log: silent };
let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1600x1200', '-frames:v', '1', `${fx}/p.jpg`]);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-t', '3', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', `${fx}/v.mp4`]);
  app = await buildApp({ cfg, db, logger: false, mailer: { sendSignInCode: async () => {} } });
});
afterAll(() => app.close());

let uploader: string;
let eventId: string;
let memberSid: string;
let coreSid: string;
beforeEach(async () => {
  await resetDb();
  const c = await addUser('c@x.qa', { role: 'core' });
  uploader = c.id;
  coreSid = (await createSession(db, c.id, { ip: null, userAgent: null })).token;
  memberSid = (await createSession(db, (await addUser('m@x.qa')).id, { ip: null, userAgent: null })).token;
  eventId = newId();
  await db.insert(events).values({ id: eventId, title: 'E', slug: 'e', startsOn: '2026-10-10', createdBy: uploader });
});

async function queued(file: string, kind: 'image' | 'video', tier: 'member' | 'core') {
  const id = newId();
  const ext = path.extname(file).slice(1);
  await db.insert(assets).values({ id, eventId, kind, tier, status: 'queued', originalFilename: path.basename(file), originalExt: ext, originalMime: kind === 'image' ? 'image/jpeg' : 'video/mp4', uploaderId: uploader });
  await mkdir(assetDir(media, id), { recursive: true });
  await copyFile(file, originalPath(media, id, ext, false));
  await db.insert(jobs).values({ id: newId(), assetId: id, kind: 'process', priority: 100 });
  return id;
}
const get = (url: string, sid: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url, headers, cookies: { sid } });

async function allFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await allFiles(p)));
    else out.push(path.relative(media, p));
  }
  return out;
}

describe('core-tier images', () => {
  it('stores only sealed files and serves them decrypted, with Range', async () => {
    const id = await queued(`${fx}/p.jpg`, 'image', 'core');
    await runUntil(ctx);
    const [a] = await db.select().from(assets).where(eq(assets.id, id));
    expect(a).toMatchObject({ status: 'ready', encrypted: true });
    const files = (await allFiles(assetDir(media, id))).map((f) => path.basename(f)).sort();
    expect(files).toEqual(['original.jpg.enc', 'thumb.webp.enc', 'view.webp.enc']);
    expect((await allFiles(path.join(media, 'tmp'))).length).toBe(0);
    const sealed = await readFile(originalPath(media, id, 'jpg', true));
    expect(sealed.subarray(0, 8).toString()).toBe('ACMENC01');

    const plain = await readFile(`${fx}/p.jpg`);
    const whole = await get(`/api/media/${id}/original`, coreSid);
    expect(whole.statusCode).toBe(200);
    expect(Buffer.compare(whole.rawPayload, plain)).toBe(0);
    const part = await get(`/api/media/${id}/original`, coreSid, { range: 'bytes=100-1099' });
    expect([part.statusCode, part.headers['content-range']]).toEqual([206, `bytes 100-1099/${plain.length}`]);
    expect(Buffer.compare(part.rawPayload, plain.subarray(100, 1100))).toBe(0);
    const thumb = await get(`/api/media/${id}/thumb`, coreSid);
    expect(thumb.rawPayload.subarray(8, 12).toString()).toBe('WEBP');
    expect((await get(`/api/media/${id}/thumb`, memberSid)).statusCode).toBe(404);
  });

  it('retiers both ways without re-rendering, and drops the keys when going back to member', async () => {
    const id = await queued(`${fx}/p.jpg`, 'image', 'member');
    await runUntil(ctx);
    const tier = (t: string) => app.inject({ method: 'PATCH', url: `/api/assets/${id}`, headers: { 'x-requested-with': 'acm-media' }, cookies: { sid: coreSid }, payload: { tier: t } });
    expect((await tier('core')).statusCode).toBe(200);
    expect((await get(`/api/media/${id}/view`, memberSid)).statusCode).toBe(404); // immediately, before the job runs
    await runUntil(ctx);
    let [a] = await db.select().from(assets).where(eq(assets.id, id));
    expect([a!.encrypted, a!.renditionRev]).toEqual([true, 2]);
    expect((await db.select().from(renditions).where(eq(renditions.assetId, id))).every((r) => r.encrypted && r.relPath.endsWith('.enc'))).toBe(true);
    expect((await get(`/api/media/${id}/view`, coreSid)).rawPayload.subarray(8, 12).toString()).toBe('WEBP');

    await tier('member');
    await runUntil(ctx);
    [a] = await db.select().from(assets).where(eq(assets.id, id));
    expect([a!.encrypted, a!.renditionRev]).toEqual([false, 3]);
    expect(existsSync(originalPath(media, id, 'jpg', false))).toBe(true);
    expect(await db.select().from(assetKeys).where(eq(assetKeys.assetId, id))).toHaveLength(0);
    expect((await get(`/api/media/${id}/view`, memberSid)).statusCode).toBe(200);
  });
});

describe('core-tier video', () => {
  it('encrypts segments with AES-128, serves the key only to core, and seals poster, thumb and original', async () => {
    const id = await queued(`${fx}/v.mp4`, 'video', 'core');
    await runUntil(ctx);
    const [a] = await db.select().from(assets).where(eq(assets.id, id));
    expect(a).toMatchObject({ status: 'ready', encrypted: true });
    const idx = (await get(`/api/media/${id}/hls/360p/index.m3u8`, coreSid)).body;
    expect(idx).toContain(`#EXT-X-KEY:METHOD=AES-128,URI="/api/media/${id}/hls/key"`);
    const ts = await readFile(path.join(assetDir(media, id), 'r1', 'hls', '360p', 'data.ts'));
    expect(ts[0]).not.toBe(0x47); // not a plaintext MPEG-TS sync byte
    const key = await get(`/api/media/${id}/hls/key`, coreSid);
    expect([key.statusCode, key.rawPayload.length, key.headers['cache-control']]).toEqual([200, 16, 'no-store']);
    expect((await get(`/api/media/${id}/hls/key`, memberSid)).statusCode).toBe(404);
    expect(await readdir(keys)).toEqual([]); // keyinfo and key files removed after the encode
    expect((await allFiles(assetDir(media, id))).filter((f) => /poster|thumb|original/.test(f)).every((f) => f.endsWith('.enc'))).toBe(true);
    // The served key decrypts the first segment back to MPEG-TS.
    const m = /#EXT-X-BYTERANGE:(\d+)@(\d+)/.exec(idx)!;
    const { createDecipheriv } = await import('node:crypto');
    const d = createDecipheriv('aes-128-cbc', key.rawPayload, Buffer.alloc(16));
    const seg = Buffer.concat([d.update(ts.subarray(Number(m[2]), Number(m[2]) + Number(m[1]))), d.final()]);
    expect(seg[0]).toBe(0x47);
  }, 120_000);
});

describe('master key rotation', () => {
  it('re-wraps every key so files still open under the new master', async () => {
    const { rotate } = await import('../../../scripts/rotate-master-key.ts');
    const id = await queued(`${fx}/p.jpg`, 'image', 'core');
    await runUntil(ctx);
    const newKey = Buffer.alloc(32, 9).toString('base64');
    expect(await rotate(cfg.DATABASE_URL, cfg.MASTER_KEY, newKey)).toBe(1);
    expect((await get(`/api/media/${id}/thumb`, coreSid)).statusCode).toBe(500); // the running app still has the old key
    const app2 = await buildApp({ cfg: { ...cfg, MASTER_KEY: newKey }, db, logger: false, mailer: { sendSignInCode: async () => {} } });
    const r = await app2.inject({ method: 'GET', url: `/api/media/${id}/thumb`, cookies: { sid: coreSid } });
    expect(r.rawPayload.subarray(8, 12).toString()).toBe('WEBP');
    await app2.close();
  });
});
