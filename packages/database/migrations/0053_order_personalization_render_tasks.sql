CREATE TABLE "order_personalization_render_tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"batch_item_id" uuid NOT NULL,
	"design_task_id" uuid NOT NULL,
	"tool_key" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"parameter_snapshot" jsonb NOT NULL,
	"request_checksum" text NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"progress_percent" integer DEFAULT 0 NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"result_version_id" uuid,
	"model_key" text,
	"model_version" text,
	"seed" text,
	"quality_check_snapshot" jsonb,
	"error_code" text,
	"error_message" text,
	"requested_by" uuid,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_personalization_render_tasks_id_uuidv7_check" CHECK (substring("id"::text from 15 for 1) = '7'),
	CONSTRAINT "order_personalization_render_tasks_idempotency_uuidv7_check" CHECK (substring("idempotency_key"::text from 15 for 1) = '7'),
	CONSTRAINT "order_personalization_render_tasks_tool_check" CHECK ("tool_key" in ('image_composite','fulfillment_composite')),
	CONSTRAINT "order_personalization_render_tasks_status_check" CHECK ("status" in ('queued','running','awaiting_review','partially_succeeded','failed')),
	CONSTRAINT "order_personalization_render_tasks_checksum_check" CHECK ("request_checksum" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "order_personalization_render_tasks_progress_check" CHECK ("progress_percent" between 0 and 100),
	CONSTRAINT "order_personalization_render_tasks_attempt_check" CHECK ("attempt_count" >= 0 and "max_attempts" between 1 and 20 and "attempt_count" <= "max_attempts"),
	CONSTRAINT "order_personalization_render_tasks_result_check" CHECK ("status" not in ('awaiting_review','partially_succeeded') or ("result_version_id" is not null and "completed_at" is not null)),
	CONSTRAINT "order_personalization_render_tasks_failure_check" CHECK ("status" <> 'failed' or ("error_code" is not null and "error_message" is not null and "completed_at" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "order_personalization_render_tasks_tenant_id_unique" ON "order_personalization_render_tasks" ("tenant_id","id");
CREATE UNIQUE INDEX "order_personalization_render_tasks_idempotency_unique" ON "order_personalization_render_tasks" ("tenant_id","idempotency_key");
CREATE INDEX "order_personalization_render_tasks_item_idx" ON "order_personalization_render_tasks" ("tenant_id","batch_item_id","created_at");
CREATE INDEX "order_personalization_render_tasks_status_idx" ON "order_personalization_render_tasks" ("tenant_id","status","updated_at");
--> statement-breakpoint
ALTER TABLE "order_personalization_render_tasks" ADD CONSTRAINT "order_personalization_render_tasks_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "order_personalization_render_tasks" ADD CONSTRAINT "order_personalization_render_tasks_requested_by_app_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "order_personalization_render_tasks" ADD CONSTRAINT "order_personalization_render_tasks_batch_item_fk" FOREIGN KEY ("tenant_id","batch_item_id") REFERENCES "public"."order_personalization_batch_items"("tenant_id","id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "order_personalization_render_tasks" ADD CONSTRAINT "order_personalization_render_tasks_design_task_fk" FOREIGN KEY ("tenant_id","design_task_id") REFERENCES "public"."design_tasks"("tenant_id","id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "order_personalization_render_tasks" ADD CONSTRAINT "order_personalization_render_tasks_result_version_fk" FOREIGN KEY ("tenant_id","result_version_id") REFERENCES "public"."design_versions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION prevent_order_personalization_render_task_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id OR OLD.batch_item_id IS DISTINCT FROM NEW.batch_item_id
     OR OLD.design_task_id IS DISTINCT FROM NEW.design_task_id OR OLD.tool_key IS DISTINCT FROM NEW.tool_key
     OR OLD.parameter_snapshot IS DISTINCT FROM NEW.parameter_snapshot OR OLD.request_checksum IS DISTINCT FROM NEW.request_checksum
     OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key OR OLD.max_attempts IS DISTINCT FROM NEW.max_attempts
     OR OLD.requested_by IS DISTINCT FROM NEW.requested_by OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'order personalization render task input is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.status IN ('awaiting_review','partially_succeeded','failed') AND ROW(OLD.status, OLD.progress_percent, OLD.attempt_count, OLD.result_version_id, OLD.model_key, OLD.model_version, OLD.seed, OLD.quality_check_snapshot, OLD.error_code, OLD.error_message, OLD.started_at, OLD.completed_at, OLD.updated_at)
     IS DISTINCT FROM ROW(NEW.status, NEW.progress_percent, NEW.attempt_count, NEW.result_version_id, NEW.model_key, NEW.model_version, NEW.seed, NEW.quality_check_snapshot, NEW.error_code, NEW.error_message, NEW.started_at, NEW.completed_at, NEW.updated_at) THEN
    RAISE EXCEPTION 'terminal order personalization render task is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER order_personalization_render_tasks_immutable BEFORE UPDATE ON order_personalization_render_tasks FOR EACH ROW EXECUTE FUNCTION prevent_order_personalization_render_task_mutation();
CREATE TRIGGER order_personalization_render_tasks_no_delete BEFORE DELETE ON order_personalization_render_tasks FOR EACH ROW EXECUTE FUNCTION prevent_pod_governance_snapshot_mutation();
--> statement-breakpoint
ALTER TABLE "order_personalization_render_tasks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_personalization_render_tasks" FORCE ROW LEVEL SECURITY;
CREATE POLICY "order_personalization_render_tasks_tenant_policy" ON "order_personalization_render_tasks" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT, UPDATE ON order_personalization_render_tasks TO yummyai_app;
