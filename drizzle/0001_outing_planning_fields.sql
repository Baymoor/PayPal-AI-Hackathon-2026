ALTER TABLE "outings" ADD COLUMN "budget_reveal" jsonb;--> statement-breakpoint
ALTER TABLE "outings" ADD COLUMN "proposal" jsonb;--> statement-breakpoint
ALTER TABLE "outings" ADD COLUMN "selected_offering_id" uuid;