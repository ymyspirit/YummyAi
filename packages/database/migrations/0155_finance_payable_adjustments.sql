-- Corrections append evidence; no original bill, payment, procurement or stock row is rewritten.
CREATE TABLE finance_bill_adjustments (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), bill_id uuid NOT NULL,
 supplier_id uuid NOT NULL, currency text NOT NULL, kind text NOT NULL, amount_minor bigint NOT NULL,
 external_document_id text, evidence_reference text NOT NULL, occurred_at timestamptz NOT NULL, reason_code text NOT NULL,
 procurement_adjustment_id uuid, procurement_review_id uuid, input jsonb NOT NULL, balance_after jsonb NOT NULL,
 idempotency_key text NOT NULL, request_checksum text NOT NULL, recorded_by uuid NOT NULL REFERENCES app_users(id), recorded_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT finance_bill_adjustment_bill_fk FOREIGN KEY(tenant_id,bill_id) REFERENCES finance_payable_bills(tenant_id,id),
 CONSTRAINT finance_bill_adjustment_supplier_fk FOREIGN KEY(tenant_id,supplier_id) REFERENCES fulfillment_suppliers(tenant_id,id),
 CONSTRAINT finance_bill_adjustment_source_fk FOREIGN KEY(tenant_id,procurement_adjustment_id) REFERENCES inventory_invoice_reconciliations(tenant_id,id),
 CONSTRAINT finance_bill_adjustment_review_fk FOREIGN KEY(tenant_id,procurement_review_id) REFERENCES inventory_invoice_reconciliations(tenant_id,id),
 CONSTRAINT finance_bill_adjustment_kind CHECK(kind IN ('credit','debit','source_acknowledgement','void')),
 CONSTRAINT finance_bill_adjustment_money CHECK(amount_minor BETWEEN 0 AND 9007199254740991 AND finance_minor_digits_20260917(currency) IS NOT NULL)
);
CREATE UNIQUE INDEX finance_bill_adjustment_scope ON finance_bill_adjustments(tenant_id,id);
CREATE UNIQUE INDEX finance_bill_adjustment_key ON finance_bill_adjustments(tenant_id,idempotency_key);
CREATE UNIQUE INDEX finance_bill_adjustment_document ON finance_bill_adjustments(tenant_id,supplier_id,kind,external_document_id) WHERE external_document_id IS NOT NULL;
CREATE UNIQUE INDEX finance_bill_adjustment_source_once ON finance_bill_adjustments(tenant_id,procurement_adjustment_id) WHERE procurement_adjustment_id IS NOT NULL;
CREATE UNIQUE INDEX finance_bill_adjustment_void_once ON finance_bill_adjustments(tenant_id,bill_id) WHERE kind='void';
CREATE INDEX finance_bill_adjustment_bill ON finance_bill_adjustments(tenant_id,bill_id);
CREATE TABLE finance_payment_adjustments (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), payment_id uuid NOT NULL,
 supplier_id uuid NOT NULL, currency text NOT NULL, kind text NOT NULL, amount_minor bigint NOT NULL,
 external_document_id text, evidence_reference text NOT NULL, occurred_at timestamptz NOT NULL, reason_code text NOT NULL,
 input jsonb NOT NULL, balance_after jsonb NOT NULL, idempotency_key text NOT NULL, request_checksum text NOT NULL,
 recorded_by uuid NOT NULL REFERENCES app_users(id), recorded_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT finance_payment_adjustment_payment_fk FOREIGN KEY(tenant_id,payment_id) REFERENCES finance_payable_payments(tenant_id,id),
 CONSTRAINT finance_payment_adjustment_supplier_fk FOREIGN KEY(tenant_id,supplier_id) REFERENCES fulfillment_suppliers(tenant_id,id),
 CONSTRAINT finance_payment_adjustment_kind CHECK(kind IN ('refund','void')),
 CONSTRAINT finance_payment_adjustment_money CHECK(amount_minor BETWEEN 1 AND 9007199254740991 AND finance_minor_digits_20260917(currency) IS NOT NULL)
);
CREATE UNIQUE INDEX finance_payment_adjustment_scope ON finance_payment_adjustments(tenant_id,id);
CREATE UNIQUE INDEX finance_payment_adjustment_key ON finance_payment_adjustments(tenant_id,idempotency_key);
CREATE UNIQUE INDEX finance_payment_adjustment_document ON finance_payment_adjustments(tenant_id,supplier_id,external_document_id) WHERE external_document_id IS NOT NULL;
CREATE UNIQUE INDEX finance_payment_adjustment_void_once ON finance_payment_adjustments(tenant_id,payment_id) WHERE kind='void';
CREATE INDEX finance_payment_adjustment_payment ON finance_payment_adjustments(tenant_id,payment_id);
--> statement-breakpoint
-- VOLATILE ensures each guard also sees preceding rows of a multi-row INSERT.
CREATE FUNCTION finance_payables_bill_balance(t uuid,b uuid) RETURNS jsonb
LANGUAGE sql VOLATILE SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('amountMinor',p.amount_minor,'creditMinor',a.credit,'debitMinor',a.debit,'voidedMinor',a.voided,
  'netAmountMinor',p.amount_minor::numeric+a.debit-a.credit-a.voided,'allocatedMinor',u.used,
  'outstandingMinor',p.amount_minor::numeric+a.debit-a.credit-a.voided-u.used,
  'lifecycle',CASE WHEN a.has_void THEN 'voided' WHEN p.amount_minor::numeric+a.debit-a.credit=0 THEN 'fully_credited' ELSE 'active' END)
 FROM finance_payable_bills p
 CROSS JOIN LATERAL (SELECT coalesce(sum(amount_minor) FILTER(WHERE kind='credit'),0)::numeric credit,
  coalesce(sum(amount_minor) FILTER(WHERE kind='debit'),0)::numeric debit,
  coalesce(sum(amount_minor) FILTER(WHERE kind='void'),0)::numeric voided,coalesce(bool_or(kind='void'),false) has_void
  FROM finance_bill_adjustments WHERE tenant_id=p.tenant_id AND bill_id=p.id) a
 CROSS JOIN LATERAL (SELECT coalesce(sum(x.amount_minor::numeric),0) used FROM finance_payment_allocations x
  WHERE x.tenant_id=p.tenant_id AND x.bill_id=p.id AND NOT EXISTS(SELECT 1 FROM finance_allocation_releases r WHERE r.tenant_id=x.tenant_id AND r.allocation_id=x.id)) u
 WHERE p.tenant_id=t AND p.id=b
