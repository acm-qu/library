// Start the worker when an upload finishes instead of waiting for cron. WORKER_WAKE uses the crontab's lock with
// `flock -w 20` (cron uses -n): a running worker picks the job up, and one that's exiting is waited out. Cron covers
// everything else (admin actions, retries, crashes).
import { type ChildProcess, spawn } from 'node:child_process';

// At most one waiter: a batch of uploads would otherwise pile up a `flock -w 20` shell per file (NPROC).
let pending: ChildProcess | null = null;

export function wakeWorker(command: string | undefined) {
  if (!command || pending) return;
  // Own process group, so restarting the API (deploys pkill lsnode) never stops a running encode.
  const child = spawn('/bin/sh', ['-c', command], { detached: true, stdio: 'ignore' });
  pending = child;
  const done = () => {
    if (pending === child) pending = null;
  };
  child.on('error', done).on('exit', done).unref();
}
