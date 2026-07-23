CREATE TABLE "fulfillment_suppliers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"region_code" text NOT NULL,
	"settlement_currency" text NOT NULL,
	"external_connection_ref" text,
	"priority" integer DEFAULT 3 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fulfillment_suppliers_id_uuidv7_check" CHECK (substring("fulfillment_suppliers"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "fulfillment_suppliers_kind_check" CHECK ("fulfillment_suppliers"."kind" in ('manual','printify','printful')),
	CONSTRAINT "fulfillment_suppliers_status_check" CHECK ("fulfillment_suppliers"."status" in ('active','suspended','archived')),
	CONSTRAINT "fulfillment_suppliers_currency_check" CHECK ("fulfillment_suppliers"."settlement_currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "fulfillment_suppliers_priority_check" CHECK ("fulfillment_suppliers"."priority" between 1 and 5)
);
--> statement-breakpoint
CREATE TABLE "order_routing_decision_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"routing_decision_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"type" text NOT NULL,
	"supplier_id" uuid,
	"reason_code" text,
	"reason" text,
	"actor_user_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_routing_decision_events_id_uuidv7_check" CHECK (substring("order_routing_decision_events"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "order_routing_decision_events_sequence_check" CHECK ("order_routing_decision_events"."sequence" > 0),
	CONSTRAINT "order_routing_decision_events_type_check" CHECK ("order_routing_decision_events"."type" in ('evaluated','approved','rejected','overridden')),
	CONSTRAINT "order_routing_decision_events_override_reason_check" CHECK ("order_routing_decision_events"."type" <> 'overridden' or ("order_routing_decision_events"."supplier_id" is not null and "order_routing_decision_events"."reason_code" is not null and "order_routing_decision_events"."reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "order_routing_decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"order_line_id" uuid NOT NULL,
	"routing_policy_version_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"decision_version" integer DEFAULT 1 NOT NULL,
	"status" text NOT NULL,
	"selected_supplier_id" uuid,
	"input_checksum" text NOT NULL,
	"requires_approval" boolean NOT NULL,
	"approval_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"selected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_routing_decisions_id_uuidv7_check" CHECK (substring("order_routing_decisions"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "order_routing_decisions_version_check" CHECK ("order_routing_decisions"."version_number" > 0 and "order_routing_decisions"."decision_version" > 0),
	CONSTRAINT "order_routing_decisions_status_check" CHECK ("order_routing_decisions"."status" in ('no_eligible_supplier','pending_approval','approved','rejected')),
	CONSTRAINT "order_routing_decisions_checksum_check" CHECK ("order_routing_decisions"."input_checksum" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "order_routing_decisions_selection_check" CHECK (("order_routing_decisions"."status" = 'no_eligible_supplier' and "order_routing_decisions"."selected_supplier_id" is null) or ("order_routing_decisions"."status" <> 'no_eligible_supplier' and "order_routing_decisions"."selected_supplier_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "production_order_candidates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"routing_decision_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"quote_id" uuid NOT NULL,
	"capability_snapshot_id" uuid NOT NULL,
	"capacity_window_id" uuid NOT NULL,
	"rank" integer NOT NULL,
	"eligible" boolean NOT NULL,
	"exclusion_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scores" jsonb NOT NULL,
	"unit_cost_minor" bigint NOT NULL,
	"lead_time_days" integer NOT NULL,
	"available_units" integer NOT NULL,
	"quality_score_bps" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "production_order_candidates_id_uuidv7_check" CHECK (substring("production_order_candidates"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "production_order_candidates_rank_check" CHECK ("production_order_candidates"."rank" > 0),
	CONSTRAINT "production_order_candidates_metrics_check" CHECK ("production_order_candidates"."unit_cost_minor" >= 0 and "production_order_candidates"."lead_time_days" >= 0 and "production_order_candidates"."available_units" >= 0 and "production_order_candidates"."quality_score_bps" between 0 and 10000)
);
--> statement-breakpoint
CREATE TABLE "purchase_order_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"currency" text NOT NULL,
	"total_minor" bigint NOT NULL,
	"line_snapshot" jsonb NOT NULL,
	"routing_decision_ids" jsonb NOT NULL,
	"checksum" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_order_versions_id_uuidv7_check" CHECK (substring("purchase_order_versions"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "purchase_order_versions_version_check" CHECK ("purchase_order_versions"."version_number" > 0),
	CONSTRAINT "purchase_order_versions_currency_check" CHECK ("purchase_order_versions"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "purchase_order_versions_total_check" CHECK ("purchase_order_versions"."total_minor" >= 0),
	CONSTRAINT "purchase_order_versions_checksum_check" CHECK ("purchase_order_versions"."checksum" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"current_version_number" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_orders_id_uuidv7_check" CHECK (substring("purchase_orders"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "purchase_orders_status_check" CHECK ("purchase_orders"."status" in ('draft','pending_approval','approved','submitted','acknowledged','reconciliation_required','cancelled')),
	CONSTRAINT "purchase_orders_version_check" CHECK ("purchase_orders"."current_version_number" > 0)
);
--> statement-breakpoint
CREATE TABLE "routing_policy_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"version_number" integer NOT NULL,
	"weights" jsonb NOT NULL,
	"thresholds" jsonb NOT NULL,
	"tie_breaker" jsonb NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "routing_policy_versions_id_uuidv7_check" CHECK (substring("routing_policy_versions"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "routing_policy_versions_version_check" CHECK ("routing_policy_versions"."version_number" > 0)
);
--> statement-breakpoint
CREATE TABLE "supplier_capability_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"supported_sku_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"process_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"service_country_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"blocked_region_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"quality_score_bps" integer NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"source_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_capability_snapshots_id_uuidv7_check" CHECK (substring("supplier_capability_snapshots"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "supplier_capability_snapshots_version_check" CHECK ("supplier_capability_snapshots"."version_number" > 0),
	CONSTRAINT "supplier_capability_snapshots_quality_check" CHECK ("supplier_capability_snapshots"."quality_score_bps" between 0 and 10000)
);
--> statement-breakpoint
CREATE TABLE "supplier_capacity_windows" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"window_key" text NOT NULL,
	"version_number" integer NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"available_units" integer NOT NULL,
	"reserved_units" integer DEFAULT 0 NOT NULL,
	"source_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_capacity_windows_id_uuidv7_check" CHECK (substring("supplier_capacity_windows"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "supplier_capacity_windows_version_check" CHECK ("supplier_capacity_windows"."version_number" > 0),
	CONSTRAINT "supplier_capacity_windows_range_check" CHECK ("supplier_capacity_windows"."ends_at" > "supplier_capacity_windows"."starts_at"),
	CONSTRAINT "supplier_capacity_windows_units_check" CHECK ("supplier_capacity_windows"."available_units" >= 0 and "supplier_capacity_windows"."reserved_units" between 0 and "supplier_capacity_windows"."available_units")
);
--> statement-breakpoint
CREATE TABLE "supplier_quotes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"unit_cost_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"minimum_order_quantity" integer DEFAULT 1 NOT NULL,
	"lead_time_days" integer NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"external_quote_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_quotes_id_uuidv7_check" CHECK (substring("supplier_quotes"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "supplier_quotes_version_check" CHECK ("supplier_quotes"."version_number" > 0),
	CONSTRAINT "supplier_quotes_cost_check" CHECK ("supplier_quotes"."unit_cost_minor" >= 0),
	CONSTRAINT "supplier_quotes_currency_check" CHECK ("supplier_quotes"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "supplier_quotes_moq_check" CHECK ("supplier_quotes"."minimum_order_quantity" > 0),
	CONSTRAINT "supplier_quotes_lead_time_check" CHECK ("supplier_quotes"."lead_time_days" >= 0),
	CONSTRAINT "supplier_quotes_validity_check" CHECK ("supplier_quotes"."valid_until" > "supplier_quotes"."valid_from")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "fulfillment_suppliers_tenant_id_unique" ON "fulfillment_suppliers" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_routing_decision_events_tenant_id_unique" ON "order_routing_decision_events" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_routing_decisions_tenant_id_unique" ON "order_routing_decisions" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "production_order_candidates_tenant_id_unique" ON "production_order_candidates" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_order_versions_tenant_id_unique" ON "purchase_order_versions" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_orders_tenant_id_unique" ON "purchase_orders" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "routing_policy_versions_tenant_id_unique" ON "routing_policy_versions" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_capability_snapshots_tenant_id_unique" ON "supplier_capability_snapshots" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_capacity_windows_tenant_id_unique" ON "supplier_capacity_windows" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_quotes_tenant_id_unique" ON "supplier_quotes" USING btree ("tenant_id","id");--> statement-breakpoint
ALTER TABLE "fulfillment_suppliers" ADD CONSTRAINT "fulfillment_suppliers_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillment_suppliers" ADD CONSTRAINT "fulfillment_suppliers_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_routing_decision_events" ADD CONSTRAINT "order_routing_decision_events_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_routing_decision_events" ADD CONSTRAINT "order_routing_decision_events_actor_user_id_app_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_routing_decision_events" ADD CONSTRAINT "order_routing_decision_events_decision_fk" FOREIGN KEY ("tenant_id","routing_decision_id") REFERENCES "public"."order_routing_decisions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_routing_decision_events" ADD CONSTRAINT "order_routing_decision_events_supplier_fk" FOREIGN KEY ("tenant_id","supplier_id") REFERENCES "public"."fulfillment_suppliers"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_routing_decisions" ADD CONSTRAINT "order_routing_decisions_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_routing_decisions" ADD CONSTRAINT "order_routing_decisions_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_routing_decisions" ADD CONSTRAINT "order_routing_decisions_line_fk" FOREIGN KEY ("tenant_id","order_line_id") REFERENCES "public"."order_lines"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_routing_decisions" ADD CONSTRAINT "order_routing_decisions_policy_fk" FOREIGN KEY ("tenant_id","routing_policy_version_id") REFERENCES "public"."routing_policy_versions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_routing_decisions" ADD CONSTRAINT "order_routing_decisions_supplier_fk" FOREIGN KEY ("tenant_id","selected_supplier_id") REFERENCES "public"."fulfillment_suppliers"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_order_candidates" ADD CONSTRAINT "production_order_candidates_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_order_candidates" ADD CONSTRAINT "production_order_candidates_decision_fk" FOREIGN KEY ("tenant_id","routing_decision_id") REFERENCES "public"."order_routing_decisions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_order_candidates" ADD CONSTRAINT "production_order_candidates_supplier_fk" FOREIGN KEY ("tenant_id","supplier_id") REFERENCES "public"."fulfillment_suppliers"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_order_candidates" ADD CONSTRAINT "production_order_candidates_quote_fk" FOREIGN KEY ("tenant_id","quote_id") REFERENCES "public"."supplier_quotes"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_order_candidates" ADD CONSTRAINT "production_order_candidates_capability_fk" FOREIGN KEY ("tenant_id","capability_snapshot_id") REFERENCES "public"."supplier_capability_snapshots"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_order_candidates" ADD CONSTRAINT "production_order_candidates_capacity_fk" FOREIGN KEY ("tenant_id","capacity_window_id") REFERENCES "public"."supplier_capacity_windows"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_versions" ADD CONSTRAINT "purchase_order_versions_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_versions" ADD CONSTRAINT "purchase_order_versions_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_versions" ADD CONSTRAINT "purchase_order_versions_order_fk" FOREIGN KEY ("tenant_id","purchase_order_id") REFERENCES "public"."purchase_orders"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_supplier_fk" FOREIGN KEY ("tenant_id","supplier_id") REFERENCES "public"."fulfillment_suppliers"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_policy_versions" ADD CONSTRAINT "routing_policy_versions_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_policy_versions" ADD CONSTRAINT "routing_policy_versions_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_capability_snapshots" ADD CONSTRAINT "supplier_capability_snapshots_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_capability_snapshots" ADD CONSTRAINT "supplier_capability_snapshots_supplier_fk" FOREIGN KEY ("tenant_id","supplier_id") REFERENCES "public"."fulfillment_suppliers"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_capacity_windows" ADD CONSTRAINT "supplier_capacity_windows_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_capacity_windows" ADD CONSTRAINT "supplier_capacity_windows_supplier_fk" FOREIGN KEY ("tenant_id","supplier_id") REFERENCES "public"."fulfillment_suppliers"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_quotes" ADD CONSTRAINT "supplier_quotes_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_quotes" ADD CONSTRAINT "supplier_quotes_supplier_fk" FOREIGN KEY ("tenant_id","supplier_id") REFERENCES "public"."fulfillment_suppliers"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_quotes" ADD CONSTRAINT "supplier_quotes_sku_fk" FOREIGN KEY ("tenant_id","sku_id") REFERENCES "public"."skus"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fulfillment_suppliers_external_unique" ON "fulfillment_suppliers" USING btree ("tenant_id","kind","external_connection_ref");--> statement-breakpoint
CREATE INDEX "fulfillment_suppliers_status_idx" ON "fulfillment_suppliers" USING btree ("tenant_id","status","priority");--> statement-breakpoint
CREATE UNIQUE INDEX "order_routing_decision_events_sequence_unique" ON "order_routing_decision_events" USING btree ("tenant_id","routing_decision_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "order_routing_decisions_line_version_unique" ON "order_routing_decisions" USING btree ("tenant_id","order_line_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "order_routing_decisions_idempotency_unique" ON "order_routing_decisions" USING btree ("tenant_id","order_line_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "order_routing_decisions_status_idx" ON "order_routing_decisions" USING btree ("tenant_id","status","selected_at");--> statement-breakpoint
CREATE UNIQUE INDEX "production_order_candidates_rank_unique" ON "production_order_candidates" USING btree ("tenant_id","routing_decision_id","rank");--> statement-breakpoint
CREATE UNIQUE INDEX "production_order_candidates_supplier_unique" ON "production_order_candidates" USING btree ("tenant_id","routing_decision_id","supplier_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_order_versions_number_unique" ON "purchase_order_versions" USING btree ("tenant_id","purchase_order_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_orders_order_supplier_unique" ON "purchase_orders" USING btree ("tenant_id","order_id","supplier_id");--> statement-breakpoint
CREATE INDEX "purchase_orders_status_idx" ON "purchase_orders" USING btree ("tenant_id","status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "routing_policy_versions_name_version_unique" ON "routing_policy_versions" USING btree ("tenant_id","name","version_number");--> statement-breakpoint
CREATE INDEX "routing_policy_versions_active_idx" ON "routing_policy_versions" USING btree ("tenant_id","active","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_capability_snapshots_version_unique" ON "supplier_capability_snapshots" USING btree ("tenant_id","supplier_id","version_number");--> statement-breakpoint
CREATE INDEX "supplier_capability_snapshots_effective_idx" ON "supplier_capability_snapshots" USING btree ("tenant_id","supplier_id","effective_at");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_capacity_windows_version_unique" ON "supplier_capacity_windows" USING btree ("tenant_id","supplier_id","window_key","version_number");--> statement-breakpoint
CREATE INDEX "supplier_capacity_windows_lookup_idx" ON "supplier_capacity_windows" USING btree ("tenant_id","supplier_id","starts_at","ends_at");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_quotes_version_unique" ON "supplier_quotes" USING btree ("tenant_id","supplier_id","sku_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_quotes_external_unique" ON "supplier_quotes" USING btree ("tenant_id","supplier_id","external_quote_id");--> statement-breakpoint
CREATE INDEX "supplier_quotes_lookup_idx" ON "supplier_quotes" USING btree ("tenant_id","sku_id","valid_from","valid_until");
--> statement-breakpoint
ALTER TABLE "fulfillment_suppliers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "fulfillment_suppliers" FORCE ROW LEVEL SECURITY;
CREATE POLICY "fulfillment_suppliers_tenant_policy" ON "fulfillment_suppliers" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT, UPDATE ON "fulfillment_suppliers" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "supplier_capability_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "supplier_capability_snapshots" FORCE ROW LEVEL SECURITY;
CREATE POLICY "supplier_capability_snapshots_tenant_policy" ON "supplier_capability_snapshots" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "supplier_capability_snapshots" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "supplier_quotes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "supplier_quotes" FORCE ROW LEVEL SECURITY;
CREATE POLICY "supplier_quotes_tenant_policy" ON "supplier_quotes" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "supplier_quotes" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "supplier_capacity_windows" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "supplier_capacity_windows" FORCE ROW LEVEL SECURITY;
CREATE POLICY "supplier_capacity_windows_tenant_policy" ON "supplier_capacity_windows" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "supplier_capacity_windows" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "routing_policy_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "routing_policy_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "routing_policy_versions_tenant_policy" ON "routing_policy_versions" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "routing_policy_versions" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "order_routing_decisions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_routing_decisions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "order_routing_decisions_tenant_policy" ON "order_routing_decisions" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT, UPDATE ON "order_routing_decisions" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "production_order_candidates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "production_order_candidates" FORCE ROW LEVEL SECURITY;
CREATE POLICY "production_order_candidates_tenant_policy" ON "production_order_candidates" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "production_order_candidates" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "order_routing_decision_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_routing_decision_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "order_routing_decision_events_tenant_policy" ON "order_routing_decision_events" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "order_routing_decision_events" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "purchase_orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "purchase_orders" FORCE ROW LEVEL SECURITY;
CREATE POLICY "purchase_orders_tenant_policy" ON "purchase_orders" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT, UPDATE ON "purchase_orders" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "purchase_order_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "purchase_order_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "purchase_order_versions_tenant_policy" ON "purchase_order_versions" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "purchase_order_versions" TO yummyai_app;
