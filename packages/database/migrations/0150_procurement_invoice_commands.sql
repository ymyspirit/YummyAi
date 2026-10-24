-- Extend retained transport only; do not rewrite or infer historical 0149 facts.
CREATE UNIQUE INDEX supplier_invoice_request_tenant_id_unique ON inventory_supplier_invoice_requests(tenant_id,id);
ALTER TABLE inventory_procurement_commands ADD COLUMN invoice_result_proof_id uuid,
 ADD CONSTRAINT procurement_command_invoice_proof_fk FOREIGN KEY(tenant_id,invoice_result_proof_id) REFERENCES inventory_supplier_invoice_requests(tenant_id,id) ON DELETE RESTRICT;
ALTER TABLE inventory_procurement_commands DROP CONSTRAINT procurement_commands_kind, DROP CONSTRAINT procurement_commands_result;
ALTER TABLE inventory_procurement_commands
 ADD CONSTRAINT procurement_commands_kind CHECK(kind IN ('requisition_create','rfq_create','quote_record','purchase_create','supply_purchase_create','purchase_revise','purchase_review','invoice_record')
  AND operation=CASE WHEN kind='supply_purchase_create' THEN 'purchase_create' ELSE kind END
  AND ((kind IN ('requisition_create','purchase_create'))=(target_id IS NULL)) AND (target_id IS NULL OR substring(target_id::text from 15 for 1)='7')),
 ADD CONSTRAINT procurement_commands_result CHECK((status='succeeded')=(result_proof_id IS NOT NULL OR invoice_result_proof_id IS NOT NULL)
  AND (status='prepared')=(completed_at IS NULL) AND CASE WHEN kind='invoice_record' THEN result_proof_id IS NULL ELSE invoice_result_proof_id IS NULL END);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION procurement_command_fact_matches(c inventory_procurement_commands) RETURNS boolean LANGUAGE sql AS $$
 SELECT CASE WHEN c.kind='invoice_record' THEN EXISTS(SELECT 1 FROM inventory_supplier_invoice_requests p
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
  IF current_setting('app.user_id',true) IS DISTINCT FROM NEW.created_by::text OR NEW.status<>'prepared' OR NEW.result_proof_id IS NOT NULL OR NEW.invoice_result_proof_id IS NOT NULL
   OR NEW.completed_at IS NOT NULL OR NEW.acknowledged_at IS NOT NULL OR NEW.redacted_at IS NOT NULL OR NEW.encrypted_input IS NULL THEN
   RAISE EXCEPTION 'procurement command requires its actual actor and original preparation' USING ERRCODE='23514';
  END IF;
  NEW.created_at:=clock_timestamp(); NEW.expires_at:=NEW.created_at+interval '7 days';
  IF EXISTS(SELECT 1 FROM inventory_procurement_write_requests WHERE tenant_id=NEW.tenant_id AND operation=NEW.operation AND idempotency_key=NEW.request_key)
   OR NEW.kind='invoice_record' AND EXISTS(SELECT 1 FROM inventory_supplier_invoices WHERE tenant_id=NEW.tenant_id AND idempotency_key=NEW.request_key) THEN
   RAISE EXCEPTION 'an existing actual procurement cannot become a new prepared command' USING ERRCODE='23514';
  END IF;
  IF NEW.kind='rfq_create' AND NOT EXISTS(SELECT 1 FROM inventory_procurement_requisitions WHERE tenant_id=NEW.tenant_id AND id=NEW.target_id)
   OR NEW.kind='quote_record' AND NOT EXISTS(SELECT 1 FROM inventory_procurement_rfqs WHERE tenant_id=NEW.tenant_id AND id=NEW.target_id)
   OR NEW.kind IN ('purchase_revise','purchase_review','invoice_record') AND NOT EXISTS(SELECT 1 FROM inventory_purchase_orders WHERE tenant_id=NEW.tenant_id AND id=NEW.target_id)
   OR NEW.kind='supply_purchase_create' AND NOT EXISTS(SELECT 1 FROM product_supply_links WHERE tenant_id=NEW.tenant_id AND id=NEW.target_id) THEN
   RAISE EXCEPTION 'original procurement target missing' USING ERRCODE='23514';
  END IF;
 END IF;
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(OLD)-ARRAY['status','result_proof_id','invoice_result_proof_id','encrypted_input','completed_at','acknowledged_at','redacted_at']) IS DISTINCT FROM
    (to_jsonb(NEW)-ARRAY['status','result_proof_id','invoice_result_proof_id','encrypted_input','completed_at','acknowledged_at','redacted_at'])
   OR OLD.status<>'prepared' AND (OLD.status,OLD.result_proof_id,OLD.invoice_result_proof_id,OLD.completed_at) IS DISTINCT FROM (NEW.status,NEW.result_proof_id,NEW.invoice_result_proof_id,NEW.completed_at)
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
    OR NOT CASE WHEN NEW.kind='invoice_record' THEN EXISTS(SELECT 1 FROM inventory_supplier_invoice_requests p JOIN inventory_supplier_invoices i ON i.tenant_id=p.tenant_id AND i.id=p.invoice_id WHERE p.tenant_id=NEW.tenant_id AND p.id=NEW.invoice_result_proof_id AND p.xmin::text=xid_text AND i.creation_transaction_id=pg_current_xact_id()::text) ELSE EXISTS(SELECT 1 FROM inventory_procurement_write_requests p WHERE p.tenant_id=NEW.tenant_id AND p.id=NEW.result_proof_id AND p.xmin::text=xid_text) END) THEN
   RAISE EXCEPTION 'procurement command is not admitted to its actual transaction' USING ERRCODE='23514';
  END IF;
 END IF;
 IF NEW.status='succeeded' AND NOT procurement_command_fact_matches(NEW) THEN
  RAISE EXCEPTION 'procurement command success requires its actual original fact' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;

