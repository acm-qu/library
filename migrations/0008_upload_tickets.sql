CREATE TABLE "upload_tickets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"uploader_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"bytes" bigint NOT NULL,
	"filename" text NOT NULL,
	"girls_only" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"upload_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"granted_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "upload_tickets_kind_check" CHECK (kind in ('image','video')),
	CONSTRAINT "upload_tickets_status_check" CHECK (status in ('waiting','granted','done','cancelled','expired'))
);
--> statement-breakpoint
ALTER TABLE "upload_tickets" ADD CONSTRAINT "upload_tickets_uploader_id_users_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_tickets" ADD CONSTRAINT "upload_tickets_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "upload_tickets_status_created" ON "upload_tickets" USING btree ("status","created_at");