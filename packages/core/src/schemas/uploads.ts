import { z } from 'zod';
import { ASSET_KINDS, ASSET_STATUSES, HDR_FORMATS, TIERS } from '../enums.ts';
import { Id, IsoDateTime, page } from './common.ts';

/** tus Upload-Metadata, decoded. The type is sniffed from magic bytes on finish; `filetype` is advisory. */
export const UploadMetadata = z.object({
  eventId: Id,
  tier: z.enum(TIERS),
  /** tus metadata values are strings; absent means not girls-only. */
  girlsOnly: z.enum(['true', 'false']).default('false').transform((s) => s === 'true'),
  filename: z.string().min(1).max(255),
  filetype: z.string().max(255).nullish(),
});
export type UploadMetadata = z.infer<typeof UploadMetadata>;

export const MyUploadItem = z.object({
  assetId: Id,
  uploadId: z.string().nullable(),
  eventId: Id,
  eventTitle: z.string(),
  eventStartsOn: z.string(),
  filename: z.string(),
  kind: z.enum(ASSET_KINDS).nullable(),
  tier: z.enum(TIERS),
  girlsOnly: z.boolean(),
  status: z.enum(ASSET_STATUSES),
  bytes: z.number().int().nullable(),
  durationS: z.number().nullable(),
  hdr: z.enum(HDR_FORMATS).nullable(),
  /** 1-based place in the processing queue while queued. */
  queuePosition: z.number().int().nullable(),
  step: z.string().nullable(),
  progress: z.number().nullable(),
  readyInS: z.number().int().nullable(),
  error: z.string().nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export const UPLOAD_BUCKETS = ['all', 'active', 'attention', 'ready'] as const;
export const MyUploadsQuery = z.object({
  bucket: z.enum(UPLOAD_BUCKETS).default('all'),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const MyUploadsPage = page(MyUploadItem).extend({
  counts: z.object({ all: z.number().int(), active: z.number().int(), attention: z.number().int(), ready: z.number().int() }),
});
export const ExistingFiles = z.object({ items: z.array(z.object({ filename: z.string(), bytes: z.number().int().nullable() })) });
export type MyUploadItem = z.infer<typeof MyUploadItem>;
