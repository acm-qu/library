// Child processes (python, ffmpeg) with thread caps, lower priority, a hard timeout and cancellation.
import { spawn } from 'node:child_process';
import { setPriority } from 'node:os';

/** The host reports 64 CPUs; without caps, numpy/torch/ffmpeg would each start dozens of threads. */
export const THREAD_ENV = { OMP_NUM_THREADS: '2', OPENBLAS_NUM_THREADS: '1', MKL_NUM_THREADS: '1', NUMEXPR_NUM_THREADS: '1', VECLIB_MAXIMUM_THREADS: '1' };

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
    const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...THREAD_ENV }, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      if (child.pid) setPriority(child.pid, 10);
    } catch {
      /* not permitted everywhere */
    }
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
      reject(new ChildFailed(`${cmd}: ${e.message}`, 'spawn_failed', ''));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (poll) clearInterval(poll);
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
    const child = spawn(python, ['-m', 'mediaworker', ...args], { cwd: opts.cwd, env: { ...process.env, ...THREAD_ENV }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const killTree = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    try {
      if (child.pid) setPriority(child.pid, 10);
    } catch {
      /* ignore */
    }
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
      reject(new ChildFailed(`${python}: ${e.message}`, 'spawn_failed', ''));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (poll) clearInterval(poll);
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
