// Tone-curve choice in the video job: the table filter against the verified chain, admin overrides, automatic
// selection (scores, sealed frames, the admin frames route), its fallbacks, and cancelling while it runs.
// The scorer itself (torch) is replaced by a stub here; py/mediaworker's tests cover it, on the server too.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appSettings, assets, events, jobs, processingRuns } from '@acm/core/db';
import { newId } from '@acm/core/ids';
import { assetDir, lutPath, originalPath, tonemapGatePath } from '@acm/core/paths';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addUser, db, resetDb, testConfig } from '../../api/test/helpers.ts';
import type { Ctx } from '../src/context.ts';
import { baseFilter } from '../src/lib/ffmpeg.ts';
import { silent } from '../src/log.ts';
import { runUntil } from '../src/runner.ts';

const PY = path.resolve('py/mediaworker/.venv/bin/python');
const root = await mkdtemp(path.join(tmpdir(), 'acm-tm-'));
const media = path.join(root, 'media');
const lutsDir = path.join(root, 'luts');
const stub = path.join(root, 'python-stub.sh');
const log = path.join(root, 'stub.log');
const webp = path.join(root, 'frame.webp');
const hlg = path.join(root, 'hlg.mp4');
const CURVES = ['hable203', 'bt2446a', 'bt2390', 'reinhard203'];
const ctx: Ctx = { db, cfg: testConfig({ MEDIA_ROOT: media, PYTHON: stub, LUTS_DIR: lutsDir }), log: silent };
const ff = (...a: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...a]);

// `select` answers from STUB_MODE (ok | fail | sleep); every other mediaworker command runs the real Python.
const STUB = `#!/bin/sh
if [ "$3" = "select" ]; then
  echo "$@" >> "${log}"
  out=""; prev=""
  for a in "$@"; do [ "$prev" = "--frames-out" ] && out="$a"; prev="$a"; done
  case "$STUB_MODE" in
    fail) echo '{"error": "RuntimeError", "message": "no usable frames"}'; exit 1 ;;
    sleep) sleep 60; exit 0 ;;
  esac
  mkdir -p "$out"
  for i in 0 1 2 3 4 5 6 7; do cp "${webp}" "$out/$i.webp"; done
  cat <<'JSON'
${JSON.stringify({
  curve: 'reinhard203',
  source: 'auto',
  reason: null,
  best: 'reinhard203',
  candidates: CURVES.map((c, i) => ({ curve: c, dists: 0.1 + i / 100, topiq: 0.8 - i / 100, r_dists: [2, 3, 4, 1][i], r_topiq: [2, 4, 3, 1][i], sum: [4, 7, 7, 2][i] })),
  frames: Array.from({ length: 8 }, (_, i) => ({ t: 0.1 + i * 0.2, why: i < 6 ? 'even' : 'bright' })),
  size: [640, 360],
  lowerBetter: { dists: true, topiq: false },
  ms: { total: 1200, sample: 200, convert: 100, score: 900 },
  maxRssMb: 400,
})}
JSON
  exit 0
fi
exec "${PY}" "$@"
`;

beforeAll(async () => {
  await mkdir(lutsDir, { recursive: true });
  await writeFile(stub, STUB);
  await chmod(stub, 0o755);
  // 2 s of moving pattern converted properly to 10-bit HLG (BT.709 → HLG/BT.2020), keyframe every second.
  ff('-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-t', '2', '-vf', 'zscale=tin=bt709:min=bt709:pin=bt709:rin=tv:t=arib-std-b67:p=bt2020:m=bt2020nc:r=tv,format=yuv420p10le', '-c:v', 'libx265', '-x265-params', 'log-level=none:keyint=30:colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc', '-tag:v', 'hvc1', hlg);
  ff('-f', 'lavfi', '-i', 'color=c=gray:size=64x36', '-frames:v', '1', webp);
  // Small tables for every curve (the override and auto paths only need them to exist and be valid .cube files).
  execFileSync(PY, ['-c', `import sys; from pathlib import Path; from mediaworker.tonemap import luts, curves
for c in curves.CURVES: luts.write_cube(Path(sys.argv[1]) / luts.lut_name(c, "hlg"), luts.build(c, "hlg", 17), "test")`, lutsDir], { cwd: 'py/mediaworker' });
});
afterAll(() => rm(root, { recursive: true, force: true }));

