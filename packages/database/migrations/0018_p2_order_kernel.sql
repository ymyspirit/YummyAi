CREATE TABLE "order_connector_checkpoints" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"stream" text NOT NULL,
	"cursor" text,
	"high_water_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_connector_checkpoints_id_uuidv7_check" CHECK (substring("order_connector_checkpoints"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "order_connector_checkpoints_platform_check" CHECK ("order_connector_checkpoints"."platform" in ('amazon','etsy')),
	CONSTRAINT "order_connector_checkpoints_version_check" CHECK ("order_connector_checkpoints"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "order_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"type" text NOT NULL,
	"from_workflow_state" text,
	"to_workflow_state" text,
	"from_side_state" text,
	"to_side_state" text,
	"code" text,
	"message" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"actor_user_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_events_id_uuidv7_check" CHECK (substring("order_events"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "order_events_sequence_check" CHECK ("order_events"."sequence" > 0),
	CONSTRAINT "order_events_type_check" CHECK ("order_events"."type" in ('order_ingested','workflow_transitioned','side_state_changed','exception_opened','exception_resolved','protected_details_accessed','protected_details_anonymized'))
);
--> statement-breakpoint
CREATE TABLE "order_exception_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"exception_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"status" text NOT NULL,
	"resolution" text,
	"idempotency_key" text NOT NULL,
	"actor_user_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_exception_events_id_uuidv7_check" CHECK (substring("order_exception_events"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "order_exception_events_sequence_check" CHECK ("order_exception_events"."sequence" > 0),
	CONSTRAINT "order_exception_events_status_check" CHECK ("order_exception_events"."status" in ('open','resolved'))
);
--> statement-breakpoint
CREATE TABLE "order_exceptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"category" text NOT NULL,
	"code" text NOT NULL,
	"message" text NOT NULL,
	"opened_by" uuid,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_exceptions_id_uuidv7_check" CHECK (substring("order_exceptions"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "order_exceptions_category_check" CHECK ("order_exceptions"."category" in ('address','customization_missing','design_overdue','customer_timeout','sourcing','production','quality','logistics','cancellation_requested','refund','remake','reshipment'))
);
--> statement-breakpoint
CREATE TABLE "order_external_references" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"order_line_id" uuid,
	"provider" text NOT NULL,
	"kind" text NOT NULL,
	"external_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_external_references_id_uuidv7_check" CHECK (substring("order_external_references"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "order_external_references_provider_check" CHECK ("order_external_references"."provider" in ('amazon','etsy'))
);
--> statement-breakpoint
CREATE TABLE "order_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"external_line_id" text NOT NULL,
	"external_listing_id" text,
	"sku_code" text,
	"title" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price_minor" bigint NOT NULL,
	"unit_price_currency" text NOT NULL,
	"customization_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_lines_id_uuidv7_check" CHECK (substring("order_lines"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "order_lines_quantity_check" CHECK ("order_lines"."quantity" > 0),
	CONSTRAINT "order_lines_currency_check" CHECK ("order_lines"."unit_price_currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "order_lines_customization_count_check" CHECK ("order_lines"."customization_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "order_protected_access_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"actor_user_id" uuid,
	"granted" boolean NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_protected_access_events_id_uuidv7_check" CHECK (substring("order_protected_access_events"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "order_protected_access_events_purpose_check" CHECK ("order_protected_access_events"."purpose" in ('fulfillment','customer_support','fraud_review','legal','retention'))
);
--> statement-breakpoint
CREATE TABLE "order_protected_details" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"encrypted_envelope" text NOT NULL,
	"envelope_version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'protected' NOT NULL,
	"country_code" text,
	"retention_expires_at" timestamp with time zone NOT NULL,
	"anonymized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_protected_details_id_uuidv7_check" CHECK (substring("order_protected_details"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "order_protected_details_version_check" CHECK ("order_protected_details"."envelope_version" > 0),
	CONSTRAINT "order_protected_details_status_check" CHECK ("order_protected_details"."status" in ('protected','anonymized')),
	CONSTRAINT "order_protected_details_country_check" CHECK ("order_protected_details"."country_code" is null or "order_protected_details"."country_code" ~ '^[A-Z]{2}$')
);
--> statement-breakpoint
CREATE TABLE "order_source_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"external_event_id" text NOT NULL,
	"external_order_id" text NOT NULL,
	"normalized_order_id" uuid NOT NULL,
	"redacted_payload" jsonb NOT NULL,
	"payload_checksum" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_source_snapshots_id_uuidv7_check" CHECK (substring("order_source_snapshots"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "order_source_snapshots_platform_check" CHECK ("order_source_snapshots"."platform" in ('amazon','etsy')),
	CONSTRAINT "order_source_snapshots_checksum_check" CHECK ("order_source_snapshots"."payload_checksum" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"source_snapshot_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"external_order_id" text NOT NULL,
	"provider_status" text NOT NULL,
	"workflow_state" text DEFAULT 'pending' NOT NULL,
	"side_state" text,
	"order_total_minor" bigint NOT NULL,
	"order_currency" text NOT NULL,
	"line_count" integer NOT NULL,
	"address_status" text DEFAULT 'missing' NOT NULL,
	"address_country_code" text,
	"latest_event_sequence" integer DEFAULT 1 NOT NULL,
	"placed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_id_uuidv7_check" CHECK (substring("orders"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "orders_platform_check" CHECK ("orders"."platform" in ('amazon','etsy')),
	CONSTRAINT "orders_workflow_state_check" CHECK ("orders"."workflow_state" in ('pending','awaiting_customization','awaiting_design','awaiting_customer_approval','awaiting_routing','in_production','awaiting_quality_control','awaiting_shipment','shipped','completed')),
	CONSTRAINT "orders_side_state_check" CHECK ("orders"."side_state" is null or "orders"."side_state" in ('on_hold','cancelled')),
	CONSTRAINT "orders_currency_check" CHECK ("orders"."order_currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "orders_line_count_check" CHECK ("orders"."line_count" > 0),
	CONSTRAINT "orders_address_status_check" CHECK ("orders"."address_status" in ('missing','protected','anonymized')),
	CONSTRAINT "orders_address_country_check" CHECK ("orders"."address_country_code" is null or "orders"."address_country_code" ~ '^[A-Z]{2}$'),
	CONSTRAINT "orders_event_sequence_check" CHECK ("orders"."latest_event_sequence" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "order_source_snapshots_tenant_id_unique" ON "order_source_snapshots" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_tenant_id_unique" ON "orders" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_lines_tenant_id_unique" ON "order_lines" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_exceptions_tenant_id_unique" ON "order_exceptions" USING btree ("tenant_id","id");--> statement-breakpoint
ALTER TABLE "order_connector_checkpoints" ADD CONSTRAINT "order_connector_checkpoints_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_connector_checkpoints" ADD CONSTRAINT "order_connector_checkpoints_account_fk" FOREIGN KEY ("tenant_id","account_id") REFERENCES "public"."marketplace_accounts"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_actor_user_id_app_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_exception_events" ADD CONSTRAINT "order_exception_events_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_exception_events" ADD CONSTRAINT "order_exception_events_actor_user_id_app_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_exception_events" ADD CONSTRAINT "order_exception_events_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_exception_events" ADD CONSTRAINT "order_exception_events_exception_fk" FOREIGN KEY ("tenant_id","exception_id") REFERENCES "public"."order_exceptions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_exceptions" ADD CONSTRAINT "order_exceptions_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_exceptions" ADD CONSTRAINT "order_exceptions_opened_by_app_users_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_exceptions" ADD CONSTRAINT "order_exceptions_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_external_references" ADD CONSTRAINT "order_external_references_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_external_references" ADD CONSTRAINT "order_external_references_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_external_references" ADD CONSTRAINT "order_external_references_line_fk" FOREIGN KEY ("tenant_id","order_line_id") REFERENCES "public"."order_lines"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_protected_access_events" ADD CONSTRAINT "order_protected_access_events_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_protected_access_events" ADD CONSTRAINT "order_protected_access_events_actor_user_id_app_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_protected_access_events" ADD CONSTRAINT "order_protected_access_events_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_protected_details" ADD CONSTRAINT "order_protected_details_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_protected_details" ADD CONSTRAINT "order_protected_details_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_source_snapshots" ADD CONSTRAINT "order_source_snapshots_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_source_snapshots" ADD CONSTRAINT "order_source_snapshots_account_fk" FOREIGN KEY ("tenant_id","account_id") REFERENCES "public"."marketplace_accounts"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_account_fk" FOREIGN KEY ("tenant_id","account_id") REFERENCES "public"."marketplace_accounts"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_source_snapshot_fk" FOREIGN KEY ("tenant_id","source_snapshot_id") REFERENCES "public"."order_source_snapshots"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "order_connector_checkpoints_tenant_id_unique" ON "order_connector_checkpoints" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_connector_checkpoints_stream_unique" ON "order_connector_checkpoints" USING btree ("tenant_id","account_id","platform","stream");--> statement-breakpoint
CREATE UNIQUE INDEX "order_events_tenant_id_unique" ON "order_events" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_events_sequence_unique" ON "order_events" USING btree ("tenant_id","order_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "order_events_idempotency_unique" ON "order_events" USING btree ("tenant_id","order_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "order_events_order_idx" ON "order_events" USING btree ("tenant_id","order_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "order_exception_events_tenant_id_unique" ON "order_exception_events" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_exception_events_sequence_unique" ON "order_exception_events" USING btree ("tenant_id","exception_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "order_exception_events_idempotency_unique" ON "order_exception_events" USING btree ("tenant_id","order_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "order_exceptions_order_idx" ON "order_exceptions" USING btree ("tenant_id","order_id","opened_at");--> statement-breakpoint
CREATE UNIQUE INDEX "order_external_references_tenant_id_unique" ON "order_external_references" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_external_references_identity_unique" ON "order_external_references" USING btree ("tenant_id","order_id","kind","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_lines_external_unique" ON "order_lines" USING btree ("tenant_id","order_id","external_line_id");--> statement-breakpoint
CREATE INDEX "order_lines_order_idx" ON "order_lines" USING btree ("tenant_id","order_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "order_protected_access_events_tenant_id_unique" ON "order_protected_access_events" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX "order_protected_access_events_order_idx" ON "order_protected_access_events" USING btree ("tenant_id","order_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "order_protected_details_tenant_id_unique" ON "order_protected_details" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_protected_details_order_unique" ON "order_protected_details" USING btree ("tenant_id","order_id");--> statement-breakpoint
CREATE INDEX "order_protected_details_retention_idx" ON "order_protected_details" USING btree ("tenant_id","status","retention_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "order_source_snapshots_delivery_unique" ON "order_source_snapshots" USING btree ("tenant_id","account_id","platform","external_event_id");--> statement-breakpoint
CREATE INDEX "order_source_snapshots_order_idx" ON "order_source_snapshots" USING btree ("tenant_id","normalized_order_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_provider_identity_unique" ON "orders" USING btree ("tenant_id","account_id","platform","external_order_id");--> statement-breakpoint
CREATE INDEX "orders_inbox_idx" ON "orders" USING btree ("tenant_id","side_state","workflow_state","placed_at");
--> statement-breakpoint
ALTER TABLE "order_source_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_source_snapshots" FORCE ROW LEVEL SECURITY;
CREATE POLICY "order_source_snapshots_tenant_policy" ON "order_source_snapshots" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "order_source_snapshots" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "orders" FORCE ROW LEVEL SECURITY;
CREATE POLICY "orders_tenant_policy" ON "orders" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT, UPDATE ON "orders" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "order_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY "order_lines_tenant_policy" ON "order_lines" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "order_lines" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "order_external_references" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_external_references" FORCE ROW LEVEL SECURITY;
CREATE POLICY "order_external_references_tenant_policy" ON "order_external_references" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "order_external_references" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "order_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "order_events_tenant_policy" ON "order_events" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "order_events" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "order_exceptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_exceptions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "order_exceptions_tenant_policy" ON "order_exceptions" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "order_exceptions" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "order_exception_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_exception_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "order_exception_events_tenant_policy" ON "order_exception_events" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "order_exception_events" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "order_protected_details" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_protected_details" FORCE ROW LEVEL SECURITY;
CREATE POLICY "order_protected_details_tenant_policy" ON "order_protected_details" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT, UPDATE ON "order_protected_details" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "order_protected_access_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_protected_access_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "order_protected_access_events_tenant_policy" ON "order_protected_access_events" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "order_protected_access_events" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "order_connector_checkpoints" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_connector_checkpoints" FORCE ROW LEVEL SECURITY;
CREATE POLICY "order_connector_checkpoints_tenant_policy" ON "order_connector_checkpoints" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT, UPDATE ON "order_connector_checkpoints" TO yummyai_app;
