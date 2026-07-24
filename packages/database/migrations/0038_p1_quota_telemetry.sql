CREATE TABLE "marketplace_quota_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"operation" text NOT NULL,
	"publication_request_id" uuid,
	"listing_sync_request_id" uuid,
	"windows" jsonb NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "marketplace_quota_snapshots_id_uuidv7_check" CHECK (substring("marketplace_quota_snapshots"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "marketplace_quota_snapshots_platform_check" CHECK ("marketplace_quota_snapshots"."platform" in ('amazon','etsy')),
	CONSTRAINT "marketplace_quota_snapshots_operation_check" CHECK ("marketplace_quota_snapshots"."operation" ~ '^[a-z][a-z0-9_]{0,79}$'),
	CONSTRAINT "marketplace_quota_snapshots_source_check" CHECK (("marketplace_quota_snapshots"."publication_request_id" is null) <> ("marketplace_quota_snapshots"."listing_sync_request_id" is null))
);
--> statement-breakpoint
ALTER TABLE "marketplace_quota_snapshots" ADD CONSTRAINT "marketplace_quota_snapshots_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_quota_snapshots" ADD CONSTRAINT "marketplace_quota_snapshots_account_fk" FOREIGN KEY ("tenant_id","account_id") REFERENCES "public"."marketplace_accounts"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_quota_snapshots" ADD CONSTRAINT "marketplace_quota_snapshots_publication_fk" FOREIGN KEY ("tenant_id","publication_request_id") REFERENCES "public"."marketplace_publication_requests"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_quota_snapshots" ADD CONSTRAINT "marketplace_quota_snapshots_listing_sync_fk" FOREIGN KEY ("tenant_id","listing_sync_request_id") REFERENCES "public"."marketplace_listing_sync_requests"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_quota_snapshots_tenant_id_unique" ON "marketplace_quota_snapshots" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_quota_snapshots_publication_unique" ON "marketplace_quota_snapshots" USING btree ("tenant_id","publication_request_id","operation","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_quota_snapshots_listing_sync_unique" ON "marketplace_quota_snapshots" USING btree ("tenant_id","listing_sync_request_id","operation","observed_at");--> statement-breakpoint
CREATE INDEX "marketplace_quota_snapshots_account_idx" ON "marketplace_quota_snapshots" USING btree ("tenant_id","account_id","observed_at");--> statement-breakpoint
ALTER TABLE "marketplace_quota_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "marketplace_quota_snapshots" FORCE ROW LEVEL SECURITY;
CREATE POLICY "marketplace_quota_snapshots_tenant_policy" ON "marketplace_quota_snapshots" FOR ALL TO yummyai_app
  USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "marketplace_quota_snapshots" TO yummyai_app;
