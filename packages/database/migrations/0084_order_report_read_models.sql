CREATE TABLE amazon_order_report_read_models (
  version_id uuid PRIMARY KEY NOT NULL,
  tenant_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  encrypted_metadata text,
  encrypted_thumbnails text,
  CONSTRAINT amazon_order_report_read_models_version_fk FOREIGN KEY (tenant_id, version_id)
    REFERENCES amazon_order_report_versions(tenant_id, id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX amazon_order_report_read_models_tenant_idx ON amazon_order_report_read_models(tenant_id, version_id);
--> statement-breakpoint
ALTER TABLE amazon_order_report_read_models ENABLE ROW LEVEL SECURITY;
ALTER TABLE amazon_order_report_read_models FORCE ROW LEVEL SECURITY;
CREATE POLICY amazon_order_report_read_models_tenant_policy ON amazon_order_report_read_models
  FOR ALL TO yummyai_app
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT, UPDATE ON amazon_order_report_read_models TO yummyai_app;
