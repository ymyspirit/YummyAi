-- New technical completions may add evidence; historical terminal rows stay missing.
ALTER TABLE pod_artwork_executions ADD COLUMN completion_evidence jsonb, ADD COLUMN completion_checksum text;
ALTER TABLE pod_artwork_executions ADD CONSTRAINT pod_completion_pair_check CHECK (
 (completion_evidence IS NULL AND completion_checksum IS NULL)
 OR (completion_evidence IS NOT NULL AND completion_checksum IS NOT NULL AND completion_checksum ~ '^[a-f0-9]{64}$' AND phase='completed')
);
ALTER TABLE pod_artwork_executions ADD CONSTRAINT pod_completion_v2_required_check CHECK (
 method_snapshot#>>'{executionContract,skill,version}' IS DISTINCT FROM 'pod-method-2026-10-18-v2'
 OR phase<>'completed' OR completion_evidence IS NOT NULL
);
--> statement-breakpoint
CREATE FUNCTION protect_pod_completion() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE task pod_artwork_tasks%ROWTYPE; item jsonb; position bigint; output_count integer; expected_mode text;
BEGIN
 IF TG_OP='UPDATE' AND OLD.completion_evidence IS NOT NULL THEN
  IF NEW.completion_evidence IS DISTINCT FROM OLD.completion_evidence OR NEW.completion_checksum IS DISTINCT FROM OLD.completion_checksum
  THEN RAISE EXCEPTION 'POD completion evidence is immutable' USING ERRCODE='55000'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.completion_evidence IS NULL THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.phase IN ('completed','failed','uncertain')
 THEN RAISE EXCEPTION 'Historical POD completion must not be backfilled' USING ERRCODE='55000'; END IF;
 SELECT * INTO task FROM pod_artwork_tasks WHERE tenant_id=NEW.tenant_id AND id=NEW.task_id;
 expected_mode:=CASE WHEN NEW.method_snapshot IS NULL THEN 'legacy_missing'
  WHEN NEW.method_snapshot#>>'{executionContract,skill,version}'='pod-method-2026-10-18-v1' THEN 'legacy_owner_view'
  ELSE 'native_completion' END;
 IF task.id IS NULL OR NEW.phase<>'completed'
  OR jsonb_typeof(NEW.completion_evidence) IS DISTINCT FROM 'object'
  OR NEW.completion_evidence-ARRAY['contractVersion','taskId','designTaskId','toolKey','inputFingerprint','methodContractChecksum','methodValidation','responseChecksum','decodedWith','resultVersionId','resultState','qualityCheckChecksum','outputs','requiresBusinessReview','automaticProductionApproval']<>'{}'::jsonb
  OR NEW.completion_evidence->>'contractVersion' IS DISTINCT FROM 'pod-completion-v1'
  OR NEW.completion_evidence->>'taskId' IS DISTINCT FROM NEW.task_id::text
  OR NEW.completion_evidence->>'designTaskId' IS DISTINCT FROM task.design_task_id::text
  OR NEW.completion_evidence->>'toolKey' IS DISTINCT FROM task.tool_key
  OR NEW.completion_evidence->>'inputFingerprint' IS DISTINCT FROM NEW.input_fingerprint
  OR NEW.completion_evidence->>'methodContractChecksum' IS DISTINCT FROM NEW.method_snapshot#>>'{executionContract,checksum}'
  OR NEW.completion_evidence->>'methodValidation' IS DISTINCT FROM expected_mode
  OR NEW.completion_evidence->>'responseChecksum' IS DISTINCT FROM NEW.response_checksum
  OR coalesce(NEW.completion_evidence->>'responseChecksum','') !~ '^[a-f0-9]{64}$'
  OR NEW.completion_evidence->>'decodedWith' IS DISTINCT FROM 'pod-processor-result-v1'
  OR NEW.completion_evidence->>'resultVersionId' IS DISTINCT FROM task.result_version_id::text
  OR task.result_version_id IS NULL
  OR coalesce(NEW.completion_evidence->>'resultState','') NOT IN ('awaiting_review','partially_succeeded','blocked')
  OR NEW.completion_evidence->>'resultState' IS DISTINCT FROM task.status
  OR coalesce(NEW.completion_evidence->>'qualityCheckChecksum','') !~ '^[a-f0-9]{64}$'
  OR NEW.completion_evidence->'requiresBusinessReview' IS DISTINCT FROM 'true'::jsonb
  OR NEW.completion_evidence->'automaticProductionApproval' IS DISTINCT FROM 'false'::jsonb
  OR jsonb_typeof(NEW.completion_evidence->'outputs') IS DISTINCT FROM 'array'
  OR NOT EXISTS(SELECT 1 FROM design_versions v WHERE v.tenant_id=NEW.tenant_id AND v.id=task.result_version_id AND v.task_id=task.design_task_id AND v.status='pending_review')
 THEN RAISE EXCEPTION 'POD completion must match its original execution and review handoff' USING ERRCODE='55000'; END IF;
 output_count:=jsonb_array_length(NEW.completion_evidence->'outputs');
 IF output_count NOT BETWEEN 1 AND 100
  OR (SELECT count(DISTINCT value->>'assetId') FROM jsonb_array_elements(NEW.completion_evidence->'outputs'))<>output_count
  OR (SELECT count(*) FROM design_version_files f WHERE f.tenant_id=NEW.tenant_id AND f.version_id=task.result_version_id)<>output_count
 THEN RAISE EXCEPTION 'POD completion must include every original output exactly once' USING ERRCODE='55000'; END IF;
 FOR item,position IN SELECT value,ordinality-1 FROM jsonb_array_elements(NEW.completion_evidence->'outputs') WITH ORDINALITY LOOP
  IF jsonb_typeof(item) IS DISTINCT FROM 'object'
   OR item-ARRAY['ordinal','assetId','assetVersion','checksumSha256','byteSize','mediaType','role']<>'{}'::jsonb
   OR jsonb_typeof(item->'ordinal') IS DISTINCT FROM 'number'
   OR jsonb_typeof(item->'assetVersion') IS DISTINCT FROM 'number'
   OR jsonb_typeof(item->'byteSize') IS DISTINCT FROM 'number'
   OR item->>'ordinal' IS DISTINCT FROM position::text
   OR NOT EXISTS(SELECT 1 FROM design_version_files f JOIN asset_files a ON a.tenant_id=f.tenant_id AND a.id=f.asset_file_id
    WHERE f.tenant_id=NEW.tenant_id AND f.version_id=task.result_version_id AND a.id::text=item->>'assetId'
     AND a.version::text=item->>'assetVersion' AND a.checksum_sha256=item->>'checksumSha256'
     AND a.byte_size::text=item->>'byteSize' AND a.media_type=item->>'mediaType' AND a.asset_domain='authorized' AND f.role=item->>'role')
  THEN RAISE EXCEPTION 'POD completion output must reference its original owned file' USING ERRCODE='55000'; END IF;
 END LOOP;
 RETURN NEW;
END; $$;
CREATE TRIGGER pod_completion_immutable BEFORE INSERT OR UPDATE ON pod_artwork_executions FOR EACH ROW EXECUTE FUNCTION protect_pod_completion();
