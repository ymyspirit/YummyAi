CREATE TABLE shipos_connections (
 id uuid PRIMARY KEY CHECK(substring(id::text from 15 for 1)='7'), tenant_id uuid NOT NULL REFERENCES organizations(id), supplier_id uuid NOT NULL,
 name text NOT NULL, status text NOT NULL CHECK(status IN ('draft','active','paused')), version integer NOT NULL CHECK(version>0), encrypted_credentials text, app_key_hint text,
 last_request_key uuid NOT NULL, last_request_checksum text NOT NULL CHECK(last_request_checksum ~ '^[a-f0-9]{64}$'),
 last_test_at timestamptz, last_test_result text CHECK(last_test_result IN ('success','failed')), created_by uuid NOT NULL REFERENCES app_users(id), updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT shipos_connections_tenant_id_unique UNIQUE(tenant_id,id), CONSTRAINT shipos_connections_supplier_unique UNIQUE(tenant_id,supplier_id),
 CONSTRAINT shipos_connections_supplier_fk FOREIGN KEY(tenant_id,supplier_id) REFERENCES fulfillment_suppliers(tenant_id,id),
 CONSTRAINT shipos_connections_credentials_check CHECK(status<>'active' OR encrypted_credentials IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE shipos_sync_runs (
 id uuid PRIMARY KEY CHECK(substring(id::text from 15 for 1)='7'), tenant_id uuid NOT NULL REFERENCES organizations(id), connection_id uuid NOT NULL, connection_version integer NOT NULL CHECK(connection_version>0),
 idempotency_key uuid NOT NULL, request_checksum text NOT NULL CHECK(request_checksum ~ '^[a-f0-9]{64}$'), order_numbers jsonb NOT NULL CHECK(jsonb_typeof(order_numbers)='array' AND jsonb_array_length(order_numbers) BETWEEN 1 AND 5),
 status text NOT NULL CHECK(status IN ('running','completed','partial','failed')), diagnostic text, created_by uuid NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
 CONSTRAINT shipos_sync_runs_tenant_id_unique UNIQUE(tenant_id,id), CONSTRAINT shipos_sync_runs_request_unique UNIQUE(tenant_id,idempotency_key),
 CONSTRAINT shipos_sync_runs_connection_fk FOREIGN KEY(tenant_id,connection_id) REFERENCES shipos_connections(tenant_id,id)
);
CREATE INDEX shipos_sync_runs_connection_idx ON shipos_sync_runs(tenant_id,connection_id,created_at);
--> statement-breakpoint
CREATE TABLE shipos_order_snapshots (
 id uuid PRIMARY KEY CHECK(substring(id::text from 15 for 1)='7'), tenant_id uuid NOT NULL REFERENCES organizations(id), run_id uuid NOT NULL,
 evidence jsonb NOT NULL, local_order_id uuid, local_line_id uuid, match text NOT NULL CHECK(match IN ('matched','missing','ambiguous','expired','unavailable')), fetched_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT shipos_order_snapshots_tenant_id_unique UNIQUE(tenant_id,id),
 CONSTRAINT shipos_order_snapshots_run_fk FOREIGN KEY(tenant_id,run_id) REFERENCES shipos_sync_runs(tenant_id,id),
 CONSTRAINT shipos_order_snapshots_order_fk FOREIGN KEY(tenant_id,local_order_id) REFERENCES orders(tenant_id,id),
 CONSTRAINT shipos_order_snapshots_line_fk FOREIGN KEY(tenant_id,local_order_id,local_line_id) REFERENCES order_lines(tenant_id,order_id,id),
 CONSTRAINT shipos_order_snapshots_link_check CHECK((match='matched' AND local_order_id IS NOT NULL AND local_line_id IS NOT NULL) OR (match<>'matched' AND local_line_id IS NULL))
);
CREATE FUNCTION protect_shipos_order_evidence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'ShipOS order evidence is immutable'; END $$;
CREATE TRIGGER shipos_order_snapshots_immutable BEFORE UPDATE OR DELETE ON shipos_order_snapshots FOR EACH ROW EXECUTE FUNCTION protect_shipos_order_evidence();
ALTER TABLE shipos_connections ENABLE ROW LEVEL SECURITY; ALTER TABLE shipos_connections FORCE ROW LEVEL SECURITY;
ALTER TABLE shipos_sync_runs ENABLE ROW LEVEL SECURITY; ALTER TABLE shipos_sync_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE shipos_order_snapshots ENABLE ROW LEVEL SECURITY; ALTER TABLE shipos_order_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY shipos_connections_tenant_policy ON shipos_connections FOR ALL TO yummyai_app USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
CREATE POLICY shipos_sync_runs_tenant_policy ON shipos_sync_runs FOR ALL TO yummyai_app USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
CREATE POLICY shipos_order_snapshots_tenant_policy ON shipos_order_snapshots FOR ALL TO yummyai_app USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
GRANT SELECT,INSERT,UPDATE ON shipos_connections,shipos_sync_runs TO yummyai_app;
GRANT SELECT,INSERT ON shipos_order_snapshots TO yummyai_app;