$$;
CREATE FUNCTION finance_payables_payment_balance(t uuid,p uuid) RETURNS jsonb
LANGUAGE sql VOLATILE SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('amountMinor',r.amount_minor,'refundedMinor',a.refunded,'voidedMinor',a.voided,
  'netAmountMinor',r.amount_minor::numeric-a.refunded-a.voided,'allocatedMinor',u.used,
  'unallocatedMinor',r.amount_minor::numeric-a.refunded-a.voided-u.used,
  'lifecycle',CASE WHEN a.has_void THEN 'voided' WHEN r.amount_minor::numeric-a.refunded=0 THEN 'fully_refunded' ELSE 'active' END)
 FROM finance_payable_payments r
 CROSS JOIN LATERAL (SELECT coalesce(sum(amount_minor) FILTER(WHERE kind='refund'),0)::numeric refunded,
  coalesce(sum(amount_minor) FILTER(WHERE kind='void'),0)::numeric voided,coalesce(bool_or(kind='void'),false) has_void
  FROM finance_payment_adjustments WHERE tenant_id=r.tenant_id AND payment_id=r.id) a
 CROSS JOIN LATERAL (SELECT coalesce(sum(x.amount_minor::numeric),0) used FROM finance_payment_allocations x
  WHERE x.tenant_id=r.tenant_id AND x.payment_id=r.id AND NOT EXISTS(SELECT 1 FROM finance_allocation_releases z WHERE z.tenant_id=x.tenant_id AND z.allocation_id=x.id)) u
 WHERE r.tenant_id=t AND r.id=p
