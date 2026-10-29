import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';

const key = Buffer.alloc(32, 1).toString('base64');
const env = {
  PUBLIC_ORIGIN: 'https://library.qu.acm.org',
  DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/db',
  MASTER_KEY: key,
  OTP_PEPPER: key,
  SMTP_FROM: 'QU ACM Media Library <noreply@qu.acm.org>',
  MEDIA_ROOT: '/home/quhosting/media',
  KEYS_DIR: '/home/quhosting/keys',
};

describe('config', () => {
  it('parses defaults and the allowlist', () => {
    const c = loadConfig({ ...env, PRELAUNCH_ALLOWLIST: ' Tech@qu.acm.org, ' });
    expect(c.PRELAUNCH_ALLOWLIST).toEqual(['tech@qu.acm.org']);
    expect(c.UPLOAD_CHUNK_BYTES).toBe(8 * 2 ** 20);
  });
  it('names bad variables without echoing secrets', () => {
    expect(() => loadConfig({ ...env, MASTER_KEY: 'c2hvcnQ=' })).toThrow(/MASTER_KEY: must be 32/);
    try {
      loadConfig({ ...env, MASTER_KEY: 'c2hvcnQ=' });
    } catch (e) {
      expect(String(e)).not.toContain('c2hvcnQ=');
    }
  });
  it('refuses log mail in production', () => {
    expect(() => loadConfig({ ...env, NODE_ENV: 'production', MAIL_TRANSPORT: 'log' })).toThrow(/MAIL_TRANSPORT/);
  });
});
