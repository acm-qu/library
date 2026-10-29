import { z } from 'zod';

export const Id = z.uuid();
export const IsoDate = z.iso.date(); // YYYY-MM-DD
export const IsoDateTime = z.iso.datetime({ offset: true });
export const Email = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email().max(254));

export const PageQuery = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const page = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });
