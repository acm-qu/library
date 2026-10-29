import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assets, events, jobs } from '@acm/core/db';
import { newId } from '@acm/core/ids';
import { originalPath } from '@acm/core/paths';
import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSession } from '../src/auth/sessions.ts';
import { parseFfprobe, probeImage, probeVideo } from '../src/uploads/probe.ts';
import { sniffBuffer, sniffFile } from '../src/uploads/sniff.ts';
import { addUser, db, H, useApp } from './helpers.ts';

const media = await mkdtemp(path.join(tmpdir(), 'acm-media-'));
const fx = await mkdtemp(path.join(tmpdir(), 'acm-fx-'));
const t = useApp({ MEDIA_ROOT: media, FFPROBE: 'ffprobe' });
const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const SAMPLE_MOV = path.join(process.env.HOME ?? '', 'Downloads/IMG_4515.MOV');
const SAMPLE_HEIC = path.join(process.env.HOME ?? '', 'Downloads/IMG_0231.HEIC');

beforeAll(() => {
  if (!hasFfmpeg) return;
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x480', '-frames:v', '1', '-y', `${fx}/photo.jpg`]);
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=480x854:rate=30', '-t', '2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-y', `${fx}/clip.mp4`]);
});

let core: { id: string; sid: string };
let member: string;
let eventId: string;
beforeEach(async () => {
  const c = await addUser('c@qu.edu.qa', { role: 'core' });
  core = { id: c.id, sid: (await createSession(db, c.id, { ip: null, userAgent: null })).token };
  const m = await addUser('m@qu.edu.qa');
  member = (await createSession(db, m.id, { ip: null, userAgent: null })).token;
  eventId = newId();
  await db.insert(events).values({ id: eventId, title: 'E', slug: 'e', startsOn: '2026-10-10', createdBy: c.id });
});

const b64 = (s: string) => Buffer.from(s).toString('base64');

