// Tone-curve validation gate (deploy.sh runs it; re-run by hand with --force):
//   node --env-file=shared/.env worker/tonemap-gate.mjs [--force]
// Passes the encoder's own filter strings to `python -m mediaworker tonemap-gate`, so the acceptance test checks
// exactly what production runs. A pass writes LUTS_DIR/gate-passed.json, which lets an admin switch on tonemap_auto.
// The exit code is 0 whether or not the gate passes; only a crash is non-zero.
import { cfg } from './config.ts';
import { baseFilter } from './lib/ffmpeg.ts';
import { log } from './log.ts';
import { mediaworker } from './lib/spawn.ts';

type GateOut = { ok: boolean; reused: boolean; seconds: number; acceptance: { ok: boolean; results: Record<string, { mean: number; p999: number; max: number }> }; validation: { ok: boolean; order?: string[]; reason?: string; alignment_psnr_db?: number; also?: Record<string, boolean> } };

const args = ['tonemap-gate', '--luts', cfg.LUTS_DIR, '--clips', cfg.TONEMAP_CLIPS, '--ffmpeg', cfg.FFMPEG, '--ffprobe', cfg.FFPROBE];
for (const t of ['hlg', 'pq'] as const) args.push(`--chain-${t}`, baseFilter(t), `--table-${t}`, baseFilter(t, '{lut}'));
if (process.argv.includes('--force')) args.push('--force');

try {
  const r = await mediaworker<GateOut>(cfg.PYTHON, args, { timeoutMs: 60 * 60_000 });
  log.info({ ok: r.ok, reused: r.reused, seconds: r.seconds, acceptance: r.acceptance, validation: { ok: r.validation.ok, order: r.validation.order, reason: r.validation.reason, alignment: r.validation.alignment_psnr_db, also: r.validation.also } }, r.ok ? 'tone-curve gate passed' : 'tone-curve gate did not pass');
} catch (err) {
  log.error({ err }, 'tone-curve gate crashed');
  process.exitCode = 1;
}
