ALTER TABLE shipment_versions ADD COLUMN production_source_version integer, ADD COLUMN request_checksum text;
--> statement-breakpoint
ALTER TABLE shipment_tracking_events ADD COLUMN recorded_by uuid REFERENCES app_users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE shipment_versions ADD CONSTRAINT shipment_versions_source_check CHECK (
  (production_source_version IS NULL AND request_checksum IS NULL) OR
  (production_source_version IS NOT NULL AND production_source_version=1 AND request_checksum IS NOT NULL AND request_checksum ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX production_orders_source_line_unique ON production_orders(tenant_id,id,order_line_id);
--> statement-breakpoint
CREATE UNIQUE INDEX production_order_versions_source_order_unique ON production_order_versions(tenant_id,id,production_order_id);
--> statement-breakpoint
CREATE UNIQUE INDEX quality_inspections_source_proof_unique ON quality_inspections(tenant_id,id,production_order_id,production_version_id,result);
--> statement-breakpoint
CREATE UNIQUE INDEX shipment_package_lines_source_identity_unique ON shipment_package_lines(tenant_id,id,shipment_id,shipment_version_id,package_id,order_line_id);
--> statement-breakpoint
CREATE UNIQUE INDEX shipment_versions_source_identity_unique ON shipment_versions(tenant_id,id,shipment_id);
--> statement-breakpoint
CREATE UNIQUE INDEX shipment_packages_source_identity_unique ON shipment_packages(tenant_id,id,shipment_id,shipment_version_id);
--> statement-breakpoint
ALTER TABLE shipment_packages ADD CONSTRAINT shipment_packages_source_version_fk FOREIGN KEY(tenant_id,shipment_version_id,shipment_id) REFERENCES shipment_versions(tenant_id,id,shipment_id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE shipment_package_lines ADD CONSTRAINT shipment_package_lines_source_package_fk FOREIGN KEY(tenant_id,package_id,shipment_id,shipment_version_id) REFERENCES shipment_packages(tenant_id,id,shipment_id,shipment_version_id) ON DELETE RESTRICT;
--> statement-breakpoint
CREATE TABLE shipment_production_allocations (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  shipment_id uuid NOT NULL, shipment_version_id uuid NOT NULL, package_id uuid NOT NULL,
  package_line_id uuid NOT NULL, order_line_id uuid NOT NULL,
  production_order_id uuid NOT NULL, production_version_id uuid NOT NULL, quality_inspection_id uuid NOT NULL,
  quality_result text NOT NULL DEFAULT 'passed', production_projection_version integer NOT NULL,
  quantity integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shipment_production_allocations_id_uuidv7_check CHECK (substring(id::text from 15 for 1)='7'),
  CONSTRAINT shipment_production_allocations_quantity_check CHECK (quantity>0 AND production_projection_version>0 AND quality_result='passed'),
  CONSTRAINT shipment_production_allocations_line_fk FOREIGN KEY (tenant_id,package_line_id,shipment_id,shipment_version_id,package_id,order_line_id)
    REFERENCES shipment_package_lines(tenant_id,id,shipment_id,shipment_version_id,package_id,order_line_id) ON DELETE RESTRICT,
  CONSTRAINT shipment_production_allocations_production_fk FOREIGN KEY (tenant_id,production_order_id,order_line_id)
    REFERENCES production_orders(tenant_id,id,order_line_id) ON DELETE RESTRICT,
  CONSTRAINT shipment_production_allocations_version_fk FOREIGN KEY (tenant_id,production_version_id,production_order_id)
    REFERENCES production_order_versions(tenant_id,id,production_order_id) ON DELETE RESTRICT,
  CONSTRAINT shipment_production_allocations_quality_fk FOREIGN KEY (tenant_id,quality_inspection_id,production_order_id,production_version_id,quality_result)
    REFERENCES quality_inspections(tenant_id,id,production_order_id,production_version_id,result) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE UNIQUE INDEX shipment_production_allocations_tenant_id_unique ON shipment_production_allocations(tenant_id,id);
--> statement-breakpoint
CREATE UNIQUE INDEX shipment_production_allocations_lot_unique ON shipment_production_allocations(tenant_id,package_line_id,production_order_id);
--> statement-breakpoint
CREATE INDEX shipment_production_allocations_lot_idx ON shipment_production_allocations(tenant_id,production_order_id,production_version_id);
--> statement-breakpoint
ALTER TABLE shipment_production_allocations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE shipment_production_allocations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY shipment_production_allocations_tenant_policy ON shipment_production_allocations FOR ALL TO yummyai_app
  USING (tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid))
  WITH CHECK (tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
--> statement-breakpoint
GRANT SELECT,INSERT ON shipment_production_allocations TO yummyai_app;
--> statement-breakpoint
CREATE FUNCTION protect_shipment_source_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'shipment versions, packages, reviews, tracking and production allocations are immutable' USING ERRCODE='23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER shipment_versions_immutable BEFORE UPDATE OR DELETE ON shipment_versions FOR EACH ROW EXECUTE FUNCTION protect_shipment_source_history();
--> statement-breakpoint
CREATE TRIGGER shipment_packages_immutable BEFORE UPDATE OR DELETE ON shipment_packages FOR EACH ROW EXECUTE FUNCTION protect_shipment_source_history();
--> statement-breakpoint
CREATE TRIGGER shipment_package_lines_immutable BEFORE UPDATE OR DELETE ON shipment_package_lines FOR EACH ROW EXECUTE FUNCTION protect_shipment_source_history();
--> statement-breakpoint
CREATE TRIGGER shipment_version_reviews_immutable BEFORE UPDATE OR DELETE ON shipment_version_reviews FOR EACH ROW EXECUTE FUNCTION protect_shipment_source_history();
--> statement-breakpoint
CREATE TRIGGER shipment_production_allocations_immutable BEFORE UPDATE OR DELETE ON shipment_production_allocations FOR EACH ROW EXECUTE FUNCTION protect_shipment_source_history();
--> statement-breakpoint
CREATE TRIGGER shipment_tracking_events_immutable BEFORE UPDATE OR DELETE ON shipment_tracking_events FOR EACH ROW EXECUTE FUNCTION protect_shipment_source_history();
--> statement-breakpoint
CREATE FUNCTION require_shipment_production_sources() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user='yummyai_app' AND NEW.production_source_version IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'new shipment version requires explicit production sources' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER shipment_versions_require_sources BEFORE INSERT ON shipment_versions FOR EACH ROW EXECUTE FUNCTION require_shipment_production_sources();
--> statement-breakpoint
CREATE FUNCTION check_shipment_source_totals() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE version_id uuid; source_format integer; version_tenant uuid;
BEGIN
  IF TG_TABLE_NAME='shipment_versions' THEN version_id:=NEW.id; ELSE version_id:=NEW.shipment_version_id; END IF;
  SELECT production_source_version,tenant_id INTO source_format,version_tenant FROM shipment_versions WHERE id=version_id;
  IF source_format IS NULL THEN
    IF TG_TABLE_NAME='shipment_production_allocations' THEN
      RAISE EXCEPTION 'historical shipment sources cannot be backfilled' USING ERRCODE='23514';
    END IF;
    RETURN NULL;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM shipment_package_lines WHERE shipment_version_id=version_id AND tenant_id=version_tenant)
    OR EXISTS(SELECT 1 FROM shipment_package_lines pl WHERE pl.shipment_version_id=version_id AND pl.tenant_id=version_tenant
      AND pl.quantity<>(SELECT coalesce(sum(a.quantity),0) FROM shipment_production_allocations a WHERE a.tenant_id=pl.tenant_id AND a.package_line_id=pl.id)) THEN
    RAISE EXCEPTION 'shipment source quantities must cover every package line exactly' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER shipment_versions_source_totals AFTER INSERT ON shipment_versions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_shipment_source_totals();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER shipment_package_lines_source_totals AFTER INSERT ON shipment_package_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_shipment_source_totals();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER shipment_allocations_source_totals AFTER INSERT ON shipment_production_allocations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_shipment_source_totals();
