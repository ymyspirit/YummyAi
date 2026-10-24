-- Only newly created tasks opt into durable execution. Never invent historical receipts.
CREATE TABLE pod_artwork_executions (
 task_id uuid PRIMARY KEY, tenant_id uuid NOT NULL,
 contract_version text NOT NULL DEFAULT 'pod-execution-v1', input_fingerprint text NOT NULL,
 phase text NOT NULL DEFAULT 'pending', attempt_count integer NOT NULL DEFAULT 0, dispatch_count integer NOT NULL DEFAULT 0,
 last_dispatched_at timestamptz, next_attempt_at timestamptz NOT NULL DEFAULT now(), lease_token uuid, lease_expires_at timestamptz,
 response_object_key text, encrypted_checksum text, response_checksum text, response_expires_at timestamptz, response_purged_at timestamptz,
 artifact_manifest jsonb, updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT pod_executions_task_fk FOREIGN KEY(tenant_id,task_id) REFERENCES pod_artwork_tasks(tenant_id,id) ON DELETE RESTRICT,
 CONSTRAINT pod_executions_contract_check CHECK(contract_version='pod-execution-v1' AND input_fingerprint ~ '^[a-f0-9]{64}$'),
 CONSTRAINT pod_executions_phase_check CHECK(phase IN ('pending','preparing','response_staging','response_ready','completed','failed','uncertain')),
 CONSTRAINT pod_executions_attempt_check CHECK(attempt_count BETWEEN 0 AND 3 AND dispatch_count>=0),
 CONSTRAINT pod_executions_lease_check CHECK((lease_token IS NULL)=(lease_expires_at IS NULL)),
 CONSTRAINT pod_executions_response_check CHECK((response_object_key IS NULL AND encrypted_checksum IS NULL AND response_checksum IS NULL AND response_expires_at IS NULL AND response_purged_at IS NULL) OR (response_object_key IS NOT NULL AND encrypted_checksum ~ '^[a-f0-9]{64}$' AND response_checksum ~ '^[a-f0-9]{64}$' AND response_expires_at IS NOT NULL)),
 CONSTRAINT pod_executions_checkpoint_check CHECK(phase NOT IN ('response_staging','response_ready','completed') OR response_object_key IS NOT NULL),
 CONSTRAINT pod_executions_artifacts_check CHECK(artifact_manifest IS NULL OR (jsonb_typeof(artifact_manifest)='array' AND jsonb_array_length(artifact_manifest) BETWEEN 1 AND 100))
);
--> statement-breakpoint
CREATE INDEX pod_executions_dispatch_idx ON pod_artwork_executions(tenant_id,phase,next_attempt_at);
ALTER TABLE pod_artwork_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE pod_artwork_executions FORCE ROW LEVEL SECURITY;
CREATE POLICY pod_executions_tenant_policy ON pod_artwork_executions FOR ALL TO yummyai_app
 USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid))
 WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
GRANT SELECT,INSERT,UPDATE ON pod_artwork_executions TO yummyai_app;
--> statement-breakpoint
CREATE FUNCTION protect_pod_execution() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item jsonb;
BEGIN
 IF TG_OP='UPDATE' AND (NEW.task_id<>OLD.task_id OR NEW.tenant_id<>OLD.tenant_id OR NEW.contract_version<>OLD.contract_version OR NEW.input_fingerprint<>OLD.input_fingerprint
 OR NEW.attempt_count<OLD.attempt_count OR NEW.dispatch_count<OLD.dispatch_count
 OR (OLD.response_object_key IS NOT NULL AND (NEW.response_object_key IS DISTINCT FROM OLD.response_object_key OR NEW.encrypted_checksum IS DISTINCT FROM OLD.encrypted_checksum OR NEW.response_checksum IS DISTINCT FROM OLD.response_checksum OR NEW.response_expires_at IS DISTINCT FROM OLD.response_expires_at))
 OR (OLD.response_purged_at IS NOT NULL AND NEW.response_purged_at IS DISTINCT FROM OLD.response_purged_at)
 OR (OLD.artifact_manifest IS NOT NULL AND NEW.artifact_manifest IS DISTINCT FROM OLD.artifact_manifest)
 OR (OLD.phase IN ('completed','failed','uncertain') AND (to_jsonb(NEW)-ARRAY['response_purged_at','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['response_purged_at','updated_at'])))
 THEN RAISE EXCEPTION 'POD execution evidence is immutable' USING ERRCODE='55000'; END IF;
 IF NEW.response_object_key IS NOT NULL AND (
  NEW.response_object_key<>'tenants/'||NEW.tenant_id::text||'/quarantine/'||NEW.encrypted_checksum||'/'||NEW.task_id::text||'-pod-response.pe'
  OR NOT EXISTS(SELECT 1 FROM pod_artwork_invocations p WHERE p.tenant_id=NEW.tenant_id AND p.task_id=NEW.task_id AND p.attempt_number=1 AND p.received_at IS NOT NULL AND p.response_checksum=NEW.response_checksum))
 THEN RAISE EXCEPTION 'POD response must reference its original receipt and private object' USING ERRCODE='55000'; END IF;
 IF NEW.artifact_manifest IS NOT NULL THEN
  FOR item IN SELECT * FROM jsonb_array_elements(NEW.artifact_manifest) LOOP
   IF jsonb_typeof(item)<>'object' OR item->>'objectKey' IS NULL OR item->>'checksumSha256' IS NULL
    OR item-ARRAY['objectKey','checksumSha256']<>'{}'::jsonb
    OR item->>'checksumSha256' !~ '^[a-f0-9]{64}$'
    OR split_part(item->>'objectKey','/',1)<>'tenants' OR split_part(item->>'objectKey','/',2)<>NEW.tenant_id::text OR split_part(item->>'objectKey','/',3)<>'authorized'
    OR split_part(item->>'objectKey','/',4)<>item->>'checksumSha256'
    OR split_part(item->>'objectKey','/',5) !~ ('^'||NEW.task_id::text||'-pod-output-[0-9]{1,3}\.(png|jpg|webp|tiff|svg|mp4|zip|ps|txt)$')
    OR array_length(string_to_array(item->>'objectKey','/'),1)<>5
   THEN RAISE EXCEPTION 'POD artifacts must remain in their original execution namespace' USING ERRCODE='55000'; END IF;
  END LOOP;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER pod_execution_immutable BEFORE INSERT OR UPDATE ON pod_artwork_executions FOR EACH ROW EXECUTE FUNCTION protect_pod_execution();
