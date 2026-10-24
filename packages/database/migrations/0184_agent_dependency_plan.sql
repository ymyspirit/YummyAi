-- New opt-in dependency identities. Old sealed proposals and business ledgers stay owned by their original modules.
CREATE TABLE agent_dependency_plans (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES organizations(id),owner_id uuid NOT NULL REFERENCES app_users(id),request_id uuid NOT NULL,
 version text NOT NULL DEFAULT 'erp-agent-dependency-plan-v1',kind text NOT NULL DEFAULT 'procurement_invoice_to_finance_bill',request_checksum text NOT NULL,
 origin_ceiling jsonb NOT NULL,parent_agent_command_id uuid NOT NULL,child_request_id uuid NOT NULL,child_native_key uuid NOT NULL,due_at timestamptz,
 source_invoice_id uuid,source_checksum text,child_original_checksum text,child_preparation_request_checksum text,preparation_requested_at timestamptz,
 child_agent_command_id uuid,child_owner_command_id uuid,creation_transaction_id text,preparation_transaction_id text,link_transaction_id text,cancellation_transaction_id text,
 cancelled_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,
 CONSTRAINT agent_dependency_plans_tenant_id_unique UNIQUE(tenant_id,id),
 CONSTRAINT agent_dependency_plans_request_unique UNIQUE(tenant_id,owner_id,request_id),
 CONSTRAINT agent_dependency_plans_child_request_unique UNIQUE(tenant_id,owner_id,child_request_id),
 CONSTRAINT agent_dependency_plans_child_key_unique UNIQUE(tenant_id,child_native_key),
 CONSTRAINT agent_dependency_parent_fk FOREIGN KEY(tenant_id,parent_agent_command_id) REFERENCES agent_command_requests(tenant_id,id),
 CONSTRAINT agent_dependency_child_fk FOREIGN KEY(tenant_id,child_agent_command_id) REFERENCES agent_command_requests(tenant_id,id),
 CONSTRAINT agent_dependency_plans_version_check CHECK(version='erp-agent-dependency-plan-v1' AND kind='procurement_invoice_to_finance_bill'),
 CONSTRAINT agent_dependency_plans_hash_check CHECK(request_checksum~'^[a-f0-9]{64}$' AND(source_checksum IS NULL OR source_checksum~'^[a-f0-9]{64}$')
  AND(child_original_checksum IS NULL OR child_original_checksum~'^[a-f0-9]{64}$') AND(child_preparation_request_checksum IS NULL OR child_preparation_request_checksum~'^[a-f0-9]{64}$')),
 CONSTRAINT agent_dependency_plans_preparation_check CHECK((preparation_requested_at IS NULL AND source_invoice_id IS NULL AND source_checksum IS NULL AND child_original_checksum IS NULL AND child_preparation_request_checksum IS NULL AND preparation_transaction_id IS NULL)
  OR(preparation_requested_at IS NOT NULL AND source_invoice_id IS NOT NULL AND source_checksum IS NOT NULL AND child_original_checksum IS NOT NULL AND child_preparation_request_checksum IS NOT NULL AND preparation_transaction_id IS NOT NULL)),
 CONSTRAINT agent_dependency_plans_link_check CHECK((child_agent_command_id IS NULL OR preparation_requested_at IS NOT NULL) AND(child_owner_command_id IS NULL OR child_agent_command_id IS NOT NULL)),
 CONSTRAINT agent_dependency_plans_time_check CHECK(expires_at>created_at AND updated_at>=created_at AND(due_at IS NULL OR isfinite(due_at)
  AND due_at>='0001-01-01T00:00:00Z' AND due_at<'10000-01-01T00:00:00Z' AND date_trunc('milliseconds',due_at)=due_at))
);
CREATE INDEX agent_dependency_plans_owner_idx ON agent_dependency_plans(tenant_id,owner_id,id);
ALTER TABLE agent_dependency_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_dependency_plans FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_dependency_plans_tenant_policy ON agent_dependency_plans FOR ALL TO yummyai_app
 USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid))
 WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
