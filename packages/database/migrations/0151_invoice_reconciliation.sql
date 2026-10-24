-- Append financial corrections and later receipt matching. Never rewrite 0149 facts or stock.
CREATE UNIQUE INDEX supplier_invoice_allocation_scope ON inventory_supplier_invoice_allocations(tenant_id,id);
CREATE TABLE inventory_invoice_reconciliations (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), invoice_id uuid NOT NULL, original_proof_id uuid NOT NULL,
 purchase_order_id uuid NOT NULL, purchase_order_version_id uuid NOT NULL, supplier_id uuid NOT NULL,
 sequence integer NOT NULL CHECK(sequence>0), previous_id uuid, adjustment_id uuid, action text NOT NULL,
 input jsonb NOT NULL, balance jsonb NOT NULL, document_key text, request_key text NOT NULL, request_checksum text NOT NULL,
 created_by uuid NOT NULL REFERENCES app_users(id), creation_transaction_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT invoice_reconciliation_invoice_fk FOREIGN KEY(tenant_id,invoice_id) REFERENCES inventory_supplier_invoices(tenant_id,id),
 CONSTRAINT invoice_reconciliation_original_fk FOREIGN KEY(tenant_id,original_proof_id) REFERENCES inventory_supplier_invoice_requests(tenant_id,id),
 CONSTRAINT invoice_reconciliation_order_fk FOREIGN KEY(tenant_id,purchase_order_id) REFERENCES inventory_purchase_orders(tenant_id,id),
 CONSTRAINT invoice_reconciliation_version_fk FOREIGN KEY(tenant_id,purchase_order_version_id) REFERENCES inventory_purchase_order_versions(tenant_id,id),
 CONSTRAINT invoice_reconciliation_action CHECK(action IN ('adjustment_record','adjustment_review','receipt_match')),
 CONSTRAINT invoice_reconciliation_checksum CHECK(substring(id::text from 15 for 1)='7' AND request_checksum~'^[a-f0-9]{64}$' AND length(request_key) BETWEEN 8 AND 200)
);
CREATE UNIQUE INDEX invoice_reconciliation_scope ON inventory_invoice_reconciliations(tenant_id,id);
CREATE UNIQUE INDEX invoice_reconciliation_key ON inventory_invoice_reconciliations(tenant_id,request_key);
CREATE UNIQUE INDEX invoice_reconciliation_sequence ON inventory_invoice_reconciliations(tenant_id,invoice_id,sequence);
CREATE UNIQUE INDEX invoice_reconciliation_review ON inventory_invoice_reconciliations(tenant_id,adjustment_id) WHERE adjustment_id IS NOT NULL;
CREATE UNIQUE INDEX invoice_reconciliation_document ON inventory_invoice_reconciliations(tenant_id,supplier_id,document_key) WHERE document_key IS NOT NULL;
ALTER TABLE inventory_invoice_reconciliations ADD CONSTRAINT invoice_reconciliation_previous_fk FOREIGN KEY(tenant_id,previous_id) REFERENCES inventory_invoice_reconciliations(tenant_id,id),
 ADD CONSTRAINT invoice_reconciliation_adjustment_fk FOREIGN KEY(tenant_id,adjustment_id) REFERENCES inventory_invoice_reconciliations(tenant_id,id);
CREATE TABLE inventory_invoice_allocation_effects (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), event_id uuid NOT NULL,
 invoice_line_id uuid NOT NULL, receipt_line_id uuid NOT NULL, kind text NOT NULL, quantity numeric NOT NULL, unit text NOT NULL,
 source_allocation_id uuid, source_effect_id uuid, created_by uuid NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT invoice_effect_event_fk FOREIGN KEY(tenant_id,event_id) REFERENCES inventory_invoice_reconciliations(tenant_id,id),
 CONSTRAINT invoice_effect_line_fk FOREIGN KEY(tenant_id,invoice_line_id) REFERENCES inventory_supplier_invoice_lines(tenant_id,id),
 CONSTRAINT invoice_effect_receipt_fk FOREIGN KEY(tenant_id,receipt_line_id) REFERENCES inventory_procurement_receipt_lines(tenant_id,id),
 CONSTRAINT invoice_effect_source_fk FOREIGN KEY(tenant_id,source_allocation_id) REFERENCES inventory_supplier_invoice_allocations(tenant_id,id),
 CONSTRAINT invoice_effect_quantity CHECK(quantity>0 AND quantity<=2147483647 AND scale(quantity)<=9 AND (unit NOT IN ('each','pair','set') OR trunc(quantity)=quantity)),
 CONSTRAINT invoice_effect_kind CHECK(substring(id::text from 15 for 1)='7' AND unit IN ('each','pair','set','meter','gram','kilogram') AND kind IN ('consume','release')
  AND CASE WHEN kind='consume' THEN source_allocation_id IS NULL AND source_effect_id IS NULL ELSE (source_allocation_id IS NULL)<>(source_effect_id IS NULL) END)
);
CREATE UNIQUE INDEX invoice_allocation_effect_scope ON inventory_invoice_allocation_effects(tenant_id,id);
ALTER TABLE inventory_invoice_allocation_effects ADD CONSTRAINT invoice_effect_source_effect_fk FOREIGN KEY(tenant_id,source_effect_id) REFERENCES inventory_invoice_allocation_effects(tenant_id,id);
ALTER TABLE inventory_invoice_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_invoice_reconciliations FORCE ROW LEVEL SECURITY;
CREATE POLICY invoice_reconciliation_tenant ON inventory_invoice_reconciliations USING(tenant_id=current_setting('app.tenant_id',true)::uuid) WITH CHECK(tenant_id=current_setting('app.tenant_id',true)::uuid);
ALTER TABLE inventory_invoice_allocation_effects ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_invoice_allocation_effects FORCE ROW LEVEL SECURITY;
CREATE POLICY invoice_effect_tenant ON inventory_invoice_allocation_effects USING(tenant_id=current_setting('app.tenant_id',true)::uuid) WITH CHECK(tenant_id=current_setting('app.tenant_id',true)::uuid);
GRANT SELECT,INSERT ON inventory_invoice_reconciliations,inventory_invoice_allocation_effects TO yummyai_app;
ALTER TABLE inventory_procurement_commands ADD COLUMN reconciliation_result_proof_id uuid,
 ADD CONSTRAINT procurement_command_reconciliation_fk FOREIGN KEY(tenant_id,reconciliation_result_proof_id) REFERENCES inventory_invoice_reconciliations(tenant_id,id);
