CREATE TABLE "finance_facts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"statement_id" uuid NOT NULL,
	"account_id" uuid,
	"line_key" text NOT NULL,
	"fact_type" text NOT NULL,
	"direction" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"external_reference" text,
	"order_id" uuid,
	"order_line_id" uuid,
	"sku_id" uuid,
	"listing_id" uuid,
	"supplier_id" uuid,
	"correction_kind" text NOT NULL,
	"corrects_fact_id" uuid,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_facts_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "finance_facts_id_check" CHECK (substring("finance_facts"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "finance_facts_type_check" CHECK ("finance_facts"."fact_type" in ('sale_revenue','shipping_revenue','marketplace_commission','advertising_spend','fulfillment_fee','storage_fee','refund','chargeback','procurement_cost','production_cost','freight_cost','carrier_cost','tax','other_fee')),
	CONSTRAINT "finance_facts_direction_check" CHECK ("finance_facts"."direction" in ('credit','debit')),
	CONSTRAINT "finance_facts_amount_check" CHECK ("finance_facts"."amount_minor" >= 0),
	CONSTRAINT "finance_facts_currency_check" CHECK ("finance_facts"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "finance_facts_correction_check" CHECK (("finance_facts"."correction_kind" = 'original' and "finance_facts"."corrects_fact_id" is null) or ("finance_facts"."correction_kind" in ('reversal','replacement') and "finance_facts"."corrects_fact_id" is not null)),
	CONSTRAINT "finance_facts_order_line_check" CHECK ("finance_facts"."order_line_id" is null or "finance_facts"."order_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "finance_fx_rates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source" text NOT NULL,
	"base_currency" text NOT NULL,
	"quote_currency" text NOT NULL,
	"rate_numerator" bigint NOT NULL,
	"rate_denominator" bigint NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"retrieved_at" timestamp with time zone NOT NULL,
	"checksum" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"recorded_by" uuid,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_fx_rates_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "finance_fx_rates_id_check" CHECK (substring("finance_fx_rates"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "finance_fx_rates_pair_check" CHECK ("finance_fx_rates"."base_currency" ~ '^[A-Z]{3}$' and "finance_fx_rates"."quote_currency" ~ '^[A-Z]{3}$' and "finance_fx_rates"."base_currency" <> "finance_fx_rates"."quote_currency"),
	CONSTRAINT "finance_fx_rates_rate_check" CHECK ("finance_fx_rates"."rate_numerator" > 0 and "finance_fx_rates"."rate_denominator" > 0),
	CONSTRAINT "finance_fx_rates_time_check" CHECK ("finance_fx_rates"."retrieved_at" >= "finance_fx_rates"."effective_at"),
	CONSTRAINT "finance_fx_rates_checksum_check" CHECK ("finance_fx_rates"."checksum" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "finance_profit_contributions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"fact_id" uuid NOT NULL,
	"fx_rate_id" uuid,
	"bucket" text NOT NULL,
	"source_amount_minor" bigint NOT NULL,
	"source_currency" text NOT NULL,
	"reporting_amount_minor" bigint,
	"reporting_currency" text NOT NULL,
	"effect_sign" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_profit_contributions_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "finance_profit_contributions_id_check" CHECK (substring("finance_profit_contributions"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "finance_profit_contributions_bucket_check" CHECK ("finance_profit_contributions"."bucket" in ('revenue','cost','unclassified')),
	CONSTRAINT "finance_profit_contributions_amount_check" CHECK ("finance_profit_contributions"."source_amount_minor" >= 0 and ("finance_profit_contributions"."reporting_amount_minor" is null or "finance_profit_contributions"."reporting_amount_minor" >= 0)),
	CONSTRAINT "finance_profit_contributions_currency_check" CHECK ("finance_profit_contributions"."source_currency" ~ '^[A-Z]{3}$' and "finance_profit_contributions"."reporting_currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "finance_profit_contributions_sign_check" CHECK ("finance_profit_contributions"."effect_sign" in (-1, 1))
);
--> statement-breakpoint
CREATE TABLE "finance_profit_metric_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"metric_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"reporting_currency" text NOT NULL,
	"revenue_fact_types" jsonb NOT NULL,
	"cost_fact_types" jsonb NOT NULL,
	"required_fact_types" jsonb NOT NULL,
	"reason_code" text NOT NULL,
	"checksum" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_profit_metric_versions_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "finance_profit_metric_versions_id_check" CHECK (substring("finance_profit_metric_versions"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "finance_profit_metric_versions_number_check" CHECK ("finance_profit_metric_versions"."version_number" > 0),
	CONSTRAINT "finance_profit_metric_versions_currency_check" CHECK ("finance_profit_metric_versions"."reporting_currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "finance_profit_metric_versions_checksum_check" CHECK ("finance_profit_metric_versions"."checksum" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "finance_profit_metrics" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_profit_metrics_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "finance_profit_metrics_id_check" CHECK (substring("finance_profit_metrics"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "finance_profit_metrics_version_check" CHECK ("finance_profit_metrics"."current_version" > 0),
	CONSTRAINT "finance_profit_metrics_status_check" CHECK ("finance_profit_metrics"."status" in ('active','inactive'))
);
--> statement-breakpoint
CREATE TABLE "finance_profit_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"metric_id" uuid NOT NULL,
	"metric_version_id" uuid NOT NULL,
	"reporting_currency" text NOT NULL,
	"status" text NOT NULL,
	"revenue_minor" bigint,
	"cost_minor" bigint,
	"profit_minor" bigint,
	"margin_bps" integer,
	"statement_ids" jsonb NOT NULL,
	"fx_rate_ids" jsonb NOT NULL,
	"diagnostics" jsonb NOT NULL,
	"input_checksum" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"calculated_by" uuid,
	"calculated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_profit_runs_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "finance_profit_runs_id_check" CHECK (substring("finance_profit_runs"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "finance_profit_runs_status_check" CHECK ("finance_profit_runs"."status" in ('complete','incomplete')),
	CONSTRAINT "finance_profit_runs_currency_check" CHECK ("finance_profit_runs"."reporting_currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "finance_profit_runs_totals_check" CHECK (("finance_profit_runs"."status" = 'incomplete' and "finance_profit_runs"."revenue_minor" is null and "finance_profit_runs"."cost_minor" is null and "finance_profit_runs"."profit_minor" is null and "finance_profit_runs"."margin_bps" is null) or ("finance_profit_runs"."status" = 'complete' and "finance_profit_runs"."revenue_minor" is not null and "finance_profit_runs"."cost_minor" is not null and "finance_profit_runs"."profit_minor" is not null)),
	CONSTRAINT "finance_profit_runs_checksum_check" CHECK ("finance_profit_runs"."input_checksum" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "finance_statements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"account_id" uuid,
	"provider" text NOT NULL,
	"statement_kind" text NOT NULL,
	"external_statement_id" text NOT NULL,
	"scope_key" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"source_currency" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"checksum" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"recorded_by" uuid,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_statements_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "finance_statements_id_check" CHECK (substring("finance_statements"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "finance_statements_provider_check" CHECK ("finance_statements"."provider" in ('amazon','etsy','advertising','carrier','supplier','tax_authority','manual')),
	CONSTRAINT "finance_statements_kind_check" CHECK ("finance_statements"."statement_kind" in ('marketplace_settlement','advertising_invoice','fulfillment_invoice','carrier_invoice','supplier_invoice','tax_statement','operational_cost','manual_adjustment')),
	CONSTRAINT "finance_statements_period_check" CHECK ("finance_statements"."period_end" >= "finance_statements"."period_start"),
	CONSTRAINT "finance_statements_currency_check" CHECK ("finance_statements"."source_currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "finance_statements_checksum_check" CHECK ("finance_statements"."checksum" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "finance_facts" ADD CONSTRAINT "finance_facts_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_facts" ADD CONSTRAINT "finance_facts_statement_fk" FOREIGN KEY ("tenant_id","statement_id") REFERENCES "public"."finance_statements"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_facts" ADD CONSTRAINT "finance_facts_account_fk" FOREIGN KEY ("tenant_id","account_id") REFERENCES "public"."marketplace_accounts"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_facts" ADD CONSTRAINT "finance_facts_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_facts" ADD CONSTRAINT "finance_facts_order_line_fk" FOREIGN KEY ("tenant_id","order_line_id") REFERENCES "public"."order_lines"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_facts" ADD CONSTRAINT "finance_facts_sku_fk" FOREIGN KEY ("tenant_id","sku_id") REFERENCES "public"."skus"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_facts" ADD CONSTRAINT "finance_facts_listing_fk" FOREIGN KEY ("tenant_id","listing_id") REFERENCES "public"."listings"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_facts" ADD CONSTRAINT "finance_facts_supplier_fk" FOREIGN KEY ("tenant_id","supplier_id") REFERENCES "public"."fulfillment_suppliers"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_facts" ADD CONSTRAINT "finance_facts_correction_fk" FOREIGN KEY ("tenant_id","corrects_fact_id") REFERENCES "public"."finance_facts"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_fx_rates" ADD CONSTRAINT "finance_fx_rates_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_fx_rates" ADD CONSTRAINT "finance_fx_rates_recorded_by_app_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_profit_contributions" ADD CONSTRAINT "finance_profit_contributions_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_profit_contributions" ADD CONSTRAINT "finance_profit_contributions_run_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."finance_profit_runs"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_profit_contributions" ADD CONSTRAINT "finance_profit_contributions_fact_fk" FOREIGN KEY ("tenant_id","fact_id") REFERENCES "public"."finance_facts"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_profit_contributions" ADD CONSTRAINT "finance_profit_contributions_fx_fk" FOREIGN KEY ("tenant_id","fx_rate_id") REFERENCES "public"."finance_fx_rates"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_profit_metric_versions" ADD CONSTRAINT "finance_profit_metric_versions_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_profit_metric_versions" ADD CONSTRAINT "finance_profit_metric_versions_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_profit_metric_versions" ADD CONSTRAINT "finance_profit_metric_versions_metric_fk" FOREIGN KEY ("tenant_id","metric_id") REFERENCES "public"."finance_profit_metrics"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_profit_metrics" ADD CONSTRAINT "finance_profit_metrics_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_profit_metrics" ADD CONSTRAINT "finance_profit_metrics_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_profit_runs" ADD CONSTRAINT "finance_profit_runs_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_profit_runs" ADD CONSTRAINT "finance_profit_runs_calculated_by_app_users_id_fk" FOREIGN KEY ("calculated_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_profit_runs" ADD CONSTRAINT "finance_profit_runs_metric_fk" FOREIGN KEY ("tenant_id","metric_id") REFERENCES "public"."finance_profit_metrics"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_profit_runs" ADD CONSTRAINT "finance_profit_runs_metric_version_fk" FOREIGN KEY ("tenant_id","metric_version_id") REFERENCES "public"."finance_profit_metric_versions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_statements" ADD CONSTRAINT "finance_statements_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_statements" ADD CONSTRAINT "finance_statements_recorded_by_app_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_statements" ADD CONSTRAINT "finance_statements_account_fk" FOREIGN KEY ("tenant_id","account_id") REFERENCES "public"."marketplace_accounts"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "finance_facts_statement_line_unique" ON "finance_facts" USING btree ("tenant_id","statement_id","line_key");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_facts_correction_unique" ON "finance_facts" USING btree ("tenant_id","correction_kind","corrects_fact_id");--> statement-breakpoint
CREATE INDEX "finance_facts_order_idx" ON "finance_facts" USING btree ("tenant_id","order_id","order_line_id","occurred_at");--> statement-breakpoint
CREATE INDEX "finance_facts_catalog_idx" ON "finance_facts" USING btree ("tenant_id","sku_id","listing_id","occurred_at");--> statement-breakpoint
CREATE INDEX "finance_facts_type_idx" ON "finance_facts" USING btree ("tenant_id","fact_type","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_fx_rates_identity_unique" ON "finance_fx_rates" USING btree ("tenant_id","source","base_currency","quote_currency","effective_at","retrieved_at");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_fx_rates_idempotency_unique" ON "finance_fx_rates" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "finance_fx_rates_pair_idx" ON "finance_fx_rates" USING btree ("tenant_id","base_currency","quote_currency","effective_at");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_profit_contributions_fact_unique" ON "finance_profit_contributions" USING btree ("tenant_id","run_id","fact_id");--> statement-breakpoint
CREATE INDEX "finance_profit_contributions_run_idx" ON "finance_profit_contributions" USING btree ("tenant_id","run_id","bucket");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_profit_metric_versions_number_unique" ON "finance_profit_metric_versions" USING btree ("tenant_id","metric_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_profit_metric_versions_idempotency_unique" ON "finance_profit_metric_versions" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_profit_metrics_name_unique" ON "finance_profit_metrics" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE INDEX "finance_profit_metrics_status_idx" ON "finance_profit_metrics" USING btree ("tenant_id","status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_profit_runs_idempotency_unique" ON "finance_profit_runs" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "finance_profit_runs_metric_idx" ON "finance_profit_runs" USING btree ("tenant_id","metric_id","calculated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_statements_external_unique" ON "finance_statements" USING btree ("tenant_id","provider","scope_key","external_statement_id");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_statements_idempotency_unique" ON "finance_statements" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "finance_statements_period_idx" ON "finance_statements" USING btree ("tenant_id","period_start","period_end");
--> statement-breakpoint
ALTER TABLE "finance_statements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "finance_statements" FORCE ROW LEVEL SECURITY;
CREATE POLICY "finance_statements_tenant_policy" ON "finance_statements" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "finance_statements" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "finance_facts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "finance_facts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "finance_facts_tenant_policy" ON "finance_facts" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "finance_facts" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "finance_fx_rates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "finance_fx_rates" FORCE ROW LEVEL SECURITY;
CREATE POLICY "finance_fx_rates_tenant_policy" ON "finance_fx_rates" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "finance_fx_rates" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "finance_profit_metrics" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "finance_profit_metrics" FORCE ROW LEVEL SECURITY;
CREATE POLICY "finance_profit_metrics_tenant_policy" ON "finance_profit_metrics" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT, UPDATE ON "finance_profit_metrics" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "finance_profit_metric_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "finance_profit_metric_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "finance_profit_metric_versions_tenant_policy" ON "finance_profit_metric_versions" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "finance_profit_metric_versions" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "finance_profit_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "finance_profit_runs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "finance_profit_runs_tenant_policy" ON "finance_profit_runs" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "finance_profit_runs" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "finance_profit_contributions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "finance_profit_contributions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "finance_profit_contributions_tenant_policy" ON "finance_profit_contributions" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "finance_profit_contributions" TO yummyai_app;
