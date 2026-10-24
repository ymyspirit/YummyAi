CREATE TABLE marketplace_store_node_executions (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), account_id uuid NOT NULL,
 node_id uuid NOT NULL, certificate_generation integer NOT NULL CHECK(certificate_generation>0), authorization_generation uuid NOT NULL, binding_revision integer NOT NULL CHECK(binding_revision>0),
 request_id uuid NOT NULL, request_checksum text NOT NULL CHECK(request_checksum~'^[a-f0-9]{64}$'), operation text NOT NULL DEFAULT 'marketplace.capabilities.sync.v1' CHECK(operation='marketplace.capabilities.sync.v1'), input jsonb NOT NULL,
 created_by uuid NOT NULL, membership_id uuid NOT NULL, authority_ceiling jsonb NOT NULL,
 state text NOT NULL DEFAULT 'waiting_node' CHECK(state IN('waiting_node','claimed','running','unknown_outcome','succeeded','failed','cancelled','expired','authority_changed')),
 phase text NOT NULL DEFAULT 'queued' CHECK(phase IN('queued','credential_ready','refresh_pending','credential_checkpointed','collecting','finished')), error_code text CHECK(error_code IS NULL OR error_code~'^store_node_[a-z_]{1,100}$'),
 claim_id uuid, session_id uuid, credential_use_id uuid, credential_id uuid, original_credential_version integer, credential_version integer,
 encrypted_transport_key text, sealed_credential jsonb, etsy_app_key_sha256 text CHECK(etsy_app_key_sha256 IS NULL OR etsy_app_key_sha256~'^[a-f0-9]{64}$'),
 checkpoint_checksum text CHECK(checkpoint_checksum IS NULL OR checkpoint_checksum~'^[a-f0-9]{64}$'), completion_checksum text CHECK(completion_checksum IS NULL OR completion_checksum~'^[a-f0-9]{64}$'), snapshot_id uuid,
 expires_at timestamptz NOT NULL, run_expires_at timestamptz, lease_expires_at timestamptz, started_at timestamptz, completed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT store_node_execution_id_check CHECK(substring(id::text from 15 for 1)='7' AND substring(request_id::text from 15 for 1)='7'),
 CONSTRAINT store_node_execution_account_fk FOREIGN KEY(tenant_id,account_id) REFERENCES marketplace_accounts(tenant_id,id),
 CONSTRAINT store_node_execution_node_fk FOREIGN KEY(tenant_id,account_id,node_id) REFERENCES marketplace_store_nodes(tenant_id,account_id,id),
 CONSTRAINT store_node_execution_snapshot_fk FOREIGN KEY(tenant_id,snapshot_id) REFERENCES marketplace_capability_snapshots(tenant_id,id),
 CONSTRAINT store_node_execution_tenant_id_unique UNIQUE(tenant_id,id), CONSTRAINT store_node_execution_request_unique UNIQUE(tenant_id,account_id,request_id),
 CONSTRAINT store_node_execution_deadline_check CHECK(expires_at>created_at AND (run_expires_at IS NULL OR (run_expires_at<=expires_at AND run_expires_at>started_at))),
 CONSTRAINT store_node_execution_claim_shape CHECK(num_nonnulls(claim_id,session_id,credential_use_id,credential_id,original_credential_version,credential_version,encrypted_transport_key,sealed_credential,run_expires_at,lease_expires_at,started_at) IN(0,11)
  AND (state NOT IN('claimed','running','unknown_outcome','succeeded') OR claim_id IS NOT NULL) AND (state<>'waiting_node' OR claim_id IS NULL)),
 CONSTRAINT store_node_execution_version_shape CHECK((credential_version IS NULL AND checkpoint_checksum IS NULL) OR
  (original_credential_version>0 AND credential_version=original_credential_version+CASE WHEN checkpoint_checksum IS NULL THEN 0 ELSE 1 END)),
 CONSTRAINT store_node_execution_success_shape CHECK((state='succeeded')=(snapshot_id IS NOT NULL) AND (snapshot_id IS NULL OR completion_checksum IS NOT NULL)),
 CONSTRAINT store_node_execution_finished_shape CHECK((state IN('waiting_node','claimed','running') AND completed_at IS NULL) OR (state NOT IN('waiting_node','claimed','running') AND completed_at IS NOT NULL))
);
CREATE UNIQUE INDEX store_node_execution_active_unique ON marketplace_store_node_executions(tenant_id,account_id) WHERE state IN('claimed','running');
CREATE INDEX store_node_execution_account_idx ON marketplace_store_node_executions(tenant_id,account_id,id DESC);
--> statement-breakpoint
CREATE TABLE marketplace_store_node_execution_steps (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), execution_id uuid NOT NULL, ordinal integer NOT NULL CHECK(ordinal BETWEEN 1 AND 128),
 request_class text NOT NULL CHECK(request_class IN('amazon_lwa','amazon_participations','amazon_product_definition','amazon_schema','amazon_meta_schema','etsy_refresh','etsy_shop','etsy_sections','etsy_return_policies','etsy_taxonomy','etsy_shipping_profiles','etsy_readiness_profiles','etsy_taxonomy_properties')),
 request_digest text NOT NULL CHECK(request_digest~'^[a-f0-9]{64}$'), permit_id uuid NOT NULL, permit_expires_at timestamptz NOT NULL,
 outcome text NOT NULL DEFAULT 'permitted' CHECK(outcome IN('permitted','received','unknown','not_sent')),
 response_digest text CHECK(response_digest IS NULL OR response_digest~'^[a-f0-9]{64}$'), http_status integer CHECK(http_status BETWEEN 100 AND 599), receipt_checksum text CHECK(receipt_checksum IS NULL OR receipt_checksum~'^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), completed_at timestamptz,
 CONSTRAINT store_node_step_execution_fk FOREIGN KEY(tenant_id,execution_id) REFERENCES marketplace_store_node_executions(tenant_id,id),
 CONSTRAINT store_node_step_ordinal_unique UNIQUE(tenant_id,execution_id,ordinal),
 CONSTRAINT store_node_step_shape CHECK((outcome='permitted' AND num_nonnulls(response_digest,http_status,receipt_checksum,completed_at)=0) OR
  (outcome='received' AND num_nonnulls(response_digest,http_status,receipt_checksum,completed_at)=4) OR
  (outcome IN('unknown','not_sent') AND response_digest IS NULL AND http_status IS NULL AND receipt_checksum IS NOT NULL AND completed_at IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE marketplace_store_node_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_store_node_executions FORCE ROW LEVEL SECURITY;
CREATE POLICY store_node_execution_tenant ON marketplace_store_node_executions FOR ALL TO yummyai_app
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE marketplace_store_node_execution_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_store_node_execution_steps FORCE ROW LEVEL SECURITY;
CREATE POLICY store_node_step_tenant ON marketplace_store_node_execution_steps FOR ALL TO yummyai_app
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON marketplace_store_node_executions,marketplace_store_node_execution_steps TO yummyai_app;
--> statement-breakpoint
CREATE FUNCTION guard_store_node_execution_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.id,NEW.tenant_id,NEW.account_id,NEW.node_id,NEW.certificate_generation,NEW.authorization_generation,NEW.binding_revision,NEW.request_id,NEW.request_checksum,NEW.operation,NEW.input,NEW.created_by,NEW.membership_id,NEW.authority_ceiling,NEW.expires_at,NEW.created_at)
  IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.account_id,OLD.node_id,OLD.certificate_generation,OLD.authorization_generation,OLD.binding_revision,OLD.request_id,OLD.request_checksum,OLD.operation,OLD.input,OLD.created_by,OLD.membership_id,OLD.authority_ceiling,OLD.expires_at,OLD.created_at)
 THEN RAISE EXCEPTION 'Immutable store node execution origin' USING ERRCODE='23514'; END IF;
 IF OLD.claim_id IS NOT NULL AND ROW(NEW.claim_id,NEW.session_id,NEW.credential_use_id,NEW.credential_id,NEW.original_credential_version,NEW.encrypted_transport_key,NEW.sealed_credential,NEW.run_expires_at,NEW.started_at)
  IS DISTINCT FROM ROW(OLD.claim_id,OLD.session_id,OLD.credential_use_id,OLD.credential_id,OLD.original_credential_version,OLD.encrypted_transport_key,OLD.sealed_credential,OLD.run_expires_at,OLD.started_at)
 THEN RAISE EXCEPTION 'Immutable store node execution claim' USING ERRCODE='23514'; END IF;
 IF OLD.checkpoint_checksum IS NOT NULL AND NEW.checkpoint_checksum IS DISTINCT FROM OLD.checkpoint_checksum
 THEN RAISE EXCEPTION 'Immutable store node checkpoint' USING ERRCODE='23514'; END IF;
 IF OLD.state NOT IN('waiting_node','claimed','running') AND NEW.state IS DISTINCT FROM OLD.state
 THEN RAISE EXCEPTION 'Terminal store node execution' USING ERRCODE='23514'; END IF;
 IF OLD.completion_checksum IS NOT NULL AND ROW(NEW.completion_checksum,NEW.snapshot_id,NEW.state,NEW.phase,NEW.error_code,NEW.completed_at)
  IS DISTINCT FROM ROW(OLD.completion_checksum,OLD.snapshot_id,OLD.state,OLD.phase,OLD.error_code,OLD.completed_at)
 THEN RAISE EXCEPTION 'Immutable store node completion' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER store_node_execution_identity BEFORE UPDATE ON marketplace_store_node_executions FOR EACH ROW EXECUTE FUNCTION guard_store_node_execution_identity();
CREATE FUNCTION guard_store_node_execution_step() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.id,NEW.tenant_id,NEW.execution_id,NEW.ordinal,NEW.request_class,NEW.request_digest,NEW.permit_id,NEW.permit_expires_at,NEW.created_at)
  IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.execution_id,OLD.ordinal,OLD.request_class,OLD.request_digest,OLD.permit_id,OLD.permit_expires_at,OLD.created_at)
  OR (OLD.outcome<>'permitted' AND NEW IS DISTINCT FROM OLD)
 THEN RAISE EXCEPTION 'Immutable store node step identity or receipt' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER store_node_step_identity BEFORE UPDATE ON marketplace_store_node_execution_steps FOR EACH ROW EXECUTE FUNCTION guard_store_node_execution_step();
