import { z } from 'zod';
import { ASSET_STATUSES, JOB_KINDS, JOB_STATES, ROLES, TONE_CURVES, USER_STATUSES } from '../enums.ts';
import { Email, Id, IsoDateTime, page, PageQuery } from './common.ts';

export const AdminUser = z.object({
  id: Id,
  email: z.string(),
  name: z.string(),
  role: z.enum(ROLES),
  isAdmin: z.boolean(),
  status: z.enum(USER_STATUSES),
  createdAt: IsoDateTime,
  lastLoginAt: IsoDateTime.nullable(),
});
export type AdminUser = z.infer<typeof AdminUser>;
export const AdminUserPage = page(AdminUser);
export const AdminUserQuery = PageQuery.extend({
  q: z.string().trim().max(200).optional(),
  role: z.enum(ROLES).optional(),
  status: z.enum(USER_STATUSES).optional(),
});
export const CreateUserBody = z.object({
  email: Email,
  name: z.string().trim().max(120).default(''),
  role: z.enum(ROLES),
  isAdmin: z.boolean().default(false),
});
export const BulkUsersBody = z.object({ emails: z.array(z.string()).min(1).max(1000), role: z.enum(ROLES) });
export const BulkUsersResult = z.object({
  created: z.number().int(),
  skipped: z.array(z.object({ email: z.string(), reason: z.enum(['invalid', 'exists', 'duplicate']) })),
});
export const PatchUserBody = z
  .object({ role: z.enum(ROLES), isAdmin: z.boolean(), status: z.enum(USER_STATUSES), name: z.string().trim().max(120) })
  .partial();

export const JOB_TABS = ['running', 'queued', 'failed', 'needs_review', 'recent'] as const;
export const AdminJobQuery = PageQuery.extend({ tab: z.enum(JOB_TABS).default('queued') });
export const AdminJob = z.object({
  id: Id,
  kind: z.enum(JOB_KINDS),
  state: z.enum(JOB_STATES),
  priority: z.number().int(),
  attempts: z.number().int(),
  maxAttempts: z.number().int(),
  step: z.string().nullable(),
  progress: z.number().nullable(),
  readyInS: z.number().int().nullable(),
  lastError: z.string().nullable(),
  createdAt: IsoDateTime,
  startedAt: IsoDateTime.nullable(),
  finishedAt: IsoDateTime.nullable(),
  asset: z
    .object({ id: Id, filename: z.string(), status: z.enum(ASSET_STATUSES), eventTitle: z.string(), thumbUrl: z.string().nullable() })
    .nullable(),
});
export const AdminJobPage = page(AdminJob).extend({
  summary: z.object({ running: z.number().int(), queued: z.number().int(), failed: z.number().int(), needsReview: z.number().int(), queuedVideoS: z.number(), drainS: z.number().int(), workerTick: z.string().nullable() }),
});

export const ReprocessBody = z.object({ toneCurve: z.enum(TONE_CURVES).optional() });

/** processing_runs.scores for an HDR video: written by automatic tone-curve selection (handoff §8.5). */
export const ToneScores = z.object({
  candidates: z.array(z.object({ curve: z.string(), dists: z.number(), topiq: z.number(), r_dists: z.number(), r_topiq: z.number(), sum: z.number() })),
  /** Lowest rank sum, even when the metrics disagreed and the fallback was used. */
  best: z.string().nullable().optional(),
  /** Why the fallback was used: 'metrics_disagree' | 'score_not_finite' | 'scoring_failed'. */
  reason: z.string().nullable().optional(),
  error: z.string().optional(),
  frames: z.array(z.object({ t: z.number(), why: z.string(), n: z.number() })).optional(),
});
export type ToneScores = z.infer<typeof ToneScores>;
export const ResolveBody = z.object({ action: z.enum(['process_default', 'original_only']) });

export const AppSettings = z.object({
  tonemapAuto: z.boolean(),
  /** Whether the tone-curve validation gate has passed in this release (tonemapAuto can't be enabled before). */
  tonemapGatePassed: z.boolean(),
  /** null = the host hasn't told us the file-count limit. */
  inodeLimit: z.number().int().positive().nullable(),
});
export const PatchSettingsBody = z.object({ tonemapAuto: z.boolean(), inodeLimit: z.number().int().positive().nullable() }).partial();

export const StorageReport = z.object({
  measuredAt: z.string().nullable(),
  bytesOriginals: z.number(),
  bytesRenditions: z.number(),
  files: z.number().int(),
  byKind: z.object({ originals: z.number().int(), photoCopies: z.number().int(), videoFiles: z.number().int(), other: z.number().int() }).nullable(),
  inodeLimit: z.number().int().nullable(),
  diskFreeBytes: z.number().nullable(),
  topEvents: z.array(z.object({ id: Id, title: z.string(), slug: z.string(), bytes: z.number(), items: z.number().int() })),
  history: z.array(z.object({ date: z.string(), bytes: z.number(), files: z.number().int() })),
});

export const ProcessingReport = z.object({
  asset: z.object({
    id: Id,
    filename: z.string(),
    kind: z.enum(['image', 'video']),
    tier: z.enum(['member', 'core']),
    status: z.enum(ASSET_STATUSES),
    eventId: Id,
    eventTitle: z.string(),
    reviewReason: z.string().nullable(),
    hdr: z.string().nullable(),
    durationS: z.number().nullable(),
    width: z.number().int().nullable(),
    height: z.number().int().nullable(),
    originalSize: z.number().nullable(),
    encrypted: z.boolean(),
    duplicateOf: Id.nullable(),
    sourceInfo: z.unknown(),
    thumbUrl: z.string().nullable(),
  }),
  renditions: z.array(z.object({ kind: z.string(), label: z.string(), width: z.number().nullable(), height: z.number().nullable(), bandwidth: z.number().nullable(), bytes: z.number(), encrypted: z.boolean() })),
  runs: z.array(z.object({ id: Id, startedAt: z.string(), finishedAt: z.string().nullable(), ok: z.boolean().nullable(), toneCurve: z.string().nullable(), curveSource: z.string().nullable(), scores: z.unknown(), error: z.string().nullable() })),
  jobs: z.array(z.object({ id: Id, kind: z.string(), state: z.string(), attempts: z.number().int(), lastError: z.string().nullable(), createdAt: z.string(), finishedAt: z.string().nullable() })),
  /** Seconds a re-process would take now, queue included. */
  reprocessEtaS: z.number().int(),
});
