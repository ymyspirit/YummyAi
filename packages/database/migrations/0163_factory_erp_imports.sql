-- Factory export observations are a separate axis from physical production,
-- QC, carrier pickup and marketplace writeback. No historical backfill.
CREATE TABLE factory_erp_imports (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES organizations(id),factory_id uuid NOT NULL,
 file_checksum text NOT NULL,byte_size integer NOT NULL,object_key text NOT NULL,stored_checksum text NOT NULL,
 preview_checksum text NOT NULL,encrypted_payload text NOT NULL,source_claims jsonb NOT NULL,source_proof text NOT NULL,idempotency_key uuid NOT NULL,request_checksum text NOT NULL,
 created_by uuid NOT NULL REFERENCES app_users(id),creation_transaction_id text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,
 CONSTRAINT factory_erp_imports_factory_fk FOREIGN KEY(tenant_id,factory_id) REFERENCES fulfillment_factories(tenant_id,id),
 CONSTRAINT factory_erp_imports_bytes CHECK(byte_size BETWEEN 1 AND 5242880),
 CONSTRAINT factory_erp_imports_hash CHECK(file_checksum~'^[a-f0-9]{64}$' AND stored_checksum~'^[a-f0-9]{64}$' AND preview_checksum~'^[a-f0-9]{64}$' AND request_checksum~'^[a-f0-9]{64}$')
);
CREATE UNIQUE INDEX factory_erp_imports_scope ON factory_erp_imports(tenant_id,id);
CREATE UNIQUE INDEX factory_erp_imports_request ON factory_erp_imports(tenant_id,idempotency_key);
CREATE INDEX factory_erp_imports_factory ON factory_erp_imports(tenant_id,factory_id,created_at,id);
CREATE TABLE factory_erp_applications (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES organizations(id),import_id uuid NOT NULL,idempotency_key uuid NOT NULL,
 request_canonical text NOT NULL,request_checksum text NOT NULL,input jsonb NOT NULL,result jsonb NOT NULL,
 created_by uuid NOT NULL REFERENCES app_users(id),creation_transaction_id text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT factory_erp_applications_import_fk FOREIGN KEY(tenant_id,import_id) REFERENCES factory_erp_imports(tenant_id,id),
 CONSTRAINT factory_erp_applications_hash CHECK(request_checksum=encode(sha256(convert_to(request_canonical,'UTF8')),'hex'))
);
CREATE UNIQUE INDEX factory_erp_applications_scope ON factory_erp_applications(tenant_id,id);
CREATE UNIQUE INDEX factory_erp_applications_request ON factory_erp_applications(tenant_id,idempotency_key);
CREATE UNIQUE INDEX factory_erp_applications_birth ON factory_erp_applications(tenant_id,creation_transaction_id);
CREATE TABLE factory_erp_bindings (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES organizations(id),factory_id uuid NOT NULL,external_key text NOT NULL,
 encrypted_payload text NOT NULL,items_checksum text NOT NULL,quantity integer NOT NULL,application_id uuid NOT NULL,
 created_by uuid NOT NULL REFERENCES app_users(id),creation_transaction_id text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT factory_erp_bindings_factory_fk FOREIGN KEY(tenant_id,factory_id) REFERENCES fulfillment_factories(tenant_id,id),
 CONSTRAINT factory_erp_bindings_application_fk FOREIGN KEY(tenant_id,application_id) REFERENCES factory_erp_applications(tenant_id,id),
 CONSTRAINT factory_erp_bindings_quantity CHECK(quantity BETWEEN 1 AND 100000),
 CONSTRAINT factory_erp_bindings_hash CHECK(external_key~'^[a-f0-9]{64}$' AND items_checksum~'^[a-f0-9]{64}$')
);
CREATE UNIQUE INDEX factory_erp_bindings_scope ON factory_erp_bindings(tenant_id,id);
CREATE UNIQUE INDEX factory_erp_bindings_external ON factory_erp_bindings(tenant_id,factory_id,external_key);
CREATE TABLE factory_erp_binding_items (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES organizations(id),binding_id uuid NOT NULL,delivery_item_id uuid NOT NULL,
 production_order_id uuid NOT NULL,production_version_id uuid NOT NULL,file_checksum text NOT NULL,manufacturing_checksum text NOT NULL,quantity integer NOT NULL,
 CONSTRAINT factory_erp_binding_items_binding_fk FOREIGN KEY(tenant_id,binding_id) REFERENCES factory_erp_bindings(tenant_id,id),
 CONSTRAINT factory_erp_binding_items_delivery_fk FOREIGN KEY(tenant_id,delivery_item_id) REFERENCES production_delivery_items(tenant_id,id),
 CONSTRAINT factory_erp_binding_items_quantity CHECK(quantity BETWEEN 1 AND 100000)
);
CREATE UNIQUE INDEX factory_erp_binding_items_scope ON factory_erp_binding_items(tenant_id,id);
CREATE UNIQUE INDEX factory_erp_binding_items_delivery ON factory_erp_binding_items(tenant_id,delivery_item_id);
CREATE UNIQUE INDEX factory_erp_binding_items_version ON factory_erp_binding_items(tenant_id,production_order_id,production_version_id);
CREATE TABLE factory_erp_observations (
 id uuid PRIMARY KEY,sequence bigint GENERATED ALWAYS AS IDENTITY NOT NULL,tenant_id uuid NOT NULL REFERENCES organizations(id),binding_id uuid NOT NULL,
 application_id uuid NOT NULL,import_id uuid NOT NULL,row_number integer NOT NULL,row_checksum text NOT NULL,raw_status text NOT NULL,encrypted_payload text NOT NULL,
 created_by uuid NOT NULL REFERENCES app_users(id),creation_transaction_id text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT factory_erp_observations_binding_fk FOREIGN KEY(tenant_id,binding_id) REFERENCES factory_erp_bindings(tenant_id,id),
 CONSTRAINT factory_erp_observations_application_fk FOREIGN KEY(tenant_id,application_id) REFERENCES factory_erp_applications(tenant_id,id),
 CONSTRAINT factory_erp_observations_import_fk FOREIGN KEY(tenant_id,import_id) REFERENCES factory_erp_imports(tenant_id,id),
 CONSTRAINT factory_erp_observations_status CHECK(raw_status IN ('已审核','已出库','已作废') AND row_number BETWEEN 2 AND 5001 AND row_checksum~'^[a-f0-9]{64}$')
);
CREATE UNIQUE INDEX factory_erp_observations_scope ON factory_erp_observations(tenant_id,id);
CREATE UNIQUE INDEX factory_erp_observations_fact ON factory_erp_observations(tenant_id,binding_id,row_checksum);
CREATE INDEX factory_erp_observations_history ON factory_erp_observations(tenant_id,binding_id,sequence);
CREATE TABLE factory_erp_application_rows (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES organizations(id),application_id uuid NOT NULL,row_number integer NOT NULL,binding_id uuid NOT NULL,observation_id uuid NOT NULL,disposition text NOT NULL,
 CONSTRAINT factory_erp_application_rows_application_fk FOREIGN KEY(tenant_id,application_id) REFERENCES factory_erp_applications(tenant_id,id),
 CONSTRAINT factory_erp_application_rows_binding_fk FOREIGN KEY(tenant_id,binding_id) REFERENCES factory_erp_bindings(tenant_id,id),
 CONSTRAINT factory_erp_application_rows_observation_fk FOREIGN KEY(tenant_id,observation_id) REFERENCES factory_erp_observations(tenant_id,id),
 CONSTRAINT factory_erp_application_rows_disposition CHECK(disposition IN ('advanced','unchanged','exception') AND row_number BETWEEN 2 AND 5001)
);
CREATE UNIQUE INDEX factory_erp_application_rows_number ON factory_erp_application_rows(tenant_id,application_id,row_number);
--> statement-breakpoint
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['factory_erp_imports','factory_erp_applications','factory_erp_bindings','factory_erp_binding_items','factory_erp_observations','factory_erp_application_rows'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
  EXECUTE format('GRANT SELECT,INSERT ON %I TO yummyai_app',t);
  EXECUTE format('CREATE TRIGGER factory_erp_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION factory_capacity_immutable()',t);
 END LOOP;
END $$;
GRANT USAGE,SELECT ON SEQUENCE factory_erp_observations_sequence_seq TO yummyai_app;
--> statement-breakpoint
CREATE FUNCTION factory_erp_require_authority(tenant uuid,actor uuid) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE p text;
BEGIN
 IF tenant IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid OR actor IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid
  THEN RAISE EXCEPTION 'factory_erp_actor_invalid' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM memberships m JOIN membership_roles mr ON mr.tenant_id=m.tenant_id AND mr.membership_id=m.id
  JOIN roles r ON r.tenant_id=mr.tenant_id AND r.id=mr.role_id WHERE m.tenant_id=tenant AND m.user_id=actor FOR SHARE OF m,mr,r;
 FOREACH p IN ARRAY ARRAY['order:read','order:write','order:pii:read','asset:read','design:read'] LOOP
  IF NOT EXISTS(SELECT 1 FROM memberships m JOIN membership_roles mr ON mr.tenant_id=m.tenant_id AND mr.membership_id=m.id JOIN roles r ON r.tenant_id=mr.tenant_id AND r.id=mr.role_id
   WHERE m.tenant_id=tenant AND m.user_id=actor AND m.status='active' AND r.data_scope='tenant' AND(r.permissions?p OR r.permissions?'*'))
   THEN RAISE EXCEPTION 'factory_erp_current_authority_required' USING ERRCODE='23514'; END IF;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION factory_erp_require_authority(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION factory_erp_require_authority(uuid,uuid) TO yummyai_app;
CREATE FUNCTION factory_erp_delivery_current(tenant uuid,item_identity uuid,factory_identity uuid) RETURNS boolean LANGUAGE sql VOLATILE SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM production_delivery_items i JOIN production_delivery_packages d ON d.tenant_id=i.tenant_id AND d.id=i.package_id
  JOIN production_orders p ON p.tenant_id=i.tenant_id AND p.id=i.production_order_id
  JOIN production_order_versions v ON v.tenant_id=i.tenant_id AND v.id=i.production_version_id AND v.production_order_id=p.id
  JOIN order_work_items w ON w.tenant_id=i.tenant_id AND w.id=i.work_item_id
  JOIN order_lines ol ON ol.tenant_id=w.tenant_id AND ol.id=w.id JOIN orders o ON o.tenant_id=ol.tenant_id AND o.id=ol.order_id
  JOIN order_work_revisions wr ON wr.tenant_id=w.tenant_id AND wr.id=i.work_revision_id AND wr.work_item_id=w.id
  JOIN production_editor_projects ep ON ep.tenant_id=i.tenant_id AND ep.id=i.editor_project_id
  JOIN production_editor_renders er ON er.tenant_id=i.tenant_id AND er.id=i.render_id AND er.project_id=ep.id AND er.version_id=i.editor_version_id
  JOIN production_manufacturing_bindings mb ON mb.tenant_id=i.tenant_id AND mb.id=i.manufacturing_binding_id AND mb.production_version_id=v.id
  WHERE i.tenant_id=tenant AND i.id=item_identity AND d.factory_id=factory_identity AND p.factory_id=factory_identity AND v.factory_id=factory_identity
   AND p.current_version_number=v.version_number AND p.status NOT IN('failed','quality_hold','cancel_requested','cancelled')
   AND i.manufacturing_plan_checksum IS NOT NULL AND mb.content_checksum=i.manufacturing_content_checksum AND mb.quantity=v.quantity
   AND w.encrypted_data_key IS NOT NULL AND w.expires_at>clock_timestamp() AND w.archived_at IS NULL AND NOT w.held AND o.side_state IS NULL AND o.address_status<>'anonymized'
   AND w.pushed_revision_id=wr.id AND w.revision=wr.revision AND w.editor_project_id=ep.id AND w.artwork='approved' AND w.approved_editor_version_id=i.editor_version_id
   AND(w.proof='not_required' OR(w.proof='approved' AND w.proof_editor_version_id=i.editor_version_id))
   AND ep.status='active' AND ep.encrypted_data_key IS NOT NULL AND(ep.expires_at IS NULL OR ep.expires_at>clock_timestamp())
   AND ep.current_version_id=i.editor_version_id AND ep.reviewed_version_id=i.editor_version_id AND ep.source_work_item_id=w.id AND ep.source_work_revision_id=wr.id AND er.status='completed'
   AND(w.report_line_id IS NULL OR EXISTS(SELECT 1 FROM amazon_order_report_lines ar WHERE ar.tenant_id=tenant AND ar.id=w.report_line_id AND ar.current_version_id IS NOT DISTINCT FROM wr.source_version_id AND ar.expires_at>clock_timestamp()))
   AND EXISTS(SELECT 1 FROM production_delivery_feedback f WHERE f.tenant_id=tenant AND f.item_id=i.id AND f.kind='submitted')
   AND(SELECT f.kind FROM production_delivery_feedback f WHERE f.tenant_id=tenant AND f.item_id=i.id AND f.kind<>'rework' ORDER BY f.sequence DESC LIMIT 1)<>'rejected')
$$;
REVOKE ALL ON FUNCTION factory_erp_delivery_current(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION factory_erp_delivery_current(uuid,uuid,uuid) TO yummyai_app;
--> statement-breakpoint
CREATE FUNCTION factory_erp_apply_input_valid(value jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE r jsonb;i jsonb;row_numbers integer[]:=ARRAY[]::integer[];items text[]:=ARRAY[]::text[];productions text[]:=ARRAY[]::text[];k text;
BEGIN
 IF jsonb_typeof(value) IS DISTINCT FROM 'object' OR NOT value?&ARRAY['fileChecksum','previewChecksum','idempotencyKey','rows','confirmed'] OR value-ARRAY['fileChecksum','previewChecksum','idempotencyKey','rows','confirmed']<>'{}'::jsonb
  OR value->'confirmed' IS DISTINCT FROM 'true'::jsonb OR value->>'fileChecksum'!~'^[a-f0-9]{64}$' OR value->>'previewChecksum'!~'^[a-f0-9]{64}$'
  OR jsonb_typeof(value->'rows') IS DISTINCT FROM 'array' OR jsonb_array_length(value->'rows') NOT BETWEEN 1 AND 5000 THEN RETURN false;END IF;
 FOR r IN SELECT x FROM jsonb_array_elements(value->'rows') x LOOP
  IF jsonb_typeof(r) IS DISTINCT FROM 'object' OR NOT r?&ARRAY['rowNumber','items','wholeGroupConfirmed'] OR r-ARRAY['rowNumber','items','wholeGroupConfirmed']<>'{}'::jsonb
   OR jsonb_typeof(r->'rowNumber') IS DISTINCT FROM 'number' OR(r->>'rowNumber')!~'^\d+$' OR(r->>'rowNumber')::integer NOT BETWEEN 2 AND 5001
   OR(r->>'rowNumber')::integer=ANY(row_numbers) OR r->'wholeGroupConfirmed' IS DISTINCT FROM 'true'::jsonb OR jsonb_typeof(r->'items') IS DISTINCT FROM 'array' OR jsonb_array_length(r->'items') NOT BETWEEN 1 AND 50 THEN RETURN false;END IF;
  row_numbers:=array_append(row_numbers,(r->>'rowNumber')::integer);
  FOR i IN SELECT x FROM jsonb_array_elements(r->'items') x LOOP
   IF jsonb_typeof(i) IS DISTINCT FROM 'object' OR NOT i?&ARRAY['deliveryItemId','productionOrderId','productionVersionId','fileChecksum','manufacturingChecksum'] OR i-ARRAY['deliveryItemId','productionOrderId','productionVersionId','fileChecksum','manufacturingChecksum']<>'{}'::jsonb THEN RETURN false;END IF;
   FOREACH k IN ARRAY ARRAY['deliveryItemId','productionOrderId','productionVersionId'] LOOP
    IF jsonb_typeof(i->k) IS DISTINCT FROM 'string' OR i->>k!~'^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' THEN RETURN false;END IF;
   END LOOP;
   IF i->>'fileChecksum'!~'^[a-f0-9]{64}$' OR i->>'manufacturingChecksum'!~'^[a-f0-9]{64}$' OR(i->>'deliveryItemId')=ANY(items) OR(i->>'productionOrderId')=ANY(productions) THEN RETURN false;END IF;
   items:=array_append(items,i->>'deliveryItemId');productions:=array_append(productions,i->>'productionOrderId');
  END LOOP;
 END LOOP;RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
--> statement-breakpoint
CREATE FUNCTION guard_factory_erp_record() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE a factory_erp_applications;b factory_erp_bindings;i production_delivery_items;f factory_erp_imports;xid text:=pg_current_xact_id()::text;claim jsonb;
BEGIN
 IF TG_TABLE_NAME='factory_erp_imports' THEN
  PERFORM factory_erp_require_authority(NEW.tenant_id,NEW.created_by);
  IF NEW.creation_transaction_id IS DISTINCT FROM xid OR NEW.object_key IS DISTINCT FROM 'tenants/'||NEW.tenant_id::text||'/order/'||NEW.stored_checksum||'/'||NEW.id::text||'-factory-erp-source.pe'
   OR jsonb_typeof(NEW.source_claims) IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.source_claims) NOT BETWEEN 1 AND 5000 OR length(NEW.source_proof)<20
   OR NOT EXISTS(SELECT 1 FROM fulfillment_factories ff JOIN fulfillment_suppliers s ON s.tenant_id=ff.tenant_id AND s.id=ff.supplier_id WHERE ff.tenant_id=NEW.tenant_id AND ff.id=NEW.factory_id AND ff.status='active' AND s.status='active')
   THEN RAISE EXCEPTION 'factory_erp_source_invalid' USING ERRCODE='23514';END IF;
  NEW.created_at:=clock_timestamp();NEW.expires_at:=NEW.created_at+interval '30 days';RETURN NEW;
 END IF;
 IF TG_TABLE_NAME='factory_erp_applications' THEN
  PERFORM factory_erp_require_authority(NEW.tenant_id,NEW.created_by);
  SELECT * INTO f FROM factory_erp_imports WHERE tenant_id=NEW.tenant_id AND id=NEW.import_id;
  PERFORM pg_advisory_xact_lock(hashtextextended('factory-erp-apply:'||NEW.tenant_id::text||':'||f.factory_id::text,0));
  IF NEW.creation_transaction_id IS DISTINCT FROM xid OR f.id IS NULL OR f.expires_at<=clock_timestamp() OR NOT factory_erp_apply_input_valid(NEW.input)
   OR NEW.input->>'fileChecksum' IS DISTINCT FROM f.file_checksum OR NEW.input->>'previewChecksum' IS DISTINCT FROM f.preview_checksum
   OR NEW.input->'confirmed' IS DISTINCT FROM 'true'::jsonb OR NEW.input->>'idempotencyKey' IS DISTINCT FROM NEW.idempotency_key::text
   OR jsonb_typeof(NEW.input->'rows') IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.input->'rows') NOT BETWEEN 1 AND 5000
   OR NEW.request_canonical::jsonb IS DISTINCT FROM jsonb_build_object('version',1,'operation','factory-erp-apply','importId',NEW.import_id,'input',NEW.input)
   OR NEW.result->>'id' IS DISTINCT FROM NEW.id::text OR NEW.result->>'importId' IS DISTINCT FROM NEW.import_id::text
   OR NEW.result->>'requestChecksum' IS DISTINCT FROM NEW.request_checksum OR NEW.result->>'fileChecksum' IS DISTINCT FROM f.file_checksum OR NEW.result->>'previewChecksum' IS DISTINCT FROM f.preview_checksum
   THEN RAISE EXCEPTION 'factory_erp_application_invalid' USING ERRCODE='23514';END IF;
  RETURN NEW;
 END IF;
 IF TG_TABLE_NAME='factory_erp_binding_items' THEN
  SELECT * INTO b FROM factory_erp_bindings WHERE tenant_id=NEW.tenant_id AND id=NEW.binding_id;
  IF EXISTS(SELECT 1 FROM audit_events ae WHERE ae.tenant_id=NEW.tenant_id AND ae.entity_id=b.application_id AND ae.entity_type='factory_erp_application' AND ae.action='factory_erp.import_applied' AND ae.result='success')
   THEN RAISE EXCEPTION 'factory_erp_application_sealed' USING ERRCODE='23514';END IF;
  SELECT * INTO i FROM production_delivery_items WHERE tenant_id=NEW.tenant_id AND id=NEW.delivery_item_id;
  IF b.id IS NULL OR b.creation_transaction_id IS DISTINCT FROM xid OR NOT EXISTS(SELECT 1 FROM factory_erp_bindings bb WHERE bb.tenant_id=b.tenant_id AND bb.id=b.id AND bb.xmin::text=(xid::numeric%4294967296)::bigint::text)
   OR i.id IS NULL OR NEW.production_order_id IS DISTINCT FROM i.production_order_id OR NEW.production_version_id IS DISTINCT FROM i.production_version_id
   OR NEW.file_checksum IS DISTINCT FROM i.file_checksum OR NEW.manufacturing_checksum IS DISTINCT FROM i.manufacturing_plan_checksum
   OR NOT factory_erp_delivery_current(NEW.tenant_id,i.id,b.factory_id)
   OR NEW.quantity IS DISTINCT FROM(SELECT v.quantity FROM production_order_versions v WHERE v.tenant_id=NEW.tenant_id AND v.id=i.production_version_id)
   THEN RAISE EXCEPTION 'factory_erp_original_delivery_required' USING ERRCODE='23514';END IF;
  RETURN NEW;
 END IF;
 SELECT * INTO a FROM factory_erp_applications WHERE tenant_id=NEW.tenant_id AND id=NEW.application_id;
 IF a.id IS NULL OR a.creation_transaction_id IS DISTINCT FROM xid OR NOT EXISTS(SELECT 1 FROM factory_erp_applications aa WHERE aa.tenant_id=a.tenant_id AND aa.id=a.id AND aa.xmin::text=(xid::numeric%4294967296)::bigint::text)
  THEN RAISE EXCEPTION 'factory_erp_application_birth_required' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM audit_events ae WHERE ae.tenant_id=NEW.tenant_id AND ae.entity_id=a.id AND ae.entity_type='factory_erp_application' AND ae.action='factory_erp.import_applied' AND ae.result='success')
  THEN RAISE EXCEPTION 'factory_erp_application_sealed' USING ERRCODE='23514';END IF;
 PERFORM factory_erp_require_authority(a.tenant_id,a.created_by);
 IF TG_TABLE_NAME IN('factory_erp_bindings','factory_erp_observations') THEN
  IF NEW.created_by IS DISTINCT FROM a.created_by OR NEW.creation_transaction_id IS DISTINCT FROM xid THEN RAISE EXCEPTION 'factory_erp_original_actor_required' USING ERRCODE='23514';END IF;
 END IF;
 IF TG_TABLE_NAME='factory_erp_bindings' THEN
  SELECT * INTO f FROM factory_erp_imports WHERE tenant_id=a.tenant_id AND id=a.import_id;
  IF NEW.factory_id IS DISTINCT FROM f.factory_id THEN RAISE EXCEPTION 'factory_erp_factory_mismatch' USING ERRCODE='23514';END IF;
 ELSIF TG_TABLE_NAME='factory_erp_observations' THEN
  SELECT * INTO b FROM factory_erp_bindings WHERE tenant_id=NEW.tenant_id AND id=NEW.binding_id;
  SELECT * INTO f FROM factory_erp_imports WHERE tenant_id=a.tenant_id AND id=a.import_id;
  IF NEW.import_id IS DISTINCT FROM a.import_id OR b.factory_id IS DISTINCT FROM f.factory_id THEN RAISE EXCEPTION 'factory_erp_observation_mismatch' USING ERRCODE='23514';END IF;
  SELECT c INTO claim FROM jsonb_array_elements(f.source_claims) c WHERE(c->>'rowNumber')::integer=NEW.row_number;
  IF claim IS NULL OR claim->>'rawStatus' IS DISTINCT FROM NEW.raw_status OR claim->>'rowChecksum' IS DISTINCT FROM NEW.row_checksum
   OR claim->>'externalKey' IS DISTINCT FROM b.external_key OR(claim->>'quantity')::integer IS DISTINCT FROM b.quantity
   THEN RAISE EXCEPTION 'factory_erp_observation_source_required' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['factory_erp_imports','factory_erp_applications','factory_erp_bindings','factory_erp_binding_items','factory_erp_observations','factory_erp_application_rows'] LOOP
  EXECUTE format('CREATE TRIGGER factory_erp_guard BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION guard_factory_erp_record()',t);
 END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION require_factory_erp_closure() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE xid text:=pg_current_xact_id()::text;row_input jsonb;row_result jsonb;br factory_erp_application_rows;b factory_erp_bindings;item_input jsonb;item_count integer;
 observed factory_erp_observations;actual_status text;actual_disposition text;prior_shipped boolean;prior_scheduled boolean;new_observation boolean;
 source_row factory_erp_imports;selected_claim jsonb;
