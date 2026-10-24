CREATE TABLE catalog_operation_receipts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_plan_id uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('profile','package')),
  input_checksum text NOT NULL,
  output_checksum text NOT NULL,
  result jsonb NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT catalog_operation_receipts_id_check CHECK (substring(id::text from 15 for 1) = '7'),
  CONSTRAINT catalog_operation_receipts_checksums_check CHECK (input_checksum ~ '^[a-f0-9]{64}$' AND output_checksum ~ '^[a-f0-9]{64}$'),
  CONSTRAINT catalog_operation_receipts_plan_fk FOREIGN KEY(tenant_id,product_plan_id) REFERENCES product_plans(tenant_id,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX catalog_operation_receipts_tenant_id_unique ON catalog_operation_receipts(tenant_id,id);
CREATE INDEX catalog_operation_receipts_plan_idx ON catalog_operation_receipts(tenant_id,product_plan_id,created_at);
ALTER TABLE catalog_operation_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_operation_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY catalog_operation_receipts_tenant_policy ON catalog_operation_receipts FOR ALL TO yummyai_app
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id',true),'')::uuid))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
GRANT SELECT, INSERT ON catalog_operation_receipts TO yummyai_app;
--> statement-breakpoint
CREATE FUNCTION protect_catalog_operation_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Catalog operation receipts are immutable'; END;
$$;
CREATE TRIGGER catalog_operation_receipt_immutable BEFORE UPDATE ON catalog_operation_receipts
  FOR EACH ROW EXECUTE FUNCTION protect_catalog_operation_receipt();
