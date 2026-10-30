// Start the worker when an upload finishes instead of waiting for cron. WORKER_WAKE is the crontab's command
// (same lock), so a worker that's already running just picks the job up; cron covers everything else.
import { spawn } from 'node:child_process';

export function wakeWorker(command: string | undefined) {
  if (!command) return;
  // Own process group, so restarting the API (deploys pkill lsnode) never stops a running encode.
  spawn('/bin/sh', ['-c', command], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
}
