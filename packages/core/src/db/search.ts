// Event search for PostgreSQL 9.6 (no websearch_to_tsquery). Keep EVENT_SEARCH_VECTOR identical to the
// expression index in migrations/0001_events_cover_and_search.sql.
import { sql, type SQL } from 'drizzle-orm';

export const EVENT_SEARCH_VECTOR = sql.raw(
  `to_tsvector('simple'::regconfig, coalesce("events"."title", '') || ' ' || coalesce("events"."location", '') || ' ' || coalesce("events"."description", ''))`,
);

/** Every word must match, each as a prefix: "hack nig" finds "Hack Night". Returns null for an empty query. */
export function eventSearchQuery(q: string): SQL | null {
  const words = q
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, 8);
  if (words.length === 0) return null;
  const tsq = words.map((w) => `${w}:*`).join(' & ');
  return sql`${EVENT_SEARCH_VECTOR} @@ to_tsquery('simple', ${tsq})`;
}
