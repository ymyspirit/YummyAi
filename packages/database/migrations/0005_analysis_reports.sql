ALTER TABLE "asset_files" ADD COLUMN "rights_status" text DEFAULT 'unverified' NOT NULL;
ALTER TABLE "asset_files" ADD COLUMN "rights_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;
ALTER TABLE "asset_files" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;
ALTER TABLE "asset_files" ADD COLUMN "ai_generated" boolean DEFAULT false NOT NULL;
ALTER TABLE "asset_files" ADD CONSTRAINT "asset_files_rights_status_check" CHECK ("rights_status" IN ('unverified', 'approved', 'rejected'));
ALTER TABLE "asset_files" ADD CONSTRAINT "asset_files_version_check" CHECK ("version" > 0);
CREATE UNIQUE INDEX "asset_files_tenant_id_unique" ON "asset_files" ("tenant_id", "id");
--> statement-breakpoint
CREATE TABLE "analysis_reports" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "report_series_id" uuid NOT NULL,
  "version" integer NOT NULL,
  "task_type" text NOT NULL,
  "status" text NOT NULL,
  "input_snapshot_ids" jsonb NOT NULL,
  "report" jsonb NOT NULL,
  "created_by" uuid REFERENCES "app_users"("id") ON DELETE SET NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "analysis_reports_id_uuidv7_check" CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "analysis_reports_series_uuidv7_check" CHECK (substring("report_series_id"::text from 15 for 1) = '7'),
  CONSTRAINT "analysis_reports_version_check" CHECK ("version" > 0),
  CONSTRAINT "analysis_reports_task_check" CHECK ("task_type" IN ('AI-01','AI-02','AI-03','AI-04','AI-05','AI-06','AI-07','AI-08')),
  CONSTRAINT "analysis_reports_status_check" CHECK ("status" IN ('completed', 'failed', 'cancelled'))
);
CREATE UNIQUE INDEX "analysis_reports_tenant_id_unique" ON "analysis_reports" ("tenant_id", "id");
CREATE UNIQUE INDEX "analysis_reports_series_version_unique" ON "analysis_reports" ("tenant_id", "report_series_id", "version");
CREATE INDEX "analysis_reports_series_created_idx" ON "analysis_reports" ("tenant_id", "report_series_id", "created_at");
--> statement-breakpoint
CREATE TABLE "generated_image_provenance" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "asset_id" uuid NOT NULL,
  "provider" text NOT NULL,
  "model_key" text NOT NULL,
  "prompt_template_version" text NOT NULL,
  "provenance" jsonb NOT NULL,
  "cost_usd" numeric(14,6) NOT NULL,
  "review_status" text DEFAULT 'draft' NOT NULL,
  "ai_generated" boolean DEFAULT true NOT NULL,
  "created_by" uuid REFERENCES "app_users"("id") ON DELETE SET NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "generated_image_provenance_id_uuidv7_check" CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "generated_image_provenance_review_check" CHECK ("review_status" IN ('draft', 'approved', 'rejected')),
  CONSTRAINT "generated_image_provenance_cost_check" CHECK ("cost_usd" >= 0),
  CONSTRAINT "generated_image_provenance_asset_fk" FOREIGN KEY ("tenant_id", "asset_id") REFERENCES "asset_files"("tenant_id", "id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "generated_image_provenance_tenant_asset_unique" ON "generated_image_provenance" ("tenant_id", "asset_id");
CREATE INDEX "generated_image_provenance_status_idx" ON "generated_image_provenance" ("tenant_id", "review_status", "created_at");
--> statement-breakpoint
ALTER TABLE "analysis_reports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "analysis_reports" FORCE ROW LEVEL SECURITY;
CREATE POLICY "analysis_reports_tenant_policy" ON "analysis_reports" FOR ALL TO yummyai_app
  USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
ALTER TABLE "generated_image_provenance" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "generated_image_provenance" FORCE ROW LEVEL SECURITY;
CREATE POLICY "generated_image_provenance_tenant_policy" ON "generated_image_provenance" FOR ALL TO yummyai_app
  USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON analysis_reports, generated_image_provenance TO yummyai_app;
GRANT UPDATE (rights_status, rights_metadata, version, ai_generated) ON asset_files TO yummyai_app;
