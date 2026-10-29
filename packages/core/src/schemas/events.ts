import { z } from 'zod';
import { TIERS } from '../enums.ts';
import { Id, IsoDate, page, PageQuery } from './common.ts';

export const EventListQuery = PageQuery.extend({
  q: z.string().trim().max(200).optional(),
  year: z.coerce.number().int().min(1990).max(2100).optional(),
  hasVideos: z.coerce.boolean().optional(),
});

/** Counts and cover are computed per viewer: members never learn that core items exist. */
export const EventCard = z.object({
  id: Id,
  slug: z.string(),
  title: z.string(),
  startsOn: IsoDate,
  endsOn: IsoDate.nullable(),
  location: z.string().nullable(),
  photoCount: z.number().int(),
  videoCount: z.number().int(),
  coverUrl: z.string().nullable(),
  /** Core viewers only: the event has core-tier items (always false for members). */
  hasCore: z.boolean(),
});
export const EventPage = page(EventCard);

export const EventDetail = EventCard.extend({
  description: z.string().nullable(),
  defaultTier: z.enum(TIERS),
  coverAssetId: Id.nullable(),
});
export type EventCard = z.infer<typeof EventCard>;
export type EventDetail = z.infer<typeof EventDetail>;

const eventFields = {
  title: z.string().trim().min(1).max(200),
  startsOn: IsoDate,
  endsOn: IsoDate.nullish(),
  location: z.string().trim().max(200).nullish(),
  description: z.string().trim().max(5000).nullish(),
  defaultTier: z.enum(TIERS),
};
export const CreateEventBody = z
  .object(eventFields)
  .refine((e) => !e.endsOn || e.endsOn >= e.startsOn, { path: ['endsOn'], message: 'ends_before_start' });
export const PatchEventBody = z
  .object({ ...eventFields, coverAssetId: Id.nullable() })
  .partial()
  .refine((e) => !e.endsOn || !e.startsOn || e.endsOn >= e.startsOn, { path: ['endsOn'], message: 'ends_before_start' });