ALTER TABLE inventory_procurement_commands DROP CONSTRAINT procurement_commands_kind, DROP CONSTRAINT procurement_commands_result;
ALTER TABLE inventory_procurement_commands
 ADD CONSTRAINT procurement_commands_kind CHECK(kind IN ('requisition_create','rfq_create','quote_record','purchase_create','supply_purchase_create','purchase_revise','purchase_review','invoice_record','invoice_reconcile')
  AND operation=CASE WHEN kind='supply_purchase_create' THEN 'purchase_create' ELSE kind END
  AND ((kind IN ('requisition_create','purchase_create'))=(target_id IS NULL)) AND (target_id IS NULL OR substring(target_id::text from 15 for 1)='7')),
 ADD CONSTRAINT procurement_commands_result CHECK((status='succeeded')=(result_proof_id IS NOT NULL OR invoice_result_proof_id IS NOT NULL OR reconciliation_result_proof_id IS NOT NULL)
  AND (status='prepared')=(completed_at IS NULL) AND CASE WHEN kind='invoice_record' THEN result_proof_id IS NULL AND reconciliation_result_proof_id IS NULL
   WHEN kind='invoice_reconcile' THEN result_proof_id IS NULL AND invoice_result_proof_id IS NULL ELSE invoice_result_proof_id IS NULL AND reconciliation_result_proof_id IS NULL END);
--> statement-breakpoint
CREATE FUNCTION invoice_receipt_occupied(t uuid,r uuid) RETURNS numeric LANGUAGE sql STABLE AS $$
 SELECT coalesce((SELECT sum(quantity) FROM inventory_supplier_invoice_allocations WHERE tenant_id=t AND receipt_line_id=r),0)
  +coalesce((SELECT sum(CASE WHEN kind='consume' THEN quantity ELSE -quantity END) FROM inventory_invoice_allocation_effects WHERE tenant_id=t AND receipt_line_id=r),0)
$$;
CREATE FUNCTION invoice_line_occupied(t uuid,l uuid) RETURNS numeric LANGUAGE sql STABLE AS $$
 SELECT coalesce((SELECT sum(quantity) FROM inventory_supplier_invoice_allocations WHERE tenant_id=t AND invoice_line_id=l),0)
  +coalesce((SELECT sum(CASE WHEN kind='consume' THEN quantity ELSE -quantity END) FROM inventory_invoice_allocation_effects WHERE tenant_id=t AND invoice_line_id=l),0)
$$;
CREATE FUNCTION invoice_line_credited(t uuid,l uuid) RETURNS numeric LANGUAGE sql STABLE AS $$
 SELECT coalesce(sum(procurement_json_quantity(x->'quantity',x->>'unit',false)),0)
 FROM inventory_invoice_reconciliations d JOIN inventory_invoice_reconciliations r ON r.tenant_id=d.tenant_id AND r.adjustment_id=d.id,
 LATERAL jsonb_array_elements(d.input->'lines') x WHERE d.tenant_id=t AND d.action='adjustment_record'
  AND d.input->'document'->>'kind'='credit_note' AND r.input->>'decision'='approved' AND x->>'invoiceLineId'=l::text
$$;
CREATE FUNCTION invoice_line_amount_delta(t uuid,l uuid) RETURNS numeric LANGUAGE sql STABLE AS $$
 SELECT coalesce(sum(CASE WHEN d.input->'document'->>'kind'='credit_note' THEN -(x->>'amountMinor')::numeric ELSE (x->>'amountMinor')::numeric END),0)
 FROM inventory_invoice_reconciliations d JOIN inventory_invoice_reconciliations r ON r.tenant_id=d.tenant_id AND r.adjustment_id=d.id,
 LATERAL jsonb_array_elements(d.input->'lines') x WHERE d.tenant_id=t AND d.action='adjustment_record'
  AND r.input->>'decision'='approved' AND x->>'invoiceLineId'=l::text
