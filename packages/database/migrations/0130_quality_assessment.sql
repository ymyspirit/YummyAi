ALTER TABLE quality_inspections
  ADD COLUMN assessment_version integer,
  ADD COLUMN criterion_results jsonb,
  ADD COLUMN request_checksum text,
  ADD COLUMN production_version_id uuid,
  ADD COLUMN production_projection_version integer;
--> statement-breakpoint
ALTER TABLE quality_inspections ADD CONSTRAINT quality_inspections_assessment_check CHECK (
  (assessment_version IS NULL AND criterion_results IS NULL AND request_checksum IS NULL
    AND production_version_id IS NULL AND production_projection_version IS NULL)
  OR
  (assessment_version IS NOT NULL AND assessment_version = 2 AND criterion_results IS NOT NULL
    AND jsonb_typeof(criterion_results) = 'array' AND jsonb_array_length(criterion_results) BETWEEN 1 AND 200
    AND request_checksum IS NOT NULL AND request_checksum ~ '^[a-f0-9]{64}$'
    AND production_version_id IS NOT NULL AND production_projection_version IS NOT NULL AND production_projection_version > 0)
);
--> statement-breakpoint
ALTER TABLE quality_inspections ADD CONSTRAINT quality_inspections_production_version_fk
  FOREIGN KEY (tenant_id, production_version_id) REFERENCES production_order_versions(tenant_id, id) ON DELETE RESTRICT;
--> statement-breakpoint
CREATE FUNCTION protect_quality_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'quality versions, inspections and defects are immutable' USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER quality_standard_versions_immutable BEFORE UPDATE OR DELETE ON quality_standard_versions
  FOR EACH ROW EXECUTE FUNCTION protect_quality_history();
--> statement-breakpoint
CREATE TRIGGER quality_inspections_immutable BEFORE UPDATE OR DELETE ON quality_inspections
  FOR EACH ROW EXECUTE FUNCTION protect_quality_history();
--> statement-breakpoint
CREATE TRIGGER quality_defects_immutable BEFORE UPDATE OR DELETE ON quality_defects
  FOR EACH ROW EXECUTE FUNCTION protect_quality_history();
--> statement-breakpoint
CREATE FUNCTION require_quality_assessment_on_application_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'yummyai_app' AND NEW.assessment_version IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'new quality inspection requires criterion evidence' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER quality_inspections_require_assessment BEFORE INSERT ON quality_inspections
  FOR EACH ROW EXECUTE FUNCTION require_quality_assessment_on_application_insert();
