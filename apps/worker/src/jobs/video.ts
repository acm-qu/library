// Video job: probe and classify, choose the HDR tone curve, encode the ladder as single-file HLS in one ffmpeg run,
// poster + thumb, then the atomic swap.
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { appSettings, type Asset, assets, type Job, jobs, processingRuns, TONE_CURVES, type ToneCurve } from '@acm/core/db';
import { DEFAULT_RHO, nextRho, nextScoreSeconds, SCORE_SECONDS } from '@acm/core/eta';
import { newId } from '@acm/core/ids';
import { lutPath, tmpDir } from '@acm/core/paths';
import { eq } from 'drizzle-orm';
import { type Ctx, type JobScope, Permanent } from '../context.ts';
import { baseFilter, classify, hlsArgs, ladder, parseMaster, type ProbeJson, sourceReadrate } from '../lib/ffmpeg.ts';
import { ChildFailed, mediaworker, run } from '../lib/spawn.ts';
import { getOrCreateKeys, writeKeyInfo } from '../lib/keys.ts';
import { sealAll, wantsEncryption } from '../lib/seal.ts';
import { type Out, publish } from './publish.ts';

async function probe(ctx: Ctx, src: string): Promise<ProbeJson> {
  try {
    const { stdout } = await run(ctx.cfg.FFPROBE, ['-v', 'error', '-threads', '1', '-print_format', 'json', '-show_format', '-show_streams', src], { timeoutMs: 60_000 });
    return JSON.parse(stdout) as ProbeJson;
  } catch (e) {
    if (e instanceof ChildFailed && e.code === 'exit') throw new Permanent('decode_failed', 'ffprobe could not read the file');
    throw e;
  }
}

async function bytesIn(dir: string): Promise<number> {
  let n = 0;
  for (const f of await readdir(dir)) n += (await stat(path.join(dir, f))).size;
  return n;
}

