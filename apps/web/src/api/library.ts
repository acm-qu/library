import { AssetDetail, AssetPage, EventDetail, EventPage } from '@acm/core/schemas';
import { z } from 'zod';
import { call, q } from './client.ts';

export type EventFilters = { q?: string; year?: number; hasVideos?: boolean };
export const getEvents = (f: EventFilters, cursor?: string) =>
  call(EventPage, `/events${q({ q: f.q, year: f.year, hasVideos: f.hasVideos || undefined, cursor, limit: 24 })}`);
export const getYears = () => call(z.object({ years: z.array(z.number()) }), '/events/years');
export const getEvent = (idOrSlug: string) => call(EventDetail, `/events/${encodeURIComponent(idOrSlug)}`);

export type AssetFilters = { kind?: 'image' | 'video'; tier?: 'member' | 'core' };
export const getEventAssets = (eventId: string, f: AssetFilters, cursor?: string) =>
  call(AssetPage, `/events/${eventId}/assets${q({ ...f, cursor, limit: 100 })}`);
export const getAsset = (id: string) => call(AssetDetail, `/assets/${id}`);