let uploader: string;
let eventId: string;
beforeEach(async () => {
  await resetDb();
  await rm(log, { force: true });
  await rm(tonemapGatePath(lutsDir), { force: true });
  delete process.env.STUB_MODE;
  uploader = (await addUser('c@x.qa', { role: 'core' })).id;
  eventId = newId();
  await db.insert(events).values({ id: eventId, title: 'E', slug: 'e', startsOn: '2026-10-10', createdBy: uploader });
});

async function queued(tier: 'member' | 'core' = 'member', params: Record<string, unknown> = {}) {
  const id = newId();
  await db.insert(assets).values({ id, eventId, kind: 'video', tier, status: 'queued', originalFilename: 'hlg.mp4', originalExt: 'mp4', uploaderId: uploader });
  await mkdir(assetDir(media, id), { recursive: true });
  await copyFile(hlg, originalPath(media, id, 'mp4', false));
  await db.insert(jobs).values({ id: newId(), assetId: id, kind: 'process', params });
  return id;
}
const enableAuto = async (gate = true) => {
  await db.insert(appSettings).values({ key: 'tonemap_auto', value: true });
  if (gate) await writeFile(tonemapGatePath(lutsDir), '{"ok": true}');
};
const runOf = async (id: string) => (await db.select().from(processingRuns).where(eq(processingRuns.assetId, id)))[0]!;
const stubCalls = async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).length;

describe('table filter', () => {
  it('matches the verified Hable chain (and the old filter did not)', () => {
    const lut65 = path.join(root, 'hable65.cube');
    execFileSync(PY, ['-c', 'import sys; from pathlib import Path; from mediaworker.tonemap import luts; luts.write_cube(Path(sys.argv[1]), luts.build("hable203", "hlg"), "t")', lut65], { cwd: 'py/mediaworker' });
    const yuv = (vf: string) => execFileSync('ffmpeg', ['-v', 'error', '-i', hlg, '-vf', vf, '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-'], { maxBuffer: 1 << 28 });
    const meanDiff = (a: Buffer, b: Buffer) => {
      let s = 0;
      for (let i = 0; i < a.length; i++) s += Math.abs(a[i]! - b[i]!);
      return s / a.length;
    };
    const chain = yuv(baseFilter('hlg'));
    expect(meanDiff(chain, yuv(baseFilter('hlg', lut65)))).toBeLessThan(2); // handoff §8.5 acceptance limit
    const old = baseFilter('hlg', lut65).replace('zscale=tin=bt709:pin=bt709:t=bt709', 'zscale=t=bt709');
    expect(meanDiff(chain, yuv(old))).toBeGreaterThan(10);
  }, 120_000);
});

