CREATE TABLE "channel_allocation_policies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"stock_item_id" uuid NOT NULL,
	"name" text NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_allocation_policies_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "channel_allocation_policies_id_check" CHECK (substring("channel_allocation_policies"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "channel_allocation_policies_version_check" CHECK ("channel_allocation_policies"."current_version" > 0),
	CONSTRAINT "channel_allocation_policies_status_check" CHECK ("channel_allocation_policies"."status" in ('active','inactive'))
);
--> statement-breakpoint
CREATE TABLE "channel_allocation_policy_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"eligible_sources" jsonb NOT NULL,
	"allow_virtual" boolean DEFAULT false NOT NULL,
	"safety_buffer_quantity" integer DEFAULT 0 NOT NULL,
	"channels" jsonb NOT NULL,
	"reason_code" text NOT NULL,
	"checksum" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_allocation_policy_versions_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "channel_allocation_policy_versions_id_check" CHECK (substring("channel_allocation_policy_versions"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "channel_allocation_policy_versions_number_check" CHECK ("channel_allocation_policy_versions"."version_number" > 0),
	CONSTRAINT "channel_allocation_policy_versions_buffer_check" CHECK ("channel_allocation_policy_versions"."safety_buffer_quantity" >= 0),
	CONSTRAINT "channel_allocation_policy_versions_checksum_check" CHECK ("channel_allocation_policy_versions"."checksum" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "channel_allocation_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"policy_version_id" uuid NOT NULL,
	"stock_item_id" uuid NOT NULL,
	"eligible_quantity" integer NOT NULL,
	"allocatable_quantity" integer NOT NULL,
	"allocated_quantity" integer NOT NULL,
	"unit" text NOT NULL,
	"input_checksum" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"calculated_by" uuid,
	"calculated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_allocation_runs_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "channel_allocation_runs_id_check" CHECK (substring("channel_allocation_runs"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "channel_allocation_runs_quantity_check" CHECK ("channel_allocation_runs"."eligible_quantity" >= 0 and "channel_allocation_runs"."allocatable_quantity" >= 0 and "channel_allocation_runs"."allocated_quantity" >= 0 and "channel_allocation_runs"."allocatable_quantity" <= "channel_allocation_runs"."eligible_quantity" and "channel_allocation_runs"."allocated_quantity" <= "channel_allocation_runs"."allocatable_quantity"),
	CONSTRAINT "channel_allocation_runs_unit_check" CHECK ("channel_allocation_runs"."unit" in ('each','pair','set','meter','gram','kilogram')),
	CONSTRAINT "channel_allocation_runs_checksum_check" CHECK ("channel_allocation_runs"."input_checksum" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "channel_availability_projections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"stock_item_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"marketplace_id" text NOT NULL,
	"listing_id" uuid,
	"priority" integer NOT NULL,
	"cap_quantity" integer,
	"buffer_quantity" integer DEFAULT 0 NOT NULL,
	"allocated_quantity" integer NOT NULL,
	"unit" text NOT NULL,
	"source_trace" jsonb NOT NULL,
	"calculated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_availability_projections_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "channel_availability_projections_id_check" CHECK (substring("channel_availability_projections"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "channel_availability_projections_platform_check" CHECK ("channel_availability_projections"."platform" in ('amazon','etsy')),
	CONSTRAINT "channel_availability_projections_quantity_check" CHECK ("channel_availability_projections"."priority" > 0 and "channel_availability_projections"."buffer_quantity" >= 0 and "channel_availability_projections"."allocated_quantity" >= 0 and ("channel_availability_projections"."cap_quantity" is null or "channel_availability_projections"."cap_quantity" >= 0)),
	CONSTRAINT "channel_availability_projections_unit_check" CHECK ("channel_availability_projections"."unit" in ('each','pair','set','meter','gram','kilogram'))
);
--> statement-breakpoint
CREATE TABLE "channel_mutation_reconciliation_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"reconciliation_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"status" text NOT NULL,
	"reason_code" text NOT NULL,
	"message" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"actor_user_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_mutation_reconciliation_events_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "channel_mutation_reconciliation_events_id_check" CHECK (substring("channel_mutation_reconciliation_events"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "channel_mutation_reconciliation_events_sequence_check" CHECK ("channel_mutation_reconciliation_events"."sequence" > 0),
	CONSTRAINT "channel_mutation_reconciliation_events_status_check" CHECK ("channel_mutation_reconciliation_events"."status" in ('open','confirmed','rejected'))
);
--> statement-breakpoint
CREATE TABLE "channel_mutation_reconciliations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"listing_id" uuid,
	"sync_request_id" uuid,
	"mutation_key" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_mutation_reconciliations_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "channel_mutation_reconciliations_id_check" CHECK (substring("channel_mutation_reconciliations"."id"::text from 15 for 1) = '7')
);
--> statement-breakpoint
CREATE TABLE "network_inventory_connector_checkpoints" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"account_id" uuid,
	"provider" text NOT NULL,
	"scope_key" text NOT NULL,
	"sequence" integer NOT NULL,
	"cursor" text,
	"observed_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "network_inventory_connector_checkpoints_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "network_inventory_connector_checkpoints_id_check" CHECK (substring("network_inventory_connector_checkpoints"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "network_inventory_connector_checkpoints_provider_check" CHECK ("network_inventory_connector_checkpoints"."provider" in ('internal','amazon','etsy','third_party','supplier')),
	CONSTRAINT "network_inventory_connector_checkpoints_sequence_check" CHECK ("network_inventory_connector_checkpoints"."sequence" > 0)
);
--> statement-breakpoint
CREATE TABLE "network_inventory_snapshot_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"stock_item_id" uuid NOT NULL,
	"warehouse_id" uuid,
	"location_id" uuid,
	"external_sku" text,
	"source" text NOT NULL,
	"condition" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit" text NOT NULL,
	CONSTRAINT "network_inventory_snapshot_lines_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "network_inventory_snapshot_lines_id_check" CHECK (substring("network_inventory_snapshot_lines"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "network_inventory_snapshot_lines_number_check" CHECK ("network_inventory_snapshot_lines"."line_number" > 0),
	CONSTRAINT "network_inventory_snapshot_lines_source_check" CHECK ("network_inventory_snapshot_lines"."source" in ('owned','fba','fbm','overseas_3pl','supplier','in_transit','virtual')),
	CONSTRAINT "network_inventory_snapshot_lines_condition_check" CHECK ("network_inventory_snapshot_lines"."condition" in ('sellable','quarantine','damaged')),
	CONSTRAINT "network_inventory_snapshot_lines_quantity_check" CHECK ("network_inventory_snapshot_lines"."quantity" >= 0),
	CONSTRAINT "network_inventory_snapshot_lines_unit_check" CHECK ("network_inventory_snapshot_lines"."unit" in ('each','pair','set','meter','gram','kilogram'))
);
--> statement-breakpoint
CREATE TABLE "network_inventory_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"account_id" uuid,
	"provider" text NOT NULL,
	"scope_key" text NOT NULL,
	"provider_snapshot_id" text,
	"observed_at" timestamp with time zone NOT NULL,
	"checksum" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"recorded_by" uuid,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "network_inventory_snapshots_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "network_inventory_snapshots_id_check" CHECK (substring("network_inventory_snapshots"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "network_inventory_snapshots_provider_check" CHECK ("network_inventory_snapshots"."provider" in ('internal','amazon','etsy','third_party','supplier')),
	CONSTRAINT "network_inventory_snapshots_checksum_check" CHECK ("network_inventory_snapshots"."checksum" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "channel_allocation_policies" ADD CONSTRAINT "channel_allocation_policies_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_allocation_policies" ADD CONSTRAINT "channel_allocation_policies_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_allocation_policies" ADD CONSTRAINT "channel_allocation_policies_stock_fk" FOREIGN KEY ("tenant_id","stock_item_id") REFERENCES "public"."inventory_stock_items"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_allocation_policy_versions" ADD CONSTRAINT "channel_allocation_policy_versions_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_allocation_policy_versions" ADD CONSTRAINT "channel_allocation_policy_versions_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_allocation_policy_versions" ADD CONSTRAINT "channel_allocation_policy_versions_policy_fk" FOREIGN KEY ("tenant_id","policy_id") REFERENCES "public"."channel_allocation_policies"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_allocation_runs" ADD CONSTRAINT "channel_allocation_runs_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_allocation_runs" ADD CONSTRAINT "channel_allocation_runs_calculated_by_app_users_id_fk" FOREIGN KEY ("calculated_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_allocation_runs" ADD CONSTRAINT "channel_allocation_runs_policy_fk" FOREIGN KEY ("tenant_id","policy_id") REFERENCES "public"."channel_allocation_policies"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_allocation_runs" ADD CONSTRAINT "channel_allocation_runs_policy_version_fk" FOREIGN KEY ("tenant_id","policy_version_id") REFERENCES "public"."channel_allocation_policy_versions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_allocation_runs" ADD CONSTRAINT "channel_allocation_runs_stock_fk" FOREIGN KEY ("tenant_id","stock_item_id") REFERENCES "public"."inventory_stock_items"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_availability_projections" ADD CONSTRAINT "channel_availability_projections_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_availability_projections" ADD CONSTRAINT "channel_availability_projections_run_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."channel_allocation_runs"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_availability_projections" ADD CONSTRAINT "channel_availability_projections_stock_fk" FOREIGN KEY ("tenant_id","stock_item_id") REFERENCES "public"."inventory_stock_items"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_availability_projections" ADD CONSTRAINT "channel_availability_projections_account_fk" FOREIGN KEY ("tenant_id","account_id") REFERENCES "public"."marketplace_accounts"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_availability_projections" ADD CONSTRAINT "channel_availability_projections_listing_fk" FOREIGN KEY ("tenant_id","listing_id") REFERENCES "public"."listings"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_mutation_reconciliation_events" ADD CONSTRAINT "channel_mutation_reconciliation_events_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_mutation_reconciliation_events" ADD CONSTRAINT "channel_mutation_reconciliation_events_actor_user_id_app_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_mutation_reconciliation_events" ADD CONSTRAINT "channel_mutation_reconciliation_events_reconciliation_fk" FOREIGN KEY ("tenant_id","reconciliation_id") REFERENCES "public"."channel_mutation_reconciliations"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_mutation_reconciliations" ADD CONSTRAINT "channel_mutation_reconciliations_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_mutation_reconciliations" ADD CONSTRAINT "channel_mutation_reconciliations_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_mutation_reconciliations" ADD CONSTRAINT "channel_mutation_reconciliations_account_fk" FOREIGN KEY ("tenant_id","account_id") REFERENCES "public"."marketplace_accounts"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_mutation_reconciliations" ADD CONSTRAINT "channel_mutation_reconciliations_listing_fk" FOREIGN KEY ("tenant_id","listing_id") REFERENCES "public"."listings"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_mutation_reconciliations" ADD CONSTRAINT "channel_mutation_reconciliations_sync_fk" FOREIGN KEY ("tenant_id","sync_request_id") REFERENCES "public"."marketplace_listing_sync_requests"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_inventory_connector_checkpoints" ADD CONSTRAINT "network_inventory_connector_checkpoints_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_inventory_connector_checkpoints" ADD CONSTRAINT "network_inventory_connector_checkpoints_snapshot_fk" FOREIGN KEY ("tenant_id","snapshot_id") REFERENCES "public"."network_inventory_snapshots"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_inventory_connector_checkpoints" ADD CONSTRAINT "network_inventory_connector_checkpoints_account_fk" FOREIGN KEY ("tenant_id","account_id") REFERENCES "public"."marketplace_accounts"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_inventory_snapshot_lines" ADD CONSTRAINT "network_inventory_snapshot_lines_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_inventory_snapshot_lines" ADD CONSTRAINT "network_inventory_snapshot_lines_snapshot_fk" FOREIGN KEY ("tenant_id","snapshot_id") REFERENCES "public"."network_inventory_snapshots"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_inventory_snapshot_lines" ADD CONSTRAINT "network_inventory_snapshot_lines_stock_fk" FOREIGN KEY ("tenant_id","stock_item_id") REFERENCES "public"."inventory_stock_items"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_inventory_snapshot_lines" ADD CONSTRAINT "network_inventory_snapshot_lines_warehouse_fk" FOREIGN KEY ("tenant_id","warehouse_id") REFERENCES "public"."inventory_warehouses"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_inventory_snapshot_lines" ADD CONSTRAINT "network_inventory_snapshot_lines_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."inventory_locations"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_inventory_snapshots" ADD CONSTRAINT "network_inventory_snapshots_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_inventory_snapshots" ADD CONSTRAINT "network_inventory_snapshots_recorded_by_app_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_inventory_snapshots" ADD CONSTRAINT "network_inventory_snapshots_account_fk" FOREIGN KEY ("tenant_id","account_id") REFERENCES "public"."marketplace_accounts"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_allocation_policies_stock_unique" ON "channel_allocation_policies" USING btree ("tenant_id","stock_item_id");--> statement-breakpoint
CREATE INDEX "channel_allocation_policies_status_idx" ON "channel_allocation_policies" USING btree ("tenant_id","status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_allocation_policy_versions_number_unique" ON "channel_allocation_policy_versions" USING btree ("tenant_id","policy_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_allocation_policy_versions_idempotency_unique" ON "channel_allocation_policy_versions" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_allocation_runs_idempotency_unique" ON "channel_allocation_runs" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "channel_allocation_runs_policy_idx" ON "channel_allocation_runs" USING btree ("tenant_id","policy_id","calculated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_availability_projections_target_unique" ON "channel_availability_projections" USING btree ("tenant_id","run_id","account_id","marketplace_id","listing_id");--> statement-breakpoint
CREATE INDEX "channel_availability_projections_target_idx" ON "channel_availability_projections" USING btree ("tenant_id","account_id","marketplace_id","listing_id","calculated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_mutation_reconciliation_events_sequence_unique" ON "channel_mutation_reconciliation_events" USING btree ("tenant_id","reconciliation_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_mutation_reconciliation_events_idempotency_unique" ON "channel_mutation_reconciliation_events" USING btree ("tenant_id","reconciliation_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_mutation_reconciliations_idempotency_unique" ON "channel_mutation_reconciliations" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "channel_mutation_reconciliations_account_idx" ON "channel_mutation_reconciliations" USING btree ("tenant_id","account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "network_inventory_connector_checkpoints_snapshot_unique" ON "network_inventory_connector_checkpoints" USING btree ("tenant_id","snapshot_id");--> statement-breakpoint
CREATE UNIQUE INDEX "network_inventory_connector_checkpoints_sequence_unique" ON "network_inventory_connector_checkpoints" USING btree ("tenant_id","provider","scope_key","sequence");--> statement-breakpoint
CREATE INDEX "network_inventory_connector_checkpoints_latest_idx" ON "network_inventory_connector_checkpoints" USING btree ("tenant_id","provider","scope_key","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "network_inventory_snapshot_lines_number_unique" ON "network_inventory_snapshot_lines" USING btree ("tenant_id","snapshot_id","line_number");--> statement-breakpoint
CREATE INDEX "network_inventory_snapshot_lines_stock_idx" ON "network_inventory_snapshot_lines" USING btree ("tenant_id","stock_item_id","source","condition");--> statement-breakpoint
CREATE UNIQUE INDEX "network_inventory_snapshots_idempotency_unique" ON "network_inventory_snapshots" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "network_inventory_snapshots_scope_idx" ON "network_inventory_snapshots" USING btree ("tenant_id","provider","scope_key","observed_at");
--> statement-breakpoint
ALTER TABLE "network_inventory_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "network_inventory_snapshots" FORCE ROW LEVEL SECURITY;
CREATE POLICY "network_inventory_snapshots_tenant_policy" ON "network_inventory_snapshots" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "network_inventory_snapshots" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "network_inventory_snapshot_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "network_inventory_snapshot_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY "network_inventory_snapshot_lines_tenant_policy" ON "network_inventory_snapshot_lines" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "network_inventory_snapshot_lines" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "network_inventory_connector_checkpoints" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "network_inventory_connector_checkpoints" FORCE ROW LEVEL SECURITY;
CREATE POLICY "network_inventory_connector_checkpoints_tenant_policy" ON "network_inventory_connector_checkpoints" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "network_inventory_connector_checkpoints" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "channel_allocation_policies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "channel_allocation_policies" FORCE ROW LEVEL SECURITY;
CREATE POLICY "channel_allocation_policies_tenant_policy" ON "channel_allocation_policies" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT, UPDATE ON "channel_allocation_policies" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "channel_allocation_policy_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "channel_allocation_policy_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "channel_allocation_policy_versions_tenant_policy" ON "channel_allocation_policy_versions" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "channel_allocation_policy_versions" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "channel_allocation_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "channel_allocation_runs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "channel_allocation_runs_tenant_policy" ON "channel_allocation_runs" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "channel_allocation_runs" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "channel_availability_projections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "channel_availability_projections" FORCE ROW LEVEL SECURITY;
CREATE POLICY "channel_availability_projections_tenant_policy" ON "channel_availability_projections" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "channel_availability_projections" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "channel_mutation_reconciliations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "channel_mutation_reconciliations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "channel_mutation_reconciliations_tenant_policy" ON "channel_mutation_reconciliations" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "channel_mutation_reconciliations" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "channel_mutation_reconciliation_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "channel_mutation_reconciliation_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "channel_mutation_reconciliation_events_tenant_policy" ON "channel_mutation_reconciliation_events" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "channel_mutation_reconciliation_events" TO yummyai_app;
