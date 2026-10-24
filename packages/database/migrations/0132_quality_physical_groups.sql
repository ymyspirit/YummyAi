ALTER TABLE quality_inspections DROP CONSTRAINT quality_inspections_assessment_check;
--> statement-breakpoint
ALTER TABLE quality_inspections ADD CONSTRAINT quality_inspections_assessment_check CHECK (
  (assessment_version IS NULL AND criterion_results IS NULL AND request_checksum IS NULL AND production_version_id IS NULL AND production_projection_version IS NULL)
  OR (assessment_version IS NOT NULL AND assessment_version=2 AND criterion_results IS NOT NULL AND jsonb_typeof(criterion_results)='array'
    AND jsonb_array_length(criterion_results) BETWEEN 1 AND 200 AND request_checksum IS NOT NULL AND request_checksum ~ '^[a-f0-9]{64}$'
    AND production_version_id IS NOT NULL AND production_projection_version IS NOT NULL AND production_projection_version>0)
  OR (assessment_version IS NOT NULL AND assessment_version=3 AND criterion_results IS NULL
    AND request_checksum IS NOT NULL AND request_checksum ~ '^[a-f0-9]{64}$' AND production_version_id IS NOT NULL
    AND production_projection_version IS NOT NULL AND production_projection_version>0 AND inspected_by IS NOT NULL)
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION require_quality_assessment_on_application_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user='yummyai_app' AND (NEW.assessment_version IS NULL OR NEW.assessment_version NOT IN (2,3)) THEN
    RAISE EXCEPTION 'new quality inspection requires criterion or physical group evidence' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE UNIQUE INDEX quality_inspections_group_source_unique ON quality_inspections(tenant_id,id,production_order_id,production_version_id,assessment_version);
--> statement-breakpoint
CREATE UNIQUE INDEX quality_defects_group_source_unique ON quality_defects(tenant_id,id,inspection_id,production_order_id);
--> statement-breakpoint
CREATE UNIQUE INDEX production_recovery_cases_group_source_unique ON production_recovery_cases(tenant_id,id,original_production_order_id);
--> statement-breakpoint
CREATE UNIQUE INDEX production_orders_parent_proof_unique ON production_orders(tenant_id,id,parent_production_order_id);
--> statement-breakpoint
CREATE UNIQUE INDEX production_versions_quantity_proof_unique ON production_order_versions(tenant_id,id,production_order_id,quantity);
--> statement-breakpoint
CREATE TABLE quality_inspection_groups (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  production_order_id uuid NOT NULL, production_version_id uuid NOT NULL, inspection_id uuid NOT NULL, assessment_version integer NOT NULL DEFAULT 3,
  group_key text NOT NULL, label text NOT NULL, quantity integer NOT NULL, segregation_confirmed boolean NOT NULL,
  result text NOT NULL, score_bps integer NOT NULL, criterion_results jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT quality_groups_uuid_check CHECK (substring(id::text from 15 for 1)='7'),
  CONSTRAINT quality_groups_segregation_check CHECK (segregation_confirmed IS TRUE),
  CONSTRAINT quality_groups_values_check CHECK (quantity BETWEEN 1 AND 100000 AND assessment_version=3 AND result IN ('passed','failed')
    AND score_bps BETWEEN 0 AND 10000 AND length(btrim(label)) BETWEEN 1 AND 160 AND group_key ~ '^[A-Za-z0-9_-]{1,100}$'
    AND jsonb_typeof(criterion_results)='array' AND jsonb_array_length(criterion_results) BETWEEN 1 AND 200),
  CONSTRAINT quality_groups_inspection_fk FOREIGN KEY (tenant_id,inspection_id,production_order_id,production_version_id,assessment_version)
    REFERENCES quality_inspections(tenant_id,id,production_order_id,production_version_id,assessment_version) ON DELETE RESTRICT,
  CONSTRAINT quality_groups_tenant_id_unique UNIQUE (tenant_id,id),
  CONSTRAINT quality_groups_key_unique UNIQUE (tenant_id,inspection_id,group_key),
  CONSTRAINT quality_groups_source_unique UNIQUE (tenant_id,id,production_order_id,production_version_id),
  CONSTRAINT quality_groups_inspection_source_unique UNIQUE (tenant_id,id,inspection_id,production_order_id),
  CONSTRAINT quality_groups_quantity_proof_unique UNIQUE (tenant_id,id,inspection_id,production_order_id,quantity),
  CONSTRAINT quality_groups_passed_proof_unique UNIQUE (tenant_id,id,production_order_id,production_version_id,inspection_id,result)
);
--> statement-breakpoint
CREATE UNIQUE INDEX quality_groups_label_unique ON quality_inspection_groups(tenant_id,inspection_id,lower(normalize(btrim(label),NFKC)));
--> statement-breakpoint
CREATE INDEX quality_groups_production_idx ON quality_inspection_groups(tenant_id,production_order_id,created_at);
--> statement-breakpoint
CREATE TABLE quality_group_defects (
  defect_id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  quality_group_id uuid NOT NULL, production_order_id uuid NOT NULL, inspection_id uuid NOT NULL, affected_quantity integer NOT NULL,
  CONSTRAINT quality_group_defects_quantity_check CHECK (affected_quantity>0),
  CONSTRAINT quality_group_defects_defect_fk FOREIGN KEY (tenant_id,defect_id,inspection_id,production_order_id)
    REFERENCES quality_defects(tenant_id,id,inspection_id,production_order_id) ON DELETE RESTRICT,
  CONSTRAINT quality_group_defects_quantity_fk FOREIGN KEY (tenant_id,quality_group_id,inspection_id,production_order_id,affected_quantity)
    REFERENCES quality_inspection_groups(tenant_id,id,inspection_id,production_order_id,quantity) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE quality_group_reinspections (
  parent_group_id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  inspection_id uuid NOT NULL, production_order_id uuid NOT NULL, production_version_id uuid NOT NULL, assessment_version integer NOT NULL DEFAULT 3,
  CONSTRAINT quality_group_reinspections_format_check CHECK (assessment_version=3),
  CONSTRAINT quality_group_reinspections_inspection_unique UNIQUE (tenant_id,inspection_id),
  CONSTRAINT quality_group_reinspections_parent_fk FOREIGN KEY (tenant_id,parent_group_id,production_order_id,production_version_id)
    REFERENCES quality_inspection_groups(tenant_id,id,production_order_id,production_version_id) ON DELETE RESTRICT,
  CONSTRAINT quality_group_reinspections_inspection_fk FOREIGN KEY (tenant_id,inspection_id,production_order_id,production_version_id,assessment_version)
    REFERENCES quality_inspections(tenant_id,id,production_order_id,production_version_id,assessment_version) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE production_recovery_groups (
  recovery_case_id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  quality_group_id uuid NOT NULL, production_order_id uuid NOT NULL, production_version_id uuid NOT NULL,
  replacement_production_order_id uuid NOT NULL, replacement_production_version_id uuid NOT NULL, quantity integer NOT NULL, selection_confirmed boolean NOT NULL,
  CONSTRAINT production_recovery_groups_quantity_check CHECK (quantity>0),
  CONSTRAINT production_recovery_groups_selection_check CHECK (selection_confirmed IS TRUE),
  CONSTRAINT recovery_groups_case_fk FOREIGN KEY (tenant_id,recovery_case_id,production_order_id)
    REFERENCES production_recovery_cases(tenant_id,id,original_production_order_id) ON DELETE RESTRICT,
  CONSTRAINT recovery_groups_source_fk FOREIGN KEY (tenant_id,quality_group_id,production_order_id,production_version_id)
    REFERENCES quality_inspection_groups(tenant_id,id,production_order_id,production_version_id) ON DELETE RESTRICT,
  CONSTRAINT recovery_groups_replacement_fk FOREIGN KEY (tenant_id,replacement_production_order_id,production_order_id)
    REFERENCES production_orders(tenant_id,id,parent_production_order_id) ON DELETE RESTRICT,
  CONSTRAINT recovery_groups_replacement_quantity_fk FOREIGN KEY (tenant_id,replacement_production_version_id,replacement_production_order_id,quantity)
    REFERENCES production_order_versions(tenant_id,id,production_order_id,quantity) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE INDEX recovery_groups_source_idx ON production_recovery_groups(tenant_id,quality_group_id);
--> statement-breakpoint
DO $$ DECLARE relation_name text; BEGIN
  FOREACH relation_name IN ARRAY ARRAY['quality_inspection_groups','quality_group_defects','quality_group_reinspections','production_recovery_groups'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id=current_setting(''app.tenant_id'',true)::uuid) WITH CHECK (tenant_id=current_setting(''app.tenant_id'',true)::uuid)',relation_name);
    EXECUTE format('GRANT SELECT,INSERT ON %I TO yummyai_app',relation_name);
    EXECUTE format('CREATE TRIGGER immutable_quality_group_history BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION protect_quality_history()',relation_name);
  END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE shipment_production_allocations ADD COLUMN quality_group_id uuid, ADD COLUMN group_quality_result text;
--> statement-breakpoint
ALTER TABLE shipment_production_allocations ALTER COLUMN quality_result DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE shipment_production_allocations DROP CONSTRAINT shipment_production_allocations_quantity_check;
--> statement-breakpoint
ALTER TABLE shipment_production_allocations ADD CONSTRAINT shipment_production_allocations_quantity_check CHECK (quantity>0 AND production_projection_version>0);
--> statement-breakpoint
ALTER TABLE shipment_production_allocations ADD CONSTRAINT shipment_allocations_quality_domain_check CHECK (
  (quality_group_id IS NULL AND quality_result IS NOT NULL AND quality_result='passed' AND group_quality_result IS NULL)
  OR (quality_group_id IS NOT NULL AND quality_result IS NULL AND group_quality_result IS NOT NULL AND group_quality_result='passed')
);
--> statement-breakpoint
ALTER TABLE shipment_production_allocations ADD CONSTRAINT shipment_allocations_group_passed_fk FOREIGN KEY
  (tenant_id,quality_group_id,production_order_id,production_version_id,quality_inspection_id,group_quality_result)
  REFERENCES quality_inspection_groups(tenant_id,id,production_order_id,production_version_id,inspection_id,result) ON DELETE RESTRICT;
--> statement-breakpoint
DROP INDEX shipment_production_allocations_lot_unique;
--> statement-breakpoint
CREATE UNIQUE INDEX shipment_production_allocations_lot_unique ON shipment_production_allocations(tenant_id,package_line_id,production_order_id) WHERE quality_group_id IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX shipment_allocations_group_unique ON shipment_production_allocations(tenant_id,package_line_id,quality_group_id) WHERE quality_group_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE shipment_versions DROP CONSTRAINT shipment_versions_source_check;
--> statement-breakpoint
ALTER TABLE shipment_versions ADD CONSTRAINT shipment_versions_source_check CHECK (
  (production_source_version IS NULL AND request_checksum IS NULL) OR
  (production_source_version IS NOT NULL AND production_source_version IN (1,2) AND request_checksum IS NOT NULL AND request_checksum ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION require_shipment_production_sources() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user='yummyai_app' AND NEW.production_source_version IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'new shipment version requires current production or physical-group sources' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION check_recovery_group_quantity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_group quality_inspection_groups%ROWTYPE; occupied integer;
BEGIN
  SELECT * INTO source_group FROM quality_inspection_groups WHERE id=NEW.quality_group_id AND tenant_id=NEW.tenant_id;
  IF source_group.result IS DISTINCT FROM 'failed' OR NOT EXISTS(
    SELECT 1 FROM production_recovery_cases recovery JOIN quality_group_defects gd ON gd.defect_id=recovery.defect_id AND gd.tenant_id=recovery.tenant_id
    JOIN quality_defects defect ON defect.id=gd.defect_id AND defect.tenant_id=gd.tenant_id
    WHERE recovery.id=NEW.recovery_case_id AND recovery.tenant_id=NEW.tenant_id AND recovery.type='remake'
      AND gd.quality_group_id=NEW.quality_group_id AND defect.disposition IN ('remake','rework')) THEN
    RAISE EXCEPTION 'remake must identify its original held group and actionable defect' USING ERRCODE='23514';
  END IF;
  SELECT coalesce(sum(rg.quantity),0)::integer INTO occupied FROM production_recovery_groups rg
    JOIN production_orders child ON child.id=rg.replacement_production_order_id AND child.tenant_id=rg.tenant_id
    WHERE rg.quality_group_id=NEW.quality_group_id AND rg.tenant_id=NEW.tenant_id AND (child.status<>'cancelled' OR EXISTS(
      SELECT 1 FROM shipment_production_allocations allocation JOIN shipment_tracking_events physical ON physical.package_id=allocation.package_id AND physical.tenant_id=allocation.tenant_id
      WHERE allocation.production_order_id=child.id AND allocation.tenant_id=child.tenant_id AND physical.status IN ('picked_up','in_transit','out_for_delivery','delivered','returned')));
  IF occupied>source_group.quantity THEN
    RAISE EXCEPTION 'defects share the same physical group remake quantity' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER recovery_group_quantity AFTER INSERT ON production_recovery_groups DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_recovery_group_quantity();
--> statement-breakpoint
CREATE FUNCTION require_allocation_quality_domain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE assessment integer; source_format integer;
BEGIN
  SELECT assessment_version INTO assessment FROM quality_inspections WHERE id=NEW.quality_inspection_id AND tenant_id=NEW.tenant_id;
  SELECT production_source_version INTO source_format FROM shipment_versions WHERE id=NEW.shipment_version_id AND tenant_id=NEW.tenant_id;
  IF (NEW.quality_group_id IS NULL AND assessment IS DISTINCT FROM 2)
    OR (NEW.quality_group_id IS NOT NULL AND (assessment IS DISTINCT FROM 3 OR source_format IS DISTINCT FROM 2)) THEN
    RAISE EXCEPTION 'grouped quality requires its own physical source, legacy whole quality retains its original domain' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER shipment_allocation_quality_domain BEFORE INSERT ON shipment_production_allocations FOR EACH ROW EXECUTE FUNCTION require_allocation_quality_domain();
--> statement-breakpoint
CREATE FUNCTION check_quality_group_cover() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE inspection_id_value uuid; inspection_row quality_inspections%ROWTYPE; standard_row quality_standard_versions%ROWTYPE;
  expected_quantity integer; total_quantity integer; group_count integer; aggregate_score integer; aggregate_result text;
  group_row quality_inspection_groups%ROWTYPE; calculated_score integer; calculated_result text;
BEGIN
  IF TG_TABLE_NAME='quality_inspections' THEN inspection_id_value:=NEW.id; ELSE inspection_id_value:=NEW.inspection_id; END IF;
  SELECT * INTO inspection_row FROM quality_inspections WHERE id=inspection_id_value;
  IF inspection_row.assessment_version IS DISTINCT FROM 3 THEN RETURN NULL; END IF;
  SELECT coalesce(parent.quantity,pv.quantity) INTO expected_quantity FROM production_order_versions pv
    LEFT JOIN quality_group_reinspections scope ON scope.inspection_id=inspection_row.id AND scope.tenant_id=inspection_row.tenant_id
    LEFT JOIN quality_inspection_groups parent ON parent.id=scope.parent_group_id AND parent.tenant_id=scope.tenant_id
    WHERE pv.id=inspection_row.production_version_id AND pv.tenant_id=inspection_row.tenant_id;
  SELECT count(*),sum(quantity),round(sum(quantity::numeric*score_bps)/nullif(sum(quantity),0))::integer,
    CASE WHEN bool_and(result='passed') THEN 'passed' ELSE 'failed' END
    INTO group_count,total_quantity,aggregate_score,aggregate_result FROM quality_inspection_groups WHERE inspection_id=inspection_row.id AND tenant_id=inspection_row.tenant_id;
  IF group_count NOT BETWEEN 1 AND 100 OR total_quantity IS DISTINCT FROM expected_quantity
    OR aggregate_score IS DISTINCT FROM inspection_row.score_bps OR aggregate_result IS DISTINCT FROM inspection_row.result THEN
    RAISE EXCEPTION 'quality groups must completely cover their physical source with the actual aggregate outcome' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM quality_defects d WHERE d.inspection_id=inspection_row.id AND d.tenant_id=inspection_row.tenant_id
    AND NOT EXISTS(SELECT 1 FROM quality_group_defects gd WHERE gd.defect_id=d.id AND gd.tenant_id=d.tenant_id)) THEN
    RAISE EXCEPTION 'every grouped defect requires its explicit physical group and quantity' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM quality_group_defects gd JOIN quality_defects d ON d.id=gd.defect_id AND d.tenant_id=gd.tenant_id
    WHERE gd.inspection_id=inspection_row.id AND gd.tenant_id=inspection_row.tenant_id GROUP BY gd.quality_group_id,d.code HAVING count(*)>1) THEN
    RAISE EXCEPTION 'a defect code occurs once per physical group' USING ERRCODE='23514';
  END IF;
  SELECT * INTO standard_row FROM quality_standard_versions WHERE id=inspection_row.quality_standard_version_id AND tenant_id=inspection_row.tenant_id;
  FOR group_row IN SELECT * FROM quality_inspection_groups WHERE inspection_id=inspection_row.id AND tenant_id=inspection_row.tenant_id LOOP
    IF jsonb_array_length(group_row.criterion_results)<>jsonb_array_length(standard_row.criteria)
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(group_row.criterion_results) r WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(standard_row.criteria) c WHERE c->>'code'=r->>'code'))
      OR (SELECT count(DISTINCT r->>'code') FROM jsonb_array_elements(group_row.criterion_results) r)<>jsonb_array_length(standard_row.criteria)
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(group_row.criterion_results) r WHERE jsonb_typeof(r->'passed') IS DISTINCT FROM 'boolean'
        OR jsonb_typeof(r->'scoreBps') IS DISTINCT FROM 'number' OR (r->>'scoreBps')::numeric NOT BETWEEN 0 AND 10000 OR (r->>'scoreBps')::numeric<>trunc((r->>'scoreBps')::numeric)) THEN
      RAISE EXCEPTION 'group criterion evidence must exactly match its standard' USING ERRCODE='23514';
    END IF;
    SELECT round(sum((c->>'weightBps')::numeric*(r->>'scoreBps')::numeric)/10000)::integer INTO calculated_score
      FROM jsonb_array_elements(standard_row.criteria) c JOIN jsonb_array_elements(group_row.criterion_results) r ON r->>'code'=c->>'code';
    calculated_result:=CASE WHEN calculated_score>=standard_row.minimum_score_bps
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(standard_row.criteria) c JOIN jsonb_array_elements(group_row.criterion_results) r ON r->>'code'=c->>'code' WHERE (c->>'blocking')::boolean AND NOT (r->>'passed')::boolean)
      AND NOT EXISTS(SELECT 1 FROM quality_group_defects gd JOIN quality_defects d ON d.id=gd.defect_id AND d.tenant_id=gd.tenant_id WHERE gd.quality_group_id=group_row.id AND gd.tenant_id=group_row.tenant_id AND (d.severity='critical' OR d.disposition<>'accept'))
      THEN 'passed' ELSE 'failed' END;
    IF group_row.score_bps IS DISTINCT FROM calculated_score OR group_row.result IS DISTINCT FROM calculated_result
      OR ((calculated_result='failed' OR EXISTS(SELECT 1 FROM jsonb_array_elements(group_row.criterion_results) r WHERE NOT (r->>'passed')::boolean))
        AND NOT EXISTS(SELECT 1 FROM quality_group_defects gd WHERE gd.quality_group_id=group_row.id AND gd.tenant_id=group_row.tenant_id)) THEN
      RAISE EXCEPTION 'group outcome must follow actual criteria and defect dispositions' USING ERRCODE='23514';
    END IF;
  END LOOP;
  IF EXISTS(WITH RECURSIVE ancestry AS (
    SELECT scope.parent_group_id AS group_id,ARRAY[scope.parent_group_id] AS visited,false AS cycle FROM quality_group_reinspections scope WHERE scope.inspection_id=inspection_row.id AND scope.tenant_id=inspection_row.tenant_id
    UNION ALL SELECT scope.parent_group_id,ancestry.visited||scope.parent_group_id,scope.parent_group_id=ANY(ancestry.visited)
      FROM ancestry JOIN quality_inspection_groups g ON g.id=ancestry.group_id AND g.tenant_id=inspection_row.tenant_id
      JOIN quality_group_reinspections scope ON scope.inspection_id=g.inspection_id AND scope.tenant_id=g.tenant_id WHERE NOT ancestry.cycle)
    SELECT 1 FROM ancestry WHERE cycle) THEN
    RAISE EXCEPTION 'physical group reinspection cannot form a cycle' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DO $$ DECLARE relation_name text; BEGIN
  FOREACH relation_name IN ARRAY ARRAY['quality_inspections','quality_inspection_groups','quality_group_defects','quality_group_reinspections','quality_defects'] LOOP
    EXECUTE format('CREATE CONSTRAINT TRIGGER quality_group_complete_cover AFTER INSERT ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_quality_group_cover()',relation_name);
  END LOOP;
END $$;
