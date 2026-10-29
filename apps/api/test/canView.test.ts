// The handoff's security checklist: every role × tier × status × deleted combination, for access() and for the
// SQL used by lists, which must agree with it exactly.
import { ASSET_STATUSES, assets, events, TIERS } from '@acm/core/db';
import { newId } from '@acm/core/ids';
import type { Viewer } from '@acm/core/schemas';
import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { access, atLeast } from '../src/policy/canView.ts';
import { browsable, listed } from '../src/policy/visibleSql.ts';
import { addUser, db, resetDb } from './helpers.ts';

type Who = 'member' | 'core' | 'core-uploader' | 'admin';
const WHO: Who[] = ['member', 'core', 'core-uploader', 'admin'];

const expected: Record<string, Record<Who, string>> = {};
for (const tier of TIERS)
  for (const status of ASSET_STATUSES) {
    const row = {} as Record<Who, string>;
    for (const w of WHO) {
      let level = 'none';
      const sees = tier === 'member' || w !== 'member';
      if (status === 'deleting' || !sees) level = 'none';
      else if (status === 'ready') level = 'full';
      else if (status === 'original_only') level = 'download';
      else if (w === 'core-uploader' || w === 'admin') level = 'status';
      row[w] = level;
    }
    expected[`${tier}/${status}`] = row;
  }

let viewers: Record<Who, Viewer>;
let uploaderId: string;

beforeAll(async () => {
  await resetDb();
  const mk = async (email: string, role: 'member' | 'core', isAdmin = false) => {
    const u = await addUser(email, { role, isAdmin });
    return { id: u.id, email: u.email, name: u.name, role, isAdmin, status: 'active' } as Viewer;
  };
  viewers = {
    member: await mk('m@x.qa', 'member'),
    core: await mk('c@x.qa', 'core'),
    'core-uploader': await mk('u@x.qa', 'core'),
    admin: await mk('a@x.qa', 'core', true),
  };
  uploaderId = viewers['core-uploader'].id;
  const eventId = newId();
  await db.insert(events).values({ id: eventId, title: 'E', slug: 'e', startsOn: '2026-10-01', createdBy: uploaderId });
  const rows = [];
  for (const tier of TIERS)
    for (const status of ASSET_STATUSES)
      for (const deleted of [false, true])
        rows.push({ id: newId(), eventId, kind: 'image' as const, tier, status, originalFilename: `${tier}-${status}-${deleted}`, originalExt: 'jpg', uploaderId, deletedAt: deleted ? new Date() : null });
  await db.insert(assets).values(rows);
});

describe('access() matrix (4 roles × 2 tiers × 8 statuses × deleted)', () => {
  for (const tier of TIERS)
    for (const status of ASSET_STATUSES)
      for (const deleted of [false, true])
        it(`${tier} · ${status}${deleted ? ' · deleted' : ''}`, () => {
          for (const w of WHO) {
            const got = access(viewers[w], { tier, status, uploaderId, deletedAt: deleted ? new Date() : null });
            expect([w, got]).toEqual([w, deleted ? 'none' : expected[`${tier}/${status}`]![w]]);
          }
        });

  it('denies disabled users, missing sessions and deleted events', () => {
    const a = { tier: 'member' as const, status: 'ready' as const, uploaderId, deletedAt: null };
    expect(access(null, a)).toBe('none');
    expect(access({ ...viewers.admin, status: 'disabled' }, a)).toBe('none');
    expect(access(viewers.admin, a, true)).toBe('none');
  });

  it('orders levels for route guards', () => {
    expect(atLeast('download', 'download')).toBe(true);
    expect(atLeast('download', 'full')).toBe(false);
    expect(atLeast('status', 'download')).toBe(false);
  });
});

describe('list SQL agrees with access()', () => {
  for (const w of WHO)
    it(`for ${w}`, async () => {
      const v = viewers[w];
      const all = await db.select().from(assets);
      const listedIds = new Set((await db.select({ id: assets.id }).from(assets).where(listed(v))).map((r) => r.id));
      const browsableIds = new Set((await db.select({ id: assets.id }).from(assets).where(and(browsable(v), eq(assets.kind, 'image')))).map((r) => r.id));
      for (const a of all) {
        const level = access(v, a);
        expect([a.originalFilename, listedIds.has(a.id)]).toEqual([a.originalFilename, atLeast(level, 'status')]);
        expect([a.originalFilename, browsableIds.has(a.id)]).toEqual([a.originalFilename, atLeast(level, 'download')]);
      }
    });
});
