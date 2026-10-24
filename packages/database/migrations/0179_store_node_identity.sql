-- No historical account, credential, snapshot, or publication row is rewritten.
CREATE TABLE marketplace_store_nodes (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), account_id uuid NOT NULL,
 label text NOT NULL CHECK(length(label) BETWEEN 1 AND 80), public_key_pem text NOT NULL,
 public_key_spki_sha256 text NOT NULL, creation_request_key text NOT NULL, creation_input_digest text NOT NULL,
 status text NOT NULL DEFAULT 'pending_enrollment', certificate_generation integer NOT NULL DEFAULT 1,
 certificate_fingerprint_sha256 text, certificate_pem text, certificate_expires_at timestamptz, certificate_issued_at timestamptz,
 authorization_generation uuid NOT NULL, created_by uuid NOT NULL, membership_id uuid NOT NULL, authority_ceiling jsonb NOT NULL,
 ticket_digest text, ticket_state text NOT NULL DEFAULT 'none', ticket_expires_at timestamptz, enrollment_claim_id uuid,
 session_id uuid, last_sequence integer NOT NULL DEFAULT 0, session_expires_at timestamptz, last_seen_at timestamptz, last_heartbeat_response jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), revoked_at timestamptz,
 CONSTRAINT store_nodes_id_check CHECK(substring(id::text from 15 for 1)='7'),
 CONSTRAINT store_nodes_status_check CHECK(status IN('pending_enrollment','enrolled','revoked')),
 CONSTRAINT store_nodes_generation_check CHECK(certificate_generation>0 AND last_sequence>=0),
 CONSTRAINT store_nodes_ticket_state_check CHECK(ticket_state IN('none','issued','claimed','consumed')),
 CONSTRAINT store_nodes_digest_check CHECK(public_key_spki_sha256~'^[a-f0-9]{64}$' AND creation_request_key~'^[a-f0-9]{64}$' AND creation_input_digest~'^[a-f0-9]{64}$'),
 CONSTRAINT store_nodes_certificate_shape CHECK((status='enrolled' AND num_nonnulls(certificate_fingerprint_sha256,certificate_pem,certificate_expires_at,certificate_issued_at)=4) OR (status<>'enrolled' AND num_nonnulls(certificate_fingerprint_sha256,certificate_pem,certificate_expires_at,certificate_issued_at)=0)),
 CONSTRAINT store_nodes_ticket_shape CHECK((ticket_state='none' AND ticket_digest IS NULL AND ticket_expires_at IS NULL AND enrollment_claim_id IS NULL) OR (ticket_state<>'none' AND ticket_digest IS NOT NULL AND ticket_digest~'^[a-f0-9]{64}$' AND ticket_expires_at IS NOT NULL AND ((ticket_state IN('claimed','consumed'))=(enrollment_claim_id IS NOT NULL)))),
 CONSTRAINT store_nodes_account_fk FOREIGN KEY(tenant_id,account_id) REFERENCES marketplace_accounts(tenant_id,id),
 CONSTRAINT store_nodes_tenant_account_id_unique UNIQUE(tenant_id,account_id,id),
 CONSTRAINT store_nodes_creation_unique UNIQUE(tenant_id,creation_request_key),
 CONSTRAINT store_nodes_key_unique UNIQUE(tenant_id,account_id,public_key_spki_sha256)
);
CREATE UNIQUE INDEX store_nodes_certificate_unique ON marketplace_store_nodes(certificate_fingerprint_sha256) WHERE certificate_fingerprint_sha256 IS NOT NULL;
CREATE INDEX store_nodes_account_idx ON marketplace_store_nodes(tenant_id,account_id,created_at);
--> statement-breakpoint
CREATE TABLE marketplace_store_node_bindings (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), account_id uuid NOT NULL,
 revision integer NOT NULL DEFAULT 0 CHECK(revision>=0), state text NOT NULL DEFAULT 'unbound' CHECK(state IN('unbound','active','draining')),
 node_id uuid, certificate_generation integer, authorization_generation uuid, lease_expires_at timestamptz,
 approved_by uuid, membership_id uuid, authority_ceiling jsonb, updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT store_node_bindings_account_fk FOREIGN KEY(tenant_id,account_id) REFERENCES marketplace_accounts(tenant_id,id),
 CONSTRAINT store_node_bindings_node_fk FOREIGN KEY(tenant_id,account_id,node_id) REFERENCES marketplace_store_nodes(tenant_id,account_id,id),
 CONSTRAINT store_node_bindings_account_unique UNIQUE(tenant_id,account_id),
 CONSTRAINT store_node_bindings_shape CHECK((state='unbound' AND num_nonnulls(node_id,certificate_generation,authorization_generation,lease_expires_at,approved_by,membership_id,authority_ceiling)=0) OR (state<>'unbound' AND num_nonnulls(node_id,certificate_generation,authorization_generation,lease_expires_at,approved_by,membership_id,authority_ceiling)=7))
);
--> statement-breakpoint
ALTER TABLE marketplace_store_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_store_nodes FORCE ROW LEVEL SECURITY;
CREATE POLICY store_nodes_tenant ON marketplace_store_nodes FOR ALL TO yummyai_app
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE marketplace_store_node_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_store_node_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY store_node_bindings_tenant ON marketplace_store_node_bindings FOR ALL TO yummyai_app
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON marketplace_store_nodes,marketplace_store_node_bindings TO yummyai_app;
--> statement-breakpoint
-- The only pre-tenant lookups require a high entropy one-use digest or a peer
-- certificate fingerprint already authenticated by the private TLS listener.
-- They reveal only the pinned origin. Every business read/write then uses RLS
-- and revalidates current membership, account and all generations.
CREATE FUNCTION authenticate_store_node_ticket(requested_id uuid,requested_digest text)
RETURNS TABLE(account_id uuid,authority_ceiling jsonb,membership_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT n.account_id,n.authority_ceiling,n.membership_id FROM public.marketplace_store_nodes n
 WHERE n.id=requested_id AND requested_digest~'^[a-f0-9]{64}$' AND n.ticket_digest=requested_digest
 AND n.status='pending_enrollment' AND n.ticket_state='issued' AND n.ticket_expires_at>clock_timestamp()
$$;
REVOKE ALL ON FUNCTION authenticate_store_node_ticket(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authenticate_store_node_ticket(uuid,text) TO yummyai_app;
CREATE FUNCTION authenticate_store_node_peer(requested_fingerprint text)
RETURNS TABLE(node_id uuid,account_id uuid,authority_ceiling jsonb,membership_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT n.id,n.account_id,n.authority_ceiling,n.membership_id FROM public.marketplace_store_nodes n
 WHERE requested_fingerprint~'^[a-f0-9]{64}$' AND n.certificate_fingerprint_sha256=requested_fingerprint
 AND n.status='enrolled' AND n.certificate_expires_at>clock_timestamp()
$$;
REVOKE ALL ON FUNCTION authenticate_store_node_peer(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authenticate_store_node_peer(text) TO yummyai_app;
