CREATE TABLE order_sync_schedules (
 id uuid PRIMARY KEY CHECK(substring(id::text from 15 for 1)='7'), tenant_id uuid NOT NULL REFERENCES organizations(id), account_id uuid NOT NULL,
 version integer NOT NULL CHECK(version>0), enabled boolean NOT NULL, requested_by uuid NOT NULL REFERENCES app_users(id), authority jsonb NOT NULL,
 authorization_generation uuid NOT NULL, request_key uuid NOT NULL, request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),
 request jsonb, cursor_hashes jsonb NOT NULL DEFAULT '[]'::jsonb, active_execution_id uuid, last_run_id uuid, error_code text, failure_count integer NOT NULL DEFAULT 0 CHECK(failure_count>=0),
 next_run_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,account_id), UNIQUE(tenant_id,request_key),
 FOREIGN KEY(tenant_id,account_id) REFERENCES marketplace_accounts(tenant_id,id),
 FOREIGN KEY(tenant_id,active_execution_id) REFERENCES marketplace_store_node_executions(tenant_id,id),
 FOREIGN KEY(tenant_id,last_run_id) REFERENCES order_ingestion_runs(tenant_id,id)
);
CREATE INDEX order_sync_schedules_due ON order_sync_schedules(tenant_id,next_run_at) WHERE enabled=true;
ALTER TABLE order_sync_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_sync_schedules FORCE ROW LEVEL SECURITY;
CREATE POLICY order_sync_schedules_tenant_policy ON order_sync_schedules FOR ALL TO yummyai_app
 USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid))
 WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
GRANT SELECT,INSERT,UPDATE ON order_sync_schedules TO yummyai_app;
CREATE TABLE order_sync_dispatch_tenants (tenant_id uuid PRIMARY KEY REFERENCES organizations(id));
ALTER TABLE order_sync_dispatch_tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_sync_dispatch_tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY order_sync_dispatch_read ON order_sync_dispatch_tenants FOR SELECT TO yummyai_app USING(true);
CREATE POLICY order_sync_dispatch_register ON order_sync_dispatch_tenants FOR INSERT TO yummyai_app WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
GRANT SELECT,INSERT ON order_sync_dispatch_tenants TO yummyai_app;
--> statement-breakpoint
ALTER TABLE marketplace_store_node_executions DROP CONSTRAINT store_node_execution_operation_check;
ALTER TABLE marketplace_store_node_executions ADD CONSTRAINT store_node_execution_operation_check CHECK(operation IN
 ('marketplace.capabilities.sync.v1','marketplace.publication.validation-preview.v1','marketplace.publication.amazon-submit.v1','marketplace.publication.amazon-status.v1','marketplace.orders.sync.v1'));
ALTER TABLE marketplace_store_node_executions DROP CONSTRAINT store_node_execution_success_shape;
ALTER TABLE marketplace_store_node_executions ADD CONSTRAINT store_node_execution_success_shape CHECK(
 (operation='marketplace.capabilities.sync.v1' AND (state='succeeded')=(snapshot_id IS NOT NULL) AND (snapshot_id IS NULL OR completion_checksum IS NOT NULL))
 OR (operation IN ('marketplace.publication.validation-preview.v1','marketplace.publication.amazon-submit.v1','marketplace.publication.amazon-status.v1','marketplace.orders.sync.v1')
 AND snapshot_id IS NULL AND (state<>'succeeded' OR completion_checksum IS NOT NULL)));
ALTER TABLE marketplace_store_node_execution_steps DROP CONSTRAINT store_node_step_request_class_check;
ALTER TABLE marketplace_store_node_execution_steps ADD CONSTRAINT store_node_step_request_class_check CHECK(request_class IN
 ('amazon_lwa','amazon_participations','amazon_product_definition','amazon_schema','amazon_meta_schema','amazon_listing_validation_preview','amazon_listing_submit','amazon_listing_status','amazon_orders',
 'etsy_refresh','etsy_shop','etsy_sections','etsy_return_policies','etsy_taxonomy','etsy_shipping_profiles','etsy_readiness_profiles','etsy_taxonomy_properties'));
