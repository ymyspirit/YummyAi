ALTER TABLE order_design_agent_runs ADD COLUMN method_snapshot jsonb,
 ADD COLUMN completion_evidence jsonb, ADD COLUMN completion_checksum text;
ALTER TABLE order_design_agent_runs ADD CONSTRAINT order_design_completion_pair_check CHECK (
 (completion_evidence IS NULL AND completion_checksum IS NULL)
 OR (completion_evidence IS NOT NULL AND completion_checksum IS NOT NULL AND completion_checksum ~ '^[a-f0-9]{64}$')
);
ALTER TABLE order_design_agent_runs ADD CONSTRAINT order_design_native_review_completion_check CHECK (
 method_snapshot IS NULL OR status<>'awaiting_review' OR completion_evidence IS NOT NULL
);
--> statement-breakpoint
CREATE FUNCTION protect_order_design_method_completion() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item jsonb; ordinal bigint; required_count integer;
BEGIN
 IF TG_OP='UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
  OR NEW.work_item_id IS DISTINCT FROM OLD.work_item_id OR NEW.work_revision_id IS DISTINCT FROM OLD.work_revision_id
  OR NEW.executor_key IS DISTINCT FROM OLD.executor_key OR NEW.recipe_version IS DISTINCT FROM OLD.recipe_version
  OR NEW.policy_version IS DISTINCT FROM OLD.policy_version OR NEW.model_route_id IS DISTINCT FROM OLD.model_route_id
  OR NEW.encrypted_snapshot IS DISTINCT FROM OLD.encrypted_snapshot OR NEW.input_checksum IS DISTINCT FROM OLD.input_checksum
  OR NEW.method_snapshot IS DISTINCT FROM OLD.method_snapshot OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
  OR NEW.created_at IS DISTINCT FROM OLD.created_at)
 THEN RAISE EXCEPTION 'Original order design identity and method are immutable' USING ERRCODE='55000'; END IF;
 IF NEW.method_snapshot IS NOT NULL AND (
  NEW.method_snapshot->>'schemaVersion' IS DISTINCT FROM 'order-design-method-snapshot-v1'
  OR NEW.method_snapshot#>>'{executionContract,executorKey}' IS DISTINCT FROM 'order_design'
  OR NEW.method_snapshot#>>'{executionContract,skill,key}' IS DISTINCT FROM 'order.design.'||replace(NEW.executor_key,'strict-','')
  OR NEW.method_snapshot#>>'{methodSelection,methodKey}' IS DISTINCT FROM NEW.method_snapshot#>>'{executionContract,skill,key}'
  OR NEW.method_snapshot#>>'{methodSelection,contractChecksum}' IS DISTINCT FROM NEW.method_snapshot#>>'{executionContract,checksum}')
 THEN RAISE EXCEPTION 'Order design method must match its original owner' USING ERRCODE='55000'; END IF;
 IF TG_OP='UPDATE' AND OLD.completion_evidence IS NOT NULL THEN
  IF NEW.completion_evidence IS DISTINCT FROM OLD.completion_evidence OR NEW.completion_checksum IS DISTINCT FROM OLD.completion_checksum
   OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.current_editor_version_id IS DISTINCT FROM OLD.current_editor_version_id
  THEN RAISE EXCEPTION 'Original order design completion is immutable' USING ERRCODE='55000'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.completion_evidence IS NULL THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.status IN ('awaiting_review','cancelled')
 THEN RAISE EXCEPTION 'Historical order design completion cannot be backfilled' USING ERRCODE='55000'; END IF;
 IF NEW.method_snapshot IS NULL OR NEW.status<>'awaiting_review'
  OR jsonb_typeof(NEW.completion_evidence) IS DISTINCT FROM 'object'
  OR NEW.completion_evidence-ARRAY['contractVersion','runId','workItemId','workRevisionId','inputChecksum','methodContractChecksum','projectId','editorVersionId','documentChecksum','templateVersionId','templateChecksum','ruleSnapshotChecksum','qualityCheckChecksum','resultState','steps','proofs','requiresBusinessReview','automaticProductionApproval']<>'{}'::jsonb
  OR NEW.completion_evidence->>'contractVersion' IS DISTINCT FROM 'order-design-completion-v1'
  OR NEW.completion_evidence->>'runId' IS DISTINCT FROM NEW.id::text
  OR NEW.completion_evidence->>'workItemId' IS DISTINCT FROM NEW.work_item_id::text
  OR NEW.completion_evidence->>'workRevisionId' IS DISTINCT FROM NEW.work_revision_id::text
  OR NEW.completion_evidence->>'inputChecksum' IS DISTINCT FROM NEW.input_checksum
  OR NEW.completion_evidence->>'methodContractChecksum' IS DISTINCT FROM NEW.method_snapshot#>>'{executionContract,checksum}'
  OR NEW.completion_evidence->>'projectId' IS DISTINCT FROM NEW.project_id::text OR NEW.project_id IS NULL
  OR NEW.completion_evidence->>'editorVersionId' IS DISTINCT FROM NEW.current_editor_version_id::text OR NEW.current_editor_version_id IS NULL
  OR NEW.completion_evidence->>'resultState' IS DISTINCT FROM 'awaiting_review'
  OR NEW.completion_evidence->'requiresBusinessReview' IS DISTINCT FROM 'true'::jsonb
  OR NEW.completion_evidence->'automaticProductionApproval' IS DISTINCT FROM 'false'::jsonb
  OR jsonb_typeof(NEW.completion_evidence->'steps') IS DISTINCT FROM 'array'
  OR jsonb_typeof(NEW.completion_evidence->'proofs') IS DISTINCT FROM 'array'
  OR NOT EXISTS(SELECT 1 FROM production_editor_versions v JOIN production_editor_projects p ON p.tenant_id=v.tenant_id AND p.id=v.project_id
   WHERE v.tenant_id=NEW.tenant_id AND v.id=NEW.current_editor_version_id AND v.project_id=NEW.project_id
    AND v.checksum=NEW.completion_evidence->>'documentChecksum' AND p.source_work_item_id=NEW.work_item_id
    AND p.source_work_revision_id=NEW.work_revision_id AND p.current_version_id=v.id AND p.reviewed_version_id IS NULL AND p.status='active')
 THEN RAISE EXCEPTION 'Order completion must retain its original unreviewed draft' USING ERRCODE='55000'; END IF;
 required_count:=jsonb_array_length(NEW.completion_evidence->'steps');
 IF required_count NOT BETWEEN 1 AND 108
  OR (SELECT count(*) FROM order_design_agent_steps WHERE tenant_id=NEW.tenant_id AND run_id=NEW.id)<>required_count
 THEN RAISE EXCEPTION 'Order completion requires every original step' USING ERRCODE='55000'; END IF;
 FOR item,ordinal IN SELECT value,ordinality-1 FROM jsonb_array_elements(NEW.completion_evidence->'steps') WITH ORDINALITY LOOP
  IF NOT EXISTS(SELECT 1 FROM order_design_agent_steps s WHERE s.tenant_id=NEW.tenant_id AND s.run_id=NEW.id AND s.position=ordinal AND s.status='completed'
   AND s.id::text=item->>'id' AND s.key=item->>'key' AND s.request_id::text=item->>'requestId' AND s.input_checksum=item->>'inputChecksum'
   AND s.output_asset_id::text IS NOT DISTINCT FROM item->>'outputAssetId' AND s.output_version_id::text IS NOT DISTINCT FROM item->>'outputVersionId')
  THEN RAISE EXCEPTION 'Order completion step identity mismatch' USING ERRCODE='55000'; END IF;
 END LOOP;
 required_count:=jsonb_array_length(NEW.completion_evidence->'proofs');
 IF required_count NOT BETWEEN 1 AND 16 OR (SELECT count(DISTINCT value->>'renderId') FROM jsonb_array_elements(NEW.completion_evidence->'proofs'))<>required_count
 THEN RAISE EXCEPTION 'Order completion requires original proof renders' USING ERRCODE='55000'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(NEW.completion_evidence->'proofs') LOOP
  IF NOT EXISTS(SELECT 1 FROM production_editor_renders r JOIN order_design_agent_steps s ON s.tenant_id=r.tenant_id AND s.request_id=r.id
   WHERE r.tenant_id=NEW.tenant_id AND r.id::text=item->>'renderId' AND r.project_id=NEW.project_id
    AND r.version_id=NEW.current_editor_version_id AND r.version_id::text=item->>'versionId' AND r.status='completed'
    AND s.run_id=NEW.id AND s.status='completed' AND r.encrypted_manifest IS NOT NULL
    AND encode(sha256(convert_to(r.encrypted_manifest,'UTF8')),'hex')=item->>'manifestChecksum')
  THEN RAISE EXCEPTION 'Order completion proof identity mismatch' USING ERRCODE='55000'; END IF;
 END LOOP;
 RETURN NEW;
END; $$;
CREATE TRIGGER order_design_method_completion_guard BEFORE INSERT OR UPDATE ON order_design_agent_runs FOR EACH ROW EXECUTE FUNCTION protect_order_design_method_completion();
--> statement-breakpoint
CREATE FUNCTION protect_order_design_step_input() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.run_id IS DISTINCT FROM OLD.run_id
  OR NEW.key IS DISTINCT FROM OLD.key OR NEW.position IS DISTINCT FROM OLD.position OR NEW.request_id IS DISTINCT FROM OLD.request_id
  OR NEW.encrypted_input IS DISTINCT FROM OLD.encrypted_input OR NEW.input_checksum IS DISTINCT FROM OLD.input_checksum
 THEN RAISE EXCEPTION 'Original order design step input is immutable' USING ERRCODE='55000'; END IF;
 IF OLD.status='completed' AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.encrypted_output IS DISTINCT FROM OLD.encrypted_output
  OR NEW.output_asset_id IS DISTINCT FROM OLD.output_asset_id OR NEW.output_version_id IS DISTINCT FROM OLD.output_version_id
  OR NEW.completed_at IS DISTINCT FROM OLD.completed_at)
 THEN RAISE EXCEPTION 'Completed order design step output is immutable' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER order_design_step_input_guard BEFORE UPDATE ON order_design_agent_steps FOR EACH ROW EXECUTE FUNCTION protect_order_design_step_input();
--> statement-breakpoint
CREATE FUNCTION protect_order_design_proof() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM order_design_agent_runs r WHERE r.tenant_id=OLD.tenant_id AND r.completion_evidence IS NOT NULL
  AND EXISTS(SELECT 1 FROM jsonb_array_elements(r.completion_evidence->'proofs') p WHERE p->>'renderId'=OLD.id::text))
 AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.project_id IS DISTINCT FROM OLD.project_id
  OR NEW.version_id IS DISTINCT FROM OLD.version_id OR NEW.status IS DISTINCT FROM OLD.status
  OR NEW.encrypted_manifest IS DISTINCT FROM OLD.encrypted_manifest OR NEW.encrypted_options IS DISTINCT FROM OLD.encrypted_options)
 THEN RAISE EXCEPTION 'Handed-off order design proof is immutable' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER order_design_proof_guard BEFORE UPDATE ON production_editor_renders FOR EACH ROW EXECUTE FUNCTION protect_order_design_proof();
