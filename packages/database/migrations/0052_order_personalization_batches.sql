CREATE TABLE "order_personalization_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"request_checksum" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"item_count" integer NOT NULL,
	"prepared_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"error_message" text,
	"requested_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_personalization_batches_id_uuidv7_check" CHECK (substring("id"::text from 15 for 1) = '7'),
	CONSTRAINT "order_personalization_batches_idempotency_uuidv7_check" CHECK (substring("idempotency_key"::text from 15 for 1) = '7'),
	CONSTRAINT "order_personalization_batches_checksum_check" CHECK ("request_checksum" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "order_personalization_batches_status_check" CHECK ("status" in ('queued','running','completed','partially_succeeded','failed')),
	CONSTRAINT "order_personalization_batches_count_check" CHECK ("item_count" between 1 and 100 and "prepared_count" >= 0 and "failed_count" >= 0 and "prepared_count" + "failed_count" <= "item_count"),
	CONSTRAINT "order_personalization_batches_terminal_check" CHECK (
		("status" = 'completed' and "prepared_count" = "item_count" and "failed_count" = 0 and "completed_at" is not null)
		or ("status" = 'partially_succeeded' and "prepared_count" > 0 and "failed_count" > 0 and "prepared_count" + "failed_count" = "item_count" and "completed_at" is not null)
		or ("status" = 'failed' and "failed_count" = "item_count" and "completed_at" is not null)
		or "status" in ('queued','running')
	)
);
--> statement-breakpoint
CREATE TABLE "order_personalization_batch_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"order_id" uuid NOT NULL,
	"order_line_id" uuid NOT NULL,
	"customization_version_id" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"template_version_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"encrypted_resolution" text,
	"resolution_checksum" text,
	"resolved_slot_count" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"error_message" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_personalization_batch_items_id_uuidv7_check" CHECK (substring("id"::text from 15 for 1) = '7'),
	CONSTRAINT "order_personalization_batch_items_ordinal_check" CHECK ("ordinal" between 0 and 99),
	CONSTRAINT "order_personalization_batch_items_status_check" CHECK ("status" in ('queued','running','prepared','failed')),
	CONSTRAINT "order_personalization_batch_items_slot_count_check" CHECK ("resolved_slot_count" between 0 and 500),
	CONSTRAINT "order_personalization_batch_items_resolution_checksum_check" CHECK ("resolution_checksum" is null or "resolution_checksum" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "order_personalization_batch_items_prepared_check" CHECK ("status" <> 'prepared' or ("template_version_id" is not null and "encrypted_resolution" is not null and "resolution_checksum" is not null and "completed_at" is not null)),
	CONSTRAINT "order_personalization_batch_items_failed_check" CHECK ("status" <> 'failed' or ("error_code" is not null and "error_message" is not null and "completed_at" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "order_personalization_batches_tenant_id_unique" ON "order_personalization_batches" ("tenant_id","id");
--> statement-breakpoint
ALTER TABLE "order_personalization_batches" ADD CONSTRAINT "order_personalization_batches_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "order_personalization_batches" ADD CONSTRAINT "order_personalization_batches_requested_by_app_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "order_personalization_batch_items" ADD CONSTRAINT "order_personalization_batch_items_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "order_personalization_batch_items" ADD CONSTRAINT "order_personalization_batch_items_batch_fk" FOREIGN KEY ("tenant_id","batch_id") REFERENCES "public"."order_personalization_batches"("tenant_id","id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "order_personalization_batch_items" ADD CONSTRAINT "order_personalization_batch_items_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "order_personalization_batch_items" ADD CONSTRAINT "order_personalization_batch_items_order_line_fk" FOREIGN KEY ("tenant_id","order_line_id") REFERENCES "public"."order_lines"("tenant_id","id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "order_personalization_batch_items" ADD CONSTRAINT "order_personalization_batch_items_customization_fk" FOREIGN KEY ("tenant_id","customization_version_id") REFERENCES "public"."order_customization_versions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "order_personalization_batch_items" ADD CONSTRAINT "order_personalization_batch_items_binding_fk" FOREIGN KEY ("tenant_id","binding_id") REFERENCES "public"."sku_template_bindings"("tenant_id","id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "order_personalization_batch_items" ADD CONSTRAINT "order_personalization_batch_items_template_fk" FOREIGN KEY ("tenant_id","template_version_id") REFERENCES "public"."personalization_template_versions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "order_personalization_batches_idempotency_unique" ON "order_personalization_batches" ("tenant_id","idempotency_key");
CREATE INDEX "order_personalization_batches_status_idx" ON "order_personalization_batches" ("tenant_id","status","created_at");
CREATE UNIQUE INDEX "order_personalization_batch_items_tenant_id_unique" ON "order_personalization_batch_items" ("tenant_id","id");
CREATE UNIQUE INDEX "order_personalization_batch_items_ordinal_unique" ON "order_personalization_batch_items" ("tenant_id","batch_id","ordinal");
CREATE UNIQUE INDEX "order_personalization_batch_items_order_line_unique" ON "order_personalization_batch_items" ("tenant_id","batch_id","order_line_id");
CREATE INDEX "order_personalization_batch_items_status_idx" ON "order_personalization_batch_items" ("tenant_id","batch_id","status","ordinal");
--> statement-breakpoint
CREATE FUNCTION prevent_order_personalization_batch_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key
     OR OLD.request_checksum IS DISTINCT FROM NEW.request_checksum OR OLD.item_count IS DISTINCT FROM NEW.item_count
     OR OLD.requested_by IS DISTINCT FROM NEW.requested_by OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'order personalization batch identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.status IN ('completed','partially_succeeded','failed') AND ROW(OLD.status, OLD.prepared_count, OLD.failed_count, OLD.error_code, OLD.error_message, OLD.started_at, OLD.completed_at, OLD.updated_at)
     IS DISTINCT FROM ROW(NEW.status, NEW.prepared_count, NEW.failed_count, NEW.error_code, NEW.error_message, NEW.started_at, NEW.completed_at, NEW.updated_at) THEN
    RAISE EXCEPTION 'terminal order personalization batch is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER order_personalization_batches_immutable BEFORE UPDATE ON order_personalization_batches FOR EACH ROW EXECUTE FUNCTION prevent_order_personalization_batch_mutation();
--> statement-breakpoint
CREATE FUNCTION prevent_order_personalization_batch_item_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id OR OLD.batch_id IS DISTINCT FROM NEW.batch_id
     OR OLD.ordinal IS DISTINCT FROM NEW.ordinal OR OLD.order_id IS DISTINCT FROM NEW.order_id
     OR OLD.order_line_id IS DISTINCT FROM NEW.order_line_id OR OLD.customization_version_id IS DISTINCT FROM NEW.customization_version_id
     OR OLD.binding_id IS DISTINCT FROM NEW.binding_id OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'order personalization batch item identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.status IN ('prepared','failed') AND ROW(OLD.template_version_id, OLD.status, OLD.encrypted_resolution, OLD.resolution_checksum, OLD.resolved_slot_count, OLD.error_code, OLD.error_message, OLD.started_at, OLD.completed_at, OLD.updated_at)
     IS DISTINCT FROM ROW(NEW.template_version_id, NEW.status, NEW.encrypted_resolution, NEW.resolution_checksum, NEW.resolved_slot_count, NEW.error_code, NEW.error_message, NEW.started_at, NEW.completed_at, NEW.updated_at) THEN
    RAISE EXCEPTION 'terminal order personalization batch item is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER order_personalization_batch_items_immutable BEFORE UPDATE ON order_personalization_batch_items FOR EACH ROW EXECUTE FUNCTION prevent_order_personalization_batch_item_mutation();
--> statement-breakpoint
CREATE TRIGGER order_personalization_batches_no_delete BEFORE DELETE ON order_personalization_batches FOR EACH ROW EXECUTE FUNCTION prevent_pod_governance_snapshot_mutation();
CREATE TRIGGER order_personalization_batch_items_no_delete BEFORE DELETE ON order_personalization_batch_items FOR EACH ROW EXECUTE FUNCTION prevent_pod_governance_snapshot_mutation();
--> statement-breakpoint
ALTER TABLE "order_personalization_batches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_personalization_batches" FORCE ROW LEVEL SECURITY;
CREATE POLICY "order_personalization_batches_tenant_policy" ON "order_personalization_batches" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
ALTER TABLE "order_personalization_batch_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_personalization_batch_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY "order_personalization_batch_items_tenant_policy" ON "order_personalization_batch_items" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT, UPDATE ON order_personalization_batches, order_personalization_batch_items TO yummyai_app;
