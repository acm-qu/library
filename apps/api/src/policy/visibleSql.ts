// The SQL twin of access() for list queries. `listed` = access ≥ 'status'; `browsable` = ready or original-only
// (what counts and covers use). The matrix test checks both against access() row by row.
import { assets } from '@acm/core/db';
import type { Viewer } from '@acm/core/schemas';
import { sql, type SQL } from 'drizzle-orm';
import { seesGirlsOnly } from './canView.ts';

const UNFINISHED = sql`(${assets.status} in ('uploading','queued','processing','failed','needs_review'))`;
const BROWSABLE = sql`(${assets.status} in ('ready','original_only'))`;

export const girlsOk = (v: Viewer): SQL => (seesGirlsOnly(v) ? sql`true` : sql`not ${assets.girlsOnly}`);

function tierOk(v: Viewer): SQL {
  return sql`(${v.role === 'core' ? sql`true` : sql`${assets.tier} = 'member'`} and ${girlsOk(v)})`;
}

export function browsable(v: Viewer): SQL {
  return sql`(${assets.deletedAt} is null and ${tierOk(v)} and ${BROWSABLE})`;
}

export function listed(v: Viewer): SQL {
  const own = v.isAdmin ? sql`true` : sql`${assets.uploaderId} = ${v.id}`;
  return sql`(${assets.deletedAt} is null and ${tierOk(v)} and (${BROWSABLE} or (${UNFINISHED} and ${own})))`;
}