export async function processVideo(ctx: Ctx, job: Job, a: Asset, src: string, scope: JobScope): Promise<'ok' | 'needs_review'> {
  await scope.step('Reading video', 0.08);
  const params = (job.params ?? {}) as { force?: boolean; toneCurve?: string; curveSource?: string };
  const c = classify(await probe(ctx, src), params.force === true);
  if (c.kind === 'needs_review') {
    await ctx.db
      .update(assets)
      .set({ status: 'needs_review', reviewReason: c.reason, hdr: 'unknown', sourceInfo: { transfer: c.transfer }, updatedAt: new Date() })
      .where(eq(assets.id, a.id));
    return 'needs_review';
  }
  await ctx.db
    .update(assets)
    .set({ width: c.width, height: c.height, durationS: c.durationS, fps: c.fps, hdr: c.hdr, device: c.device ?? a.device, capturedAt: c.capturedAt ? new Date(c.capturedAt) : a.capturedAt, sourceInfo: { vfr: c.vfr, hasAudio: c.hasAudio, dvProfile: c.dvProfile } })
    .where(eq(assets.id, a.id));

  const runId = newId();
  const hdr = c.hdr !== 'sdr';
  const tmp = path.join(tmpDir(ctx.cfg.MEDIA_ROOT, job.id), 'out'); // tmp/ may also hold a decrypted source
  await rm(tmp, { recursive: true, force: true });
  await ctx.db.insert(processingRuns).values({ id: runId, assetId: a.id, settingsVersion: 1, curveSource: hdr ? null : 'none', startedAt: new Date() });

  const encrypt = wantsEncryption(a);
  const keys = encrypt ? await getOrCreateKeys(ctx, a.id) : null;
  let keyInfo: Awaited<ReturnType<typeof writeKeyInfo>> | null = null;
  const rungs = ladder(c.width, c.height);
  let tail = '';
  try {
    // Curve first (scoring reads the source, never alongside the encode), then the table it needs.
    const choice = c.hdr === 'sdr' ? null : await chooseCurve(ctx, scope, src, c.hdr, c.durationS, params, path.join(tmp, 'frames'));
    await ctx.db.update(processingRuns).set({ toneCurve: choice?.curve ?? null, curveSource: choice?.source ?? 'none', scores: choice?.scores ?? null }).where(eq(processingRuns.id, runId));
    const lut = choice && choice.curve !== FALLBACK ? await ensureLut(ctx, choice.curve, c.hdr as 'hlg' | 'pq') : undefined;
    const vf = baseFilter(c.hdr, lut);
    keyInfo = keys ? await writeKeyInfo(ctx, job.id, a.id, keys.hlsKey) : null;
    for (const r of rungs) await mkdir(path.join(tmp, 'hls', r.name), { recursive: true });

    // Encode: 10% → 90% of the job's progress bar.
    await scope.step(hdr ? 'Converting HDR and encoding' : 'Encoding', 0.1);
    const encStart = Date.now();
    const readrate = sourceReadrate((await stat(src)).size, c.durationS);
    const timeoutMs = Math.max(15 * 60_000, c.durationS * 1000 * ((hdr ? 8 : 4) + 1 / readrate));
    let lastOut = 0;
    await run(ctx.cfg.FFMPEG, hlsArgs({ src, out: tmp, rungs, vf, fps: c.fps, vfr: c.vfr, hasAudio: c.hasAudio, keyInfo: keyInfo?.info, readrate }), {
      timeoutMs,
      isCancelled: () => scope.isCancelled(),
      onStderr: (l) => (tail = (tail + l + '\n').slice(-4000)),
      onStdout: (l) => {
        const m = /^out_time_us=(\d+)/.exec(l);
        if (m && c.durationS > 0) {
          const t = Number(m[1]) / 1e6;
          if (t > lastOut) {
            lastOut = t;
            void scope.progress(0.1 + 0.8 * Math.min(1, t / c.durationS));
          }
        }
      },
    }).catch((e) => {
      if (e instanceof ChildFailed && e.code === 'cancelled') throw e;
      if (e instanceof ChildFailed && e.code === 'exit' && /Invalid data found|could not find codec|Decoder .* not found|moov atom not found/i.test(e.stderrTail)) {
        throw new Permanent('unsupported_codec', e.message);
      }
      throw e;
    });
    const encodeS = (Date.now() - encStart) / 1000;
    await keyInfo?.cleanup();
    await scope.throwIfCancelled();

    await scope.step('Making poster', 0.92);
    const posterPng = path.join(tmp, 'poster.png');
    await run(ctx.cfg.FFMPEG, ['-nostdin', '-hide_banner', '-y', '-filter_threads', '1', '-threads', '1', '-ss', String(Math.max(0, c.durationS * 0.1)), '-i', src, '-frames:v', '1', '-vf', vf.replace(/,format=yuv420p$/, ''), '-threads', '1', posterPng], { timeoutMs: 120_000 });
    const stills = path.join(tmp, 'stills');
    const img = await mediaworker<{ files: { view: { file: string; width: number; height: number; bytes: number }; thumb: { file: string; width: number; height: number; bytes: number } } }>(
      ctx.cfg.PYTHON,
      ['images', '--src', posterPng, '--out', stills],
      { timeoutMs: 120_000 },
    );
    await rename(path.join(stills, 'view.webp'), path.join(tmp, 'poster.webp'));
    await rename(path.join(stills, 'thumb.webp'), path.join(tmp, 'thumb.webp'));
    await rm(stills, { recursive: true, force: true });
    await rm(posterPng, { force: true });

    // ffmpeg leaves data.ts.tmp behind in single_file mode (Milestone 0 spike).
    for (const r of rungs) await rm(path.join(tmp, 'hls', r.name, 'data.ts.tmp'), { force: true });

    let poster = 'poster.webp';
    let thumb = 'thumb.webp';
    if (keys) [poster, thumb] = (await sealAll(tmp, [poster, thumb], keys.fileKey, a.id)) as [string, string];
    // Sampled frames ride along in r<rev>/frames/ (not renditions: only the admin's Item details reads them).
    const frameDir = path.join(tmp, 'frames');
    if (keys && existsSync(frameDir)) await sealAll(frameDir, (await readdir(frameDir)).filter((f) => f.endsWith('.webp')), keys.fileKey, a.id);
    const master = parseMaster(await readFile(path.join(tmp, 'hls', 'master.m3u8'), 'utf8'));
    const outs: Out[] = [
      { kind: 'hls_master', file: 'hls/master.m3u8', bytes: (await stat(path.join(tmp, 'hls', 'master.m3u8'))).size },
      ...(await Promise.all(
        rungs.map(async (r) => {
          const m = master.get(r.name);
          return { kind: 'hls_variant' as const, label: r.name, file: `hls/${r.name}/index.m3u8`, width: m?.width ?? null, height: m?.height ?? r.h, bandwidth: m?.bandwidth ?? null, bytes: await bytesIn(path.join(tmp, 'hls', r.name)) };
        }),
      )),
      // HLS segments are AES-128 encrypted by ffmpeg itself (served as-is); poster and thumb are sealed files.
      { kind: 'video_poster', file: poster, width: img.files.view.width, height: img.files.view.height, bytes: (await stat(path.join(tmp, poster))).size, encrypted: !!keys },
      { kind: 'video_thumb', file: thumb, width: img.files.thumb.width, height: img.files.thumb.height, bytes: (await stat(path.join(tmp, thumb))).size, encrypted: !!keys },
    ];
    await scope.step('Finishing', 0.97);
    await publish(ctx, a, tmp, outs, { reviewReason: null });
    await ctx.db.update(processingRuns).set({ finishedAt: new Date(), ok: true, logTail: tail.slice(-2000) }).where(eq(processingRuns.id, runId));
    await updateRho(ctx, hdr, encodeS, c.durationS);
    return 'ok';
  } catch (e) {
    await ctx.db
      .update(processingRuns)
      .set({ finishedAt: new Date(), ok: false, error: e instanceof Error ? e.message.slice(0, 500) : 'error', logTail: tail.slice(-2000) })
      .where(eq(processingRuns.id, runId));
    throw e;
  } finally {
    await keyInfo?.cleanup();
    await rm(tmp, { recursive: true, force: true });
    await ctx.db.update(jobs).set({ estSeconds: null }).where(eq(jobs.id, job.id));
  }
}

