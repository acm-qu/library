CREATE TABLE "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "asset_keys" (
	"asset_id" uuid PRIMARY KEY NOT NULL,
	"file_key_wrapped" "bytea" NOT NULL,
	"hls_key_wrapped" "bytea",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"event_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"tier" text NOT NULL,
	"status" text NOT NULL,
	"original_filename" text NOT NULL,
	"original_mime" text,
	"original_size" bigint,
	"original_sha256" "bytea",
	"original_ext" text NOT NULL,
	"duplicate_of" uuid,
	"encrypted" boolean DEFAULT false NOT NULL,
	"rendition_rev" integer DEFAULT 0 NOT NULL,
	"captured_at" timestamp with time zone,
	"width" integer,
	"height" integer,
	"duration_s" real,
	"fps" real,
	"device" text,
	"hdr" text,
	"review_reason" text,
	"source_info" jsonb,
	"uploader_id" uuid NOT NULL,
	"upload_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "assets_kind_check" CHECK (kind in ('image','video')),
	CONSTRAINT "assets_tier_check" CHECK (tier in ('member','core')),
	CONSTRAINT "assets_status_check" CHECK (status in ('uploading','queued','processing','ready','failed','needs_review','original_only','deleting')),
	CONSTRAINT "assets_hdr_check" CHECK (hdr is null or hdr in ('sdr','hlg','pq','unknown'))
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" uuid,
	"data" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"slug" text NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date,
	"location" text,
	"description" text,
	"cover_asset_id" uuid,
	"default_tier" text DEFAULT 'member' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "events_default_tier_check" CHECK (default_tier in ('member','core'))
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"asset_id" uuid,
	"kind" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"outcome" text,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"step" text,
	"progress" real,
	"est_seconds" integer,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_kind_check" CHECK (kind in ('process','reprocess','retier','purge')),
	CONSTRAINT "jobs_state_check" CHECK (state in ('queued','running','done','failed','cancelled')),
	CONSTRAINT "jobs_outcome_check" CHECK (outcome is null or outcome in ('ok','needs_review'))
);
--> statement-breakpoint
CREATE TABLE "otp_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"code_hash" "bytea" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_ip" "inet"
);
--> statement-breakpoint
CREATE TABLE "processing_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"asset_id" uuid NOT NULL,
	"settings_version" integer NOT NULL,
	"tone_curve" text,
	"curve_source" text,
	"scores" jsonb,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"ok" boolean,
	"error" text,
	"log_tail" text,
	CONSTRAINT "processing_runs_tone_curve_check" CHECK (tone_curve is null or tone_curve in ('hable203','bt2446a','bt2390','reinhard203')),
	CONSTRAINT "processing_runs_curve_source_check" CHECK (curve_source is null or curve_source in ('auto','fallback','override','none'))
);
--> statement-breakpoint
CREATE TABLE "renditions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"asset_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"width" integer,
	"height" integer,
	"bandwidth" integer,
	"bytes" bigint NOT NULL,
	"rel_path" text NOT NULL,
	"encrypted" boolean DEFAULT false NOT NULL,
	"settings_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "renditions_kind_check" CHECK (kind in ('image_view','image_thumb','image_jpeg','video_poster','video_thumb','hls_master','hls_variant'))
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip" "inet",
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"is_admin" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	CONSTRAINT "users_email_lower" CHECK ("users"."email" = lower("users"."email")),
	CONSTRAINT "users_role_check" CHECK (role in ('member','core')),
	CONSTRAINT "users_status_check" CHECK (status in ('active','disabled')),
	CONSTRAINT "admin_is_core" CHECK (not "users"."is_admin" or "users"."role" = 'core')
);
--> statement-breakpoint
ALTER TABLE "asset_keys" ADD CONSTRAINT "asset_keys_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_uploader_id_users_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_duplicate_of_fk" FOREIGN KEY ("duplicate_of") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_runs" ADD CONSTRAINT "processing_runs_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "renditions" ADD CONSTRAINT "renditions_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assets_event_tier_status" ON "assets" USING btree ("event_id","tier","status") WHERE "assets"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "assets_event_sha" ON "assets" USING btree ("event_id","original_sha256");--> statement-breakpoint
CREATE INDEX "assets_uploader" ON "assets" USING btree ("uploader_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "assets_upload_id_key" ON "assets" USING btree ("upload_id");--> statement-breakpoint
CREATE INDEX "audit_log_at" ON "audit_log" USING btree ("at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "events_slug_key" ON "events" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "events_starts_on" ON "events" USING btree ("starts_on" DESC NULLS LAST,"id");--> statement-breakpoint
CREATE INDEX "jobs_claim" ON "jobs" USING btree ("state","priority" DESC NULLS LAST,"created_at");--> statement-breakpoint
CREATE INDEX "jobs_asset" ON "jobs" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "otp_codes_email_created" ON "otp_codes" USING btree ("email","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "processing_runs_asset" ON "processing_runs" USING btree ("asset_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "renditions_asset_kind_label" ON "renditions" USING btree ("asset_id","kind","label");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree ("email");