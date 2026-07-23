CREATE TABLE "production_milestone_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"production_order_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"type" text NOT NULL,
	"external_event_id" text,
	"evidence_code" text NOT NULL,
	"encrypted_evidence_note" text,
	"evidence_asset_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"actor_user_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "production_milestone_events_id_uuidv7_check" CHECK (substring("production_milestone_events"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "production_milestone_events_sequence_check" CHECK ("production_milestone_events"."sequence" > 0),
	CONSTRAINT "production_milestone_events_type_check" CHECK ("production_milestone_events"."type" in ('submitted','acknowledged','started','completed','failed','cancel_requested','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "production_order_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"production_order_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"quantity" integer NOT NULL,
	"design_version_id" uuid,
	"production_asset_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"encrypted_instructions" text NOT NULL,
	"instructions_checksum" text NOT NULL,
	"expected_completion_at" timestamp with time zone NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "production_order_versions_id_uuidv7_check" CHECK (substring("production_order_versions"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "production_order_versions_version_check" CHECK ("production_order_versions"."version_number" > 0 and "production_order_versions"."quantity" > 0),
	CONSTRAINT "production_order_versions_checksum_check" CHECK ("production_order_versions"."instructions_checksum" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "production_orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"order_line_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"routing_decision_id" uuid NOT NULL,
	"purchase_order_version_id" uuid NOT NULL,
	"parent_production_order_id" uuid,
	"source" text DEFAULT 'initial' NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"projection_version" integer DEFAULT 1 NOT NULL,
	"current_version_number" integer DEFAULT 1 NOT NULL,
	"expected_completion_at" timestamp with time zone NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "production_orders_id_uuidv7_check" CHECK (substring("production_orders"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "production_orders_source_check" CHECK ("production_orders"."source" in ('initial','remake')),
	CONSTRAINT "production_orders_status_check" CHECK ("production_orders"."status" in ('planned','submitted','acknowledged','in_production','quality_hold','completed','cancel_requested','cancelled','failed')),
	CONSTRAINT "production_orders_versions_check" CHECK ("production_orders"."projection_version" > 0 and "production_orders"."current_version_number" > 0),
	CONSTRAINT "production_orders_parent_check" CHECK (("production_orders"."source" = 'initial' and "production_orders"."parent_production_order_id" is null) or ("production_orders"."source" = 'remake' and "production_orders"."parent_production_order_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "production_recovery_cases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"original_production_order_id" uuid NOT NULL,
	"defect_id" uuid,
	"type" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"projection_version" integer DEFAULT 1 NOT NULL,
	"encrypted_reason" text NOT NULL,
	"reason_checksum" text NOT NULL,
	"compensation_amount_minor" bigint,
	"compensation_currency" text,
	"expected_completion_at" timestamp with time zone,
	"idempotency_key" text NOT NULL,
	"opened_by" uuid,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "production_recovery_cases_id_uuidv7_check" CHECK (substring("production_recovery_cases"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "production_recovery_cases_type_check" CHECK ("production_recovery_cases"."type" in ('remake','reship','cancellation_compensation')),
	CONSTRAINT "production_recovery_cases_status_check" CHECK ("production_recovery_cases"."status" in ('open','in_progress','resolved','cancelled')),
	CONSTRAINT "production_recovery_cases_version_check" CHECK ("production_recovery_cases"."projection_version" > 0),
	CONSTRAINT "production_recovery_cases_checksum_check" CHECK ("production_recovery_cases"."reason_checksum" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "production_recovery_cases_compensation_check" CHECK (("production_recovery_cases"."type" = 'cancellation_compensation' and "production_recovery_cases"."compensation_amount_minor" is not null and "production_recovery_cases"."compensation_currency" ~ '^[A-Z]{3}$') or ("production_recovery_cases"."type" <> 'cancellation_compensation' and "production_recovery_cases"."compensation_amount_minor" is null and "production_recovery_cases"."compensation_currency" is null))
);
--> statement-breakpoint
CREATE TABLE "quality_defects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"production_order_id" uuid NOT NULL,
	"inspection_id" uuid NOT NULL,
	"code" text NOT NULL,
	"severity" text NOT NULL,
	"responsibility" text NOT NULL,
	"disposition" text NOT NULL,
	"encrypted_detail" text NOT NULL,
	"detail_checksum" text NOT NULL,
	"evidence_asset_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quality_defects_id_uuidv7_check" CHECK (substring("quality_defects"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "quality_defects_severity_check" CHECK ("quality_defects"."severity" in ('minor','major','critical')),
	CONSTRAINT "quality_defects_responsibility_check" CHECK ("quality_defects"."responsibility" in ('supplier','internal','carrier','customer','unknown')),
	CONSTRAINT "quality_defects_disposition_check" CHECK ("quality_defects"."disposition" in ('accept','rework','remake','reship','refund','cancel')),
	CONSTRAINT "quality_defects_checksum_check" CHECK ("quality_defects"."detail_checksum" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "quality_inspections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"production_order_id" uuid NOT NULL,
	"quality_standard_version_id" uuid NOT NULL,
	"result" text NOT NULL,
	"score_bps" integer NOT NULL,
	"evidence_asset_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"inspected_by" uuid,
	"inspected_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quality_inspections_id_uuidv7_check" CHECK (substring("quality_inspections"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "quality_inspections_result_check" CHECK ("quality_inspections"."result" in ('passed','failed')),
	CONSTRAINT "quality_inspections_score_check" CHECK ("quality_inspections"."score_bps" between 0 and 10000)
);
--> statement-breakpoint
CREATE TABLE "quality_standard_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"version_number" integer NOT NULL,
	"sku_id" uuid,
	"supplier_id" uuid,
	"minimum_score_bps" integer NOT NULL,
	"criteria" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quality_standard_versions_id_uuidv7_check" CHECK (substring("quality_standard_versions"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "quality_standard_versions_version_check" CHECK ("quality_standard_versions"."version_number" > 0),
	CONSTRAINT "quality_standard_versions_score_check" CHECK ("quality_standard_versions"."minimum_score_bps" between 0 and 10000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "production_milestone_events_tenant_id_unique" ON "production_milestone_events" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "production_order_versions_tenant_id_unique" ON "production_order_versions" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "production_orders_tenant_id_unique" ON "production_orders" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "production_recovery_cases_tenant_id_unique" ON "production_recovery_cases" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "quality_defects_tenant_id_unique" ON "quality_defects" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "quality_inspections_tenant_id_unique" ON "quality_inspections" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "quality_standard_versions_tenant_id_unique" ON "quality_standard_versions" USING btree ("tenant_id","id");--> statement-breakpoint
ALTER TABLE "production_milestone_events" ADD CONSTRAINT "production_milestone_events_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_milestone_events" ADD CONSTRAINT "production_milestone_events_actor_user_id_app_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_milestone_events" ADD CONSTRAINT "production_milestone_events_order_fk" FOREIGN KEY ("tenant_id","production_order_id") REFERENCES "public"."production_orders"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_order_versions" ADD CONSTRAINT "production_order_versions_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_order_versions" ADD CONSTRAINT "production_order_versions_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_order_versions" ADD CONSTRAINT "production_order_versions_order_fk" FOREIGN KEY ("tenant_id","production_order_id") REFERENCES "public"."production_orders"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_order_versions" ADD CONSTRAINT "production_order_versions_design_fk" FOREIGN KEY ("tenant_id","design_version_id") REFERENCES "public"."design_versions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_line_fk" FOREIGN KEY ("tenant_id","order_line_id") REFERENCES "public"."order_lines"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_supplier_fk" FOREIGN KEY ("tenant_id","supplier_id") REFERENCES "public"."fulfillment_suppliers"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_routing_fk" FOREIGN KEY ("tenant_id","routing_decision_id") REFERENCES "public"."order_routing_decisions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_purchase_version_fk" FOREIGN KEY ("tenant_id","purchase_order_version_id") REFERENCES "public"."purchase_order_versions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_parent_fk" FOREIGN KEY ("tenant_id","parent_production_order_id") REFERENCES "public"."production_orders"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_recovery_cases" ADD CONSTRAINT "production_recovery_cases_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_recovery_cases" ADD CONSTRAINT "production_recovery_cases_opened_by_app_users_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_recovery_cases" ADD CONSTRAINT "production_recovery_cases_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_recovery_cases" ADD CONSTRAINT "production_recovery_cases_production_fk" FOREIGN KEY ("tenant_id","original_production_order_id") REFERENCES "public"."production_orders"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_recovery_cases" ADD CONSTRAINT "production_recovery_cases_defect_fk" FOREIGN KEY ("tenant_id","defect_id") REFERENCES "public"."quality_defects"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_defects" ADD CONSTRAINT "quality_defects_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_defects" ADD CONSTRAINT "quality_defects_order_fk" FOREIGN KEY ("tenant_id","production_order_id") REFERENCES "public"."production_orders"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_defects" ADD CONSTRAINT "quality_defects_inspection_fk" FOREIGN KEY ("tenant_id","inspection_id") REFERENCES "public"."quality_inspections"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_inspections" ADD CONSTRAINT "quality_inspections_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_inspections" ADD CONSTRAINT "quality_inspections_inspected_by_app_users_id_fk" FOREIGN KEY ("inspected_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_inspections" ADD CONSTRAINT "quality_inspections_order_fk" FOREIGN KEY ("tenant_id","production_order_id") REFERENCES "public"."production_orders"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_inspections" ADD CONSTRAINT "quality_inspections_standard_fk" FOREIGN KEY ("tenant_id","quality_standard_version_id") REFERENCES "public"."quality_standard_versions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_standard_versions" ADD CONSTRAINT "quality_standard_versions_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_standard_versions" ADD CONSTRAINT "quality_standard_versions_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_standard_versions" ADD CONSTRAINT "quality_standard_versions_sku_fk" FOREIGN KEY ("tenant_id","sku_id") REFERENCES "public"."skus"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_standard_versions" ADD CONSTRAINT "quality_standard_versions_supplier_fk" FOREIGN KEY ("tenant_id","supplier_id") REFERENCES "public"."fulfillment_suppliers"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "production_milestone_events_sequence_unique" ON "production_milestone_events" USING btree ("tenant_id","production_order_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "production_milestone_events_external_unique" ON "production_milestone_events" USING btree ("tenant_id","production_order_id","external_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "production_order_versions_number_unique" ON "production_order_versions" USING btree ("tenant_id","production_order_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "production_orders_idempotency_unique" ON "production_orders" USING btree ("tenant_id","order_line_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "production_orders_queue_idx" ON "production_orders" USING btree ("tenant_id","status","expected_completion_at");--> statement-breakpoint
CREATE INDEX "production_orders_lineage_idx" ON "production_orders" USING btree ("tenant_id","parent_production_order_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "production_recovery_cases_idempotency_unique" ON "production_recovery_cases" USING btree ("tenant_id","original_production_order_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "production_recovery_cases_queue_idx" ON "production_recovery_cases" USING btree ("tenant_id","status","type","updated_at");--> statement-breakpoint
CREATE INDEX "quality_defects_responsibility_idx" ON "quality_defects" USING btree ("tenant_id","responsibility","severity","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "quality_inspections_idempotency_unique" ON "quality_inspections" USING btree ("tenant_id","production_order_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "quality_inspections_result_idx" ON "quality_inspections" USING btree ("tenant_id","result","inspected_at");--> statement-breakpoint
CREATE UNIQUE INDEX "quality_standard_versions_name_version_unique" ON "quality_standard_versions" USING btree ("tenant_id","name","version_number");--> statement-breakpoint
CREATE INDEX "quality_standard_versions_scope_idx" ON "quality_standard_versions" USING btree ("tenant_id","sku_id","supplier_id","created_at");
--> statement-breakpoint
ALTER TABLE "production_orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "production_orders" FORCE ROW LEVEL SECURITY;
CREATE POLICY "production_orders_tenant_policy" ON "production_orders" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT, UPDATE ON "production_orders" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "production_order_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "production_order_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "production_order_versions_tenant_policy" ON "production_order_versions" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "production_order_versions" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "production_milestone_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "production_milestone_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "production_milestone_events_tenant_policy" ON "production_milestone_events" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "production_milestone_events" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "quality_standard_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "quality_standard_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "quality_standard_versions_tenant_policy" ON "quality_standard_versions" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "quality_standard_versions" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "quality_inspections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "quality_inspections" FORCE ROW LEVEL SECURITY;
CREATE POLICY "quality_inspections_tenant_policy" ON "quality_inspections" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "quality_inspections" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "quality_defects" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "quality_defects" FORCE ROW LEVEL SECURITY;
CREATE POLICY "quality_defects_tenant_policy" ON "quality_defects" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "quality_defects" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "production_recovery_cases" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "production_recovery_cases" FORCE ROW LEVEL SECURITY;
CREATE POLICY "production_recovery_cases_tenant_policy" ON "production_recovery_cases" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT, UPDATE ON "production_recovery_cases" TO yummyai_app;
