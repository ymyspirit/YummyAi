-- Original successful-write bindings. Existing facts remain untouched and unknown.
CREATE TABLE inventory_procurement_write_requests (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 operation text NOT NULL,
 target_id uuid,
 created_by uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
 evidence_version integer NOT NULL DEFAULT 1,
 idempotency_key text NOT NULL,
 request_checksum text NOT NULL,
 requisition_id uuid, rfq_id uuid, quote_id uuid,
 purchase_order_id uuid, purchase_order_version_id uuid, purchase_order_event_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT procurement_write_id_check CHECK(substring(id::text from 15 for 1)='7'),
 CONSTRAINT procurement_write_kind_check CHECK(operation IN ('requisition_create','rfq_create','quote_record','purchase_create','purchase_revise','purchase_review')),
 CONSTRAINT procurement_write_evidence_check CHECK(evidence_version=1),
 CONSTRAINT procurement_write_key_check CHECK(length(idempotency_key) BETWEEN 8 AND 200),
 CONSTRAINT procurement_write_checksum_check CHECK(request_checksum ~ '^[a-f0-9]{64}$'),
 CONSTRAINT procurement_write_req_fk FOREIGN KEY(tenant_id,requisition_id) REFERENCES inventory_procurement_requisitions(tenant_id,id) ON DELETE RESTRICT,
 CONSTRAINT procurement_write_rfq_fk FOREIGN KEY(tenant_id,rfq_id) REFERENCES inventory_procurement_rfqs(tenant_id,id) ON DELETE RESTRICT,
 CONSTRAINT procurement_write_quote_fk FOREIGN KEY(tenant_id,quote_id) REFERENCES inventory_supplier_quote_versions(tenant_id,id) ON DELETE RESTRICT,
 CONSTRAINT procurement_write_order_fk FOREIGN KEY(tenant_id,purchase_order_id) REFERENCES inventory_purchase_orders(tenant_id,id) ON DELETE RESTRICT,
 CONSTRAINT procurement_write_version_fk FOREIGN KEY(tenant_id,purchase_order_version_id) REFERENCES inventory_purchase_order_versions(tenant_id,id) ON DELETE RESTRICT,
 CONSTRAINT procurement_write_event_fk FOREIGN KEY(tenant_id,purchase_order_event_id) REFERENCES inventory_purchase_order_events(tenant_id,id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX procurement_write_key_unique ON inventory_procurement_write_requests(tenant_id,operation,idempotency_key);
CREATE UNIQUE INDEX procurement_write_req_unique ON inventory_procurement_write_requests(tenant_id,requisition_id) WHERE operation='requisition_create';
CREATE UNIQUE INDEX procurement_write_rfq_unique ON inventory_procurement_write_requests(tenant_id,rfq_id) WHERE operation='rfq_create';
CREATE UNIQUE INDEX procurement_write_quote_unique ON inventory_procurement_write_requests(tenant_id,quote_id) WHERE operation='quote_record';
CREATE UNIQUE INDEX procurement_write_event_unique ON inventory_procurement_write_requests(tenant_id,purchase_order_event_id) WHERE purchase_order_event_id IS NOT NULL;
ALTER TABLE inventory_procurement_write_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_procurement_write_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY procurement_write_tenant ON inventory_procurement_write_requests
 USING(tenant_id=current_setting('app.tenant_id',true)::uuid) WITH CHECK(tenant_id=current_setting('app.tenant_id',true)::uuid);
GRANT SELECT,INSERT ON inventory_procurement_write_requests TO yummyai_app;
--> statement-breakpoint
CREATE FUNCTION guard_procurement_original_request() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE valid boolean:=false;
 xid_text text:=mod(pg_current_xact_id()::text::numeric,4294967296)::bigint::text;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'procurement request evidence is immutable' USING ERRCODE='23514'; END IF;
 IF NEW.created_by::text IS DISTINCT FROM current_setting('app.user_id',true) THEN
  RAISE EXCEPTION 'procurement request requires its actual actor' USING ERRCODE='23514';
 END IF;
 IF NEW.operation='requisition_create' AND NEW.target_id IS NULL AND NEW.requisition_id IS NOT NULL
  AND NEW.rfq_id IS NULL AND NEW.quote_id IS NULL AND NEW.purchase_order_id IS NULL
  AND NEW.purchase_order_version_id IS NULL AND NEW.purchase_order_event_id IS NULL THEN
  SELECT EXISTS(SELECT 1 FROM inventory_procurement_requisitions r JOIN inventory_procurement_requisition_versions v
   ON v.tenant_id=r.tenant_id AND v.requisition_id=r.id AND v.version_number=1
   WHERE r.tenant_id=NEW.tenant_id AND r.id=NEW.requisition_id AND r.created_by=NEW.created_by
    AND r.idempotency_key=NEW.idempotency_key AND r.xmin::text=xid_text AND v.xmin::text=xid_text) INTO valid;
 ELSIF NEW.operation='rfq_create' AND NEW.target_id=NEW.requisition_id AND NEW.rfq_id IS NOT NULL
  AND NEW.quote_id IS NULL AND NEW.purchase_order_id IS NULL AND NEW.purchase_order_version_id IS NULL AND NEW.purchase_order_event_id IS NULL THEN
  SELECT EXISTS(SELECT 1 FROM inventory_procurement_rfqs r WHERE r.tenant_id=NEW.tenant_id AND r.id=NEW.rfq_id
   AND r.requisition_id=NEW.requisition_id AND r.created_by=NEW.created_by AND r.idempotency_key=NEW.idempotency_key
   AND r.xmin::text=xid_text) INTO valid;
 ELSIF NEW.operation='quote_record' AND NEW.target_id=NEW.rfq_id AND NEW.requisition_id IS NOT NULL AND NEW.quote_id IS NOT NULL
  AND NEW.purchase_order_id IS NULL AND NEW.purchase_order_version_id IS NULL AND NEW.purchase_order_event_id IS NULL THEN
  SELECT EXISTS(SELECT 1 FROM inventory_supplier_quote_versions q JOIN inventory_procurement_rfqs r ON r.tenant_id=q.tenant_id AND r.id=q.rfq_id
   WHERE q.tenant_id=NEW.tenant_id AND q.id=NEW.quote_id AND q.rfq_id=NEW.rfq_id AND r.requisition_id=NEW.requisition_id
   AND q.created_by=NEW.created_by AND q.idempotency_key=NEW.idempotency_key AND q.xmin::text=xid_text) INTO valid;
 ELSIF NEW.operation IN ('purchase_create','purchase_revise','purchase_review') AND NEW.requisition_id IS NULL
  AND NEW.rfq_id IS NULL AND NEW.quote_id IS NULL AND NEW.purchase_order_id IS NOT NULL
  AND NEW.purchase_order_version_id IS NOT NULL AND NEW.purchase_order_event_id IS NOT NULL THEN
  SELECT EXISTS(SELECT 1 FROM inventory_purchase_orders p JOIN inventory_purchase_order_versions v
   ON v.tenant_id=p.tenant_id AND v.purchase_order_id=p.id JOIN inventory_purchase_order_events e
   ON e.tenant_id=p.tenant_id AND e.purchase_order_id=p.id
   WHERE p.tenant_id=NEW.tenant_id AND p.id=NEW.purchase_order_id AND v.id=NEW.purchase_order_version_id
    AND e.id=NEW.purchase_order_event_id AND e.actor_user_id=NEW.created_by AND e.idempotency_key=NEW.idempotency_key
    AND e.xmin::text=xid_text AND p.current_version=v.version_number
    AND ((NEW.operation='purchase_create' AND p.created_by=NEW.created_by AND p.xmin::text=xid_text AND v.xmin::text=xid_text
      AND v.version_number=1 AND e.action='created' AND ((NEW.target_id IS NULL AND p.source_supply_version_id IS NULL)
       OR EXISTS(SELECT 1 FROM product_supply_versions s WHERE s.tenant_id=p.tenant_id AND s.id=p.source_supply_version_id AND s.link_id=NEW.target_id)))
     OR (NEW.operation='purchase_revise' AND NEW.target_id=p.id AND v.xmin::text=xid_text AND v.version_number>1 AND e.action='revised')
     OR (NEW.operation='purchase_review' AND NEW.target_id=p.id AND e.action IN ('approved','rejected') AND p.status=e.to_status))) INTO valid;
 END IF;
 IF valid IS DISTINCT FROM true THEN RAISE EXCEPTION 'procurement request requires matching same-transaction business facts' USING ERRCODE='23514'; END IF;
 NEW.created_at=clock_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER procurement_original_request_guard BEFORE INSERT OR UPDATE OR DELETE ON inventory_procurement_write_requests
 FOR EACH ROW EXECUTE FUNCTION guard_procurement_original_request();
--> statement-breakpoint
CREATE FUNCTION require_procurement_original_request() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE valid boolean:=false;
BEGIN
 IF TG_TABLE_NAME='inventory_procurement_requisitions' THEN
  SELECT EXISTS(SELECT 1 FROM inventory_procurement_write_requests p WHERE p.tenant_id=NEW.tenant_id AND p.operation='requisition_create' AND p.requisition_id=NEW.id) INTO valid;
 ELSIF TG_TABLE_NAME='inventory_procurement_rfqs' THEN
  SELECT EXISTS(SELECT 1 FROM inventory_procurement_write_requests p WHERE p.tenant_id=NEW.tenant_id AND p.operation='rfq_create' AND p.rfq_id=NEW.id) INTO valid;
 ELSIF TG_TABLE_NAME='inventory_supplier_quote_versions' THEN
  SELECT EXISTS(SELECT 1 FROM inventory_procurement_write_requests p WHERE p.tenant_id=NEW.tenant_id AND p.operation='quote_record' AND p.quote_id=NEW.id) INTO valid;
 ELSIF TG_TABLE_NAME='inventory_purchase_orders' THEN
  SELECT EXISTS(SELECT 1 FROM inventory_procurement_write_requests p WHERE p.tenant_id=NEW.tenant_id AND p.operation='purchase_create' AND p.purchase_order_id=NEW.id) INTO valid;
 ELSIF TG_TABLE_NAME='inventory_purchase_order_versions' THEN
  SELECT EXISTS(SELECT 1 FROM inventory_procurement_write_requests p WHERE p.tenant_id=NEW.tenant_id
   AND p.operation=CASE WHEN NEW.version_number=1 THEN 'purchase_create' ELSE 'purchase_revise' END AND p.purchase_order_version_id=NEW.id) INTO valid;
 ELSIF TG_TABLE_NAME='inventory_purchase_order_events' THEN
  IF NEW.action NOT IN ('created','revised','approved','rejected') THEN RETURN NULL; END IF;
  SELECT EXISTS(SELECT 1 FROM inventory_procurement_write_requests p WHERE p.tenant_id=NEW.tenant_id AND p.purchase_order_event_id=NEW.id
   AND p.operation=CASE NEW.action WHEN 'created' THEN 'purchase_create' WHEN 'revised' THEN 'purchase_revise' ELSE 'purchase_review' END) INTO valid;
 END IF;
 IF valid IS DISTINCT FROM true THEN RAISE EXCEPTION 'procurement business facts and original request must commit together' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER procurement_req_original_required AFTER INSERT ON inventory_procurement_requisitions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_procurement_original_request();
CREATE CONSTRAINT TRIGGER procurement_rfq_original_required AFTER INSERT ON inventory_procurement_rfqs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_procurement_original_request();
CREATE CONSTRAINT TRIGGER procurement_quote_original_required AFTER INSERT ON inventory_supplier_quote_versions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_procurement_original_request();
CREATE CONSTRAINT TRIGGER procurement_order_original_required AFTER INSERT ON inventory_purchase_orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_procurement_original_request();
CREATE CONSTRAINT TRIGGER procurement_version_original_required AFTER INSERT ON inventory_purchase_order_versions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_procurement_original_request();
CREATE CONSTRAINT TRIGGER procurement_event_original_required AFTER INSERT ON inventory_purchase_order_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_procurement_original_request();
--> statement-breakpoint
-- Approval and revision are also mutable projections. Inserting proof-only
-- history must not allow a caller to change the projection without its event.
CREATE FUNCTION require_procurement_review_projection() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE valid boolean:=false;
 xid_text text:=mod(pg_current_xact_id()::text::numeric,4294967296)::bigint::text;
BEGIN
 IF NEW.current_version=OLD.current_version AND NEW.status=OLD.status THEN RETURN NULL; END IF;
 IF NEW.current_version=OLD.current_version AND NEW.status NOT IN ('draft','approved','rejected') THEN RETURN NULL; END IF;
 SELECT EXISTS(SELECT 1 FROM inventory_procurement_write_requests p
  JOIN inventory_purchase_order_events e ON e.tenant_id=p.tenant_id AND e.id=p.purchase_order_event_id
  JOIN inventory_purchase_order_versions v ON v.tenant_id=p.tenant_id AND v.id=p.purchase_order_version_id
  WHERE p.tenant_id=NEW.tenant_id AND p.purchase_order_id=NEW.id AND v.version_number=NEW.current_version
   AND p.xmin::text=xid_text AND e.xmin::text=xid_text AND e.to_status=NEW.status AND e.from_status=OLD.status
   AND ((NEW.current_version=OLD.current_version+1 AND NEW.status='draft' AND p.operation='purchase_revise' AND e.action='revised')
    OR (NEW.current_version=OLD.current_version AND NEW.status IN ('approved','rejected') AND p.operation='purchase_review' AND e.action=NEW.status))) INTO valid;
 IF valid IS DISTINCT FROM true THEN RAISE EXCEPTION 'purchase revision or review requires its actual original request and event' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER procurement_review_projection_required AFTER UPDATE ON inventory_purchase_orders
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_procurement_review_projection();
