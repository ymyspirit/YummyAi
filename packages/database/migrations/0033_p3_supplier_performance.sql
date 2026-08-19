CREATE TABLE "supplier_kpi_definition_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"definition_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"missing_data_policy" text NOT NULL,
	"metrics" jsonb NOT NULL,
	"reason_code" text NOT NULL,
	"checksum" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_kpi_definition_versions_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "supplier_kpi_definition_versions_id_check" CHECK (substring("supplier_kpi_definition_versions"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "supplier_kpi_definition_versions_number_check" CHECK ("supplier_kpi_definition_versions"."version_number" > 0),
	CONSTRAINT "supplier_kpi_definition_versions_policy_check" CHECK ("supplier_kpi_definition_versions"."missing_data_policy" in ('exclude','zero','incomplete')),
	CONSTRAINT "supplier_kpi_definition_versions_checksum_check" CHECK ("supplier_kpi_definition_versions"."checksum" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "supplier_kpi_definitions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_kpi_definitions_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "supplier_kpi_definitions_id_check" CHECK (substring("supplier_kpi_definitions"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "supplier_kpi_definitions_version_check" CHECK ("supplier_kpi_definitions"."current_version" > 0),
	CONSTRAINT "supplier_kpi_definitions_status_check" CHECK ("supplier_kpi_definitions"."status" in ('active','inactive'))
);
--> statement-breakpoint
CREATE TABLE "supplier_scorecard_metrics" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"metric" text NOT NULL,
	"score_bps" integer,
	"sample_count" integer NOT NULL,
	"raw_numerator" bigint NOT NULL,
	"raw_denominator" bigint NOT NULL,
	"raw_unit" text NOT NULL,
	"evidence_references" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_scorecard_metrics_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "supplier_scorecard_metrics_id_check" CHECK (substring("supplier_scorecard_metrics"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "supplier_scorecard_metrics_metric_check" CHECK ("supplier_scorecard_metrics"."metric" in ('quality','on_time_delivery','price_variance','response_time','acceptance','cancellation','capacity_adherence')),
	CONSTRAINT "supplier_scorecard_metrics_score_check" CHECK ("supplier_scorecard_metrics"."score_bps" is null or "supplier_scorecard_metrics"."score_bps" between 0 and 10000),
	CONSTRAINT "supplier_scorecard_metrics_values_check" CHECK ("supplier_scorecard_metrics"."sample_count" >= 0 and "supplier_scorecard_metrics"."raw_numerator" >= 0 and "supplier_scorecard_metrics"."raw_denominator" >= 0),
	CONSTRAINT "supplier_scorecard_metrics_unit_check" CHECK ("supplier_scorecard_metrics"."raw_unit" in ('weighted_bps','sample_ratio','money_ratio','unit_ratio'))
);
--> statement-breakpoint
CREATE TABLE "supplier_scorecard_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"definition_id" uuid NOT NULL,
	"definition_version_id" uuid NOT NULL,
	"definition_version" integer NOT NULL,
	"status" text NOT NULL,
	"overall_score_bps" integer,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"evidence_cutoff_at" timestamp with time zone NOT NULL,
	"diagnostics" jsonb NOT NULL,
	"input_checksum" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"calculated_by" uuid,
	"calculated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_scorecard_runs_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "supplier_scorecard_runs_id_check" CHECK (substring("supplier_scorecard_runs"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "supplier_scorecard_runs_version_check" CHECK ("supplier_scorecard_runs"."definition_version" > 0),
	CONSTRAINT "supplier_scorecard_runs_status_check" CHECK ("supplier_scorecard_runs"."status" in ('complete','incomplete')),
	CONSTRAINT "supplier_scorecard_runs_score_check" CHECK (("supplier_scorecard_runs"."status" = 'complete' and "supplier_scorecard_runs"."overall_score_bps" between 0 and 10000) or ("supplier_scorecard_runs"."status" = 'incomplete' and "supplier_scorecard_runs"."overall_score_bps" is null)),
	CONSTRAINT "supplier_scorecard_runs_window_check" CHECK ("supplier_scorecard_runs"."window_end" > "supplier_scorecard_runs"."window_start" and "supplier_scorecard_runs"."evidence_cutoff_at" >= "supplier_scorecard_runs"."window_end"),
	CONSTRAINT "supplier_scorecard_runs_checksum_check" CHECK ("supplier_scorecard_runs"."input_checksum" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "supplier_kpi_definition_versions" ADD CONSTRAINT "supplier_kpi_definition_versions_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_kpi_definition_versions" ADD CONSTRAINT "supplier_kpi_definition_versions_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_kpi_definition_versions" ADD CONSTRAINT "supplier_kpi_definition_versions_definition_fk" FOREIGN KEY ("tenant_id","definition_id") REFERENCES "public"."supplier_kpi_definitions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_kpi_definitions" ADD CONSTRAINT "supplier_kpi_definitions_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_kpi_definitions" ADD CONSTRAINT "supplier_kpi_definitions_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_scorecard_metrics" ADD CONSTRAINT "supplier_scorecard_metrics_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_scorecard_metrics" ADD CONSTRAINT "supplier_scorecard_metrics_run_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."supplier_scorecard_runs"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_scorecard_runs" ADD CONSTRAINT "supplier_scorecard_runs_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_scorecard_runs" ADD CONSTRAINT "supplier_scorecard_runs_calculated_by_app_users_id_fk" FOREIGN KEY ("calculated_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_scorecard_runs" ADD CONSTRAINT "supplier_scorecard_runs_supplier_fk" FOREIGN KEY ("tenant_id","supplier_id") REFERENCES "public"."fulfillment_suppliers"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_scorecard_runs" ADD CONSTRAINT "supplier_scorecard_runs_definition_fk" FOREIGN KEY ("tenant_id","definition_id") REFERENCES "public"."supplier_kpi_definitions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_scorecard_runs" ADD CONSTRAINT "supplier_scorecard_runs_definition_version_fk" FOREIGN KEY ("tenant_id","definition_version_id") REFERENCES "public"."supplier_kpi_definition_versions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_kpi_definition_versions_number_unique" ON "supplier_kpi_definition_versions" USING btree ("tenant_id","definition_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_kpi_definition_versions_idempotency_unique" ON "supplier_kpi_definition_versions" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_kpi_definitions_name_unique" ON "supplier_kpi_definitions" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE INDEX "supplier_kpi_definitions_status_idx" ON "supplier_kpi_definitions" USING btree ("tenant_id","status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_scorecard_metrics_run_metric_unique" ON "supplier_scorecard_metrics" USING btree ("tenant_id","run_id","metric");--> statement-breakpoint
CREATE INDEX "supplier_scorecard_metrics_run_idx" ON "supplier_scorecard_metrics" USING btree ("tenant_id","run_id","metric");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_scorecard_runs_idempotency_unique" ON "supplier_scorecard_runs" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "supplier_scorecard_runs_supplier_idx" ON "supplier_scorecard_runs" USING btree ("tenant_id","supplier_id","calculated_at");
--> statement-breakpoint
ALTER TABLE "supplier_kpi_definitions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "supplier_kpi_definitions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "supplier_kpi_definitions_tenant_policy" ON "supplier_kpi_definitions" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT, UPDATE ON "supplier_kpi_definitions" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "supplier_kpi_definition_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "supplier_kpi_definition_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "supplier_kpi_definition_versions_tenant_policy" ON "supplier_kpi_definition_versions" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "supplier_kpi_definition_versions" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "supplier_scorecard_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "supplier_scorecard_runs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "supplier_scorecard_runs_tenant_policy" ON "supplier_scorecard_runs" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "supplier_scorecard_runs" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "supplier_scorecard_metrics" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "supplier_scorecard_metrics" FORCE ROW LEVEL SECURITY;
CREATE POLICY "supplier_scorecard_metrics_tenant_policy" ON "supplier_scorecard_metrics" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "supplier_scorecard_metrics" TO yummyai_app;
