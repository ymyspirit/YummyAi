-- Saved editable copies have their own immutable identity. No historical
-- Studio rows, generations, approvals, files or business facts are rewritten.
CREATE TABLE creative_studio_transfers (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), owner_id uuid NOT NULL REFERENCES app_users(id),
 request_id uuid NOT NULL, scope text NOT NULL, target_scope text NOT NULL, manifest_hash text NOT NULL,
 request jsonb NOT NULL, manifest jsonb NOT NULL, receipt jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), committed_at timestamptz, cancelled_at timestamptz,
 CONSTRAINT creative_studio_transfer_scope_check CHECK(scope<>target_scope),
 CONSTRAINT creative_studio_transfer_hash_check CHECK(manifest_hash~'^[a-f0-9]{64}$'),
 CONSTRAINT creative_studio_transfer_receipt_check CHECK((receipt IS NULL)=(committed_at IS NULL)),
 CONSTRAINT creative_studio_transfer_terminal_check CHECK(cancelled_at IS NULL OR receipt IS NULL)
);
CREATE UNIQUE INDEX creative_studio_transfer_request_unique ON creative_studio_transfers(tenant_id,owner_id,request_id);
CREATE UNIQUE INDEX creative_studio_transfers_tenant_id_unique ON creative_studio_transfers(tenant_id,id);
CREATE INDEX creative_studio_transfer_owner_idx ON creative_studio_transfers(tenant_id,owner_id,created_at);
CREATE INDEX creative_studio_transfer_scope_cursor_idx ON creative_studio_transfers(tenant_id,owner_id,scope,id);
ALTER TABLE creative_studio_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE creative_studio_transfers FORCE ROW LEVEL SECURITY;
CREATE POLICY creative_studio_transfer_owner ON creative_studio_transfers TO yummyai_app
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.user_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND owner_id=nullif(current_setting('app.user_id',true),'')::uuid);
GRANT SELECT,INSERT ON creative_studio_transfers TO yummyai_app;
GRANT UPDATE(receipt,committed_at,cancelled_at) ON creative_studio_transfers TO yummyai_app;
--> statement-breakpoint
CREATE FUNCTION guard_studio_transfer() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE item jsonb; expected jsonb;
BEGIN
 IF NEW.owner_id::text IS DISTINCT FROM current_setting('app.user_id',true)
  OR NEW.tenant_id::text IS DISTINCT FROM current_setting('app.tenant_id',true)
  OR NEW.request IS DISTINCT FROM jsonb_build_object('scope',NEW.scope,'targetScope',NEW.target_scope,'requestId',NEW.request_id::text,'manifestHash',NEW.manifest_hash)
  OR jsonb_typeof(NEW.manifest) IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION 'studio_transfer_original_identity_invalid' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.receipt IS NOT NULL OR NEW.committed_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL
   OR jsonb_typeof(NEW.manifest->'plan'->'writes') IS DISTINCT FROM 'array'
   OR jsonb_array_length(NEW.manifest->'plan'->'writes') NOT BETWEEN 1 AND 10000 THEN
   RAISE EXCEPTION 'studio_transfer_must_prepare' USING ERRCODE='23514';END IF;
 ELSE
  IF (to_jsonb(OLD)-ARRAY['receipt','committed_at','cancelled_at']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['receipt','committed_at','cancelled_at'])
   OR OLD.receipt IS NOT NULL OR OLD.cancelled_at IS NOT NULL THEN
   RAISE EXCEPTION 'studio_transfer_terminal_immutable' USING ERRCODE='23514';END IF;
  IF NEW.cancelled_at IS NOT NULL THEN
   IF NEW.receipt IS NOT NULL OR NEW.committed_at IS NOT NULL THEN
    RAISE EXCEPTION 'studio_transfer_terminal_conflict' USING ERRCODE='23514';END IF;
   RETURN NEW;
  END IF;
  IF NEW.receipt IS NULL OR NEW.committed_at IS NULL
   OR NEW.receipt->>'id' IS DISTINCT FROM NEW.id::text
   OR NEW.receipt->>'sourceScope' IS DISTINCT FROM NEW.scope OR NEW.receipt->>'targetScope' IS DISTINCT FROM NEW.target_scope
   OR NEW.receipt->>'requestId' IS DISTINCT FROM NEW.request_id::text OR NEW.receipt->>'manifestHash' IS DISTINCT FROM NEW.manifest_hash
   OR jsonb_typeof(NEW.receipt->'entries') IS DISTINCT FROM 'array'
   OR NEW.receipt->'counts' IS DISTINCT FROM NEW.manifest->'plan'->'counts'
   OR jsonb_array_length(NEW.receipt->'entries') IS DISTINCT FROM jsonb_array_length(NEW.manifest->'plan'->'writes')
   OR (SELECT count(DISTINCT (value->>'namespace',value->>'key')) FROM jsonb_array_elements(NEW.receipt->'entries'))
     <>jsonb_array_length(NEW.receipt->'entries') THEN
   RAISE EXCEPTION 'studio_transfer_receipt_immutable' USING ERRCODE='23514';END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(NEW.receipt->'entries') LOOP
   SELECT value INTO expected FROM jsonb_array_elements(NEW.manifest->'plan'->'writes')
    WHERE value->>'namespace'=item->>'namespace' AND value->>'key'=item->>'key';
   IF expected IS NULL OR item->'sourceEntryIds' IS DISTINCT FROM expected->'sourceEntryIds'
    OR (expected->>'targetRevision')::integer+1<>(item->>'revision')::integer
    OR (expected->>'targetEntryId' IS NOT NULL AND expected->>'targetEntryId' IS DISTINCT FROM item->>'targetEntryId') THEN
    RAISE EXCEPTION 'studio_transfer_original_plan_required' USING ERRCODE='23514';END IF;
   IF NOT EXISTS(SELECT 1 FROM creative_studio_entries e JOIN creative_studio_revisions r ON r.tenant_id=e.tenant_id AND r.entry_id=e.id
    WHERE e.tenant_id=NEW.tenant_id AND e.owner_id=NEW.owner_id AND e.scope=NEW.target_scope
     AND e.id::text=item->>'targetEntryId' AND e.namespace=item->>'namespace' AND e.key=item->>'key'
     AND r.revision::text=item->>'revision' AND r.value IS NOT DISTINCT FROM nullif(expected->'value','null'::jsonb)
     AND r.asset_id::text IS NOT DISTINCT FROM expected->>'assetId'
     AND r.xmin::text=mod(pg_current_xact_id()::text::numeric,4294967296)::text) THEN
    RAISE EXCEPTION 'studio_transfer_revision_birth_required' USING ERRCODE='23514';END IF;
  END LOOP;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER creative_studio_transfer_guard BEFORE INSERT OR UPDATE ON creative_studio_transfers
 FOR EACH ROW EXECUTE FUNCTION guard_studio_transfer();
--> statement-breakpoint
-- Also fence writes outside the RPC path, so a new key cannot evade the
-- complete-scope manifest. Service paths acquire the same locks before rows.
CREATE FUNCTION lock_studio_document_scope() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='UPDATE' AND (OLD.tenant_id,OLD.owner_id,OLD.scope,OLD.namespace,OLD.key,OLD.id)
   IS DISTINCT FROM (NEW.tenant_id,NEW.owner_id,NEW.scope,NEW.namespace,NEW.key,NEW.id) THEN
  RAISE EXCEPTION 'studio_entry_address_immutable' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('studio-scope:'||NEW.tenant_id::text||':'||NEW.owner_id::text||':'||NEW.scope,0));
 RETURN NEW;
END $$;
CREATE TRIGGER creative_studio_scope_lock BEFORE INSERT OR UPDATE ON creative_studio_entries
 FOR EACH ROW EXECUTE FUNCTION lock_studio_document_scope();
