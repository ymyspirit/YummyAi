CREATE TABLE "listing_replications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source_listing_id" uuid NOT NULL,
	"source_version_id" uuid NOT NULL,
	"target_listing_id" uuid NOT NULL,
	"target_version_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"target_marketplace_id" text NOT NULL,
	"target_locale" text NOT NULL,
	"overrides" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "listing_replications_id_uuidv7_check" CHECK (substring("listing_replications"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "listing_replications_platform_check" CHECK ("listing_replications"."platform" in ('amazon','etsy'))
);
--> statement-breakpoint
CREATE TABLE "marketplace_automation_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"trigger" text NOT NULL,
	"conditions" jsonb NOT NULL,
	"action" jsonb NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "marketplace_automation_rules_id_uuidv7_check" CHECK (substring("marketplace_automation_rules"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "marketplace_automation_rules_trigger_check" CHECK ("marketplace_automation_rules"."trigger" = 'listing_approved')
);
--> statement-breakpoint
CREATE TABLE "marketplace_automation_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"listing_id" uuid NOT NULL,
	"listing_version_id" uuid NOT NULL,
	"trigger_key" text NOT NULL,
	"status" text NOT NULL,
	"output_type" text,
	"output_id" uuid,
	"code" text,
	"message" text,
	"actor_user_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "marketplace_automation_runs_id_uuidv7_check" CHECK (substring("marketplace_automation_runs"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "marketplace_automation_runs_trigger_key_check" CHECK ("marketplace_automation_runs"."trigger_key" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "marketplace_automation_runs_status_check" CHECK ("marketplace_automation_runs"."status" in ('skipped','enqueued','failed'))
);
--> statement-breakpoint
CREATE TABLE "marketplace_listing_sync_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"status" text NOT NULL,
	"code" text,
	"message" text,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"snapshot" jsonb,
	"snapshot_checksum" text,
	"retryable" boolean DEFAULT false NOT NULL,
	"actor_user_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "marketplace_listing_sync_events_id_uuidv7_check" CHECK (substring("marketplace_listing_sync_events"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "marketplace_listing_sync_events_sequence_check" CHECK ("marketplace_listing_sync_events"."sequence" > 0),
	CONSTRAINT "marketplace_listing_sync_events_status_check" CHECK ("marketplace_listing_sync_events"."status" in ('queued','processing','completed','drift_detected','retry_pending','reconciliation_required','failed')),
	CONSTRAINT "marketplace_listing_sync_events_snapshot_checksum_check" CHECK ("marketplace_listing_sync_events"."snapshot_checksum" is null or "marketplace_listing_sync_events"."snapshot_checksum" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "marketplace_listing_sync_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"source_publication_request_id" uuid NOT NULL,
	"listing_id" uuid NOT NULL,
	"listing_version_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"marketplace_id" text NOT NULL,
	"external_listing_id" text NOT NULL,
	"action" text NOT NULL,
	"desired_state" jsonb NOT NULL,
	"desired_checksum" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "marketplace_listing_sync_requests_id_uuidv7_check" CHECK (substring("marketplace_listing_sync_requests"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "marketplace_listing_sync_requests_platform_check" CHECK ("marketplace_listing_sync_requests"."platform" in ('amazon','etsy')),
	CONSTRAINT "marketplace_listing_sync_requests_action_check" CHECK ("marketplace_listing_sync_requests"."action" in ('read','push_price_inventory')),
	CONSTRAINT "marketplace_listing_sync_requests_desired_checksum_check" CHECK ("marketplace_listing_sync_requests"."desired_checksum" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "marketplace_listing_sync_requests_idempotency_check" CHECK ("marketplace_listing_sync_requests"."idempotency_key" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
DROP INDEX "listings_channel_unique";--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "marketplace_id" text;--> statement-breakpoint
ALTER TABLE "listing_replications" ADD CONSTRAINT "listing_replications_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_replications" ADD CONSTRAINT "listing_replications_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_replications" ADD CONSTRAINT "listing_replications_source_listing_fk" FOREIGN KEY ("tenant_id","source_listing_id") REFERENCES "public"."listings"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_replications" ADD CONSTRAINT "listing_replications_source_version_fk" FOREIGN KEY ("tenant_id","source_version_id") REFERENCES "public"."listing_versions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_replications" ADD CONSTRAINT "listing_replications_target_listing_fk" FOREIGN KEY ("tenant_id","target_listing_id") REFERENCES "public"."listings"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_replications" ADD CONSTRAINT "listing_replications_target_version_fk" FOREIGN KEY ("tenant_id","target_version_id") REFERENCES "public"."listing_versions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_automation_rules_tenant_id_unique" ON "marketplace_automation_rules" USING btree ("tenant_id","id");--> statement-breakpoint
ALTER TABLE "marketplace_automation_rules" ADD CONSTRAINT "marketplace_automation_rules_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_automation_rules" ADD CONSTRAINT "marketplace_automation_rules_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_automation_runs" ADD CONSTRAINT "marketplace_automation_runs_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_automation_runs" ADD CONSTRAINT "marketplace_automation_runs_actor_user_id_app_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_automation_runs" ADD CONSTRAINT "marketplace_automation_runs_rule_fk" FOREIGN KEY ("tenant_id","rule_id") REFERENCES "public"."marketplace_automation_rules"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_automation_runs" ADD CONSTRAINT "marketplace_automation_runs_listing_fk" FOREIGN KEY ("tenant_id","listing_id") REFERENCES "public"."listings"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_automation_runs" ADD CONSTRAINT "marketplace_automation_runs_version_fk" FOREIGN KEY ("tenant_id","listing_version_id") REFERENCES "public"."listing_versions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_listing_sync_requests_tenant_id_unique" ON "marketplace_listing_sync_requests" USING btree ("tenant_id","id");--> statement-breakpoint
ALTER TABLE "marketplace_listing_sync_events" ADD CONSTRAINT "marketplace_listing_sync_events_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_listing_sync_events" ADD CONSTRAINT "marketplace_listing_sync_events_actor_user_id_app_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_listing_sync_events" ADD CONSTRAINT "marketplace_listing_sync_events_request_fk" FOREIGN KEY ("tenant_id","request_id") REFERENCES "public"."marketplace_listing_sync_requests"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_listing_sync_requests" ADD CONSTRAINT "marketplace_listing_sync_requests_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_listing_sync_requests" ADD CONSTRAINT "marketplace_listing_sync_requests_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_listing_sync_requests" ADD CONSTRAINT "marketplace_listing_sync_requests_account_fk" FOREIGN KEY ("tenant_id","account_id") REFERENCES "public"."marketplace_accounts"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_listing_sync_requests" ADD CONSTRAINT "marketplace_listing_sync_requests_publication_fk" FOREIGN KEY ("tenant_id","source_publication_request_id") REFERENCES "public"."marketplace_publication_requests"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_listing_sync_requests" ADD CONSTRAINT "marketplace_listing_sync_requests_listing_fk" FOREIGN KEY ("tenant_id","listing_id") REFERENCES "public"."listings"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_listing_sync_requests" ADD CONSTRAINT "marketplace_listing_sync_requests_version_fk" FOREIGN KEY ("tenant_id","listing_version_id") REFERENCES "public"."listing_versions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "listing_replications_tenant_id_unique" ON "listing_replications" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "listing_replications_target_unique" ON "listing_replications" USING btree ("tenant_id","source_version_id","target_marketplace_id","target_locale");--> statement-breakpoint
CREATE INDEX "listing_replications_source_idx" ON "listing_replications" USING btree ("tenant_id","source_listing_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_automation_rules_name_unique" ON "marketplace_automation_rules" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE INDEX "marketplace_automation_rules_trigger_idx" ON "marketplace_automation_rules" USING btree ("tenant_id","enabled","trigger","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_automation_runs_tenant_id_unique" ON "marketplace_automation_runs" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_automation_runs_trigger_unique" ON "marketplace_automation_runs" USING btree ("tenant_id","rule_id","trigger_key");--> statement-breakpoint
CREATE INDEX "marketplace_automation_runs_listing_idx" ON "marketplace_automation_runs" USING btree ("tenant_id","listing_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_listing_sync_events_tenant_id_unique" ON "marketplace_listing_sync_events" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_listing_sync_events_sequence_unique" ON "marketplace_listing_sync_events" USING btree ("tenant_id","request_id","sequence");--> statement-breakpoint
CREATE INDEX "marketplace_listing_sync_events_latest_idx" ON "marketplace_listing_sync_events" USING btree ("tenant_id","request_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_listing_sync_requests_idempotency_unique" ON "marketplace_listing_sync_requests" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "marketplace_listing_sync_requests_listing_idx" ON "marketplace_listing_sync_requests" USING btree ("tenant_id","listing_id","created_at");--> statement-breakpoint
CREATE INDEX "marketplace_listing_sync_requests_account_idx" ON "marketplace_listing_sync_requests" USING btree ("tenant_id","account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "listings_channel_unique" ON "listings" USING btree ("tenant_id","spu_id","platform","marketplace_id","locale");
--> statement-breakpoint
CREATE UNIQUE INDEX "listings_legacy_channel_unique" ON "listings" ("tenant_id","spu_id","platform","locale") WHERE "marketplace_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "listing_replications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "listing_replications" FORCE ROW LEVEL SECURITY;
CREATE POLICY "listing_replications_tenant_policy" ON "listing_replications" FOR ALL TO yummyai_app
  USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "listing_replications" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "marketplace_listing_sync_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "marketplace_listing_sync_requests" FORCE ROW LEVEL SECURITY;
CREATE POLICY "marketplace_listing_sync_requests_tenant_policy" ON "marketplace_listing_sync_requests" FOR ALL TO yummyai_app
  USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "marketplace_listing_sync_requests" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "marketplace_listing_sync_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "marketplace_listing_sync_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "marketplace_listing_sync_events_tenant_policy" ON "marketplace_listing_sync_events" FOR ALL TO yummyai_app
  USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "marketplace_listing_sync_events" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "marketplace_automation_rules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "marketplace_automation_rules" FORCE ROW LEVEL SECURITY;
CREATE POLICY "marketplace_automation_rules_tenant_policy" ON "marketplace_automation_rules" FOR ALL TO yummyai_app
  USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT, UPDATE, DELETE ON "marketplace_automation_rules" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "marketplace_automation_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "marketplace_automation_runs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "marketplace_automation_runs_tenant_policy" ON "marketplace_automation_runs" FOR ALL TO yummyai_app
  USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "marketplace_automation_runs" TO yummyai_app;
