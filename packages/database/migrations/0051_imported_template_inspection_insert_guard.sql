ALTER TABLE "personalization_template_versions" DROP CONSTRAINT "personalization_template_versions_source_inspection_check";
--> statement-breakpoint
CREATE FUNCTION require_imported_template_source_inspection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source IN ('png','psd') AND NEW.source_inspection_id IS NULL THEN
    RAISE EXCEPTION 'imported personalization templates require a source inspection' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER personalization_template_source_inspection_required BEFORE INSERT ON personalization_template_versions FOR EACH ROW EXECUTE FUNCTION require_imported_template_source_inspection();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_personalization_template_source_inspection_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
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
