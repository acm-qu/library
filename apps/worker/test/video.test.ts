import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appSettings, assets, events, jobs, processingRuns, renditions } from '@acm/core/db';
import { newId } from '@acm/core/ids';
import { assetDir, originalPath } from '@acm/core/paths';
import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addUser, db, resetDb, testConfig } from '../../api/test/helpers.ts';
import type { Ctx } from '../src/context.ts';
import { baseFilter, classify, hlsArgs, ladder, parseMaster } from '../src/lib/ffmpeg.ts';
import { silent } from '../src/log.ts';
import { runUntil } from '../src/runner.ts';

const PY = path.resolve('py/mediaworker/.venv/bin/python');
const media = await mkdtemp(path.join(tmpdir(), 'acm-video-'));
const fx = await mkdtemp(path.join(tmpdir(), 'acm-vfx-'));
const ctx: Ctx = { db, cfg: testConfig({ MEDIA_ROOT: media, PYTHON: PY }), log: silent };
const SAMPLE_MOV = path.join(process.env.HOME ?? '', 'Downloads/IMG_4515.MOV');
const ff = (...a: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...a]);

beforeAll(() => {
  ff('-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '4', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', `${fx}/land.mp4`);
  ff('-f', 'lavfi', '-i', 'testsrc2=size=480x854:rate=30', '-t', '3', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', `${fx}/portrait-silent.mp4`);
  ff('-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25', '-t', '2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', `${fx}/tiny.mp4`);
  ff('-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-t', '2', '-pix_fmt', 'yuv420p10le', '-c:v', 'libx265', '-x265-params', 'log-level=none', '-color_trc', 'log100', '-tag:v', 'hvc1', `${fx}/log.mp4`);
});

let uploader: string;
let eventId: string;
beforeEach(async () => {
  await resetDb();
  uploader = (await addUser('c@x.qa', { role: 'core' })).id;
  eventId = newId();
  await db.insert(events).values({ id: eventId, title: 'E', slug: 'e', startsOn: '2026-10-10', createdBy: uploader });
});

async function queuedVideo(file: string, ext = 'mp4') {
  const id = newId();
  await db.insert(assets).values({ id, eventId, kind: 'video', tier: 'member', status: 'queued', originalFilename: path.basename(file), originalExt: ext, uploaderId: uploader });
  await mkdir(assetDir(media, id), { recursive: true });
  await copyFile(file, originalPath(media, id, ext, false));
  await db.insert(jobs).values({ id: newId(), assetId: id, kind: 'process' });
  return id;
}

describe('ffmpeg builders', () => {
  it('classifies transfers like the handoff', () => {
    const v = (o: object) => classify({ streams: [{ codec_type: 'video', width: 1920, height: 1080, ...o }], format: { duration: '10' } });
    expect(v({ color_transfer: 'arib-std-b67', pix_fmt: 'yuv420p10le' })).toMatchObject({ hdr: 'hlg' });
    expect(v({ color_transfer: 'smpte2084', pix_fmt: 'yuv420p10le' })).toMatchObject({ hdr: 'pq' });
    expect(v({ color_transfer: 'bt709' })).toMatchObject({ hdr: 'sdr' });
    expect(v({ pix_fmt: 'yuv420p' })).toMatchObject({ hdr: 'sdr' });
    expect(v({ pix_fmt: 'yuv420p10le' })).toMatchObject({ kind: 'needs_review' });
    expect(v({ color_transfer: 'log100', pix_fmt: 'yuv420p10le' })).toMatchObject({ kind: 'needs_review', transfer: 'log100' });
    expect(v({ color_transfer: 'bt709', side_data_list: [{ rotation: -90 }] })).toMatchObject({ width: 1080, height: 1920 });
    expect(v({ color_transfer: 'bt709', avg_frame_rate: '90500/3017', r_frame_rate: '30000/1001' })).toMatchObject({ vfr: true });
  });

  it('builds the ladder by the short side, never upscaling', () => {
    expect(ladder(1920, 1080).map((r) => r.name)).toEqual(['360p', '720p', '1080p']);
    expect(ladder(1080, 1920).map((r) => r.name)).toEqual(['360p', '720p', '1080p']);
    expect(ladder(1280, 720).map((r) => r.name)).toEqual(['360p', '720p']);
    expect(ladder(320, 240).map((r) => r.name)).toEqual(['240p']);
  });

  it('maps audio only when present and adds the key info for core', () => {
    const a = hlsArgs({ src: 's', out: 'o', rungs: ladder(1280, 720), vf: baseFilter('sdr'), fps: 29.97, vfr: false, hasAudio: false, keyInfo: 'k' });
    expect(a.join(' ')).not.toContain('0:a');
    expect(a[a.indexOf('-var_stream_map') + 1]).toBe('v:0,name:360p v:1,name:720p');
    expect(a[a.indexOf('-g') + 1]).toBe('60');
    expect(a).toContain('-hls_key_info_file');
    expect(baseFilter('hlg')).toContain('tin=arib-std-b67');
    expect(baseFilter('pq')).toContain('tin=smpte2084');
  });

  it('parses the master playlist', () => {
    const m = parseMaster('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1140800,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2"\n360p/index.m3u8\n');
    expect(m.get('360p')).toEqual({ bandwidth: 1140800, width: 640, height: 360 });
  });
});

describe('video jobs', () => {
  it('encodes SDR with audio into single-file HLS and swaps renditions in', async () => {
    const id = await queuedVideo(`${fx}/land.mp4`);
    expect(await runUntil(ctx)).toBe(1);
    const [a] = await db.select().from(assets).where(eq(assets.id, id));
    expect(a).toMatchObject({ status: 'ready', hdr: 'sdr', width: 1280, height: 720, renditionRev: 1 });
    const rs = await db.select().from(renditions).where(eq(renditions.assetId, id));
    expect(rs.map((r) => `${r.kind}:${r.label}`).sort()).toEqual(['hls_master:', 'hls_variant:360p', 'hls_variant:720p', 'video_poster:', 'video_thumb:']);
    expect(rs.find((r) => r.label === '720p')!.bandwidth).toBeGreaterThan(0);
    const dir = path.join(assetDir(media, id), 'r1', 'hls', '720p');
    expect((await readdir(dir)).sort()).toEqual(['data.ts', 'index.m3u8']);
    const playlist = await readFile(path.join(dir, 'index.m3u8'), 'utf8');
    expect(playlist).toContain('#EXT-X-BYTERANGE');
    expect(playlist).toContain('#EXT-X-ENDLIST');
    const [rho] = await db.select().from(appSettings).where(eq(appSettings.key, 'rho_sdr'));
    expect(typeof rho!.value).toBe('number');
    const [run] = await db.select().from(processingRuns).where(eq(processingRuns.assetId, id));
    expect(run).toMatchObject({ ok: true, curveSource: 'none' });
  }, 120_000);

  it('handles portrait sources without audio and tiny sources', async () => {
    const p = await queuedVideo(`${fx}/portrait-silent.mp4`);
    const t = await queuedVideo(`${fx}/tiny.mp4`);
    await runUntil(ctx);
    const [pa] = await db.select().from(assets).where(eq(assets.id, p));
    expect(pa).toMatchObject({ status: 'ready', width: 480, height: 854 });
    const prs = await db.select().from(renditions).where(eq(renditions.assetId, p));
    expect(prs.find((r) => r.label === '360p')).toMatchObject({ width: 360 });
    const trs = await db.select().from(renditions).where(eq(renditions.assetId, t));
    expect(trs.filter((r) => r.kind === 'hls_variant').map((r) => r.label)).toEqual(['240p']);
  }, 120_000);

  it('sends Log or unknown transfers to needs review without encoding', async () => {
    const id = await queuedVideo(`${fx}/log.mp4`);
    await runUntil(ctx);
    const [a] = await db.select().from(assets).where(eq(assets.id, id));
    expect(a).toMatchObject({ status: 'needs_review', reviewReason: 'unknown_transfer' });
    expect((await db.select().from(jobs))[0]).toMatchObject({ state: 'done', outcome: 'needs_review' });
  }, 60_000);

  it.runIf(existsSync(SAMPLE_MOV))('tone maps the chapter HLG sample (portrait, VFR, Dolby Vision) with the Hable fallback', async () => {
    const id = await queuedVideo(SAMPLE_MOV, 'mov');
    await runUntil(ctx);
    const [a] = await db.select().from(assets).where(eq(assets.id, id));
    expect(a).toMatchObject({ status: 'ready', hdr: 'hlg', width: 1080, height: 1920 });
    const [run] = await db.select().from(processingRuns).where(eq(processingRuns.assetId, id));
    expect(run).toMatchObject({ ok: true, toneCurve: 'hable203', curveSource: 'fallback' });
    const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=color_transfer,color_primaries,width,height', '-of', 'json', path.join(assetDir(media, id), 'r1', 'hls', '1080p', 'data.ts')]).toString();
    expect(JSON.parse(out).streams[0]).toMatchObject({ color_transfer: 'bt709', color_primaries: 'bt709', width: 1080, height: 1920 });
  }, 600_000);
});

describe('HLS routes', () => {
  it('serves playlists with ?v= stamped on URIs, byte ranges of data.ts, and 404s unknown variants', async () => {
    const { buildApp } = await import('../../api/src/app.ts');
    const { createSession } = await import('../../api/src/auth/sessions.ts');
    const id = await queuedVideo(`${fx}/land.mp4`);
    await runUntil(ctx);
    const app = await buildApp({ cfg: ctx.cfg, db, logger: false, mailer: { sendSignInCode: async () => {} } });
    const m = await addUser('m@x.qa', { role: 'member' });
    const sid = (await createSession(db, m.id, { ip: null, userAgent: null })).token;
    const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url, headers, cookies: { sid } });
    const master = await get(`/api/media/${id}/hls/master.m3u8`);
    expect(master.headers['content-type']).toBe('application/vnd.apple.mpegurl');
    expect(master.body).toContain('360p/index.m3u8?v=1');
    const idx = await get(`/api/media/${id}/hls/720p/index.m3u8`);
    expect(idx.body).toMatch(/^data\.ts\?v=1$/m);
    const range = /#EXT-X-BYTERANGE:(\d+)@(\d+)/.exec(idx.body)!;
    const [len, off] = [Number(range[1]), Number(range[2])];
    const seg = await get(`/api/media/${id}/hls/720p/data.ts?v=1`, { range: `bytes=${off}-${off + len - 1}` });
    expect([seg.statusCode, seg.rawPayload.length, seg.rawPayload[0]]).toEqual([206, len, 0x47]); // MPEG-TS sync byte
    expect((await get(`/api/media/${id}/hls/2160p/index.m3u8`)).statusCode).toBe(404);
    expect((await get(`/api/media/${id}/hls/..%2F..%2Foriginal.mp4/index.m3u8`)).statusCode).toBe(404);
    await app.close();
  }, 120_000);
});

