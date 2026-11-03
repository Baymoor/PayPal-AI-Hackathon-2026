CREATE TYPE "public"."attendance_state" AS ENUM('PENDING', 'ACCEPTED', 'DECLINED', 'WITHDRAWN');--> statement-breakpoint
CREATE TYPE "public"."budget_unit" AS ENUM('TOTAL', 'PER_PERSON');--> statement-breakpoint
CREATE TYPE "public"."cleanup_state" AS ENUM('NONE', 'VOID_PENDING', 'REFUND_PENDING', 'NEEDS_ATTENTION', 'COMPLETE');--> statement-breakpoint
CREATE TYPE "public"."deadline_policy" AS ENUM('ALL_REQUIRED');--> statement-breakpoint
CREATE TYPE "public"."job_kind" AS ENUM('SETTLE_DEADLINE', 'PROCESS_OPERATIONS', 'RECONCILE_PAYMENT');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('QUEUED', 'RUNNING', 'DONE', 'FAILED', 'DEAD');--> statement-breakpoint
CREATE TYPE "public"."operation_kind" AS ENUM('CAPTURE', 'VOID', 'REFUND');--> statement-breakpoint
CREATE TYPE "public"."operation_status" AS ENUM('PENDING', 'IN_FLIGHT', 'SUCCEEDED', 'FAILED', 'UNKNOWN', 'SKIPPED');--> statement-breakpoint
CREATE TYPE "public"."outing_status" AS ENUM('DRAFT', 'BUDGETING', 'PROPOSED', 'COLLECTING', 'SETTLING', 'CONFIRMED', 'CANCELLING', 'COMPENSATING', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."participant_role" AS ENUM('ORGANIZER', 'INVITEE');--> statement-breakpoint
CREATE TYPE "public"."payer_type" AS ENUM('PAYER', 'SPONSORED');--> statement-breakpoint
CREATE TYPE "public"."payment_provider" AS ENUM('PAYPAL', 'FIXTURE');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('CREATED', 'APPROVAL_PENDING', 'AUTHORIZED', 'CAPTURE_PENDING', 'CAPTURED', 'VOID_PENDING', 'VOIDED', 'REFUND_PENDING', 'REFUNDED', 'FAILED', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."pricing_model" AS ENUM('FIXED_TOTAL', 'PER_ATTENDEE');--> statement-breakpoint
CREATE TYPE "public"."quote_status" AS ENUM('ACTIVE', 'SUPERSEDED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."settlement_decision" AS ENUM('SETTLE', 'CANCEL');--> statement-breakpoint
CREATE TABLE "ai_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outing_id" uuid,
	"purpose" text NOT NULL,
	"source" text NOT NULL,
	"model" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"ok" boolean NOT NULL,
	"error" text,
	"output" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outing_id" uuid,
	"actor" text NOT NULL,
	"type" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budget_votes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outing_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"round" integer NOT NULL,
	"amount_minor" integer NOT NULL,
	"unit" "budget_unit" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_vote_positive" CHECK ("budget_votes"."amount_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outing_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"quote_id" uuid NOT NULL,
	"terms_hash" text NOT NULL,
	"cap_minor" integer NOT NULL,
	"currency" text NOT NULL,
	"statement" text NOT NULL,
	"accepted_at" timestamp with time zone NOT NULL,
	"withdrawn_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "job_kind" NOT NULL,
	"outing_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"run_at" timestamp with time zone NOT NULL,
	"status" "job_status" DEFAULT 'QUEUED' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 10 NOT NULL,
	"locked_by" text,
	"locked_until" timestamp with time zone,
	"last_error" text,
	"dedupe_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "merchants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"paypal_merchant_id" text,
	"timezone" text DEFAULT 'Europe/Copenhagen' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchants_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "offerings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"description" text NOT NULL,
	"location" text NOT NULL,
	"pricing_model" "pricing_model" NOT NULL,
	"price_minor" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"min_attendees" integer DEFAULT 1 NOT NULL,
	"capacity" integer NOT NULL,
	"duration_minutes" integer NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"availability" jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "offerings_price_positive" CHECK ("offerings"."price_minor" > 0),
	CONSTRAINT "offerings_capacity_positive" CHECK ("offerings"."capacity" > 0)
);
--> statement-breakpoint
CREATE TABLE "outings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"brief" text DEFAULT '' NOT NULL,
	"brief_extraction" jsonb,
	"status" "outing_status" DEFAULT 'DRAFT' NOT NULL,
	"policy" "deadline_policy" DEFAULT 'ALL_REQUIRED' NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"budget_unit" "budget_unit" DEFAULT 'TOTAL' NOT NULL,
	"budget_round" integer DEFAULT 1 NOT NULL,
	"budget_revealed_at" timestamp with time zone,
	"proposed_budget_minor" integer,
	"merchant_id" uuid,
	"current_quote_id" uuid,
	"min_payers" integer,
	"max_attendees" integer,
	"activity_at" timestamp with time zone,
	"deadline_at" timestamp with time zone,
	"display_timezone" text DEFAULT 'Europe/Copenhagen' NOT NULL,
	"collection_opened_at" timestamp with time zone,
	"frozen_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cleanup" "cleanup_state" DEFAULT 'NONE' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"is_fixture" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outing_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"role" "participant_role" DEFAULT 'INVITEE' NOT NULL,
	"payer_type" "payer_type" DEFAULT 'PAYER' NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"sort_key" integer NOT NULL,
	"attendance" "attendance_state" DEFAULT 'PENDING' NOT NULL,
	"attendance_at" timestamp with time zone,
	"invite_token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "participants_invite_token_hash_unique" UNIQUE("invite_token_hash")
);
--> statement-breakpoint
CREATE TABLE "payment_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outing_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"consent_id" uuid NOT NULL,
	"quote_id" uuid NOT NULL,
	"provider" "payment_provider" NOT NULL,
	"status" "payment_status" DEFAULT 'CREATED' NOT NULL,
	"currency" text NOT NULL,
	"requested_minor" integer NOT NULL,
	"authorized_minor" integer DEFAULT 0 NOT NULL,
	"captured_minor" integer DEFAULT 0 NOT NULL,
	"refunded_minor" integer DEFAULT 0 NOT NULL,
	"provider_order_id" text,
	"authorization_id" text,
	"capture_id" text,
	"refund_id" text,
	"authorized_at" timestamp with time zone,
	"authorization_expires_at" timestamp with time zone,
	"verified" boolean DEFAULT false NOT NULL,
	"verified_at" timestamp with time zone,
	"late" boolean DEFAULT false NOT NULL,
	"provider_status" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_requested_positive" CHECK ("payment_attempts"."requested_minor" > 0),
	CONSTRAINT "payment_capture_le_authorized" CHECK ("payment_attempts"."captured_minor" <= "payment_attempts"."authorized_minor"),
	CONSTRAINT "payment_refund_le_captured" CHECK ("payment_attempts"."refunded_minor" <= "payment_attempts"."captured_minor")
);
--> statement-breakpoint
CREATE TABLE "payment_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outing_id" uuid NOT NULL,
	"payment_attempt_id" uuid NOT NULL,
	"kind" "operation_kind" NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" text NOT NULL,
	"request_id" text NOT NULL,
	"status" "operation_status" DEFAULT 'PENDING' NOT NULL,
	"sequence" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 8 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider_ref" text,
	"provider_status" text,
	"last_error" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_operations_request_id_unique" UNIQUE("request_id"),
	CONSTRAINT "payment_operation_amount_non_negative" CHECK ("payment_operations"."amount_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "quote_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outing_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" "quote_status" DEFAULT 'ACTIVE' NOT NULL,
	"merchant_id" uuid NOT NULL,
	"offering_id" uuid NOT NULL,
	"pricing_model" "pricing_model" NOT NULL,
	"total_minor" integer NOT NULL,
	"currency" text NOT NULL,
	"capacity" integer NOT NULL,
	"min_payers" integer NOT NULL,
	"cap_minor" integer NOT NULL,
	"activity_at" timestamp with time zone NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"terms" jsonb NOT NULL,
	"terms_hash" text NOT NULL,
	"merchant_confirmed_at" timestamp with time zone NOT NULL,
	"availability_source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quote_total_positive" CHECK ("quote_versions"."total_minor" > 0),
	CONSTRAINT "quote_cap_positive" CHECK ("quote_versions"."cap_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "settlement_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outing_id" uuid NOT NULL,
	"quote_id" uuid NOT NULL,
	"terms_hash" text NOT NULL,
	"decision" "settlement_decision" NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"frozen_at" timestamp with time zone NOT NULL,
	"total_minor" integer NOT NULL,
	"currency" text NOT NULL,
	"payer_count" integer NOT NULL,
	"roster" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settlement_snapshots_outing_id_unique" UNIQUE("outing_id")
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "payment_provider" NOT NULL,
	"provider_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"resource_id" text,
	"verified" boolean NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"processing_error" text,
	CONSTRAINT "webhook_events_provider_event_id_unique" UNIQUE("provider_event_id")
);
--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_outing_id_outings_id_fk" FOREIGN KEY ("outing_id") REFERENCES "public"."outings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_outing_id_outings_id_fk" FOREIGN KEY ("outing_id") REFERENCES "public"."outings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_votes" ADD CONSTRAINT "budget_votes_outing_id_outings_id_fk" FOREIGN KEY ("outing_id") REFERENCES "public"."outings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_votes" ADD CONSTRAINT "budget_votes_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_outing_id_outings_id_fk" FOREIGN KEY ("outing_id") REFERENCES "public"."outings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_quote_id_quote_versions_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quote_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_outing_id_outings_id_fk" FOREIGN KEY ("outing_id") REFERENCES "public"."outings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offerings" ADD CONSTRAINT "offerings_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outings" ADD CONSTRAINT "outings_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participants" ADD CONSTRAINT "participants_outing_id_outings_id_fk" FOREIGN KEY ("outing_id") REFERENCES "public"."outings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_outing_id_outings_id_fk" FOREIGN KEY ("outing_id") REFERENCES "public"."outings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_consent_id_consents_id_fk" FOREIGN KEY ("consent_id") REFERENCES "public"."consents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_quote_id_quote_versions_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quote_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_outing_id_outings_id_fk" FOREIGN KEY ("outing_id") REFERENCES "public"."outings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_payment_attempt_id_payment_attempts_id_fk" FOREIGN KEY ("payment_attempt_id") REFERENCES "public"."payment_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_versions" ADD CONSTRAINT "quote_versions_outing_id_outings_id_fk" FOREIGN KEY ("outing_id") REFERENCES "public"."outings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_versions" ADD CONSTRAINT "quote_versions_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_versions" ADD CONSTRAINT "quote_versions_offering_id_offerings_id_fk" FOREIGN KEY ("offering_id") REFERENCES "public"."offerings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_snapshots" ADD CONSTRAINT "settlement_snapshots_outing_id_outings_id_fk" FOREIGN KEY ("outing_id") REFERENCES "public"."outings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_snapshots" ADD CONSTRAINT "settlement_snapshots_quote_id_quote_versions_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quote_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_outing_idx" ON "audit_events" USING btree ("outing_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "budget_votes_unique_idx" ON "budget_votes" USING btree ("outing_id","participant_id","round");--> statement-breakpoint
CREATE INDEX "consents_participant_idx" ON "consents" USING btree ("participant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "consents_active_unique_idx" ON "consents" USING btree ("participant_id","quote_id") WHERE "consents"."withdrawn_at" is null;--> statement-breakpoint
CREATE INDEX "jobs_due_idx" ON "jobs" USING btree ("status","run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "offerings_merchant_slug_idx" ON "offerings" USING btree ("merchant_id","slug");--> statement-breakpoint
CREATE INDEX "outings_status_deadline_idx" ON "outings" USING btree ("status","deadline_at");--> statement-breakpoint
CREATE INDEX "outings_merchant_idx" ON "outings" USING btree ("merchant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "participants_outing_sort_idx" ON "participants" USING btree ("outing_id","sort_key");--> statement-breakpoint
CREATE INDEX "participants_outing_idx" ON "participants" USING btree ("outing_id");--> statement-breakpoint
CREATE INDEX "payment_attempts_outing_idx" ON "payment_attempts" USING btree ("outing_id");--> statement-breakpoint
CREATE INDEX "payment_attempts_participant_idx" ON "payment_attempts" USING btree ("participant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_attempts_order_idx" ON "payment_attempts" USING btree ("provider_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_attempts_authorization_idx" ON "payment_attempts" USING btree ("authorization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_operations_attempt_kind_idx" ON "payment_operations" USING btree ("payment_attempt_id","kind");--> statement-breakpoint
CREATE INDEX "payment_operations_status_idx" ON "payment_operations" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "quote_versions_outing_version_idx" ON "quote_versions" USING btree ("outing_id","version");