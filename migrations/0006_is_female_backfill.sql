-- is_female replaces the gender text; gender stays (and is written alongside) until no release reads it.
UPDATE "users" SET "is_female" = ("gender" = 'female') WHERE "gender" IS NOT NULL;--> statement-breakpoint
UPDATE "access_requests" SET "is_female" = ("gender" = 'female') WHERE "gender" IS NOT NULL;