describe('admin overrides', () => {
  it('"Process anyway" encodes an unknown transfer as SDR', async () => {
    const id = await queuedVideo(`${fx}/log.mp4`);
    await runUntil(ctx);
    await db.update(assets).set({ status: 'queued' }).where(eq(assets.id, id));
    await db.insert(jobs).values({ id: newId(), assetId: id, kind: 'process', params: { force: true } });
    await runUntil(ctx);
    expect((await db.select().from(assets).where(eq(assets.id, id)))[0]).toMatchObject({ status: 'ready', hdr: 'sdr' });
  }, 60_000);

  it('a curve override on an SDR source is ignored (nothing to tone map)', async () => {
    const id = await queuedVideo(`${fx}/land.mp4`);
    await db.delete(jobs);
    await db.insert(jobs).values({ id: newId(), assetId: id, kind: 'reprocess', params: { toneCurve: 'bt2390' } });
    await runUntil(ctx);
    expect((await db.select().from(jobs))[0]).toMatchObject({ state: 'done' });
    expect((await db.select().from(processingRuns).where(eq(processingRuns.assetId, id)))[0]).toMatchObject({ toneCurve: null, curveSource: 'none' });
  }, 60_000);

  it('records storage stats with a daily history', async () => {
    const { storageStats } = await import('../src/stats.ts');
    const id = await queuedVideo(`${fx}/tiny.mp4`);
    await runUntil(ctx);
    void id;
    const s = await storageStats(ctx);
    expect(s.files).toBeGreaterThan(3);
    expect(s.bytesOriginals).toBeGreaterThan(0);
    const [h] = await db.select().from(appSettings).where(eq(appSettings.key, 'storage_history'));
    expect(h!.value).toHaveLength(1);
  }, 60_000);
});
