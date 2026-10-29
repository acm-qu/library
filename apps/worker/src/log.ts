// Plain JSON lines on stdout (cron appends them to ~/logs/worker.log). Never logs job params or key paths.
export type Logger = { info(o: object, msg: string): void; warn(o: object, msg: string): void; error(o: object, msg: string): void };

const line = (level: string) => (o: object, msg: string) => {
  const safe = Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v instanceof Error ? { message: v.message, name: v.name } : v]));
  process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), level, msg, ...safe })}\n`);
};
export const log: Logger = { info: line('info'), warn: line('warn'), error: line('error') };
export const silent: Logger = { info() {}, warn() {}, error() {} };
