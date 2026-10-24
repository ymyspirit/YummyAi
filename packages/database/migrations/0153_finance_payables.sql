-- Payment evidence and its allocation are separate from cost recognition.
-- Existing finance/procurement facts and balances are never rewritten here.
CREATE TABLE finance_payable_bills (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), supplier_id uuid NOT NULL,
 kind text NOT NULL, external_bill_id text NOT NULL, currency text NOT NULL, amount_minor bigint NOT NULL,
 issued_at timestamptz NOT NULL, due_at timestamptz, procurement_invoice_id uuid, procurement_proof_id uuid,
 idempotency_key text NOT NULL, request_checksum text NOT NULL, recorded_by uuid NOT NULL REFERENCES app_users(id),
 recorded_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT finance_payable_bill_supplier_fk FOREIGN KEY(tenant_id,supplier_id) REFERENCES fulfillment_suppliers(tenant_id,id),
 CONSTRAINT finance_payable_bill_invoice_fk FOREIGN KEY(tenant_id,procurement_invoice_id) REFERENCES inventory_supplier_invoices(tenant_id,id),
 CONSTRAINT finance_payable_bill_proof_fk FOREIGN KEY(tenant_id,procurement_proof_id) REFERENCES inventory_supplier_invoice_requests(tenant_id,id),
 CONSTRAINT finance_payable_bill_kind CHECK(kind IN ('factory_invoice','supplier_invoice','procurement_invoice') AND
  CASE WHEN kind='procurement_invoice' THEN procurement_invoice_id IS NOT NULL AND procurement_proof_id IS NOT NULL ELSE procurement_invoice_id IS NULL AND procurement_proof_id IS NULL END),
 CONSTRAINT finance_payable_bill_money CHECK(amount_minor BETWEEN 1 AND 9007199254740991 AND finance_minor_digits_20260917(currency) IS NOT NULL),
 CONSTRAINT finance_payable_bill_dates CHECK(isfinite(issued_at) AND issued_at>='0001-01-01T00:00:00Z' AND issued_at<'10000-01-01T00:00:00Z'
  AND date_trunc('milliseconds',issued_at)=issued_at AND (due_at IS NULL OR isfinite(due_at) AND due_at>=issued_at
   AND due_at<'10000-01-01T00:00:00Z' AND date_trunc('milliseconds',due_at)=due_at))
);
CREATE UNIQUE INDEX finance_payable_bill_scope ON finance_payable_bills(tenant_id,id);
CREATE UNIQUE INDEX finance_payable_bill_key ON finance_payable_bills(tenant_id,idempotency_key);
CREATE UNIQUE INDEX finance_payable_bill_external ON finance_payable_bills(tenant_id,supplier_id,external_bill_id);
CREATE UNIQUE INDEX finance_payable_bill_procurement ON finance_payable_bills(tenant_id,procurement_invoice_id) WHERE procurement_invoice_id IS NOT NULL;
CREATE INDEX finance_payable_bill_recent ON finance_payable_bills(tenant_id,recorded_at,id);
CREATE TABLE finance_payable_payments (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), supplier_id uuid NOT NULL,
 external_payment_id text NOT NULL, currency text NOT NULL, amount_minor bigint NOT NULL,
 paid_at timestamptz NOT NULL, method text NOT NULL, evidence_reference text NOT NULL,
 idempotency_key text NOT NULL, request_checksum text NOT NULL, recorded_by uuid NOT NULL REFERENCES app_users(id),
 recorded_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT finance_payable_payment_supplier_fk FOREIGN KEY(tenant_id,supplier_id) REFERENCES fulfillment_suppliers(tenant_id,id),
 CONSTRAINT finance_payable_payment_method CHECK(method IN ('bank_transfer','card','cash','other')),
 CONSTRAINT finance_payable_payment_money CHECK(amount_minor BETWEEN 1 AND 9007199254740991 AND finance_minor_digits_20260917(currency) IS NOT NULL),
 CONSTRAINT finance_payable_payment_date CHECK(isfinite(paid_at) AND paid_at>='0001-01-01T00:00:00Z' AND paid_at<'10000-01-01T00:00:00Z' AND date_trunc('milliseconds',paid_at)=paid_at)
);
CREATE UNIQUE INDEX finance_payable_payment_scope ON finance_payable_payments(tenant_id,id);
CREATE UNIQUE INDEX finance_payable_payment_key ON finance_payable_payments(tenant_id,idempotency_key);
CREATE UNIQUE INDEX finance_payable_payment_external ON finance_payable_payments(tenant_id,supplier_id,external_payment_id);
CREATE INDEX finance_payable_payment_recent ON finance_payable_payments(tenant_id,recorded_at,id);
CREATE TABLE finance_payment_allocation_batches (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), payment_id uuid NOT NULL,
 input jsonb NOT NULL, idempotency_key text NOT NULL, request_checksum text NOT NULL,
 creation_transaction_id text NOT NULL DEFAULT txid_current()::text,
 recorded_by uuid NOT NULL REFERENCES app_users(id), recorded_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT finance_payment_allocation_batch_payment_fk FOREIGN KEY(tenant_id,payment_id) REFERENCES finance_payable_payments(tenant_id,id)
);
CREATE UNIQUE INDEX finance_payment_allocation_batch_scope ON finance_payment_allocation_batches(tenant_id,id);
CREATE UNIQUE INDEX finance_payment_allocation_batch_key ON finance_payment_allocation_batches(tenant_id,idempotency_key);
CREATE TABLE finance_payment_allocations (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), batch_id uuid NOT NULL,
 payment_id uuid NOT NULL, bill_id uuid NOT NULL, supplier_id uuid NOT NULL, currency text NOT NULL, amount_minor bigint NOT NULL,
 recorded_by uuid NOT NULL REFERENCES app_users(id), recorded_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT finance_payment_allocation_batch_fk FOREIGN KEY(tenant_id,batch_id) REFERENCES finance_payment_allocation_batches(tenant_id,id),
 CONSTRAINT finance_payment_allocation_payment_fk FOREIGN KEY(tenant_id,payment_id) REFERENCES finance_payable_payments(tenant_id,id),
 CONSTRAINT finance_payment_allocation_bill_fk FOREIGN KEY(tenant_id,bill_id) REFERENCES finance_payable_bills(tenant_id,id),
 CONSTRAINT finance_payment_allocation_supplier_fk FOREIGN KEY(tenant_id,supplier_id) REFERENCES fulfillment_suppliers(tenant_id,id),
 CONSTRAINT finance_payment_allocation_money CHECK(amount_minor BETWEEN 1 AND 9007199254740991 AND finance_minor_digits_20260917(currency) IS NOT NULL)
);
CREATE UNIQUE INDEX finance_payment_allocation_scope ON finance_payment_allocations(tenant_id,id);
CREATE UNIQUE INDEX finance_payment_allocation_batch_bill ON finance_payment_allocations(tenant_id,batch_id,bill_id);
CREATE INDEX finance_payment_allocation_payment ON finance_payment_allocations(tenant_id,payment_id);
CREATE INDEX finance_payment_allocation_bill ON finance_payment_allocations(tenant_id,bill_id);
CREATE TABLE finance_allocation_releases (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), allocation_id uuid NOT NULL,
 reason_code text NOT NULL, idempotency_key text NOT NULL, request_checksum text NOT NULL,
 recorded_by uuid NOT NULL REFERENCES app_users(id), recorded_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT finance_allocation_release_allocation_fk FOREIGN KEY(tenant_id,allocation_id) REFERENCES finance_payment_allocations(tenant_id,id),
 CONSTRAINT finance_allocation_release_reason CHECK(reason_code ~ '^[A-Z0-9][A-Z0-9._-]{0,99}$')
);
CREATE UNIQUE INDEX finance_allocation_release_scope ON finance_allocation_releases(tenant_id,id);
CREATE UNIQUE INDEX finance_allocation_release_key ON finance_allocation_releases(tenant_id,idempotency_key);
CREATE UNIQUE INDEX finance_allocation_release_once ON finance_allocation_releases(tenant_id,allocation_id);
--> statement-breakpoint
CREATE FUNCTION finance_payables_checksum(op text,target_id uuid,value jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
 SELECT encode(sha256(convert_to(invoice_reconciliation_canonical(jsonb_build_object(
  'version',1,'operation',op,'targetId',target_id,'input',value)),'UTF8')),'hex')
$$;
CREATE FUNCTION finance_payable_bill_source_status(t uuid,b uuid) RETURNS text
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public AS $$
DECLARE bill finance_payable_bills%ROWTYPE; inv inventory_supplier_invoices%ROWTYPE;
 proof inventory_supplier_invoice_requests%ROWTYPE; po inventory_purchase_orders%ROWTYPE; latest_status text;
BEGIN
 SELECT * INTO bill FROM finance_payable_bills WHERE tenant_id=t AND id=b;
 IF bill.id IS NULL THEN RETURN 'source_unavailable'; END IF;
 IF bill.kind<>'procurement_invoice' THEN RETURN 'current'; END IF;
 SELECT * INTO inv FROM inventory_supplier_invoices WHERE tenant_id=t AND id=bill.procurement_invoice_id;
 SELECT * INTO proof FROM inventory_supplier_invoice_requests WHERE tenant_id=t AND id=bill.procurement_proof_id;
 SELECT * INTO po FROM inventory_purchase_orders WHERE tenant_id=t AND id=inv.purchase_order_id;
 IF inv.id IS NULL OR proof.id IS NULL OR po.id IS NULL OR inv.creation_transaction_id IS NULL OR inv.allocation_status IS NULL OR inv.allocation_status='legacy_unknown'
  OR proof.evidence_version<>1 OR proof.idempotency_key IS DISTINCT FROM inv.idempotency_key OR proof.created_by IS DISTINCT FROM inv.created_by
  OR proof.invoice_id<>inv.id OR proof.purchase_order_id<>po.id
  OR po.supplier_id<>bill.supplier_id OR inv.currency<>bill.currency OR inv.total_minor<>bill.amount_minor
  OR inv.invoice_number<>bill.external_bill_id OR inv.issued_at<>bill.issued_at THEN RETURN 'source_unavailable'; END IF;
 IF EXISTS(SELECT 1 FROM inventory_invoice_reconciliations WHERE tenant_id=t AND invoice_id=inv.id
   AND action='adjustment_review' AND input->>'decision'='approved') THEN RETURN 'source_adjusted'; END IF;
 IF EXISTS(SELECT 1 FROM inventory_invoice_reconciliations d WHERE d.tenant_id=t AND d.invoice_id=inv.id AND d.action='adjustment_record'
   AND NOT EXISTS(SELECT 1 FROM inventory_invoice_reconciliations r WHERE r.tenant_id=t AND r.invoice_id=inv.id AND r.adjustment_id=d.id AND r.action='adjustment_review'))
   THEN RETURN 'source_unreconciled'; END IF;
 SELECT balance->>'status' INTO latest_status FROM inventory_invoice_reconciliations WHERE tenant_id=t AND invoice_id=inv.id ORDER BY sequence DESC LIMIT 1;
 IF coalesce(latest_status,inv.status)<>'matched' THEN RETURN 'source_unreconciled'; END IF;
 RETURN 'current';
END $$;
CREATE FUNCTION finance_payables_used_payment(t uuid,p uuid) RETURNS numeric LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT coalesce(sum(a.amount_minor::numeric),0) FROM finance_payment_allocations a WHERE a.tenant_id=t AND a.payment_id=p
  AND NOT EXISTS(SELECT 1 FROM finance_allocation_releases r WHERE r.tenant_id=a.tenant_id AND r.allocation_id=a.id)
$$;
CREATE FUNCTION finance_payables_used_bill(t uuid,b uuid) RETURNS numeric LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT coalesce(sum(a.amount_minor::numeric),0) FROM finance_payment_allocations a WHERE a.tenant_id=t AND a.bill_id=b
  AND NOT EXISTS(SELECT 1 FROM finance_allocation_releases r WHERE r.tenant_id=a.tenant_id AND r.allocation_id=a.id)
$$;
--> statement-breakpoint
CREATE FUNCTION guard_finance_payables_row() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE value jsonb:=to_jsonb(NEW); body jsonb; batch finance_payment_allocation_batches%ROWTYPE;
 payment finance_payable_payments%ROWTYPE; bill finance_payable_bills%ROWTYPE; allocation finance_payment_allocations%ROWTYPE;
 inv inventory_supplier_invoices%ROWTYPE; proof inventory_supplier_invoice_requests%ROWTYPE; po inventory_purchase_orders%ROWTYPE;
 item jsonb; expected_amount numeric; expected_count integer; op text; target_id uuid;
BEGIN
 NEW.recorded_at:=date_trunc('milliseconds',clock_timestamp());
 IF NEW.id::text !~ '^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' OR NEW.recorded_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid
  OR NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid THEN
  RAISE EXCEPTION 'finance_payables_authority_invalid' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME<>'finance_payment_allocations' AND (length(value->>'idempotency_key') NOT BETWEEN 8 AND 200
  OR value->>'idempotency_key'<>btrim(value->>'idempotency_key') OR value->>'request_checksum' !~ '^[a-f0-9]{64}$') THEN
  RAISE EXCEPTION 'finance_payables_request_invalid' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='finance_payable_bills' THEN
  IF NEW.external_bill_id !~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$' THEN RAISE EXCEPTION 'finance_payables_reference_invalid' USING ERRCODE='23514'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('finance-payables-scope:'||NEW.tenant_id||':'||NEW.supplier_id||':'||NEW.currency,0));
  IF NEW.kind='procurement_invoice' THEN
   SELECT * INTO inv FROM inventory_supplier_invoices WHERE tenant_id=NEW.tenant_id AND id=NEW.procurement_invoice_id;
   PERFORM pg_advisory_xact_lock(hashtextextended('procurement-order:'||NEW.tenant_id||':'||inv.purchase_order_id,0));
   SELECT * INTO proof FROM inventory_supplier_invoice_requests WHERE tenant_id=NEW.tenant_id AND id=NEW.procurement_proof_id;
   SELECT * INTO po FROM inventory_purchase_orders WHERE tenant_id=NEW.tenant_id AND id=inv.purchase_order_id;
   IF inv.id IS NULL OR proof.id IS NULL OR po.id IS NULL OR inv.creation_transaction_id IS NULL OR inv.allocation_status IS NULL OR inv.allocation_status='legacy_unknown'
    OR proof.evidence_version<>1 OR proof.idempotency_key IS DISTINCT FROM inv.idempotency_key OR proof.created_by IS DISTINCT FROM inv.created_by
    OR proof.invoice_id<>inv.id OR proof.purchase_order_id<>po.id
    OR po.supplier_id<>NEW.supplier_id OR inv.currency<>NEW.currency OR inv.total_minor<>NEW.amount_minor
    OR inv.invoice_number<>NEW.external_bill_id OR inv.issued_at<>NEW.issued_at
    OR EXISTS(SELECT 1 FROM inventory_invoice_reconciliations WHERE tenant_id=NEW.tenant_id AND invoice_id=inv.id AND action='adjustment_review' AND input->>'decision'='approved') THEN
    RAISE EXCEPTION 'finance_payables_procurement_source_invalid' USING ERRCODE='23514'; END IF;
  END IF;
  op:='bill'; body:=jsonb_build_object('supplierId',NEW.supplier_id,'kind',NEW.kind,'externalBillId',NEW.external_bill_id,'currency',NEW.currency,
   'amountMinor',NEW.amount_minor,'issuedAt',to_char(NEW.issued_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   'dueAt',CASE WHEN NEW.due_at IS NULL THEN NULL ELSE to_char(NEW.due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
   'procurementInvoiceId',NEW.procurement_invoice_id,'idempotencyKey',NEW.idempotency_key);
 ELSIF TG_TABLE_NAME='finance_payable_payments' THEN
  IF NEW.external_payment_id !~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$' OR NEW.evidence_reference !~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$' THEN
   RAISE EXCEPTION 'finance_payables_reference_invalid' USING ERRCODE='23514'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('finance-payables-scope:'||NEW.tenant_id||':'||NEW.supplier_id||':'||NEW.currency,0));
  op:='payment'; body:=jsonb_build_object('supplierId',NEW.supplier_id,'externalPaymentId',NEW.external_payment_id,'currency',NEW.currency,
   'amountMinor',NEW.amount_minor,'paidAt',to_char(NEW.paid_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   'method',NEW.method,'evidenceReference',NEW.evidence_reference,'idempotencyKey',NEW.idempotency_key);
 ELSIF TG_TABLE_NAME='finance_payment_allocation_batches' THEN
  SELECT * INTO payment FROM finance_payable_payments WHERE tenant_id=NEW.tenant_id AND id=NEW.payment_id;
  IF jsonb_typeof(NEW.input) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'finance_payables_batch_invalid' USING ERRCODE='23514'; END IF;
  IF payment.id IS NULL OR NEW.creation_transaction_id<>txid_current()::text
   OR jsonb_typeof(NEW.input->'paymentId') IS DISTINCT FROM 'string' OR jsonb_typeof(NEW.input->'idempotencyKey') IS DISTINCT FROM 'string'
   OR NEW.input->>'paymentId' IS DISTINCT FROM NEW.payment_id::text OR NEW.input->>'idempotencyKey' IS DISTINCT FROM NEW.idempotency_key
   OR (SELECT array_agg(key ORDER BY key COLLATE "C") FROM jsonb_object_keys(NEW.input) key) IS DISTINCT FROM ARRAY['allocations','idempotencyKey','paymentId']::text[]
   OR jsonb_typeof(NEW.input->'allocations') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'finance_payables_batch_invalid' USING ERRCODE='23514'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('finance-payables-scope:'||NEW.tenant_id||':'||payment.supplier_id||':'||payment.currency,0));
  expected_count:=jsonb_array_length(NEW.input->'allocations'); expected_amount:=0;
  IF expected_count NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'finance_payables_batch_invalid' USING ERRCODE='23514'; END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(NEW.input->'allocations') LOOP
   IF jsonb_typeof(item) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'finance_payables_batch_item_invalid' USING ERRCODE='23514'; END IF;
   IF (SELECT array_agg(key ORDER BY key COLLATE "C") FROM jsonb_object_keys(item) key) IS DISTINCT FROM ARRAY['amountMinor','billId']::text[]
    OR jsonb_typeof(item->'billId') IS DISTINCT FROM 'string'
    OR jsonb_typeof(item->'amountMinor') IS DISTINCT FROM 'number' OR item->>'amountMinor' !~ '^[0-9]+$'
    OR (item->>'amountMinor')::numeric NOT BETWEEN 1 AND 9007199254740991
    OR item->>'billId' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' THEN
    RAISE EXCEPTION 'finance_payables_batch_item_invalid' USING ERRCODE='23514'; END IF;
   expected_amount:=expected_amount+(item->>'amountMinor')::numeric;
  END LOOP;
  IF expected_amount>9007199254740991 OR (SELECT count(DISTINCT x->>'billId') FROM jsonb_array_elements(NEW.input->'allocations') x)<>expected_count THEN
   RAISE EXCEPTION 'finance_payables_batch_total_invalid' USING ERRCODE='23514'; END IF;
  op:='allocation'; body:=NEW.input;
 ELSIF TG_TABLE_NAME='finance_payment_allocations' THEN
  SELECT * INTO batch FROM finance_payment_allocation_batches WHERE tenant_id=NEW.tenant_id AND id=NEW.batch_id;
  SELECT * INTO payment FROM finance_payable_payments WHERE tenant_id=NEW.tenant_id AND id=NEW.payment_id;
  SELECT * INTO bill FROM finance_payable_bills WHERE tenant_id=NEW.tenant_id AND id=NEW.bill_id;
  IF batch.id IS NULL OR payment.id IS NULL OR bill.id IS NULL OR batch.creation_transaction_id<>txid_current()::text
   OR batch.payment_id<>payment.id OR batch.recorded_by<>NEW.recorded_by OR payment.supplier_id<>bill.supplier_id OR payment.currency<>bill.currency
   OR NEW.supplier_id<>payment.supplier_id OR NEW.currency<>payment.currency
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(batch.input->'allocations') x WHERE x->>'billId'=NEW.bill_id::text AND (x->>'amountMinor')::numeric=NEW.amount_minor) THEN
   RAISE EXCEPTION 'finance_payables_allocation_source_invalid' USING ERRCODE='23514'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('finance-payables-scope:'||NEW.tenant_id||':'||NEW.supplier_id||':'||NEW.currency,0));
  IF bill.procurement_invoice_id IS NOT NULL THEN
   SELECT * INTO inv FROM inventory_supplier_invoices WHERE tenant_id=NEW.tenant_id AND id=bill.procurement_invoice_id;
   PERFORM pg_advisory_xact_lock(hashtextextended('procurement-order:'||NEW.tenant_id||':'||inv.purchase_order_id,0));
  END IF;
  IF finance_payable_bill_source_status(NEW.tenant_id,bill.id)<>'current'
   OR finance_payables_used_payment(NEW.tenant_id,payment.id)+NEW.amount_minor>payment.amount_minor
   OR finance_payables_used_bill(NEW.tenant_id,bill.id)+NEW.amount_minor>bill.amount_minor THEN
   RAISE EXCEPTION 'finance_payables_allocation_exceeds_evidence' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 ELSE
  SELECT * INTO allocation FROM finance_payment_allocations WHERE tenant_id=NEW.tenant_id AND id=NEW.allocation_id;
  IF allocation.id IS NULL THEN RAISE EXCEPTION 'finance_payables_allocation_missing' USING ERRCODE='23514'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('finance-payables-scope:'||NEW.tenant_id||':'||allocation.supplier_id||':'||allocation.currency,0));
  op:='release'; target_id:=NEW.allocation_id;
  body:=jsonb_build_object('reasonCode',NEW.reason_code,'idempotencyKey',NEW.idempotency_key);
 END IF;
 IF NEW.request_checksum IS DISTINCT FROM finance_payables_checksum(op,target_id,body) THEN
  RAISE EXCEPTION 'finance_payables_checksum_invalid' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION require_finance_payables_closed_transaction() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE expected_action text; expected_type text; expected_count integer; actual_count integer;
