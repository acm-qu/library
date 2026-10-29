import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { eventSearchQuery } from '../src/db/search.ts';
import { canTransition, isUnfinished } from '../src/status.ts';
import { CreateEventBody, Email, VerifyBody } from '../src/schemas/index.ts';

describe('status', () => {
  it('follows the lifecycle diagram', () => {
    expect(canTransition('processing', 'ready')).toBe(true);
    expect(canTransition('ready', 'ready')).toBe(true);
    expect(canTransition('original_only', 'ready')).toBe(false);
    expect(canTransition('deleting', 'queued')).toBe(false);
    expect(isUnfinished('queued')).toBe(true);
    expect(isUnfinished('failed')).toBe(false);
  });
});

describe('event search', () => {
  it('builds a prefix AND query with the words as a bound parameter', () => {
    const q = new PgDialect().sqlToQuery(eventSearchQuery("Hack-Night  '26 & drop;")!);
    expect(q.params).toEqual(['hack:* & night:* & 26:* & drop:*']);
    expect(q.sql).toContain("to_tsquery('simple', $1)");
  });
  it('returns null for punctuation only', () => expect(eventSearchQuery(' -- ')).toBeNull());
  it('keeps Arabic words', () => {
    const q = new PgDialect().sqlToQuery(eventSearchQuery('هاكاثون')!);
    expect(q.params).toEqual(['هاكاثون:*']);
  });
});

describe('schemas', () => {
  it('lower-cases and trims emails', () => expect(Email.parse('  Tech@QU.ACM.org ')).toBe('tech@qu.acm.org'));
  it('needs exactly 6 digits', () => {
    expect(VerifyBody.safeParse({ email: 'a@b.co', code: '04291' }).success).toBe(false);
    expect(VerifyBody.safeParse({ email: 'a@b.co', code: '042917' }).success).toBe(true);
  });
  it('rejects an event that ends before it starts', () => {
    const r = CreateEventBody.safeParse({ title: 'x', startsOn: '2026-10-29', endsOn: '2026-10-28', defaultTier: 'member' });
    expect(r.success).toBe(false);
  });
});
