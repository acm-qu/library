// Re-wrap every asset key under a new MASTER_KEY, in one transaction. File contents never change.
//   OLD_MASTER_KEY=... NEW_MASTER_KEY=... npm run rotate-master-key
// Then put NEW_MASTER_KEY into shared/.env (and the password manager) and restart the app and worker.
import { assetKeys, createDb } from '@acm/core/db';
import { parseMasterKey, unwrapKey, wrapKey } from '@acm/core/crypto';
import { eq } from 'drizzle-orm';

export async function rotate(url: string, oldB64: string, newB64: string) {
  const oldKey = parseMasterKey(oldB64);
  const newKey = parseMasterKey(newB64);
  if (oldKey.equals(newKey)) throw new Error('the new key is the same as the old one');
  const { db, pool } = createDb(url, 1);
  try {
    return await db.transaction(async (tx) => {
      const rows = await tx.select().from(assetKeys).for('update');
      for (const r of rows) {
        await tx
          .update(assetKeys)
          .set({
            fileKeyWrapped: wrapKey(unwrapKey(r.fileKeyWrapped, oldKey), newKey),
            hlsKeyWrapped: r.hlsKeyWrapped ? wrapKey(unwrapKey(r.hlsKeyWrapped, oldKey), newKey) : null,
          })
          .where(eq(assetKeys.assetId, r.assetId));
      }
      return rows.length;
    });
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { DATABASE_URL, OLD_MASTER_KEY, NEW_MASTER_KEY } = process.env;
  if (!DATABASE_URL || !OLD_MASTER_KEY || !NEW_MASTER_KEY) throw new Error('DATABASE_URL, OLD_MASTER_KEY and NEW_MASTER_KEY are required');
  const n = await rotate(DATABASE_URL, OLD_MASTER_KEY, NEW_MASTER_KEY);
  console.log(`re-wrapped ${n} asset keys; now set MASTER_KEY to the new value and restart`);
}
