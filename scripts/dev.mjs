// `npm run dev`: API on :3000 (tsx watch) and Vite on :5173 (proxies /api). Ctrl+C stops both.
import { spawn } from 'node:child_process';

const procs = [
  ['api', ['run', 'dev', '-w', '@acm/api']],
  ['web', ['run', 'dev', '-w', '@acm/web']],
].map(([name, args]) => {
  // Own process group per child, so stopping kills npm, its shell and tsx/vite together.
  const p = spawn('npm', args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const tag = (chunk) => chunk.toString().split('\n').filter(Boolean).map((l) => `[${name}] ${l}`).join('\n') + '\n';
  p.stdout.on('data', (c) => process.stdout.write(tag(c)));
  p.stderr.on('data', (c) => process.stderr.write(tag(c)));
  p.on('exit', (code) => {
    console.log(`[${name}] exited (${code})`);
    stop();
  });
  return p;
});

function stop() {
  for (const p of procs) {
    try {
      process.kill(-p.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
