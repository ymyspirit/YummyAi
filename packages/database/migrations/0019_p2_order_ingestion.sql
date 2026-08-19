CREATE TABLE "order_ingestion_risks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"ingestion_run_id" uuid NOT NULL,
	"order_id" uuid,
	"code" text NOT NULL,
	"severity" text NOT NULL,
	"external_order_id" text NOT NULL,
	"external_line_id" text,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_ingestion_risks_id_uuidv7_check" CHECK (substring("order_ingestion_risks"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "order_ingestion_risks_code_check" CHECK ("order_ingestion_risks"."code" in ('duplicate_delivery','address_gap','customization_missing','unsupported_mapping','cancellation_requested','stale_provider_data')),
	CONSTRAINT "order_ingestion_risks_severity_check" CHECK ("order_ingestion_risks"."severity" in ('blocker','warning','info'))
);
--> statement-breakpoint
CREATE TABLE "order_ingestion_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"stream" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"collected_count" integer DEFAULT 0 NOT NULL,
	"reported_count" integer,
	"duplicate_count" integer DEFAULT 0 NOT NULL,
	"risk_count" integer DEFAULT 0 NOT NULL,
	"source_version" text NOT NULL,
	"checkpoint_version_start" integer NOT NULL,
	"checkpoint_version_end" integer,
	"high_water_at" timestamp with time zone,
	"error_code" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "order_ingestion_runs_id_uuidv7_check" CHECK (substring("order_ingestion_runs"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "order_ingestion_runs_platform_check" CHECK ("order_ingestion_runs"."platform" in ('amazon','etsy')),
	CONSTRAINT "order_ingestion_runs_status_check" CHECK ("order_ingestion_runs"."status" in ('running','completed','partial','failed')),
	CONSTRAINT "order_ingestion_runs_counts_check" CHECK ("order_ingestion_runs"."collected_count" >= 0 and ("order_ingestion_runs"."reported_count" is null or "order_ingestion_runs"."reported_count" >= 0) and "order_ingestion_runs"."duplicate_count" >= 0 and "order_ingestion_runs"."risk_count" >= 0),
	CONSTRAINT "order_ingestion_runs_versions_check" CHECK ("order_ingestion_runs"."checkpoint_version_start" > 0 and ("order_ingestion_runs"."checkpoint_version_end" is null or "order_ingestion_runs"."checkpoint_version_end" > "order_ingestion_runs"."checkpoint_version_start"))
);
--> statement-breakpoint
CREATE TABLE "order_line_catalog_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_line_id" uuid NOT NULL,
	"sku_id" uuid,
	"listing_id" uuid,
	"listing_version_id" uuid,
	"match_source" text NOT NULL,
	"linked_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_line_catalog_links_id_uuidv7_check" CHECK (substring("order_line_catalog_links"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "order_line_catalog_links_source_check" CHECK ("order_line_catalog_links"."match_source" in ('external_listing','sku','manual')),
	CONSTRAINT "order_line_catalog_links_target_check" CHECK ("order_line_catalog_links"."sku_id" is not null or ("order_line_catalog_links"."listing_id" is not null and "order_line_catalog_links"."listing_version_id" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "order_ingestion_runs_tenant_id_unique" ON "order_ingestion_runs" USING btree ("tenant_id","id");--> statement-breakpoint
ALTER TABLE "order_ingestion_risks" ADD CONSTRAINT "order_ingestion_risks_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_ingestion_risks" ADD CONSTRAINT "order_ingestion_risks_run_fk" FOREIGN KEY ("tenant_id","ingestion_run_id") REFERENCES "public"."order_ingestion_runs"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_ingestion_risks" ADD CONSTRAINT "order_ingestion_risks_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_ingestion_runs" ADD CONSTRAINT "order_ingestion_runs_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_ingestion_runs" ADD CONSTRAINT "order_ingestion_runs_account_fk" FOREIGN KEY ("tenant_id","account_id") REFERENCES "public"."marketplace_accounts"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_line_catalog_links" ADD CONSTRAINT "order_line_catalog_links_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_line_catalog_links" ADD CONSTRAINT "order_line_catalog_links_linked_by_app_users_id_fk" FOREIGN KEY ("linked_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_line_catalog_links" ADD CONSTRAINT "order_line_catalog_links_order_line_fk" FOREIGN KEY ("tenant_id","order_line_id") REFERENCES "public"."order_lines"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_line_catalog_links" ADD CONSTRAINT "order_line_catalog_links_sku_fk" FOREIGN KEY ("tenant_id","sku_id") REFERENCES "public"."skus"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_line_catalog_links" ADD CONSTRAINT "order_line_catalog_links_listing_fk" FOREIGN KEY ("tenant_id","listing_id") REFERENCES "public"."listings"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_line_catalog_links" ADD CONSTRAINT "order_line_catalog_links_listing_version_fk" FOREIGN KEY ("tenant_id","listing_version_id") REFERENCES "public"."listing_versions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "order_ingestion_risks_tenant_id_unique" ON "order_ingestion_risks" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX "order_ingestion_risks_run_idx" ON "order_ingestion_risks" USING btree ("tenant_id","ingestion_run_id","severity","created_at");--> statement-breakpoint
CREATE INDEX "order_ingestion_runs_account_idx" ON "order_ingestion_runs" USING btree ("tenant_id","account_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "order_line_catalog_links_tenant_id_unique" ON "order_line_catalog_links" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_line_catalog_links_order_line_unique" ON "order_line_catalog_links" USING btree ("tenant_id","order_line_id");
--> statement-breakpoint
ALTER TABLE "order_ingestion_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_ingestion_runs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "order_ingestion_runs_tenant_policy" ON "order_ingestion_runs" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT, UPDATE ON "order_ingestion_runs" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "order_ingestion_risks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_ingestion_risks" FORCE ROW LEVEL SECURITY;
CREATE POLICY "order_ingestion_risks_tenant_policy" ON "order_ingestion_risks" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "order_ingestion_risks" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "order_line_catalog_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_line_catalog_links" FORCE ROW LEVEL SECURITY;
CREATE POLICY "order_line_catalog_links_tenant_policy" ON "order_line_catalog_links" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "order_line_catalog_links" TO yummyai_app;
