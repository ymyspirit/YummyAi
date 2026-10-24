-- New executions only: historical owners, authority and receipts are never backfilled.
CREATE UNIQUE INDEX creative_studio_generations_tenant_id_unique ON creative_studio_generations(tenant_id,id);
CREATE TABLE creative_executions (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), parent_execution_id uuid,
 kind text NOT NULL, step_key text NOT NULL,
 candidate_id uuid, creative_version_id uuid, inspection_id uuid, mockup_item_id uuid, studio_generation_id uuid,
 requested_by uuid NOT NULL REFERENCES app_users(id),
 authority_snapshot jsonb NOT NULL, authority_checksum text NOT NULL, input_fingerprint text NOT NULL,
 execution_contract jsonb NOT NULL, method_selection jsonb NOT NULL, effect text NOT NULL,
 phase text NOT NULL DEFAULT 'pending', attempt_count integer NOT NULL DEFAULT 0, dispatch_count integer NOT NULL DEFAULT 0,
 next_attempt_at timestamptz NOT NULL DEFAULT now(), last_dispatched_at timestamptz,
 lease_token uuid, lease_expires_at timestamptz, submitted_at timestamptz, submission_token uuid,
 budget_limit_usd numeric(14,6), budget_ledger_id uuid, receipt jsonb,
 response_object_key text, encrypted_checksum text, response_checksum text, response_expires_at timestamptz, response_purged_at timestamptz,
 artifact_manifest jsonb, completion_evidence jsonb, completion_checksum text, error_code text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT creative_exec_candidate_fk FOREIGN KEY(tenant_id,candidate_id) REFERENCES creative_design_candidates(tenant_id,id) ON DELETE RESTRICT,
 CONSTRAINT creative_exec_version_fk FOREIGN KEY(tenant_id,creative_version_id) REFERENCES creative_design_versions(tenant_id,id) ON DELETE RESTRICT,
 CONSTRAINT creative_exec_inspection_fk FOREIGN KEY(tenant_id,inspection_id) REFERENCES mockup_template_source_inspections(tenant_id,id) ON DELETE RESTRICT,
 CONSTRAINT creative_exec_mockup_fk FOREIGN KEY(tenant_id,mockup_item_id) REFERENCES mockup_batch_items(tenant_id,id) ON DELETE RESTRICT,
 CONSTRAINT creative_exec_studio_fk FOREIGN KEY(tenant_id,studio_generation_id) REFERENCES creative_studio_generations(tenant_id,id) ON DELETE RESTRICT,
 CONSTRAINT creative_exec_budget_fk FOREIGN KEY(tenant_id,budget_ledger_id) REFERENCES ai_budget_ledger(tenant_id,id) ON DELETE RESTRICT,
 CONSTRAINT creative_exec_owner_check CHECK(num_nonnulls(candidate_id,creative_version_id,inspection_id,mockup_item_id,studio_generation_id)=1 AND
  ((kind='creative_candidate' AND candidate_id IS NOT NULL) OR (kind='creative_adaptation' AND creative_version_id IS NOT NULL) OR
   (kind='template_compile' AND inspection_id IS NOT NULL) OR (kind='mockup_render' AND mockup_item_id IS NOT NULL) OR (kind='studio_generation' AND studio_generation_id IS NOT NULL))),
 CONSTRAINT creative_exec_authority_check CHECK((authority_snapshot->>'version'='creative-authority-v1' AND authority_snapshot->'context'->>'tenantId'=tenant_id::text AND authority_snapshot->'context'->>'userId'=requested_by::text) IS TRUE),
 CONSTRAINT creative_exec_uuid_check CHECK(substring(id::text from 15 for 1)='7'),
 CONSTRAINT creative_exec_hash_check CHECK(authority_checksum ~ '^[a-f0-9]{64}$' AND input_fingerprint ~ '^[a-f0-9]{64}$'),
 CONSTRAINT creative_exec_state_check CHECK(phase IN ('pending','preparing','submitted','response_staging','response_ready','completed','failed','uncertain') AND effect IN ('external_request','internal_write') AND attempt_count BETWEEN 0 AND 3 AND dispatch_count>=0),
 CONSTRAINT creative_exec_lease_check CHECK((lease_token IS NULL)=(lease_expires_at IS NULL)),
 CONSTRAINT creative_exec_step_check CHECK(length(step_key) BETWEEN 1 AND 160),
 CONSTRAINT creative_exec_submission_check CHECK(((submitted_at IS NULL AND submission_token IS NULL) OR (effect='external_request' AND submitted_at IS NOT NULL AND submission_token IS NOT NULL AND budget_ledger_id IS NOT NULL AND budget_limit_usd>0)) IS TRUE),
 CONSTRAINT creative_exec_completion_check CHECK(((phase<>'completed' AND completion_evidence IS NULL AND completion_checksum IS NULL) OR (phase='completed' AND completion_evidence IS NOT NULL AND completion_checksum ~ '^[a-f0-9]{64}$')) IS TRUE),
 CONSTRAINT creative_exec_response_check CHECK(((response_object_key IS NULL AND encrypted_checksum IS NULL AND response_checksum IS NULL AND response_expires_at IS NULL AND response_purged_at IS NULL) OR
  (response_object_key IS NOT NULL AND encrypted_checksum ~ '^[a-f0-9]{64}$' AND response_checksum ~ '^[a-f0-9]{64}$' AND response_expires_at IS NOT NULL AND (effect='internal_write' OR receipt IS NOT NULL))) IS TRUE),
 CONSTRAINT creative_exec_checkpoint_check CHECK(phase NOT IN ('response_staging','response_ready','completed') OR response_object_key IS NOT NULL)
);
CREATE UNIQUE INDEX creative_executions_tenant_id_unique ON creative_executions(tenant_id,id);
ALTER TABLE creative_executions ADD CONSTRAINT creative_exec_parent_fk FOREIGN KEY(tenant_id,parent_execution_id) REFERENCES creative_executions(tenant_id,id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX creative_executions_original_step_unique ON creative_executions(tenant_id,kind,(coalesce(candidate_id,creative_version_id,inspection_id,mockup_item_id,studio_generation_id)),step_key);
CREATE INDEX creative_executions_dispatch_idx ON creative_executions(tenant_id,phase,next_attempt_at);
ALTER TABLE creative_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE creative_executions FORCE ROW LEVEL SECURITY;
CREATE POLICY creative_executions_tenant_policy ON creative_executions FOR ALL TO yummyai_app
 USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid))
 WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