const FALLBACK: ToneCurve = 'hable203';
type Choice = { curve: ToneCurve; source: 'auto' | 'fallback' | 'override'; scores: Record<string, unknown> | null };
type SelectOut = { curve: ToneCurve; source: 'auto' | 'fallback'; reason: string | null; candidates: unknown[]; best?: string; frames: { t: number; why: string }[]; size: number[]; ms: Record<string, number>; maxRssMb: number };

/** Automatic selection runs whenever an admin switched it on; the validation gate's result is information only. */
async function autoEnabled(ctx: Ctx): Promise<boolean> {
  const [row] = await ctx.db.select().from(appSettings).where(eq(appSettings.key, 'tonemap_auto'));
  return row?.value === true;
}

/** Handoff §8.5: an admin override wins; then automatic selection when enabled; Hable (203) otherwise and on any error. */
async function chooseCurve(ctx: Ctx, scope: JobScope, src: string, hdr: 'hlg' | 'pq', durationS: number, params: { toneCurve?: string }, framesOut: string): Promise<Choice> {
  if (params.toneCurve && (TONE_CURVES as readonly string[]).includes(params.toneCurve)) return { curve: params.toneCurve as ToneCurve, source: 'override', scores: null };
  if (!(await autoEnabled(ctx))) return { curve: FALLBACK, source: 'fallback', scores: null };
  await scope.step('Scoring tone curves', 0.1);
  for (const c of TONE_CURVES) await ensureLut(ctx, c, hdr);
  try {
    const r = await mediaworker<SelectOut>(
      ctx.cfg.PYTHON,
      ['select', '--src', src, '--transfer', hdr, '--luts', ctx.cfg.LUTS_DIR, '--ffmpeg', ctx.cfg.FFMPEG, '--ffprobe', ctx.cfg.FFPROBE, '--frames-out', framesOut],
      // Keyframe scan ≈ real time / 20 on the host; scoring 8 frames × 4 curves is a few minutes.
      { timeoutMs: 30 * 60_000 + durationS * 200, isCancelled: () => scope.isCancelled() },
    );
    ctx.log.info({ curve: r.curve, source: r.source, reason: r.reason, ms: r.ms, maxRssMb: r.maxRssMb }, 'tone curve chosen');
    await updateScoreSeconds(ctx, (r.ms.total ?? 0) / 1000);
    const frames = r.frames.map((f, n) => ({ ...f, n }));
    return { curve: r.curve, source: r.source, scores: { candidates: r.candidates, best: r.best ?? null, reason: r.reason, frames, size: r.size, ms: r.ms, maxRssMb: r.maxRssMb } };
  } catch (e) {
    if (e instanceof ChildFailed && e.code === 'cancelled') throw e;
    await rm(framesOut, { recursive: true, force: true });
    const code = e instanceof ChildFailed ? e.code : 'error';
    ctx.log.warn({ code, err: e instanceof Error ? e.message.slice(0, 300) : String(e) }, 'tone-curve scoring failed; using the fallback');
    return { curve: FALLBACK, source: 'fallback', scores: { candidates: [], reason: 'scoring_failed', error: code } };
  }
}

/** The table for one curve, generated on first use (`python -m mediaworker luts` writes them all in ~3 s). */
async function ensureLut(ctx: Ctx, curve: ToneCurve, hdr: 'hlg' | 'pq'): Promise<string> {
  const file = lutPath(ctx.cfg.LUTS_DIR, curve, hdr);
  if (existsSync(file)) return file;
  await mediaworker(ctx.cfg.PYTHON, ['luts', '--out', ctx.cfg.LUTS_DIR], { timeoutMs: 5 * 60_000 });
  if (!existsSync(file)) throw new Permanent('lut_missing', `no table for ${curve} (${hdr})`);
  return file;
}

async function updateScoreSeconds(ctx: Ctx, measuredS: number) {
  const [row] = await ctx.db.select().from(appSettings).where(eq(appSettings.key, 'score_seconds'));
  const value = Math.round(nextScoreSeconds(typeof row?.value === 'number' ? row.value : SCORE_SECONDS, measuredS));
  await ctx.db.insert(appSettings).values({ key: 'score_seconds', value }).onConflictDoUpdate({ target: appSettings.key, set: { value } });
}

/** ρ tracks the real host: an EMA of encode seconds per second of video (scoring excluded). */
async function updateRho(ctx: Ctx, hdr: boolean, encodeS: number, durationS: number) {
  const key = hdr ? 'rho_hdr' : 'rho_sdr';
  const [row] = await ctx.db.select().from(appSettings).where(eq(appSettings.key, key));
  const current = typeof row?.value === 'number' ? row.value : hdr ? DEFAULT_RHO.hdr : DEFAULT_RHO.sdr;
  const value = Math.round(nextRho(current, encodeS, durationS) * 1000) / 1000;
  await ctx.db.insert(appSettings).values({ key, value }).onConflictDoUpdate({ target: appSettings.key, set: { value } });
}
