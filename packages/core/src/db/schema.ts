// Drizzle schema shared by the API and the worker.
// Production runs PostgreSQL 9.6: no enums (ALTER TYPE can't run in a migration transaction before PG12),
// no identity/generated columns, no extensions. Statuses are text + CHECK; ids are UUID v7 generated in the app.
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  date,
  foreignKey,
  index,
  inet,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  ACCESS_REQUEST_STATUSES,
  ASSET_KINDS,
  ASSET_STATUSES,
  CURVE_SOURCES,
  GENDERS,
  HDR_FORMATS,
  JOB_KINDS,
  JOB_OUTCOMES,
  JOB_STATES,
  RENDITION_KINDS,
  ROLES,
  TIERS,
  TONE_CURVES,
  USER_STATUSES,
} from '../enums.ts';

export * from '../enums.ts';

export const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const created = () => ts('created_at').notNull().defaultNow();
const inList = (col: string, values: readonly string[]) =>
  sql.raw(`${col} in (${values.map((v) => `'${v}'`).join(',')})`);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    email: text('email').notNull(),
    name: text('name').notNull().default(''),
    role: text('role', { enum: ROLES }).notNull().default('member'),
    isAdmin: boolean('is_admin').notNull().default(false),
    status: text('status', { enum: USER_STATUSES }).notNull().default('active'),
    // Null until the person completes their profile on first sign-in (or an admin sets it).
    gender: text('gender', { enum: GENDERS }),
    createdBy: uuid('created_by'),
    createdAt: created(),
    lastLoginAt: ts('last_login_at'),
  },
  (t) => [
    uniqueIndex('users_email_key').on(t.email),
    check('users_email_lower', sql`${t.email} = lower(${t.email})`),
    check('users_role_check', inList('role', ROLES)),
    check('users_status_check', inList('status', USER_STATUSES)),
    check('admin_is_core', sql`not ${t.isAdmin} or ${t.role} = 'core'`),
    check('users_gender_check', inList('gender', GENDERS)),
  ],
);

/** "Request access" from the sign-in screen; an admin approves (creating the account) or rejects. */
export const accessRequests = pgTable(
  'access_requests',
  {
    id: uuid('id').primaryKey(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    gender: text('gender', { enum: GENDERS }).notNull(),
    status: text('status', { enum: ACCESS_REQUEST_STATUSES }).notNull().default('pending'),
    createdAt: created(),
    decidedAt: ts('decided_at'),
    decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
    requestIp: inet('request_ip'),
  },
  (t) => [
    uniqueIndex('access_requests_pending_email').on(t.email).where(sql`${t.status} = 'pending'`),
    check('access_requests_email_lower', sql`${t.email} = lower(${t.email})`),
    check('access_requests_gender_check', inList('gender', GENDERS)),
    check('access_requests_status_check', inList('status', ACCESS_REQUEST_STATUSES)),
  ],
);

export const otpCodes = pgTable(
  'otp_codes',
  {
    id: uuid('id').primaryKey(),
    email: text('email').notNull(),
    codeHash: bytea('code_hash').notNull(),
    expiresAt: ts('expires_at').notNull(),
    attempts: integer('attempts').notNull().default(0),
    consumedAt: ts('consumed_at'),
    createdAt: created(),
    requestIp: inet('request_ip'),
  },
  (t) => [index('otp_codes_email_created').on(t.email, t.createdAt.desc())],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey(),
    tokenHash: bytea('token_hash').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: created(),
    expiresAt: ts('expires_at').notNull(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
    ip: inet('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [uniqueIndex('sessions_token_hash_key').on(t.tokenHash), index('sessions_user').on(t.userId)],
);

export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey(),
    title: text('title').notNull(),
    slug: text('slug').notNull(),
    startsOn: date('starts_on', { mode: 'string' }).notNull(),
    endsOn: date('ends_on', { mode: 'string' }),
    location: text('location'),
    description: text('description'),
    // FK to assets is added in migration 0001 (circular reference): on delete set null.
    coverAssetId: uuid('cover_asset_id'),
    defaultTier: text('default_tier', { enum: TIERS }).notNull().default('member'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    uniqueIndex('events_slug_key').on(t.slug),
    index('events_starts_on').on(t.startsOn.desc(), t.id),
    check('events_default_tier_check', inList('default_tier', TIERS)),
  ],
);

export const assets = pgTable(
  'assets',
  {
    id: uuid('id').primaryKey(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id),
    kind: text('kind', { enum: ASSET_KINDS }).notNull(),
    tier: text('tier', { enum: TIERS }).notNull(),
    status: text('status', { enum: ASSET_STATUSES }).notNull(),
    originalFilename: text('original_filename').notNull(),
    originalMime: text('original_mime'),
    originalSize: bigint('original_size', { mode: 'number' }),
    originalSha256: bytea('original_sha256'),
    originalExt: text('original_ext').notNull(),
    duplicateOf: uuid('duplicate_of'),
    encrypted: boolean('encrypted').notNull().default(false),
    renditionRev: integer('rendition_rev').notNull().default(0),
    capturedAt: ts('captured_at'),
    width: integer('width'),
    height: integer('height'),
    durationS: real('duration_s'),
    fps: real('fps'),
    device: text('device'),
    hdr: text('hdr', { enum: HDR_FORMATS }),
    reviewReason: text('review_reason'),
    sourceInfo: jsonb('source_info'),
    uploaderId: uuid('uploader_id')
      .notNull()
      .references(() => users.id),
    uploadId: text('upload_id'),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    index('assets_event_tier_status').on(t.eventId, t.tier, t.status).where(sql`${t.deletedAt} is null`),
    index('assets_event_sha').on(t.eventId, t.originalSha256),
    index('assets_uploader').on(t.uploaderId, t.createdAt.desc()),
    uniqueIndex('assets_upload_id_key').on(t.uploadId),
    foreignKey({ name: 'assets_duplicate_of_fk', columns: [t.duplicateOf], foreignColumns: [t.id] }).onDelete('set null'),
    check('assets_kind_check', inList('kind', ASSET_KINDS)),
    check('assets_tier_check', inList('tier', TIERS)),
    check('assets_status_check', inList('status', ASSET_STATUSES)),
    check('assets_hdr_check', sql`hdr is null or ${inList('hdr', HDR_FORMATS)}`),
  ],
);

export const renditions = pgTable(
  'renditions',
  {
    id: uuid('id').primaryKey(),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: RENDITION_KINDS }).notNull(),
    label: text('label').notNull().default(''),
    width: integer('width'),
    height: integer('height'),
    bandwidth: integer('bandwidth'),
    bytes: bigint('bytes', { mode: 'number' }).notNull(),
    relPath: text('rel_path').notNull(),
    encrypted: boolean('encrypted').notNull().default(false),
    settingsVersion: integer('settings_version').notNull(),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex('renditions_asset_kind_label').on(t.assetId, t.kind, t.label),
    check('renditions_kind_check', inList('kind', RENDITION_KINDS)),
  ],
);

