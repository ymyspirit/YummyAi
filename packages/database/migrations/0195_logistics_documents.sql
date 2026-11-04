CREATE TABLE logistics_document_profiles (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), created_by uuid NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(),
 factory_id uuid NOT NULL, factory_version_id uuid NOT NULL, version_number integer NOT NULL CHECK(version_number>0), profile jsonb NOT NULL,
 request_key uuid NOT NULL, request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,factory_id,version_number), UNIQUE(tenant_id,request_key),
 FOREIGN KEY(tenant_id,factory_id) REFERENCES fulfillment_factories(tenant_id,id),
 FOREIGN KEY(tenant_id,factory_id,factory_version_id) REFERENCES fulfillment_factory_versions(tenant_id,factory_id,id)
);
--> statement-breakpoint
CREATE TABLE logistics_document_exports (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), created_by uuid NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(),
 profile_version_id uuid NOT NULL, adapter text NOT NULL CHECK(adapter IN ('printeque_shipping','printeque_factory','yunexpress')),
 request_key uuid NOT NULL, request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'), source_fingerprint text NOT NULL CHECK(source_fingerprint ~ '^[a-f0-9]{64}$'),
 encrypted_snapshot text, file_checksum text NOT NULL CHECK(file_checksum ~ '^[a-f0-9]{64}$'), byte_size integer NOT NULL CHECK(byte_size>0 AND byte_size<=10485760),
 row_count integer NOT NULL CHECK(row_count>0), expires_at timestamptz NOT NULL,
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,request_key), UNIQUE(tenant_id,profile_version_id,adapter,source_fingerprint),
 FOREIGN KEY(tenant_id,profile_version_id) REFERENCES logistics_document_profiles(tenant_id,id)
);
--> statement-breakpoint
CREATE INDEX logistics_document_exports_retention ON logistics_document_exports(tenant_id,expires_at);
--> statement-breakpoint
CREATE TABLE logistics_document_orders (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), export_id uuid NOT NULL, order_id uuid NOT NULL,
 source_fingerprint text NOT NULL CHECK(source_fingerprint ~ '^[a-f0-9]{64}$'),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,export_id,order_id),
 FOREIGN KEY(tenant_id,export_id) REFERENCES logistics_document_exports(tenant_id,id),
 FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id)
);
--> statement-breakpoint
CREATE INDEX logistics_document_orders_order ON logistics_document_orders(tenant_id,order_id,export_id);
--> statement-breakpoint
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['logistics_document_profiles','logistics_document_exports','logistics_document_orders'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO yummyai_app USING(tenant_id=(SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid))',tab||'_tenant_policy',tab);
  EXECUTE format('GRANT SELECT,INSERT ON %I TO yummyai_app',tab);
 END LOOP;
END $$;
--> statement-breakpoint
GRANT UPDATE(encrypted_snapshot) ON logistics_document_exports TO yummyai_app;
--> statement-breakpoint
CREATE FUNCTION protect_logistics_document_export() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (to_jsonb(NEW)-'encrypted_snapshot') IS DISTINCT FROM (to_jsonb(OLD)-'encrypted_snapshot')
   OR NEW.encrypted_snapshot IS NOT NULL THEN
  RAISE EXCEPTION 'Document export receipts are immutable; only private payload erasure is allowed';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER logistics_document_export_immutable BEFORE UPDATE ON logistics_document_exports
 FOR EACH ROW EXECUTE FUNCTION protect_logistics_document_export();
--> statement-breakpoint
CREATE TABLE logistics_document_labels (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), created_by uuid NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(),
 export_id uuid NOT NULL, order_id uuid NOT NULL, request_key uuid NOT NULL, request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 source_fingerprint text NOT NULL CHECK(source_fingerprint ~ '^[a-f0-9]{64}$'), encrypted_snapshot text,
 file_checksum text NOT NULL CHECK(file_checksum ~ '^[a-f0-9]{64}$'), byte_size integer NOT NULL CHECK(byte_size>0 AND byte_size<=5242880),
 scan_evidence jsonb NOT NULL, expires_at timestamptz NOT NULL,
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,request_key),
 FOREIGN KEY(tenant_id,export_id,order_id) REFERENCES logistics_document_orders(tenant_id,export_id,order_id)
);
--> statement-breakpoint
CREATE INDEX logistics_document_labels_order ON logistics_document_labels(tenant_id,order_id,created_at);
--> statement-breakpoint
ALTER TABLE logistics_document_labels ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE logistics_document_labels FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY logistics_document_labels_tenant_policy ON logistics_document_labels FOR ALL TO yummyai_app
 USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid))
 WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
--> statement-breakpoint
GRANT SELECT,INSERT ON logistics_document_labels TO yummyai_app;
--> statement-breakpoint
GRANT UPDATE(encrypted_snapshot) ON logistics_document_labels TO yummyai_app;
--> statement-breakpoint
CREATE TRIGGER logistics_document_label_immutable BEFORE UPDATE ON logistics_document_labels
 FOR EACH ROW EXECUTE FUNCTION protect_logistics_document_export();
