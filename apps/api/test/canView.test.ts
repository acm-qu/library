// The handoff's security checklist: every viewer × tier × status × girls-only × deleted combination, for access() and for the
// SQL used by lists, which must agree with it exactly.
import { ASSET_STATUSES, assets, events, TIERS } from '@acm/core/db';
import { newId } from '@acm/core/ids';
import type { Viewer } from '@acm/core/schemas';
import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { access, atLeast } from '../src/policy/canView.ts';
import { browsable, listed } from '../src/policy/visibleSql.ts';
import { addUser, db, resetDb } from './helpers.ts';

// Uploads come from a male and a female core member; only female core members (admins included) see girls-only rows.
type Who = 'member' | 'core' | 'core-uploader' | 'admin' | 'core-f' | 'core-f-uploader' | 'admin-f' | 'core-unset';
const WHO: Who[] = ['member', 'core', 'core-uploader', 'admin', 'core-f', 'core-f-uploader', 'admin-f', 'core-unset'];
const UPLOADERS = ['core-uploader', 'core-f-uploader'] as const;
const FEMALE = new Set<Who>(['core-f', 'core-f-uploader', 'admin-f']);
const ADMIN = new Set<Who>(['admin', 'admin-f']);

function expected(w: Who, tier: string, status: string, girlsOnly: boolean, uploader: Who): string {
  if (status === 'deleting' || (tier === 'core' && w === 'member') || (girlsOnly && !FEMALE.has(w))) return 'none';
  if (status === 'ready') return 'full';
  if (status === 'original_only') return 'download';
  return w === uploader || ADMIN.has(w) ? 'status' : 'none';
}

let viewers: Record<Who, Viewer>;

beforeAll(async () => {
  await resetDb();
  const mk = async (email: string, role: 'member' | 'core', isFemale: boolean | null, isAdmin = false) => {
    const u = await addUser(email, { role, isAdmin, isFemale });
    return { id: u.id, email: u.email, name: u.name, role, isAdmin, isFemale, status: 'active' } as Viewer;
  };
  viewers = {
    member: await mk('m@x.qa', 'member', null),
    core: await mk('c@x.qa', 'core', false),
    'core-uploader': await mk('u@x.qa', 'core', false),
    admin: await mk('a@x.qa', 'core', false, true),
    'core-f': await mk('cf@x.qa', 'core', true),
    'core-f-uploader': await mk('uf@x.qa', 'core', true),
    'admin-f': await mk('af@x.qa', 'core', true, true),
    'core-unset': await mk('cn@x.qa', 'core', null),
  };
  const eventId = newId();
  await db.insert(events).values({ id: eventId, title: 'E', slug: 'e', startsOn: '2026-10-01', createdBy: viewers.core.id });
  const rows = [];
  for (const tier of TIERS)
    for (const status of ASSET_STATUSES)
      for (const girlsOnly of [false, true])
        for (const up of UPLOADERS)
          for (const deleted of [false, true])
            rows.push({ id: newId(), eventId, kind: 'image' as const, tier, girlsOnly, status, originalFilename: `${tier}-${status}-${girlsOnly}-${up}-${deleted}`, originalExt: 'jpg', uploaderId: viewers[up].id, deletedAt: deleted ? new Date() : null });
  await db.insert(assets).values(rows);
});

describe('access() matrix (8 viewers × 2 tiers × 8 statuses × girls-only × 2 uploaders × deleted)', () => {
  for (const tier of TIERS)
    for (const status of ASSET_STATUSES)
      for (const girlsOnly of [false, true])
        for (const deleted of [false, true])
          it(`${tier} · ${status}${girlsOnly ? ' · girls-only' : ''}${deleted ? ' · deleted' : ''}`, () => {
            for (const up of UPLOADERS)
              for (const w of WHO) {
                const got = access(viewers[w], { tier, girlsOnly, status, uploaderId: viewers[up].id, deletedAt: deleted ? new Date() : null });
                expect([w, up, got]).toEqual([w, up, deleted ? 'none' : expected(w, tier, status, girlsOnly, up)]);
              }
          });

  it('denies disabled users, missing sessions and deleted events', () => {
    const a = { tier: 'member' as const, girlsOnly: false, status: 'ready' as const, uploaderId: viewers.core.id, deletedAt: null };
    expect(access(null, a)).toBe('none');
    expect(access({ ...viewers.admin, status: 'disabled' }, a)).toBe('none');
    expect(access(viewers.admin, a, true)).toBe('none');
    expect(access({ ...viewers['admin-f'], status: 'disabled' }, { ...a, girlsOnly: true })).toBe('none');
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
