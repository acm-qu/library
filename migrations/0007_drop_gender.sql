-- Last copy from the old text column (covers rows a rolled-back release may have written), then drop it.
UPDATE "users" SET "is_female" = ("gender" = 'female') WHERE "gender" IS NOT NULL AND "is_female" IS NULL;--> statement-breakpoint
UPDATE "access_requests" SET "is_female" = ("gender" = 'female') WHERE "is_female" IS NULL;--> statement-breakpoint
ALTER TABLE "access_requests" DROP CONSTRAINT "access_requests_gender_check";--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_gender_check";--> statement-breakpoint
ALTER TABLE "access_requests" ALTER COLUMN "is_female" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "access_requests" DROP COLUMN "gender";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "gender";