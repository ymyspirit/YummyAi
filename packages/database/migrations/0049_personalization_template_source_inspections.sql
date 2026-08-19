CREATE TABLE "personalization_template_source_inspections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source_asset_id" uuid NOT NULL,
	"source_asset_version" integer NOT NULL,
	"checksum_sha256" text NOT NULL,
	"source" text NOT NULL,
	"asset_domain" text NOT NULL,
	"rights_status" text NOT NULL,
	"rights_source_kind" text,
	"idempotency_key" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"parser_key" text NOT NULL,
	"parser_version" text NOT NULL,
	"canvas" jsonb,
	"slot_snapshot" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"warning_snapshot" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error_code" text,
	"error_message" text,
	"requested_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personalization_template_source_inspections_id_uuidv7_check" CHECK (substring("personalization_template_source_inspections"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "personalization_template_source_inspections_version_check" CHECK ("personalization_template_source_inspections"."source_asset_version" > 0),
	CONSTRAINT "personalization_template_source_inspections_checksum_check" CHECK ("personalization_template_source_inspections"."checksum_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "personalization_template_source_inspections_source_check" CHECK ("personalization_template_source_inspections"."source" in ('png','psd')),
	CONSTRAINT "personalization_template_source_inspections_domain_check" CHECK ("personalization_template_source_inspections"."asset_domain" = 'authorized'),
	CONSTRAINT "personalization_template_source_inspections_rights_check" CHECK ("personalization_template_source_inspections"."rights_status" = 'approved'),
	CONSTRAINT "personalization_template_source_inspections_status_check" CHECK ("personalization_template_source_inspections"."status" in ('queued','running','completed','failed')),
	CONSTRAINT "personalization_template_source_inspections_complete_check" CHECK ("personalization_template_source_inspections"."status" <> 'completed' or ("personalization_template_source_inspections"."canvas" is not null and "personalization_template_source_inspections"."completed_at" is not null)),
	CONSTRAINT "personalization_template_source_inspections_failed_check" CHECK ("personalization_template_source_inspections"."status" <> 'failed' or ("personalization_template_source_inspections"."error_code" is not null and "personalization_template_source_inspections"."error_message" is not null and "personalization_template_source_inspections"."completed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "personalization_template_versions" ADD COLUMN "source_inspection_id" uuid;
--> statement-breakpoint
ALTER TABLE "personalization_template_source_inspections" ADD CONSTRAINT "personalization_template_source_inspections_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "personalization_template_source_inspections" ADD CONSTRAINT "personalization_template_source_inspections_asset_fk" FOREIGN KEY ("tenant_id","source_asset_id") REFERENCES "public"."asset_files"("tenant_id","id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "personalization_template_source_inspections" ADD CONSTRAINT "personalization_template_source_inspections_requested_by_app_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
CREATE UNIQUE INDEX "personalization_template_source_inspections_tenant_id_unique" ON "personalization_template_source_inspections" ("tenant_id","id");
CREATE UNIQUE INDEX "personalization_template_source_inspections_idempotency_unique" ON "personalization_template_source_inspections" ("tenant_id","idempotency_key");
CREATE INDEX "personalization_template_source_inspections_status_idx" ON "personalization_template_source_inspections" ("tenant_id","status","created_at");
CREATE INDEX "personalization_template_source_inspections_asset_idx" ON "personalization_template_source_inspections" ("tenant_id","source_asset_id","source_asset_version","created_at");
--> statement-breakpoint
ALTER TABLE "personalization_template_versions" ADD CONSTRAINT "personalization_template_versions_source_inspection_fk" FOREIGN KEY ("tenant_id","source_inspection_id") REFERENCES "public"."personalization_template_source_inspections"("tenant_id","id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "personalization_template_versions" ADD CONSTRAINT "personalization_template_versions_source_inspection_check" CHECK ("personalization_template_versions"."source" not in ('png','psd') or "personalization_template_versions"."source_inspection_id" is not null) NOT VALID;
CREATE UNIQUE INDEX "personalization_template_versions_source_inspection_unique" ON "personalization_template_versions" ("tenant_id","source_inspection_id");
--> statement-breakpoint
CREATE FUNCTION prevent_personalization_template_source_inspection_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id OR OLD.source_asset_id IS DISTINCT FROM NEW.source_asset_id
     OR OLD.source_asset_version IS DISTINCT FROM NEW.source_asset_version OR OLD.checksum_sha256 IS DISTINCT FROM NEW.checksum_sha256
     OR OLD.source IS DISTINCT FROM NEW.source OR OLD.asset_domain IS DISTINCT FROM NEW.asset_domain
     OR OLD.rights_status IS DISTINCT FROM NEW.rights_status OR OLD.rights_source_kind IS DISTINCT FROM NEW.rights_source_kind
     OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key OR OLD.parser_key IS DISTINCT FROM NEW.parser_key
     OR OLD.parser_version IS DISTINCT FROM NEW.parser_version OR OLD.requested_by IS DISTINCT FROM NEW.requested_by
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'personalization template source inspection identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.status IN ('completed','failed') AND ROW(OLD.status, OLD.canvas, OLD.slot_snapshot, OLD.warning_snapshot, OLD.error_code, OLD.error_message, OLD.started_at, OLD.completed_at, OLD.updated_at)
     IS DISTINCT FROM ROW(NEW.status, NEW.canvas, NEW.slot_snapshot, NEW.warning_snapshot, NEW.error_code, NEW.error_message, NEW.started_at, NEW.completed_at, NEW.updated_at) THEN
    RAISE EXCEPTION 'completed personalization template source inspection is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER personalization_template_source_inspections_immutable BEFORE UPDATE ON personalization_template_source_inspections FOR EACH ROW EXECUTE FUNCTION prevent_personalization_template_source_inspection_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_personalization_template_content_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id OR OLD.template_id IS DISTINCT FROM NEW.template_id
     OR OLD.version_number IS DISTINCT FROM NEW.version_number OR OLD.name IS DISTINCT FROM NEW.name
     OR OLD.source IS DISTINCT FROM NEW.source OR OLD.source_asset_id IS DISTINCT FROM NEW.source_asset_id
     OR OLD.source_asset_version IS DISTINCT FROM NEW.source_asset_version OR OLD.source_inspection_id IS DISTINCT FROM NEW.source_inspection_id
     OR OLD.canvas IS DISTINCT FROM NEW.canvas OR OLD.preview_asset_id IS DISTINCT FROM NEW.preview_asset_id
     OR OLD.created_by IS DISTINCT FROM NEW.created_by OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'personalization template version content is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
ALTER TABLE "personalization_template_source_inspections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "personalization_template_source_inspections" FORCE ROW LEVEL SECURITY;
CREATE POLICY "personalization_template_source_inspections_tenant_policy" ON "personalization_template_source_inspections" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT, UPDATE ON personalization_template_source_inspections TO yummyai_app;
