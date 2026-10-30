// Start the worker when an upload finishes instead of waiting for cron. WORKER_WAKE uses the crontab's lock with
// `flock -w 20` (cron uses -n): a running worker picks the job up, and one that's exiting is waited out. Cron covers
// everything else (admin actions, retries, crashes).
import { spawn } from 'node:child_process';

export function wakeWorker(command: string | undefined) {
  if (!command) return;
  // Own process group, so restarting the API (deploys pkill lsnode) never stops a running encode.
  spawn('/bin/sh', ['-c', command], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
}
