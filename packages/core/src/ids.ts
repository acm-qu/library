// UUID v7 ids are generated in the app: PostgreSQL 9.6 has no gen_random_uuid() without pgcrypto,
// and v7's time ordering keeps btree inserts append-mostly.
import { uuidv7 } from 'uuidv7';

export const newId = (): string => uuidv7();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string): boolean => UUID_RE.test(s);

/** 16 raw bytes of a UUID, used as AEAD associated data. */
export function uuidBytes(id: string): Buffer {
  if (!isUuid(id)) throw new TypeError(`not a uuid: ${id}`);
  return Buffer.from(id.replaceAll('-', ''), 'hex');
}