/** tus takes over the raw response, which Fastify's inject() can't follow; tus traffic uses a real listener. */
let base = '';
beforeEach(async () => {
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(t.app.server.address() as { port: number }).port}`;
});
async function http(method: string, url: string, headers: Record<string, string>, body?: Buffer) {
  const r = await fetch(base + url, { method, headers, body: body ? new Uint8Array(body) : undefined, signal: AbortSignal.timeout(10_000) });
  const text = await r.text();
  return { statusCode: r.status, headers: Object.fromEntries(r.headers), body: text, json: () => JSON.parse(text) };
}
const tusHeaders = (sid = core.sid) => ({ ...H, 'tus-resumable': '1.0.0', cookie: `sid=${sid}` });
async function create(bytes: number, meta: Record<string, string>, sid?: string) {
  return http('POST', '/api/uploads', { ...tusHeaders(sid), 'upload-length': String(bytes), 'upload-metadata': Object.entries(meta).map(([k, v]) => `${k} ${b64(v)}`).join(',') });
}
const patch = (location: string, offset: number, body: Buffer) =>
  http('PATCH', location, { ...tusHeaders(), 'upload-offset': String(offset), 'content-type': 'application/offset+octet-stream' }, body);

async function upload(file: string, filename: string, tier = 'member', chunk = Infinity) {
  const body = await readFile(file);
  const c = await create(body.length, { eventId, tier, filename, filetype: '' });
  expect(c.statusCode).toBe(201);
  const loc = c.headers.location as string;
  let res;
  for (let o = 0; o < body.length; o += chunk) res = await patch(loc, o, body.subarray(o, Math.min(body.length, o + chunk)));
  return { res: res!, loc, body };
}

describe('sniffing', () => {
  it('recognises the accepted types from magic bytes and rejects the rest', () => {
    const ftyp = (major: string, ...compat: string[]) => {
      const b = Buffer.alloc(16 + compat.length * 4);
      b.writeUInt32BE(b.length, 0);
      b.write('ftyp', 4, 'latin1');
      b.write(major, 8, 'latin1');
      compat.forEach((c, i) => b.write(c, 16 + i * 4, 'latin1'));
      return b;
    };
    expect(sniffBuffer(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))?.ext).toBe('jpg');
    expect(sniffBuffer(ftyp('heic', 'mif1', 'heic'))?.ext).toBe('heic');
    expect(sniffBuffer(ftyp('mif1', 'avif'))?.ext).toBe('avif');
    expect(sniffBuffer(ftyp('avif', 'mif1'))?.ext).toBe('avif');
    expect(sniffBuffer(ftyp('qt  ', 'qt  '))?.ext).toBe('mov');
    expect(sniffBuffer(ftyp('isom', 'iso2', 'avc1'))?.ext).toBe('mp4');
    expect(sniffBuffer(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1'))?.ext).toBe('webp');
    expect(sniffBuffer(Buffer.from('%PDF-1.7'))).toBeNull();
    expect(sniffBuffer(Buffer.from('GIF89a'))).toBeNull();
  });

  it('reads rotation and HDR transfer from ffprobe output', () => {
    const p = parseFfprobe({
      streams: [{ codec_type: 'video', width: 1920, height: 1080, color_transfer: 'arib-std-b67', avg_frame_rate: '30000/1001', side_data_list: [{ rotation: -90 }] }],
      format: { duration: '8.4' },
    });
    expect(p).toEqual({ width: 1080, height: 1920, durationS: 8.4, fps: 29.97, hdr: 'hlg' });
  });

  it.runIf(existsSync(SAMPLE_MOV))('probes the chapter HLG sample as portrait HDR', async () => {
    expect(await sniffFile(SAMPLE_MOV)).toMatchObject({ kind: 'video', ext: 'mov' });
    const p = await probeVideo('ffprobe', SAMPLE_MOV);
    expect(p.hdr).toBe('hlg');
    expect(p.height).toBeGreaterThan(p.width!);
  });

  it.runIf(existsSync(SAMPLE_HEIC))('sniffs and sizes a real iPhone HEIC', async () => {
    expect(await sniffFile(SAMPLE_HEIC)).toMatchObject({ kind: 'image', ext: 'heic' });
    const p = await probeImage(SAMPLE_HEIC);
    expect(p.width).toBeGreaterThan(0);
  });
});

describe.runIf(hasFfmpeg)('tus uploads', () => {
  it('creates an uploading row, then ingests on the last chunk', async () => {
    const body = await readFile(`${fx}/photo.jpg`);
    const c = await create(body.length, { eventId, tier: 'core', filename: 'IMG_1.JPG', filetype: 'image/jpeg' });
    expect(c.statusCode).toBe(201);
    expect(c.headers.location).toMatch(/^\/api\/uploads\/[\w-]+$/);
    const [row] = await db.select().from(assets);
    expect(row).toMatchObject({ status: 'uploading', tier: 'core', originalSize: body.length, uploaderId: core.id, originalExt: 'jpg' });

    const half = Math.floor(body.length / 2);
    expect((await patch(c.headers.location as string, 0, body.subarray(0, half))).statusCode).toBe(204);
    expect((await db.select().from(assets))[0]!.status).toBe('uploading');
    const done = await patch(c.headers.location as string, half, body.subarray(half));
    expect(done.statusCode).toBe(204);
    expect(done.headers['asset-id']).toBe(row!.id);

    const [a] = await db.select().from(assets);
    expect(a).toMatchObject({ status: 'queued', kind: 'image', originalMime: 'image/jpeg', width: 640, height: 480 });
    expect((await stat(originalPath(media, a!.id, 'jpg', false))).size).toBe(body.length);
    expect(existsSync(path.join(media, 'tus', row!.uploadId!))).toBe(false);
    expect(existsSync(path.join(media, 'tus', `${row!.uploadId!}.json`))).toBe(false);
    const [job] = await db.select().from(jobs);
    expect(job).toMatchObject({ assetId: a!.id, kind: 'process', state: 'queued', priority: 100 });
  });

  it('probes videos at ingest and queues them behind photos', async () => {
    const { res } = await upload(`${fx}/clip.mp4`, 'clip.mp4', 'member', 64 * 1024);
    expect(res.statusCode).toBe(204);
    const [a] = await db.select().from(assets);
    expect(a).toMatchObject({ kind: 'video', originalExt: 'mp4', width: 480, height: 854, hdr: 'sdr' });
    expect(a!.durationS).toBeCloseTo(2, 0);
    expect((await db.select().from(jobs))[0]!.priority).toBe(0);
  });

  it('answers HEAD for a finished upload from the asset row', async () => {
    const { loc, body } = await upload(`${fx}/photo.jpg`, 'p.jpg');
    const head = await http('HEAD', loc, tusHeaders());
    expect(head.statusCode).toBe(200);
    expect(head.headers['upload-offset']).toBe(String(body.length));
  });

  it('rejects types outside the list and removes the row and files', async () => {
    const pdf = Buffer.from('%PDF-1.7\n' + 'x'.repeat(2000));
    const c = await create(pdf.length, { eventId, tier: 'member', filename: 'slides.pdf' });
    const res = await patch(c.headers.location as string, 0, pdf);
    expect(res.statusCode).toBe(415);
    expect(res.json().error).toBe('unsupported_type');
    expect(await db.select().from(assets)).toHaveLength(0);
  });

  it('cleans up a cancelled upload', async () => {
    const c = await create(1000, { eventId, tier: 'member', filename: 'x.jpg' });
    const del = await http('DELETE', c.headers.location as string, tusHeaders());
    expect(del.statusCode).toBe(204);
    await new Promise((r) => setTimeout(r, 50));
    expect(await db.select().from(assets)).toHaveLength(0);
  });

  it('is core-only, needs the CSRF header, a known event and valid metadata', async () => {
    expect((await create(10, { eventId, tier: 'member', filename: 'a.jpg' }, member)).statusCode).toBe(404);
    const noCsrf = await http('POST', '/api/uploads', { 'tus-resumable': '1.0.0', 'upload-length': '10', cookie: `sid=${core.sid}` });
    expect(noCsrf.statusCode).toBe(403);
    expect((await create(10, { eventId: newId(), tier: 'member', filename: 'a.jpg' })).statusCode).toBe(404);
    expect((await create(10, { eventId, tier: 'secret', filename: 'a.jpg' })).statusCode).toBe(400);
    const spoof = await http('POST', '/api/uploads', { ...tusHeaders(), 'x-acm-uploader': newId(), 'upload-length': '10', 'upload-metadata': `eventId ${b64(eventId)},tier ${b64('member')},filename ${b64('a.jpg')}` });
    expect(spoof.statusCode).toBe(201);
    expect((await db.select().from(assets))[0]!.uploaderId).toBe(core.id);
  });
});

describe.runIf(hasFfmpeg)('my uploads and retry', () => {
  it('lists my items newest first with status, and retries a failed one', async () => {
    await upload(`${fx}/photo.jpg`, 'first.jpg');
    await upload(`${fx}/photo.jpg`, 'second.jpg');
    const mine = (await t.app.inject({ method: 'GET', url: '/api/uploads/mine', cookies: { sid: core.sid } })).json();
    expect(mine.items.map((i: { filename: string }) => i.filename)).toEqual(['second.jpg', 'first.jpg']);
    expect(mine.items[0]).toMatchObject({ status: 'queued', eventTitle: 'E', readyInS: expect.any(Number) });

    const target = mine.items[1].assetId;
    await db.update(assets).set({ status: 'failed' }).where(eq(assets.id, target));
    await db.update(jobs).set({ state: 'failed', lastError: 'decode_failed', finishedAt: new Date() }).where(eq(jobs.assetId, target));
    const failed = (await t.app.inject({ method: 'GET', url: '/api/uploads/mine', cookies: { sid: core.sid } })).json().items[1];
    expect(failed).toMatchObject({ status: 'failed', error: 'decode_failed' });
    const retry = (sid: string) => t.app.inject({ method: 'POST', url: `/api/uploads/${target}/retry`, headers: H, cookies: { sid } });
    expect((await retry(member)).statusCode).toBe(404);
    expect((await retry(core.sid)).statusCode).toBe(200);
    expect((await retry(core.sid)).statusCode).toBe(409);
    expect((await db.select().from(jobs).where(eq(jobs.assetId, target))).map((j) => j.state).sort()).toEqual(['failed', 'queued']);
  });
});

describe.runIf(hasFfmpeg)('my uploads buckets and duplicates index', () => {
  it('counts buckets, filters by bucket and reports queue positions and existing files', async () => {
    await upload(`${fx}/photo.jpg`, 'a.jpg');
    await upload(`${fx}/clip.mp4`, 'b.mp4');
    const get = (q: string) => t.app.inject({ method: 'GET', url: `/api/uploads/mine${q}`, cookies: { sid: core.sid } }).then((r) => r.json());
    const all = await get('');
    expect(all.counts).toEqual({ all: 2, active: 2, attention: 0, ready: 0 });
    expect(all.items.map((i: { filename: string; queuePosition: number }) => [i.filename, i.queuePosition])).toEqual([['b.mp4', 2], ['a.jpg', 1]]);
    expect((await get('?bucket=ready')).items).toHaveLength(0);
    const existing = await t.app.inject({ method: 'GET', url: `/api/uploads/existing?eventId=${eventId}`, cookies: { sid: core.sid } });
    expect(existing.json().items.map((i: { filename: string }) => i.filename).sort()).toEqual(['a.jpg', 'b.mp4']);
  });
});
