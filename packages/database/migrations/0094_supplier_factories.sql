ALTER TABLE fulfillment_suppliers ADD COLUMN profile jsonb NOT NULL DEFAULT '{"schemaVersion":1,"entityKind":"unconfirmed","legalName":"","alias":"","roles":[],"contacts":[],"officeAddress":null,"paymentTerms":"","invoiceInformation":"","notes":""}'::jsonb;
--> statement-breakpoint
CREATE TABLE fulfillment_factories (
 id uuid PRIMARY KEY CHECK(substring(id::text from 15 for 1)='7'), tenant_id uuid NOT NULL REFERENCES organizations(id), supplier_id uuid NOT NULL,
 code text NOT NULL CHECK(code ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'), name text NOT NULL, status text NOT NULL CHECK(status IN ('draft','active','suspended','archived')),
 current_version_number integer NOT NULL CHECK(current_version_number>0), created_by uuid NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT fulfillment_factories_tenant_id_unique UNIQUE(tenant_id,id), CONSTRAINT fulfillment_factories_parent_unique UNIQUE(tenant_id,supplier_id,id), CONSTRAINT fulfillment_factories_code_unique UNIQUE(tenant_id,code),
 CONSTRAINT fulfillment_factories_supplier_fk FOREIGN KEY(tenant_id,supplier_id) REFERENCES fulfillment_suppliers(tenant_id,id)
);
CREATE INDEX fulfillment_factories_supplier_idx ON fulfillment_factories(tenant_id,supplier_id,status);
--> statement-breakpoint
CREATE TABLE fulfillment_factory_versions (
 id uuid PRIMARY KEY CHECK(substring(id::text from 15 for 1)='7'), tenant_id uuid NOT NULL REFERENCES organizations(id), factory_id uuid NOT NULL, version_number integer NOT NULL CHECK(version_number>0),
 profile jsonb NOT NULL, idempotency_key uuid NOT NULL, request_checksum text NOT NULL CHECK(request_checksum ~ '^[a-f0-9]{64}$'), created_by uuid NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT fulfillment_factory_versions_tenant_id_unique UNIQUE(tenant_id,id), CONSTRAINT fulfillment_factory_versions_parent_unique UNIQUE(tenant_id,factory_id,id), CONSTRAINT fulfillment_factory_versions_number_unique UNIQUE(tenant_id,factory_id,version_number),
 CONSTRAINT fulfillment_factory_versions_request_unique UNIQUE(tenant_id,idempotency_key), CONSTRAINT fulfillment_factory_versions_factory_fk FOREIGN KEY(tenant_id,factory_id) REFERENCES fulfillment_factories(tenant_id,id)
);
--> statement-breakpoint
CREATE TABLE factory_capabilities (
 id uuid PRIMARY KEY CHECK(substring(id::text from 15 for 1)='7'), tenant_id uuid NOT NULL REFERENCES organizations(id), factory_id uuid NOT NULL,
 name text NOT NULL, status text NOT NULL CHECK(status IN ('draft','active','paused','archived')), current_version_number integer NOT NULL CHECK(current_version_number>0),
 created_by uuid NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT factory_capabilities_tenant_id_unique UNIQUE(tenant_id,id), CONSTRAINT factory_capabilities_parent_unique UNIQUE(tenant_id,factory_id,id),
 CONSTRAINT factory_capabilities_factory_fk FOREIGN KEY(tenant_id,factory_id) REFERENCES fulfillment_factories(tenant_id,id)
);
CREATE INDEX factory_capabilities_factory_idx ON factory_capabilities(tenant_id,factory_id,status);
--> statement-breakpoint
CREATE TABLE factory_capability_versions (
 id uuid PRIMARY KEY CHECK(substring(id::text from 15 for 1)='7'), tenant_id uuid NOT NULL REFERENCES organizations(id), factory_id uuid NOT NULL, capability_id uuid NOT NULL,
 version_number integer NOT NULL CHECK(version_number>0), profile jsonb NOT NULL, idempotency_key uuid NOT NULL, request_checksum text NOT NULL CHECK(request_checksum ~ '^[a-f0-9]{64}$'),
 created_by uuid NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT factory_capability_versions_tenant_id_unique UNIQUE(tenant_id,id), CONSTRAINT factory_capability_versions_parent_unique UNIQUE(tenant_id,factory_id,id),
 CONSTRAINT factory_capability_versions_number_unique UNIQUE(tenant_id,capability_id,version_number), CONSTRAINT factory_capability_versions_request_unique UNIQUE(tenant_id,idempotency_key),
 CONSTRAINT factory_capability_versions_capability_fk FOREIGN KEY(tenant_id,factory_id,capability_id) REFERENCES factory_capabilities(tenant_id,factory_id,id)
);
--> statement-breakpoint
CREATE FUNCTION protect_factory_directory_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Factory directory history is immutable'; END $$;
CREATE TRIGGER factory_versions_immutable BEFORE UPDATE OR DELETE ON fulfillment_factory_versions FOR EACH ROW EXECUTE FUNCTION protect_factory_directory_history();
CREATE TRIGGER factory_capability_versions_immutable BEFORE UPDATE OR DELETE ON factory_capability_versions FOR EACH ROW EXECUTE FUNCTION protect_factory_directory_history();
ALTER TABLE fulfillment_factories ENABLE ROW LEVEL SECURITY; ALTER TABLE fulfillment_factories FORCE ROW LEVEL SECURITY;
ALTER TABLE fulfillment_factory_versions ENABLE ROW LEVEL SECURITY; ALTER TABLE fulfillment_factory_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE factory_capabilities ENABLE ROW LEVEL SECURITY; ALTER TABLE factory_capabilities FORCE ROW LEVEL SECURITY;
ALTER TABLE factory_capability_versions ENABLE ROW LEVEL SECURITY; ALTER TABLE factory_capability_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY fulfillment_factories_tenant_policy ON fulfillment_factories FOR ALL TO yummyai_app USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
CREATE POLICY fulfillment_factory_versions_tenant_policy ON fulfillment_factory_versions FOR ALL TO yummyai_app USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
CREATE POLICY factory_capabilities_tenant_policy ON factory_capabilities FOR ALL TO yummyai_app USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
CREATE POLICY factory_capability_versions_tenant_policy ON factory_capability_versions FOR ALL TO yummyai_app USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
GRANT SELECT,INSERT,UPDATE ON fulfillment_factories,factory_capabilities TO yummyai_app;
GRANT SELECT,INSERT ON fulfillment_factory_versions,factory_capability_versions TO yummyai_app;
--> statement-breakpoint
ALTER TABLE production_orders ADD COLUMN factory_id uuid;
ALTER TABLE production_orders ADD COLUMN request_checksum text CHECK(request_checksum IS NULL OR request_checksum ~ '^[a-f0-9]{64}$');
ALTER TABLE production_orders ADD CONSTRAINT production_orders_factory_fk FOREIGN KEY(tenant_id,supplier_id,factory_id) REFERENCES fulfillment_factories(tenant_id,supplier_id,id);
ALTER TABLE production_order_versions ADD COLUMN factory_id uuid, ADD COLUMN factory_version_id uuid, ADD COLUMN capability_version_id uuid;
ALTER TABLE production_order_versions ADD CONSTRAINT production_order_versions_factory_pin_check CHECK((factory_id IS NULL AND factory_version_id IS NULL AND capability_version_id IS NULL) OR (factory_id IS NOT NULL AND factory_version_id IS NOT NULL AND capability_version_id IS NOT NULL));
ALTER TABLE production_order_versions ADD CONSTRAINT production_order_versions_factory_fk FOREIGN KEY(tenant_id,factory_id,factory_version_id) REFERENCES fulfillment_factory_versions(tenant_id,factory_id,id);
ALTER TABLE production_order_versions ADD CONSTRAINT production_order_versions_capability_fk FOREIGN KEY(tenant_id,factory_id,capability_version_id) REFERENCES factory_capability_versions(tenant_id,factory_id,id);
ALTER TABLE production_delivery_packages ADD COLUMN schema_version integer NOT NULL DEFAULT 1 CHECK(schema_version IN (1,2)), ADD COLUMN factory_id uuid, ADD COLUMN factory_version_id uuid;
ALTER TABLE production_delivery_packages ADD CONSTRAINT production_delivery_packages_factory_fk FOREIGN KEY(tenant_id,supplier_id,factory_id) REFERENCES fulfillment_factories(tenant_id,supplier_id,id);
ALTER TABLE production_delivery_packages ADD CONSTRAINT production_delivery_packages_factory_version_fk FOREIGN KEY(tenant_id,factory_id,factory_version_id) REFERENCES fulfillment_factory_versions(tenant_id,factory_id,id);
ALTER TABLE production_delivery_packages ADD CONSTRAINT production_delivery_packages_factory_pin_check CHECK((schema_version=1 AND factory_id IS NULL AND factory_version_id IS NULL) OR (schema_version=2 AND factory_id IS NOT NULL AND factory_version_id IS NOT NULL));
