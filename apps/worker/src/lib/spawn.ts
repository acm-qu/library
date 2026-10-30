// Child processes (python, ffmpeg) with thread caps, lower priority, a hard timeout and cancellation.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { setPriority } from 'node:os';
import path from 'node:path';

/** The host reports 64 CPUs; without caps, numpy/torch/ffmpeg would each start dozens of threads. */
export const THREAD_ENV = { OMP_NUM_THREADS: '2', OPENBLAS_NUM_THREADS: '1', MKL_NUM_THREADS: '1', NUMEXPR_NUM_THREADS: '1', VECLIB_MAXIMUM_THREADS: '1' };

/** `ionice -c3` (idle IO class) when the host has it, so encodes never starve the API's disk reads. Resolved once. */
const findTool = (name: string) =>
  ['/usr/bin', ...(process.env.PATH ?? '').split(path.delimiter).filter((d) => path.isAbsolute(d))].map((d) => path.join(d, name)).find((f) => existsSync(f)) ?? null;
const IONICE = findTool('ionice');
/** The account's CPU quota is 4 cores; children get 2 (≤ 200%), and 2-3 because CPUs 0-1 carry the network softirqs. */
export const WORKER_CPUS = '2-3';
const TASKSET = findTool('taskset');
const wrap = (cmd: string, args: string[]): [string, string[]] => {
  const pre = [...(IONICE ? [IONICE, '-c3'] : []), ...(TASKSET ? [TASKSET, '-c', WORKER_CPUS] : [])];
  return pre.length ? [pre[0]!, [...pre.slice(1), cmd, ...args]] : [cmd, args];
};
// ionice could not exec the command (126/127): the same as spawn failing.
const execFailed = (code: number | null) => !!(IONICE || TASKSET) && (code === 126 || code === 127);

function lowerPriority(pid: number | undefined) {
  try {
    if (pid) setPriority(pid, 19);
  } catch {
    /* not permitted everywhere */
  }
}

/** Threads (CloudLinux counts them against NPROC) of one process, or of its whole process group; 0 off Linux. */
function threadsOf(pid: number, group: boolean): number {
  try {
    if (!group) return readdirSync(`/proc/${pid}/task`).length;
    let n = 0;
    for (const p of readdirSync('/proc')) {
      if (!/^\d+$/.test(p)) continue;
      try {
        const st = readFileSync(`/proc/${p}/stat`, 'utf8');
        const f = st.slice(st.lastIndexOf(')') + 2).split(' '); // f[2] = pgrp, f[17] = num_threads
        if (Number(f[2]) === pid) n += Number(f[17]);
      } catch {
        /* exited meanwhile */
      }
    }
    return n;
  } catch {
    return 0;
  }
}

let peakThreads = 0;
/** Highest thread count any child reached since the last call (the runner logs it per job). */
export function takePeakThreads(): number {
  const p = peakThreads;
  peakThreads = 0;
  return p;
}
function sampleThreads(pid: number | undefined, group: boolean) {
  if (!pid || process.platform !== 'linux') return null;
  return setInterval(() => (peakThreads = Math.max(peakThreads, threadsOf(pid, group))), 2000);
}

export class ChildFailed extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly stderrTail: string,
  ) {
    super(message);
  }
}

export type RunOpts = { timeoutMs: number; cwd?: string; isCancelled?: () => Promise<boolean>; onStderr?: (line: string) => void; onStdout?: (line: string) => void };

export function run(cmd: string, args: string[], opts: RunOpts): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(...wrap(cmd, args), { cwd: opts.cwd, env: { ...process.env, ...THREAD_ENV }, stdio: ['ignore', 'pipe', 'pipe'] });
    lowerPriority(child.pid);
    const sampler = sampleThreads(child.pid, false);
    let stdout = '';
    let stderr = '';
    let killedFor: string | null = null;
    child.stdout.on('data', (c: Buffer) => {
      const s = c.toString();
      if (opts.onStdout) {
        for (const line of s.split(/\r|\n/)) if (line) opts.onStdout(line);
      } else stdout += s;
    });
    child.stderr.on('data', (c: Buffer) => {
      const s = c.toString();
      stderr = (stderr + s).slice(-16_000);
      if (opts.onStderr) for (const line of s.split(/\r|\n/)) if (line) opts.onStderr(line);
    });
    const kill = (why: string) => {
      killedFor = why;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    };
    const timer = setTimeout(() => kill('timeout'), opts.timeoutMs);
    const poll = opts.isCancelled
      ? setInterval(() => void opts.isCancelled!().then((c) => c && kill('cancelled')), 5000)
      : null;
    child.on('error', (e) => {
      clearTimeout(timer);
      if (poll) clearInterval(poll);
      if (sampler) clearInterval(sampler);
      reject(new ChildFailed(`${cmd}: ${e.message}`, 'spawn_failed', ''));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (poll) clearInterval(poll);
      if (sampler) clearInterval(sampler);
      if (execFailed(code)) return reject(new ChildFailed(`${cmd}: could not start`, 'spawn_failed', stderr.slice(-4000)));
      if (killedFor) return reject(new ChildFailed(`${cmd} ${killedFor}`, killedFor, stderr.slice(-4000)));
      if (code !== 0) return reject(new ChildFailed(`${cmd} exited ${code}`, 'exit', stderr.slice(-4000)));
      resolve({ stdout, stderr });
    });
  });
}

/** python -m mediaworker <cmd>: one JSON object on stdout, also on failure. */
export function mediaworker<T>(python: string, args: string[], opts: RunOpts): Promise<T> {
  return new Promise((resolve, reject) => {
    // Its own process group, so a timeout or cancel also stops the ffmpeg it runs (tone-curve scoring scans and
    // extracts frames); killing only Python would leave those running.
    const child = spawn(...wrap(python, ['-m', 'mediaworker', ...args]), { cwd: opts.cwd, env: { ...process.env, ...THREAD_ENV }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const killTree = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    lowerPriority(child.pid);
    const sampler = sampleThreads(child.pid, true);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr = (stderr + c.toString()).slice(-8000)));
    let cancelled = false;
    const timer = setTimeout(killTree, opts.timeoutMs);
    const poll = opts.isCancelled
      ? setInterval(
          () =>
            void opts.isCancelled!().then((c) => {
              if (!c) return;
              cancelled = true;
              killTree();
            }),
          5000,
        )
      : null;
    child.on('error', (e) => {
      clearTimeout(timer);
      if (poll) clearInterval(poll);
      if (sampler) clearInterval(sampler);
      reject(new ChildFailed(`${python}: ${e.message}`, 'spawn_failed', ''));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (poll) clearInterval(poll);
      if (sampler) clearInterval(sampler);
      if (execFailed(code)) return reject(new ChildFailed(`${python}: could not start`, 'spawn_failed', stderr));
      if (cancelled) return reject(new ChildFailed(`mediaworker ${args[0]} cancelled`, 'cancelled', stderr));
      let out: (T & { error?: string; message?: string }) | null = null;
      try {
        out = JSON.parse(stdout);
      } catch {
        /* handled below */
      }
      if (signal) return reject(new ChildFailed(`mediaworker ${args[0]} killed (${signal})`, 'timeout', stderr));
      if (code !== 0 || !out) return reject(new ChildFailed(out?.message ?? `mediaworker ${args[0]} exited ${code}`, out?.error ?? 'exit', stderr));
      resolve(out);
    });
  });
}