GRANT SELECT,INSERT,UPDATE ON creative_executions TO yummyai_app;
--> statement-breakpoint
CREATE FUNCTION protect_creative_execution() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item jsonb; parent creative_executions%ROWTYPE; permission_key text; old_scope text; new_scope text;
BEGIN
 IF NEW.kind='creative_adaptation' AND ((NEW.effect='external_request' AND NEW.parent_execution_id IS NULL)
  OR (NEW.effect='internal_write' AND (NEW.parent_execution_id IS NOT NULL OR NEW.step_key NOT LIKE 'spec:%')))
 THEN RAISE EXCEPTION 'Creative outpainting requires its original adaptation parent' USING ERRCODE='55000'; END IF;
 IF NEW.parent_execution_id IS NOT NULL THEN
  SELECT * INTO parent FROM creative_executions WHERE tenant_id=NEW.tenant_id AND id=NEW.parent_execution_id FOR SHARE;
  IF NOT FOUND OR NEW.kind<>'creative_adaptation' OR NEW.effect<>'external_request' OR parent.kind<>'creative_adaptation'
   OR parent.effect<>'internal_write' OR parent.creative_version_id IS DISTINCT FROM NEW.creative_version_id
   OR parent.requested_by<>NEW.requested_by OR parent.step_key NOT LIKE 'spec:%'
   OR NEW.step_key<>'outpaint:'||substr(parent.step_key,6)
   OR ((NEW.authority_snapshot->'context'->'permissions') <@ (parent.authority_snapshot->'context'->'permissions')) IS NOT TRUE
   OR (coalesce(NEW.authority_snapshot->'context'->'teamIds','[]'::jsonb) <@ coalesce(parent.authority_snapshot->'context'->'teamIds','[]'::jsonb)) IS NOT TRUE
  THEN RAISE EXCEPTION 'Creative child must retain its original owner and permission ceiling' USING ERRCODE='55000'; END IF;
  FOR permission_key IN SELECT jsonb_array_elements_text(NEW.authority_snapshot->'context'->'permissions') LOOP
   old_scope=coalesce(parent.authority_snapshot->'context'->'permissionScopes'->>permission_key,parent.authority_snapshot->'context'->>'dataScope');
   new_scope=coalesce(NEW.authority_snapshot->'context'->'permissionScopes'->>permission_key,NEW.authority_snapshot->'context'->>'dataScope');
   IF old_scope IS NULL OR (CASE new_scope WHEN 'self' THEN 0 WHEN 'team' THEN 1 WHEN 'tenant' THEN 2 ELSE 99 END)>
    (CASE old_scope WHEN 'self' THEN 0 WHEN 'team' THEN 1 WHEN 'tenant' THEN 2 ELSE -1 END)
   THEN RAISE EXCEPTION 'Creative child cannot expand its original scope' USING ERRCODE='55000'; END IF;
  END LOOP;
 END IF;
 IF NEW.effect='internal_write' AND (NEW.receipt IS NOT NULL OR NEW.budget_ledger_id IS NOT NULL OR NEW.budget_limit_usd IS NOT NULL)
 THEN RAISE EXCEPTION 'Local creative steps cannot fabricate paid invocation evidence' USING ERRCODE='55000'; END IF;
 IF TG_OP='UPDATE' AND (
  (to_jsonb(NEW)-ARRAY['phase','attempt_count','dispatch_count','last_dispatched_at','next_attempt_at','lease_token','lease_expires_at','submitted_at','submission_token','budget_ledger_id','budget_limit_usd','receipt','response_object_key','encrypted_checksum','response_checksum','response_expires_at','response_purged_at','artifact_manifest','completion_evidence','completion_checksum','error_code','updated_at'])
   IS DISTINCT FROM
  (to_jsonb(OLD)-ARRAY['phase','attempt_count','dispatch_count','last_dispatched_at','next_attempt_at','lease_token','lease_expires_at','submitted_at','submission_token','budget_ledger_id','budget_limit_usd','receipt','response_object_key','encrypted_checksum','response_checksum','response_expires_at','response_purged_at','artifact_manifest','completion_evidence','completion_checksum','error_code','updated_at'])
  OR NEW.attempt_count<OLD.attempt_count OR NEW.dispatch_count<OLD.dispatch_count
  OR (OLD.submitted_at IS NOT NULL AND (NEW.submitted_at IS DISTINCT FROM OLD.submitted_at OR NEW.submission_token IS DISTINCT FROM OLD.submission_token OR NEW.phase='pending'))
  OR (OLD.budget_ledger_id IS NOT NULL AND (NEW.budget_ledger_id IS DISTINCT FROM OLD.budget_ledger_id OR NEW.budget_limit_usd IS DISTINCT FROM OLD.budget_limit_usd))
  OR (OLD.receipt IS NOT NULL AND NEW.receipt IS DISTINCT FROM OLD.receipt)
  OR (OLD.response_object_key IS NOT NULL AND (NEW.response_object_key IS DISTINCT FROM OLD.response_object_key OR NEW.encrypted_checksum IS DISTINCT FROM OLD.encrypted_checksum OR NEW.response_checksum IS DISTINCT FROM OLD.response_checksum OR NEW.response_expires_at IS DISTINCT FROM OLD.response_expires_at))
  OR (OLD.response_purged_at IS NOT NULL AND NEW.response_purged_at IS DISTINCT FROM OLD.response_purged_at)
  OR (OLD.artifact_manifest IS NOT NULL AND NEW.artifact_manifest IS DISTINCT FROM OLD.artifact_manifest)
  OR (OLD.completion_evidence IS NOT NULL AND (NEW.completion_evidence IS DISTINCT FROM OLD.completion_evidence OR NEW.completion_checksum IS DISTINCT FROM OLD.completion_checksum))
  OR (OLD.phase IN ('completed','failed','uncertain') AND
   (to_jsonb(NEW)-ARRAY['receipt','response_object_key','encrypted_checksum','response_checksum','response_expires_at','response_purged_at','updated_at'])
    IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['receipt','response_object_key','encrypted_checksum','response_checksum','response_expires_at','response_purged_at','updated_at']))
 ) THEN RAISE EXCEPTION 'Creative execution original input and receipts are immutable' USING ERRCODE='55000'; END IF;
 IF NEW.submitted_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ai_budget_ledger b WHERE b.tenant_id=NEW.tenant_id AND b.id=NEW.budget_ledger_id
  AND b.request_id=CASE WHEN NEW.kind='studio_generation' THEN NEW.studio_generation_id ELSE NEW.id END)
 THEN RAISE EXCEPTION 'Creative submission requires its original budget reservation' USING ERRCODE='55000'; END IF;
 IF NEW.receipt IS NOT NULL AND (NEW.effect='external_request' AND NEW.submitted_at IS NULL OR
  (NEW.receipt->>'version'='pod-response-v1' AND NEW.receipt->>'responseChecksum' ~ '^[a-f0-9]{64}$') IS NOT TRUE)
 THEN RAISE EXCEPTION 'Creative receipt requires its original submission' USING ERRCODE='55000'; END IF;
 IF NEW.response_object_key IS NOT NULL AND (NEW.response_object_key<>'tenants/'||NEW.tenant_id::text||'/quarantine/'||NEW.encrypted_checksum||'/'||NEW.id::text||'-pod-response.pe'
  OR (NEW.receipt IS NOT NULL AND NEW.receipt->>'responseChecksum' IS DISTINCT FROM NEW.response_checksum))
 THEN RAISE EXCEPTION 'Creative response must use its original private namespace and receipt' USING ERRCODE='55000'; END IF;
 IF NEW.artifact_manifest IS NOT NULL THEN
  IF jsonb_typeof(NEW.artifact_manifest)<>'array' OR jsonb_array_length(NEW.artifact_manifest) NOT BETWEEN 1 AND 100
  THEN RAISE EXCEPTION 'Creative artifact manifest is invalid' USING ERRCODE='55000'; END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(NEW.artifact_manifest) LOOP
   IF jsonb_typeof(item)<>'object' OR item->>'objectKey' IS NULL OR item->>'checksumSha256' IS NULL OR item-ARRAY['objectKey','checksumSha256']<>'{}'::jsonb
    OR item->>'checksumSha256' !~ '^[a-f0-9]{64}$' OR split_part(item->>'objectKey','/',1)<>'tenants' OR split_part(item->>'objectKey','/',2)<>NEW.tenant_id::text
    OR split_part(item->>'objectKey','/',3)<>'authorized' OR split_part(item->>'objectKey','/',4)<>item->>'checksumSha256'
    OR split_part(item->>'objectKey','/',5) !~ ('^'||NEW.id::text||'-pod-output-[0-9]{1,3}[.](png|jpg|webp|tiff|svg|mp4|webm|zip|ps|txt|json|bin)$')
    OR array_length(string_to_array(item->>'objectKey','/'),1)<>5
   THEN RAISE EXCEPTION 'Creative artifact must stay in its original execution namespace' USING ERRCODE='55000'; END IF;
  END LOOP;
 END IF;
 IF NEW.phase='completed' THEN
  IF (NEW.completion_evidence->>'version'='creative-completion-v1' AND NEW.completion_evidence->>'executionId'=NEW.id::text
   AND NEW.completion_evidence->>'inputFingerprint'=NEW.input_fingerprint
   AND NEW.completion_evidence->>'responseChecksum'=NEW.response_checksum
   AND NEW.completion_evidence->>'ownerResultChecksum' ~ '^[a-f0-9]{64}$'
   AND jsonb_typeof(NEW.completion_evidence->'artifacts')='array'
   AND jsonb_array_length(NEW.completion_evidence->'artifacts')=coalesce(jsonb_array_length(NEW.artifact_manifest),0)) IS NOT TRUE
  THEN RAISE EXCEPTION 'Creative completion requires its original input, response and artifacts' USING ERRCODE='55000'; END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(NEW.completion_evidence->'artifacts') LOOP
   IF NOT EXISTS(SELECT 1 FROM asset_files a WHERE a.tenant_id=NEW.tenant_id AND a.id::text=item->>'assetId'
    AND a.version=(item->>'version')::integer AND a.checksum_sha256=item->>'checksumSha256'
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.artifact_manifest) m WHERE m->>'objectKey'=a.object_key AND m->>'checksumSha256'=a.checksum_sha256))
   THEN RAISE EXCEPTION 'Creative completion cannot borrow an unrelated asset' USING ERRCODE='55000'; END IF;
  END LOOP;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER creative_execution_immutable BEFORE INSERT OR UPDATE ON creative_executions FOR EACH ROW EXECUTE FUNCTION protect_creative_execution();
--> statement-breakpoint
CREATE FUNCTION protect_creative_studio_provider_task() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.provider_task_id IS DISTINCT FROM OLD.provider_task_id AND
  (OLD.provider_task_id IS NOT NULL OR NEW.provider_task_id IS NULL OR NEW.provider_task_id !~ '^[a-zA-Z0-9_-]{1,160}$' OR NOT EXISTS(
   SELECT 1 FROM creative_executions e WHERE e.tenant_id=NEW.tenant_id AND e.studio_generation_id=NEW.id AND e.requested_by=NEW.owner_id AND e.submitted_at IS NOT NULL))
 THEN RAISE EXCEPTION 'Studio provider task requires its immutable original submission' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER creative_studio_provider_task_immutable BEFORE UPDATE ON creative_studio_generations FOR EACH ROW EXECUTE FUNCTION protect_creative_studio_provider_task();
