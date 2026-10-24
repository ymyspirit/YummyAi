-- Existing tasks retain NULL; never backfill governance with today's publication.
ALTER TABLE pod_artwork_executions ADD COLUMN method_snapshot jsonb;
--> statement-breakpoint
CREATE FUNCTION protect_pod_method_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tool text;
BEGIN
 IF TG_OP='UPDATE' AND NEW.method_snapshot IS DISTINCT FROM OLD.method_snapshot
 THEN RAISE EXCEPTION 'POD method snapshot is immutable' USING ERRCODE='55000'; END IF;
 IF NEW.method_snapshot IS NOT NULL THEN
  SELECT tool_key INTO tool FROM pod_artwork_tasks WHERE tenant_id=NEW.tenant_id AND id=NEW.task_id;
  IF tool IS NULL
   OR jsonb_typeof(NEW.method_snapshot) IS DISTINCT FROM 'object'
   OR NEW.method_snapshot-ARRAY['schemaVersion','executionContract','methodSelection']<>'{}'::jsonb
   OR NEW.method_snapshot->>'schemaVersion' IS DISTINCT FROM 'pod-method-snapshot-v1'
   OR NEW.method_snapshot#>>'{executionContract,contractVersion}' IS DISTINCT FROM 'native-harness-v1'
   OR NEW.method_snapshot#>>'{executionContract,executorKey}' IS DISTINCT FROM 'pod_artwork'
   OR NEW.method_snapshot#>>'{executionContract,skill,key}' IS DISTINCT FROM 'pod.artwork.'||tool
   OR NEW.method_snapshot#>>'{methodSelection,schemaVersion}' IS DISTINCT FROM 'agent-method-selection-v1'
   OR NEW.method_snapshot#>>'{methodSelection,methodKey}' IS DISTINCT FROM 'pod.artwork.'||tool
   OR coalesce(NEW.method_snapshot#>>'{methodSelection,mode}','') NOT IN ('builtin','published')
   OR coalesce(NEW.method_snapshot#>>'{executionContract,checksum}','') !~ '^[a-f0-9]{64}$'
   OR NEW.method_snapshot#>>'{methodSelection,contractChecksum}' IS DISTINCT FROM NEW.method_snapshot#>>'{executionContract,checksum}'
  THEN RAISE EXCEPTION 'POD method snapshot must match its original task and contract' USING ERRCODE='55000'; END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER pod_method_snapshot_immutable BEFORE INSERT OR UPDATE ON pod_artwork_executions FOR EACH ROW EXECUTE FUNCTION protect_pod_method_snapshot();
