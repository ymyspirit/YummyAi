CREATE TABLE creative_studio_image_requests (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), owner_id uuid NOT NULL REFERENCES app_users(id),
 scope text NOT NULL, request_id uuid NOT NULL, original_input jsonb NOT NULL, input jsonb NOT NULL, quote jsonb NOT NULL,
 generation_id uuid, created_at timestamptz NOT NULL DEFAULT now(), committed_at timestamptz, cancelled_at timestamptz,
 CONSTRAINT creative_studio_image_receipt_check CHECK((generation_id IS NULL)=(committed_at IS NULL)),
 CONSTRAINT creative_studio_image_terminal_check CHECK(cancelled_at IS NULL OR generation_id IS NULL),
 CONSTRAINT creative_studio_image_generation_fk FOREIGN KEY(tenant_id,generation_id) REFERENCES creative_studio_generations(tenant_id,id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX creative_studio_image_request_unique ON creative_studio_image_requests(tenant_id,owner_id,request_id);
CREATE UNIQUE INDEX creative_studio_image_requests_tenant_id_unique ON creative_studio_image_requests(tenant_id,id);
CREATE UNIQUE INDEX creative_studio_image_generation_unique ON creative_studio_image_requests(tenant_id,generation_id);
CREATE INDEX creative_studio_image_request_cursor_idx ON creative_studio_image_requests(tenant_id,owner_id,scope,id);
ALTER TABLE creative_studio_image_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE creative_studio_image_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY creative_studio_image_request_owner ON creative_studio_image_requests TO yummyai_app
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.user_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.user_id',true),'')::uuid);
GRANT SELECT,INSERT ON creative_studio_image_requests TO yummyai_app;
GRANT UPDATE(generation_id,committed_at,cancelled_at) ON creative_studio_image_requests TO yummyai_app;
CREATE TABLE creative_studio_image_cancellations (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), owner_id uuid NOT NULL REFERENCES app_users(id),
 scope text NOT NULL, request_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX creative_studio_image_cancel_original_unique ON creative_studio_image_cancellations(tenant_id,owner_id,request_id);
ALTER TABLE creative_studio_image_cancellations ENABLE ROW LEVEL SECURITY;
ALTER TABLE creative_studio_image_cancellations FORCE ROW LEVEL SECURITY;
CREATE POLICY creative_studio_image_cancel_owner ON creative_studio_image_cancellations TO yummyai_app
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.user_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.user_id',true),'')::uuid);
GRANT SELECT,INSERT ON creative_studio_image_cancellations TO yummyai_app;
--> statement-breakpoint
CREATE FUNCTION guard_studio_paid_image_request() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE pin text;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text||':'||NEW.owner_id::text||':studio-generation',0));
 FOREACH pin IN ARRAY ARRAY['quoteHash','inputFingerprint','providerFingerprint','selectionRevision'] LOOP
  IF jsonb_typeof(NEW.quote->pin) IS DISTINCT FROM 'string' OR coalesce(NEW.quote->>pin,'') !~ '^[a-f0-9]{64}$' THEN
   RAISE EXCEPTION 'studio_paid_image_pin_required' USING ERRCODE='23514'; END IF;
 END LOOP;
 FOREACH pin IN ARRAY ARRAY['modelId','providerConfigId'] LOOP
  IF jsonb_typeof(NEW.quote->pin) IS DISTINCT FROM 'string' OR coalesce(NEW.quote->>pin,'') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
   RAISE EXCEPTION 'studio_paid_image_pin_required' USING ERRCODE='23514'; END IF;
 END LOOP;
 FOREACH pin IN ARRAY ARRAY['modelId','selectionRevision'] LOOP
  IF jsonb_typeof(NEW.input->pin) IS DISTINCT FROM 'string' OR jsonb_typeof(NEW.original_input->pin) IS DISTINCT FROM 'string' THEN
   RAISE EXCEPTION 'studio_paid_image_pin_required' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF jsonb_typeof(NEW.quote->'pricing'->'estimatedUsd') IS DISTINCT FROM 'string'
  OR jsonb_typeof(NEW.quote->'pricing'->'reservationUsd') IS DISTINCT FROM 'string'
  OR jsonb_typeof(NEW.quote->'pricing'->'reference') IS DISTINCT FROM 'string'
  OR coalesce(length(NEW.quote->'pricing'->>'reference'),0) NOT BETWEEN 1 AND 500
  OR jsonb_typeof(NEW.quote->'contextAuthority') IS DISTINCT FROM 'string'
  OR coalesce(length(NEW.quote->>'contextAuthority'),0) NOT BETWEEN 20 AND 131072
  OR jsonb_typeof(NEW.quote->'createdAt') IS DISTINCT FROM 'string' OR jsonb_typeof(NEW.quote->'expiresAt') IS DISTINCT FROM 'string'
  OR coalesce(NEW.quote->>'createdAt','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
  OR coalesce(NEW.quote->>'expiresAt','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$' THEN
  RAISE EXCEPTION 'studio_paid_image_pin_required' USING ERRCODE='23514'; END IF;
 IF (NEW.quote->>'contextAuthority')::jsonb->>'tenantId' IS DISTINCT FROM NEW.tenant_id::text
  OR (NEW.quote->>'contextAuthority')::jsonb->>'userId' IS DISTINCT FROM NEW.owner_id::text
  OR (NEW.quote->>'expiresAt')::timestamptz <= (NEW.quote->>'createdAt')::timestamptz
  OR (NEW.quote->>'expiresAt')::timestamptz > (NEW.quote->>'createdAt')::timestamptz + interval '5 minutes' THEN
  RAISE EXCEPTION 'studio_paid_image_pin_required' USING ERRCODE='23514'; END IF;
 IF NEW.owner_id::text IS DISTINCT FROM current_setting('app.user_id',true)
  OR NEW.tenant_id::text IS DISTINCT FROM current_setting('app.tenant_id',true)
  OR jsonb_typeof(NEW.input) IS DISTINCT FROM 'object' OR jsonb_typeof(NEW.original_input) IS DISTINCT FROM 'object'
  OR NEW.input->>'requestId' IS DISTINCT FROM NEW.request_id::text OR NEW.original_input->>'requestId' IS DISTINCT FROM NEW.request_id::text
  OR NEW.input->>'capability' IS DISTINCT FROM 'image' OR NEW.original_input->>'capability' IS DISTINCT FROM 'image'
  OR jsonb_typeof(NEW.quote) IS DISTINCT FROM 'object' OR NEW.quote->>'unit' IS DISTINCT FROM 'image'
  OR NEW.quote->>'currency' IS DISTINCT FROM 'USD' OR NEW.quote->>'basis' IS DISTINCT FROM 'operator_estimate'
  OR NEW.quote->'count' IS DISTINCT FROM '1'::jsonb
  OR NEW.quote->>'modelId' IS DISTINCT FROM NEW.input->>'modelId'
  OR NEW.quote->>'selectionRevision' IS DISTINCT FROM NEW.input->>'selectionRevision'
  OR coalesce(NEW.quote->>'quoteHash','') !~ '^[a-f0-9]{64}$'
  OR coalesce(NEW.quote->>'inputFingerprint','') !~ '^[a-f0-9]{64}$'
  OR coalesce(NEW.quote->'pricing'->>'estimatedUsd','') !~ '^(0|[1-9][0-9]{0,7})\.[0-9]{8}$'
  OR coalesce(NEW.quote->'pricing'->>'reservationUsd','') !~ '^(0|[1-9][0-9]{0,7})\.[0-9]{6}$'
  OR (NEW.quote->'pricing'->>'reservationUsd')::numeric<=0
  OR (NEW.quote->'pricing'->>'estimatedUsd')::numeric>(NEW.quote->'pricing'->>'reservationUsd')::numeric
  OR jsonb_typeof(NEW.quote->'references') IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION 'studio_paid_image_original_invalid' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.generation_id IS NOT NULL OR NEW.committed_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL THEN
   RAISE EXCEPTION 'studio_paid_image_must_prepare' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM creative_studio_image_cancellations c WHERE c.tenant_id=NEW.tenant_id AND c.owner_id=NEW.owner_id AND c.request_id=NEW.request_id) THEN
   RAISE EXCEPTION 'studio_paid_image_original_cancelled' USING ERRCODE='23514'; END IF;
 ELSE
  IF (to_jsonb(OLD)-ARRAY['generation_id','committed_at','cancelled_at']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['generation_id','committed_at','cancelled_at'])
   OR OLD.generation_id IS NOT NULL OR OLD.cancelled_at IS NOT NULL THEN
   RAISE EXCEPTION 'studio_paid_image_original_immutable' USING ERRCODE='23514'; END IF;
  IF NEW.cancelled_at IS NOT NULL THEN
   IF NEW.generation_id IS NOT NULL OR NEW.committed_at IS NOT NULL THEN
    RAISE EXCEPTION 'studio_paid_image_terminal_conflict' USING ERRCODE='23514'; END IF;
   RETURN NEW;
  END IF;
  IF NEW.committed_at < (NEW.quote->>'createdAt')::timestamptz
   OR NEW.committed_at >= (NEW.quote->>'expiresAt')::timestamptz
   OR clock_timestamp() >= (NEW.quote->>'expiresAt')::timestamptz THEN
   RAISE EXCEPTION 'studio_paid_image_quote_expired' USING ERRCODE='23514'; END IF;
  IF NEW.generation_id IS NULL OR NEW.committed_at IS NULL OR NOT EXISTS (
   SELECT 1 FROM creative_studio_generations g JOIN ai_budget_ledger b ON b.tenant_id=g.tenant_id AND b.request_id=g.id
   WHERE g.id=NEW.generation_id AND g.tenant_id=NEW.tenant_id AND g.owner_id=NEW.owner_id AND g.scope=NEW.scope
    AND g.request_id=NEW.request_id AND g.input IS NOT DISTINCT FROM NEW.input AND g.references IS NOT DISTINCT FROM NEW.quote->'references'
    AND g.model_snapshot->>'capability'='image' AND g.model_snapshot->>'routeId'=NEW.quote->>'modelId'
    AND g.model_snapshot->>'providerConfigId'=NEW.quote->>'providerConfigId' AND g.model_snapshot->>'model'=NEW.quote->>'model'
    AND g.model_snapshot->>'providerFingerprint'=NEW.quote->>'providerFingerprint'
    AND g.model_snapshot->'paidImage' IS NOT DISTINCT FROM jsonb_build_object('imageRequestId',NEW.id::text,'quoteHash',NEW.quote->>'quoteHash',
      'reservationUsd',NEW.quote->'pricing'->>'reservationUsd','estimatedUsd',NEW.quote->'pricing'->>'estimatedUsd')
    AND b.task_type='studio_image' AND b.model_key=NEW.quote->>'model' AND b.state='reserved'
    AND b.amount_usd=(NEW.quote->'pricing'->>'reservationUsd')::numeric
    AND g.xmin::text=mod(pg_current_xact_id()::text::numeric,4294967296)::text
    AND b.xmin::text=mod(pg_current_xact_id()::text::numeric,4294967296)::text
  ) THEN RAISE EXCEPTION 'studio_paid_image_original_commit_required' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM creative_studio_image_cancellations c WHERE c.tenant_id=NEW.tenant_id AND c.owner_id=NEW.owner_id AND c.request_id=NEW.request_id) THEN
   RAISE EXCEPTION 'studio_paid_image_original_cancelled' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER creative_studio_paid_image_guard BEFORE INSERT OR UPDATE ON creative_studio_image_requests
 FOR EACH ROW EXECUTE FUNCTION guard_studio_paid_image_request();
