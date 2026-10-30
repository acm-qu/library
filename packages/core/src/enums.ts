// Value sets shared by the database CHECK constraints, the zod schemas and the web app.
// Kept free of drizzle imports so the browser bundle can use them.
// Accounts are all 'core' (admin is a flag on top). 'member' stays for the DB CHECK, old rows and the signed-out viewer.
export const ROLES = ['member', 'core'] as const;
export const USER_STATUSES = ['active', 'disabled'] as const;
export const ACCESS_REQUEST_STATUSES = ['pending', 'approved', 'rejected'] as const;
export const TIERS = ['member', 'core'] as const;
export const ASSET_KINDS = ['image', 'video'] as const;
export const ASSET_STATUSES = [
  'uploading',
  'queued',
  'processing',
  'ready',
  'failed',
  'needs_review',
  'original_only',
  'deleting',
] as const;
// A file's place in the server-wide upload queue: waiting → granted (may upload) → done / cancelled / expired.
export const UPLOAD_TICKET_STATUSES = ['waiting', 'granted', 'done', 'cancelled', 'expired'] as const;
export const HDR_FORMATS = ['sdr', 'hlg', 'pq', 'unknown'] as const;
export const JOB_KINDS = ['process', 'reprocess', 'retier', 'purge'] as const;
export const JOB_STATES = ['queued', 'running', 'done', 'failed', 'cancelled'] as const;
export const JOB_OUTCOMES = ['ok', 'needs_review'] as const;
export const RENDITION_KINDS = [
  'image_view',
  'image_thumb',
  'image_jpeg', // no longer made (originals are the download); kept for the DB CHECK and old rows
  'video_poster',
  'video_thumb',
  'hls_master',
  'hls_variant',
] as const;
export const TONE_CURVES = ['hable203', 'bt2446a', 'bt2390', 'reinhard203'] as const;
export const CURVE_SOURCES = ['auto', 'fallback', 'override', 'none'] as const;

export type Role = (typeof ROLES)[number];
export type Tier = (typeof TIERS)[number];
export type AssetKind = (typeof ASSET_KINDS)[number];
export type AssetStatus = (typeof ASSET_STATUSES)[number];
export type HdrFormat = (typeof HDR_FORMATS)[number];
export type JobKind = (typeof JOB_KINDS)[number];
export type JobState = (typeof JOB_STATES)[number];
export type RenditionKind = (typeof RENDITION_KINDS)[number];
export type ToneCurve = (typeof TONE_CURVES)[number];
export type UserStatus = (typeof USER_STATUSES)[number];
export type JobOutcome = (typeof JOB_OUTCOMES)[number];
export type CurveSource = (typeof CURVE_SOURCES)[number];
export type UploadTicketStatus = (typeof UPLOAD_TICKET_STATUSES)[number];
