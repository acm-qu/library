import { AssetDetail, AssetPage, EventDetail, EventPage, LoginMosaic, type PatchEventBody } from '@acm/core/schemas';
import { z } from 'zod';
import { call, q } from './client.ts';

export type EventFilters = { q?: string; year?: number; hasVideos?: boolean };
export const getEvents = (f: EventFilters, cursor?: string) =>
  call(EventPage, `/events${q({ q: f.q, year: f.year, hasVideos: f.hasVideos || undefined, cursor, limit: 24 })}`);
export const getYears = () => call(z.object({ years: z.array(z.number()) }), '/events/years');
export const getEvent = (idOrSlug: string) => call(EventDetail, `/events/${encodeURIComponent(idOrSlug)}`);
export const patchEvent = (id: string, body: z.input<typeof PatchEventBody>) => call(EventDetail, `/events/${id}`, { method: 'PATCH', json: body });
/** Admins only: hides the event and queues purges of all its items. */
export const deleteEvent = (id: string) => call(null, `/events/${id}`, { method: 'DELETE' });

export type AssetFilters = { kind?: 'image' | 'video'; tier?: 'member' | 'core' };
export const getEventAssets = (eventId: string, f: AssetFilters, cursor?: string) =>
  call(AssetPage, `/events/${eventId}/assets${q({ ...f, cursor, limit: 100 })}`);
export const getAsset = (id: string) => call(AssetDetail, `/assets/${id}`);

/** One request for every photo in the sign-in page's mosaic (public thumbnails inlined as data: URLs). */
export const getLoginMosaic = () => call(LoginMosaic, '/public/login-mosaic');
