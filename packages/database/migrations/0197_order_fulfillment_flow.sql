CREATE TABLE fulfillment_routes (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), version integer NOT NULL CHECK(version>0),
 profile jsonb NOT NULL, request_key uuid NOT NULL, request_hash text NOT NULL,
 created_by uuid NOT NULL REFERENCES app_users(id), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,request_key)
);
CREATE TABLE fulfillment_route_versions (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), route_id uuid NOT NULL, version integer NOT NULL CHECK(version>0),
 profile jsonb NOT NULL, request_key uuid NOT NULL, request_hash text NOT NULL,
 created_by uuid NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,route_id,version), UNIQUE(tenant_id,request_key),
 FOREIGN KEY(tenant_id,route_id) REFERENCES fulfillment_routes(tenant_id,id)
);
CREATE TRIGGER fulfillment_route_versions_immutable BEFORE UPDATE OR DELETE ON fulfillment_route_versions FOR EACH ROW EXECUTE FUNCTION protect_logistics_history();
CREATE TABLE order_fulfillment_flows (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), order_id uuid NOT NULL,
 requested_by uuid NOT NULL REFERENCES app_users(id), authority jsonb NOT NULL,
 stage text NOT NULL DEFAULT 'waiting_artwork' CHECK(stage IN ('waiting_artwork','waiting_render','production','logistics','delivery','waiting_factory','waiting_dispatch','writeback','completed','exception','paused')),
 route_id uuid, route_version integer, route_snapshot jsonb, reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
 production_order_ids jsonb NOT NULL DEFAULT '[]'::jsonb, logistics_task_id uuid, production_export_id uuid, delivery_package_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
 pending_command jsonb, retry_count integer NOT NULL DEFAULT 0 CHECK(retry_count>=0),
 next_run_at timestamptz NOT NULL DEFAULT now(), lease_token uuid, lease_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,order_id), FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id),
 FOREIGN KEY(tenant_id,route_id) REFERENCES fulfillment_routes(tenant_id,id)
);
CREATE INDEX order_fulfillment_flows_due ON order_fulfillment_flows(tenant_id,next_run_at);
--> statement-breakpoint
DO $$ DECLARE tab text; BEGIN FOREACH tab IN ARRAY ARRAY['fulfillment_routes','fulfillment_route_versions','order_fulfillment_flows'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
 EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK(substring(id::text from 15 for 1)=''7'')',tab,tab||'_uuidv7');
 EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO yummyai_app USING(tenant_id=(SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid))',tab||'_tenant_policy',tab);
 EXECUTE format('GRANT SELECT,INSERT ON %I TO yummyai_app',tab);
END LOOP;END $$;
GRANT UPDATE ON fulfillment_routes,order_fulfillment_flows TO yummyai_app;
CREATE TABLE order_flow_dispatch_tenants (tenant_id uuid PRIMARY KEY REFERENCES organizations(id));
ALTER TABLE order_flow_dispatch_tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_flow_dispatch_tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY order_flow_dispatch_read ON order_flow_dispatch_tenants FOR SELECT TO yummyai_app USING(true);
CREATE POLICY order_flow_dispatch_register ON order_flow_dispatch_tenants FOR INSERT TO yummyai_app WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
GRANT SELECT,INSERT ON order_flow_dispatch_tenants TO yummyai_app;
