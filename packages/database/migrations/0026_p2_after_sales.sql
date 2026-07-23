CREATE TABLE "after_sales_cases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"reason_code" text NOT NULL,
	"encrypted_summary" text NOT NULL,
	"summary_checksum" text NOT NULL,
	"current_decision_version" integer DEFAULT 0 NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "after_sales_cases_id_uuidv7_check" CHECK (substring("after_sales_cases"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "after_sales_cases_type_check" CHECK ("after_sales_cases"."type" in ('customer_contact','refund_request','return_request','replacement_request','delivery_issue','quality_issue')),
	CONSTRAINT "after_sales_cases_status_check" CHECK ("after_sales_cases"."status" in ('open','awaiting_customer','awaiting_internal','approved','rejected','resolved','cancelled')),
	CONSTRAINT "after_sales_cases_checksum_check" CHECK ("after_sales_cases"."summary_checksum" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "after_sales_cases_version_check" CHECK ("after_sales_cases"."current_decision_version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "after_sales_decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"resolution" text NOT NULL,
	"refund_amount_minor" bigint,
	"refund_currency" text,
	"return_required" boolean NOT NULL,
	"responsibility_party" text NOT NULL,
	"reason_code" text NOT NULL,
	"encrypted_reason" text NOT NULL,
	"reason_checksum" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "after_sales_decisions_id_uuidv7_check" CHECK (substring("after_sales_decisions"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "after_sales_decisions_version_check" CHECK ("after_sales_decisions"."version_number" > 0),
	CONSTRAINT "after_sales_decisions_resolution_check" CHECK ("after_sales_decisions"."resolution" in ('no_action','full_refund','partial_refund','return_and_refund','replacement')),
	CONSTRAINT "after_sales_decisions_money_check" CHECK (("after_sales_decisions"."refund_amount_minor" is null and "after_sales_decisions"."refund_currency" is null) or ("after_sales_decisions"."refund_amount_minor" >= 0 and "after_sales_decisions"."refund_currency" ~ '^[A-Z]{3}$')),
	CONSTRAINT "after_sales_decisions_party_check" CHECK ("after_sales_decisions"."responsibility_party" in ('customer','marketplace','carrier','supplier','internal','undetermined')),
	CONSTRAINT "after_sales_decisions_checksum_check" CHECK ("after_sales_decisions"."reason_checksum" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "after_sales_responsibility_evidence" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"party" text NOT NULL,
	"code" text NOT NULL,
	"encrypted_detail" text NOT NULL,
	"detail_checksum" text NOT NULL,
	"asset_id" uuid,
	"idempotency_key" text NOT NULL,
	"recorded_by" uuid,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "after_sales_responsibility_evidence_id_uuidv7_check" CHECK (substring("after_sales_responsibility_evidence"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "after_sales_responsibility_evidence_party_check" CHECK ("after_sales_responsibility_evidence"."party" in ('customer','marketplace','carrier','supplier','internal','undetermined')),
	CONSTRAINT "after_sales_responsibility_evidence_checksum_check" CHECK ("after_sales_responsibility_evidence"."detail_checksum" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "customer_contact_records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"direction" text NOT NULL,
	"encrypted_body" text NOT NULL,
	"body_checksum" text NOT NULL,
	"external_message_id" text,
	"idempotency_key" text NOT NULL,
	"actor_user_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_contact_records_id_uuidv7_check" CHECK (substring("customer_contact_records"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "customer_contact_records_channel_check" CHECK ("customer_contact_records"."channel" in ('marketplace','email','phone','internal')),
	CONSTRAINT "customer_contact_records_direction_check" CHECK ("customer_contact_records"."direction" in ('inbound','outbound','internal')),
	CONSTRAINT "customer_contact_records_checksum_check" CHECK ("customer_contact_records"."body_checksum" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "replacement_order_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"source_order_id" uuid NOT NULL,
	"replacement_order_id" uuid NOT NULL,
	"encrypted_reason" text NOT NULL,
	"reason_checksum" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "replacement_order_links_id_uuidv7_check" CHECK (substring("replacement_order_links"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "replacement_order_links_distinct_check" CHECK ("replacement_order_links"."source_order_id" <> "replacement_order_links"."replacement_order_id"),
	CONSTRAINT "replacement_order_links_checksum_check" CHECK ("replacement_order_links"."reason_checksum" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "return_shipments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"carrier_code" text NOT NULL,
	"tracking_number" text NOT NULL,
	"status" text DEFAULT 'label_created' NOT NULL,
	"label_asset_id" uuid,
	"idempotency_key" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "return_shipments_id_uuidv7_check" CHECK (substring("return_shipments"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "return_shipments_status_check" CHECK ("return_shipments"."status" in ('label_created','in_transit','delivered','lost','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "return_tracking_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"return_shipment_id" uuid NOT NULL,
	"status" text NOT NULL,
	"provider" text NOT NULL,
	"external_event_id" text NOT NULL,
	"detail_code" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "return_tracking_events_id_uuidv7_check" CHECK (substring("return_tracking_events"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "return_tracking_events_status_check" CHECK ("return_tracking_events"."status" in ('label_created','in_transit','delivered','lost','cancelled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "after_sales_cases_tenant_id_unique" ON "after_sales_cases" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "return_shipments_tenant_id_unique" ON "return_shipments" USING btree ("tenant_id","id");--> statement-breakpoint
ALTER TABLE "after_sales_cases" ADD CONSTRAINT "after_sales_cases_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "after_sales_cases" ADD CONSTRAINT "after_sales_cases_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "after_sales_cases" ADD CONSTRAINT "after_sales_cases_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "after_sales_decisions" ADD CONSTRAINT "after_sales_decisions_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "after_sales_decisions" ADD CONSTRAINT "after_sales_decisions_decided_by_app_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "after_sales_decisions" ADD CONSTRAINT "after_sales_decisions_case_fk" FOREIGN KEY ("tenant_id","case_id") REFERENCES "public"."after_sales_cases"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "after_sales_responsibility_evidence" ADD CONSTRAINT "after_sales_responsibility_evidence_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "after_sales_responsibility_evidence" ADD CONSTRAINT "after_sales_responsibility_evidence_recorded_by_app_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "after_sales_responsibility_evidence" ADD CONSTRAINT "after_sales_responsibility_evidence_case_fk" FOREIGN KEY ("tenant_id","case_id") REFERENCES "public"."after_sales_cases"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "after_sales_responsibility_evidence" ADD CONSTRAINT "after_sales_responsibility_evidence_asset_fk" FOREIGN KEY ("tenant_id","asset_id") REFERENCES "public"."asset_files"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_contact_records" ADD CONSTRAINT "customer_contact_records_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_contact_records" ADD CONSTRAINT "customer_contact_records_actor_user_id_app_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_contact_records" ADD CONSTRAINT "customer_contact_records_case_fk" FOREIGN KEY ("tenant_id","case_id") REFERENCES "public"."after_sales_cases"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_contact_records" ADD CONSTRAINT "customer_contact_records_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replacement_order_links" ADD CONSTRAINT "replacement_order_links_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replacement_order_links" ADD CONSTRAINT "replacement_order_links_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replacement_order_links" ADD CONSTRAINT "replacement_order_links_case_fk" FOREIGN KEY ("tenant_id","case_id") REFERENCES "public"."after_sales_cases"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replacement_order_links" ADD CONSTRAINT "replacement_order_links_source_fk" FOREIGN KEY ("tenant_id","source_order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replacement_order_links" ADD CONSTRAINT "replacement_order_links_replacement_fk" FOREIGN KEY ("tenant_id","replacement_order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_shipments" ADD CONSTRAINT "return_shipments_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_shipments" ADD CONSTRAINT "return_shipments_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_shipments" ADD CONSTRAINT "return_shipments_case_fk" FOREIGN KEY ("tenant_id","case_id") REFERENCES "public"."after_sales_cases"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_shipments" ADD CONSTRAINT "return_shipments_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_shipments" ADD CONSTRAINT "return_shipments_label_asset_fk" FOREIGN KEY ("tenant_id","label_asset_id") REFERENCES "public"."asset_files"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_tracking_events" ADD CONSTRAINT "return_tracking_events_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_tracking_events" ADD CONSTRAINT "return_tracking_events_shipment_fk" FOREIGN KEY ("tenant_id","return_shipment_id") REFERENCES "public"."return_shipments"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "after_sales_cases_idempotency_unique" ON "after_sales_cases" USING btree ("tenant_id","order_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "after_sales_cases_queue_idx" ON "after_sales_cases" USING btree ("tenant_id","status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "after_sales_decisions_tenant_id_unique" ON "after_sales_decisions" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "after_sales_decisions_version_unique" ON "after_sales_decisions" USING btree ("tenant_id","case_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "after_sales_decisions_idempotency_unique" ON "after_sales_decisions" USING btree ("tenant_id","case_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "after_sales_responsibility_evidence_tenant_id_unique" ON "after_sales_responsibility_evidence" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "after_sales_responsibility_evidence_idempotency_unique" ON "after_sales_responsibility_evidence" USING btree ("tenant_id","case_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_contact_records_tenant_id_unique" ON "customer_contact_records" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_contact_records_idempotency_unique" ON "customer_contact_records" USING btree ("tenant_id","case_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_contact_records_external_unique" ON "customer_contact_records" USING btree ("tenant_id","channel","external_message_id");--> statement-breakpoint
CREATE INDEX "customer_contact_records_timeline_idx" ON "customer_contact_records" USING btree ("tenant_id","case_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "replacement_order_links_tenant_id_unique" ON "replacement_order_links" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "replacement_order_links_replacement_unique" ON "replacement_order_links" USING btree ("tenant_id","replacement_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "replacement_order_links_idempotency_unique" ON "replacement_order_links" USING btree ("tenant_id","case_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "return_shipments_idempotency_unique" ON "return_shipments" USING btree ("tenant_id","case_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "return_shipments_tracking_idx" ON "return_shipments" USING btree ("tenant_id","carrier_code","tracking_number");--> statement-breakpoint
CREATE UNIQUE INDEX "return_tracking_events_tenant_id_unique" ON "return_tracking_events" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "return_tracking_events_external_unique" ON "return_tracking_events" USING btree ("tenant_id","provider","external_event_id");--> statement-breakpoint
CREATE INDEX "return_tracking_events_timeline_idx" ON "return_tracking_events" USING btree ("tenant_id","return_shipment_id","occurred_at");
--> statement-breakpoint
ALTER TABLE "after_sales_cases" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "after_sales_cases" FORCE ROW LEVEL SECURITY;
CREATE POLICY "after_sales_cases_tenant_policy" ON "after_sales_cases" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT, UPDATE ON "after_sales_cases" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "after_sales_decisions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "after_sales_decisions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "after_sales_decisions_tenant_policy" ON "after_sales_decisions" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "after_sales_decisions" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "after_sales_responsibility_evidence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "after_sales_responsibility_evidence" FORCE ROW LEVEL SECURITY;
CREATE POLICY "after_sales_responsibility_evidence_tenant_policy" ON "after_sales_responsibility_evidence" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "after_sales_responsibility_evidence" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "customer_contact_records" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_contact_records" FORCE ROW LEVEL SECURITY;
CREATE POLICY "customer_contact_records_tenant_policy" ON "customer_contact_records" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "customer_contact_records" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "replacement_order_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "replacement_order_links" FORCE ROW LEVEL SECURITY;
CREATE POLICY "replacement_order_links_tenant_policy" ON "replacement_order_links" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "replacement_order_links" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "return_shipments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "return_shipments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "return_shipments_tenant_policy" ON "return_shipments" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT, UPDATE ON "return_shipments" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "return_tracking_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "return_tracking_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "return_tracking_events_tenant_policy" ON "return_tracking_events" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "return_tracking_events" TO yummyai_app;
