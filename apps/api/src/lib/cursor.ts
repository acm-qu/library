// Opaque keyset cursors: base64url JSON of the last row's sort key. Garbage decodes to null (first page).
import { z } from 'zod';

export const encodeCursor = (key: Record<string, string | number>) => Buffer.from(JSON.stringify(key)).toString('base64url');

export function decodeCursor<T extends z.ZodType>(schema: T, cursor: string | undefined): z.infer<T> | null {
  if (!cursor) return null;
  try {
    const r = schema.safeParse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}
