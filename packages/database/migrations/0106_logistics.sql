CREATE TABLE logistics_connections (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), created_by uuid NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(),
 factory_id uuid NOT NULL, version integer NOT NULL CHECK(version>0), rule_version integer NOT NULL DEFAULT 0 CHECK(rule_version>=0), verified_version_id uuid, verified_at timestamptz,
 UNIQUE(tenant_id,id), FOREIGN KEY(tenant_id,factory_id) REFERENCES fulfillment_factories(tenant_id,id)
);
CREATE TABLE logistics_connection_versions (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), created_by uuid NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(),
 connection_id uuid NOT NULL, version integer NOT NULL CHECK(version>0), profile jsonb NOT NULL, encrypted_credentials text NOT NULL, request_key uuid NOT NULL, request_hash text NOT NULL,
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,connection_id,version), UNIQUE(tenant_id,request_key), FOREIGN KEY(tenant_id,connection_id) REFERENCES logistics_connections(tenant_id,id)
);
ALTER TABLE logistics_connections ADD FOREIGN KEY(tenant_id,verified_version_id) REFERENCES logistics_connection_versions(tenant_id,id);
CREATE TABLE logistics_rule_versions (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), created_by uuid NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(),
 connection_id uuid NOT NULL, version integer NOT NULL CHECK(version>0), connection_version_id uuid NOT NULL, rule jsonb NOT NULL, request_key uuid NOT NULL, request_hash text NOT NULL,
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,connection_id,version), UNIQUE(tenant_id,request_key), FOREIGN KEY(tenant_id,connection_id) REFERENCES logistics_connections(tenant_id,id), FOREIGN KEY(tenant_id,connection_version_id) REFERENCES logistics_connection_versions(tenant_id,id)
);
CREATE TABLE logistics_tasks (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), created_by uuid NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(),
 order_id uuid NOT NULL, factory_id uuid NOT NULL, connection_version_id uuid NOT NULL, rule_version_id uuid NOT NULL,
 identity_key text NOT NULL, request_key uuid NOT NULL, request_hash text NOT NULL, external_reference text NOT NULL, encrypted_snapshot text,
 snapshot_hash text NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','quoted','purchasing','created','label_requesting','completed','attention','reconciliation_required','cancelled')),
 diagnostic text, selected_quote jsonb, processing_run_id uuid, lease_until timestamptz, label_requested_at timestamptz, provider_order_id text, tracking_numbers jsonb NOT NULL DEFAULT '[]'::jsonb, actual_cost_minor bigint CHECK(actual_cost_minor>=0), actual_currency text,
 reservation_minor bigint NOT NULL DEFAULT 0 CHECK(reservation_minor>=0), reserved_day text, updated_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,identity_key), UNIQUE(tenant_id,request_key), UNIQUE(tenant_id,external_reference),
 FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id), FOREIGN KEY(tenant_id,factory_id) REFERENCES fulfillment_factories(tenant_id,id),
 FOREIGN KEY(tenant_id,connection_version_id) REFERENCES logistics_connection_versions(tenant_id,id), FOREIGN KEY(tenant_id,rule_version_id) REFERENCES logistics_rule_versions(tenant_id,id),
 CHECK((actual_cost_minor IS NULL)=(actual_currency IS NULL)), CHECK((reservation_minor=0) OR reserved_day IS NOT NULL)
);
CREATE INDEX logistics_tasks_queue ON logistics_tasks(tenant_id,status,updated_at);
CREATE TABLE logistics_task_productions (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), created_by uuid NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(),
 task_id uuid NOT NULL, production_version_id uuid NOT NULL, UNIQUE(tenant_id,id), UNIQUE(tenant_id,production_version_id),
 FOREIGN KEY(tenant_id,task_id) REFERENCES logistics_tasks(tenant_id,id), FOREIGN KEY(tenant_id,production_version_id) REFERENCES production_order_versions(tenant_id,id)
);
CREATE TABLE logistics_quotes (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), created_by uuid NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(),
 task_id uuid NOT NULL, quote jsonb NOT NULL, round_id uuid NOT NULL, UNIQUE(tenant_id,id), FOREIGN KEY(tenant_id,task_id) REFERENCES logistics_tasks(tenant_id,id)
);
CREATE TABLE logistics_labels (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), created_by uuid NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(),
 task_id uuid NOT NULL, object_key text NOT NULL, checksum text NOT NULL, file_name text NOT NULL, byte_size integer NOT NULL CHECK(byte_size BETWEEN 5 AND 10485760),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,task_id,checksum), FOREIGN KEY(tenant_id,task_id) REFERENCES logistics_tasks(tenant_id,id)
);
CREATE TABLE logistics_events (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), created_by uuid NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(),
 task_id uuid, connection_id uuid, action text NOT NULL, data jsonb NOT NULL, UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,task_id) REFERENCES logistics_tasks(tenant_id,id), FOREIGN KEY(tenant_id,connection_id) REFERENCES logistics_connections(tenant_id,id)
);
--> statement-breakpoint
CREATE FUNCTION protect_logistics_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Logistics history is immutable'; END $$;
CREATE TRIGGER logistics_connection_versions_immutable BEFORE UPDATE OR DELETE ON logistics_connection_versions FOR EACH ROW EXECUTE FUNCTION protect_logistics_history();
CREATE TRIGGER logistics_rule_versions_immutable BEFORE UPDATE OR DELETE ON logistics_rule_versions FOR EACH ROW EXECUTE FUNCTION protect_logistics_history();
CREATE TRIGGER logistics_quotes_immutable BEFORE UPDATE OR DELETE ON logistics_quotes FOR EACH ROW EXECUTE FUNCTION protect_logistics_history();
CREATE TRIGGER logistics_events_immutable BEFORE UPDATE OR DELETE ON logistics_events FOR EACH ROW EXECUTE FUNCTION protect_logistics_history();
CREATE TRIGGER logistics_task_productions_immutable BEFORE UPDATE OR DELETE ON logistics_task_productions FOR EACH ROW EXECUTE FUNCTION protect_logistics_history();
CREATE FUNCTION protect_logistics_task_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.order_id IS DISTINCT FROM OLD.order_id OR NEW.factory_id IS DISTINCT FROM OLD.factory_id OR NEW.connection_version_id IS DISTINCT FROM OLD.connection_version_id OR NEW.rule_version_id IS DISTINCT FROM OLD.rule_version_id
 OR NEW.snapshot_hash IS DISTINCT FROM OLD.snapshot_hash OR NEW.identity_key IS DISTINCT FROM OLD.identity_key OR NEW.external_reference IS DISTINCT FROM OLD.external_reference
 OR NEW.request_key IS DISTINCT FROM OLD.request_key OR NEW.request_hash IS DISTINCT FROM OLD.request_hash OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.created_by IS DISTINCT FROM OLD.created_by
 OR (NEW.encrypted_snapshot IS DISTINCT FROM OLD.encrypted_snapshot AND NEW.encrypted_snapshot IS NOT NULL) THEN RAISE EXCEPTION 'Logistics task pins are immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER logistics_task_snapshot_immutable BEFORE UPDATE ON logistics_tasks FOR EACH ROW EXECUTE FUNCTION protect_logistics_task_snapshot();
--> statement-breakpoint
DO $$ DECLARE tab text; BEGIN FOREACH tab IN ARRAY ARRAY['logistics_connections','logistics_connection_versions','logistics_rule_versions','logistics_tasks','logistics_task_productions','logistics_quotes','logistics_labels','logistics_events'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab); EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
 EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK(substring(id::text from 15 for 1)=''7'')',tab,tab||'_uuidv7');
 EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO yummyai_app USING(tenant_id=(SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid))',tab||'_tenant_policy',tab);
 EXECUTE format('GRANT SELECT,INSERT ON %I TO yummyai_app',tab);
END LOOP; END $$;
GRANT UPDATE ON logistics_connections,logistics_tasks TO yummyai_app;
GRANT DELETE ON logistics_labels TO yummyai_app;