$$;
-- Exact v1 canonical JSON for this strict, ASCII-keyed contract. Safe integer
-- money/quantity numbers are decimal; arrays keep their original order.
CREATE FUNCTION invoice_reconciliation_canonical(value jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE result text;
BEGIN
 CASE jsonb_typeof(value)
 WHEN 'object' THEN SELECT '{'||coalesce(string_agg(to_jsonb(key)::text||':'||invoice_reconciliation_canonical(child),',' ORDER BY key COLLATE "C"),'')||'}'
  INTO result FROM jsonb_each(value) AS e(key,child);
 WHEN 'array' THEN SELECT '['||coalesce(string_agg(invoice_reconciliation_canonical(child),',' ORDER BY ordinal),'')||']'
  INTO result FROM jsonb_array_elements(value) WITH ORDINALITY AS e(child,ordinal);
 WHEN 'number' THEN result:=trim_scale((value#>>'{}')::numeric)::text;
 ELSE result:=value::text;
 END CASE;
 RETURN result;
END $$;
CREATE FUNCTION invoice_reconciliation_checksum(invoice_id uuid,input jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE normalized jsonb:=input;
BEGIN
 IF input->>'action'='adjustment_record' THEN normalized:=jsonb_set(input,'{document,issuedAt}',to_jsonb(to_char((input->'document'->>'issuedAt')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))); END IF;
 RETURN encode(sha256(convert_to(invoice_reconciliation_canonical(jsonb_build_object('version',1,'invoiceId',invoice_id::text,'input',normalized)),'UTF8')),'hex');
END $$;
--> statement-breakpoint
CREATE FUNCTION guard_invoice_reconciliation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE c inventory_procurement_commands%ROWTYPE; p inventory_supplier_invoice_requests%ROWTYPE;
 i inventory_supplier_invoices%ROWTYPE; o inventory_purchase_orders%ROWTYPE; h inventory_invoice_reconciliations%ROWTYPE;
 d inventory_invoice_reconciliations%ROWTYPE; l inventory_supplier_invoice_lines%ROWTYPE; x jsonb; q numeric; a numeric; qty numeric; amount numeric;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'invoice reconciliation facts are immutable' USING ERRCODE='23514'; END IF;
 IF NEW.created_by::text IS DISTINCT FROM current_setting('app.user_id',true) THEN RAISE EXCEPTION 'invoice reconciliation requires actual actor' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('procurement-original:'||NEW.tenant_id::text||':invoice_reconcile:'||NEW.request_key,0));
 SELECT * INTO c FROM inventory_procurement_commands WHERE tenant_id=NEW.tenant_id AND operation='invoice_reconcile' AND request_key=NEW.request_key FOR UPDATE;
 IF c.id IS NULL OR c.kind<>'invoice_reconcile' OR c.status<>'prepared' OR c.expires_at<=clock_timestamp()
  OR current_setting('app.procurement_command_id',true) IS DISTINCT FROM c.id::text OR c.created_by<>NEW.created_by
  OR c.target_id IS DISTINCT FROM NEW.invoice_id OR c.request_checksum<>NEW.request_checksum THEN
  RAISE EXCEPTION 'invoice reconciliation must bind its actual prepared command' USING ERRCODE='23514'; END IF;
 IF invoice_reconciliation_checksum(NEW.invoice_id,NEW.input) IS DISTINCT FROM NEW.request_checksum THEN
  RAISE EXCEPTION 'invoice reconciliation actual input differs from its original request checksum' USING ERRCODE='23514'; END IF;
 SELECT * INTO i FROM inventory_supplier_invoices WHERE tenant_id=NEW.tenant_id AND id=NEW.invoice_id;
 PERFORM pg_advisory_xact_lock(hashtextextended('procurement-order:'||NEW.tenant_id::text||':'||i.purchase_order_id::text,0));
 SELECT * INTO p FROM inventory_supplier_invoice_requests WHERE tenant_id=NEW.tenant_id AND id=NEW.original_proof_id;
 SELECT * INTO o FROM inventory_purchase_orders WHERE tenant_id=NEW.tenant_id AND id=NEW.purchase_order_id;
 IF i.id IS NULL OR p.invoice_id IS DISTINCT FROM i.id OR p.purchase_order_id IS DISTINCT FROM NEW.purchase_order_id
  OR p.purchase_order_version_id IS DISTINCT FROM NEW.purchase_order_version_id OR i.purchase_order_id IS DISTINCT FROM NEW.purchase_order_id
  OR o.supplier_id IS DISTINCT FROM NEW.supplier_id OR i.allocation_status IS NULL OR i.allocation_status='legacy_unknown'
  OR EXISTS(SELECT 1 FROM inventory_supplier_invoices legacy_invoice LEFT JOIN inventory_supplier_invoice_requests proof ON proof.tenant_id=legacy_invoice.tenant_id AND proof.invoice_id=legacy_invoice.id
    WHERE legacy_invoice.tenant_id=NEW.tenant_id AND legacy_invoice.purchase_order_id=NEW.purchase_order_id AND (proof.id IS NULL OR legacy_invoice.allocation_status IS NULL OR legacy_invoice.allocation_status='legacy_unknown')) THEN
  RAISE EXCEPTION 'invoice reconciliation requires known original evidence and capacity' USING ERRCODE='23514'; END IF;
 SELECT * INTO h FROM inventory_invoice_reconciliations WHERE tenant_id=NEW.tenant_id AND invoice_id=NEW.invoice_id ORDER BY sequence DESC LIMIT 1;
 IF NEW.sequence<>coalesce(h.sequence,0)+1 OR NEW.previous_id IS DISTINCT FROM h.id THEN RAISE EXCEPTION 'invoice reconciliation head changed' USING ERRCODE='23514'; END IF;
 IF (NEW.input->>'action' IS DISTINCT FROM NEW.action OR NEW.input->>'idempotencyKey' IS DISTINCT FROM NEW.request_key
  OR coalesce(NEW.input->>'expectedFingerprint','')!~'^[a-f0-9]{64}$' OR length(coalesce(NEW.input->>'reason','')) NOT BETWEEN 1 AND 2000) THEN
  RAISE EXCEPTION 'invoice reconciliation input differs from original action' USING ERRCODE='23514'; END IF;
 IF NEW.action='adjustment_record' THEN
  IF NEW.adjustment_id IS NOT NULL OR coalesce(NEW.input->'document'->>'kind','') NOT IN ('credit_note','debit_note')
   OR NEW.input->'document'->>'currency' IS DISTINCT FROM i.currency OR length(coalesce(NEW.input->'document'->>'number','')) NOT BETWEEN 1 AND 100
   OR length(coalesce(NEW.input->'document'->>'evidenceReference','')) NOT BETWEEN 1 AND 2000
   OR NEW.input->'document'->>'issuedAt' IS NULL OR (NEW.input->'document'->>'issuedAt')::timestamptz IS NULL
   OR NEW.document_key IS DISTINCT FROM (NEW.input->'document'->>'kind'||':'||lower(btrim(NEW.input->'document'->>'number')))
   OR jsonb_typeof(NEW.input->'lines') IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.input->'lines') NOT BETWEEN 1 AND 200
   OR (SELECT count(DISTINCT requested_line->>'invoiceLineId') FROM jsonb_array_elements(NEW.input->'lines') requested_line)<>jsonb_array_length(NEW.input->'lines') THEN
   RAISE EXCEPTION 'supplier correction requires its actual document and unique original lines' USING ERRCODE='23514'; END IF;
  FOR x IN SELECT * FROM jsonb_array_elements(NEW.input->'lines') LOOP
   SELECT * INTO l FROM inventory_supplier_invoice_lines WHERE tenant_id=NEW.tenant_id AND id=(x->>'invoiceLineId')::uuid AND invoice_id=NEW.invoice_id;
   q:=procurement_json_quantity(x->'quantity',x->>'unit',false); a:=(x->>'amountMinor')::numeric;
   IF l.id IS NULL OR x->>'unit' IS DISTINCT FROM l.unit OR q IS NULL OR a IS NULL OR a<0 OR a>9007199254740991 OR trunc(a)<>a OR (q=0 AND a=0)
    OR NEW.input->'document'->>'kind'='debit_note' AND q<>0 THEN RAISE EXCEPTION 'supplier adjustment differs from original line or amount' USING ERRCODE='23514'; END IF;
  END LOOP;
 ELSIF NEW.action='adjustment_review' THEN
  SELECT * INTO d FROM inventory_invoice_reconciliations WHERE tenant_id=NEW.tenant_id AND id=NEW.adjustment_id;
  IF NEW.document_key IS NOT NULL OR d.id IS NULL OR d.action<>'adjustment_record' OR d.invoice_id<>NEW.invoice_id OR d.original_proof_id<>NEW.original_proof_id
   OR NEW.input->>'adjustmentId' IS DISTINCT FROM NEW.adjustment_id::text OR coalesce(NEW.input->>'decision','') NOT IN ('approved','rejected')
   OR EXISTS(SELECT 1 FROM inventory_invoice_reconciliations WHERE tenant_id=NEW.tenant_id AND adjustment_id=d.id) THEN
   RAISE EXCEPTION 'supplier adjustment review must reference its pending original document' USING ERRCODE='23514'; END IF;
  IF NEW.input->>'decision'='approved' THEN
   FOR x IN SELECT * FROM jsonb_array_elements(d.input->'lines') LOOP
    SELECT * INTO l FROM inventory_supplier_invoice_lines WHERE tenant_id=NEW.tenant_id AND id=(x->>'invoiceLineId')::uuid AND invoice_id=NEW.invoice_id;
    qty:=invoice_line_credited(NEW.tenant_id,l.id); amount:=procurement_minor_amount(l.invoiced_quantity,l.unit_cost_minor,l.price_basis_quantity)+invoice_line_amount_delta(NEW.tenant_id,l.id);
    q:=procurement_json_quantity(x->'quantity',x->>'unit',false); a:=(x->>'amountMinor')::numeric;
    IF d.input->'document'->>'kind'='credit_note' THEN qty:=qty+q; amount:=amount-a; ELSE amount:=amount+a; END IF;
    IF qty>l.invoiced_quantity OR amount<0 OR amount>9007199254740991 THEN RAISE EXCEPTION 'supplier correction exceeds remaining invoice quantity or amount' USING ERRCODE='23514'; END IF;
   END LOOP;
  END IF;
 ELSE
  IF NEW.adjustment_id IS NOT NULL OR NEW.document_key IS NOT NULL OR jsonb_typeof(NEW.input->'lines') IS DISTINCT FROM 'array'
   OR jsonb_array_length(NEW.input->'lines') NOT BETWEEN 1 AND 200
   OR (SELECT count(DISTINCT (requested_line->>'invoiceLineId',requested_line->>'receiptLineId')) FROM jsonb_array_elements(NEW.input->'lines') requested_line)<>jsonb_array_length(NEW.input->'lines') THEN
   RAISE EXCEPTION 'later receipt matching requires unique actual lines' USING ERRCODE='23514'; END IF;
 END IF;
 NEW.creation_transaction_id:=pg_current_xact_id()::text; NEW.created_at:=clock_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER invoice_reconciliation_guard BEFORE INSERT OR UPDATE OR DELETE ON inventory_invoice_reconciliations FOR EACH ROW EXECUTE FUNCTION guard_invoice_reconciliation();
--> statement-breakpoint
CREATE FUNCTION guard_invoice_allocation_effect() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE e inventory_invoice_reconciliations%ROWTYPE; d inventory_invoice_reconciliations%ROWTYPE;
 l inventory_supplier_invoice_lines%ROWTYPE; r inventory_procurement_receipt_lines%ROWTYPE; receipt inventory_procurement_receipts%ROWTYPE;
 a inventory_supplier_invoice_allocations%ROWTYPE; s inventory_invoice_allocation_effects%ROWTYPE; used numeric; available numeric;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'invoice allocation effects are immutable' USING ERRCODE='23514'; END IF;
 SELECT * INTO e FROM inventory_invoice_reconciliations WHERE tenant_id=NEW.tenant_id AND id=NEW.event_id;
 IF e.id IS NULL OR e.creation_transaction_id IS DISTINCT FROM pg_current_xact_id()::text OR NEW.created_by IS DISTINCT FROM e.created_by
  OR NEW.created_by::text IS DISTINCT FROM current_setting('app.user_id',true) THEN RAISE EXCEPTION 'allocation effect requires this actual reconciliation transaction' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('procurement-order:'||NEW.tenant_id::text||':'||e.purchase_order_id::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('procurement-invoice-receipt:'||NEW.tenant_id::text||':'||NEW.receipt_line_id::text,0));
 SELECT * INTO l FROM inventory_supplier_invoice_lines WHERE tenant_id=NEW.tenant_id AND id=NEW.invoice_line_id;
 SELECT * INTO r FROM inventory_procurement_receipt_lines WHERE tenant_id=NEW.tenant_id AND id=NEW.receipt_line_id;
 SELECT * INTO receipt FROM inventory_procurement_receipts WHERE tenant_id=NEW.tenant_id AND id=r.receipt_id;
 IF l.id IS NULL OR r.id IS NULL OR l.invoice_id<>e.invoice_id OR r.line_key<>l.line_key OR NEW.unit IS DISTINCT FROM l.unit OR NEW.unit IS DISTINCT FROM r.unit
  OR receipt.purchase_order_id IS DISTINCT FROM e.purchase_order_id OR receipt.purchase_order_version_id IS DISTINCT FROM e.purchase_order_version_id THEN
  RAISE EXCEPTION 'allocation effect differs from original invoice receipt or purchase version' USING ERRCODE='23514'; END IF;
 IF NEW.kind='consume' THEN
  IF e.action<>'receipt_match' THEN RAISE EXCEPTION 'only actual later receipt matching may consume capacity' USING ERRCODE='23514'; END IF;
  IF invoice_receipt_occupied(NEW.tenant_id,r.id)+NEW.quantity>r.received_quantity THEN RAISE EXCEPTION 'accepted receipt quantity already allocated' USING ERRCODE='23514'; END IF;
  IF invoice_line_occupied(NEW.tenant_id,l.id)+NEW.quantity>l.invoiced_quantity-invoice_line_credited(NEW.tenant_id,l.id) THEN
   RAISE EXCEPTION 'later matching exceeds remaining invoice quantity' USING ERRCODE='23514'; END IF;
 ELSE
  SELECT * INTO d FROM inventory_invoice_reconciliations WHERE tenant_id=NEW.tenant_id AND id=e.adjustment_id;
  IF e.action<>'adjustment_review' OR e.input->>'decision'<>'approved' OR d.input->'document'->>'kind'<>'credit_note' THEN
   RAISE EXCEPTION 'only approved quantity credit may release capacity' USING ERRCODE='23514'; END IF;
  IF NEW.source_allocation_id IS NOT NULL THEN
   SELECT * INTO a FROM inventory_supplier_invoice_allocations WHERE tenant_id=NEW.tenant_id AND id=NEW.source_allocation_id;
   IF a.id IS NULL OR a.invoice_line_id<>l.id OR a.receipt_line_id<>r.id OR a.unit<>NEW.unit THEN RAISE EXCEPTION 'release differs from original allocation' USING ERRCODE='23514'; END IF;
   SELECT coalesce(sum(quantity),0) INTO used FROM inventory_invoice_allocation_effects WHERE tenant_id=NEW.tenant_id AND source_allocation_id=a.id;
   available:=a.quantity-used;
  ELSE
   SELECT * INTO s FROM inventory_invoice_allocation_effects WHERE tenant_id=NEW.tenant_id AND id=NEW.source_effect_id;
   IF s.id IS NULL OR s.kind<>'consume' OR s.invoice_line_id<>l.id OR s.receipt_line_id<>r.id OR s.unit<>NEW.unit THEN RAISE EXCEPTION 'release differs from original later match' USING ERRCODE='23514'; END IF;
   SELECT coalesce(sum(quantity),0) INTO used FROM inventory_invoice_allocation_effects WHERE tenant_id=NEW.tenant_id AND source_effect_id=s.id;
   available:=s.quantity-used;
  END IF;
  IF NEW.quantity>available OR invoice_line_occupied(NEW.tenant_id,l.id)<NEW.quantity THEN RAISE EXCEPTION 'release exceeds actual original occupation' USING ERRCODE='23514'; END IF;
 END IF;
 NEW.created_at:=clock_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER invoice_allocation_effect_guard BEFORE INSERT OR UPDATE OR DELETE ON inventory_invoice_allocation_effects FOR EACH ROW EXECUTE FUNCTION guard_invoice_allocation_effect();
--> statement-breakpoint
CREATE FUNCTION require_invoice_reconciliation_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE c inventory_procurement_commands%ROWTYPE; d inventory_invoice_reconciliations%ROWTYPE; l inventory_supplier_invoice_lines%ROWTYPE;
 x jsonb; used numeric; released numeric; old_used numeric; net_quantity numeric; actual numeric;
BEGIN
 SELECT * INTO c FROM inventory_procurement_commands WHERE tenant_id=NEW.tenant_id AND operation='invoice_reconcile' AND request_key=NEW.request_key;
 IF c.id IS NULL OR c.status<>'succeeded' OR c.reconciliation_result_proof_id IS DISTINCT FROM NEW.id OR c.created_by<>NEW.created_by
  OR c.target_id IS DISTINCT FROM NEW.invoice_id OR c.request_checksum<>NEW.request_checksum OR NEW.creation_transaction_id IS DISTINCT FROM pg_current_xact_id()::text THEN
  RAISE EXCEPTION 'reconciliation fact and original command outcome must commit together' USING ERRCODE='23514'; END IF;
 IF NEW.action='receipt_match' THEN
  FOR x IN SELECT * FROM jsonb_array_elements(NEW.input->'lines') LOOP
   SELECT coalesce(sum(quantity),0) INTO actual FROM inventory_invoice_allocation_effects WHERE tenant_id=NEW.tenant_id AND event_id=NEW.id AND kind='consume'
    AND invoice_line_id=(x->>'invoiceLineId')::uuid AND receipt_line_id=(x->>'receiptLineId')::uuid AND unit=x->>'unit';
   IF actual IS DISTINCT FROM procurement_json_quantity(x->'quantity',x->>'unit',true) THEN RAISE EXCEPTION 'later matching effects differ from actual requested receipt quantities' USING ERRCODE='23514'; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM inventory_invoice_allocation_effects f WHERE f.tenant_id=NEW.tenant_id AND f.event_id=NEW.id AND (f.kind<>'consume'
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.input->'lines') requested_line WHERE requested_line->>'invoiceLineId'=f.invoice_line_id::text AND requested_line->>'receiptLineId'=f.receipt_line_id::text))) THEN
   RAISE EXCEPTION 'later matching contains an unrequested effect' USING ERRCODE='23514'; END IF;
 ELSIF NEW.action='adjustment_review' AND NEW.input->>'decision'='approved' THEN
  SELECT * INTO d FROM inventory_invoice_reconciliations WHERE tenant_id=NEW.tenant_id AND id=NEW.adjustment_id;
  FOR l IN SELECT * FROM inventory_supplier_invoice_lines WHERE tenant_id=NEW.tenant_id AND invoice_id=NEW.invoice_id LOOP
   used:=invoice_line_occupied(NEW.tenant_id,l.id); net_quantity:=l.invoiced_quantity-invoice_line_credited(NEW.tenant_id,l.id);
   SELECT coalesce(sum(quantity),0) INTO released FROM inventory_invoice_allocation_effects WHERE tenant_id=NEW.tenant_id AND event_id=NEW.id AND invoice_line_id=l.id AND kind='release';
   old_used:=used+released;
   IF used<0 OR used>net_quantity OR released<>greatest(old_used-net_quantity,0) THEN RAISE EXCEPTION 'approved credit must release only actual occupation beyond the remaining claim' USING ERRCODE='23514'; END IF;
   IF procurement_minor_amount(l.invoiced_quantity,l.unit_cost_minor,l.price_basis_quantity)+invoice_line_amount_delta(NEW.tenant_id,l.id) NOT BETWEEN 0 AND 9007199254740991 THEN
    RAISE EXCEPTION 'approved adjustment exceeds actual invoice amount' USING ERRCODE='23514'; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM inventory_invoice_allocation_effects WHERE tenant_id=NEW.tenant_id AND event_id=NEW.id AND kind<>'release') THEN
   RAISE EXCEPTION 'supplier credit cannot consume receipt capacity' USING ERRCODE='23514'; END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM inventory_invoice_allocation_effects WHERE tenant_id=NEW.tenant_id AND event_id=NEW.id) THEN
   RAISE EXCEPTION 'pending or rejected documents have no allocation effect' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER invoice_reconciliation_complete AFTER INSERT ON inventory_invoice_reconciliations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_invoice_reconciliation_complete();
