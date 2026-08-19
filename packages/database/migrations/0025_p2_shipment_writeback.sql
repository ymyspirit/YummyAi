CREATE TABLE "shipment_package_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"shipment_id" uuid NOT NULL,
	"shipment_version_id" uuid NOT NULL,
	"package_id" uuid NOT NULL,
	"order_line_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipment_package_lines_id_uuidv7_check" CHECK (substring("shipment_package_lines"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "shipment_package_lines_quantity_check" CHECK ("shipment_package_lines"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "shipment_packages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"shipment_id" uuid NOT NULL,
	"shipment_version_id" uuid NOT NULL,
	"package_reference_id" text NOT NULL,
	"tracking_number" text NOT NULL,
	"carrier_code" text NOT NULL,
	"carrier_name" text NOT NULL,
	"carrier_service" text NOT NULL,
	"label_asset_id" uuid,
	"external_label_id" text,
	"label_cost_minor" bigint,
	"label_currency" text,
	"weight_grams" integer,
	"length_mm" integer,
	"width_mm" integer,
	"height_mm" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipment_packages_id_uuidv7_check" CHECK (substring("shipment_packages"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "shipment_packages_carrier_code_check" CHECK ("shipment_packages"."carrier_code" ~ '^[A-Z0-9_:-]{1,80}$'),
	CONSTRAINT "shipment_packages_money_check" CHECK (("shipment_packages"."label_cost_minor" is null and "shipment_packages"."label_currency" is null) or ("shipment_packages"."label_cost_minor" >= 0 and "shipment_packages"."label_currency" ~ '^[A-Z]{3}$')),
	CONSTRAINT "shipment_packages_weight_check" CHECK ("shipment_packages"."weight_grams" is null or "shipment_packages"."weight_grams" > 0),
	CONSTRAINT "shipment_packages_dimensions_check" CHECK (("shipment_packages"."length_mm" is null and "shipment_packages"."width_mm" is null and "shipment_packages"."height_mm" is null) or ("shipment_packages"."length_mm" > 0 and "shipment_packages"."width_mm" > 0 and "shipment_packages"."height_mm" > 0))
);
--> statement-breakpoint
CREATE TABLE "shipment_tracking_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"shipment_id" uuid NOT NULL,
	"package_id" uuid NOT NULL,
	"status" text NOT NULL,
	"provider" text NOT NULL,
	"external_event_id" text NOT NULL,
	"detail_code" text NOT NULL,
	"estimated_delivery_at" timestamp with time zone,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipment_tracking_events_id_uuidv7_check" CHECK (substring("shipment_tracking_events"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "shipment_tracking_events_status_check" CHECK ("shipment_tracking_events"."status" in ('information_received','picked_up','in_transit','out_for_delivery','delivered','delivery_exception','returned'))
);
--> statement-breakpoint
CREATE TABLE "shipment_version_reviews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"shipment_id" uuid NOT NULL,
	"shipment_version_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"reason_code" text NOT NULL,
	"encrypted_reason" text NOT NULL,
	"reason_checksum" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipment_version_reviews_id_uuidv7_check" CHECK (substring("shipment_version_reviews"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "shipment_version_reviews_decision_check" CHECK ("shipment_version_reviews"."decision" in ('approved','rejected')),
	CONSTRAINT "shipment_version_reviews_checksum_check" CHECK ("shipment_version_reviews"."reason_checksum" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "shipment_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"shipment_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"ship_date" timestamp with time zone NOT NULL,
	"promised_delivery_at" timestamp with time zone,
	"estimated_delivery_at" timestamp with time zone,
	"ship_from_country_code" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipment_versions_id_uuidv7_check" CHECK (substring("shipment_versions"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "shipment_versions_number_check" CHECK ("shipment_versions"."version_number" > 0),
	CONSTRAINT "shipment_versions_country_check" CHECK ("shipment_versions"."ship_from_country_code" ~ '^[A-Z]{2}$'),
	CONSTRAINT "shipment_versions_delivery_check" CHECK (("shipment_versions"."promised_delivery_at" is null or "shipment_versions"."promised_delivery_at" >= "shipment_versions"."ship_date") and ("shipment_versions"."estimated_delivery_at" is null or "shipment_versions"."estimated_delivery_at" >= "shipment_versions"."ship_date"))
);
--> statement-breakpoint
CREATE TABLE "shipment_writeback_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"action" text NOT NULL,
	"from_status" text NOT NULL,
	"to_status" text NOT NULL,
	"provider_code" text,
	"external_reference" text,
	"actor_user_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipment_writeback_events_id_uuidv7_check" CHECK (substring("shipment_writeback_events"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "shipment_writeback_events_sequence_check" CHECK ("shipment_writeback_events"."sequence" > 0),
	CONSTRAINT "shipment_writeback_events_action_check" CHECK ("shipment_writeback_events"."action" in ('dispatched','accepted','rejected','uncertain','reconcile_accepted','reconcile_rejected'))
);
--> statement-breakpoint
CREATE TABLE "shipment_writeback_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"shipment_id" uuid NOT NULL,
	"shipment_version_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"external_order_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"projection_version" integer DEFAULT 1 NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipment_writeback_requests_id_uuidv7_check" CHECK (substring("shipment_writeback_requests"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "shipment_writeback_requests_platform_check" CHECK ("shipment_writeback_requests"."platform" in ('amazon','etsy')),
	CONSTRAINT "shipment_writeback_requests_status_check" CHECK ("shipment_writeback_requests"."status" in ('queued','dispatched','accepted','rejected','reconciliation_required','reconciled')),
	CONSTRAINT "shipment_writeback_requests_version_check" CHECK ("shipment_writeback_requests"."projection_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "shipments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"current_version_number" integer DEFAULT 1 NOT NULL,
	"approved_version_number" integer,
	"idempotency_key" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipments_id_uuidv7_check" CHECK (substring("shipments"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "shipments_status_check" CHECK ("shipments"."status" in ('draft','approved','writeback_pending','shipped','in_transit','delivered','exception','cancelled')),
	CONSTRAINT "shipments_versions_check" CHECK ("shipments"."current_version_number" > 0 and ("shipments"."approved_version_number" is null or ("shipments"."approved_version_number" > 0 and "shipments"."approved_version_number" <= "shipments"."current_version_number")))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "shipment_packages_tenant_id_unique" ON "shipment_packages" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "shipment_versions_tenant_id_unique" ON "shipment_versions" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "shipment_writeback_requests_tenant_id_unique" ON "shipment_writeback_requests" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "shipments_tenant_id_unique" ON "shipments" USING btree ("tenant_id","id");--> statement-breakpoint
ALTER TABLE "shipment_package_lines" ADD CONSTRAINT "shipment_package_lines_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_package_lines" ADD CONSTRAINT "shipment_package_lines_shipment_fk" FOREIGN KEY ("tenant_id","shipment_id") REFERENCES "public"."shipments"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_package_lines" ADD CONSTRAINT "shipment_package_lines_version_fk" FOREIGN KEY ("tenant_id","shipment_version_id") REFERENCES "public"."shipment_versions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_package_lines" ADD CONSTRAINT "shipment_package_lines_package_fk" FOREIGN KEY ("tenant_id","package_id") REFERENCES "public"."shipment_packages"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_package_lines" ADD CONSTRAINT "shipment_package_lines_order_line_fk" FOREIGN KEY ("tenant_id","order_line_id") REFERENCES "public"."order_lines"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_packages" ADD CONSTRAINT "shipment_packages_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_packages" ADD CONSTRAINT "shipment_packages_shipment_fk" FOREIGN KEY ("tenant_id","shipment_id") REFERENCES "public"."shipments"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_packages" ADD CONSTRAINT "shipment_packages_version_fk" FOREIGN KEY ("tenant_id","shipment_version_id") REFERENCES "public"."shipment_versions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_packages" ADD CONSTRAINT "shipment_packages_label_asset_fk" FOREIGN KEY ("tenant_id","label_asset_id") REFERENCES "public"."asset_files"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_tracking_events" ADD CONSTRAINT "shipment_tracking_events_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_tracking_events" ADD CONSTRAINT "shipment_tracking_events_shipment_fk" FOREIGN KEY ("tenant_id","shipment_id") REFERENCES "public"."shipments"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_tracking_events" ADD CONSTRAINT "shipment_tracking_events_package_fk" FOREIGN KEY ("tenant_id","package_id") REFERENCES "public"."shipment_packages"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_version_reviews" ADD CONSTRAINT "shipment_version_reviews_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_version_reviews" ADD CONSTRAINT "shipment_version_reviews_reviewed_by_app_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_version_reviews" ADD CONSTRAINT "shipment_version_reviews_shipment_fk" FOREIGN KEY ("tenant_id","shipment_id") REFERENCES "public"."shipments"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_version_reviews" ADD CONSTRAINT "shipment_version_reviews_version_fk" FOREIGN KEY ("tenant_id","shipment_version_id") REFERENCES "public"."shipment_versions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_versions" ADD CONSTRAINT "shipment_versions_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_versions" ADD CONSTRAINT "shipment_versions_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_versions" ADD CONSTRAINT "shipment_versions_shipment_fk" FOREIGN KEY ("tenant_id","shipment_id") REFERENCES "public"."shipments"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_writeback_events" ADD CONSTRAINT "shipment_writeback_events_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_writeback_events" ADD CONSTRAINT "shipment_writeback_events_actor_user_id_app_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_writeback_events" ADD CONSTRAINT "shipment_writeback_events_request_fk" FOREIGN KEY ("tenant_id","request_id") REFERENCES "public"."shipment_writeback_requests"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_writeback_requests" ADD CONSTRAINT "shipment_writeback_requests_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_writeback_requests" ADD CONSTRAINT "shipment_writeback_requests_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_writeback_requests" ADD CONSTRAINT "shipment_writeback_requests_shipment_fk" FOREIGN KEY ("tenant_id","shipment_id") REFERENCES "public"."shipments"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_writeback_requests" ADD CONSTRAINT "shipment_writeback_requests_version_fk" FOREIGN KEY ("tenant_id","shipment_version_id") REFERENCES "public"."shipment_versions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_writeback_requests" ADD CONSTRAINT "shipment_writeback_requests_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_writeback_requests" ADD CONSTRAINT "shipment_writeback_requests_account_fk" FOREIGN KEY ("tenant_id","account_id") REFERENCES "public"."marketplace_accounts"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shipment_package_lines_tenant_id_unique" ON "shipment_package_lines" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "shipment_package_lines_pair_unique" ON "shipment_package_lines" USING btree ("tenant_id","package_id","order_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shipment_packages_reference_unique" ON "shipment_packages" USING btree ("tenant_id","shipment_version_id","package_reference_id");--> statement-breakpoint
CREATE INDEX "shipment_packages_tracking_idx" ON "shipment_packages" USING btree ("tenant_id","carrier_code","tracking_number");--> statement-breakpoint
CREATE UNIQUE INDEX "shipment_tracking_events_tenant_id_unique" ON "shipment_tracking_events" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "shipment_tracking_events_external_unique" ON "shipment_tracking_events" USING btree ("tenant_id","provider","external_event_id");--> statement-breakpoint
CREATE INDEX "shipment_tracking_events_timeline_idx" ON "shipment_tracking_events" USING btree ("tenant_id","shipment_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "shipment_version_reviews_tenant_id_unique" ON "shipment_version_reviews" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "shipment_version_reviews_version_unique" ON "shipment_version_reviews" USING btree ("tenant_id","shipment_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shipment_version_reviews_idempotency_unique" ON "shipment_version_reviews" USING btree ("tenant_id","shipment_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "shipment_versions_number_unique" ON "shipment_versions" USING btree ("tenant_id","shipment_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "shipment_versions_idempotency_unique" ON "shipment_versions" USING btree ("tenant_id","shipment_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "shipment_writeback_events_tenant_id_unique" ON "shipment_writeback_events" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "shipment_writeback_events_sequence_unique" ON "shipment_writeback_events" USING btree ("tenant_id","request_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "shipment_writeback_requests_idempotency_unique" ON "shipment_writeback_requests" USING btree ("tenant_id","shipment_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "shipment_writeback_requests_queue_idx" ON "shipment_writeback_requests" USING btree ("tenant_id","status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "shipments_idempotency_unique" ON "shipments" USING btree ("tenant_id","order_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "shipments_queue_idx" ON "shipments" USING btree ("tenant_id","status","updated_at");
--> statement-breakpoint
ALTER TABLE "shipments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shipments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "shipments_tenant_policy" ON "shipments" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT, UPDATE ON "shipments" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "shipment_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shipment_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "shipment_versions_tenant_policy" ON "shipment_versions" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "shipment_versions" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "shipment_packages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shipment_packages" FORCE ROW LEVEL SECURITY;
CREATE POLICY "shipment_packages_tenant_policy" ON "shipment_packages" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "shipment_packages" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "shipment_package_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shipment_package_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY "shipment_package_lines_tenant_policy" ON "shipment_package_lines" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "shipment_package_lines" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "shipment_version_reviews" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shipment_version_reviews" FORCE ROW LEVEL SECURITY;
CREATE POLICY "shipment_version_reviews_tenant_policy" ON "shipment_version_reviews" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "shipment_version_reviews" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "shipment_writeback_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shipment_writeback_requests" FORCE ROW LEVEL SECURITY;
CREATE POLICY "shipment_writeback_requests_tenant_policy" ON "shipment_writeback_requests" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT, UPDATE ON "shipment_writeback_requests" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "shipment_writeback_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shipment_writeback_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "shipment_writeback_events_tenant_policy" ON "shipment_writeback_events" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "shipment_writeback_events" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "shipment_tracking_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shipment_tracking_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "shipment_tracking_events_tenant_policy" ON "shipment_tracking_events" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "shipment_tracking_events" TO yummyai_app;
