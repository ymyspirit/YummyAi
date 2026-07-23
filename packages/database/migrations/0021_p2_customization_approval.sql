CREATE TABLE "order_customization_file_intakes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customization_version_id" uuid NOT NULL,
	"field_key" text NOT NULL,
	"object_key" text NOT NULL,
	"safe_file_name" text NOT NULL,
	"media_type" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"checksum_sha256" text NOT NULL,
	"scan_status" text DEFAULT 'pending' NOT NULL,
	"authorized_asset_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_customization_file_intakes_id_uuidv7_check" CHECK (substring("order_customization_file_intakes"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "order_customization_file_intakes_object_key_check" CHECK ("order_customization_file_intakes"."object_key" like 'tenants/' || "order_customization_file_intakes"."tenant_id"::text || '/quarantine/%'),
	CONSTRAINT "order_customization_file_intakes_size_check" CHECK ("order_customization_file_intakes"."byte_size" > 0),
	CONSTRAINT "order_customization_file_intakes_checksum_check" CHECK ("order_customization_file_intakes"."checksum_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "order_customization_file_intakes_scan_check" CHECK ("order_customization_file_intakes"."scan_status" in ('pending','clean','infected','unsupported','failed','promoted'))
);
--> statement-breakpoint
CREATE TABLE "order_customization_file_scan_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"intake_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"result" text NOT NULL,
	"engine" text NOT NULL,
	"signature_version" text NOT NULL,
	"scanned_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_customization_file_scan_events_id_uuidv7_check" CHECK (substring("order_customization_file_scan_events"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "order_customization_file_scan_events_sequence_check" CHECK ("order_customization_file_scan_events"."sequence" > 0),
	CONSTRAINT "order_customization_file_scan_events_result_check" CHECK ("order_customization_file_scan_events"."result" in ('clean','infected','unsupported','failed'))
);
--> statement-breakpoint
CREATE TABLE "order_customization_requirements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"order_line_id" uuid NOT NULL,
	"schema_version" integer NOT NULL,
	"schema_snapshot" jsonb NOT NULL,
	"fulfillment_path" text NOT NULL,
	"status" text NOT NULL,
	"customer_approval_due_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_customization_requirements_id_uuidv7_check" CHECK (substring("order_customization_requirements"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "order_customization_requirements_schema_version_check" CHECK ("order_customization_requirements"."schema_version" > 0),
	CONSTRAINT "order_customization_requirements_path_check" CHECK ("order_customization_requirements"."fulfillment_path" in ('template_ready','designer_required','customer_approval_required')),
	CONSTRAINT "order_customization_requirements_status_check" CHECK ("order_customization_requirements"."status" in ('incomplete','ready','awaiting_design','awaiting_customer','approved','rejected','quarantined')),
	CONSTRAINT "order_customization_requirements_due_check" CHECK ("order_customization_requirements"."fulfillment_path" <> 'customer_approval_required' or "order_customization_requirements"."customer_approval_due_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "order_customization_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"requirement_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"encrypted_values" text NOT NULL,
	"values_checksum" text NOT NULL,
	"mapped_field_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"missing_field_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"file_field_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"completeness" integer NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_customization_versions_id_uuidv7_check" CHECK (substring("order_customization_versions"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "order_customization_versions_number_check" CHECK ("order_customization_versions"."version_number" > 0),
	CONSTRAINT "order_customization_versions_checksum_check" CHECK ("order_customization_versions"."values_checksum" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "order_customization_versions_completeness_check" CHECK ("order_customization_versions"."completeness" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "order_proof_decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"proof_version_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"external_decision_id" text NOT NULL,
	"reason_code" text,
	"actor_user_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_proof_decisions_id_uuidv7_check" CHECK (substring("order_proof_decisions"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "order_proof_decisions_decision_check" CHECK ("order_proof_decisions"."decision" in ('approved','rejected','timed_out')),
	CONSTRAINT "order_proof_decisions_rejection_check" CHECK ("order_proof_decisions"."decision" <> 'rejected' or "order_proof_decisions"."reason_code" is not null)
);
--> statement-breakpoint
CREATE TABLE "order_proof_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"order_line_id" uuid NOT NULL,
	"customization_version_id" uuid NOT NULL,
	"design_version_id" uuid,
	"version_number" integer NOT NULL,
	"due_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_proof_versions_id_uuidv7_check" CHECK (substring("order_proof_versions"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "order_proof_versions_number_check" CHECK ("order_proof_versions"."version_number" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "order_customization_requirements_tenant_id_unique" ON "order_customization_requirements" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_customization_versions_tenant_id_unique" ON "order_customization_versions" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_customization_file_intakes_tenant_id_unique" ON "order_customization_file_intakes" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_customization_file_scan_events_tenant_id_unique" ON "order_customization_file_scan_events" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_proof_versions_tenant_id_unique" ON "order_proof_versions" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_proof_decisions_tenant_id_unique" ON "order_proof_decisions" USING btree ("tenant_id","id");--> statement-breakpoint
ALTER TABLE "order_customization_file_intakes" ADD CONSTRAINT "order_customization_file_intakes_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_customization_file_intakes" ADD CONSTRAINT "order_customization_file_intakes_version_fk" FOREIGN KEY ("tenant_id","customization_version_id") REFERENCES "public"."order_customization_versions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_customization_file_intakes" ADD CONSTRAINT "order_customization_file_intakes_asset_fk" FOREIGN KEY ("tenant_id","authorized_asset_id") REFERENCES "public"."asset_files"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_customization_file_scan_events" ADD CONSTRAINT "order_customization_file_scan_events_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_customization_file_scan_events" ADD CONSTRAINT "order_customization_file_scan_events_intake_fk" FOREIGN KEY ("tenant_id","intake_id") REFERENCES "public"."order_customization_file_intakes"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_customization_requirements" ADD CONSTRAINT "order_customization_requirements_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_customization_requirements" ADD CONSTRAINT "order_customization_requirements_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_customization_requirements" ADD CONSTRAINT "order_customization_requirements_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_customization_requirements" ADD CONSTRAINT "order_customization_requirements_line_fk" FOREIGN KEY ("tenant_id","order_line_id") REFERENCES "public"."order_lines"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_customization_versions" ADD CONSTRAINT "order_customization_versions_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_customization_versions" ADD CONSTRAINT "order_customization_versions_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_customization_versions" ADD CONSTRAINT "order_customization_versions_requirement_fk" FOREIGN KEY ("tenant_id","requirement_id") REFERENCES "public"."order_customization_requirements"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_proof_decisions" ADD CONSTRAINT "order_proof_decisions_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_proof_decisions" ADD CONSTRAINT "order_proof_decisions_actor_user_id_app_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_proof_decisions" ADD CONSTRAINT "order_proof_decisions_proof_fk" FOREIGN KEY ("tenant_id","proof_version_id") REFERENCES "public"."order_proof_versions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_proof_versions" ADD CONSTRAINT "order_proof_versions_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_proof_versions" ADD CONSTRAINT "order_proof_versions_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_proof_versions" ADD CONSTRAINT "order_proof_versions_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_proof_versions" ADD CONSTRAINT "order_proof_versions_line_fk" FOREIGN KEY ("tenant_id","order_line_id") REFERENCES "public"."order_lines"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_proof_versions" ADD CONSTRAINT "order_proof_versions_customization_fk" FOREIGN KEY ("tenant_id","customization_version_id") REFERENCES "public"."order_customization_versions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_proof_versions" ADD CONSTRAINT "order_proof_versions_design_fk" FOREIGN KEY ("tenant_id","design_version_id") REFERENCES "public"."design_versions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "order_customization_file_intakes_object_unique" ON "order_customization_file_intakes" USING btree ("tenant_id","object_key");--> statement-breakpoint
CREATE INDEX "order_customization_file_intakes_scan_idx" ON "order_customization_file_intakes" USING btree ("tenant_id","scan_status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "order_customization_file_scan_events_sequence_unique" ON "order_customization_file_scan_events" USING btree ("tenant_id","intake_id","sequence");--> statement-breakpoint
CREATE INDEX "order_customization_file_scan_events_intake_idx" ON "order_customization_file_scan_events" USING btree ("tenant_id","intake_id","recorded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "order_customization_requirements_line_unique" ON "order_customization_requirements" USING btree ("tenant_id","order_line_id");--> statement-breakpoint
CREATE INDEX "order_customization_requirements_status_idx" ON "order_customization_requirements" USING btree ("tenant_id","status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "order_customization_versions_number_unique" ON "order_customization_versions" USING btree ("tenant_id","requirement_id","version_number");--> statement-breakpoint
CREATE INDEX "order_customization_versions_requirement_idx" ON "order_customization_versions" USING btree ("tenant_id","requirement_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "order_proof_decisions_external_unique" ON "order_proof_decisions" USING btree ("tenant_id","proof_version_id","external_decision_id");--> statement-breakpoint
CREATE INDEX "order_proof_decisions_proof_idx" ON "order_proof_decisions" USING btree ("tenant_id","proof_version_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "order_proof_versions_number_unique" ON "order_proof_versions" USING btree ("tenant_id","order_line_id","version_number");--> statement-breakpoint
CREATE INDEX "order_proof_versions_due_idx" ON "order_proof_versions" USING btree ("tenant_id","due_at","created_at");
--> statement-breakpoint
ALTER TABLE "order_customization_requirements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_customization_requirements" FORCE ROW LEVEL SECURITY;
CREATE POLICY "order_customization_requirements_tenant_policy" ON "order_customization_requirements" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT, UPDATE ON "order_customization_requirements" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "order_customization_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_customization_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "order_customization_versions_tenant_policy" ON "order_customization_versions" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "order_customization_versions" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "order_customization_file_intakes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_customization_file_intakes" FORCE ROW LEVEL SECURITY;
CREATE POLICY "order_customization_file_intakes_tenant_policy" ON "order_customization_file_intakes" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT, UPDATE ON "order_customization_file_intakes" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "order_customization_file_scan_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_customization_file_scan_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "order_customization_file_scan_events_tenant_policy" ON "order_customization_file_scan_events" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "order_customization_file_scan_events" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "order_proof_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_proof_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "order_proof_versions_tenant_policy" ON "order_proof_versions" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "order_proof_versions" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "order_proof_decisions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_proof_decisions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "order_proof_decisions_tenant_policy" ON "order_proof_decisions" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "order_proof_decisions" TO yummyai_app;