GRANT SELECT,INSERT,UPDATE ON agent_dependency_plans TO yummyai_app;
--> statement-breakpoint
CREATE FUNCTION agent_dependency_checksum(value jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
 SELECT encode(sha256(convert_to(invoice_reconciliation_canonical(value),'UTF8')),'hex')
$$;
CREATE FUNCTION agent_dependency_actor(parent agent_dependency_plans,write_action boolean) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE actor agent_command_requests%ROWTYPE;
BEGIN
 actor.tenant_id:=parent.tenant_id;actor.owner_id:=parent.owner_id;actor.origin_ceiling:=parent.origin_ceiling;
 PERFORM agent_command_require_actor(actor,write_action);
END $$;
CREATE FUNCTION agent_dependency_write_authority(parent agent_dependency_plans) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE bit text;
BEGIN
 PERFORM agent_dependency_actor(parent,true);
 FOREACH bit IN ARRAY ARRAY['procurement:read','finance:read','finance:write'] LOOP
  IF integration_client_permission_rank(parent.tenant_id,parent.owner_id,bit)<1 OR(parent.origin_ceiling->'permissions'?bit) IS NOT TRUE THEN
   RAISE EXCEPTION 'agent_dependency_authority_required' USING ERRCODE='23514';END IF;
 END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION agent_dependency_check_references(parent agent_dependency_plans) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE predecessor agent_command_requests%ROWTYPE;child agent_command_requests%ROWTYPE;purchase inventory_procurement_commands%ROWTYPE;
 proof inventory_supplier_invoice_requests%ROWTYPE;invoice inventory_supplier_invoices%ROWTYPE;po inventory_purchase_orders%ROWTYPE;
 finance finance_commands%ROWTYPE;bill finance_payable_bills%ROWTYPE;source jsonb;original jsonb;source_time text;due_time text;owner_checksum text;
BEGIN
 SELECT * INTO predecessor FROM agent_command_requests WHERE tenant_id=parent.tenant_id AND id=parent.parent_agent_command_id FOR SHARE;
 IF NOT FOUND OR predecessor.owner_id IS DISTINCT FROM parent.owner_id OR predecessor.binding->>'domain'<>'procurement' OR predecessor.binding->>'kind'<>'invoice_record' THEN
  RAISE EXCEPTION 'agent_dependency_original_parent_required' USING ERRCODE='23514';END IF;
 IF parent.source_invoice_id IS NULL THEN RETURN;END IF;
 -- A prepared wrapper or a known receipt never supplies an invoice result.
 SELECT * INTO purchase FROM inventory_procurement_commands WHERE tenant_id=parent.tenant_id AND id=predecessor.owner_command_id FOR SHARE;
 IF NOT FOUND OR purchase.created_by IS DISTINCT FROM parent.owner_id OR purchase.kind<>'invoice_record' OR purchase.status<>'succeeded' OR purchase.invoice_result_proof_id IS NULL THEN
  RAISE EXCEPTION 'agent_dependency_actual_predecessor_required' USING ERRCODE='23514';END IF;
 SELECT * INTO proof FROM inventory_supplier_invoice_requests WHERE tenant_id=parent.tenant_id AND id=purchase.invoice_result_proof_id;
 IF NOT FOUND OR proof.invoice_id IS DISTINCT FROM parent.source_invoice_id OR proof.evidence_version<>1 OR proof.created_by IS DISTINCT FROM parent.owner_id
  OR proof.purchase_order_id IS DISTINCT FROM purchase.target_id OR proof.purchase_order_id::text IS DISTINCT FROM predecessor.binding->>'targetId' THEN
  RAISE EXCEPTION 'agent_dependency_actual_invoice_required' USING ERRCODE='23514';END IF;
 SELECT * INTO invoice FROM inventory_supplier_invoices WHERE tenant_id=parent.tenant_id AND id=proof.invoice_id;
 IF NOT FOUND OR invoice.purchase_order_id IS DISTINCT FROM proof.purchase_order_id OR invoice.created_by IS DISTINCT FROM proof.created_by OR invoice.idempotency_key IS DISTINCT FROM proof.idempotency_key THEN
  RAISE EXCEPTION 'agent_dependency_actual_invoice_required' USING ERRCODE='23514';END IF;
 SELECT * INTO po FROM inventory_purchase_orders WHERE tenant_id=parent.tenant_id AND id=proof.purchase_order_id;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM inventory_purchase_order_versions v WHERE v.tenant_id=parent.tenant_id AND v.id=proof.purchase_order_version_id AND v.purchase_order_id=po.id) THEN
  RAISE EXCEPTION 'agent_dependency_actual_source_required' USING ERRCODE='23514';END IF;
 source_time:=to_char(invoice.issued_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 due_time:=CASE WHEN parent.due_at IS NULL THEN NULL ELSE to_char(parent.due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END;
 source:=jsonb_build_object('version',parent.version,'invoiceId',invoice.id::text,'purchaseOrderId',po.id::text,'purchaseOrderVersionId',proof.purchase_order_version_id::text,
  'procurementProofId',proof.id::text,'supplierId',po.supplier_id::text,'invoiceNumber',invoice.invoice_number,'currency',invoice.currency,'totalMinor',invoice.total_minor,'issuedAt',source_time);
 original:=jsonb_build_object('domain','finance','command',jsonb_build_object('kind','bill_record','targetId',NULL,'input',jsonb_build_object(
  'supplierId',po.supplier_id::text,'kind','procurement_invoice','externalBillId',invoice.invoice_number,'currency',invoice.currency,'amountMinor',invoice.total_minor,
  'issuedAt',source_time,'dueAt',due_time,'procurementInvoiceId',invoice.id::text,'idempotencyKey',parent.child_native_key::text)));
 IF parent.source_checksum IS DISTINCT FROM agent_dependency_checksum(source) OR parent.child_original_checksum IS DISTINCT FROM agent_dependency_checksum(original)
  OR parent.child_preparation_request_checksum IS DISTINCT FROM agent_dependency_checksum(jsonb_build_object('operation','prepare','request',jsonb_build_object('version','erp-agent-command-v1','requestId',parent.child_request_id::text,'original',original))) THEN
  RAISE EXCEPTION 'agent_dependency_exact_mapping_required' USING ERRCODE='23514';END IF;
 IF parent.child_agent_command_id IS NULL THEN RETURN;END IF;
 SELECT * INTO child FROM agent_command_requests WHERE tenant_id=parent.tenant_id AND id=parent.child_agent_command_id;
 owner_checksum:=agent_dependency_checksum(original->'command');
 IF NOT FOUND OR child.owner_id IS DISTINCT FROM parent.owner_id OR child.request_id IS DISTINCT FROM parent.child_request_id OR child.operation<>'prepare'
  OR child.original_checksum IS DISTINCT FROM parent.child_original_checksum OR child.request_checksum IS DISTINCT FROM parent.child_preparation_request_checksum
  OR child.binding IS DISTINCT FROM jsonb_build_object('domain','finance','kind','bill_record','targetId',NULL,'accountId',NULL,
    'requestKeyHash',encode(sha256(convert_to(parent.child_native_key::text,'UTF8')),'hex'),'ownerRequestChecksum',owner_checksum)
  OR agent_plan_ceiling_contains(parent.origin_ceiling,child.origin_ceiling) IS NOT TRUE THEN
  RAISE EXCEPTION 'agent_dependency_exact_child_required' USING ERRCODE='23514';END IF;
 IF parent.child_owner_command_id IS NULL THEN RETURN;END IF;
 IF child.owner_command_id IS DISTINCT FROM parent.child_owner_command_id THEN RAISE EXCEPTION 'agent_dependency_exact_child_owner_required' USING ERRCODE='23514';END IF;
 SELECT * INTO finance FROM finance_commands WHERE tenant_id=parent.tenant_id AND id=parent.child_owner_command_id;
 IF NOT FOUND OR finance.kind<>'bill_record' OR finance.created_by IS DISTINCT FROM parent.owner_id OR finance.target_id IS NOT NULL
  OR finance.request_key IS DISTINCT FROM parent.child_native_key::text OR finance.request_checksum IS DISTINCT FROM owner_checksum THEN
  RAISE EXCEPTION 'agent_dependency_exact_child_owner_required' USING ERRCODE='23514';END IF;
 IF finance.status='succeeded' THEN
  SELECT * INTO bill FROM finance_payable_bills WHERE tenant_id=parent.tenant_id AND id=finance.result_id;
  IF NOT FOUND OR bill.procurement_invoice_id IS DISTINCT FROM parent.source_invoice_id OR bill.procurement_proof_id IS DISTINCT FROM proof.id
   OR bill.recorded_by IS DISTINCT FROM parent.owner_id OR bill.idempotency_key IS DISTINCT FROM parent.child_native_key::text THEN
   RAISE EXCEPTION 'agent_dependency_actual_child_result_required' USING ERRCODE='23514';END IF;
 END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION guard_agent_dependency_plan() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE actor agent_command_requests%ROWTYPE;request_body jsonb;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'agent_dependency_history_immutable' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' THEN
  PERFORM agent_dependency_write_authority(NEW);
  actor.tenant_id:=NEW.tenant_id;actor.owner_id:=NEW.owner_id;actor.origin_ceiling:=NEW.origin_ceiling;PERFORM agent_command_check_birth_ceiling(actor);
  IF NEW.source_invoice_id IS NOT NULL OR NEW.source_checksum IS NOT NULL OR NEW.child_original_checksum IS NOT NULL OR NEW.child_preparation_request_checksum IS NOT NULL
   OR NEW.preparation_requested_at IS NOT NULL OR NEW.child_agent_command_id IS NOT NULL OR NEW.child_owner_command_id IS NOT NULL OR NEW.cancelled_at IS NOT NULL
   OR NEW.creation_transaction_id IS NOT NULL OR NEW.preparation_transaction_id IS NOT NULL OR NEW.link_transaction_id IS NOT NULL OR NEW.cancellation_transaction_id IS NOT NULL THEN
   RAISE EXCEPTION 'agent_dependency_clean_birth_required' USING ERRCODE='23514';END IF;
  request_body:=jsonb_build_object('version',NEW.version,'kind',NEW.kind,'requestId',NEW.request_id::text,'parentAgentCommandId',NEW.parent_agent_command_id::text,
   'dueAt',CASE WHEN NEW.due_at IS NULL THEN NULL ELSE to_char(NEW.due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END);
  IF NEW.request_checksum IS DISTINCT FROM agent_dependency_checksum(request_body) OR NEW.request_id=NEW.child_request_id OR NEW.parent_agent_command_id=NEW.child_agent_command_id THEN
   RAISE EXCEPTION 'agent_dependency_birth_identity_invalid' USING ERRCODE='23514';END IF;
  NEW.created_at:=clock_timestamp();NEW.updated_at:=NEW.created_at;NEW.expires_at:=NEW.created_at+interval '7 days';NEW.creation_transaction_id:=pg_current_xact_id()::text;
  PERFORM agent_dependency_check_references(NEW);RETURN NEW;
 END IF;
 IF (to_jsonb(NEW)-ARRAY['source_invoice_id','source_checksum','child_original_checksum','child_preparation_request_checksum','preparation_requested_at','child_agent_command_id','child_owner_command_id','preparation_transaction_id','link_transaction_id','cancellation_transaction_id','cancelled_at','updated_at'])
  IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['source_invoice_id','source_checksum','child_original_checksum','child_preparation_request_checksum','preparation_requested_at','child_agent_command_id','child_owner_command_id','preparation_transaction_id','link_transaction_id','cancellation_transaction_id','cancelled_at','updated_at']) THEN
  RAISE EXCEPTION 'agent_dependency_birth_immutable' USING ERRCODE='23514';END IF;
 IF NEW.preparation_transaction_id IS DISTINCT FROM OLD.preparation_transaction_id OR NEW.link_transaction_id IS DISTINCT FROM OLD.link_transaction_id OR NEW.cancellation_transaction_id IS DISTINCT FROM OLD.cancellation_transaction_id THEN
  RAISE EXCEPTION 'agent_dependency_transaction_server_owned' USING ERRCODE='23514';END IF;
 PERFORM agent_dependency_actor(NEW,NEW.preparation_requested_at IS DISTINCT FROM OLD.preparation_requested_at OR NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at);
 IF OLD.preparation_requested_at IS NOT NULL AND(NEW.preparation_requested_at IS DISTINCT FROM OLD.preparation_requested_at OR NEW.source_invoice_id IS DISTINCT FROM OLD.source_invoice_id OR NEW.source_checksum IS DISTINCT FROM OLD.source_checksum
  OR NEW.child_original_checksum IS DISTINCT FROM OLD.child_original_checksum OR NEW.child_preparation_request_checksum IS DISTINCT FROM OLD.child_preparation_request_checksum)
  OR OLD.child_agent_command_id IS NOT NULL AND NEW.child_agent_command_id IS DISTINCT FROM OLD.child_agent_command_id
  OR OLD.child_owner_command_id IS NOT NULL AND NEW.child_owner_command_id IS DISTINCT FROM OLD.child_owner_command_id
  OR OLD.cancelled_at IS NOT NULL AND NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at THEN RAISE EXCEPTION 'agent_dependency_progress_monotone' USING ERRCODE='23514';END IF;
 IF OLD.preparation_requested_at IS NULL AND NEW.preparation_requested_at IS NOT NULL THEN
  PERFORM agent_dependency_write_authority(NEW);
  IF OLD.cancelled_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL OR NEW.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'agent_dependency_live_preparation_required' USING ERRCODE='23514';END IF;
  NEW.preparation_requested_at:=clock_timestamp();NEW.preparation_transaction_id:=pg_current_xact_id()::text;
 END IF;
 IF NEW.child_agent_command_id IS DISTINCT FROM OLD.child_agent_command_id OR NEW.child_owner_command_id IS DISTINCT FROM OLD.child_owner_command_id THEN NEW.link_transaction_id:=pg_current_xact_id()::text;END IF;
 IF OLD.cancelled_at IS NULL AND NEW.cancelled_at IS NOT NULL THEN NEW.cancelled_at:=clock_timestamp();NEW.cancellation_transaction_id:=pg_current_xact_id()::text;END IF;
 NEW.updated_at:=clock_timestamp();PERFORM agent_dependency_check_references(NEW);RETURN NEW;
END $$;
CREATE TRIGGER agent_dependency_plan_guard BEFORE INSERT OR UPDATE OR DELETE ON agent_dependency_plans FOR EACH ROW EXECUTE FUNCTION guard_agent_dependency_plan();
--> statement-breakpoint
CREATE FUNCTION require_agent_dependency_audit() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE parent agent_dependency_plans%ROWTYPE;event_action text;own_xmin text:=(pg_current_xact_id()::text::numeric%4294967296)::text;
BEGIN
 SELECT * INTO parent FROM agent_dependency_plans WHERE tenant_id=NEW.tenant_id AND id=NEW.id;
 FOR event_action IN SELECT unnest(array_remove(ARRAY[
  CASE WHEN TG_OP='INSERT' THEN 'agent.dependency_plan.create' END,
  CASE WHEN TG_OP='UPDATE' AND OLD.preparation_requested_at IS NULL AND NEW.preparation_requested_at IS NOT NULL THEN 'agent.dependency_plan.prepare' END,
  CASE WHEN TG_OP='UPDATE' AND(OLD.child_agent_command_id IS DISTINCT FROM NEW.child_agent_command_id OR OLD.child_owner_command_id IS DISTINCT FROM NEW.child_owner_command_id) THEN 'agent.dependency_plan.link' END,
  CASE WHEN TG_OP='UPDATE' AND OLD.cancelled_at IS NULL AND NEW.cancelled_at IS NOT NULL THEN 'agent.dependency_plan.cancel' END]::text[],NULL)) LOOP
  IF NOT EXISTS(SELECT 1 FROM audit_events a WHERE a.tenant_id=parent.tenant_id AND a.actor_user_id=parent.owner_id AND a.entity_type='agent_dependency_plan' AND a.entity_id=parent.id
   AND a.action=event_action AND a.result='success' AND a.xmin::text=own_xmin AND a.metadata->>'requestChecksum'=parent.request_checksum) THEN
   RAISE EXCEPTION 'agent_dependency_same_transaction_audit_required' USING ERRCODE='23514';END IF;
 END LOOP;
 PERFORM agent_dependency_check_references(parent);RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER agent_dependency_audit_closure AFTER INSERT OR UPDATE ON agent_dependency_plans DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_agent_dependency_audit();
--> statement-breakpoint
CREATE FUNCTION require_agent_dependency_audit_parent() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE parent agent_dependency_plans%ROWTYPE;event_transaction text;
BEGIN
 SELECT * INTO parent FROM agent_dependency_plans WHERE tenant_id=NEW.tenant_id AND id=NEW.entity_id;
 IF NOT FOUND OR NEW.entity_type<>'agent_dependency_plan' OR NEW.actor_user_id IS DISTINCT FROM parent.owner_id OR NEW.result<>'success'
  OR NEW.metadata->>'requestChecksum' IS DISTINCT FROM parent.request_checksum OR NEW.metadata->>'parentAgentCommandId' IS DISTINCT FROM parent.parent_agent_command_id::text
  OR NEW.metadata->>'childRequestId' IS DISTINCT FROM parent.child_request_id::text OR NEW.metadata->>'sourceChecksum' IS DISTINCT FROM parent.source_checksum
  OR NEW.metadata->>'childPreparationRequestChecksum' IS DISTINCT FROM parent.child_preparation_request_checksum
  OR NEW.metadata->>'childAgentCommandId' IS DISTINCT FROM parent.child_agent_command_id::text OR NEW.metadata->>'childOwnerCommandId' IS DISTINCT FROM parent.child_owner_command_id::text THEN
  RAISE EXCEPTION 'agent_dependency_audit_parent_required' USING ERRCODE='23514';END IF;
 PERFORM agent_dependency_actor(parent,NEW.action<>'agent.dependency_plan.link');
 CASE NEW.action
  WHEN 'agent.dependency_plan.create' THEN event_transaction:=parent.creation_transaction_id;
  WHEN 'agent.dependency_plan.prepare' THEN event_transaction:=parent.preparation_transaction_id;
  WHEN 'agent.dependency_plan.link' THEN event_transaction:=parent.link_transaction_id;
  WHEN 'agent.dependency_plan.cancel' THEN event_transaction:=parent.cancellation_transaction_id;
  ELSE RAISE EXCEPTION 'agent_dependency_audit_action_invalid' USING ERRCODE='23514';
 END CASE;
 IF event_transaction IS DISTINCT FROM pg_current_xact_id()::text THEN RAISE EXCEPTION 'agent_dependency_same_transaction_audit_required' USING ERRCODE='23514';END IF;
 PERFORM agent_dependency_check_references(parent);RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER agent_dependency_audit_parent_closure AFTER INSERT ON audit_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 WHEN(NEW.entity_type='agent_dependency_plan' OR NEW.action LIKE 'agent.dependency_plan.%') EXECUTE FUNCTION require_agent_dependency_audit_parent();
