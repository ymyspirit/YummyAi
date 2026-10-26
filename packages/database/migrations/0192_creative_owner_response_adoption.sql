-- Independent, unreviewed local results for the four remaining Creative owners.
-- Original executions, provider receipts, fees and budget history are untouched.
CREATE TABLE creative_owner_response_adoptions (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES organizations(id),execution_id uuid NOT NULL,
 requested_by uuid NOT NULL REFERENCES app_users(id),kind text NOT NULL,owner_id uuid NOT NULL,parent_id uuid,
 request_id uuid NOT NULL,request_checksum text NOT NULL,expected_basis text NOT NULL,request jsonb NOT NULL,source_pin jsonb NOT NULL,
 status text NOT NULL DEFAULT 'prepared',attempt_count integer NOT NULL DEFAULT 0,lease_token uuid,lease_expires_at timestamptz,
 plan_pin jsonb,artifact_intents jsonb,artifact_discarded_at timestamptz,error_code text,owner_receipt jsonb,receipt jsonb,
 committed_at timestamptz,cancelled_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT creative_owner_adoptions_execution_fk FOREIGN KEY(tenant_id,execution_id) REFERENCES creative_executions(tenant_id,id) ON DELETE RESTRICT,
 CONSTRAINT creative_owner_adoptions_kind_check CHECK(kind IN ('creative_adaptation','template_compile','mockup_render','studio_generation')),
 CONSTRAINT creative_owner_adoptions_hash_check CHECK(request_checksum~'^[a-f0-9]{64}$' AND expected_basis~'^[a-f0-9]{64}$'),
 CONSTRAINT creative_owner_adoptions_status_check CHECK(status IN ('prepared','processing','committed','cancelled') AND attempt_count BETWEEN 0 AND 3),
 CONSTRAINT creative_owner_adoptions_lease_check CHECK((status='processing')=(lease_token IS NOT NULL AND lease_expires_at IS NOT NULL) AND (lease_token IS NULL)=(lease_expires_at IS NULL)),
 CONSTRAINT creative_owner_adoptions_terminal_check CHECK((status='committed')=(receipt IS NOT NULL) AND (status='committed')=(owner_receipt IS NOT NULL) AND (status='committed')=(committed_at IS NOT NULL) AND (status='cancelled')=(cancelled_at IS NOT NULL))
);
CREATE UNIQUE INDEX creative_owner_adoptions_tenant_id_unique ON creative_owner_response_adoptions(tenant_id,id);
CREATE UNIQUE INDEX creative_owner_adoptions_execution_unique ON creative_owner_response_adoptions(tenant_id,execution_id);
CREATE UNIQUE INDEX creative_owner_adoptions_request_unique ON creative_owner_response_adoptions(tenant_id,requested_by,request_id);
CREATE INDEX creative_owner_adoptions_owner_idx ON creative_owner_response_adoptions(tenant_id,kind,owner_id);
ALTER TABLE creative_owner_response_adoptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE creative_owner_response_adoptions FORCE ROW LEVEL SECURITY;
CREATE POLICY creative_owner_response_adoption_owner ON creative_owner_response_adoptions TO yummyai_app
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND requested_by=nullif(current_setting('app.user_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND requested_by=nullif(current_setting('app.user_id',true),'')::uuid);
-- Downstream reviewers verify this tenant-owned immutable fact through the real
-- business resource permission. Personal recovery routes also filter requester.
CREATE POLICY creative_owner_response_adoption_tenant_read ON creative_owner_response_adoptions FOR SELECT TO yummyai_app
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT ON creative_owner_response_adoptions TO yummyai_app;
GRANT UPDATE(status,attempt_count,lease_token,lease_expires_at,plan_pin,artifact_intents,artifact_discarded_at,error_code,owner_receipt,receipt,committed_at,cancelled_at,updated_at) ON creative_owner_response_adoptions TO yummyai_app;
--> statement-breakpoint
CREATE FUNCTION guard_creative_owner_response_adoption() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE original creative_executions;item jsonb;txid text;expected_artifacts jsonb;owner_artifacts jsonb;actual_owner uuid;valid_owner boolean;
BEGIN
 IF NEW.tenant_id::text IS DISTINCT FROM current_setting('app.tenant_id',true)
  OR NEW.requested_by::text IS DISTINCT FROM current_setting('app.user_id',true)
  OR substring(NEW.id::text from 15 for 1)<>'7'
  OR NEW.request IS DISTINCT FROM jsonb_build_object('requestId',NEW.request_id::text,'expectedBasis',NEW.expected_basis,'acknowledgeReviewRequired',true)
  OR NEW.source_pin->>'version' IS DISTINCT FROM '1' OR NEW.source_pin->>'executionId' IS DISTINCT FROM NEW.execution_id::text
  OR NEW.source_pin->>'kind' IS DISTINCT FROM NEW.kind OR NEW.source_pin->>'ownerId' IS DISTINCT FROM NEW.owner_id::text
  OR NEW.source_pin->>'parentId' IS DISTINCT FROM NEW.parent_id::text THEN
  RAISE EXCEPTION 'creative_owner_adoption_identity_required' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(OLD)-ARRAY['status','attempt_count','lease_token','lease_expires_at','plan_pin','artifact_intents','artifact_discarded_at','error_code','owner_receipt','receipt','committed_at','cancelled_at','updated_at'])
    IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['status','attempt_count','lease_token','lease_expires_at','plan_pin','artifact_intents','artifact_discarded_at','error_code','owner_receipt','receipt','committed_at','cancelled_at','updated_at'])
   OR OLD.status='committed' OR (OLD.plan_pin IS NOT NULL AND OLD.plan_pin IS DISTINCT FROM NEW.plan_pin)
   OR (OLD.artifact_intents IS NOT NULL AND OLD.artifact_intents IS DISTINCT FROM NEW.artifact_intents) THEN
   RAISE EXCEPTION 'creative_owner_adoption_immutable' USING ERRCODE='23514';END IF;
  IF OLD.status='cancelled' THEN
   IF (to_jsonb(OLD)-ARRAY['artifact_discarded_at','updated_at']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['artifact_discarded_at','updated_at'])
    OR OLD.artifact_discarded_at IS NOT NULL OR NEW.artifact_discarded_at IS NULL OR NEW.artifact_intents IS NULL
    OR EXISTS(SELECT 1 FROM asset_files a WHERE a.tenant_id=NEW.tenant_id AND a.object_key IN (SELECT x->>'objectKey' FROM jsonb_array_elements(NEW.artifact_intents) x)) THEN
    RAISE EXCEPTION 'creative_owner_adoption_cleanup_required' USING ERRCODE='23514';END IF;
   RETURN NEW;
  END IF;
  IF NEW.artifact_discarded_at IS NOT NULL THEN
   RAISE EXCEPTION 'creative_owner_adoption_cleanup_before_cancel' USING ERRCODE='23514';END IF;
  IF OLD.status='prepared' AND NEW.status='processing' THEN
   IF NEW.attempt_count<>OLD.attempt_count+1 OR NEW.attempt_count>3 OR NEW.lease_token IS NULL
    OR NEW.lease_token IS NOT DISTINCT FROM OLD.lease_token OR NEW.error_code IS NOT NULL
    OR NEW.plan_pin IS DISTINCT FROM OLD.plan_pin OR NEW.artifact_intents IS DISTINCT FROM OLD.artifact_intents
    OR NEW.lease_expires_at<=clock_timestamp() OR NEW.lease_expires_at>clock_timestamp()+interval '181 seconds' THEN
    RAISE EXCEPTION 'creative_owner_adoption_finite_lease_required' USING ERRCODE='23514';END IF;
   RETURN NEW;
  END IF;
  IF NEW.attempt_count<>OLD.attempt_count THEN RAISE EXCEPTION 'creative_owner_adoption_attempt_immutable' USING ERRCODE='23514';END IF;
  IF NEW.status='cancelled' THEN
   IF OLD.status<>'prepared' OR NEW.cancelled_at IS NULL OR NEW.receipt IS NOT NULL OR NEW.owner_receipt IS NOT NULL
    OR NEW.committed_at IS NOT NULL OR NEW.artifact_intents IS DISTINCT FROM OLD.artifact_intents OR NEW.plan_pin IS DISTINCT FROM OLD.plan_pin THEN
    RAISE EXCEPTION 'creative_owner_adoption_cancel_quiescent_only' USING ERRCODE='23514';END IF;
   RETURN NEW;
  END IF;
  IF OLD.status<>'processing' THEN RAISE EXCEPTION 'creative_owner_adoption_processing_required' USING ERRCODE='23514';END IF;
  IF NEW.status='prepared' THEN
   IF NEW.error_code IS NULL OR length(NEW.error_code)>100 OR NEW.receipt IS NOT NULL OR NEW.owner_receipt IS NOT NULL
    OR NEW.committed_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL OR NEW.artifact_intents IS DISTINCT FROM OLD.artifact_intents
    OR NEW.plan_pin IS DISTINCT FROM OLD.plan_pin THEN
    RAISE EXCEPTION 'creative_owner_adoption_failure_receipt_required' USING ERRCODE='23514';END IF;
   RETURN NEW;
  END IF;
  IF NEW.status='processing' AND NEW.lease_token IS NOT DISTINCT FROM OLD.lease_token
   AND NEW.lease_expires_at IS NOT DISTINCT FROM OLD.lease_expires_at AND NEW.plan_pin IS NOT DISTINCT FROM OLD.plan_pin
   AND NEW.artifact_intents IS NOT DISTINCT FROM OLD.artifact_intents AND NEW.error_code='CREATIVE_OWNER_ADOPTION_ARTIFACT_IO_FAILED'
   AND NEW.receipt IS NULL AND NEW.owner_receipt IS NULL AND NEW.committed_at IS NULL THEN RETURN NEW;END IF;
  IF OLD.lease_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'creative_owner_adoption_lease_lost' USING ERRCODE='23514';END IF;
  IF NEW.status='processing' THEN
   IF OLD.plan_pin IS NOT NULL OR OLD.artifact_intents IS NOT NULL OR NEW.plan_pin IS NULL OR NEW.artifact_intents IS NULL
    OR NEW.lease_token IS DISTINCT FROM OLD.lease_token OR NEW.lease_expires_at IS DISTINCT FROM OLD.lease_expires_at
    OR NEW.error_code IS DISTINCT FROM OLD.error_code OR NEW.receipt IS NOT NULL OR NEW.owner_receipt IS NOT NULL THEN
    RAISE EXCEPTION 'creative_owner_adoption_exact_intents_required' USING ERRCODE='23514';END IF;
  ELSIF NEW.status<>'committed' THEN RAISE EXCEPTION 'creative_owner_adoption_transition_invalid' USING ERRCODE='23514';END IF;
 ELSE
  IF NEW.status<>'prepared' OR NEW.attempt_count<>0 OR NEW.plan_pin IS NOT NULL OR NEW.artifact_intents IS NOT NULL
   OR NEW.artifact_discarded_at IS NOT NULL OR NEW.error_code IS NOT NULL OR NEW.owner_receipt IS NOT NULL OR NEW.receipt IS NOT NULL
   OR NEW.committed_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL THEN
   RAISE EXCEPTION 'creative_owner_adoption_must_prepare' USING ERRCODE='23514';END IF;
 END IF;
 SELECT * INTO original FROM creative_executions WHERE tenant_id=NEW.tenant_id AND id=NEW.execution_id;
 actual_owner:=coalesce(original.creative_version_id,original.inspection_id,original.mockup_item_id,original.studio_generation_id);
 IF original.id IS NULL OR original.kind IS DISTINCT FROM NEW.kind OR actual_owner IS DISTINCT FROM NEW.owner_id
  OR original.requested_by IS DISTINCT FROM NEW.requested_by OR original.phase NOT IN ('failed','uncertain')
  OR original.completion_evidence IS NOT NULL OR original.completion_checksum IS NOT NULL
  OR original.lease_token IS NOT NULL OR original.lease_expires_at IS NOT NULL
  OR original.response_object_key IS NULL OR original.encrypted_checksum IS NULL OR original.response_checksum IS NULL
  OR original.response_expires_at IS NULL
  OR (original.effect='external_request' AND (original.submission_token IS NULL OR original.submitted_at IS NULL OR original.receipt IS NULL))
  OR (original.effect='internal_write' AND (original.submission_token IS NOT NULL OR original.submitted_at IS NOT NULL OR original.receipt IS NOT NULL))
  OR original.phase IS DISTINCT FROM NEW.source_pin->>'originalPhase' OR original.effect IS DISTINCT FROM NEW.source_pin->>'effect'
  OR original.input_fingerprint IS DISTINCT FROM NEW.source_pin->>'inputFingerprint'
  OR original.authority_checksum IS DISTINCT FROM NEW.source_pin->>'authorityChecksum'
  OR original.response_object_key IS DISTINCT FROM NEW.source_pin->>'responseObjectKey'
  OR original.encrypted_checksum IS DISTINCT FROM NEW.source_pin->>'encryptedChecksum'
  OR original.response_checksum IS DISTINCT FROM NEW.source_pin->>'responseChecksum'
  OR original.response_expires_at IS DISTINCT FROM (NEW.source_pin->>'responseExpiresAt')::timestamptz
  OR original.response_expires_at<=clock_timestamp() OR original.response_purged_at IS NOT NULL
  OR original.response_object_key IS DISTINCT FROM 'tenants/'||NEW.tenant_id::text||'/quarantine/'||original.encrypted_checksum||'/'||NEW.execution_id::text||'-pod-response.pe'
  OR original.submission_token::text IS DISTINCT FROM NEW.source_pin->>'submissionToken'
  OR original.submitted_at IS DISTINCT FROM (NEW.source_pin->>'submittedAt')::timestamptz
  OR coalesce(original.receipt,'null'::jsonb) IS DISTINCT FROM NEW.source_pin->'receipt' THEN
  RAISE EXCEPTION 'creative_owner_adoption_original_basis_required' USING ERRCODE='23514';END IF;
 IF NEW.artifact_intents IS NOT NULL THEN
  IF jsonb_typeof(NEW.artifact_intents) IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.artifact_intents) NOT BETWEEN 1 AND 8
   OR jsonb_typeof(NEW.plan_pin) IS DISTINCT FROM 'object' OR NEW.plan_pin->>'version' IS DISTINCT FROM '1'
   OR NEW.plan_pin->>'executionId' IS DISTINCT FROM NEW.execution_id::text OR NEW.plan_pin->>'kind' IS DISTINCT FROM NEW.kind
   OR NEW.plan_pin->>'parentId' IS DISTINCT FROM NEW.parent_id::text
   OR NEW.plan_pin->>'ownerId' IS DISTINCT FROM NEW.owner_id::text OR coalesce(NEW.plan_pin->>'checksum','')!~'^[a-f0-9]{64}$'
   OR (SELECT count(DISTINCT x->>'role') FROM jsonb_array_elements(NEW.artifact_intents) x)<>jsonb_array_length(NEW.artifact_intents)
   OR (SELECT count(DISTINCT x->>'assetId') FROM jsonb_array_elements(NEW.artifact_intents) x)<>jsonb_array_length(NEW.artifact_intents) THEN
   RAISE EXCEPTION 'creative_owner_adoption_intents_invalid' USING ERRCODE='23514';END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(NEW.artifact_intents) LOOP
   IF (jsonb_typeof(item)='object' AND item ?& ARRAY['assetId','role','fileName','objectKey','checksumSha256','byteSize','mediaType','width','height','aiGenerated','rightsMetadata']
    AND (SELECT count(*) FROM jsonb_object_keys(item))=11
    AND jsonb_typeof(item->'byteSize')='number' AND item->>'byteSize'~'^[1-9][0-9]{0,7}$'
    AND jsonb_typeof(item->'aiGenerated')='boolean' AND jsonb_typeof(item->'rightsMetadata')='object'
    AND (item->>'mediaType' IN ('image/png','image/jpeg','image/webp','image/tiff')
      AND jsonb_typeof(item->'width')='number' AND item->>'width'~'^[1-9][0-9]{0,5}$'
      AND jsonb_typeof(item->'height')='number' AND item->>'height'~'^[1-9][0-9]{0,5}$'
      OR item->>'mediaType'='application/json' AND item->'width'='null'::jsonb AND item->'height'='null'::jsonb)) IS NOT TRUE
    OR coalesce(item->>'assetId','')!~'^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR coalesce(item->>'checksumSha256','')!~'^[a-f0-9]{64}$' OR coalesce(item->>'role','')!~'^[a-zA-Z0-9_:-]{1,100}$'
    OR (item->>'byteSize')::bigint NOT BETWEEN 1 AND 52428800
    OR coalesce(item->>'fileName','')!~('^'||NEW.id::text||'-owner-[0-7]\.(png|jpg|webp|tiff|json)$')
    OR right(item->>'fileName',length(CASE item->>'mediaType' WHEN 'image/png' THEN '.png' WHEN 'image/jpeg' THEN '.jpg' WHEN 'image/webp' THEN '.webp' WHEN 'image/tiff' THEN '.tiff' ELSE '.json' END))
      IS DISTINCT FROM (CASE item->>'mediaType' WHEN 'image/png' THEN '.png' WHEN 'image/jpeg' THEN '.jpg' WHEN 'image/webp' THEN '.webp' WHEN 'image/tiff' THEN '.tiff' ELSE '.json' END)
    OR item->>'objectKey' IS DISTINCT FROM 'tenants/'||NEW.tenant_id::text||'/authorized/'||(item->>'checksumSha256')||'/'||(item->>'fileName')
    OR item->'rightsMetadata'->'creativeResponseAdoption' IS DISTINCT FROM jsonb_build_object('adoptionId',NEW.id::text,
      'executionId',NEW.execution_id::text,'ownerKind',NEW.kind,'ownerId',NEW.owner_id::text,'basisChecksum',NEW.plan_pin->>'checksum','role',item->>'role') THEN
    RAISE EXCEPTION 'creative_owner_adoption_artifact_invalid' USING ERRCODE='23514';END IF;
  END LOOP;
 END IF;
 IF NEW.status<>'committed' THEN RETURN NEW;END IF;
 IF NEW.artifact_intents IS NULL OR NEW.plan_pin IS NULL OR NEW.owner_receipt IS NULL OR NEW.receipt IS NULL
  OR NEW.error_code IS NOT NULL OR NEW.committed_at IS NULL OR NEW.cancelled_at IS NOT NULL
  OR NEW.owner_receipt->>'adoptionId' IS DISTINCT FROM NEW.id::text
  OR NEW.owner_receipt->>'executionId' IS DISTINCT FROM NEW.execution_id::text OR NEW.owner_receipt->>'kind' IS DISTINCT FROM NEW.kind
  OR NEW.owner_receipt->>'ownerId' IS DISTINCT FROM NEW.owner_id::text
  OR NEW.owner_receipt->>'parentId' IS DISTINCT FROM NEW.parent_id::text OR NEW.owner_receipt->>'version' IS DISTINCT FROM '1'
  OR coalesce(NEW.owner_receipt->>'checksum','')!~'^[a-f0-9]{64}$'
  OR NEW.owner_receipt->>'basisChecksum' IS DISTINCT FROM NEW.plan_pin->>'checksum'
  OR NEW.receipt->>'version' IS DISTINCT FROM 'creative-owner-response-adoption-v1'
  OR NEW.receipt->>'id' IS DISTINCT FROM NEW.id::text OR NEW.receipt->>'executionId' IS DISTINCT FROM NEW.execution_id::text
  OR NEW.receipt->>'requestId' IS DISTINCT FROM NEW.request_id::text OR NEW.receipt->>'basis' IS DISTINCT FROM NEW.expected_basis
  OR NEW.receipt->>'kind' IS DISTINCT FROM NEW.kind OR NEW.receipt->>'ownerId' IS DISTINCT FROM NEW.owner_id::text
  OR NEW.receipt->>'parentId' IS DISTINCT FROM NEW.parent_id::text OR NEW.receipt->>'stepKey' IS DISTINCT FROM original.step_key
  OR NEW.receipt->>'ownerStatus' IS DISTINCT FROM NEW.owner_receipt->>'status'
  OR NEW.receipt->>'originalPhase' IS DISTINCT FROM original.phase OR NEW.receipt->>'inputFingerprint' IS DISTINCT FROM original.input_fingerprint
  OR NEW.receipt->>'responseChecksum' IS DISTINCT FROM original.response_checksum OR NEW.receipt->>'encryptedChecksum' IS DISTINCT FROM original.encrypted_checksum
  OR NEW.receipt->'originalCostUsd' IS DISTINCT FROM coalesce(original.receipt->'costUsd','null'::jsonb)
  OR NEW.receipt->>'ownerReceiptChecksum' IS DISTINCT FROM NEW.owner_receipt->>'checksum'
  OR NEW.receipt->>'approval' IS DISTINCT FROM 'review_required' OR NEW.receipt->>'rightsStatus' IS DISTINCT FROM 'unverified'
  OR NEW.receipt->>'noNewModelCall' IS DISTINCT FROM 'true' OR (NEW.receipt->>'committedAt')::timestamptz IS DISTINCT FROM NEW.committed_at THEN
  RAISE EXCEPTION 'creative_owner_adoption_receipt_required' USING ERRCODE='23514';END IF;
 txid:=mod(pg_current_xact_id()::text::numeric,4294967296)::text;
 FOR item IN SELECT value FROM jsonb_array_elements(NEW.artifact_intents) LOOP
  IF NOT EXISTS(SELECT 1 FROM asset_files a WHERE a.tenant_id=NEW.tenant_id AND a.id::text=item->>'assetId'
   AND a.owner_user_id=NEW.requested_by AND a.asset_domain='authorized' AND a.version=1 AND a.deleted_at IS NULL
   AND a.rights_status='unverified' AND a.ai_generated=(item->>'aiGenerated')::boolean AND a.object_key=item->>'objectKey'
   AND a.checksum_sha256=item->>'checksumSha256' AND a.byte_size=(item->>'byteSize')::bigint AND a.media_type=item->>'mediaType'
   AND a.rights_metadata IS NOT DISTINCT FROM item->'rightsMetadata' AND a.xmin::text=txid) THEN
   RAISE EXCEPTION 'creative_owner_adoption_asset_birth_required' USING ERRCODE='23514';END IF;
 END LOOP;
 SELECT jsonb_agg(jsonb_build_object('role',x->>'role','assetId',x->>'assetId','version',1,'checksumSha256',x->>'checksumSha256',
  'mediaType',x->>'mediaType','byteSize',(x->>'byteSize')::bigint,'width',x->'width','height',x->'height') ORDER BY n)
  INTO expected_artifacts FROM jsonb_array_elements(NEW.artifact_intents) WITH ORDINALITY q(x,n);
 IF NEW.receipt->'artifacts' IS DISTINCT FROM expected_artifacts THEN RAISE EXCEPTION 'creative_owner_adoption_artifacts_required' USING ERRCODE='23514';END IF;
 SELECT jsonb_agg(jsonb_build_object('role',x->>'role','assetId',x->>'assetId','version',1,'checksumSha256',x->>'checksumSha256') ORDER BY n)
  INTO owner_artifacts FROM jsonb_array_elements(NEW.artifact_intents) WITH ORDINALITY q(x,n);
 IF NEW.owner_receipt->'artifacts' IS DISTINCT FROM owner_artifacts THEN RAISE EXCEPTION 'creative_owner_adoption_owner_artifacts_required' USING ERRCODE='23514';END IF;
 valid_owner:=false;
 IF NEW.kind='creative_adaptation' THEN
  IF NEW.owner_receipt->'saved'->>'kind'='adaptation_spec' THEN
   SELECT EXISTS(SELECT 1 FROM creative_design_version_assets v JOIN creative_design_versions d ON d.tenant_id=v.tenant_id AND d.id=v.creative_design_version_id
    WHERE v.tenant_id=NEW.tenant_id AND v.id::text=NEW.owner_receipt->'saved'->>'linkId' AND d.id=NEW.owner_id
     AND d.reviewed_at IS NULL AND d.reviewed_by IS NULL AND d.status IN ('adapting','pending_review','rejected')
     AND v.asset_id::text=NEW.owner_receipt->'saved'->>'assetId' AND v.role='aspect_variant' AND v.asset_version=1
     AND v.print_spec_version_id::text=NEW.owner_receipt->'saved'->>'printSpecVersionId'
     AND v.asset_id::text=(SELECT x->>'assetId' FROM jsonb_array_elements(NEW.artifact_intents) x WHERE x->>'role'='aspect_variant')
     AND jsonb_array_length(NEW.artifact_intents)=1 AND NEW.receipt->>'disposition'='aspect_ready' AND v.xmin::text=txid) INTO valid_owner;
  ELSIF NEW.owner_receipt->'saved'->>'kind'='adaptation_outpaint' THEN
   SELECT EXISTS(SELECT 1 FROM artifact_relations r JOIN creative_design_version_assets v ON v.tenant_id=r.tenant_id AND v.asset_id=r.from_asset_id
    WHERE r.tenant_id=NEW.tenant_id AND v.creative_design_version_id=NEW.owner_id AND v.role='master'
     AND r.to_asset_id::text=NEW.owner_receipt->'saved'->>'assetId' AND r.relation_type='result_to_derivative'
     AND r.from_asset_version=v.asset_version AND r.to_asset_version=1 AND r.xmin::text=txid
     AND r.to_asset_id::text=(SELECT x->>'assetId' FROM jsonb_array_elements(NEW.artifact_intents) x WHERE x->>'role'='expanded')
     AND jsonb_array_length(NEW.artifact_intents)=1 AND NEW.receipt->>'disposition'='outpaint_artifact_ready'
     AND NEW.owner_receipt->'saved'->>'parentExecutionId'=original.parent_execution_id::text
     AND NEW.owner_receipt->'saved'->>'parentRequiresLocalAdaptation'='true') INTO valid_owner;
  END IF;
 ELSIF NEW.kind='template_compile' THEN
  SELECT EXISTS(SELECT 1 FROM mockup_template_source_inspections i WHERE i.tenant_id=NEW.tenant_id AND i.id=NEW.owner_id
   AND i.status='completed' AND i.confirmed_at IS NULL AND i.confirmed_by IS NULL
   AND i.compilation->>'manifestAssetId'=NEW.owner_receipt->'saved'->>'manifestAssetId'
   AND NEW.receipt->>'disposition'='template_inspected' AND NEW.owner_receipt->'saved'->>'confirmed'='false'
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.artifact_intents) x WHERE
     x->>'role' NOT IN ('background','foreground','preview','mask','manifest')
     OR i.compilation->>(CASE x->>'role' WHEN 'background' THEN 'backgroundAssetId' WHEN 'foreground' THEN 'foregroundAssetId'
       WHEN 'preview' THEN 'previewAssetId' WHEN 'mask' THEN 'maskAssetId' ELSE 'manifestAssetId' END) IS DISTINCT FROM x->>'assetId')
   AND (SELECT count(*) FROM jsonb_array_elements(NEW.artifact_intents) x WHERE x->>'role' IN ('background','foreground','preview','manifest'))=4
   AND i.xmin::text=txid) INTO valid_owner;
 ELSIF NEW.kind='mockup_render' THEN
  SELECT EXISTS(SELECT 1 FROM mockup_batch_outputs o WHERE o.tenant_id=NEW.tenant_id AND o.item_id=NEW.owner_id
   AND o.id::text=NEW.owner_receipt->'saved'->>'outputId' AND o.status='succeeded'
   AND o.asset_id::text=NEW.owner_receipt->'saved'->>'assetId' AND o.asset_version=1
   AND o.asset_id::text=(SELECT x->>'assetId' FROM jsonb_array_elements(NEW.artifact_intents) x WHERE x->>'role'='mockup')
   AND jsonb_array_length(NEW.artifact_intents)=1 AND NEW.receipt->>'disposition'='mockup_ready'
   AND NEW.owner_receipt->'saved'->>'approved'='false' AND o.xmin::text=txid) INTO valid_owner;
 ELSIF NEW.kind='studio_generation' THEN
  SELECT EXISTS(SELECT 1 FROM creative_studio_generations g JOIN creative_studio_entries e ON e.tenant_id=g.tenant_id
    AND e.owner_id=g.owner_id AND e.scope=g.scope AND e.namespace='image_files' AND e.key='image:'||g.id::text
   JOIN creative_studio_revisions r ON r.tenant_id=e.tenant_id AND r.entry_id=e.id AND r.revision=1 AND r.asset_id=e.asset_id
   WHERE g.tenant_id=NEW.tenant_id AND g.id=NEW.owner_id AND g.status='completed'
    AND g.asset_id::text=NEW.owner_receipt->'saved'->>'assetId' AND e.asset_id=g.asset_id AND e.revision=1
    AND e.id::text=NEW.owner_receipt->'saved'->>'entryId' AND r.id::text=NEW.owner_receipt->'saved'->>'revisionId'
    AND g.asset_id::text=(SELECT x->>'assetId' FROM jsonb_array_elements(NEW.artifact_intents) x WHERE x->>'role'='image')
    AND jsonb_array_length(NEW.artifact_intents)=1 AND NEW.receipt->>'disposition'='studio_image_ready'
    AND e.xmin::text=txid AND g.xmin::text=txid AND r.xmin::text=txid) INTO valid_owner;
 END IF;
 IF NOT valid_owner THEN RAISE EXCEPTION 'creative_owner_adoption_real_owner_required' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER creative_owner_response_adoption_guard BEFORE INSERT OR UPDATE ON creative_owner_response_adoptions
 FOR EACH ROW EXECUTE FUNCTION guard_creative_owner_response_adoption();
