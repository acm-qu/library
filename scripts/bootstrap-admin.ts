// Create (or promote) the first admin. Idempotent: re-running leaves an existing admin unchanged.
//   npm run bootstrap-admin -- tech@qu.acm.org "QU ACM Tech"
import { eq } from 'drizzle-orm';
import { createDb, users } from '@acm/core/db';
import { newId } from '@acm/core/ids';
import { Email } from '@acm/core/schemas';

const [rawEmail = 'tech@qu.acm.org', name = 'QU ACM Tech'] = process.argv.slice(2);
const email = Email.parse(rawEmail);
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');

const { db, pool } = createDb(url, 1);
try {
  const [existing] = await db.select().from(users).where(eq(users.email, email));
  if (existing) {
    await db.update(users).set({ role: 'core', isAdmin: true, status: 'active' }).where(eq(users.id, existing.id));
    console.log(`${email} is an active core admin (id ${existing.id})`);
  } else {
    const id = newId();
    await db.insert(users).values({ id, email, name, role: 'core', isAdmin: true });
    console.log(`created admin ${email} (id ${id})`);
  }
} finally {
  await pool.end();
}
