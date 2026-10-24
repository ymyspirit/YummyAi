-- No historical JSON, checksums, ciphertext, costs or allocations are rewritten.
-- Unconstrained numeric rejects excess scale rather than rounding it on input.
ALTER TABLE inventory_supplier_invoice_lines ALTER COLUMN invoiced_quantity TYPE numeric USING invoiced_quantity::numeric,
 ALTER COLUMN variance_minor DROP NOT NULL,
 ADD COLUMN unit text, ADD COLUMN price_basis_quantity numeric, ADD COLUMN allocated_quantity numeric;
ALTER TABLE inventory_supplier_invoices ALTER COLUMN variance_minor DROP NOT NULL,
 ADD COLUMN allocation_status text, ADD COLUMN creation_transaction_id text;
ALTER TABLE inventory_procurement_receipt_lines ADD COLUMN price_basis_quantity numeric, ADD COLUMN stock_unit text,
 ADD COLUMN stock_received_quantity numeric, ADD COLUMN stock_rejected_quantity numeric;
ALTER TABLE inventory_lots ADD COLUMN unit_cost_quantity numeric;
ALTER TABLE inventory_replenishment_policy_versions
 ALTER COLUMN reorder_point TYPE numeric USING reorder_point::numeric,
 ALTER COLUMN safety_stock TYPE numeric USING safety_stock::numeric,
 ALTER COLUMN minimum_order_quantity TYPE numeric USING minimum_order_quantity::numeric;
ALTER TABLE inventory_replenishment_suggestions ALTER COLUMN suggested_quantity TYPE numeric USING suggested_quantity::numeric;
--> statement-breakpoint
CREATE FUNCTION procurement_quantity_valid(q numeric,u text) RETURNS boolean
 LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
 SELECT coalesce(q BETWEEN 0 AND 2147483647 AND scale(q)<=9
  AND u IN ('each','pair','set','meter','gram','kilogram')
  AND (u NOT IN ('each','pair','set') OR trunc(q)=q),false)
$$;
CREATE FUNCTION procurement_unit_factor(source_unit text,target_unit text) RETURNS numeric
 LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
BEGIN
 IF source_unit=target_unit AND source_unit IN ('each','pair','set','meter','gram','kilogram') THEN RETURN 1; END IF;
 IF source_unit='kilogram' AND target_unit='gram' THEN RETURN 1000; END IF;
 IF source_unit='gram' AND target_unit='kilogram' THEN RETURN 0.001; END IF;
 RAISE EXCEPTION 'procurement unit conversion is unavailable' USING ERRCODE='23514';
END $$;
CREATE FUNCTION procurement_convert_quantity(q numeric,source_unit text,target_unit text) RETURNS numeric
 LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE converted numeric;
BEGIN
 IF NOT procurement_quantity_valid(q,source_unit) THEN RAISE EXCEPTION 'invalid procurement source quantity' USING ERRCODE='23514'; END IF;
 converted:=trim_scale(q*procurement_unit_factor(source_unit,target_unit));
 IF NOT procurement_quantity_valid(converted,target_unit) THEN RAISE EXCEPTION 'procurement conversion cannot be represented exactly' USING ERRCODE='23514'; END IF;
 RETURN converted;
END $$;
CREATE FUNCTION procurement_json_quantity(value jsonb,u text,positive boolean) RETURNS numeric
 LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE q numeric; raw text;
BEGIN
 raw:=value#>>'{}';
 IF value IS NULL OR jsonb_typeof(value) NOT IN ('string','number') OR length(raw)>40
  OR raw !~ '^[0-9]+([.][0-9]{1,9})?$' THEN RAISE EXCEPTION 'invalid procurement JSON quantity' USING ERRCODE='23514'; END IF;
 q:=raw::numeric;
 IF (jsonb_typeof(value)='number' AND trunc(q)<>q) OR NOT procurement_quantity_valid(q,u) OR (positive AND q<=0) THEN
  RAISE EXCEPTION 'procurement JSON quantity must retain its exact unit and precision' USING ERRCODE='23514'; END IF;
 RETURN q;
END $$;
CREATE FUNCTION procurement_minor_amount(q numeric,cost bigint,basis numeric) RETURNS bigint
 LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE amount numeric;
BEGIN
 IF q IS NULL OR cost IS NULL OR basis IS NULL OR q<0 OR basis<=0 OR cost<0 OR cost>9007199254740991 THEN
  RAISE EXCEPTION 'invalid procurement amount basis' USING ERRCODE='23514'; END IF;
 IF mod(q*cost,basis)<>0 THEN RAISE EXCEPTION 'fractional minor money is not permitted' USING ERRCODE='23514'; END IF;
 amount:=q*cost/basis;
 IF amount IS NULL OR trunc(amount)<>amount OR amount<0 OR amount>9007199254740991 THEN
  RAISE EXCEPTION 'procurement minor amount cannot be represented exactly' USING ERRCODE='23514'; END IF;
 RETURN amount::bigint;
