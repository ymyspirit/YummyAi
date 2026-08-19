ALTER TABLE "personalization_template_versions" ADD COLUMN "source_template_version_id" uuid;
--> statement-breakpoint
ALTER TABLE "personalization_template_versions" ADD CONSTRAINT "personalization_template_versions_source_template_fk" FOREIGN KEY ("tenant_id","source_template_version_id") REFERENCES "public"."personalization_template_versions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "personalization_template_versions" ADD CONSTRAINT "personalization_template_versions_source_template_check" CHECK (("source" = 'popular_template' and "source_template_version_id" is not null and "source_template_version_id" <> "id") or ("source" <> 'popular_template' and "source_template_version_id" is null));
--> statement-breakpoint
CREATE INDEX "personalization_template_versions_source_template_idx" ON "personalization_template_versions" ("tenant_id","source_template_version_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_personalization_template_content_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id OR OLD.template_id IS DISTINCT FROM NEW.template_id
     OR OLD.version_number IS DISTINCT FROM NEW.version_number OR OLD.name IS DISTINCT FROM NEW.name
     OR OLD.source IS DISTINCT FROM NEW.source OR OLD.source_asset_id IS DISTINCT FROM NEW.source_asset_id
     OR OLD.source_asset_version IS DISTINCT FROM NEW.source_asset_version OR OLD.source_inspection_id IS DISTINCT FROM NEW.source_inspection_id
     OR OLD.source_template_version_id IS DISTINCT FROM NEW.source_template_version_id
     OR OLD.canvas IS DISTINCT FROM NEW.canvas OR OLD.preview_asset_id IS DISTINCT FROM NEW.preview_asset_id
     OR OLD.created_by IS DISTINCT FROM NEW.created_by OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'personalization template version content is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
