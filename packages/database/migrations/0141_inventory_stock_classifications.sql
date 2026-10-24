-- Existing stock items stay unclassified. Names, SKUs and prior receipts do not
-- establish a material category or an incoming-inspection approval.
CREATE TABLE inventory_stock_item_classifications (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 stock_item_id uuid NOT NULL,
 version_number integer NOT NULL,
 kind text NOT NULL,
 reason text NOT NULL,
 request_checksum text NOT NULL,
 idempotency_key text NOT NULL,
 created_by uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT inventory_stock_classifications_id_check CHECK(substring(id::text from 15 for 1)='7'),
 CONSTRAINT inventory_stock_classifications_version_check CHECK(version_number>0),
 CONSTRAINT inventory_stock_classifications_kind_check CHECK(kind IN ('blank','material','packaging','work_in_progress','finished_good')),
 CONSTRAINT inventory_stock_classifications_reason_check CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
 CONSTRAINT inventory_stock_classifications_checksum_check CHECK(request_checksum ~ '^[a-f0-9]{64}$'),
 CONSTRAINT inventory_stock_classifications_key_check CHECK(length(idempotency_key) BETWEEN 8 AND 200),
 CONSTRAINT inventory_stock_classifications_stock_fk FOREIGN KEY(tenant_id,stock_item_id) REFERENCES inventory_stock_items(tenant_id,id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX inventory_stock_classifications_tenant_id_unique ON inventory_stock_item_classifications(tenant_id,id);
CREATE UNIQUE INDEX inventory_stock_classifications_version_unique ON inventory_stock_item_classifications(tenant_id,stock_item_id,version_number);
CREATE UNIQUE INDEX inventory_stock_classifications_key_unique ON inventory_stock_item_classifications(tenant_id,idempotency_key);
ALTER TABLE inventory_stock_item_classifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_stock_item_classifications FORCE ROW LEVEL SECURITY;
CREATE POLICY inventory_stock_classifications_tenant ON inventory_stock_item_classifications
 USING(tenant_id=current_setting('app.tenant_id',true)::uuid) WITH CHECK(tenant_id=current_setting('app.tenant_id',true)::uuid);
GRANT SELECT,INSERT ON inventory_stock_item_classifications TO yummyai_app;
--> statement-breakpoint
CREATE FUNCTION guard_inventory_stock_classification() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE next_version integer;
BEGIN
 IF TG_OP<>'INSERT' THEN
  RAISE EXCEPTION 'stock classification evidence is immutable' USING ERRCODE='23514';
 END IF;
 IF NEW.created_by::text IS DISTINCT FROM current_setting('app.user_id',true) THEN
  RAISE EXCEPTION 'stock classification requires its actual actor' USING ERRCODE='23514';
 END IF;
 PERFORM id FROM inventory_stock_items WHERE tenant_id=NEW.tenant_id AND id=NEW.stock_item_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'stock classification source unavailable' USING ERRCODE='23514'; END IF;
 SELECT coalesce(max(version_number),0)+1 INTO next_version FROM inventory_stock_item_classifications
  WHERE tenant_id=NEW.tenant_id AND stock_item_id=NEW.stock_item_id;
 IF NEW.version_number<>next_version THEN
  RAISE EXCEPTION 'stock classification version changed' USING ERRCODE='23514';
 END IF;
 NEW.created_at=clock_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER inventory_stock_classification_guard BEFORE INSERT OR UPDATE OR DELETE ON inventory_stock_item_classifications
 FOR EACH ROW EXECUTE FUNCTION guard_inventory_stock_classification();