describe('tone curve choice', () => {
  it('uses the Hable chain by default, without scoring', async () => {
    const id = await queued();
    await runUntil(ctx);
    expect((await db.select().from(assets).where(eq(assets.id, id)))[0]).toMatchObject({ status: 'ready', hdr: 'hlg' });
    expect(await runOf(id)).toMatchObject({ ok: true, toneCurve: 'hable203', curveSource: 'fallback', scores: null });
    expect(await stubCalls()).toBe(0);
  }, 120_000);

  it('an admin override encodes through that curve\'s table', async () => {
    const id = await queued('member', { toneCurve: 'bt2390', curveSource: 'override' });
    await runUntil(ctx);
    expect((await db.select().from(assets).where(eq(assets.id, id)))[0]).toMatchObject({ status: 'ready' });
    expect(await runOf(id)).toMatchObject({ ok: true, toneCurve: 'bt2390', curveSource: 'override' });
    expect(await stubCalls()).toBe(0);
  }, 120_000);

  it('`mediaworker luts` writes every table once', () => {
    const out = path.join(root, 'fresh');
    const luts = (...a: string[]) => JSON.parse(execFileSync(PY, ['-m', 'mediaworker', 'luts', '--out', out, '--size', '9', ...a], { cwd: 'py/mediaworker' }).toString());
    expect(luts()).toMatchObject({ generated: true, size: 9 });
    expect(luts()).toMatchObject({ generated: false });
    for (const c of CURVES) for (const t of ['hlg', 'pq'] as const) expect(existsSync(lutPath(out, c, t))).toBe(true);
  }, 60_000);

  it('automatic selection: stores the choice, the scores and sealed frames, served to admins only', async () => {
    await enableAuto();
    const id = await queued('core');
    await runUntil(ctx);
    expect((await db.select().from(assets).where(eq(assets.id, id)))[0]).toMatchObject({ status: 'ready', encrypted: true });
    const run = await runOf(id);
    expect(run).toMatchObject({ ok: true, toneCurve: 'reinhard203', curveSource: 'auto' });
    const scores = run.scores as { candidates: unknown[]; frames: { n: number }[]; reason: null };
    expect(scores.candidates).toHaveLength(4);
    expect(scores.frames.map((f) => f.n)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(await stubCalls()).toBe(1);
    // The measured scoring time (1.2 s from the stub) moves the ETA's fixed HDR cost: 0.8 × 340 + 0.2 × 1.2.
    expect((await db.select().from(appSettings).where(eq(appSettings.key, 'score_seconds')))[0]!.value).toBe(272);
    const frames = (await readdir(path.join(assetDir(media, id), 'r1', 'frames'))).sort();
    expect(frames).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map((n) => `${n}.webp.enc`)); // core tier: sealed

    const { buildApp } = await import('../../api/src/app.ts');
    const { createSession } = await import('../../api/src/auth/sessions.ts');
    const app = await buildApp({ cfg: ctx.cfg, db, logger: false, mailer: { sendSignInCode: async () => {} } });
    const admin = await addUser('a@x.qa', { role: 'core', isAdmin: true });
    const core = await addUser('k@x.qa', { role: 'core' });
    const sid = async (u: { id: string }) => (await createSession(db, u.id, { ip: null, userAgent: null })).token;
    const [as, cs] = [await sid(admin), await sid(core)];
    const get = (url: string, s: string) => app.inject({ method: 'GET', url, cookies: { sid: s } });
    const f0 = await get(`/api/admin/assets/${id}/frames/0?r=${run.id}`, as);
    expect([f0.statusCode, f0.headers['content-type']]).toEqual([200, 'image/webp']);
    expect(Buffer.compare(f0.rawPayload, await readFile(webp))).toBe(0); // decrypted back to the scorer's file
    expect((await get(`/api/admin/assets/${id}/frames/8`, as)).statusCode).toBe(404);
    expect((await get(`/api/admin/assets/${id}/frames/x`, as)).statusCode).toBe(404);
    expect((await get(`/api/admin/assets/${id}/frames/0`, cs)).statusCode).toBe(404); // not an admin
    const processing = await get(`/api/admin/assets/${id}/processing`, as);
    expect(processing.json().runs[0]).toMatchObject({ toneCurve: 'reinhard203', curveSource: 'auto' });
    await app.close();
  }, 120_000);

  it('member-tier frames stay plain files', async () => {
    await enableAuto();
    const id = await queued('member');
    await runUntil(ctx);
    expect((await readdir(path.join(assetDir(media, id), 'r1', 'frames'))).sort()[0]).toBe('0.webp');
  }, 120_000);

  it('a scoring failure falls back to Hable and says why', async () => {
    await enableAuto();
    process.env.STUB_MODE = 'fail';
    const id = await queued();
    await runUntil(ctx);
    expect((await db.select().from(assets).where(eq(assets.id, id)))[0]).toMatchObject({ status: 'ready' });
    expect(await runOf(id)).toMatchObject({ ok: true, toneCurve: 'hable203', curveSource: 'fallback', scores: { reason: 'scoring_failed', error: 'RuntimeError' } });
  }, 120_000);

  it('runs as soon as it is switched on, before the validation gate has passed', async () => {
    await enableAuto(false);
    const id = await queued();
    await runUntil(ctx);
    expect(await runOf(id)).toMatchObject({ toneCurve: 'reinhard203', curveSource: 'auto' });
    expect(await stubCalls()).toBe(1);
  }, 120_000);

  it('cancelling while the curves are scored stops the job and keeps it cancelled', async () => {
    await enableAuto();
    process.env.STUB_MODE = 'sleep';
    const id = await queued();
    const started = Date.now();
    const done = runUntil(ctx);
    await new Promise((r) => setTimeout(r, 1500));
    await db.update(jobs).set({ state: 'cancelled' }).where(eq(jobs.assetId, id));
    await done;
    expect(Date.now() - started).toBeLessThan(20_000); // killed at the next 5 s poll, not after the 60 s sleep
    expect((await db.select().from(jobs).where(eq(jobs.assetId, id)))[0]).toMatchObject({ state: 'cancelled' });
    expect((await db.select().from(assets).where(eq(assets.id, id)))[0]).toMatchObject({ status: 'failed' });
    expect(await runOf(id)).toMatchObject({ ok: false });
  }, 60_000);
});