--> statement-breakpoint
-- Saved execution balances are immutable evidence, so validate them against the
-- actual approved ledger too. A raw caller cannot invent a convincing UI result.
CREATE FUNCTION require_invoice_reconciliation_balance() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE i inventory_supplier_invoices%ROWTYPE; v inventory_purchase_order_versions%ROWTYPE; l inventory_supplier_invoice_lines%ROWTYPE;
 x jsonb; ordered jsonb; original_amount numeric; credit_amount numeric; debit_amount numeric; net_amount numeric; net_quantity numeric;
 credited numeric; allocated numeric; expected numeric; variance numeric; total numeric:=0; total_variance numeric:=0;
 price_basis numeric; exact_expected numeric; price_unknown boolean:=false; all_allocated boolean:=true; all_credited boolean:=true; all_lines_matched boolean:=true;
 status text; reasons jsonb:='[]'::jsonb;
BEGIN
 SELECT * INTO i FROM inventory_supplier_invoices WHERE tenant_id=NEW.tenant_id AND id=NEW.invoice_id;
 SELECT * INTO v FROM inventory_purchase_order_versions WHERE tenant_id=NEW.tenant_id AND id=NEW.purchase_order_version_id;
 IF NEW.balance->>'currency' IS DISTINCT FROM i.currency OR NEW.balance->>'comparisonCurrency' IS DISTINCT FROM v.currency
  OR jsonb_typeof(NEW.balance->'lines') IS DISTINCT FROM 'array'
  OR jsonb_array_length(NEW.balance->'lines')<>(SELECT count(*) FROM inventory_supplier_invoice_lines WHERE tenant_id=NEW.tenant_id AND invoice_id=NEW.invoice_id)
  OR (SELECT count(DISTINCT balance_line->>'invoiceLineId') FROM jsonb_array_elements(NEW.balance->'lines') balance_line)<>jsonb_array_length(NEW.balance->'lines') THEN
  RAISE EXCEPTION 'reconciliation balance requires exact original lines and currencies' USING ERRCODE='23514'; END IF;
 FOR l IN SELECT * FROM inventory_supplier_invoice_lines WHERE tenant_id=NEW.tenant_id AND invoice_id=NEW.invoice_id LOOP
  SELECT y INTO x FROM jsonb_array_elements(NEW.balance->'lines') y WHERE y->>'invoiceLineId'=l.id::text;
  SELECT y INTO ordered FROM jsonb_array_elements(v.line_snapshot) y WHERE y->>'lineKey'=l.line_key;
  original_amount:=procurement_minor_amount(l.invoiced_quantity,l.unit_cost_minor,l.price_basis_quantity);
  SELECT coalesce(sum(CASE WHEN d.input->'document'->>'kind'='credit_note' THEN (y->>'amountMinor')::numeric ELSE 0 END),0),
   coalesce(sum(CASE WHEN d.input->'document'->>'kind'='debit_note' THEN (y->>'amountMinor')::numeric ELSE 0 END),0)
   INTO credit_amount,debit_amount FROM inventory_invoice_reconciliations d JOIN inventory_invoice_reconciliations r ON r.tenant_id=d.tenant_id AND r.adjustment_id=d.id,
   LATERAL jsonb_array_elements(d.input->'lines') y WHERE d.tenant_id=NEW.tenant_id AND d.invoice_id=NEW.invoice_id AND r.input->>'decision'='approved' AND y->>'invoiceLineId'=l.id::text;
  credited:=invoice_line_credited(NEW.tenant_id,l.id); net_quantity:=l.invoiced_quantity-credited; allocated:=invoice_line_occupied(NEW.tenant_id,l.id);
  net_amount:=original_amount+debit_amount-credit_amount; total:=total+net_amount;
  IF allocated<>net_quantity THEN all_allocated:=false; END IF;
  IF net_quantity<>0 OR net_amount<>0 OR allocated<>0 THEN all_credited:=false; END IF;
  expected:=NULL; variance:=NULL;
  IF i.currency=v.currency THEN
   price_basis:=procurement_json_quantity(coalesce(ordered->'priceBasisQuantity','1'::jsonb),l.unit,true);
   exact_expected:=allocated*(ordered->>'unitCostMinor')::numeric/price_basis;
   IF mod(allocated*(ordered->>'unitCostMinor')::numeric,price_basis)=0
    AND exact_expected=trunc(exact_expected) AND exact_expected BETWEEN 0 AND 9007199254740991 THEN expected:=exact_expected; variance:=net_amount-expected;
   ELSE price_unknown:=true; END IF;
  END IF;
  IF variance IS NULL THEN total_variance:=NULL; ELSIF total_variance IS NOT NULL THEN total_variance:=total_variance+variance; END IF;
  IF variance IS DISTINCT FROM 0 THEN all_lines_matched:=false; END IF;
  IF x IS NULL OR x->>'lineKey' IS DISTINCT FROM l.line_key OR x->>'unit' IS DISTINCT FROM l.unit
   OR procurement_json_quantity(x->'originalQuantity',l.unit,true)<>l.invoiced_quantity
   OR procurement_json_quantity(x->'creditedQuantity',l.unit,false)<>credited
   OR procurement_json_quantity(x->'netQuantity',l.unit,false)<>net_quantity
   OR procurement_json_quantity(x->'allocatedQuantity',l.unit,false)<>allocated
   OR procurement_json_quantity(x->'unallocatedQuantity',l.unit,false)<>net_quantity-allocated
   OR (x->>'originalAmountMinor')::numeric IS DISTINCT FROM original_amount OR (x->>'creditAmountMinor')::numeric IS DISTINCT FROM credit_amount
   OR (x->>'debitAmountMinor')::numeric IS DISTINCT FROM debit_amount OR (x->>'netAmountMinor')::numeric IS DISTINCT FROM net_amount
   OR (x->>'expectedAmountMinor')::numeric IS DISTINCT FROM expected OR (x->>'varianceMinor')::numeric IS DISTINCT FROM variance THEN
   RAISE EXCEPTION 'reconciliation execution balance differs from actual line facts' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF i.currency<>v.currency THEN reasons:=reasons||'"currency_mismatch"'::jsonb; END IF;
 IF price_unknown THEN reasons:=reasons||'"price_basis_unrepresentable"'::jsonb; END IF;
 status:=CASE WHEN all_credited THEN 'fully_credited' WHEN jsonb_array_length(reasons)>0 THEN 'unknown'
  WHEN all_allocated AND all_lines_matched AND total_variance=0 THEN 'matched' ELSE 'reconciliation_required' END;
 IF total NOT BETWEEN 0 AND 9007199254740991 OR (NEW.balance->>'netAmountMinor')::numeric IS DISTINCT FROM total
  OR (NEW.balance->>'varianceMinor')::numeric IS DISTINCT FROM total_variance OR NEW.balance->>'status' IS DISTINCT FROM status
  OR NEW.balance->'unknownReasons' IS DISTINCT FROM reasons THEN
  RAISE EXCEPTION 'reconciliation execution total or status differs from actual facts' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER invoice_reconciliation_balance AFTER INSERT ON inventory_invoice_reconciliations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_invoice_reconciliation_balance();