--> statement-breakpoint
-- Header admission takes the original key before the command row and PO lock.
-- Raw SQL and the API owner use the same ordering, including permanently bound keys.
CREATE OR REPLACE FUNCTION guard_supplier_invoice_creation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE command inventory_procurement_commands%ROWTYPE;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'supplier invoice facts are immutable' USING ERRCODE='23514'; END IF;
 IF NEW.created_by::text IS DISTINCT FROM current_setting('app.user_id',true) OR NEW.allocation_status IS NULL THEN
  RAISE EXCEPTION 'new supplier invoice requires its actual actor and allocation state' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('procurement-original:'||NEW.tenant_id::text||':invoice_record:'||NEW.idempotency_key,0));
 SELECT * INTO command FROM inventory_procurement_commands WHERE tenant_id=NEW.tenant_id AND operation='invoice_record' AND request_key=NEW.idempotency_key FOR UPDATE;
 IF command.id IS NOT NULL AND (command.kind<>'invoice_record' OR command.status<>'prepared' OR command.expires_at<=clock_timestamp()
  OR current_setting('app.procurement_command_id',true) IS DISTINCT FROM command.id::text OR command.created_by<>NEW.created_by OR command.target_id IS DISTINCT FROM NEW.purchase_order_id) THEN
  RAISE EXCEPTION 'prepared invoice must execute through its original command' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('procurement-invoice-idempotency:'||NEW.tenant_id::text||':'||NEW.idempotency_key,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('procurement-order:'||NEW.tenant_id::text||':'||NEW.purchase_order_id::text,0));
 NEW.creation_transaction_id:=pg_current_xact_id()::text;
 RETURN NEW;
END $$;
CREATE FUNCTION admit_prepared_supplier_invoice_fact() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE command inventory_procurement_commands%ROWTYPE;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('procurement-original:'||NEW.tenant_id::text||':invoice_record:'||NEW.idempotency_key,0));
 SELECT * INTO command FROM inventory_procurement_commands WHERE tenant_id=NEW.tenant_id AND operation='invoice_record' AND request_key=NEW.idempotency_key FOR UPDATE;
 IF command.id IS NOT NULL AND (command.kind<>'invoice_record' OR command.status<>'prepared' OR command.expires_at<=clock_timestamp()
  OR current_setting('app.procurement_command_id',true) IS DISTINCT FROM command.id::text OR command.created_by<>NEW.created_by
  OR command.request_checksum<>NEW.request_checksum OR command.target_id IS DISTINCT FROM NEW.purchase_order_id) THEN
  RAISE EXCEPTION 'prepared invoice proof must bind its actual original command' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION admit_prepared_supplier_invoice_fact() FROM PUBLIC;
CREATE TRIGGER supplier_invoice_command_admission BEFORE INSERT ON inventory_supplier_invoice_requests FOR EACH ROW EXECUTE FUNCTION admit_prepared_supplier_invoice_fact();
--> statement-breakpoint
CREATE FUNCTION require_supplier_invoice_command_outcome() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE command inventory_procurement_commands%ROWTYPE;
 xid_text text:=mod(pg_current_xact_id()::text::numeric,4294967296)::bigint::text;
BEGIN
 SELECT * INTO command FROM inventory_procurement_commands WHERE tenant_id=NEW.tenant_id AND operation='invoice_record' AND request_key=NEW.idempotency_key;
 IF command.id IS NOT NULL AND (command.kind<>'invoice_record' OR command.status<>'succeeded' OR command.invoice_result_proof_id IS DISTINCT FROM NEW.id
  OR command.result_proof_id IS NOT NULL OR command.created_by<>NEW.created_by OR command.target_id IS DISTINCT FROM NEW.purchase_order_id
  OR command.request_checksum<>NEW.request_checksum OR NOT EXISTS(SELECT 1 FROM inventory_procurement_commands c WHERE c.tenant_id=command.tenant_id AND c.id=command.id AND c.xmin::text=xid_text)
  OR NOT EXISTS(SELECT 1 FROM inventory_supplier_invoices i WHERE i.tenant_id=NEW.tenant_id AND i.id=NEW.invoice_id AND i.creation_transaction_id=pg_current_xact_id()::text)) THEN
  RAISE EXCEPTION 'invoice fact and actual original command outcome must commit together' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION require_supplier_invoice_command_outcome() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER supplier_invoice_command_outcome_required AFTER INSERT ON inventory_supplier_invoice_requests
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_supplier_invoice_command_outcome();
