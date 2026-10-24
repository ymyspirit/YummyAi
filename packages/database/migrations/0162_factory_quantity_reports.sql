-- Factory observations reuse the original quantity report. No historical attribution.
CREATE TABLE factory_quantity_report_origins (
 report_id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES organizations(id),assignment_id uuid NOT NULL,accepted_feedback_id uuid NOT NULL,
 production_order_id uuid NOT NULL,production_version_id uuid NOT NULL,factory_id uuid NOT NULL,factory_name text NOT NULL,
 input jsonb NOT NULL,idempotency_key uuid NOT NULL,request_canonical text NOT NULL,request_checksum text NOT NULL,
 creation_transaction_id text NOT NULL,created_by uuid NOT NULL REFERENCES app_users(id),created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT factory_quantity_origins_report_fk FOREIGN KEY(tenant_id,report_id,production_order_id,production_version_id) REFERENCES production_quantity_reports(tenant_id,id,production_order_id,production_version_id),
 CONSTRAINT factory_quantity_origins_assignment_fk FOREIGN KEY(tenant_id,assignment_id) REFERENCES factory_task_assignments(tenant_id,id),
 CONSTRAINT factory_quantity_origins_accepted_fk FOREIGN KEY(tenant_id,accepted_feedback_id) REFERENCES production_delivery_feedback(tenant_id,id),
 CONSTRAINT factory_quantity_origins_factory_fk FOREIGN KEY(tenant_id,factory_id) REFERENCES fulfillment_factories(tenant_id,id),
 CONSTRAINT factory_quantity_origins_hash CHECK(request_checksum=encode(sha256(convert_to(request_canonical,'UTF8')),'hex')),
 CONSTRAINT factory_quantity_origins_name CHECK(length(factory_name) BETWEEN 1 AND 500)
);
CREATE UNIQUE INDEX factory_quantity_origins_scope ON factory_quantity_report_origins(tenant_id,report_id);
CREATE UNIQUE INDEX factory_quantity_origins_request ON factory_quantity_report_origins(tenant_id,idempotency_key);
CREATE INDEX factory_quantity_origins_history ON factory_quantity_report_origins(tenant_id,assignment_id,created_by,report_id);
ALTER TABLE factory_quantity_report_origins ENABLE ROW LEVEL SECURITY;
ALTER TABLE factory_quantity_report_origins FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON factory_quantity_report_origins USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT ON factory_quantity_report_origins TO yummyai_app;
CREATE TRIGGER factory_quantity_origins_immutable BEFORE UPDATE OR DELETE ON factory_quantity_report_origins FOR EACH ROW EXECUTE FUNCTION factory_capacity_immutable();
--> statement-breakpoint
-- A common database fingerprint binds the public opaque basis and the SQL guard.
-- It contains no current clock value, so it remains stable until a fact changes.
CREATE FUNCTION factory_quantity_basis_fingerprint(tenant uuid,actor uuid,assignment uuid) RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT encode(sha256(convert_to(jsonb_build_object('version',1,'tenant',tenant,'actor',actor,'assignment',a.id,
  'grant',jsonb_build_object('id',g.id,'member',g.membership_id,'respond',g.can_respond,'expires',g.expires_at,'revoked',g.revoked_at),
  'assignmentState',jsonb_build_object('expires',a.expires_at,'revoked',a.revoked_at,'checksum',a.file_checksum),
  'member',jsonb_build_object('id',m.id,'status',m.status),
  'file',jsonb_build_object('item',i.id,'production',i.production_order_id,'version',i.production_version_id,'work',i.work_revision_id,'editor',i.editor_version_id,'render',i.render_id,'checksum',i.file_checksum,'manufacturing',i.manufacturing_plan_checksum),
  'private',jsonb_build_object('available',w.encrypted_data_key IS NOT NULL AND w.expires_at>statement_timestamp() AND ep.encrypted_data_key IS NOT NULL AND(ep.expires_at IS NULL OR ep.expires_at>statement_timestamp()),
    'projectStatus',ep.status,'current',ep.current_version_id,'reviewed',ep.reviewed_version_id,'workRevision',w.pushed_revision_id,'artwork',w.artwork,'proof',w.proof),
  'accepted',(SELECT jsonb_build_object('id',f.id,'kind',f.kind,'sequence',f.sequence,'actor',f.recorded_by,'own',EXISTS(SELECT 1 FROM factory_task_receipts fr WHERE fr.tenant_id=tenant AND fr.assignment_id=a.id AND fr.feedback_id=f.id AND fr.recorded_by=actor)) FROM production_delivery_feedback f WHERE f.tenant_id=tenant AND f.item_id=i.id AND f.kind<>'rework' ORDER BY f.sequence DESC LIMIT 1),
  'basis',production_quantity_basis(tenant,i.production_order_id)->>'fingerprint')::text,'UTF8')),'hex')
 FROM factory_task_assignments a JOIN factory_access_grants g ON g.tenant_id=a.tenant_id AND g.id=a.grant_id
 JOIN memberships m ON m.tenant_id=g.tenant_id AND m.id=g.membership_id AND m.user_id=actor
 JOIN production_delivery_items i ON i.tenant_id=a.tenant_id AND i.id=a.delivery_item_id
 JOIN order_work_items w ON w.tenant_id=i.tenant_id AND w.id=i.work_item_id
 JOIN production_editor_projects ep ON ep.tenant_id=i.tenant_id AND ep.id=i.editor_project_id
 WHERE a.tenant_id=tenant AND a.id=assignment AND tenant=nullif(current_setting('app.tenant_id',true),'')::uuid AND actor=nullif(current_setting('app.user_id',true),'')::uuid
