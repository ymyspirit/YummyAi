ALTER TABLE order_work_items ADD COLUMN platform_ship_by_at timestamptz,
  ADD COLUMN platform_deadline_verified_at timestamptz,
  ADD COLUMN proof_editor_version_id uuid;
--> statement-breakpoint
CREATE INDEX order_work_platform_deadline_idx ON order_work_items(tenant_id, platform_ship_by_at);
--> statement-breakpoint
CREATE TABLE shipment_manual_confirmations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES organizations(id),
  shipment_id uuid NOT NULL,
  shipment_version_id uuid NOT NULL,
  confirmed_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  recorded_by uuid NOT NULL REFERENCES app_users(id),
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL,
  CONSTRAINT shipment_manual_confirmation_shipment_fk FOREIGN KEY (tenant_id, shipment_id) REFERENCES shipments(tenant_id, id),
  CONSTRAINT shipment_manual_confirmation_version_fk FOREIGN KEY (tenant_id, shipment_version_id) REFERENCES shipment_versions(tenant_id, id)
);
CREATE UNIQUE INDEX shipment_manual_confirmation_request_unique ON shipment_manual_confirmations(tenant_id, shipment_id, idempotency_key);
CREATE INDEX shipment_manual_confirmation_version_idx ON shipment_manual_confirmations(tenant_id, shipment_version_id);
--> statement-breakpoint
ALTER TABLE shipment_manual_confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipment_manual_confirmations FORCE ROW LEVEL SECURITY;
CREATE POLICY shipment_manual_confirmations_tenant_policy ON shipment_manual_confirmations FOR ALL TO yummyai_app
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id',true),'')::uuid))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
GRANT SELECT, INSERT ON shipment_manual_confirmations TO yummyai_app;
CREATE TRIGGER shipment_manual_confirmations_immutable BEFORE UPDATE OR DELETE ON shipment_manual_confirmations
  FOR EACH ROW EXECUTE FUNCTION protect_order_work_history();