BEGIN
 IF TG_TABLE_NAME='factory_erp_imports' THEN
  IF NOT EXISTS(SELECT 1 FROM audit_events ae WHERE ae.tenant_id=NEW.tenant_id AND ae.entity_id=NEW.id AND ae.entity_type='factory_erp_import' AND ae.action='factory_erp.import_uploaded' AND ae.actor_user_id=NEW.created_by AND ae.result='success' AND ae.xmin::text=(xid::numeric%4294967296)::bigint::text)
   THEN RAISE EXCEPTION 'factory_erp_source_audit_required' USING ERRCODE='23514';END IF;RETURN NULL;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM audit_events ae WHERE ae.tenant_id=NEW.tenant_id AND ae.entity_id=NEW.id AND ae.entity_type='factory_erp_application' AND ae.action='factory_erp.import_applied' AND ae.actor_user_id=NEW.created_by AND ae.result='success' AND ae.xmin::text=(xid::numeric%4294967296)::bigint::text)
  THEN RAISE EXCEPTION 'factory_erp_application_audit_required' USING ERRCODE='23514';END IF;
 SELECT * INTO source_row FROM factory_erp_imports WHERE tenant_id=NEW.tenant_id AND id=NEW.import_id;
 IF(SELECT count(*) FROM factory_erp_application_rows r WHERE r.tenant_id=NEW.tenant_id AND r.application_id=NEW.id)<>jsonb_array_length(NEW.input->'rows')
  OR jsonb_array_length(NEW.result->'observations')<>jsonb_array_length(NEW.input->'rows') OR(NEW.result->>'appliedRows')::integer<>jsonb_array_length(NEW.input->'rows')
  THEN RAISE EXCEPTION 'factory_erp_rows_closure_required' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM factory_erp_bindings bb WHERE bb.tenant_id=NEW.tenant_id AND bb.application_id=NEW.id AND NOT EXISTS(SELECT 1 FROM factory_erp_application_rows rr WHERE rr.tenant_id=NEW.tenant_id AND rr.application_id=NEW.id AND rr.binding_id=bb.id))
  OR EXISTS(SELECT 1 FROM factory_erp_observations oo WHERE oo.tenant_id=NEW.tenant_id AND oo.application_id=NEW.id AND NOT EXISTS(SELECT 1 FROM factory_erp_application_rows rr WHERE rr.tenant_id=NEW.tenant_id AND rr.application_id=NEW.id AND rr.observation_id=oo.id AND rr.row_number=oo.row_number))
  THEN RAISE EXCEPTION 'factory_erp_extra_facts_forbidden' USING ERRCODE='23514';END IF;
 FOR row_input IN SELECT value FROM jsonb_array_elements(NEW.input->'rows') LOOP
  SELECT * INTO br FROM factory_erp_application_rows r WHERE r.tenant_id=NEW.tenant_id AND r.application_id=NEW.id AND r.row_number=(row_input->>'rowNumber')::integer;
  SELECT * INTO b FROM factory_erp_bindings WHERE tenant_id=NEW.tenant_id AND id=br.binding_id;
  IF br.id IS NULL OR b.id IS NULL OR row_input->'wholeGroupConfirmed' IS DISTINCT FROM 'true'::jsonb
   OR NOT EXISTS(SELECT 1 FROM factory_erp_observations o WHERE o.tenant_id=NEW.tenant_id AND o.id=br.observation_id AND o.binding_id=b.id)
   THEN RAISE EXCEPTION 'factory_erp_row_binding_required' USING ERRCODE='23514';END IF;
  SELECT value INTO row_result FROM jsonb_array_elements(NEW.result->'observations') WHERE(value->>'rowNumber')::integer=br.row_number;
  IF row_result->>'bindingId' IS DISTINCT FROM b.id::text OR row_result->>'observationId' IS DISTINCT FROM br.observation_id::text OR row_result->>'disposition' IS DISTINCT FROM br.disposition
   THEN RAISE EXCEPTION 'factory_erp_result_mismatch' USING ERRCODE='23514';END IF;
  SELECT * INTO observed FROM factory_erp_observations WHERE tenant_id=NEW.tenant_id AND id=br.observation_id;
  SELECT c INTO selected_claim FROM jsonb_array_elements(source_row.source_claims) c WHERE(c->>'rowNumber')::integer=br.row_number;
  IF selected_claim IS NULL OR selected_claim->>'rowChecksum' IS DISTINCT FROM observed.row_checksum OR selected_claim->>'rawStatus' IS DISTINCT FROM observed.raw_status
   OR selected_claim->>'externalKey' IS DISTINCT FROM b.external_key OR(selected_claim->>'quantity')::integer IS DISTINCT FROM b.quantity
   THEN RAISE EXCEPTION 'factory_erp_observation_source_required' USING ERRCODE='23514';END IF;
  SELECT EXISTS(SELECT 1 FROM factory_erp_observations oo WHERE oo.tenant_id=NEW.tenant_id AND oo.binding_id=b.id AND oo.raw_status='已出库'),
   EXISTS(SELECT 1 FROM factory_erp_observations oo WHERE oo.tenant_id=NEW.tenant_id AND oo.binding_id=b.id AND oo.raw_status='已审核') INTO prior_shipped,prior_scheduled;
  actual_status:=CASE WHEN prior_shipped THEN 'shipped' WHEN prior_scheduled THEN 'scheduled' ELSE NULL END;
  IF row_result->>'status' IS DISTINCT FROM actual_status THEN RAISE EXCEPTION 'factory_erp_status_mismatch' USING ERRCODE='23514';END IF;
  new_observation:=observed.application_id=NEW.id AND observed.creation_transaction_id=xid;
  actual_disposition:=CASE WHEN NOT new_observation THEN 'unchanged' WHEN observed.raw_status='已作废' THEN 'exception'
   WHEN EXISTS(SELECT 1 FROM factory_erp_observations oo WHERE oo.tenant_id=NEW.tenant_id AND oo.binding_id=b.id AND oo.id<>observed.id AND(oo.raw_status='已出库' OR observed.raw_status='已审核' AND oo.raw_status='已审核')) THEN 'unchanged' ELSE 'advanced' END;
  IF br.disposition IS DISTINCT FROM actual_disposition THEN RAISE EXCEPTION 'factory_erp_disposition_mismatch' USING ERRCODE='23514';END IF;
  SELECT count(*) INTO item_count FROM factory_erp_binding_items bi WHERE bi.tenant_id=NEW.tenant_id AND bi.binding_id=b.id;
  IF item_count NOT BETWEEN 1 AND 50 OR item_count<>jsonb_array_length(row_input->'items')
   OR b.quantity<>(SELECT sum(bi.quantity) FROM factory_erp_binding_items bi WHERE bi.tenant_id=NEW.tenant_id AND bi.binding_id=b.id)
   THEN RAISE EXCEPTION 'factory_erp_whole_group_required' USING ERRCODE='23514';END IF;
  FOR item_input IN SELECT value FROM jsonb_array_elements(row_input->'items') LOOP
   IF NOT EXISTS(SELECT 1 FROM factory_erp_binding_items bi WHERE bi.tenant_id=NEW.tenant_id AND bi.binding_id=b.id AND bi.delivery_item_id::text=item_input->>'deliveryItemId'
     AND bi.production_order_id::text=item_input->>'productionOrderId' AND bi.production_version_id::text=item_input->>'productionVersionId'
     AND bi.file_checksum=item_input->>'fileChecksum' AND bi.manufacturing_checksum=item_input->>'manufacturingChecksum' AND factory_erp_delivery_current(NEW.tenant_id,bi.delivery_item_id,b.factory_id))
    THEN RAISE EXCEPTION 'factory_erp_original_group_changed' USING ERRCODE='23514';END IF;
  END LOOP;
 END LOOP;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER factory_erp_source_closure AFTER INSERT ON factory_erp_imports DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_factory_erp_closure();
CREATE CONSTRAINT TRIGGER factory_erp_application_closure AFTER INSERT ON factory_erp_applications DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_factory_erp_closure();
