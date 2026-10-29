// Development data: three users (member, core, admin), two years of events, and assets in every status with
// real-looking dimensions. Media files arrive with the worker (Milestone 5); until then tiles show placeholders.
//   npm run seed            (refuses to run when NODE_ENV=production)
import { assets, createDb, events, jobs, users } from '@acm/core/db';
type NewAsset = typeof assets.$inferInsert;
import { newId } from '@acm/core/ids';
import { sql } from 'drizzle-orm';

if (process.env.NODE_ENV === 'production') throw new Error('seed is for development databases only');
const { db, pool } = createDb(process.env.DATABASE_URL!, 1);

const people = [
  { email: 'tech@qu.acm.org', name: 'QU ACM Tech', role: 'core' as const, isAdmin: true },
  { email: 'omar@qu.edu.qa', name: 'Omar H.', role: 'core' as const, isAdmin: false },
  { email: 'mariam@qu.edu.qa', name: 'Mariam K.', role: 'member' as const, isAdmin: false },
];
const ids: Record<string, string> = {};
for (const p of people) {
  const [u] = await db
    .insert(users)
    .values({ id: newId(), ...p })
    .onConflictDoUpdate({ target: users.email, set: { role: p.role, isAdmin: p.isAdmin, name: p.name } })
    .returning();
  ids[p.email] = u!.id;
}
const omar = ids['omar@qu.edu.qa']!;

await db.execute(sql`delete from jobs; delete from renditions; update events set cover_asset_id = null; delete from assets; delete from events;`);

const EVENTS: [string, string, string | null, number, number, boolean][] = [
  ['Hackathon, day 2', '2026-10-18', 'Engineering Building, Room C07', 60, 2, true],
  ['Hackathon, day 1', '2026-10-17', 'Engineering Building, Room C07', 90, 3, true],
  ['Intro to Git workshop', '2026-10-08', 'Library, Lab 2', 24, 0, false],
  ['Career talk: ML in industry', '2026-09-24', null, 18, 1, false],
  ['Programming contest, qualifier', '2026-09-15', 'CSE Labs', 40, 0, false],
  ['Fall Welcome Night', '2026-09-03', 'Student Center', 70, 6, false],
  ['Core team retreat', '2026-08-28', null, 30, 4, true],
  ['Spring showcase', '2026-04-30', 'Main Hall', 45, 2, false],
  ['Web dev bootcamp', '2025-11-12', null, 28, 0, false],
  ['Python for beginners', '2025-10-29', null, 20, 0, false],
  ['Fall Welcome Night', '2025-09-04', 'Student Center', 50, 3, false],
  ['Hack the Campus', '2025-04-18', null, 80, 5, false],
];
const RATIOS: [number, number][] = [[4032, 3024], [3024, 4032], [4032, 2268], [3000, 3000], [1920, 1080], [1080, 1920], [4000, 2667]];

let n = 0;
for (const [title, startsOn, location, photos, videos, hasCore] of EVENTS) {
  const eventId = newId();
  const slug = `${startsOn}-${title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
  await db.insert(events).values({
    id: eventId, title, slug, startsOn, location,
    description: title.startsWith('Hackathon') ? '24 hours of building, 31 teams. Opening talks, team photos and the midnight pizza run.' : null,
    createdBy: omar, defaultTier: title === 'Core team retreat' ? 'core' : 'member',
  });
  const base = new Date(`${startsOn}T09:00:00Z`).getTime();
  const rows: NewAsset[] = [];
  let videoCount = 0;
  for (let i = 0; i < photos + videos; i++) {
    const video: boolean = videoCount < videos && i % Math.max(2, Math.floor((photos + videos) / Math.max(1, videos))) === 1;
    if (video) videoCount++;
    const [w, h] = video ? RATIOS[4 + (i % 2)]! : RATIOS[n++ % RATIOS.length]!;
    const status: NewAsset['status'] = title === 'Hackathon, day 1' ? ((['processing', 'queued', 'failed', 'needs_review'] as const)[i] ?? 'ready') : 'ready';
    rows.push({
      id: newId(), eventId, kind: video ? ('video' as const) : ('image' as const),
      tier: (title === 'Core team retreat' || (hasCore && i % 9 === 3) ? 'core' : 'member') as 'core' | 'member',
      status, originalFilename: video ? `IMG_${4500 + i}.MOV` : `IMG_${4700 + i}.HEIC`, originalExt: video ? 'mov' : 'heic',
      originalMime: video ? 'video/quicktime' : 'image/heic', originalSize: video ? 80_000_000 + i * 1000 : 3_100_000 + i * 1000,
      width: w, height: h, durationS: video ? 30 + ((i * 37) % 600) : null, hdr: video ? ('hlg' as const) : null,
      uploaderId: omar, capturedAt: new Date(base + i * 97_000), device: 'iPhone 15 Pro',
    });
  }
  await db.insert(assets).values(rows);
  for (const r of rows.filter((x) => x.status === 'processing' || x.status === 'queued'))
    await db.insert(jobs).values({ id: newId(), assetId: r.id, kind: 'process', state: r.status === 'processing' ? 'running' : 'queued', step: r.status === 'processing' ? 'Encoding 720p' : null, progress: r.status === 'processing' ? 0.4 : null, startedAt: r.status === 'processing' ? new Date() : null });
}
console.log(`seeded ${EVENTS.length} events; users: ${people.map((p) => p.email).join(', ')}`);
await pool.end();
