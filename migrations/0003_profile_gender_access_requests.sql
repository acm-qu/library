CREATE TABLE "access_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"gender" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" uuid,
	"request_ip" "inet",
	CONSTRAINT "access_requests_email_lower" CHECK ("access_requests"."email" = lower("access_requests"."email")),
	CONSTRAINT "access_requests_gender_check" CHECK (gender in ('male','female')),
	CONSTRAINT "access_requests_status_check" CHECK (status in ('pending','approved','rejected'))
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "gender" text;--> statement-breakpoint
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "access_requests_pending_email" ON "access_requests" USING btree ("email") WHERE "access_requests"."status" = 'pending';--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_gender_check" CHECK (gender in ('male','female'));