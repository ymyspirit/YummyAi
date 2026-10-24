-- Historical reservation events remain NULL. In particular a legacy "fulfilled"
-- event is not retrospectively described as a physical consumption.
ALTER TABLE inventory_reservation_events ADD COLUMN quantity_delta numeric, ADD COLUMN movement_id uuid;
ALTER TABLE inventory_reservation_events DROP CONSTRAINT inventory_reservation_events_action_check;
ALTER TABLE inventory_reservation_events ADD CONSTRAINT inventory_reservation_events_action_check CHECK(action IN ('reserved','released','fulfilled','cancelled','consumed'));
ALTER TABLE inventory_reservation_events ADD CONSTRAINT inventory_reservation_events_consumption_check CHECK(
 (action='consumed' AND quantity_delta IS NOT NULL AND quantity_delta<0 AND quantity_delta>=-2147483647 AND scale(quantity_delta)<=9 AND movement_id IS NOT NULL AND from_status IS NOT NULL AND from_status='active' AND to_status IN ('active','fulfilled'))
 OR (action<>'consumed' AND quantity_delta IS NULL AND movement_id IS NULL));
ALTER TABLE inventory_reservation_events ADD CONSTRAINT inventory_reservation_events_movement_fk FOREIGN KEY(tenant_id,movement_id) REFERENCES inventory_movements(tenant_id,id);
ALTER TABLE inventory_movements DROP CONSTRAINT inventory_movements_type_check;
ALTER TABLE inventory_movements ADD CONSTRAINT inventory_movements_type_check CHECK(type IN ('opening','receipt','allocation','release','pick','ship','return','adjustment','transfer_outbound','transfer_inbound','damage','reconciliation','consumption'));
ALTER TABLE production_manufacturing_bindings ADD CONSTRAINT production_manufacturing_material_ref UNIQUE(tenant_id,id,production_order_id);
--> statement-breakpoint
CREATE TABLE production_material_entries (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), production_order_id uuid NOT NULL, binding_id uuid NOT NULL,
 material_code text NOT NULL, stock_item_id uuid NOT NULL, unit text NOT NULL, kind text NOT NULL, quantity numeric NOT NULL,
 location_id uuid, lot_id uuid, reservation_id uuid, movement_id uuid, original_entry_id uuid,
 report_reference text, encrypted_reason text, idempotency_key text NOT NULL, request_checksum text NOT NULL,
 created_by uuid NOT NULL REFERENCES app_users(id), occurred_at timestamptz NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT production_material_entries_scope UNIQUE(tenant_id,id),
 CONSTRAINT production_material_entries_request UNIQUE(tenant_id,production_order_id,idempotency_key),
 CONSTRAINT production_material_entries_movement UNIQUE(tenant_id,movement_id),
 CONSTRAINT production_material_entries_identity CHECK(substring(id::text from 15 for 1)='7' AND length(material_code) BETWEEN 1 AND 64 AND length(idempotency_key) BETWEEN 8 AND 200 AND request_checksum~'^[a-f0-9]{64}$'),
 CONSTRAINT production_material_entries_kind CHECK(kind IN ('reserve','consume','release','return','factory_report','factory_correction')),
 CONSTRAINT production_material_entries_quantity CHECK(quantity>0 AND quantity<=2147483647 AND scale(quantity)<=9 AND unit IN ('each','pair','set','meter','gram','kilogram') AND (unit NOT IN ('each','pair','set') OR trunc(quantity)=quantity)),
 CONSTRAINT production_material_entries_shape CHECK(
  (kind='reserve' AND reservation_id IS NOT NULL AND location_id IS NOT NULL AND movement_id IS NULL AND original_entry_id IS NULL AND report_reference IS NULL)
  OR (kind='consume' AND location_id IS NOT NULL AND movement_id IS NOT NULL AND report_reference IS NULL AND ((reservation_id IS NULL)=(original_entry_id IS NULL)))
  OR (kind='release' AND reservation_id IS NOT NULL AND original_entry_id IS NOT NULL AND location_id IS NOT NULL AND movement_id IS NULL AND report_reference IS NULL)
  OR (kind='return' AND original_entry_id IS NOT NULL AND location_id IS NOT NULL AND movement_id IS NOT NULL AND reservation_id IS NULL AND report_reference IS NULL AND encrypted_reason IS NOT NULL)
  OR (kind='factory_report' AND report_reference IS NOT NULL AND length(report_reference) BETWEEN 1 AND 200 AND original_entry_id IS NULL AND location_id IS NULL AND lot_id IS NULL AND reservation_id IS NULL AND movement_id IS NULL)
  OR (kind='factory_correction' AND original_entry_id IS NOT NULL AND location_id IS NULL AND lot_id IS NULL AND reservation_id IS NULL AND movement_id IS NULL AND report_reference IS NULL AND encrypted_reason IS NOT NULL)),
 FOREIGN KEY(tenant_id,binding_id,production_order_id) REFERENCES production_manufacturing_bindings(tenant_id,id,production_order_id),
 FOREIGN KEY(tenant_id,stock_item_id) REFERENCES inventory_stock_items(tenant_id,id),
 FOREIGN KEY(tenant_id,location_id) REFERENCES inventory_locations(tenant_id,id),
 FOREIGN KEY(tenant_id,stock_item_id,lot_id) REFERENCES inventory_lots(tenant_id,stock_item_id,id),
 FOREIGN KEY(tenant_id,reservation_id) REFERENCES inventory_reservations(tenant_id,id),
 FOREIGN KEY(tenant_id,movement_id) REFERENCES inventory_movements(tenant_id,id),
 FOREIGN KEY(tenant_id,original_entry_id) REFERENCES production_material_entries(tenant_id,id)
);
CREATE INDEX production_material_entries_history ON production_material_entries(tenant_id,production_order_id,binding_id,id);
CREATE UNIQUE INDEX production_material_entries_reservation ON production_material_entries(tenant_id,reservation_id) WHERE kind='reserve';
CREATE INDEX production_material_entries_corrections ON production_material_entries(tenant_id,original_entry_id,kind);
ALTER TABLE production_material_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_material_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY production_material_entries_tenant ON production_material_entries
 USING(tenant_id=current_setting('app.tenant_id',true)::uuid) WITH CHECK(tenant_id=current_setting('app.tenant_id',true)::uuid);
