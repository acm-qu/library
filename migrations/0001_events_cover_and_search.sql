-- events.cover_asset_id references assets, which references events: added here to break the cycle.
ALTER TABLE "events" ADD CONSTRAINT "events_cover_asset_id_fk" FOREIGN KEY ("cover_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Library search. The expression must match EVENT_SEARCH_VECTOR in packages/core/src/db/search.ts exactly,
-- or the planner won't use the index. 'simple' keeps Arabic and English titles searchable without stemming.
CREATE INDEX "events_search" ON "events" USING gin (to_tsvector('simple'::regconfig, coalesce("title", '') || ' ' || coalesce("location", '') || ' ' || coalesce("description", '')));--> statement-breakpoint
-- The worker's claim only looks at queued rows.
CREATE INDEX "jobs_queued_claim" ON "jobs" USING btree ("priority" DESC, "created_at") WHERE "state" = 'queued';
