-- Old receipt bodies cannot be reconstructed by guessing. The original rows
-- remain unchanged and have no synthetic request evidence appended.
CREATE TABLE inventory_procurement_receipt_requests (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 receipt_id uuid NOT NULL,
 purchase_order_id uuid NOT NULL,
 purchase_order_version_id uuid NOT NULL,
 created_by uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
 evidence_version integer NOT NULL DEFAULT 1,
 request_checksum text NOT NULL,
 idempotency_key text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT inventory_receipt_requests_id_check CHECK(substring(id::text from 15 for 1)='7'),
 CONSTRAINT inventory_receipt_requests_version_check CHECK(evidence_version=1),
 CONSTRAINT inventory_receipt_requests_checksum_check CHECK(request_checksum ~ '^[a-f0-9]{64}$'),
 CONSTRAINT inventory_receipt_requests_key_check CHECK(length(idempotency_key) BETWEEN 8 AND 200),
 CONSTRAINT inventory_receipt_requests_receipt_fk FOREIGN KEY(tenant_id,receipt_id) REFERENCES inventory_procurement_receipts(tenant_id,id) ON DELETE RESTRICT,
 CONSTRAINT inventory_receipt_requests_order_fk FOREIGN KEY(tenant_id,purchase_order_id) REFERENCES inventory_purchase_orders(tenant_id,id) ON DELETE RESTRICT,
 CONSTRAINT inventory_receipt_requests_version_fk FOREIGN KEY(tenant_id,purchase_order_version_id) REFERENCES inventory_purchase_order_versions(tenant_id,id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX inventory_receipt_requests_receipt_unique ON inventory_procurement_receipt_requests(tenant_id,receipt_id);
CREATE UNIQUE INDEX inventory_receipt_requests_key_unique ON inventory_procurement_receipt_requests(tenant_id,idempotency_key);
ALTER TABLE inventory_procurement_receipt_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_procurement_receipt_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY inventory_receipt_requests_tenant ON inventory_procurement_receipt_requests
 USING(tenant_id=current_setting('app.tenant_id',true)::uuid) WITH CHECK(tenant_id=current_setting('app.tenant_id',true)::uuid);
GRANT SELECT,INSERT ON inventory_procurement_receipt_requests TO yummyai_app;
--> statement-breakpoint
CREATE FUNCTION guard_inventory_receipt_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'receipt request evidence is immutable' USING ERRCODE='23514'; END IF;
 IF NEW.created_by::text IS DISTINCT FROM current_setting('app.user_id',true) OR NOT EXISTS(
  SELECT 1 FROM inventory_procurement_receipts r WHERE r.tenant_id=NEW.tenant_id AND r.id=NEW.receipt_id
   AND r.purchase_order_id=NEW.purchase_order_id AND r.purchase_order_version_id=NEW.purchase_order_version_id
   AND r.created_by=NEW.created_by AND r.idempotency_key=NEW.idempotency_key
   -- Header and evidence must originate in this transaction. xmin is a 32-bit
   -- transaction id; reduce the full xid8 explicitly to handle epoch rollover.
   AND r.xmin::text=mod(pg_current_xact_id()::text::numeric,4294967296)::bigint::text
 ) THEN RAISE EXCEPTION 'receipt request requires its original actor and same-transaction business receipt' USING ERRCODE='23514'; END IF;
 NEW.created_at=clock_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER inventory_receipt_request_guard BEFORE INSERT OR UPDATE OR DELETE ON inventory_procurement_receipt_requests
 FOR EACH ROW EXECUTE FUNCTION guard_inventory_receipt_request();
--> statement-breakpoint
CREATE FUNCTION require_inventory_receipt_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM inventory_procurement_receipt_requests p WHERE p.tenant_id=NEW.tenant_id AND p.receipt_id=NEW.id
  AND p.purchase_order_id=NEW.purchase_order_id AND p.purchase_order_version_id=NEW.purchase_order_version_id
  AND p.created_by=NEW.created_by AND p.idempotency_key=NEW.idempotency_key) THEN
  RAISE EXCEPTION 'new receipt and original request evidence must commit together' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER inventory_receipt_request_required AFTER INSERT ON inventory_procurement_receipts
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_inventory_receipt_request();