$$;
REVOKE ALL ON FUNCTION factory_quantity_basis_fingerprint(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION factory_quantity_basis_fingerprint(uuid,uuid,uuid) TO yummyai_app;
--> statement-breakpoint
CREATE FUNCTION factory_quantity_input_valid(value jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE keys text[]:=ARRAY['idempotencyKey','fileChecksum','manufacturingChecksum','acceptedFeedbackId','expectedBasisFingerprint','wholeProductionConfirmed','observedAt','quantities','evidenceCode','reference'];observed timestamptz;
BEGIN
 IF jsonb_typeof(value) IS DISTINCT FROM 'object' OR NOT value?&keys OR value-keys<>'{}'::jsonb
  OR jsonb_typeof(value->'idempotencyKey') IS DISTINCT FROM 'string' OR value->>'idempotencyKey'!~'^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
  OR jsonb_typeof(value->'acceptedFeedbackId') IS DISTINCT FROM 'string' OR value->>'acceptedFeedbackId'!~'^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
  OR jsonb_typeof(value->'fileChecksum') IS DISTINCT FROM 'string' OR value->>'fileChecksum'!~'^[a-f0-9]{64}$'
  OR jsonb_typeof(value->'manufacturingChecksum') IS DISTINCT FROM 'string' OR value->>'manufacturingChecksum'!~'^[a-f0-9]{64}$'
  OR jsonb_typeof(value->'expectedBasisFingerprint') IS DISTINCT FROM 'string' OR value->>'expectedBasisFingerprint'!~'^[a-f0-9]{64}$'
  OR value->'wholeProductionConfirmed' IS DISTINCT FROM 'true'::jsonb OR NOT production_quantity_counts_valid(value->'quantities',true)
  OR jsonb_typeof(value->'evidenceCode') IS DISTINCT FROM 'string' OR value->>'evidenceCode'!~'^[A-Z0-9_:-]{1,160}$'
  OR jsonb_typeof(value->'reference') IS DISTINCT FROM 'string' OR length(value->>'reference') NOT BETWEEN 1 AND 200 OR btrim(value->>'reference')<>value->>'reference'
  OR jsonb_typeof(value->'observedAt') IS DISTINCT FROM 'string' OR value->>'observedAt'!~'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$'
  THEN RETURN false;END IF;
 observed:=(value->>'observedAt')::timestamptz;
 RETURN observed=date_trunc('milliseconds',observed);
EXCEPTION WHEN OTHERS THEN RETURN false;END $$;
--> statement-breakpoint
CREATE FUNCTION guard_factory_quantity_origin() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE actor uuid:=nullif(current_setting('app.user_id',true),'')::uuid;report production_quantity_reports;item production_delivery_items;accepted production_delivery_feedback;
 assignment factory_task_assignments;grant_row factory_access_grants;member memberships;factory fulfillment_factories;production production_orders;version production_order_versions;basis jsonb;full_xid text:=pg_current_xact_id()::text;
BEGIN
 IF NEW.created_by IS DISTINCT FROM actor OR NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid OR NOT factory_quantity_input_valid(NEW.input)
  OR NEW.creation_transaction_id IS DISTINCT FROM full_xid OR NEW.idempotency_key::text IS DISTINCT FROM NEW.input->>'idempotencyKey'
  OR NEW.request_canonical::jsonb IS DISTINCT FROM jsonb_build_object('version',1,'operation','factory-report','assignmentId',NEW.assignment_id,'input',NEW.input)
  THEN RAISE EXCEPTION 'factory_quantity_origin_input_invalid' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('production-quantity-request:'||NEW.tenant_id::text||':report:factory-quantity:'||NEW.idempotency_key::text,0));
 SELECT * INTO assignment FROM factory_task_assignments WHERE tenant_id=NEW.tenant_id AND id=NEW.assignment_id FOR SHARE;
 SELECT * INTO grant_row FROM factory_access_grants WHERE tenant_id=NEW.tenant_id AND id=assignment.grant_id FOR SHARE;
 SELECT * INTO member FROM memberships WHERE tenant_id=NEW.tenant_id AND id=grant_row.membership_id FOR SHARE;
 SELECT * INTO factory FROM fulfillment_factories WHERE tenant_id=NEW.tenant_id AND id=grant_row.factory_id FOR SHARE;
 IF assignment.id IS NULL OR grant_row.id IS NULL OR member.user_id IS DISTINCT FROM actor OR member.status<>'active'
  OR assignment.revoked_at IS NOT NULL OR assignment.expires_at<=clock_timestamp() OR grant_row.revoked_at IS NOT NULL OR grant_row.expires_at<=clock_timestamp() OR NOT grant_row.can_respond
  OR factory.id IS NULL OR factory.id IS DISTINCT FROM NEW.factory_id OR factory.name IS DISTINCT FROM NEW.factory_name OR factory.status<>'active'
  OR NOT EXISTS(SELECT 1 FROM fulfillment_suppliers s WHERE s.tenant_id=NEW.tenant_id AND s.id=factory.supplier_id AND s.status='active')
  THEN RAISE EXCEPTION 'factory_quantity_current_authority_required' USING ERRCODE='23514';END IF;
 SELECT * INTO item FROM production_delivery_items WHERE tenant_id=NEW.tenant_id AND id=assignment.delivery_item_id;
 SELECT * INTO production FROM production_orders WHERE tenant_id=NEW.tenant_id AND id=item.production_order_id;
 SELECT * INTO version FROM production_order_versions WHERE tenant_id=NEW.tenant_id AND id=item.production_version_id;
 SELECT * INTO accepted FROM production_delivery_feedback WHERE tenant_id=NEW.tenant_id AND item_id=item.id AND kind<>'rework' ORDER BY sequence DESC LIMIT 1;
 IF item.id IS NULL OR production.id IS NULL OR version.id IS NULL OR production.id IS DISTINCT FROM NEW.production_order_id OR version.id IS DISTINCT FROM NEW.production_version_id
  OR production.current_version_number<>version.version_number OR production.factory_id IS DISTINCT FROM NEW.factory_id OR version.factory_id IS DISTINCT FROM NEW.factory_id OR production.status='cancelled'
  OR item.file_checksum IS DISTINCT FROM assignment.file_checksum OR NEW.input->>'fileChecksum' IS DISTINCT FROM item.file_checksum
  OR item.manufacturing_plan_checksum IS NULL OR NEW.input->>'manufacturingChecksum' IS DISTINCT FROM item.manufacturing_plan_checksum
  OR accepted.id IS NULL OR accepted.id IS DISTINCT FROM NEW.accepted_feedback_id OR NEW.input->>'acceptedFeedbackId' IS DISTINCT FROM accepted.id::text OR accepted.kind<>'accepted' OR accepted.recorded_by IS DISTINCT FROM actor
  OR NOT EXISTS(SELECT 1 FROM factory_task_receipts fr WHERE fr.tenant_id=NEW.tenant_id AND fr.assignment_id=assignment.id AND fr.feedback_id=accepted.id AND fr.recorded_by=actor)
  OR NOT EXISTS(SELECT 1 FROM production_delivery_packages p WHERE p.tenant_id=NEW.tenant_id AND p.id=item.package_id AND p.factory_id=NEW.factory_id)
  OR NOT EXISTS(SELECT 1 FROM production_manufacturing_bindings b WHERE b.tenant_id=NEW.tenant_id AND b.id=item.manufacturing_binding_id AND b.production_version_id=version.id AND b.quantity=version.quantity AND b.content_checksum=item.manufacturing_content_checksum)
  THEN RAISE EXCEPTION 'factory_quantity_original_source_required' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM order_work_items w JOIN order_lines ol ON ol.tenant_id=w.tenant_id AND ol.id=w.id JOIN orders o ON o.tenant_id=ol.tenant_id AND o.id=ol.order_id
   JOIN order_work_revisions wr ON wr.tenant_id=w.tenant_id AND wr.id=item.work_revision_id AND wr.work_item_id=w.id
   JOIN production_editor_projects ep ON ep.tenant_id=w.tenant_id AND ep.id=item.editor_project_id
   JOIN production_editor_renders er ON er.tenant_id=ep.tenant_id AND er.id=item.render_id AND er.project_id=ep.id AND er.version_id=item.editor_version_id
   WHERE w.tenant_id=NEW.tenant_id AND w.id=item.work_item_id AND w.encrypted_data_key IS NOT NULL AND w.expires_at>clock_timestamp() AND w.archived_at IS NULL AND NOT w.held
    AND w.pushed_revision_id=item.work_revision_id AND w.revision=wr.revision AND w.editor_project_id=ep.id AND w.artwork='approved' AND w.approved_editor_version_id=item.editor_version_id
    AND(w.proof='not_required' OR(w.proof='approved' AND w.proof_editor_version_id=item.editor_version_id)) AND o.address_status<>'anonymized' AND o.side_state IS NULL
    AND ep.status='active' AND ep.encrypted_data_key IS NOT NULL AND(ep.expires_at IS NULL OR ep.expires_at>clock_timestamp()) AND ep.current_version_id=item.editor_version_id AND ep.reviewed_version_id=item.editor_version_id
    AND ep.source_work_item_id=w.id AND ep.source_work_revision_id=wr.id AND er.status='completed'
    AND(w.report_line_id IS NULL OR EXISTS(SELECT 1 FROM amazon_order_report_lines ar WHERE ar.tenant_id=w.tenant_id AND ar.id=w.report_line_id AND ar.current_version_id=wr.source_version_id AND ar.expires_at>clock_timestamp())))
  THEN RAISE EXCEPTION 'factory_quantity_private_source_required' USING ERRCODE='23514';END IF;
 basis:=production_quantity_basis(NEW.tenant_id,NEW.production_order_id);
 IF NEW.input->>'expectedBasisFingerprint' IS DISTINCT FROM factory_quantity_basis_fingerprint(NEW.tenant_id,actor,NEW.assignment_id)
  OR basis IS NULL OR jsonb_array_length(basis->'blockers')>0
  THEN RAISE EXCEPTION 'factory_quantity_basis_changed' USING ERRCODE='23514';END IF;
 SELECT * INTO report FROM production_quantity_reports WHERE tenant_id=NEW.tenant_id AND id=NEW.report_id;
 IF report.id IS NULL OR report.created_by IS DISTINCT FROM actor OR report.idempotency_key IS DISTINCT FROM 'factory-quantity:'||NEW.idempotency_key::text
  OR report.production_order_id IS DISTINCT FROM NEW.production_order_id OR report.production_version_id IS DISTINCT FROM NEW.production_version_id
  OR report.input->'quantities' IS DISTINCT FROM NEW.input->'quantities' OR report.input->>'evidenceCode' IS DISTINCT FROM NEW.input->>'evidenceCode'
  OR(report.input->>'observedAt')::timestamptz IS DISTINCT FROM(NEW.input->>'observedAt')::timestamptz OR report.input->'evidenceAssetIds' IS DISTINCT FROM '[]'::jsonb
  OR report.created_at<transaction_timestamp() OR NOT EXISTS(SELECT 1 FROM production_quantity_reports r WHERE r.tenant_id=NEW.tenant_id AND r.id=NEW.report_id AND r.xmin::text=(full_xid::numeric%4294967296)::bigint::text)
  THEN RAISE EXCEPTION 'factory_quantity_original_report_birth_required' USING ERRCODE='23514';END IF;
 IF(NEW.input->>'observedAt')::timestamptz<accepted.occurred_at OR(NEW.input->>'observedAt')::timestamptz>clock_timestamp()
  THEN RAISE EXCEPTION 'factory_quantity_time_invalid' USING ERRCODE='23514';END IF;
 NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER factory_quantity_origin_guard BEFORE INSERT ON factory_quantity_report_origins FOR EACH ROW EXECUTE FUNCTION guard_factory_quantity_origin();