--> statement-breakpoint
CREATE FUNCTION guard_studio_image_cancellation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text||':'||NEW.owner_id::text||':studio-generation',0));
 IF NEW.tenant_id::text IS DISTINCT FROM current_setting('app.tenant_id',true)
  OR NEW.owner_id::text IS DISTINCT FROM current_setting('app.user_id',true)
  OR EXISTS(SELECT 1 FROM creative_studio_image_requests r WHERE r.tenant_id=NEW.tenant_id AND r.owner_id=NEW.owner_id AND r.request_id=NEW.request_id
    AND (r.scope IS DISTINCT FROM NEW.scope OR r.cancelled_at IS NULL OR r.generation_id IS NOT NULL)) THEN
  RAISE EXCEPTION 'studio_paid_image_cancellation_invalid' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER creative_studio_image_cancel_guard BEFORE INSERT ON creative_studio_image_cancellations
 FOR EACH ROW EXECUTE FUNCTION guard_studio_image_cancellation();
--> statement-breakpoint
-- xmin alone proves a last write, not birth. A new paid pin cannot survive a
-- transaction without its committed original request, hold and Harness owner.
CREATE FUNCTION guard_studio_paid_image_birth() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NOT (NEW.model_snapshot ? 'paidImage') THEN RETURN NEW; END IF;
 IF jsonb_typeof(NEW.model_snapshot->'paidImage') IS DISTINCT FROM 'object' OR NOT EXISTS (
  SELECT 1 FROM creative_studio_image_requests r
   JOIN ai_budget_ledger b ON b.tenant_id=r.tenant_id AND b.request_id=NEW.id
   JOIN creative_executions e ON e.tenant_id=r.tenant_id AND e.studio_generation_id=NEW.id
  WHERE r.generation_id=NEW.id AND r.tenant_id=NEW.tenant_id AND r.owner_id=NEW.owner_id AND r.scope=NEW.scope
   AND r.request_id=NEW.request_id AND r.committed_at IS NOT NULL AND r.cancelled_at IS NULL
   AND r.input IS NOT DISTINCT FROM NEW.input AND r.quote->'references' IS NOT DISTINCT FROM NEW.references
   AND NEW.model_snapshot->'paidImage' IS NOT DISTINCT FROM jsonb_build_object('imageRequestId',r.id::text,'quoteHash',r.quote->>'quoteHash',
     'reservationUsd',r.quote->'pricing'->>'reservationUsd','estimatedUsd',r.quote->'pricing'->>'estimatedUsd')
   AND b.state='reserved' AND b.task_type='studio_image' AND b.model_key=r.quote->>'model'
   AND b.amount_usd=(r.quote->'pricing'->>'reservationUsd')::numeric
   AND e.requested_by=NEW.owner_id AND e.kind='studio_generation' AND e.step_key='generate' AND e.effect='external_request'
   AND e.submitted_at IS NULL AND e.submission_token IS NULL AND e.receipt IS NULL AND e.response_object_key IS NULL
 ) THEN RAISE EXCEPTION 'studio_paid_image_birth_pair_required' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER creative_studio_paid_image_birth_guard AFTER INSERT ON creative_studio_generations
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_studio_paid_image_birth();
--> statement-breakpoint
-- A hold belongs to its original UTC month. Check at the actual first submitted
-- write, after the shared budget lock, including when that lock crossed midnight.
-- Existing submitted receipts and archived-response recovery never enter here.
CREATE FUNCTION guard_studio_paid_image_submission_month() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE image_cap numeric; policy_caps jsonb; period_start timestamptz;
BEGIN
 IF NEW.kind IS DISTINCT FROM 'studio_generation' OR OLD.submitted_at IS NOT NULL OR NEW.submitted_at IS NULL
  OR NOT EXISTS(SELECT 1 FROM creative_studio_generations g WHERE g.id=NEW.studio_generation_id
    AND g.tenant_id=NEW.tenant_id AND g.model_snapshot ? 'paidImage') THEN RETURN NEW; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text||':ai-assist-budget',0));
 period_start:=date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
 SELECT p.task_caps_usd, CASE WHEN p.task_caps_usd ? 'studio_image' THEN
   CASE WHEN jsonb_typeof(p.task_caps_usd->'studio_image')='number' THEN (p.task_caps_usd->>'studio_image')::numeric ELSE NULL END
   ELSE p.default_task_cap_usd END INTO policy_caps,image_cap FROM ai_budget_policies p WHERE p.tenant_id=NEW.tenant_id;
 IF jsonb_typeof(policy_caps) IS DISTINCT FROM 'object' OR image_cap IS NULL OR image_cap<=0
  OR image_cap*1000000 IS DISTINCT FROM trunc(image_cap*1000000)
  OR NOT EXISTS(SELECT 1 FROM ai_budget_ledger b WHERE b.id=NEW.budget_ledger_id AND b.tenant_id=NEW.tenant_id
    AND b.request_id=NEW.studio_generation_id AND b.task_type='studio_image' AND b.state='reserved'
    AND b.amount_usd=NEW.budget_limit_usd AND b.amount_usd<=image_cap
    AND b.created_at>=period_start AND b.created_at<period_start+interval '1 month') THEN
  RAISE EXCEPTION 'studio_paid_image_budget_period_changed' USING ERRCODE='23514',CONSTRAINT='studio_image_paid_submission_month_guard';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER studio_image_paid_submission_month_guard BEFORE UPDATE OF submitted_at ON creative_executions
 FOR EACH ROW WHEN (OLD.submitted_at IS NULL AND NEW.submitted_at IS NOT NULL)
 EXECUTE FUNCTION guard_studio_paid_image_submission_month();