GRANT SELECT,INSERT ON production_material_entries TO yummyai_app;
CREATE TRIGGER immutable_evidence BEFORE UPDATE OR DELETE ON production_material_entries FOR EACH ROW EXECUTE FUNCTION prevent_manufacturing_evidence_mutation();
--> statement-breakpoint
CREATE FUNCTION guard_production_material_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b production_manufacturing_bindings; line jsonb; previous production_material_entries; m inventory_movements; r inventory_reservations; corrected numeric;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('production-order:'||NEW.production_order_id::text,0));
 SELECT * INTO b FROM production_manufacturing_bindings WHERE tenant_id=NEW.tenant_id AND id=NEW.binding_id;
 SELECT value INTO line FROM jsonb_array_elements(b.content_canonical::jsonb->'materials') WHERE value->>'code'=NEW.material_code;
 IF line IS NULL OR line->>'stockItemId'<>NEW.stock_item_id::text OR line->>'unit'<>NEW.unit
  OR (line->>'responsibility'='merchant')<>(NEW.kind IN ('reserve','consume','release','return'))
  OR line->>'responsibility' NOT IN ('merchant','factory') THEN
  RAISE EXCEPTION 'material must match the sealed production basis' USING ERRCODE='23514';
 END IF;
 IF NEW.original_entry_id IS NOT NULL THEN
  SELECT * INTO previous FROM production_material_entries WHERE tenant_id=NEW.tenant_id AND id=NEW.original_entry_id;
  IF previous.id IS NULL OR previous.binding_id<>NEW.binding_id OR previous.material_code<>NEW.material_code
    OR previous.production_order_id<>NEW.production_order_id OR previous.kind<>(CASE WHEN NEW.kind IN ('consume','release') THEN 'reserve' WHEN NEW.kind='return' THEN 'consume' ELSE 'factory_report' END) THEN
   RAISE EXCEPTION 'material correction must reference the actual original fact' USING ERRCODE='23514';
  END IF;
  IF NEW.kind IN ('return','factory_correction') THEN
   SELECT COALESCE(sum(quantity),0) INTO corrected FROM production_material_entries WHERE tenant_id=NEW.tenant_id AND original_entry_id=previous.id AND kind=NEW.kind;
   IF corrected+NEW.quantity>previous.quantity THEN RAISE EXCEPTION 'material correction exceeds original actual quantity' USING ERRCODE='23514'; END IF;
  END IF;
 END IF;
 IF NEW.reservation_id IS NOT NULL THEN
  SELECT * INTO r FROM inventory_reservations WHERE tenant_id=NEW.tenant_id AND id=NEW.reservation_id;
  IF r.id IS NULL OR r.stock_item_id<>NEW.stock_item_id OR r.location_id<>NEW.location_id OR r.lot_id IS DISTINCT FROM NEW.lot_id OR r.unit<>NEW.unit
   OR r.source_type<>'order_line' OR r.source_id<>b.order_line_id::text OR (NEW.kind='reserve' AND r.quantity<>NEW.quantity)
   OR (NEW.kind IN ('consume','release') AND r.id IS DISTINCT FROM previous.reservation_id) THEN
   RAISE EXCEPTION 'material reservation does not match original stock and production' USING ERRCODE='23514';
  END IF;
 END IF;
 IF NEW.kind='release' THEN
  SELECT r.quantity+COALESCE(sum(e.quantity_delta),0) INTO corrected FROM inventory_reservation_events e
   WHERE e.tenant_id=NEW.tenant_id AND e.reservation_id=r.id AND e.action='consumed';
  IF r.status<>'released' OR NEW.quantity<>corrected OR NOT EXISTS(SELECT 1 FROM inventory_reservation_events e
    WHERE e.tenant_id=NEW.tenant_id AND e.reservation_id=r.id AND e.sequence=r.version AND e.action='released' AND e.idempotency_key=NEW.idempotency_key) THEN
   RAISE EXCEPTION 'release requires the exact original unused reservation remainder' USING ERRCODE='23514';
  END IF;
 END IF;
 IF NEW.movement_id IS NOT NULL THEN
  SELECT * INTO m FROM inventory_movements WHERE tenant_id=NEW.tenant_id AND id=NEW.movement_id;
  IF m.id IS NULL OR m.stock_item_id<>NEW.stock_item_id OR m.location_id<>NEW.location_id OR m.lot_id IS DISTINCT FROM NEW.lot_id
   OR m.unit<>NEW.unit OR m.bucket<>'physical' OR m.source_type<>'order_line' OR m.source_id<>b.order_line_id::text
   OR m.type<>(CASE WHEN NEW.kind='consume' THEN 'consumption' ELSE 'return' END)
   OR m.quantity_delta<>(CASE WHEN NEW.kind='consume' THEN -NEW.quantity ELSE NEW.quantity END)
   OR (NEW.kind='return' AND (m.location_id<>previous.location_id OR m.lot_id IS DISTINCT FROM previous.lot_id)) THEN
   RAISE EXCEPTION 'material entry requires the exact original stock movement' USING ERRCODE='23514';
  END IF;
  IF NEW.reservation_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM inventory_reservation_events e WHERE e.tenant_id=NEW.tenant_id AND e.reservation_id=NEW.reservation_id AND e.action='consumed' AND e.movement_id=m.id AND e.quantity_delta=-NEW.quantity) THEN
   RAISE EXCEPTION 'consumption must atomically reduce the associated reservation' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER original_material_basis BEFORE INSERT ON production_material_entries FOR EACH ROW EXECUTE FUNCTION guard_production_material_entry();
--> statement-breakpoint
CREATE FUNCTION require_production_consumption_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.type='consumption' AND NOT EXISTS(SELECT 1 FROM production_material_entries WHERE tenant_id=NEW.tenant_id AND movement_id=NEW.id AND kind='consume') THEN
  RAISE EXCEPTION 'production consumption requires an atomic material receipt' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER production_consumption_receipt AFTER INSERT ON inventory_movements DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_production_consumption_receipt();
--> statement-breakpoint
CREATE FUNCTION require_consumed_reservation_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.action='consumed' AND NOT EXISTS(SELECT 1 FROM production_material_entries
  WHERE tenant_id=NEW.tenant_id AND reservation_id=NEW.reservation_id AND movement_id=NEW.movement_id AND kind='consume' AND quantity=-NEW.quantity_delta) THEN
  RAISE EXCEPTION 'partial reservation consumption requires an atomic original material receipt' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER consumed_reservation_receipt AFTER INSERT ON inventory_reservation_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_consumed_reservation_receipt();