END $$;
REVOKE ALL ON FUNCTION procurement_quantity_valid(numeric,text),procurement_unit_factor(text,text),
 procurement_convert_quantity(numeric,text,text),procurement_json_quantity(jsonb,text,boolean),procurement_minor_amount(numeric,bigint,numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION procurement_quantity_valid(numeric,text),procurement_unit_factor(text,text),
 procurement_convert_quantity(numeric,text,text),procurement_json_quantity(jsonb,text,boolean),procurement_minor_amount(numeric,bigint,numeric) TO yummyai_app;
--> statement-breakpoint
ALTER TABLE inventory_lots ADD CONSTRAINT inventory_lot_cost_quantity_check CHECK(unit_cost_quantity IS NULL OR
 (unit_cost_quantity>0 AND unit_cost_quantity<=2147483647 AND scale(unit_cost_quantity)<=9 AND unit_cost_minor IS NOT NULL));
ALTER TABLE inventory_supplier_invoice_lines ADD CONSTRAINT supplier_invoice_line_exact_check CHECK(
 (unit IS NULL AND scale(invoiced_quantity)=0 AND invoiced_quantity<=2147483647)
 OR procurement_quantity_valid(invoiced_quantity,unit)),
 ADD CONSTRAINT supplier_invoice_line_basis_check CHECK(price_basis_quantity IS NULL OR
 (price_basis_quantity>0 AND procurement_quantity_valid(price_basis_quantity,unit))),
 ADD CONSTRAINT supplier_invoice_line_allocated_check CHECK(allocated_quantity IS NULL OR
 (procurement_quantity_valid(allocated_quantity,unit) AND allocated_quantity<=invoiced_quantity));
ALTER TABLE inventory_supplier_invoices ADD CONSTRAINT supplier_invoice_allocation_status_check CHECK(
 allocation_status IS NULL OR allocation_status IN ('complete','reconciliation_required','legacy_unknown')),
 ADD CONSTRAINT supplier_invoice_creation_transaction_check CHECK(creation_transaction_id IS NULL OR creation_transaction_id ~ '^[0-9]+$');
--> statement-breakpoint
CREATE TABLE inventory_supplier_invoice_requests (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 invoice_id uuid NOT NULL,purchase_order_id uuid NOT NULL,purchase_order_version_id uuid NOT NULL,
 created_by uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
 evidence_version integer NOT NULL DEFAULT 1,request_checksum text NOT NULL,idempotency_key text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT supplier_invoice_request_id_check CHECK(substring(id::text from 15 for 1)='7'),
 CONSTRAINT supplier_invoice_request_version_check CHECK(evidence_version=1),
 CONSTRAINT supplier_invoice_request_checksum_check CHECK(request_checksum ~ '^[a-f0-9]{64}$'),
 CONSTRAINT supplier_invoice_request_key_check CHECK(length(idempotency_key) BETWEEN 8 AND 200),
 CONSTRAINT supplier_invoice_request_invoice_fk FOREIGN KEY(tenant_id,invoice_id) REFERENCES inventory_supplier_invoices(tenant_id,id) ON DELETE RESTRICT,
 CONSTRAINT supplier_invoice_request_order_fk FOREIGN KEY(tenant_id,purchase_order_id) REFERENCES inventory_purchase_orders(tenant_id,id) ON DELETE RESTRICT,
 CONSTRAINT supplier_invoice_request_version_fk FOREIGN KEY(tenant_id,purchase_order_version_id) REFERENCES inventory_purchase_order_versions(tenant_id,id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX supplier_invoice_request_invoice_unique ON inventory_supplier_invoice_requests(tenant_id,invoice_id);
CREATE UNIQUE INDEX supplier_invoice_request_key_unique ON inventory_supplier_invoice_requests(tenant_id,idempotency_key);
CREATE TABLE inventory_supplier_invoice_allocations (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 invoice_line_id uuid NOT NULL,receipt_line_id uuid NOT NULL,quantity numeric NOT NULL,unit text NOT NULL,
 created_by uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT supplier_invoice_allocation_id_check CHECK(substring(id::text from 15 for 1)='7'),
 CONSTRAINT supplier_invoice_allocation_quantity_check CHECK(quantity>0 AND procurement_quantity_valid(quantity,unit)),
 CONSTRAINT supplier_invoice_allocation_unit_check CHECK(unit IN ('each','pair','set','meter','gram','kilogram')),
 CONSTRAINT supplier_invoice_allocation_line_fk FOREIGN KEY(tenant_id,invoice_line_id) REFERENCES inventory_supplier_invoice_lines(tenant_id,id) ON DELETE RESTRICT,
 CONSTRAINT supplier_invoice_allocation_receipt_fk FOREIGN KEY(tenant_id,receipt_line_id) REFERENCES inventory_procurement_receipt_lines(tenant_id,id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX supplier_invoice_allocation_pair_unique ON inventory_supplier_invoice_allocations(tenant_id,invoice_line_id,receipt_line_id);
ALTER TABLE inventory_supplier_invoice_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_supplier_invoice_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY supplier_invoice_request_tenant ON inventory_supplier_invoice_requests FOR ALL TO yummyai_app
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE inventory_supplier_invoice_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_supplier_invoice_allocations FORCE ROW LEVEL SECURITY;
CREATE POLICY supplier_invoice_allocation_tenant ON inventory_supplier_invoice_allocations FOR ALL TO yummyai_app
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT ON inventory_supplier_invoice_requests,inventory_supplier_invoice_allocations TO yummyai_app;
--> statement-breakpoint
CREATE FUNCTION guard_supplier_invoice_creation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'supplier invoice facts are immutable' USING ERRCODE='23514'; END IF;
 IF NEW.created_by::text IS DISTINCT FROM current_setting('app.user_id',true) OR NEW.allocation_status IS NULL THEN
  RAISE EXCEPTION 'new supplier invoice requires its actual actor and allocation state' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('procurement-order:'||NEW.tenant_id::text||':'||NEW.purchase_order_id::text,0));
 NEW.creation_transaction_id:=pg_current_xact_id()::text;
 RETURN NEW;
END $$;
CREATE TRIGGER supplier_invoice_creation_guard BEFORE INSERT OR UPDATE OR DELETE ON inventory_supplier_invoices
 FOR EACH ROW EXECUTE FUNCTION guard_supplier_invoice_creation();
CREATE FUNCTION guard_supplier_invoice_evidence() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'supplier invoice evidence is immutable' USING ERRCODE='23514'; END IF;
 IF NEW.created_by::text IS DISTINCT FROM current_setting('app.user_id',true) OR NOT EXISTS(
  SELECT 1 FROM inventory_supplier_invoices i JOIN inventory_purchase_order_versions v
   ON v.tenant_id=i.tenant_id AND v.purchase_order_id=i.purchase_order_id
  WHERE i.tenant_id=NEW.tenant_id AND i.id=NEW.invoice_id AND i.purchase_order_id=NEW.purchase_order_id
   AND v.id=NEW.purchase_order_version_id AND i.created_by=NEW.created_by AND i.idempotency_key=NEW.idempotency_key
   AND i.creation_transaction_id=pg_current_xact_id()::text
 ) THEN RAISE EXCEPTION 'supplier invoice original requires its actual insert transaction and basis' USING ERRCODE='23514'; END IF;
 NEW.created_at=clock_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER supplier_invoice_evidence_guard BEFORE INSERT OR UPDATE OR DELETE ON inventory_supplier_invoice_requests
 FOR EACH ROW EXECUTE FUNCTION guard_supplier_invoice_evidence();
CREATE FUNCTION guard_supplier_invoice_line() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP<>'INSERT' OR NOT EXISTS(SELECT 1 FROM inventory_supplier_invoices i WHERE i.tenant_id=NEW.tenant_id AND i.id=NEW.invoice_id
  AND i.created_by::text=current_setting('app.user_id',true) AND i.creation_transaction_id=pg_current_xact_id()::text) THEN
  RAISE EXCEPTION 'invoice line requires its original invoice insertion' USING ERRCODE='23514'; END IF;
 IF NEW.unit IS NULL OR NEW.price_basis_quantity IS NULL THEN RAISE EXCEPTION 'invoice price unit is required' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER supplier_invoice_line_guard BEFORE INSERT OR UPDATE OR DELETE ON inventory_supplier_invoice_lines
 FOR EACH ROW EXECUTE FUNCTION guard_supplier_invoice_line();
--> statement-breakpoint
CREATE FUNCTION guard_supplier_invoice_allocation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE receipt_line inventory_procurement_receipt_lines%ROWTYPE; invoice_line inventory_supplier_invoice_lines%ROWTYPE;
 invoice_row inventory_supplier_invoices%ROWTYPE; receipt_row inventory_procurement_receipts%ROWTYPE; used numeric;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'invoice receipt allocations are immutable' USING ERRCODE='23514'; END IF;
 SELECT * INTO invoice_line FROM inventory_supplier_invoice_lines WHERE tenant_id=NEW.tenant_id AND id=NEW.invoice_line_id;
 SELECT * INTO invoice_row FROM inventory_supplier_invoices WHERE tenant_id=NEW.tenant_id AND id=invoice_line.invoice_id;
 PERFORM pg_advisory_xact_lock(hashtextextended('procurement-order:'||NEW.tenant_id::text||':'||invoice_row.purchase_order_id::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('procurement-invoice-receipt:'||NEW.tenant_id::text||':'||NEW.receipt_line_id::text,0));
 SELECT * INTO receipt_line FROM inventory_procurement_receipt_lines WHERE tenant_id=NEW.tenant_id AND id=NEW.receipt_line_id;
 SELECT * INTO receipt_row FROM inventory_procurement_receipts WHERE tenant_id=NEW.tenant_id AND id=receipt_line.receipt_id;
 IF invoice_row.id IS NULL OR receipt_line.id IS NULL OR invoice_row.creation_transaction_id IS DISTINCT FROM pg_current_xact_id()::text
  OR NEW.created_by::text IS DISTINCT FROM current_setting('app.user_id',true) OR NEW.created_by IS DISTINCT FROM invoice_row.created_by
  OR receipt_row.purchase_order_id IS DISTINCT FROM invoice_row.purchase_order_id OR receipt_line.line_key IS DISTINCT FROM invoice_line.line_key
  OR NEW.unit IS DISTINCT FROM invoice_line.unit OR NEW.unit IS DISTINCT FROM receipt_line.unit OR invoice_row.allocation_status='legacy_unknown' THEN
  RAISE EXCEPTION 'invoice allocation must retain its original receipt and purchase unit' USING ERRCODE='23514'; END IF;
 SELECT coalesce(sum(quantity),0) INTO used FROM inventory_supplier_invoice_allocations WHERE tenant_id=NEW.tenant_id AND receipt_line_id=NEW.receipt_line_id;
 IF used+NEW.quantity>receipt_line.received_quantity THEN RAISE EXCEPTION 'accepted receipt quantity already allocated' USING ERRCODE='23514'; END IF;
 SELECT coalesce(sum(quantity),0) INTO used FROM inventory_supplier_invoice_allocations WHERE tenant_id=NEW.tenant_id AND invoice_line_id=NEW.invoice_line_id;
 IF used+NEW.quantity>invoice_line.invoiced_quantity THEN RAISE EXCEPTION 'invoice allocation exceeds its recorded quantity' USING ERRCODE='23514'; END IF;
 NEW.created_at=clock_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER supplier_invoice_allocation_guard BEFORE INSERT OR UPDATE OR DELETE ON inventory_supplier_invoice_allocations
 FOR EACH ROW EXECUTE FUNCTION guard_supplier_invoice_allocation();
--> statement-breakpoint
CREATE FUNCTION require_supplier_invoice_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE proof inventory_supplier_invoice_requests%ROWTYPE; version_row inventory_purchase_order_versions%ROWTYPE;
 line_row inventory_supplier_invoice_lines%ROWTYPE; ordered jsonb; price_basis numeric; original_basis numeric;
 total numeric:=0; expected numeric:=0; amount bigint; line_expected bigint; allocated numeric;
 all_allocated boolean:=true; price_matches boolean:=true; unknown_legacy boolean; comparable boolean; lines_count integer:=0;
BEGIN
 SELECT * INTO proof FROM inventory_supplier_invoice_requests WHERE tenant_id=NEW.tenant_id AND invoice_id=NEW.id;
 SELECT * INTO version_row FROM inventory_purchase_order_versions WHERE tenant_id=NEW.tenant_id AND id=proof.purchase_order_version_id;
 IF proof.id IS NULL OR version_row.purchase_order_id IS DISTINCT FROM NEW.purchase_order_id OR proof.purchase_order_id IS DISTINCT FROM NEW.purchase_order_id
  OR proof.created_by IS DISTINCT FROM NEW.created_by OR proof.idempotency_key IS DISTINCT FROM NEW.idempotency_key
  OR NEW.creation_transaction_id IS DISTINCT FROM pg_current_xact_id()::text THEN
  RAISE EXCEPTION 'invoice and original request must commit together' USING ERRCODE='23514'; END IF;
 SELECT EXISTS(SELECT 1 FROM inventory_supplier_invoices i LEFT JOIN inventory_supplier_invoice_requests p
  ON p.tenant_id=i.tenant_id AND p.invoice_id=i.id WHERE i.tenant_id=NEW.tenant_id AND i.purchase_order_id=NEW.purchase_order_id
  AND i.id<>NEW.id AND (p.id IS NULL OR i.allocation_status IS NULL OR i.allocation_status='legacy_unknown')) INTO unknown_legacy;
 IF unknown_legacy IS DISTINCT FROM (NEW.allocation_status='legacy_unknown') THEN
  RAISE EXCEPTION 'unknown historical allocation cannot be presented as known' USING ERRCODE='23514'; END IF;
 comparable:=NOT unknown_legacy AND NEW.currency=version_row.currency;
 FOR line_row IN SELECT * FROM inventory_supplier_invoice_lines WHERE tenant_id=NEW.tenant_id AND invoice_id=NEW.id LOOP
  lines_count:=lines_count+1;
  SELECT x INTO ordered FROM jsonb_array_elements(version_row.line_snapshot) x WHERE x->>'lineKey'=line_row.line_key;
  IF ordered IS NULL OR line_row.unit IS DISTINCT FROM ordered->>'unit' THEN
   RAISE EXCEPTION 'invoice line differs from its fixed purchase version' USING ERRCODE='23514'; END IF;
  price_basis:=line_row.price_basis_quantity;
  original_basis:=procurement_json_quantity(coalesce(ordered->'priceBasisQuantity','1'::jsonb),line_row.unit,true);
  amount:=procurement_minor_amount(line_row.invoiced_quantity,line_row.unit_cost_minor,price_basis);
  total:=total+amount;
  SELECT coalesce(sum(quantity),0) INTO allocated FROM inventory_supplier_invoice_allocations WHERE tenant_id=NEW.tenant_id AND invoice_line_id=line_row.id;
  IF EXISTS(SELECT 1 FROM inventory_supplier_invoice_allocations a JOIN inventory_procurement_receipt_lines l
   ON l.tenant_id=a.tenant_id AND l.id=a.receipt_line_id JOIN inventory_procurement_receipts r ON r.tenant_id=l.tenant_id AND r.id=l.receipt_id
   WHERE a.tenant_id=NEW.tenant_id AND a.invoice_line_id=line_row.id AND (r.purchase_order_version_id<>version_row.id
    OR l.stock_item_id::text<>ordered->>'stockItemId' OR l.destination_location_id::text<>ordered->>'destinationLocationId')) THEN
   RAISE EXCEPTION 'allocation differs from the fixed receipt version or dimensions' USING ERRCODE='23514'; END IF;
  IF unknown_legacy THEN
   IF allocated<>0 OR line_row.allocated_quantity IS NOT NULL OR line_row.variance_minor IS NOT NULL THEN
    RAISE EXCEPTION 'unknown invoice allocation cannot be inferred' USING ERRCODE='23514'; END IF;
   all_allocated:=false;
  ELSE
   IF line_row.allocated_quantity IS DISTINCT FROM allocated THEN RAISE EXCEPTION 'invoice allocation projection differs from its facts' USING ERRCODE='23514'; END IF;
   IF allocated<>line_row.invoiced_quantity THEN all_allocated:=false; END IF;
   IF comparable THEN
    line_expected:=procurement_minor_amount(allocated,(ordered->>'unitCostMinor')::bigint,original_basis);
    IF line_row.variance_minor IS DISTINCT FROM (amount-line_expected) THEN RAISE EXCEPTION 'invoice variance differs from allocated cost' USING ERRCODE='23514'; END IF;
    expected:=expected+line_expected;
   ELSIF line_row.variance_minor IS NOT NULL THEN RAISE EXCEPTION 'different currencies have no comparable minor variance' USING ERRCODE='23514'; END IF;
  END IF;
  IF line_row.unit_cost_minor::numeric*original_basis<>(ordered->>'unitCostMinor')::numeric*price_basis THEN price_matches:=false; END IF;
 END LOOP;
 IF lines_count=0 OR total>9007199254740991 OR NEW.total_minor IS DISTINCT FROM total THEN
  RAISE EXCEPTION 'invoice total differs from exact recorded lines' USING ERRCODE='23514'; END IF;
 IF comparable THEN
  IF abs(total-expected)>9007199254740991 OR NEW.variance_minor IS DISTINCT FROM total-expected THEN RAISE EXCEPTION 'invoice total variance differs' USING ERRCODE='23514'; END IF;
 ELSIF NEW.variance_minor IS NOT NULL THEN RAISE EXCEPTION 'unknown invoice variance must remain null' USING ERRCODE='23514'; END IF;
 IF (NOT unknown_legacy AND NEW.allocation_status IS DISTINCT FROM (CASE WHEN all_allocated THEN 'complete' ELSE 'reconciliation_required' END))
  OR NEW.status IS DISTINCT FROM (CASE WHEN comparable AND all_allocated AND price_matches THEN 'matched' ELSE 'reconciliation_required' END) THEN
  RAISE EXCEPTION 'invoice status cannot manufacture quantity or money reconciliation' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER supplier_invoice_complete_required AFTER INSERT ON inventory_supplier_invoices
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_supplier_invoice_complete();
REVOKE ALL ON FUNCTION guard_supplier_invoice_creation(),guard_supplier_invoice_evidence(),guard_supplier_invoice_line(),
 guard_supplier_invoice_allocation(),require_supplier_invoice_complete() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION guard_procurement_measurement_snapshot() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE line jsonb; original jsonb; stock_unit text; u text; q numeric; basis numeric; cost bigint; total numeric:=0;
 numerator text; denominator text; factor numeric; rfq_row inventory_procurement_rfqs%ROWTYPE; request_lines jsonb;
BEGIN
 IF TG_TABLE_NAME='product_supply_versions' THEN
  u:=NEW.terms->>'purchaseUnit';
  IF u IS NULL AND NEW.stock_item_id IS NOT NULL THEN SELECT base_unit INTO u FROM inventory_stock_items WHERE tenant_id=NEW.tenant_id AND id=NEW.stock_item_id; END IF;
  -- An unbound legacy supply without an explicit purchase unit cannot invent a conversion.
  IF u IS NULL THEN
   IF NEW.terms ? 'purchaseUnit' OR NEW.terms ? 'priceBasisQuantity' THEN RAISE EXCEPTION 'supply price unit is unavailable' USING ERRCODE='23514'; END IF;
   RETURN NEW;
  END IF;
  PERFORM procurement_json_quantity(NEW.terms->'minimumOrderQuantity',u,true);
  PERFORM procurement_json_quantity(coalesce(NEW.terms->'priceBasisQuantity','1'::jsonb),u,true);
  IF NEW.stock_item_id IS NOT NULL THEN
   SELECT base_unit INTO stock_unit FROM inventory_stock_items WHERE tenant_id=NEW.tenant_id AND id=NEW.stock_item_id;
   PERFORM procurement_convert_quantity(procurement_json_quantity(NEW.terms->'minimumOrderQuantity',u,true),u,stock_unit);
   PERFORM procurement_convert_quantity(procurement_json_quantity(coalesce(NEW.terms->'priceBasisQuantity','1'::jsonb),u,true),u,stock_unit);
  END IF;
  RETURN NEW;
 END IF;
 IF TG_TABLE_NAME='inventory_supplier_quote_versions' THEN
  SELECT * INTO rfq_row FROM inventory_procurement_rfqs WHERE tenant_id=NEW.tenant_id AND id=NEW.rfq_id;
  SELECT line_snapshot INTO request_lines FROM inventory_procurement_requisition_versions WHERE tenant_id=NEW.tenant_id AND id=rfq_row.requisition_version_id;
 END IF;
 FOR line IN SELECT * FROM jsonb_array_elements(NEW.line_snapshot) LOOP
  IF TG_TABLE_NAME='inventory_supplier_quote_versions' THEN
   SELECT x INTO original FROM jsonb_array_elements(request_lines) x WHERE x->>'lineKey'=line->>'lineKey';
   IF original IS NULL THEN RAISE EXCEPTION 'quote line has no original requisition' USING ERRCODE='23514'; END IF;
   u:=original->>'unit';
   IF line ? 'unit' AND line->>'unit' IS DISTINCT FROM u THEN RAISE EXCEPTION 'quote unit differs from fixed requisition' USING ERRCODE='23514'; END IF;
   q:=procurement_json_quantity(original->'quantity',u,true);
   q:=greatest(q,procurement_json_quantity(line->'minimumOrderQuantity',u,true));
  ELSE
   u:=line->>'unit'; q:=procurement_json_quantity(line->'quantity',u,true);
  END IF;
  IF TG_TABLE_NAME IN ('inventory_purchase_order_versions','inventory_supplier_quote_versions') THEN
   basis:=procurement_json_quantity(coalesce(line->'priceBasisQuantity','1'::jsonb),u,true);
   IF jsonb_typeof(line->'unitCostMinor') IS DISTINCT FROM 'number' OR line->>'unitCostMinor' !~ '^[0-9]+$'
    OR length(line->>'unitCostMinor')>16 THEN RAISE EXCEPTION 'invalid exact procurement price' USING ERRCODE='23514'; END IF;
   cost:=(line->>'unitCostMinor')::bigint; total:=total+procurement_minor_amount(q,cost,basis);
  END IF;
  IF TG_TABLE_NAME='inventory_purchase_order_versions' THEN
   SELECT base_unit INTO stock_unit FROM inventory_stock_items WHERE tenant_id=NEW.tenant_id AND id=(line->>'stockItemId')::uuid;
   IF stock_unit IS NULL THEN RAISE EXCEPTION 'purchase line stock basis missing' USING ERRCODE='23514'; END IF;
   IF line ? 'stockBasis' THEN
    factor:=procurement_unit_factor(u,stock_unit);
    numerator:=CASE WHEN factor=1000 THEN '1000' ELSE '1' END;
    denominator:=CASE WHEN factor=0.001 THEN '1000' ELSE '1' END;
    IF line->'stockBasis'->>'version' IS DISTINCT FROM '1' OR line->'stockBasis'->>'rule' IS DISTINCT FROM 'metric-unit-v1'
     OR line->'stockBasis'->>'stockUnit' IS DISTINCT FROM stock_unit
     OR line->'stockBasis'->>'conversionNumerator' IS DISTINCT FROM numerator OR line->'stockBasis'->>'conversionDenominator' IS DISTINCT FROM denominator
     OR procurement_json_quantity(line->'stockBasis'->'stockQuantity',stock_unit,true)<>procurement_convert_quantity(q,u,stock_unit)
     OR procurement_json_quantity(line->'stockBasis'->'priceBasisStockQuantity',stock_unit,true)<>procurement_convert_quantity(basis,u,stock_unit) THEN
     RAISE EXCEPTION 'purchase stock and price basis differs from exact pinned conversion' USING ERRCODE='23514'; END IF;
   ELSIF u<>stock_unit THEN RAISE EXCEPTION 'legacy purchase has no unit conversion basis' USING ERRCODE='23514'; END IF;
  END IF;
 END LOOP;
 IF TG_TABLE_NAME IN ('inventory_purchase_order_versions','inventory_supplier_quote_versions') THEN
  IF total>9007199254740991 OR total IS DISTINCT FROM NEW.total_minor::numeric THEN
   RAISE EXCEPTION 'procurement total differs from exact line pricing' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER procurement_requisition_measurement_guard BEFORE INSERT ON inventory_procurement_requisition_versions FOR EACH ROW EXECUTE FUNCTION guard_procurement_measurement_snapshot();
CREATE TRIGGER procurement_quote_measurement_guard BEFORE INSERT ON inventory_supplier_quote_versions FOR EACH ROW EXECUTE FUNCTION guard_procurement_measurement_snapshot();
CREATE TRIGGER procurement_order_measurement_guard BEFORE INSERT ON inventory_purchase_order_versions FOR EACH ROW EXECUTE FUNCTION guard_procurement_measurement_snapshot();
CREATE TRIGGER procurement_supply_measurement_guard BEFORE INSERT ON product_supply_versions FOR EACH ROW EXECUTE FUNCTION guard_procurement_measurement_snapshot();
REVOKE ALL ON FUNCTION guard_procurement_measurement_snapshot() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION guard_procurement_receipt_measurement() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE original jsonb; original_unit text; base_unit text; basis numeric; stock_received numeric; stock_rejected numeric;
 receipt_row inventory_procurement_receipts%ROWTYPE; lot_row inventory_lots%ROWTYPE;
BEGIN
 SELECT * INTO receipt_row FROM inventory_procurement_receipts WHERE tenant_id=NEW.tenant_id AND id=NEW.receipt_id;
 SELECT x INTO original FROM inventory_purchase_order_versions v,jsonb_array_elements(v.line_snapshot)x
  WHERE v.tenant_id=NEW.tenant_id AND v.id=receipt_row.purchase_order_version_id AND x->>'lineKey'=NEW.line_key;
 SELECT s.base_unit INTO base_unit FROM inventory_stock_items s WHERE s.tenant_id=NEW.tenant_id AND s.id=NEW.stock_item_id;
 original_unit:=original->>'unit';
 IF original IS NULL OR original->>'stockItemId' IS DISTINCT FROM NEW.stock_item_id::text
  OR original->>'destinationLocationId' IS DISTINCT FROM NEW.destination_location_id::text OR NEW.unit IS DISTINCT FROM original_unit
  OR (original->>'unitCostMinor')::numeric IS DISTINCT FROM NEW.unit_cost_minor::numeric THEN
  RAISE EXCEPTION 'receipt must retain its original purchase dimensions and price' USING ERRCODE='23514'; END IF;
 basis:=procurement_json_quantity(coalesce(original->'priceBasisQuantity','1'::jsonb),NEW.unit,true);
 IF NEW.price_basis_quantity IS NULL AND NEW.stock_unit IS NULL AND NEW.stock_received_quantity IS NULL AND NEW.stock_rejected_quantity IS NULL THEN
  IF NEW.unit IS DISTINCT FROM base_unit OR original ? 'stockBasis' OR basis<>1 THEN
   RAISE EXCEPTION 'receipt has no fixed stock conversion evidence' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 stock_received:=procurement_convert_quantity(NEW.received_quantity,NEW.unit,base_unit);
 stock_rejected:=procurement_convert_quantity(NEW.rejected_quantity,NEW.unit,base_unit);
 IF NEW.price_basis_quantity IS DISTINCT FROM basis OR NEW.stock_unit IS DISTINCT FROM base_unit
  OR NEW.stock_received_quantity IS DISTINCT FROM stock_received OR NEW.stock_rejected_quantity IS DISTINCT FROM stock_rejected
  OR (NEW.unit<>base_unit AND (original->'stockBasis'->>'stockUnit' IS DISTINCT FROM base_unit
   OR original->'stockBasis'->>'rule' IS DISTINCT FROM 'metric-unit-v1')) THEN
  RAISE EXCEPTION 'receipt stock quantities differ from their exact purchase conversion' USING ERRCODE='23514'; END IF;
 IF stock_received>0 THEN
  SELECT * INTO lot_row FROM inventory_lots WHERE tenant_id=NEW.tenant_id AND id=NEW.lot_id;
  IF lot_row.id IS NULL OR lot_row.stock_item_id<>NEW.stock_item_id OR lot_row.unit_cost_minor IS DISTINCT FROM NEW.unit_cost_minor
   OR lot_row.unit_cost_currency IS DISTINCT FROM (SELECT currency FROM inventory_purchase_order_versions WHERE tenant_id=NEW.tenant_id AND id=receipt_row.purchase_order_version_id)
   OR lot_row.unit_cost_quantity IS DISTINCT FROM procurement_convert_quantity(basis,NEW.unit,base_unit)
   OR lot_row.source_type<>'receipt' OR lot_row.source_id<>NEW.receipt_id::text
   OR NOT EXISTS(SELECT 1 FROM inventory_movements m WHERE m.tenant_id=NEW.tenant_id AND m.id=NEW.movement_id
    AND m.stock_item_id=NEW.stock_item_id AND m.lot_id=NEW.lot_id AND m.location_id=NEW.destination_location_id
    AND m.unit=base_unit AND m.quantity_delta=stock_received AND m.source_type='receipt' AND m.source_id=NEW.receipt_id::text
    AND m.type='receipt' AND m.bucket='physical') THEN
   RAISE EXCEPTION 'receipt stock movement or lot price basis is not its actual stock fact' USING ERRCODE='23514'; END IF;
 ELSIF NEW.lot_id IS NOT NULL OR NEW.movement_id IS NOT NULL THEN RAISE EXCEPTION 'rejected stock cannot enter accepted inventory' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER procurement_receipt_measurement_guard BEFORE INSERT ON inventory_procurement_receipt_lines FOR EACH ROW EXECUTE FUNCTION guard_procurement_receipt_measurement();
CREATE FUNCTION guard_procurement_stock_quantities() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE u text;
BEGIN
 IF TG_TABLE_NAME='inventory_lots' THEN
  IF NEW.unit_cost_quantity IS NULL THEN RETURN NEW; END IF;
  SELECT base_unit INTO u FROM inventory_stock_items WHERE tenant_id=NEW.tenant_id AND id=NEW.stock_item_id;
  IF NEW.unit_cost_quantity<=0 OR NOT procurement_quantity_valid(NEW.unit_cost_quantity,u) OR NEW.unit_cost_minor IS NULL THEN
   RAISE EXCEPTION 'lot cost basis must retain its actual stock unit' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='inventory_replenishment_policy_versions' THEN
  SELECT s.base_unit INTO u FROM inventory_replenishment_policies p JOIN inventory_stock_items s ON s.tenant_id=p.tenant_id AND s.id=p.stock_item_id
   WHERE p.tenant_id=NEW.tenant_id AND p.id=NEW.policy_id;
  IF NOT procurement_quantity_valid(NEW.reorder_point,u) OR NOT procurement_quantity_valid(NEW.safety_stock,u)
   OR NOT procurement_quantity_valid(NEW.minimum_order_quantity,u) THEN RAISE EXCEPTION 'replenishment policy requires exact stock quantities' USING ERRCODE='23514'; END IF;
 ELSE
  SELECT base_unit INTO u FROM inventory_stock_items WHERE tenant_id=NEW.tenant_id AND id=NEW.stock_item_id;
  IF NOT procurement_quantity_valid(NEW.suggested_quantity,u) THEN RAISE EXCEPTION 'replenishment suggestion requires exact stock quantities' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER procurement_lot_cost_basis_guard BEFORE INSERT OR UPDATE ON inventory_lots FOR EACH ROW EXECUTE FUNCTION guard_procurement_stock_quantities();
CREATE TRIGGER procurement_policy_quantity_guard BEFORE INSERT ON inventory_replenishment_policy_versions FOR EACH ROW EXECUTE FUNCTION guard_procurement_stock_quantities();
CREATE TRIGGER procurement_suggestion_quantity_guard BEFORE INSERT OR UPDATE ON inventory_replenishment_suggestions FOR EACH ROW EXECUTE FUNCTION guard_procurement_stock_quantities();
REVOKE ALL ON FUNCTION guard_procurement_receipt_measurement(),guard_procurement_stock_quantities() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION procurement_incoming_unit_valid(original jsonb,q numeric,u text) RETURNS boolean
 LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
BEGIN
 IF NOT procurement_quantity_valid(q,u) THEN
  RAISE EXCEPTION 'incoming arrival quantity cannot be represented exactly'
   USING ERRCODE='23514',CONSTRAINT='procurement_arrival_lines_quantity_check';
 END IF;
 IF NOT (original ? 'stockBasis') THEN RETURN original->>'unit'=u; END IF;
 IF original->'stockBasis'->>'version' IS DISTINCT FROM '1' OR original->'stockBasis'->>'rule' IS DISTINCT FROM 'metric-unit-v1' THEN RETURN false; END IF;
 PERFORM procurement_convert_quantity(q,u,original->>'unit');
 PERFORM procurement_convert_quantity(q,u,original->'stockBasis'->>'stockUnit');
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION procurement_incoming_unit_valid(jsonb,numeric,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION procurement_incoming_unit_valid(jsonb,numeric,text) TO yummyai_app;

--> statement-breakpoint
-- 0144 guard preserved; only exact purchase/stock comparisons updated.
CREATE OR REPLACE FUNCTION guard_incoming_fact() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE line_row inventory_procurement_arrival_lines%ROWTYPE; arrival_row inventory_procurement_arrivals%ROWTYPE;
 inspection_row inventory_incoming_inspections%ROWTYPE; standard_row inventory_incoming_standards%ROWTYPE;
 review_row inventory_incoming_inspection_reviews%ROWTYPE; posting_row inventory_incoming_postings%ROWTYPE;
 receipt_row inventory_procurement_receipts%ROWTYPE; order_line jsonb;
 expected_version integer; used_accepted numeric; used_rejected numeric; used_returned numeric; result jsonb;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'incoming facts are immutable' USING ERRCODE='23514'; END IF;
 IF substring(NEW.id::text from 15 for 1)<>'7' OR NEW.created_by::text IS DISTINCT FROM current_setting('app.user_id',true) THEN
  RAISE EXCEPTION 'incoming fact requires its actual actor' USING ERRCODE='23514';
 END IF;
 IF TG_TABLE_NAME<>'inventory_procurement_arrival_lines' THEN
  IF NEW.request_checksum !~ '^[a-f0-9]{64}$' OR length(NEW.idempotency_key) NOT BETWEEN 8 AND 200 THEN
   RAISE EXCEPTION 'incoming original request missing' USING ERRCODE='23514';
  END IF;
 END IF;
 NEW.created_at=clock_timestamp();
 IF TG_TABLE_NAME IN ('inventory_incoming_standards','inventory_procurement_arrivals') THEN
  IF NEW.code !~ '^[A-Z0-9][A-Z0-9._-]{0,63}$' THEN
   RAISE EXCEPTION 'incoming business code invalid' USING ERRCODE='23514'; END IF;
 END IF;
 IF TG_TABLE_NAME='inventory_incoming_standards' THEN
  PERFORM 1 FROM inventory_stock_items WHERE tenant_id=NEW.tenant_id AND id=NEW.stock_item_id FOR UPDATE;
  SELECT coalesce(max(version_number),0)+1 INTO expected_version FROM inventory_incoming_standards
   WHERE tenant_id=NEW.tenant_id AND stock_item_id=NEW.stock_item_id AND code=NEW.code;
  IF NEW.version_number<>expected_version OR length(btrim(NEW.title)) NOT BETWEEN 1 AND 160
  OR length(btrim(NEW.source_reference)) NOT BETWEEN 1 AND 2000 THEN
   RAISE EXCEPTION 'incoming standard revision or source invalid' USING ERRCODE='23514'; END IF;
  PERFORM evaluate_incoming_readings(NEW.criteria,'[]'::jsonb);
 ELSIF TG_TABLE_NAME='inventory_procurement_arrivals' THEN
  PERFORM 1 FROM inventory_purchase_orders WHERE tenant_id=NEW.tenant_id AND id=NEW.purchase_order_id FOR UPDATE;
  IF NOT EXISTS(SELECT 1 FROM inventory_purchase_orders p JOIN inventory_purchase_order_versions v ON v.tenant_id=p.tenant_id AND v.purchase_order_id=p.id
   WHERE p.tenant_id=NEW.tenant_id AND p.id=NEW.purchase_order_id AND v.id=NEW.purchase_order_version_id
   AND p.current_version=v.version_number AND p.archived_at IS NULL AND p.status IN ('approved','partially_received','reconciliation_required','received'))
  OR length(btrim(NEW.external_reference)) NOT BETWEEN 1 AND 2000 OR NEW.arrived_at>clock_timestamp() THEN
   RAISE EXCEPTION 'arrival requires its actual approved purchase basis' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='inventory_procurement_arrival_lines' THEN
  SELECT * INTO arrival_row FROM inventory_procurement_arrivals WHERE tenant_id=NEW.tenant_id AND id=NEW.arrival_id;
  SELECT x INTO order_line FROM inventory_purchase_order_versions v, jsonb_array_elements(v.line_snapshot) x
   WHERE v.tenant_id=NEW.tenant_id AND v.id=arrival_row.purchase_order_version_id AND x->>'lineKey'=NEW.line_key;
  IF order_line IS NULL OR order_line->>'stockItemId'<>NEW.stock_item_id::text OR procurement_incoming_unit_valid(order_line,NEW.quantity,NEW.unit) IS DISTINCT FROM true
  OR arrival_row.created_by IS DISTINCT FROM NEW.created_by OR NOT EXISTS(
   SELECT 1 FROM inventory_procurement_arrivals a WHERE a.id=NEW.arrival_id AND a.tenant_id=NEW.tenant_id
   AND a.xmin::text=mod(pg_current_xact_id()::text::numeric,4294967296)::bigint::text)
  OR length(btrim(NEW.supplier_lot_code)) NOT BETWEEN 1 AND 200 THEN
   RAISE EXCEPTION 'arrival line must retain its original stock and unit' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='inventory_incoming_inspections' THEN
  PERFORM lock_incoming_line(NEW.tenant_id,NEW.arrival_line_id);
  SELECT * INTO line_row FROM inventory_procurement_arrival_lines WHERE tenant_id=NEW.tenant_id AND id=NEW.arrival_line_id;
  PERFORM 1 FROM inventory_stock_items WHERE tenant_id=NEW.tenant_id AND id=line_row.stock_item_id FOR UPDATE;
  SELECT * INTO arrival_row FROM inventory_procurement_arrivals WHERE tenant_id=NEW.tenant_id AND id=line_row.arrival_id;
  SELECT * INTO standard_row FROM inventory_incoming_standards WHERE tenant_id=NEW.tenant_id AND id=NEW.standard_version_id;
  SELECT coalesce(max(version_number),0)+1 INTO expected_version FROM inventory_incoming_inspections WHERE tenant_id=NEW.tenant_id AND arrival_line_id=NEW.arrival_line_id;
  SELECT coalesce(sum(accepted_quantity),0),coalesce(sum(rejected_quantity),0) INTO used_accepted,used_rejected
   FROM inventory_incoming_postings WHERE tenant_id=NEW.tenant_id AND arrival_line_id=NEW.arrival_line_id;
  IF line_row.id IS NULL OR standard_row.id IS NULL OR standard_row.stock_item_id<>line_row.stock_item_id OR NEW.unit<>line_row.unit
  OR NEW.version_number<>expected_version OR NEW.accepted_quantity+NEW.rejected_quantity>line_row.quantity-used_accepted-used_rejected
  OR standard_row.version_number<>(SELECT max(version_number) FROM inventory_incoming_standards WHERE tenant_id=NEW.tenant_id AND stock_item_id=standard_row.stock_item_id AND code=standard_row.code)
  OR NEW.measured_at<arrival_row.arrived_at OR NEW.measured_at>clock_timestamp()
  OR (NEW.version_number>1 AND coalesce(length(btrim(NEW.notes)),0)=0) THEN
   RAISE EXCEPTION 'incoming inspection basis, remaining quantity or revision changed' USING ERRCODE='23514'; END IF;
  NEW.evaluation=evaluate_incoming_readings(standard_row.criteria,NEW.readings);
 ELSIF TG_TABLE_NAME='inventory_incoming_inspection_reviews' THEN
  SELECT * INTO inspection_row FROM inventory_incoming_inspections WHERE tenant_id=NEW.tenant_id AND id=NEW.inspection_id;
  PERFORM lock_incoming_line(NEW.tenant_id,inspection_row.arrival_line_id);
  IF inspection_row.id IS NULL OR inspection_row.version_number<>(SELECT max(version_number) FROM inventory_incoming_inspections WHERE tenant_id=NEW.tenant_id AND arrival_line_id=inspection_row.arrival_line_id)
  OR length(btrim(NEW.reason)) NOT BETWEEN 1 AND 2000 THEN
   RAISE EXCEPTION 'inspection review must retain the current original inspection' USING ERRCODE='23514'; END IF;
  IF NEW.decision='approved' AND ((inspection_row.evaluation->>'complete')::boolean IS DISTINCT FROM true
   OR (inspection_row.accepted_quantity>0 AND (inspection_row.evaluation->>'passed')::boolean IS DISTINCT FROM true)) THEN
   RAISE EXCEPTION 'missing or failing measurements cannot approve accepted stock' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='inventory_incoming_postings' THEN
  PERFORM lock_incoming_line(NEW.tenant_id,NEW.arrival_line_id);
  SELECT * INTO line_row FROM inventory_procurement_arrival_lines WHERE tenant_id=NEW.tenant_id AND id=NEW.arrival_line_id;
  SELECT * INTO arrival_row FROM inventory_procurement_arrivals WHERE tenant_id=NEW.tenant_id AND id=line_row.arrival_id;
  SELECT * INTO review_row FROM inventory_incoming_inspection_reviews WHERE tenant_id=NEW.tenant_id AND id=NEW.approval_id;
  SELECT * INTO inspection_row FROM inventory_incoming_inspections WHERE tenant_id=NEW.tenant_id AND id=review_row.inspection_id;
  SELECT * INTO receipt_row FROM inventory_procurement_receipts WHERE tenant_id=NEW.tenant_id AND id=NEW.receipt_id;
  IF line_row.id IS NULL OR review_row.decision IS DISTINCT FROM 'approved' OR inspection_row.arrival_line_id<>NEW.arrival_line_id
  OR NEW.unit<>line_row.unit OR inspection_row.version_number<>(SELECT max(version_number) FROM inventory_incoming_inspections WHERE tenant_id=NEW.tenant_id AND arrival_line_id=NEW.arrival_line_id)
  OR receipt_row.purchase_order_id IS DISTINCT FROM arrival_row.purchase_order_id OR receipt_row.purchase_order_version_id IS DISTINCT FROM arrival_row.purchase_order_version_id
  OR receipt_row.created_by IS DISTINCT FROM NEW.created_by OR receipt_row.idempotency_key IS DISTINCT FROM NEW.idempotency_key
  OR NOT EXISTS(SELECT 1 FROM inventory_purchase_orders p JOIN inventory_purchase_order_versions v ON v.purchase_order_id=p.id AND v.tenant_id=p.tenant_id
   WHERE p.tenant_id=NEW.tenant_id AND p.id=arrival_row.purchase_order_id AND v.id=arrival_row.purchase_order_version_id AND v.version_number=p.current_version)
  OR NOT EXISTS(SELECT 1 FROM inventory_procurement_receipts r WHERE r.id=NEW.receipt_id AND r.tenant_id=NEW.tenant_id
   AND r.xmin::text=mod(pg_current_xact_id()::text::numeric,4294967296)::bigint::text)
  OR (SELECT count(*) FROM inventory_procurement_receipt_lines WHERE tenant_id=NEW.tenant_id AND receipt_id=NEW.receipt_id)<>1
  OR NOT EXISTS(SELECT 1 FROM inventory_procurement_receipt_lines l WHERE l.tenant_id=NEW.tenant_id AND l.receipt_id=NEW.receipt_id
   AND l.line_key=line_row.line_key AND l.stock_item_id=line_row.stock_item_id
   AND l.unit=(SELECT x->>'unit' FROM inventory_purchase_order_versions v,jsonb_array_elements(v.line_snapshot)x WHERE v.tenant_id=NEW.tenant_id AND v.id=arrival_row.purchase_order_version_id AND x->>'lineKey'=line_row.line_key)
   AND l.received_quantity=procurement_convert_quantity(NEW.accepted_quantity,NEW.unit,l.unit)
   AND l.rejected_quantity=procurement_convert_quantity(NEW.rejected_quantity,NEW.unit,l.unit)
   AND l.destination_location_id=(SELECT (x->>'destinationLocationId')::uuid FROM inventory_purchase_order_versions v,
     jsonb_array_elements(v.line_snapshot) x WHERE v.tenant_id=NEW.tenant_id AND v.id=arrival_row.purchase_order_version_id AND x->>'lineKey'=line_row.line_key)
   AND ((NEW.accepted_quantity=0 AND l.lot_id IS NULL AND l.movement_id IS NULL) OR (NEW.accepted_quantity>0 AND EXISTS(
    SELECT 1 FROM inventory_movements m JOIN inventory_lots b ON b.tenant_id=m.tenant_id AND b.id=m.lot_id
    WHERE m.tenant_id=NEW.tenant_id AND m.id=l.movement_id AND m.lot_id=l.lot_id AND m.stock_item_id=l.stock_item_id
    AND m.location_id=l.destination_location_id AND m.unit=coalesce(l.stock_unit,l.unit)
    AND m.quantity_delta=procurement_convert_quantity(NEW.accepted_quantity,NEW.unit,coalesce(l.stock_unit,l.unit))
    AND m.type='receipt' AND m.bucket='physical' AND m.source_type='receipt' AND m.source_id=NEW.receipt_id::text
    AND b.stock_item_id=line_row.stock_item_id AND b.source_type='receipt' AND b.source_id=NEW.receipt_id::text))))
  OR NEW.posted_at<inspection_row.measured_at OR NEW.posted_at>clock_timestamp()
  OR (NEW.accepted_quantity>0 AND line_row.expires_at IS NOT NULL AND line_row.expires_at<=NEW.posted_at) THEN
   RAISE EXCEPTION 'incoming posting requires its actual approval and same-transaction receipt' USING ERRCODE='23514'; END IF;
  SELECT coalesce(sum(accepted_quantity),0),coalesce(sum(rejected_quantity),0) INTO used_accepted,used_rejected
   FROM inventory_incoming_postings WHERE tenant_id=NEW.tenant_id AND approval_id=NEW.approval_id;
  IF NEW.accepted_quantity+used_accepted>inspection_row.accepted_quantity OR NEW.rejected_quantity+used_rejected>inspection_row.rejected_quantity THEN
   RAISE EXCEPTION 'incoming disposition exceeds its approved remainder' USING ERRCODE='23514'; END IF;
  SELECT coalesce(sum(accepted_quantity+rejected_quantity),0) INTO used_accepted FROM inventory_incoming_postings WHERE tenant_id=NEW.tenant_id AND arrival_line_id=NEW.arrival_line_id;
  IF used_accepted+NEW.accepted_quantity+NEW.rejected_quantity>line_row.quantity THEN
   RAISE EXCEPTION 'incoming disposition exceeds actual arrival' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='inventory_incoming_returns' THEN
  SELECT * INTO posting_row FROM inventory_incoming_postings WHERE tenant_id=NEW.tenant_id AND id=NEW.posting_id;
  PERFORM lock_incoming_line(NEW.tenant_id,posting_row.arrival_line_id);
  SELECT coalesce(sum(quantity),0) INTO used_returned FROM inventory_incoming_returns WHERE tenant_id=NEW.tenant_id AND posting_id=NEW.posting_id;
  IF posting_row.id IS NULL OR NEW.unit<>posting_row.unit OR used_returned+NEW.quantity>posting_row.rejected_quantity
  OR NEW.returned_at<posting_row.posted_at OR NEW.returned_at>clock_timestamp()
  OR length(btrim(NEW.external_reference)) NOT BETWEEN 1 AND 2000 OR length(btrim(NEW.reason)) NOT BETWEEN 1 AND 2000 THEN
   RAISE EXCEPTION 'return exceeds rejected custody or lacks its actual evidence' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_incoming_fact() FROM PUBLIC;
