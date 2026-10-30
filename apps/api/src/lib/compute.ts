// Live usage for Admin › Processing, read from /proc the way CloudLinux counts it: every task (process and thread)
// of this account, across all its sites, plus this app's share. Linux only; elsewhere it reports unavailable.
import { readdir, readFile, stat } from 'node:fs/promises';

// shortcut: copied from cPanel › Resource Usage (NPROC 200, SPEED 400%, IO 30 MB/s); update if the host changes them.
export const HOST_LIMITS = { threads: 200, cpuPct: 400, ioBps: 30 * 2 ** 20 };
// The library's processes: the API (lsnode …/acm-media/app), the worker and its flock/sh wrappers, Python and ffmpeg.
const APP = /acm-media|mediaworker|\/bin\/ffmpeg|\/bin\/ffprobe/;
// The worker's processes (cron entries worker/*.mjs, Python, ffmpeg), for the IO allocator; the API's ingest ffprobe counts here too.
const WORKER = /worker\/[\w-]+\.mjs|mediaworker|\/bin\/ffmpeg|\/bin\/ffprobe/;

/** utime + stime (clock ticks) and thread count from a /proc/<pid>/stat line; the name in (…) may contain spaces. */
export function parseStat(line: string) {
  const f = line.slice(line.lastIndexOf(')') + 2).split(' ');
  return { ticks: Number(f[11]) + Number(f[12]), threads: Number(f[17]) };
}

/** Bytes that actually reached or left the disk (read_bytes + write_bytes) from /proc/<pid>/io. */
export function parseIo(text: string) {
  const get = (k: string) => Number(new RegExp(`^${k}: (\\d+)$`, 'm').exec(text)?.[1] ?? 0);
  return get('read_bytes') + get('write_bytes');
}

type Proc = { ticks: number; threads: number; io: number; app: boolean; worker: boolean };

async function snapshot(uid: number) {
  const out = new Map<string, Proc>();
  for (const pid of await readdir('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      if ((await stat(`/proc/${pid}`)).uid !== uid) continue;
      const [st, io, cmd] = await Promise.all([
        readFile(`/proc/${pid}/stat`, 'utf8'),
        readFile(`/proc/${pid}/io`, 'utf8').catch(() => ''),
        readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => ''),
      ]);
      const line = cmd.replaceAll('\0', ' ');
      out.set(pid, { ...parseStat(st), io: parseIo(io), app: APP.test(line), worker: WORKER.test(line) });
    } catch {
      /* exited meanwhile */
    }
  }
  return out;
}

let lastIo: { at: number; io: Map<string, Proc> } | null = null;

export type IoSplit = { account: number; self: number; worker: number };

/** Disk bytes/s since the previous call: the whole account, this process, the worker's processes. Null on the first call or off Linux. */
export async function ioSince(): Promise<IoSplit | null> {
  const uid = process.getuid?.();
  if (process.platform !== 'linux' || uid === undefined) return null;
  const snap = await snapshot(uid);
  const now = Date.now();
  const prev = lastIo;
  lastIo = { at: now, io: snap };
  if (!prev || now <= prev.at) return null;
  const secs = (now - prev.at) / 1000;
  const out = { account: 0, self: 0, worker: 0 };
  for (const [pid, p] of snap) {
    const before = prev.io.get(pid);
    if (!before) continue;
    const bps = Math.max(0, p.io - before.io) / secs;
    out.account += bps;
    if (pid === String(process.pid)) out.self += bps;
    else if (p.worker) out.worker += bps;
  }
  return out;
}

const zero = { threads: 0, cpuPct: 0, ioBps: 0 };

/** Two snapshots `sampleMs` apart: threads now, CPU % (100 = one core) and disk bytes/s over the gap. */
export async function computeUsage(sampleMs = 1000) {
  const uid = process.getuid?.();
  if (process.platform !== 'linux' || uid === undefined) return { available: false, ...zero, app: zero, limits: HOST_LIMITS };
  const t0 = Date.now();
  const a = await snapshot(uid);
  await new Promise((r) => setTimeout(r, sampleMs));
  const b = await snapshot(uid);
  const secs = (Date.now() - t0) / 1000;
  const total = { ...zero };
  const app = { ...zero };
  for (const [pid, p] of b) {
    const before = a.get(pid);
    // Linux reports CPU time in 1/100 s ticks, so ticks per second is already a percentage of one core.
    const cpu = before ? (p.ticks - before.ticks) / secs : 0;
    const io = before ? Math.max(0, p.io - before.io) / secs : 0;
    for (const sum of p.app ? [total, app] : [total]) {
      sum.threads += p.threads;
      sum.cpuPct += cpu;
      sum.ioBps += io;
    }
  }
  const round = (u: typeof zero) => ({ threads: u.threads, cpuPct: Math.round(u.cpuPct), ioBps: Math.round(u.ioBps) });
  return { available: true, ...round(total), app: round(app), limits: HOST_LIMITS };
}
