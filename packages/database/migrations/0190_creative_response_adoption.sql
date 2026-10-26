-- New local adoption facts only. Original executions, submissions, budgets and
-- response archives retain their historical identity and terminal state.
CREATE TABLE creative_response_adoptions (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id),
 execution_id uuid NOT NULL, candidate_id uuid NOT NULL, requested_by uuid NOT NULL REFERENCES app_users(id), request_id uuid NOT NULL,
 request_checksum text NOT NULL, expected_basis text NOT NULL, request jsonb NOT NULL, source_pin jsonb NOT NULL,
 status text NOT NULL DEFAULT 'prepared', attempt_count integer NOT NULL DEFAULT 0,
 lease_token uuid, lease_expires_at timestamptz, artifact_intent jsonb, artifact_discarded_at timestamptz,
 error_code text, receipt jsonb, committed_at timestamptz, cancelled_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT creative_response_adoption_execution_fk FOREIGN KEY(tenant_id,execution_id) REFERENCES creative_executions(tenant_id,id) ON DELETE RESTRICT,
 CONSTRAINT creative_response_adoption_candidate_fk FOREIGN KEY(tenant_id,candidate_id) REFERENCES creative_design_candidates(tenant_id,id) ON DELETE RESTRICT,
 CONSTRAINT creative_response_adoption_id_check CHECK(substring(id::text from 15 for 1)='7'),
 CONSTRAINT creative_response_adoption_hash_check CHECK(request_checksum~'^[a-f0-9]{64}$' AND expected_basis~'^[a-f0-9]{64}$'),
 CONSTRAINT creative_response_adoption_status_check CHECK(status IN ('prepared','processing','committed','cancelled') AND attempt_count BETWEEN 0 AND 3),
 CONSTRAINT creative_response_adoption_lease_check CHECK((status='processing')=(lease_token IS NOT NULL AND lease_expires_at IS NOT NULL) AND (lease_token IS NULL)=(lease_expires_at IS NULL)),
 CONSTRAINT creative_response_adoption_terminal_check CHECK((status='committed')=(receipt IS NOT NULL AND committed_at IS NOT NULL) AND (status='cancelled')=(cancelled_at IS NOT NULL))
);
CREATE UNIQUE INDEX creative_response_adoptions_tenant_id_unique ON creative_response_adoptions(tenant_id,id);
CREATE UNIQUE INDEX creative_response_adoptions_execution_unique ON creative_response_adoptions(tenant_id,execution_id);
CREATE UNIQUE INDEX creative_response_adoptions_request_unique ON creative_response_adoptions(tenant_id,requested_by,request_id);
CREATE INDEX creative_response_adoptions_owner_idx ON creative_response_adoptions(tenant_id,requested_by,created_at);
ALTER TABLE creative_response_adoptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE creative_response_adoptions FORCE ROW LEVEL SECURITY;
CREATE POLICY creative_response_adoption_owner ON creative_response_adoptions TO yummyai_app
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND requested_by=nullif(current_setting('app.user_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND requested_by=nullif(current_setting('app.user_id',true),'')::uuid);
GRANT SELECT,INSERT ON creative_response_adoptions TO yummyai_app;
GRANT UPDATE(status,attempt_count,lease_token,lease_expires_at,artifact_intent,artifact_discarded_at,error_code,receipt,committed_at,cancelled_at,updated_at) ON creative_response_adoptions TO yummyai_app;
--> statement-breakpoint
CREATE FUNCTION guard_creative_response_adoption() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE original creative_executions; candidate creative_design_candidates; parent creative_design_batches;
 item creative_design_batch_items; expected jsonb; intent jsonb; txid text; candidate_txid text;
BEGIN
 IF NEW.tenant_id::text IS DISTINCT FROM current_setting('app.tenant_id',true)
  OR NEW.requested_by::text IS DISTINCT FROM current_setting('app.user_id',true)
  OR NEW.request IS DISTINCT FROM jsonb_build_object('requestId',NEW.request_id::text,'expectedBasis',NEW.expected_basis,'acknowledgeReviewRequired',true)
  OR NEW.source_pin->>'version' IS DISTINCT FROM '1'
  OR NEW.source_pin->>'executionId' IS DISTINCT FROM NEW.execution_id::text
  OR NEW.source_pin->>'candidateId' IS DISTINCT FROM NEW.candidate_id::text THEN
  RAISE EXCEPTION 'creative_adoption_original_identity_required' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(OLD)-ARRAY['status','attempt_count','lease_token','lease_expires_at','artifact_intent','artifact_discarded_at','error_code','receipt','committed_at','cancelled_at','updated_at'])
    IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['status','attempt_count','lease_token','lease_expires_at','artifact_intent','artifact_discarded_at','error_code','receipt','committed_at','cancelled_at','updated_at'])
   OR (OLD.artifact_intent IS NOT NULL AND OLD.artifact_intent IS DISTINCT FROM NEW.artifact_intent)
   OR OLD.status='committed' THEN
   RAISE EXCEPTION 'creative_adoption_original_immutable' USING ERRCODE='23514';END IF;
  IF OLD.status='cancelled' THEN
   IF (to_jsonb(OLD)-ARRAY['artifact_discarded_at','updated_at']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['artifact_discarded_at','updated_at'])
    OR OLD.artifact_discarded_at IS NOT NULL OR NEW.artifact_discarded_at IS NULL OR NEW.artifact_intent IS NULL
    OR EXISTS(SELECT 1 FROM asset_files a WHERE a.tenant_id=NEW.tenant_id AND a.object_key=NEW.artifact_intent->>'objectKey') THEN
    RAISE EXCEPTION 'creative_adoption_cleanup_owner_required' USING ERRCODE='23514';END IF;
   RETURN NEW;
  END IF;
  IF NEW.artifact_discarded_at IS NOT NULL THEN RAISE EXCEPTION 'creative_adoption_cleanup_before_cancel' USING ERRCODE='23514';END IF;
  IF NEW.status='processing' AND OLD.status='prepared' THEN
   IF NEW.attempt_count<>OLD.attempt_count+1 OR NEW.attempt_count>3 OR NEW.lease_token IS NULL
    OR NEW.lease_token IS NOT DISTINCT FROM OLD.lease_token OR NEW.error_code IS NOT NULL
    OR NEW.artifact_intent IS DISTINCT FROM OLD.artifact_intent
    OR NEW.lease_expires_at<=clock_timestamp() OR NEW.lease_expires_at>clock_timestamp()+interval '181 seconds' THEN
    RAISE EXCEPTION 'creative_adoption_finite_lease_required' USING ERRCODE='23514';END IF;
   RETURN NEW;
  END IF;
  IF NEW.attempt_count<>OLD.attempt_count THEN RAISE EXCEPTION 'creative_adoption_attempt_immutable' USING ERRCODE='23514';END IF;
  IF NEW.status='cancelled' THEN
   IF OLD.status<>'prepared' OR NEW.receipt IS NOT NULL OR NEW.committed_at IS NOT NULL
    OR NEW.cancelled_at IS NULL OR NEW.artifact_intent IS DISTINCT FROM OLD.artifact_intent THEN
    RAISE EXCEPTION 'creative_adoption_cancel_quiescent_only' USING ERRCODE='23514';END IF;
   RETURN NEW;
  END IF;
  IF OLD.status<>'processing' THEN RAISE EXCEPTION 'creative_adoption_processing_required' USING ERRCODE='23514';END IF;
  IF NEW.status='prepared' THEN
   IF NEW.error_code IS NULL OR length(NEW.error_code)>100 OR NEW.artifact_intent IS DISTINCT FROM OLD.artifact_intent
    OR NEW.receipt IS NOT NULL OR NEW.committed_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'creative_adoption_failure_receipt_required' USING ERRCODE='23514';END IF;
   RETURN NEW;
  END IF;
  -- A dispatched storage write with no confirmed readback must retain its
  -- ownership. Lease expiry cannot turn an unknown remote PUT into safe cleanup.
  IF NEW.status='processing' AND NEW.artifact_intent IS NOT DISTINCT FROM OLD.artifact_intent
   AND NEW.lease_token IS NOT DISTINCT FROM OLD.lease_token AND NEW.lease_expires_at IS NOT DISTINCT FROM OLD.lease_expires_at
   AND NEW.error_code='CREATIVE_ADOPTION_ARTIFACT_IO_FAILED' AND NEW.receipt IS NULL AND NEW.committed_at IS NULL THEN
   RETURN NEW;
  END IF;
  IF OLD.lease_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'creative_adoption_lease_lost' USING ERRCODE='23514';END IF;
  IF NEW.status='processing' THEN
   IF NEW.lease_token IS DISTINCT FROM OLD.lease_token OR NEW.lease_expires_at IS DISTINCT FROM OLD.lease_expires_at
    OR NEW.artifact_intent IS NULL OR OLD.artifact_intent IS NOT NULL
    OR NEW.error_code IS DISTINCT FROM OLD.error_code OR NEW.receipt IS NOT NULL OR NEW.committed_at IS NOT NULL THEN
    RAISE EXCEPTION 'creative_adoption_exact_intent_required' USING ERRCODE='23514';END IF;
  ELSIF NEW.status<>'committed' THEN RAISE EXCEPTION 'creative_adoption_transition_invalid' USING ERRCODE='23514';END IF;
 ELSE
  IF NEW.status<>'prepared' OR NEW.attempt_count<>0 OR NEW.artifact_intent IS NOT NULL OR NEW.artifact_discarded_at IS NOT NULL
   OR NEW.error_code IS NOT NULL OR NEW.receipt IS NOT NULL OR NEW.committed_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL THEN
   RAISE EXCEPTION 'creative_adoption_must_prepare' USING ERRCODE='23514';END IF;
 END IF;
 -- Owning service takes original execution, parent, ordered items, candidate,
 -- then asset locks before this trigger. No parent-to-execution lock reversal.
 SELECT * INTO original FROM creative_executions WHERE tenant_id=NEW.tenant_id AND id=NEW.execution_id;
 SELECT * INTO candidate FROM creative_design_candidates WHERE tenant_id=NEW.tenant_id AND id=NEW.candidate_id;
 SELECT xmin::text INTO candidate_txid FROM creative_design_candidates WHERE tenant_id=NEW.tenant_id AND id=NEW.candidate_id;
 SELECT * INTO item FROM creative_design_batch_items WHERE tenant_id=NEW.tenant_id AND id=candidate.item_id;
 SELECT * INTO parent FROM creative_design_batches WHERE tenant_id=NEW.tenant_id AND id=item.batch_id;
 IF original.id IS NULL OR candidate.id IS NULL OR parent.id IS NULL
  OR original.kind<>'creative_candidate' OR original.step_key<>'generate' OR original.effect<>'external_request'
  OR original.candidate_id IS DISTINCT FROM NEW.candidate_id OR original.requested_by IS DISTINCT FROM NEW.requested_by
  OR original.phase NOT IN ('failed','uncertain') OR original.phase IS DISTINCT FROM NEW.source_pin->>'originalPhase'
  OR original.input_fingerprint IS DISTINCT FROM NEW.source_pin->>'inputFingerprint'
  OR original.authority_checksum IS DISTINCT FROM NEW.source_pin->>'authorityChecksum'
  OR original.receipt IS DISTINCT FROM NEW.source_pin->'receipt'
  OR original.response_object_key IS DISTINCT FROM NEW.source_pin->>'responseObjectKey'
  OR original.encrypted_checksum IS DISTINCT FROM NEW.source_pin->>'encryptedChecksum'
  OR original.response_checksum IS DISTINCT FROM NEW.source_pin->>'responseChecksum'
  OR original.response_expires_at IS DISTINCT FROM (NEW.source_pin->>'responseExpiresAt')::timestamptz
  OR original.response_expires_at<=clock_timestamp() OR original.response_purged_at IS NOT NULL
  OR original.submission_token::text IS DISTINCT FROM NEW.source_pin->>'submissionToken'
  OR original.submitted_at IS DISTINCT FROM (NEW.source_pin->>'submittedAt')::timestamptz
  OR item.id::text IS DISTINCT FROM NEW.source_pin->>'itemId' OR parent.id::text IS DISTINCT FROM NEW.source_pin->>'batchId'
  OR parent.archived_at IS NOT NULL OR parent.status IN ('completed','cancelled') OR item.status IN ('completed','cancelled') THEN
  RAISE EXCEPTION 'creative_adoption_live_original_basis_required' USING ERRCODE='23514';END IF;
 IF NEW.artifact_intent IS NOT NULL THEN
  intent:=NEW.artifact_intent;
  IF (jsonb_typeof(intent)='object'
   AND intent ?& ARRAY['assetId','objectKey','fileName','checksumSha256','byteSize','mediaType','width','height','modelKey','modelVersion','seed','qualityCheckSnapshot','outputMetadata']
   AND (SELECT count(*) FROM jsonb_object_keys(intent))=13
   AND jsonb_typeof(intent->'assetId')='string' AND jsonb_typeof(intent->'objectKey')='string'
   AND jsonb_typeof(intent->'fileName')='string' AND jsonb_typeof(intent->'checksumSha256')='string'
   AND jsonb_typeof(intent->'byteSize')='number' AND intent->>'byteSize'~'^[1-9][0-9]{0,7}$'
   AND jsonb_typeof(intent->'width')='number' AND intent->>'width'~'^[1-9][0-9]{0,7}$'
   AND jsonb_typeof(intent->'height')='number' AND intent->>'height'~'^[1-9][0-9]{0,7}$'
   AND jsonb_typeof(intent->'mediaType')='string' AND jsonb_typeof(intent->'modelKey')='string'
   AND length(intent->>'modelKey') BETWEEN 1 AND 160 AND jsonb_typeof(intent->'modelVersion')='string'
   AND length(intent->>'modelVersion') BETWEEN 1 AND 160
   AND (jsonb_typeof(intent->'seed')='null' OR (jsonb_typeof(intent->'seed')='string' AND length(intent->>'seed')<=1000))
   AND jsonb_typeof(intent->'qualityCheckSnapshot')='object' AND jsonb_typeof(intent->'outputMetadata')='object') IS NOT TRUE THEN
   RAISE EXCEPTION 'creative_adoption_artifact_intent_invalid' USING ERRCODE='23514';END IF;
  IF intent->>'assetId'!~'^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
   OR intent->>'checksumSha256'!~'^[a-f0-9]{64}$' OR intent->>'mediaType' NOT IN ('image/png','image/jpeg','image/webp','image/tiff')
   OR (intent->>'byteSize')::bigint NOT BETWEEN 1 AND 52428800
   OR (intent->>'width')::integer<=0 OR (intent->>'height')::integer<=0
   OR (intent->>'width')::bigint*(intent->>'height')::bigint>64000000
   OR intent->>'fileName' IS DISTINCT FROM (NEW.id::text||'-pod-output-0.'||(CASE intent->>'mediaType' WHEN 'image/png' THEN 'png' WHEN 'image/jpeg' THEN 'jpg' WHEN 'image/webp' THEN 'webp' ELSE 'tiff' END))
   OR intent->>'objectKey' IS DISTINCT FROM 'tenants/'||NEW.tenant_id::text||'/authorized/'||(intent->>'checksumSha256')||'/'||(intent->>'fileName') THEN
   RAISE EXCEPTION 'creative_adoption_artifact_intent_invalid' USING ERRCODE='23514';END IF;
 END IF;
 IF NEW.status<>'committed' THEN
  IF candidate.status<>'failed' OR candidate.asset_id IS NOT NULL OR candidate.asset_version IS NOT NULL OR candidate.checksum_sha256 IS NOT NULL THEN
   RAISE EXCEPTION 'creative_adoption_empty_failed_candidate_required' USING ERRCODE='23514';END IF;
  RETURN NEW;
 END IF;
 IF NEW.artifact_intent IS NULL OR NEW.committed_at IS NULL OR NEW.cancelled_at IS NOT NULL OR NEW.error_code IS NOT NULL THEN
  RAISE EXCEPTION 'creative_adoption_commit_invalid' USING ERRCODE='23514';END IF;
 expected:=jsonb_build_object('version','creative-response-adoption-v1','id',NEW.id::text,'executionId',NEW.execution_id::text,
  'requestId',NEW.request_id::text,'basis',NEW.expected_basis,'candidateId',NEW.candidate_id::text,
  'originalPhase',NEW.source_pin->>'originalPhase','inputFingerprint',NEW.source_pin->>'inputFingerprint',
  'responseChecksum',NEW.source_pin->>'responseChecksum','encryptedChecksum',NEW.source_pin->>'encryptedChecksum',
  'artifact',jsonb_build_object('assetId',intent->>'assetId','version',1,'checksumSha256',intent->>'checksumSha256',
   'mediaType',intent->>'mediaType','width',(intent->>'width')::integer,'height',(intent->>'height')::integer),
  'modelKey',intent->>'modelKey','modelVersion',intent->>'modelVersion','originalCostUsd',NEW.source_pin->'receipt'->'costUsd',
  'disposition','generated','rightsStatus','unverified','approval','review_required','committedAt',NEW.receipt->>'committedAt');
 IF NEW.receipt IS DISTINCT FROM expected OR (NEW.receipt->>'committedAt')::timestamptz IS DISTINCT FROM NEW.committed_at THEN
  RAISE EXCEPTION 'creative_adoption_original_receipt_required' USING ERRCODE='23514';END IF;
 txid:=mod(pg_current_xact_id()::text::numeric,4294967296)::text;
 IF candidate.status<>'generated' OR candidate.asset_id::text IS DISTINCT FROM intent->>'assetId'
  OR candidate.asset_version<>1 OR candidate.checksum_sha256 IS DISTINCT FROM intent->>'checksumSha256'
  OR candidate.model_key IS DISTINCT FROM intent->>'modelKey' OR candidate.model_version IS DISTINCT FROM intent->>'modelVersion'
  OR candidate_txid IS DISTINCT FROM txid
  OR NOT EXISTS(SELECT 1 FROM asset_files a WHERE a.tenant_id=NEW.tenant_id AND a.id::text=intent->>'assetId'
   AND a.owner_user_id=NEW.requested_by AND a.asset_domain='authorized' AND a.rights_status='unverified'
   AND a.ai_generated AND a.version=1 AND a.deleted_at IS NULL AND a.object_key=intent->>'objectKey'
   AND a.checksum_sha256=intent->>'checksumSha256' AND a.media_type=intent->>'mediaType'
   AND a.byte_size=(intent->>'byteSize')::bigint AND a.xmin::text=txid) THEN
  RAISE EXCEPTION 'creative_adoption_owner_commit_birth_required' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER creative_response_adoption_guard BEFORE INSERT OR UPDATE ON creative_response_adoptions
 FOR EACH ROW EXECUTE FUNCTION guard_creative_response_adoption();