REVOKE ALL ON FUNCTION require_invoice_reconciliation_balance() FROM PUBLIC;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION procurement_command_fact_matches(c inventory_procurement_commands) RETURNS boolean LANGUAGE sql AS $$
 SELECT CASE WHEN c.kind='invoice_reconcile' THEN EXISTS(SELECT 1 FROM inventory_invoice_reconciliations e
 WHERE e.tenant_id=c.tenant_id AND e.id=c.reconciliation_result_proof_id AND e.invoice_id=c.target_id
 AND e.created_by=c.created_by AND e.request_key=c.request_key AND e.request_checksum=c.request_checksum)
 WHEN c.kind='invoice_record' THEN EXISTS(SELECT 1 FROM inventory_supplier_invoice_requests p
  JOIN inventory_supplier_invoices i ON i.tenant_id=p.tenant_id AND i.id=p.invoice_id
  WHERE p.tenant_id=c.tenant_id AND p.id=c.invoice_result_proof_id AND p.purchase_order_id=c.target_id AND p.created_by=c.created_by
   AND p.idempotency_key=c.request_key AND p.request_checksum=c.request_checksum AND p.evidence_version=1
   AND i.purchase_order_id=p.purchase_order_id AND i.created_by=p.created_by AND i.idempotency_key=p.idempotency_key)
 ELSE EXISTS(SELECT 1 FROM inventory_procurement_write_requests p WHERE p.tenant_id=c.tenant_id AND p.id=c.result_proof_id
  AND p.operation=c.operation AND p.target_id IS NOT DISTINCT FROM c.target_id AND p.created_by=c.created_by
  AND p.idempotency_key=c.request_key AND p.request_checksum=c.request_checksum) END