BEGIN
 IF TG_TABLE_NAME='finance_payment_allocation_batches' THEN
  expected_count:=jsonb_array_length(NEW.input->'allocations');
  SELECT count(*) INTO actual_count FROM finance_payment_allocations WHERE tenant_id=NEW.tenant_id AND batch_id=NEW.id;
  IF expected_count<>actual_count THEN RAISE EXCEPTION 'finance_payables_batch_incomplete' USING ERRCODE='23514'; END IF;
  expected_action:='finance.payables.payment_allocated'; expected_type:='finance_payment_allocation_batch';
 ELSIF TG_TABLE_NAME='finance_payable_bills' THEN expected_action:='finance.payables.bill_recorded'; expected_type:='finance_payable_bill';
 ELSIF TG_TABLE_NAME='finance_payable_payments' THEN expected_action:='finance.payables.payment_recorded'; expected_type:='finance_payable_payment';
 ELSE expected_action:='finance.payables.allocation_released'; expected_type:='finance_allocation_release'; END IF;
 IF NOT EXISTS(SELECT 1 FROM audit_events a WHERE a.tenant_id=NEW.tenant_id AND a.entity_id=NEW.id AND a.entity_type=expected_type
  AND a.action=expected_action AND a.result='success' AND a.actor_user_id=NEW.recorded_by
  AND a.xmin::text=mod(txid_current()::numeric,4294967296)::text) THEN
  RAISE EXCEPTION 'finance_payables_atomic_audit_missing' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE FUNCTION prohibit_finance_payables_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'finance_payables_immutable' USING ERRCODE='23514'; END $$;
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['finance_payable_bills','finance_payable_payments','finance_payment_allocation_batches','finance_payment_allocations','finance_allocation_releases'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY %I ON %I USING(tenant_id=current_setting(''app.tenant_id'',true)::uuid) WITH CHECK(tenant_id=current_setting(''app.tenant_id'',true)::uuid)',name||'_tenant',name);
  EXECUTE format('GRANT SELECT,INSERT ON %I TO yummyai_app',name);
  EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION guard_finance_payables_row()',name||'_guard',name);
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION prohibit_finance_payables_mutation()',name||'_immutable',name);
  IF name<>'finance_payment_allocations' THEN
   EXECUTE format('CREATE CONSTRAINT TRIGGER %I AFTER INSERT ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_finance_payables_closed_transaction()',name||'_closed',name);
  END IF;
 END LOOP;
END $$;
