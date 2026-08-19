CREATE TABLE "pod_artwork_tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"design_task_id" uuid NOT NULL,
	"tool_key" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"parameter_snapshot" jsonb NOT NULL,
	"model_key" text,
	"model_version" text,
	"seed" text,
	"progress_percent" integer DEFAULT 0 NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"result_version_id" uuid,
	"error_code" text,
	"error_message" text,
	"quality_check_snapshot" jsonb,
	"review_snapshot" jsonb,
	"idempotency_key" uuid NOT NULL,
	"requested_by" uuid,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pod_artwork_tasks_id_uuidv7_check" CHECK (substring("pod_artwork_tasks"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "pod_artwork_tasks_idempotency_uuidv7_check" CHECK (substring("pod_artwork_tasks"."idempotency_key"::text from 15 for 1) = '7'),
	CONSTRAINT "pod_artwork_tasks_tool_check" CHECK ("pod_artwork_tasks"."tool_key" in ('pattern_crop','print_extract','background_remove','super_resolution','outpaint','crop_compress','vectorize','authorized_watermark_remove','rights_risk_scan')),
	CONSTRAINT "pod_artwork_tasks_status_check" CHECK ("pod_artwork_tasks"."status" in ('queued','running','awaiting_review','partially_succeeded','failed','blocked','approved','rejected','cancelled')),
	CONSTRAINT "pod_artwork_tasks_progress_check" CHECK ("pod_artwork_tasks"."progress_percent" between 0 and 100),
	CONSTRAINT "pod_artwork_tasks_attempt_check" CHECK ("pod_artwork_tasks"."attempt_count" >= 0 and "pod_artwork_tasks"."max_attempts" between 1 and 20 and "pod_artwork_tasks"."attempt_count" <= "pod_artwork_tasks"."max_attempts")
);
--> statement-breakpoint
CREATE TABLE "pod_artwork_task_inputs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"asset_file_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"asset_version" integer NOT NULL,
	"checksum_sha256" text NOT NULL,
	"asset_domain" text NOT NULL,
	"rights_status" text NOT NULL,
	"rights_source_kind" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pod_artwork_task_inputs_id_uuidv7_check" CHECK (substring("pod_artwork_task_inputs"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "pod_artwork_task_inputs_ordinal_check" CHECK ("pod_artwork_task_inputs"."ordinal" >= 0),
	CONSTRAINT "pod_artwork_task_inputs_version_check" CHECK ("pod_artwork_task_inputs"."asset_version" > 0),
	CONSTRAINT "pod_artwork_task_inputs_checksum_check" CHECK ("pod_artwork_task_inputs"."checksum_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "pod_artwork_task_inputs_domain_check" CHECK ("pod_artwork_task_inputs"."asset_domain" in ('research','authorized')),
	CONSTRAINT "pod_artwork_task_inputs_rights_check" CHECK ("pod_artwork_task_inputs"."rights_status" in ('unverified','approved','rejected')),
	CONSTRAINT "pod_artwork_task_inputs_rights_source_check" CHECK ("pod_artwork_task_inputs"."rights_source_kind" is null or "pod_artwork_task_inputs"."rights_source_kind" in ('owned','licensed','commissioned','ai_generated','customer_provided','competitor'))
);
--> statement-breakpoint
ALTER TABLE "pod_artwork_tasks" ADD CONSTRAINT "pod_artwork_tasks_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pod_artwork_tasks" ADD CONSTRAINT "pod_artwork_tasks_requested_by_app_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pod_artwork_tasks" ADD CONSTRAINT "pod_artwork_tasks_design_task_fk" FOREIGN KEY ("tenant_id","design_task_id") REFERENCES "public"."design_tasks"("tenant_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pod_artwork_tasks" ADD CONSTRAINT "pod_artwork_tasks_result_version_fk" FOREIGN KEY ("tenant_id","result_version_id") REFERENCES "public"."design_versions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pod_artwork_task_inputs" ADD CONSTRAINT "pod_artwork_task_inputs_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "pod_artwork_tasks_tenant_id_unique" ON "pod_artwork_tasks" USING btree ("tenant_id","id");
--> statement-breakpoint
ALTER TABLE "pod_artwork_task_inputs" ADD CONSTRAINT "pod_artwork_task_inputs_task_fk" FOREIGN KEY ("tenant_id","task_id") REFERENCES "public"."pod_artwork_tasks"("tenant_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pod_artwork_task_inputs" ADD CONSTRAINT "pod_artwork_task_inputs_asset_fk" FOREIGN KEY ("tenant_id","asset_file_id") REFERENCES "public"."asset_files"("tenant_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "pod_artwork_tasks_design_task_unique" ON "pod_artwork_tasks" USING btree ("tenant_id","design_task_id");
CREATE UNIQUE INDEX "pod_artwork_tasks_idempotency_unique" ON "pod_artwork_tasks" USING btree ("tenant_id","idempotency_key");
CREATE INDEX "pod_artwork_tasks_status_idx" ON "pod_artwork_tasks" USING btree ("tenant_id","status","updated_at");
CREATE INDEX "pod_artwork_tasks_tool_idx" ON "pod_artwork_tasks" USING btree ("tenant_id","tool_key","created_at");
CREATE UNIQUE INDEX "pod_artwork_task_inputs_tenant_id_unique" ON "pod_artwork_task_inputs" USING btree ("tenant_id","id");
CREATE UNIQUE INDEX "pod_artwork_task_inputs_ordinal_unique" ON "pod_artwork_task_inputs" USING btree ("tenant_id","task_id","ordinal");
CREATE UNIQUE INDEX "pod_artwork_task_inputs_asset_unique" ON "pod_artwork_task_inputs" USING btree ("tenant_id","task_id","asset_file_id");
CREATE INDEX "pod_artwork_task_inputs_task_idx" ON "pod_artwork_task_inputs" USING btree ("tenant_id","task_id","ordinal");
--> statement-breakpoint
CREATE FUNCTION prevent_pod_artwork_task_snapshot_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.design_task_id IS DISTINCT FROM NEW.design_task_id
     OR OLD.tool_key IS DISTINCT FROM NEW.tool_key
     OR OLD.parameter_snapshot IS DISTINCT FROM NEW.parameter_snapshot
     OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key
     OR OLD.requested_by IS DISTINCT FROM NEW.requested_by
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'pod artwork task input and parameter snapshots are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER pod_artwork_tasks_snapshot_immutable BEFORE UPDATE ON pod_artwork_tasks FOR EACH ROW EXECUTE FUNCTION prevent_pod_artwork_task_snapshot_mutation();
--> statement-breakpoint
CREATE FUNCTION prevent_pod_artwork_task_input_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'pod artwork task inputs are immutable' USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER pod_artwork_task_inputs_immutable BEFORE UPDATE OR DELETE ON pod_artwork_task_inputs FOR EACH ROW EXECUTE FUNCTION prevent_pod_artwork_task_input_mutation();
--> statement-breakpoint
ALTER TABLE "pod_artwork_tasks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pod_artwork_tasks" FORCE ROW LEVEL SECURITY;
CREATE POLICY "pod_artwork_tasks_tenant_policy" ON "pod_artwork_tasks" FOR ALL TO yummyai_app
  USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
ALTER TABLE "pod_artwork_task_inputs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pod_artwork_task_inputs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "pod_artwork_task_inputs_tenant_policy" ON "pod_artwork_task_inputs" FOR ALL TO yummyai_app
  USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT, UPDATE ON pod_artwork_tasks TO yummyai_app;
GRANT SELECT, INSERT ON pod_artwork_task_inputs TO yummyai_app;