$$;
CREATE OR REPLACE FUNCTION guard_procurement_command() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE maintenance boolean; xid_text text:=mod(pg_current_xact_id()::text::numeric,4294967296)::bigint::text;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'procurement command evidence is immutable' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('procurement-original:'||NEW.tenant_id::text||':'||NEW.operation||':'||NEW.request_key,0));
  IF current_setting('app.user_id',true) IS DISTINCT FROM NEW.created_by::text OR NEW.status<>'prepared' OR NEW.result_proof_id IS NOT NULL OR NEW.invoice_result_proof_id IS NOT NULL OR NEW.reconciliation_result_proof_id IS NOT NULL
   OR NEW.completed_at IS NOT NULL OR NEW.acknowledged_at IS NOT NULL OR NEW.redacted_at IS NOT NULL OR NEW.encrypted_input IS NULL THEN
   RAISE EXCEPTION 'procurement command requires its actual actor and original preparation' USING ERRCODE='23514';
  END IF;
  NEW.created_at:=clock_timestamp(); NEW.expires_at:=NEW.created_at+interval '7 days';
  IF EXISTS(SELECT 1 FROM inventory_procurement_write_requests WHERE tenant_id=NEW.tenant_id AND operation=NEW.operation AND idempotency_key=NEW.request_key)
   OR NEW.kind='invoice_record' AND EXISTS(SELECT 1 FROM inventory_supplier_invoices WHERE tenant_id=NEW.tenant_id AND idempotency_key=NEW.request_key) OR NEW.kind='invoice_reconcile' AND EXISTS(SELECT 1 FROM inventory_invoice_reconciliations WHERE tenant_id=NEW.tenant_id AND request_key=NEW.request_key) THEN
   RAISE EXCEPTION 'an existing actual procurement cannot become a new prepared command' USING ERRCODE='23514';
  END IF;
  IF NEW.kind='rfq_create' AND NOT EXISTS(SELECT 1 FROM inventory_procurement_requisitions WHERE tenant_id=NEW.tenant_id AND id=NEW.target_id)
   OR NEW.kind='quote_record' AND NOT EXISTS(SELECT 1 FROM inventory_procurement_rfqs WHERE tenant_id=NEW.tenant_id AND id=NEW.target_id)
   OR NEW.kind IN ('purchase_revise','purchase_review','invoice_record') AND NOT EXISTS(SELECT 1 FROM inventory_purchase_orders WHERE tenant_id=NEW.tenant_id AND id=NEW.target_id)
   OR NEW.kind='invoice_reconcile' AND NOT EXISTS(SELECT 1 FROM inventory_supplier_invoices WHERE tenant_id=NEW.tenant_id AND id=NEW.target_id) OR NEW.kind='supply_purchase_create' AND NOT EXISTS(SELECT 1 FROM product_supply_links WHERE tenant_id=NEW.tenant_id AND id=NEW.target_id) THEN
   RAISE EXCEPTION 'original procurement target missing' USING ERRCODE='23514';
  END IF;
 END IF;
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(OLD)-ARRAY['status','result_proof_id','invoice_result_proof_id','reconciliation_result_proof_id','encrypted_input','completed_at','acknowledged_at','redacted_at']) IS DISTINCT FROM
    (to_jsonb(NEW)-ARRAY['status','result_proof_id','invoice_result_proof_id','reconciliation_result_proof_id','encrypted_input','completed_at','acknowledged_at','redacted_at'])
   OR OLD.status<>'prepared' AND (OLD.status,OLD.result_proof_id,OLD.invoice_result_proof_id,OLD.reconciliation_result_proof_id,OLD.completed_at) IS DISTINCT FROM (NEW.status,NEW.result_proof_id,NEW.invoice_result_proof_id,NEW.reconciliation_result_proof_id,NEW.completed_at)
   OR OLD.encrypted_input IS NULL AND NEW.encrypted_input IS NOT NULL
   OR OLD.encrypted_input IS NOT NULL AND NEW.encrypted_input IS NOT NULL AND OLD.encrypted_input<>NEW.encrypted_input
   OR OLD.acknowledged_at IS NOT NULL AND OLD.acknowledged_at IS DISTINCT FROM NEW.acknowledged_at
   OR OLD.redacted_at IS NOT NULL AND OLD.redacted_at IS DISTINCT FROM NEW.redacted_at THEN
   RAISE EXCEPTION 'procurement original and outcome are immutable' USING ERRCODE='23514';
  END IF;
  maintenance:=OLD.expires_at<=clock_timestamp() AND OLD.encrypted_input IS NOT NULL AND NEW.encrypted_input IS NULL AND NEW.redacted_at IS NOT NULL
   AND NEW.acknowledged_at IS NOT DISTINCT FROM OLD.acknowledged_at AND NEW.status=CASE WHEN OLD.status='prepared' THEN 'expired' ELSE OLD.status END;
  IF current_setting('app.user_id',true) IS DISTINCT FROM OLD.created_by::text AND NOT maintenance THEN
   RAISE EXCEPTION 'procurement command belongs to its actual original actor' USING ERRCODE='23514';
  END IF;
  IF NEW.status='expired' AND OLD.status='prepared' AND OLD.expires_at>clock_timestamp() OR NEW.status='succeeded' AND OLD.status='prepared'
   AND (OLD.expires_at<=clock_timestamp() OR current_setting('app.procurement_command_id',true) IS DISTINCT FROM OLD.id::text
    OR NOT CASE WHEN NEW.kind='invoice_reconcile' THEN EXISTS(SELECT 1 FROM inventory_invoice_reconciliations e WHERE e.tenant_id=NEW.tenant_id AND e.id=NEW.reconciliation_result_proof_id AND e.creation_transaction_id=pg_current_xact_id()::text) WHEN NEW.kind='invoice_record' THEN EXISTS(SELECT 1 FROM inventory_supplier_invoice_requests p JOIN inventory_supplier_invoices i ON i.tenant_id=p.tenant_id AND i.id=p.invoice_id WHERE p.tenant_id=NEW.tenant_id AND p.id=NEW.invoice_result_proof_id AND p.xmin::text=xid_text AND i.creation_transaction_id=pg_current_xact_id()::text) ELSE EXISTS(SELECT 1 FROM inventory_procurement_write_requests p WHERE p.tenant_id=NEW.tenant_id AND p.id=NEW.result_proof_id AND p.xmin::text=xid_text) END) THEN
   RAISE EXCEPTION 'procurement command is not admitted to its actual transaction' USING ERRCODE='23514';
  END IF;
 END IF;
 IF NEW.status='succeeded' AND NOT procurement_command_fact_matches(NEW) THEN
  RAISE EXCEPTION 'procurement command success requires its actual original fact' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_supplier_invoice_allocation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
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
 used:=invoice_receipt_occupied(NEW.tenant_id,NEW.receipt_line_id);
 IF used+NEW.quantity>receipt_line.received_quantity THEN RAISE EXCEPTION 'accepted receipt quantity already allocated' USING ERRCODE='23514'; END IF;
 SELECT coalesce(sum(quantity),0) INTO used FROM inventory_supplier_invoice_allocations WHERE tenant_id=NEW.tenant_id AND invoice_line_id=NEW.invoice_line_id;
 IF used+NEW.quantity>invoice_line.invoiced_quantity THEN RAISE EXCEPTION 'invoice allocation exceeds its recorded quantity' USING ERRCODE='23514'; END IF;
 NEW.created_at=clock_timestamp(); RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_invoice_reconciliation(),guard_invoice_allocation_effect(),require_invoice_reconciliation_complete() FROM PUBLIC;
