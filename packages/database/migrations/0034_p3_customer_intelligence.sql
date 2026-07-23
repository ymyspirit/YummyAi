CREATE TABLE "advertising_metric_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"report_id" uuid NOT NULL,
	"line_key" text NOT NULL,
	"entity_level" text NOT NULL,
	"external_campaign_id" text NOT NULL,
	"external_ad_group_id" text,
	"normalized_term" text,
	"identity_redacted" boolean NOT NULL,
	"listing_id" uuid,
	"sku_id" uuid,
	"impressions" bigint NOT NULL,
	"clicks" bigint NOT NULL,
	"orders" bigint NOT NULL,
	"spend_minor" bigint NOT NULL,
	"sales_minor" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "advertising_metric_lines_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "advertising_metric_lines_id_check" CHECK (substring("advertising_metric_lines"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "advertising_metric_lines_level_check" CHECK ("advertising_metric_lines"."entity_level" in ('campaign','ad_group','keyword','search_term')),
	CONSTRAINT "advertising_metric_lines_redacted_check" CHECK ("advertising_metric_lines"."identity_redacted" = true),
	CONSTRAINT "advertising_metric_lines_values_check" CHECK ("advertising_metric_lines"."impressions" >= 0 and "advertising_metric_lines"."clicks" >= 0 and "advertising_metric_lines"."orders" >= 0 and "advertising_metric_lines"."spend_minor" >= 0 and "advertising_metric_lines"."sales_minor" >= 0 and "advertising_metric_lines"."clicks" <= "advertising_metric_lines"."impressions" and "advertising_metric_lines"."orders" <= "advertising_metric_lines"."clicks"),
	CONSTRAINT "advertising_metric_lines_term_check" CHECK (("advertising_metric_lines"."entity_level" in ('keyword','search_term')) = ("advertising_metric_lines"."normalized_term" is not null))
);
--> statement-breakpoint
CREATE TABLE "advertising_reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"account_id" uuid,
	"external_report_id" text NOT NULL,
	"scope_key" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"attribution_window_days" integer NOT NULL,
	"source_currency" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"checksum" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"recorded_by" uuid,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "advertising_reports_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "advertising_reports_id_check" CHECK (substring("advertising_reports"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "advertising_reports_provider_check" CHECK ("advertising_reports"."provider" in ('amazon_ads','etsy_ads','manual')),
	CONSTRAINT "advertising_reports_period_check" CHECK ("advertising_reports"."period_end" >= "advertising_reports"."period_start" and "advertising_reports"."observed_at" >= "advertising_reports"."period_end"),
	CONSTRAINT "advertising_reports_attribution_check" CHECK ("advertising_reports"."attribution_window_days" between 0 and 365),
	CONSTRAINT "advertising_reports_currency_check" CHECK ("advertising_reports"."source_currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "advertising_reports_checksum_check" CHECK ("advertising_reports"."checksum" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "customer_recommendation_review_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"recommendation_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"reason_code" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_recommendation_review_events_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "customer_recommendation_review_events_id_check" CHECK (substring("customer_recommendation_review_events"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "customer_recommendation_review_events_decision_check" CHECK ("customer_recommendation_review_events"."decision" in ('approved','rejected'))
);
--> statement-breakpoint
CREATE TABLE "customer_recommendations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"theme_code" text NOT NULL,
	"action" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"evidence_signal_ids" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone,
	CONSTRAINT "customer_recommendations_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "customer_recommendations_id_check" CHECK (substring("customer_recommendations"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "customer_recommendations_action_check" CHECK ("customer_recommendations"."action" in ('investigate_product','review_listing_expectations','review_campaign_terms','review_service_process')),
	CONSTRAINT "customer_recommendations_status_check" CHECK ("customer_recommendations"."status" in ('pending','approved','rejected')),
	CONSTRAINT "customer_recommendations_review_check" CHECK (("customer_recommendations"."status" = 'pending' and "customer_recommendations"."reviewed_at" is null) or ("customer_recommendations"."status" in ('approved','rejected') and "customer_recommendations"."reviewed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "customer_signal_facts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"theme_code" text NOT NULL,
	"sentiment" text NOT NULL,
	"occurrence_count" integer NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"consent_basis" text NOT NULL,
	"identity_redacted" boolean NOT NULL,
	"excerpt_checksum" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"recorded_by" uuid,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_signal_facts_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "customer_signal_facts_id_check" CHECK (substring("customer_signal_facts"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "customer_signal_facts_source_check" CHECK ("customer_signal_facts"."source_type" in ('review','return_reason','support_contact','quality_defect','keyword')),
	CONSTRAINT "customer_signal_facts_sentiment_check" CHECK ("customer_signal_facts"."sentiment" in ('negative','neutral','positive','mixed')),
	CONSTRAINT "customer_signal_facts_consent_check" CHECK ("customer_signal_facts"."consent_basis" in ('public_page','marketplace_authorization','customer_support','internal_quality','advertising_authorization')),
	CONSTRAINT "customer_signal_facts_redacted_check" CHECK ("customer_signal_facts"."identity_redacted" = true),
	CONSTRAINT "customer_signal_facts_occurrence_check" CHECK ("customer_signal_facts"."occurrence_count" between 1 and 1000000),
	CONSTRAINT "customer_signal_facts_theme_check" CHECK ("customer_signal_facts"."theme_code" ~ '^[A-Z0-9][A-Z0-9._-]*$'),
	CONSTRAINT "customer_signal_facts_checksum_check" CHECK ("customer_signal_facts"."excerpt_checksum" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "voc_analysis_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"definition_id" uuid NOT NULL,
	"definition_version_id" uuid NOT NULL,
	"definition_version" integer NOT NULL,
	"status" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"evidence_cutoff_at" timestamp with time zone NOT NULL,
	"signal_ids" jsonb NOT NULL,
	"input_checksum" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"calculated_by" uuid,
	"calculated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "voc_analysis_runs_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "voc_analysis_runs_id_check" CHECK (substring("voc_analysis_runs"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "voc_analysis_runs_version_check" CHECK ("voc_analysis_runs"."definition_version" > 0),
	CONSTRAINT "voc_analysis_runs_status_check" CHECK ("voc_analysis_runs"."status" in ('complete','incomplete')),
	CONSTRAINT "voc_analysis_runs_window_check" CHECK ("voc_analysis_runs"."window_end" > "voc_analysis_runs"."window_start" and "voc_analysis_runs"."evidence_cutoff_at" >= "voc_analysis_runs"."window_end"),
	CONSTRAINT "voc_analysis_runs_checksum_check" CHECK ("voc_analysis_runs"."input_checksum" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "voc_definition_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"definition_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"source_weights" jsonb NOT NULL,
	"minimum_occurrences" integer NOT NULL,
	"reason_code" text NOT NULL,
	"checksum" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "voc_definition_versions_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "voc_definition_versions_id_check" CHECK (substring("voc_definition_versions"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "voc_definition_versions_number_check" CHECK ("voc_definition_versions"."version_number" > 0),
	CONSTRAINT "voc_definition_versions_occurrence_check" CHECK ("voc_definition_versions"."minimum_occurrences" between 1 and 1000000),
	CONSTRAINT "voc_definition_versions_checksum_check" CHECK ("voc_definition_versions"."checksum" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "voc_definitions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "voc_definitions_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "voc_definitions_id_check" CHECK (substring("voc_definitions"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "voc_definitions_version_check" CHECK ("voc_definitions"."current_version" > 0),
	CONSTRAINT "voc_definitions_status_check" CHECK ("voc_definitions"."status" in ('active','inactive'))
);
--> statement-breakpoint
CREATE TABLE "voc_theme_metrics" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"theme_code" text NOT NULL,
	"total_occurrences" integer NOT NULL,
	"negative_occurrences" integer NOT NULL,
	"negative_bps" integer,
	"weighted_score" bigint NOT NULL,
	"source_counts" jsonb NOT NULL,
	"signal_ids" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "voc_theme_metrics_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "voc_theme_metrics_id_check" CHECK (substring("voc_theme_metrics"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "voc_theme_metrics_values_check" CHECK ("voc_theme_metrics"."total_occurrences" >= 0 and "voc_theme_metrics"."negative_occurrences" >= 0 and "voc_theme_metrics"."negative_occurrences" <= "voc_theme_metrics"."total_occurrences" and ("voc_theme_metrics"."negative_bps" is null or "voc_theme_metrics"."negative_bps" between 0 and 10000) and "voc_theme_metrics"."weighted_score" >= 0)
);
--> statement-breakpoint
ALTER TABLE "advertising_metric_lines" ADD CONSTRAINT "advertising_metric_lines_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advertising_metric_lines" ADD CONSTRAINT "advertising_metric_lines_report_fk" FOREIGN KEY ("tenant_id","report_id") REFERENCES "public"."advertising_reports"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advertising_metric_lines" ADD CONSTRAINT "advertising_metric_lines_listing_fk" FOREIGN KEY ("tenant_id","listing_id") REFERENCES "public"."listings"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advertising_metric_lines" ADD CONSTRAINT "advertising_metric_lines_sku_fk" FOREIGN KEY ("tenant_id","sku_id") REFERENCES "public"."skus"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advertising_reports" ADD CONSTRAINT "advertising_reports_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advertising_reports" ADD CONSTRAINT "advertising_reports_recorded_by_app_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advertising_reports" ADD CONSTRAINT "advertising_reports_account_fk" FOREIGN KEY ("tenant_id","account_id") REFERENCES "public"."marketplace_accounts"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_recommendation_review_events" ADD CONSTRAINT "customer_recommendation_review_events_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_recommendation_review_events" ADD CONSTRAINT "customer_recommendation_review_events_reviewed_by_app_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_recommendation_review_events" ADD CONSTRAINT "customer_recommendation_review_events_recommendation_fk" FOREIGN KEY ("tenant_id","recommendation_id") REFERENCES "public"."customer_recommendations"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_recommendations" ADD CONSTRAINT "customer_recommendations_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_recommendations" ADD CONSTRAINT "customer_recommendations_run_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."voc_analysis_runs"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_signal_facts" ADD CONSTRAINT "customer_signal_facts_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_signal_facts" ADD CONSTRAINT "customer_signal_facts_recorded_by_app_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voc_analysis_runs" ADD CONSTRAINT "voc_analysis_runs_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voc_analysis_runs" ADD CONSTRAINT "voc_analysis_runs_calculated_by_app_users_id_fk" FOREIGN KEY ("calculated_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voc_analysis_runs" ADD CONSTRAINT "voc_analysis_runs_definition_fk" FOREIGN KEY ("tenant_id","definition_id") REFERENCES "public"."voc_definitions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voc_analysis_runs" ADD CONSTRAINT "voc_analysis_runs_definition_version_fk" FOREIGN KEY ("tenant_id","definition_version_id") REFERENCES "public"."voc_definition_versions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voc_definition_versions" ADD CONSTRAINT "voc_definition_versions_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voc_definition_versions" ADD CONSTRAINT "voc_definition_versions_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voc_definition_versions" ADD CONSTRAINT "voc_definition_versions_definition_fk" FOREIGN KEY ("tenant_id","definition_id") REFERENCES "public"."voc_definitions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voc_definitions" ADD CONSTRAINT "voc_definitions_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voc_definitions" ADD CONSTRAINT "voc_definitions_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voc_theme_metrics" ADD CONSTRAINT "voc_theme_metrics_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voc_theme_metrics" ADD CONSTRAINT "voc_theme_metrics_run_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."voc_analysis_runs"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "advertising_metric_lines_report_key_unique" ON "advertising_metric_lines" USING btree ("tenant_id","report_id","line_key");--> statement-breakpoint
CREATE INDEX "advertising_metric_lines_term_idx" ON "advertising_metric_lines" USING btree ("tenant_id","entity_level","normalized_term");--> statement-breakpoint
CREATE UNIQUE INDEX "advertising_reports_idempotency_unique" ON "advertising_reports" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "advertising_reports_provider_external_unique" ON "advertising_reports" USING btree ("tenant_id","provider","external_report_id");--> statement-breakpoint
CREATE INDEX "advertising_reports_period_idx" ON "advertising_reports" USING btree ("tenant_id","period_end","recorded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_recommendation_review_events_idempotency_unique" ON "customer_recommendation_review_events" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_recommendation_review_events_recommendation_unique" ON "customer_recommendation_review_events" USING btree ("tenant_id","recommendation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_recommendations_run_theme_action_unique" ON "customer_recommendations" USING btree ("tenant_id","run_id","theme_code","action");--> statement-breakpoint
CREATE INDEX "customer_recommendations_status_idx" ON "customer_recommendations" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_signal_facts_idempotency_unique" ON "customer_signal_facts" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "customer_signal_facts_window_idx" ON "customer_signal_facts" USING btree ("tenant_id","occurred_at","source_type");--> statement-breakpoint
CREATE INDEX "customer_signal_facts_theme_idx" ON "customer_signal_facts" USING btree ("tenant_id","theme_code","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "voc_analysis_runs_idempotency_unique" ON "voc_analysis_runs" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "voc_analysis_runs_window_idx" ON "voc_analysis_runs" USING btree ("tenant_id","window_end","calculated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "voc_definition_versions_number_unique" ON "voc_definition_versions" USING btree ("tenant_id","definition_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "voc_definition_versions_idempotency_unique" ON "voc_definition_versions" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "voc_definitions_name_unique" ON "voc_definitions" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "voc_theme_metrics_run_theme_unique" ON "voc_theme_metrics" USING btree ("tenant_id","run_id","theme_code");
--> statement-breakpoint
ALTER TABLE "advertising_reports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "advertising_reports" FORCE ROW LEVEL SECURITY;
CREATE POLICY "advertising_reports_tenant_policy" ON "advertising_reports" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "advertising_reports" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "advertising_metric_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "advertising_metric_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY "advertising_metric_lines_tenant_policy" ON "advertising_metric_lines" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "advertising_metric_lines" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "customer_signal_facts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_signal_facts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "customer_signal_facts_tenant_policy" ON "customer_signal_facts" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "customer_signal_facts" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "voc_definitions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "voc_definitions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "voc_definitions_tenant_policy" ON "voc_definitions" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT, UPDATE ON "voc_definitions" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "voc_definition_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "voc_definition_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "voc_definition_versions_tenant_policy" ON "voc_definition_versions" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "voc_definition_versions" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "voc_analysis_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "voc_analysis_runs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "voc_analysis_runs_tenant_policy" ON "voc_analysis_runs" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "voc_analysis_runs" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "voc_theme_metrics" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "voc_theme_metrics" FORCE ROW LEVEL SECURITY;
CREATE POLICY "voc_theme_metrics_tenant_policy" ON "voc_theme_metrics" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "voc_theme_metrics" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "customer_recommendations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_recommendations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "customer_recommendations_tenant_policy" ON "customer_recommendations" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT, UPDATE ON "customer_recommendations" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "customer_recommendation_review_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_recommendation_review_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "customer_recommendation_review_events_tenant_policy" ON "customer_recommendation_review_events" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "customer_recommendation_review_events" TO yummyai_app;
