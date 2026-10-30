// Server configuration, validated once at boot by the API and the worker. Never imported by the web app.
// In production the values come from ~/apps/acm-media/shared/.env (chmod 600).
import { z } from 'zod';
import { Email } from './schemas/common.ts';

const base64Key = z
  .string()
  .refine((s) => Buffer.from(s, 'base64').length === 32, 'must be 32 random bytes, base64');

const emailList = z
  .string()
  .default('')
  .transform((s) => s.split(',').map((e) => e.trim()).filter(Boolean))
  .pipe(z.array(Email));

export const ServerConfig = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PUBLIC_ORIGIN: z.url(),
    PORT: z.coerce.number().int().default(3080),
    DATABASE_URL: z.string().startsWith('postgres'),
    MASTER_KEY: base64Key,
    OTP_PEPPER: base64Key,
    MAIL_TRANSPORT: z.enum(['smtp', 'log']).default('smtp'),
    SMTP_HOST: z.string().default('localhost'),
    SMTP_PORT: z.coerce.number().int().default(587),
    SMTP_USER: z.string().default(''),
    SMTP_PASS: z.string().default(''),
    SMTP_FROM: z.string().min(3),
    MEDIA_ROOT: z.string().min(1),
    KEYS_DIR: z.string().min(1),
    FFMPEG: z.string().default('ffmpeg'),
    FFPROBE: z.string().default('ffprobe'),
    PYTHON: z.string().default('python3'),
    /** Tone-curve tables and the validation gate's result. Generated on the server, outside any release. */
    LUTS_DIR: z.string().default('./luts'),
    /** The reviewed clips the validation gate scores (IMG_4515.MOV + T_*.mp4), kept out of git. */
    TONEMAP_CLIPS: z.string().default('./.data/tonemap-validation'),
    /** Built web app (apps/web/dist). Unset in development, where Vite serves the UI and proxies /api. */
    WEB_ROOT: z.string().optional(),
    /** API log file. Set in production: LiteSpeed's lsnode drops the app's stdout. */
    LOG_FILE: z.string().optional(),
    /** Shell command that starts one worker pass (the crontab's, with `flock -w 20` so it waits out a worker that's exiting). Unset: cron only. */
    WORKER_WAKE: z.string().optional(),
    UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(20 * 2 ** 30),
    UPLOAD_CHUNK_BYTES: z.coerce.number().int().positive().default(8 * 2 ** 20),
    PRELAUNCH_ALLOWLIST: emailList,
  })
  .refine((c) => c.NODE_ENV !== 'production' || c.MAIL_TRANSPORT === 'smtp', {
    path: ['MAIL_TRANSPORT'],
    message: 'production must send real mail',
  });
export type ServerConfig = z.infer<typeof ServerConfig>;

/** Parse the environment, listing every bad variable by name (never by value). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const r = ServerConfig.safeParse(env);
  if (r.success) return r.data;
  const lines = r.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
  throw new Error(`invalid configuration:\n${lines.join('\n')}`);
}