--> statement-breakpoint
CREATE FUNCTION require_factory_quantity_origin_closure() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE report_identity uuid;origin factory_quantity_report_origins;full_xid text:=pg_current_xact_id()::text;
BEGIN
 IF TG_TABLE_NAME='production_quantity_reports' THEN
  IF NEW.idempotency_key NOT LIKE 'factory-quantity:%' THEN RETURN NULL;END IF;
  report_identity:=NEW.id;
 ELSE report_identity:=NEW.report_id;END IF;
 SELECT * INTO origin FROM factory_quantity_report_origins WHERE tenant_id=NEW.tenant_id AND report_id=report_identity;
 IF origin.report_id IS NULL OR origin.creation_transaction_id IS DISTINCT FROM full_xid
  OR NOT EXISTS(SELECT 1 FROM audit_events a WHERE a.tenant_id=NEW.tenant_id AND a.entity_id=report_identity AND a.entity_type='factory_quantity_report' AND a.action='factory_portal.quantity_reported'
    AND a.actor_user_id=origin.created_by AND a.result='success' AND a.xmin::text=(full_xid::numeric%4294967296)::bigint::text)
  OR NOT EXISTS(SELECT 1 FROM audit_events a WHERE a.tenant_id=NEW.tenant_id AND a.entity_id=report_identity AND a.entity_type='production_quantity_report' AND a.action='production.quantity.report_recorded'
    AND a.actor_user_id=origin.created_by AND a.result='success' AND a.xmin::text=(full_xid::numeric%4294967296)::bigint::text)
  THEN RAISE EXCEPTION 'factory_quantity_origin_closure_required' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER factory_quantity_origin_closure AFTER INSERT ON factory_quantity_report_origins DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_factory_quantity_origin_closure();
CREATE CONSTRAINT TRIGGER factory_quantity_report_origin_closure AFTER INSERT ON production_quantity_reports DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_factory_quantity_origin_closure();