export const processingRuns = pgTable(
  'processing_runs',
  {
    id: uuid('id').primaryKey(),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    settingsVersion: integer('settings_version').notNull(),
    toneCurve: text('tone_curve', { enum: TONE_CURVES }),
    curveSource: text('curve_source', { enum: CURVE_SOURCES }),
    scores: jsonb('scores'),
    startedAt: ts('started_at').notNull(),
    finishedAt: ts('finished_at'),
    ok: boolean('ok'),
    error: text('error'),
    logTail: text('log_tail'),
  },
  (t) => [
    index('processing_runs_asset').on(t.assetId, t.startedAt.desc()),
    check('processing_runs_tone_curve_check', sql`tone_curve is null or ${inList('tone_curve', TONE_CURVES)}`),
    check('processing_runs_curve_source_check', sql`curve_source is null or ${inList('curve_source', CURVE_SOURCES)}`),
  ],
);

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey(),
    assetId: uuid('asset_id').references(() => assets.id, { onDelete: 'set null' }),
    kind: text('kind', { enum: JOB_KINDS }).notNull(),
    state: text('state', { enum: JOB_STATES }).notNull().default('queued'),
    outcome: text('outcome', { enum: JOB_OUTCOMES }),
    params: jsonb('params').notNull().default({}),
    priority: integer('priority').notNull().default(0),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    runAfter: ts('run_after').notNull().defaultNow(),
    step: text('step'),
    progress: real('progress'),
    estSeconds: integer('est_seconds'),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
    lastError: text('last_error'),
    createdAt: created(),
  },
  (t) => [
    index('jobs_claim').on(t.state, t.priority.desc(), t.createdAt),
    index('jobs_asset').on(t.assetId),
    check('jobs_kind_check', inList('kind', JOB_KINDS)),
    check('jobs_state_check', inList('state', JOB_STATES)),
    check('jobs_outcome_check', sql`outcome is null or ${inList('outcome', JOB_OUTCOMES)}`),
  ],
);

export const assetKeys = pgTable('asset_keys', {
  assetId: uuid('asset_id')
    .primaryKey()
    .references(() => assets.id, { onDelete: 'cascade' }),
  fileKeyWrapped: bytea('file_key_wrapped').notNull(),
  hlsKeyWrapped: bytea('hls_key_wrapped'),
  createdAt: created(),
});

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    actorId: uuid('actor_id'),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: uuid('target_id'),
    data: jsonb('data'),
    at: ts('at').notNull().defaultNow(),
  },
  (t) => [index('audit_log_at').on(t.at.desc())],
);

export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
});

export type User = typeof users.$inferSelect;
export type AccessRequest = typeof accessRequests.$inferSelect;
export type Event = typeof events.$inferSelect;
export type Asset = typeof assets.$inferSelect;
export type Rendition = typeof renditions.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type ProcessingRun = typeof processingRuns.$inferSelect;
