ALTER TABLE production_recovery_cases ADD COLUMN request_checksum text CHECK(request_checksum IS NULL OR request_checksum ~ '^[a-f0-9]{64}$');
--> statement-breakpoint
CREATE TABLE production_delivery_packages (
 id uuid PRIMARY KEY CHECK(substring(id::text from 15 for 1)='7'), tenant_id uuid NOT NULL REFERENCES organizations(id), supplier_id uuid NOT NULL, supplier_name text NOT NULL,
 idempotency_key uuid NOT NULL, request_checksum text NOT NULL CHECK(request_checksum ~ '^[a-f0-9]{64}$'), checksum text NOT NULL CHECK(checksum ~ '^[a-f0-9]{64}$'),
 created_by uuid NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT production_delivery_packages_tenant_id_unique UNIQUE(tenant_id,id),
 CONSTRAINT production_delivery_packages_request_unique UNIQUE(tenant_id,idempotency_key),
 CONSTRAINT production_delivery_packages_supplier_fk FOREIGN KEY(tenant_id,supplier_id) REFERENCES fulfillment_suppliers(tenant_id,id)
);
CREATE INDEX production_delivery_packages_created_idx ON production_delivery_packages(tenant_id,created_at);
--> statement-breakpoint
CREATE TABLE production_delivery_items (
 id uuid PRIMARY KEY CHECK(substring(id::text from 15 for 1)='7'), tenant_id uuid NOT NULL REFERENCES organizations(id), package_id uuid NOT NULL,
 production_order_id uuid NOT NULL, production_version_id uuid NOT NULL, work_item_id uuid NOT NULL, work_revision_id uuid NOT NULL,
 editor_project_id uuid NOT NULL, editor_version_id uuid NOT NULL, render_id uuid NOT NULL,
 file_checksum text NOT NULL CHECK(file_checksum ~ '^[a-f0-9]{64}$'), byte_size bigint NOT NULL CHECK(byte_size>0), encrypted_snapshot text NOT NULL,
 CONSTRAINT production_delivery_items_tenant_id_unique UNIQUE(tenant_id,id),
 CONSTRAINT production_delivery_items_order_unique UNIQUE(tenant_id,package_id,production_order_id),
 CONSTRAINT production_delivery_items_package_fk FOREIGN KEY(tenant_id,package_id) REFERENCES production_delivery_packages(tenant_id,id),
 CONSTRAINT production_delivery_items_order_fk FOREIGN KEY(tenant_id,production_order_id) REFERENCES production_orders(tenant_id,id),
 CONSTRAINT production_delivery_items_version_fk FOREIGN KEY(tenant_id,production_version_id) REFERENCES production_order_versions(tenant_id,id),
 CONSTRAINT production_delivery_items_work_fk FOREIGN KEY(tenant_id,work_item_id) REFERENCES order_work_items(tenant_id,id),
 CONSTRAINT production_delivery_items_revision_fk FOREIGN KEY(tenant_id,work_item_id,work_revision_id) REFERENCES order_work_revisions(tenant_id,work_item_id,id),
 CONSTRAINT production_delivery_items_project_fk FOREIGN KEY(tenant_id,editor_project_id) REFERENCES production_editor_projects(tenant_id,id),
 CONSTRAINT production_delivery_items_editor_version_fk FOREIGN KEY(tenant_id,editor_project_id,editor_version_id) REFERENCES production_editor_versions(tenant_id,project_id,id),
 CONSTRAINT production_delivery_items_render_fk FOREIGN KEY(tenant_id,render_id) REFERENCES production_editor_renders(tenant_id,id)
);
CREATE INDEX production_delivery_items_production_idx ON production_delivery_items(tenant_id,production_order_id);
--> statement-breakpoint
CREATE TABLE production_delivery_feedback (
 id uuid PRIMARY KEY CHECK(substring(id::text from 15 for 1)='7'), tenant_id uuid NOT NULL REFERENCES organizations(id), item_id uuid NOT NULL,
 sequence integer NOT NULL CHECK(sequence>0), kind text NOT NULL CHECK(kind IN ('received','accepted','rejected','rework')), idempotency_key uuid NOT NULL,
 request_checksum text NOT NULL CHECK(request_checksum ~ '^[a-f0-9]{64}$'), encrypted_evidence text NOT NULL, recorded_by uuid NOT NULL REFERENCES app_users(id),
 occurred_at timestamptz NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT production_delivery_feedback_item_fk FOREIGN KEY(tenant_id,item_id) REFERENCES production_delivery_items(tenant_id,id),
 CONSTRAINT production_delivery_feedback_sequence_unique UNIQUE(tenant_id,item_id,sequence),
 CONSTRAINT production_delivery_feedback_request_unique UNIQUE(tenant_id,item_id,idempotency_key)
);
--> statement-breakpoint
CREATE FUNCTION protect_production_delivery_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Production delivery history is immutable'; END $$;
CREATE TRIGGER production_delivery_packages_immutable BEFORE UPDATE OR DELETE ON production_delivery_packages FOR EACH ROW EXECUTE FUNCTION protect_production_delivery_history();
CREATE TRIGGER production_delivery_items_immutable BEFORE UPDATE OR DELETE ON production_delivery_items FOR EACH ROW EXECUTE FUNCTION protect_production_delivery_history();
CREATE TRIGGER production_delivery_feedback_immutable BEFORE UPDATE OR DELETE ON production_delivery_feedback FOR EACH ROW EXECUTE FUNCTION protect_production_delivery_history();
ALTER TABLE production_delivery_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_delivery_packages FORCE ROW LEVEL SECURITY;
ALTER TABLE production_delivery_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_delivery_items FORCE ROW LEVEL SECURITY;
ALTER TABLE production_delivery_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_delivery_feedback FORCE ROW LEVEL SECURITY;
CREATE POLICY production_delivery_packages_tenant_policy ON production_delivery_packages FOR ALL TO yummyai_app USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
CREATE POLICY production_delivery_items_tenant_policy ON production_delivery_items FOR ALL TO yummyai_app USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
CREATE POLICY production_delivery_feedback_tenant_policy ON production_delivery_feedback FOR ALL TO yummyai_app USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
GRANT SELECT,INSERT ON production_delivery_packages,production_delivery_items,production_delivery_feedback TO yummyai_app;