$$;
--> statement-breakpoint
CREATE FUNCTION guard_finance_payable_adjustment() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE bill finance_payable_bills%ROWTYPE; payment finance_payable_payments%ROWTYPE;
 source inventory_invoice_reconciliations%ROWTYPE; review inventory_invoice_reconciliations%ROWTYPE;
 proof inventory_supplier_invoice_requests%ROWTYPE; inv inventory_supplier_invoices%ROWTYPE;
 current_balance jsonb; expected_balance jsonb; expected_input jsonb; op text; target_id uuid;
 current_net numeric; next_net numeric; used numeric; credits numeric; debits numeric; voided numeric; refunded numeric;
 source_amount numeric; normalized_kind text; lifecycle text; input_kind text;
BEGIN
 NEW.recorded_at:=date_trunc('milliseconds',clock_timestamp());
 IF NEW.id::text !~ '^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
  OR NEW.recorded_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid
  OR NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid THEN
  RAISE EXCEPTION 'finance_payables_adjustment_authority_invalid' USING ERRCODE='23514'; END IF;
 IF NEW.idempotency_key<>finance_source_entry_trim(NEW.idempotency_key) OR finance_source_entry_utf16_length(NEW.idempotency_key) NOT BETWEEN 8 AND 200
  OR NEW.request_checksum !~ '^[a-f0-9]{64}$' OR jsonb_typeof(NEW.input) IS DISTINCT FROM 'object'
  OR jsonb_typeof(NEW.input->'expectedNetAmountMinor') IS DISTINCT FROM 'number'
  OR coalesce(NEW.input->>'expectedNetAmountMinor','') !~ '^[0-9]+$'
  OR (NEW.input->>'expectedNetAmountMinor')::numeric NOT BETWEEN 0 AND 9007199254740991 THEN
  RAISE EXCEPTION 'finance_payables_adjustment_input_invalid' USING ERRCODE='23514'; END IF;
 IF NOT isfinite(NEW.occurred_at) OR NEW.occurred_at<'0001-01-01T00:00:00Z' OR NEW.occurred_at>='10000-01-01T00:00:00Z'
  OR date_trunc('milliseconds',NEW.occurred_at)<>NEW.occurred_at OR NEW.reason_code !~ '^[A-Z0-9][A-Z0-9._-]{0,99}$'
  OR NEW.evidence_reference<>finance_source_entry_trim(NEW.evidence_reference)
  OR finance_source_entry_utf16_length(NEW.evidence_reference) NOT BETWEEN 1 AND 2000 OR NEW.evidence_reference ~ U&'[\0001-\001F\007F]'
  OR (NEW.external_document_id IS NOT NULL AND (NEW.external_document_id<>finance_source_entry_trim(NEW.external_document_id)
   OR finance_source_entry_utf16_length(NEW.external_document_id) NOT BETWEEN 1 AND 160 OR NEW.external_document_id ~ U&'[\0001-\001F\007F]')) THEN
  RAISE EXCEPTION 'finance_payables_adjustment_evidence_invalid' USING ERRCODE='23514'; END IF;
 input_kind:=NEW.input->>'kind';
 IF TG_TABLE_NAME='finance_bill_adjustments' THEN
  op:='bill-adjustment'; target_id:=NEW.bill_id;
  SELECT * INTO bill FROM finance_payable_bills WHERE tenant_id=NEW.tenant_id AND id=NEW.bill_id;
  IF bill.id IS NULL OR bill.supplier_id<>NEW.supplier_id OR bill.currency<>NEW.currency THEN
   RAISE EXCEPTION 'finance_payables_adjustment_scope_invalid' USING ERRCODE='23514'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('finance-payables-scope:'||NEW.tenant_id||':'||bill.supplier_id||':'||bill.currency,0));
  IF bill.procurement_invoice_id IS NOT NULL THEN
   SELECT * INTO inv FROM inventory_supplier_invoices WHERE tenant_id=NEW.tenant_id AND id=bill.procurement_invoice_id;
   PERFORM pg_advisory_xact_lock(hashtextextended('procurement-order:'||NEW.tenant_id||':'||inv.purchase_order_id,0));
  END IF;
  current_balance:=finance_payables_bill_balance(NEW.tenant_id,bill.id);
  IF current_balance->>'lifecycle'='voided' THEN RAISE EXCEPTION 'finance_payables_bill_voided' USING ERRCODE='23514'; END IF;
  current_net:=(current_balance->>'netAmountMinor')::numeric; used:=(current_balance->>'allocatedMinor')::numeric;
  credits:=(current_balance->>'creditMinor')::numeric; debits:=(current_balance->>'debitMinor')::numeric; voided:=(current_balance->>'voidedMinor')::numeric;
  IF input_kind='procurement_sync' THEN
   expected_input:=jsonb_build_object('kind','procurement_sync','expectedNetAmountMinor',current_net,'idempotencyKey',NEW.idempotency_key,
    'procurementAdjustmentId',NEW.procurement_adjustment_id,'procurementReviewId',NEW.procurement_review_id);
   SELECT * INTO source FROM inventory_invoice_reconciliations WHERE tenant_id=NEW.tenant_id AND id=NEW.procurement_adjustment_id;
   SELECT * INTO review FROM inventory_invoice_reconciliations WHERE tenant_id=NEW.tenant_id AND id=NEW.procurement_review_id;
   SELECT * INTO proof FROM inventory_supplier_invoice_requests WHERE tenant_id=NEW.tenant_id AND id=bill.procurement_proof_id;
   IF bill.kind<>'procurement_invoice' OR source.id IS NULL OR review.id IS NULL OR proof.id IS NULL
    OR finance_payable_bill_source_status(NEW.tenant_id,bill.id)='source_unavailable'
    OR source.action<>'adjustment_record' OR review.action<>'adjustment_review' OR review.input->>'decision' IS DISTINCT FROM 'approved'
    OR review.adjustment_id IS DISTINCT FROM source.id OR review.input->>'adjustmentId' IS DISTINCT FROM source.id::text
    OR source.invoice_id<>bill.procurement_invoice_id OR review.invoice_id<>source.invoice_id
    OR source.original_proof_id<>bill.procurement_proof_id OR review.original_proof_id<>source.original_proof_id
    OR source.purchase_order_id<>inv.purchase_order_id OR review.purchase_order_id<>source.purchase_order_id
    OR source.purchase_order_version_id<>proof.purchase_order_version_id OR review.purchase_order_version_id<>source.purchase_order_version_id
    OR source.supplier_id<>bill.supplier_id OR review.supplier_id<>source.supplier_id
    OR source.input->'document'->>'currency' IS DISTINCT FROM bill.currency OR NEW.reason_code<>'PROCUREMENT_APPROVED'
    OR NOT finance_source_date_supported(source.input->'document'->>'issuedAt') THEN
    RAISE EXCEPTION 'finance_payables_procurement_adjustment_source_invalid' USING ERRCODE='23514'; END IF;
   SELECT sum((line->>'amountMinor')::numeric) INTO source_amount FROM jsonb_array_elements(source.input->'lines') line;
   normalized_kind:=CASE WHEN source_amount=0 THEN 'source_acknowledgement' WHEN source.input->'document'->>'kind'='credit_note' THEN 'credit' ELSE 'debit' END;
   IF source_amount IS NULL OR source_amount NOT BETWEEN 0 AND 9007199254740991 OR NEW.kind<>normalized_kind OR NEW.amount_minor<>source_amount
    OR NEW.external_document_id IS DISTINCT FROM source.input->'document'->>'number'
    OR NEW.evidence_reference IS DISTINCT FROM source.input->'document'->>'evidenceReference'
    OR NEW.occurred_at IS DISTINCT FROM (source.input->'document'->>'issuedAt')::timestamptz THEN
    RAISE EXCEPTION 'finance_payables_procurement_adjustment_binding_invalid' USING ERRCODE='23514'; END IF;
  ELSE
   IF NEW.procurement_adjustment_id IS NOT NULL OR NEW.procurement_review_id IS NOT NULL OR input_kind IS DISTINCT FROM NEW.kind
    OR NEW.kind NOT IN ('credit','debit','void') OR (bill.kind='procurement_invoice' AND NEW.kind<>'void') THEN
    RAISE EXCEPTION 'finance_payables_procurement_adjustment_required' USING ERRCODE='23514'; END IF;
   expected_input:=jsonb_build_object('kind',NEW.kind,'expectedNetAmountMinor',current_net,'idempotencyKey',NEW.idempotency_key,
    'evidenceReference',NEW.evidence_reference,'occurredAt',to_char(NEW.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'reasonCode',NEW.reason_code);
   IF NEW.kind<>'void' THEN
    expected_input:=expected_input||jsonb_build_object('amountMinor',NEW.amount_minor,'externalDocumentId',NEW.external_document_id);
    IF NEW.amount_minor<=0 OR NEW.external_document_id IS NULL THEN RAISE EXCEPTION 'finance_payables_adjustment_amount_invalid' USING ERRCODE='23514'; END IF;
   ELSIF NEW.external_document_id IS NOT NULL OR NEW.amount_minor<>current_net OR used<>0
    OR (bill.kind='procurement_invoice' AND (current_net<>0 OR finance_payable_bill_source_status(NEW.tenant_id,bill.id)<>'current')) THEN
    RAISE EXCEPTION 'finance_payables_bill_void_invalid' USING ERRCODE='23514'; END IF;
  END IF;
  IF NEW.kind='credit' THEN credits:=credits+NEW.amount_minor;
   ELSIF NEW.kind='debit' THEN debits:=debits+NEW.amount_minor;
   ELSIF NEW.kind='void' THEN voided:=voided+NEW.amount_minor; END IF;
  next_net:=bill.amount_minor::numeric+debits-credits-voided;
  IF next_net NOT BETWEEN 0 AND 9007199254740991 OR credits>9007199254740991 OR debits>9007199254740991 OR used>next_net THEN
   RAISE EXCEPTION 'finance_payables_adjustment_capacity_exceeded' USING ERRCODE='23514'; END IF;
  lifecycle:=CASE WHEN NEW.kind='void' THEN 'voided' WHEN next_net=0 THEN 'fully_credited' ELSE 'active' END;
  expected_balance:=jsonb_build_object('amountMinor',bill.amount_minor,'creditMinor',credits,'debitMinor',debits,'voidedMinor',voided,
   'netAmountMinor',next_net,'allocatedMinor',used,'outstandingMinor',next_net-used,'lifecycle',lifecycle);
 ELSE
  op:='payment-adjustment'; target_id:=NEW.payment_id;
  SELECT * INTO payment FROM finance_payable_payments WHERE tenant_id=NEW.tenant_id AND id=NEW.payment_id;
  IF payment.id IS NULL OR payment.supplier_id<>NEW.supplier_id OR payment.currency<>NEW.currency THEN
   RAISE EXCEPTION 'finance_payables_adjustment_scope_invalid' USING ERRCODE='23514'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('finance-payables-scope:'||NEW.tenant_id||':'||payment.supplier_id||':'||payment.currency,0));
  current_balance:=finance_payables_payment_balance(NEW.tenant_id,payment.id);
  IF current_balance->>'lifecycle'='voided' THEN RAISE EXCEPTION 'finance_payables_payment_voided' USING ERRCODE='23514'; END IF;
  current_net:=(current_balance->>'netAmountMinor')::numeric; used:=(current_balance->>'allocatedMinor')::numeric;
  refunded:=(current_balance->>'refundedMinor')::numeric; voided:=(current_balance->>'voidedMinor')::numeric;
  IF input_kind IS DISTINCT FROM NEW.kind OR NEW.kind NOT IN ('refund','void') THEN
   RAISE EXCEPTION 'finance_payables_adjustment_input_invalid' USING ERRCODE='23514'; END IF;
  expected_input:=jsonb_build_object('kind',NEW.kind,'expectedNetAmountMinor',current_net,'idempotencyKey',NEW.idempotency_key,
   'evidenceReference',NEW.evidence_reference,'occurredAt',to_char(NEW.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'reasonCode',NEW.reason_code);
  IF NEW.kind='refund' THEN
   IF NEW.occurred_at<payment.paid_at THEN RAISE EXCEPTION 'finance_payables_refund_date_invalid' USING ERRCODE='23514'; END IF;
   IF NEW.external_document_id IS NULL THEN RAISE EXCEPTION 'finance_payables_adjustment_evidence_invalid' USING ERRCODE='23514'; END IF;
   expected_input:=expected_input||jsonb_build_object('amountMinor',NEW.amount_minor,'externalDocumentId',NEW.external_document_id);
   refunded:=refunded+NEW.amount_minor;
  ELSE
   IF NEW.external_document_id IS NOT NULL OR NEW.amount_minor<>current_net OR refunded<>0 OR used<>0 THEN
    RAISE EXCEPTION 'finance_payables_payment_void_invalid' USING ERRCODE='23514'; END IF;
   voided:=voided+NEW.amount_minor;
  END IF;
  next_net:=payment.amount_minor::numeric-refunded-voided;
  IF next_net NOT BETWEEN 0 AND 9007199254740991 OR used>next_net THEN
   RAISE EXCEPTION 'finance_payables_adjustment_capacity_exceeded' USING ERRCODE='23514'; END IF;
  lifecycle:=CASE WHEN NEW.kind='void' THEN 'voided' WHEN next_net=0 THEN 'fully_refunded' ELSE 'active' END;
  expected_balance:=jsonb_build_object('amountMinor',payment.amount_minor,'refundedMinor',refunded,'voidedMinor',voided,
   'netAmountMinor',next_net,'allocatedMinor',used,'unallocatedMinor',next_net-used,'lifecycle',lifecycle);
 END IF;
 IF NEW.input->'expectedNetAmountMinor' IS DISTINCT FROM to_jsonb(current_net) THEN
  RAISE EXCEPTION 'finance_payables_adjustment_balance_changed' USING ERRCODE='23514'; END IF;
 IF NEW.input IS DISTINCT FROM expected_input OR NEW.request_checksum IS DISTINCT FROM finance_payables_checksum(op,target_id,expected_input) THEN
  RAISE EXCEPTION 'finance_payables_adjustment_checksum_invalid' USING ERRCODE='23514'; END IF;
 IF NEW.balance_after IS DISTINCT FROM expected_balance THEN
  RAISE EXCEPTION 'finance_payables_adjustment_result_invalid' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION require_finance_payable_adjustment_audit() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE expected_action text; expected_type text; target_name text; target_id text; expected_metadata jsonb;
BEGIN
 IF TG_TABLE_NAME='finance_bill_adjustments' THEN
  expected_action:='finance.payables.bill_adjustment_recorded'; expected_type:='finance_bill_adjustment'; target_name:='billId'; target_id:=NEW.bill_id::text;
  expected_metadata:='{}'::jsonb;
 ELSE
  expected_action:='finance.payables.payment_adjustment_recorded'; expected_type:='finance_payment_adjustment'; target_name:='paymentId'; target_id:=NEW.payment_id::text;
  expected_metadata:='{}'::jsonb;
 END IF;
 expected_metadata:=expected_metadata||jsonb_build_object(target_name,target_id,'kind',NEW.kind,'supplierId',NEW.supplier_id,'currency',NEW.currency,'amountMinor',NEW.amount_minor);
 IF NOT EXISTS(SELECT 1 FROM audit_events a WHERE a.tenant_id=NEW.tenant_id AND a.entity_id=NEW.id AND a.entity_type=expected_type
  AND a.action=expected_action AND a.result='success' AND a.actor_user_id=NEW.recorded_by
  AND a.xmin::text=mod(txid_current()::numeric,4294967296)::text
  AND a.metadata @> expected_metadata
  AND (TG_TABLE_NAME<>'finance_bill_adjustments' OR (
   coalesce(a.metadata->'procurementAdjustmentId','null'::jsonb) IS NOT DISTINCT FROM (to_jsonb(NEW)->'procurement_adjustment_id')
   AND coalesce(a.metadata->'procurementReviewId','null'::jsonb) IS NOT DISTINCT FROM (to_jsonb(NEW)->'procurement_review_id')))) THEN
  RAISE EXCEPTION 'finance_payables_adjustment_atomic_audit_missing' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['finance_bill_adjustments','finance_payment_adjustments'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY %I ON %I USING(tenant_id=current_setting(''app.tenant_id'',true)::uuid) WITH CHECK(tenant_id=current_setting(''app.tenant_id'',true)::uuid)',name||'_tenant',name);
  EXECUTE format('GRANT SELECT,INSERT ON %I TO yummyai_app',name);
  EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION guard_finance_payable_adjustment()',name||'_guard',name);
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION prohibit_finance_payables_mutation()',name||'_immutable',name);
  EXECUTE format('CREATE CONSTRAINT TRIGGER %I AFTER INSERT ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_finance_payable_adjustment_audit()',name||'_closed',name);
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION finance_payables_bill_balance(uuid,uuid),finance_payables_payment_balance(uuid,uuid),guard_finance_payable_adjustment(),require_finance_payable_adjustment_audit() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finance_payables_bill_balance(uuid,uuid),finance_payables_payment_balance(uuid,uuid) TO yummyai_app;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION finance_payable_bill_source_status(t uuid,b uuid) RETURNS text
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,public AS $$
DECLARE bill finance_payable_bills%ROWTYPE; inv inventory_supplier_invoices%ROWTYPE;
 proof inventory_supplier_invoice_requests%ROWTYPE; po inventory_purchase_orders%ROWTYPE; latest_status text; latest_net text;
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
 IF EXISTS(SELECT 1 FROM inventory_invoice_reconciliations r WHERE r.tenant_id=t AND r.invoice_id=inv.id
   AND r.action='adjustment_review' AND r.input->>'decision'='approved'
   AND NOT EXISTS(SELECT 1 FROM finance_bill_adjustments a WHERE a.tenant_id=t AND a.bill_id=bill.id
    AND a.procurement_adjustment_id=r.adjustment_id AND a.procurement_review_id=r.id)) THEN RETURN 'source_adjusted'; END IF;
 IF EXISTS(SELECT 1 FROM inventory_invoice_reconciliations d WHERE d.tenant_id=t AND d.invoice_id=inv.id AND d.action='adjustment_record'
   AND NOT EXISTS(SELECT 1 FROM inventory_invoice_reconciliations r WHERE r.tenant_id=t AND r.invoice_id=inv.id AND r.adjustment_id=d.id AND r.action='adjustment_review'))
   THEN RETURN 'source_unreconciled'; END IF;
 SELECT balance->>'status',balance->>'netAmountMinor' INTO latest_status,latest_net FROM inventory_invoice_reconciliations WHERE tenant_id=t AND invoice_id=inv.id ORDER BY sequence DESC LIMIT 1;
 IF coalesce(latest_status,inv.status) NOT IN ('matched','fully_credited') THEN RETURN 'source_unreconciled'; END IF;
 IF coalesce(latest_net,inv.total_minor::text)::numeric IS DISTINCT FROM (finance_payables_bill_balance(t,bill.id)->>'netAmountMinor')::numeric THEN RETURN 'source_adjusted'; END IF;
 RETURN 'current';
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_finance_payables_row() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
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
    OR inv.invoice_number<>NEW.external_bill_id OR inv.issued_at<>NEW.issued_at THEN
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
   OR (finance_payables_payment_balance(NEW.tenant_id,payment.id)->>'unallocatedMinor')::numeric<NEW.amount_minor
   OR (finance_payables_bill_balance(NEW.tenant_id,bill.id)->>'outstandingMinor')::numeric<NEW.amount_minor THEN
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
