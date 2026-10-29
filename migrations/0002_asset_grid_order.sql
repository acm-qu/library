-- Event grid keyset: assets of one event in capture order. Matches SORT_TIME in apps/api/src/routes/assets.ts.
CREATE INDEX "assets_event_grid" ON "assets" USING btree ("event_id", (coalesce("captured_at", "created_at")), "id") WHERE "deleted_at" IS NULL;
