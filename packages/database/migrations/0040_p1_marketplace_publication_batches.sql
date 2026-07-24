CREATE TABLE "marketplace_publication_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"capability_snapshot_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"marketplace_id" text NOT NULL,
	"action" text NOT NULL,
	"parent_batch_id" uuid,
	"idempotency_key" text NOT NULL,
	"item_count" integer NOT NULL,
	"scheduled_for" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "marketplace_publication_batches_id_uuidv7_check" CHECK (substring("marketplace_publication_batches"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "marketplace_publication_batches_platform_check" CHECK ("marketplace_publication_batches"."platform" in ('amazon','etsy')),
	CONSTRAINT "marketplace_publication_batches_action_check" CHECK ("marketplace_publication_batches"."action" in ('initial','continue')),
	CONSTRAINT "marketplace_publication_batches_parent_check" CHECK (("marketplace_publication_batches"."action" = 'initial' and "marketplace_publication_batches"."parent_batch_id" is null) or ("marketplace_publication_batches"."action" = 'continue' and "marketplace_publication_batches"."parent_batch_id" is not null)),
	CONSTRAINT "marketplace_publication_batches_item_count_check" CHECK ("marketplace_publication_batches"."item_count" between 2 and 100),
	CONSTRAINT "marketplace_publication_batches_idempotency_check" CHECK ("marketplace_publication_batches"."idempotency_key" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "marketplace_publication_requests" DROP CONSTRAINT "marketplace_publication_requests_action_check";--> statement-breakpoint
ALTER TABLE "marketplace_publication_requests" DROP CONSTRAINT "marketplace_publication_requests_platform_action_check";--> statement-breakpoint
ALTER TABLE "marketplace_publication_requests" DROP CONSTRAINT "marketplace_publication_requests_followup_check";--> statement-breakpoint
ALTER TABLE "marketplace_quota_snapshots" DROP CONSTRAINT "marketplace_quota_snapshots_source_check";--> statement-breakpoint
ALTER TABLE "marketplace_publication_requests" ADD COLUMN "batch_id" uuid;--> statement-breakpoint
ALTER TABLE "marketplace_quota_snapshots" ADD COLUMN "publication_batch_id" uuid;--> statement-breakpoint
ALTER TABLE "marketplace_publication_batches" ADD CONSTRAINT "marketplace_publication_batches_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_publication_batches" ADD CONSTRAINT "marketplace_publication_batches_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_publication_batches" ADD CONSTRAINT "marketplace_publication_batches_account_fk" FOREIGN KEY ("tenant_id","account_id") REFERENCES "public"."marketplace_accounts"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_publication_batches" ADD CONSTRAINT "marketplace_publication_batches_capability_fk" FOREIGN KEY ("tenant_id","capability_snapshot_id") REFERENCES "public"."marketplace_capability_snapshots"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_publication_batches_tenant_id_unique" ON "marketplace_publication_batches" USING btree ("tenant_id","id");--> statement-breakpoint
ALTER TABLE "marketplace_publication_batches" ADD CONSTRAINT "marketplace_publication_batches_parent_fk" FOREIGN KEY ("tenant_id","parent_batch_id") REFERENCES "public"."marketplace_publication_batches"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_publication_batches_idempotency_unique" ON "marketplace_publication_batches" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "marketplace_publication_batches_account_idx" ON "marketplace_publication_batches" USING btree ("tenant_id","account_id","created_at");--> statement-breakpoint
CREATE INDEX "marketplace_publication_batches_parent_idx" ON "marketplace_publication_batches" USING btree ("tenant_id","parent_batch_id");--> statement-breakpoint
CREATE INDEX "marketplace_publication_batches_schedule_idx" ON "marketplace_publication_batches" USING btree ("tenant_id","account_id","scheduled_for");--> statement-breakpoint
ALTER TABLE "marketplace_publication_requests" ADD CONSTRAINT "marketplace_publication_requests_batch_fk" FOREIGN KEY ("tenant_id","batch_id") REFERENCES "public"."marketplace_publication_batches"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_quota_snapshots" ADD CONSTRAINT "marketplace_quota_snapshots_publication_batch_fk" FOREIGN KEY ("tenant_id","publication_batch_id") REFERENCES "public"."marketplace_publication_batches"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "marketplace_publication_requests_batch_idx" ON "marketplace_publication_requests" USING btree ("tenant_id","batch_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_quota_snapshots_publication_batch_unique" ON "marketplace_quota_snapshots" USING btree ("tenant_id","publication_batch_id","operation","observed_at");--> statement-breakpoint
ALTER TABLE "marketplace_publication_requests" ADD CONSTRAINT "marketplace_publication_requests_action_check" CHECK ("marketplace_publication_requests"."action" in ('amazon_validation_preview', 'amazon_submit', 'amazon_feed_submit', 'etsy_create_draft', 'etsy_activate'));--> statement-breakpoint
ALTER TABLE "marketplace_publication_requests" ADD CONSTRAINT "marketplace_publication_requests_platform_action_check" CHECK (("marketplace_publication_requests"."platform" = 'amazon' and "marketplace_publication_requests"."action" in ('amazon_validation_preview', 'amazon_submit', 'amazon_feed_submit')) or ("marketplace_publication_requests"."platform" = 'etsy' and "marketplace_publication_requests"."action" in ('etsy_create_draft', 'etsy_activate')));--> statement-breakpoint
ALTER TABLE "marketplace_publication_requests" ADD CONSTRAINT "marketplace_publication_requests_followup_check" CHECK (("marketplace_publication_requests"."action" in ('amazon_validation_preview', 'etsy_create_draft') and "marketplace_publication_requests"."parent_request_id" is null and "marketplace_publication_requests"."source_external_listing_id" is null) or ("marketplace_publication_requests"."action" = 'amazon_submit' and "marketplace_publication_requests"."parent_request_id" is not null and "marketplace_publication_requests"."source_external_listing_id" is null and "marketplace_publication_requests"."batch_id" is null) or ("marketplace_publication_requests"."action" = 'amazon_feed_submit' and "marketplace_publication_requests"."parent_request_id" is not null and "marketplace_publication_requests"."source_external_listing_id" is null and "marketplace_publication_requests"."batch_id" is not null) or ("marketplace_publication_requests"."action" = 'etsy_activate' and "marketplace_publication_requests"."parent_request_id" is not null and "marketplace_publication_requests"."source_external_listing_id" is not null));--> statement-breakpoint
ALTER TABLE "marketplace_quota_snapshots" ADD CONSTRAINT "marketplace_quota_snapshots_source_check" CHECK (num_nonnulls("marketplace_quota_snapshots"."publication_batch_id", "marketplace_quota_snapshots"."publication_request_id", "marketplace_quota_snapshots"."listing_sync_request_id") = 1);
--> statement-breakpoint
ALTER TABLE "marketplace_publication_batches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "marketplace_publication_batches" FORCE ROW LEVEL SECURITY;
CREATE POLICY "marketplace_publication_batches_tenant_policy" ON "marketplace_publication_batches" FOR ALL TO yummyai_app
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT ON marketplace_publication_batches TO yummyai_app;
