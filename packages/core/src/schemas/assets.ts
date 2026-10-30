import { z } from 'zod';
import { ASSET_KINDS, ASSET_STATUSES, HDR_FORMATS, TIERS } from '../enums.ts';
import { Id, IsoDateTime, page, PageQuery } from './common.ts';

export const AssetListQuery = PageQuery.extend({
  kind: z.enum(ASSET_KINDS).optional(),
  tier: z.enum(TIERS).optional(), // ignored for members
});

/** One grid tile. `width`/`height` come from the ingest probe, so they exist from 'queued' on. */
export const AssetTile = z.object({
  id: Id,
  kind: z.enum(ASSET_KINDS),
  tier: z.enum(TIERS),
  status: z.enum(ASSET_STATUSES),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  durationS: z.number().nullable(),
  hdr: z.enum(HDR_FORMATS).nullable(),
  thumbUrl: z.string().nullable(),
  /** A re-process or retier job is running beside a ready item (core and admins only). */
  processing: z.boolean(),
  step: z.string().nullable(),
  progress: z.number().nullable(),
  readyInS: z.number().int().nullable(),
});
export const AssetPage = page(AssetTile);
export type AssetTile = z.infer<typeof AssetTile>;

export const AssetDetail = AssetTile.extend({
  eventId: Id,
  originalFilename: z.string(),
  originalMime: z.string().nullable(),
  originalSize: z.number().int().nullable(),
  downloadName: z.string(),
  capturedAt: IsoDateTime.nullable(),
  device: z.string().nullable(),
  fps: z.number().nullable(),
  uploader: z.object({ id: Id, name: z.string() }).nullable(),
  viewUrl: z.string().nullable(),
  posterUrl: z.string().nullable(),
  hlsUrl: z.string().nullable(),
  originalUrl: z.string().nullable(),
  variants: z.array(z.object({ label: z.string(), height: z.number().int(), bandwidth: z.number().int() })),
  canEdit: z.boolean(),
  canDelete: z.boolean(),
});
export type AssetDetail = z.infer<typeof AssetDetail>;

export const PatchAssetBody = z
  .object({ tier: z.enum(TIERS), eventId: Id })
  .partial()
  .refine((b) => b.tier !== undefined || b.eventId !== undefined, { message: 'empty_patch' });
