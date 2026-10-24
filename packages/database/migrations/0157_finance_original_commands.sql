-- Retained private transports delegate to existing immutable finance owners.
CREATE TABLE finance_original_write_proofs (
 tenant_id uuid NOT NULL REFERENCES organizations(id),kind text NOT NULL,result_id uuid NOT NULL,command_id uuid,
 request_key text NOT NULL,actor_id uuid NOT NULL REFERENCES app_users(id),target_id uuid,owner_input_checksum text NOT NULL,
 creation_transaction_id text NOT NULL,parent_id uuid,version integer,
 PRIMARY KEY(tenant_id,kind,result_id),CONSTRAINT finance_original_proof_key UNIQUE(tenant_id,kind,request_key)
);
CREATE UNIQUE INDEX finance_original_proof_command ON finance_original_write_proofs(tenant_id,command_id) WHERE command_id IS NOT NULL;
CREATE TABLE finance_commands (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES organizations(id),created_by uuid NOT NULL REFERENCES app_users(id),
 kind text NOT NULL,target_id uuid,request_key text NOT NULL,request_checksum text NOT NULL,owner_input_checksum text NOT NULL,
 authority_snapshot jsonb NOT NULL,encrypted_input text,contract_version text NOT NULL DEFAULT 'finance-command-v1',
 status text NOT NULL DEFAULT 'prepared',result_id uuid,error_code text,created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,
 completed_at timestamptz,acknowledged_at timestamptz,redacted_at timestamptz,
 CONSTRAINT finance_commands_scope UNIQUE(tenant_id,id),CONSTRAINT finance_commands_key UNIQUE(tenant_id,kind,request_key),
 CONSTRAINT finance_command_actual_result_fk FOREIGN KEY(tenant_id,kind,result_id) REFERENCES finance_original_write_proofs(tenant_id,kind,result_id),
 CONSTRAINT finance_commands_result CHECK((status='succeeded')=(result_id IS NOT NULL) AND (status='prepared')=(completed_at IS NULL)),
 CONSTRAINT finance_commands_status CHECK(status IN('prepared','succeeded','cancelled','expired')),
 CONSTRAINT finance_commands_input_state CHECK((status<>'prepared' OR encrypted_input IS NOT NULL AND redacted_at IS NULL)
  AND (status NOT IN('cancelled','expired') OR encrypted_input IS NULL AND redacted_at IS NOT NULL) AND error_code IS NULL),
 CONSTRAINT finance_commands_cipher CHECK(encrypted_input IS NULL OR octet_length(encrypted_input) BETWEEN 44 AND 47185920),
 CONSTRAINT finance_commands_hash CHECK(request_checksum~'^[a-f0-9]{64}$' AND owner_input_checksum~'^[a-f0-9]{64}$'),
 CONSTRAINT finance_commands_time CHECK(expires_at=created_at+interval '7 days' AND completed_at IS NOT DISTINCT FROM
  CASE WHEN status='prepared' THEN NULL ELSE completed_at END AND (completed_at IS NULL OR completed_at>=created_at)
  AND (acknowledged_at IS NULL OR acknowledged_at>=completed_at) AND (redacted_at IS NULL OR redacted_at>=created_at)),
 CONSTRAINT finance_commands_redaction CHECK((encrypted_input IS NULL)=(redacted_at IS NOT NULL) AND (acknowledged_at IS NULL OR status<>'prepared' AND encrypted_input IS NULL))
);
ALTER TABLE finance_original_write_proofs ADD CONSTRAINT finance_original_proof_command_fk FOREIGN KEY(tenant_id,command_id) REFERENCES finance_commands(tenant_id,id);
CREATE UNIQUE INDEX finance_commands_unacknowledged ON finance_commands(tenant_id,kind,created_by,coalesce(target_id,'00000000-0000-0000-0000-000000000000'::uuid)) WHERE acknowledged_at IS NULL;
CREATE INDEX finance_commands_retention ON finance_commands(tenant_id,expires_at) WHERE encrypted_input IS NOT NULL;
--> statement-breakpoint
CREATE FUNCTION finance_command_iso(value text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
 SELECT CASE WHEN value IS NULL THEN NULL ELSE to_char(value::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END
$$;
-- This hash is separate from the old locale-dependent owner checksums.
CREATE FUNCTION finance_command_body_hash(k text,target uuid,body jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE b jsonb:=body; key text; sources jsonb;
BEGIN
 IF k='statement_record' THEN
  b:=jsonb_set(b,'{lines}',(SELECT jsonb_agg(x ORDER BY x->>'lineKey' COLLATE "C") FROM jsonb_array_elements(b->'lines') x));
 ELSIF k='fx_rate_record' THEN
  b:=b||jsonb_build_object('effectiveAt',finance_command_iso(b->>'effectiveAt'),'retrievedAt',finance_command_iso(b->>'retrievedAt'));
 ELSIF k='metric_upsert' THEN
  FOREACH key IN ARRAY ARRAY['revenueFactTypes','costFactTypes','requiredFactTypes'] LOOP
   b:=jsonb_set(b,ARRAY[key],(SELECT coalesce(jsonb_agg(x ORDER BY x#>>'{}' COLLATE "C"),'[]') FROM jsonb_array_elements(b->key) x));
  END LOOP;
  b:=jsonb_set(b,'{metricId}',coalesce(to_jsonb(lower(b->>'metricId')),'null'));
 ELSIF k='profit_calculate' THEN
  FOREACH key IN ARRAY ARRAY['statementIds','fxRateIds'] LOOP
   b:=jsonb_set(b,ARRAY[key],(SELECT coalesce(jsonb_agg(x ORDER BY x#>>'{}' COLLATE "C"),'[]') FROM jsonb_array_elements(b->key) x));
  END LOOP;
  b:=b||jsonb_build_object('coverageDimension',coalesce(b->>'coverageDimension','order'),'metricId',lower(b->>'metricId'));
 ELSIF k='cost_version_approve' THEN
  SELECT jsonb_agg(x||jsonb_build_object('targets',(SELECT jsonb_agg(y ORDER BY y->>'key' COLLATE "C") FROM jsonb_array_elements(x->'targets') y))
    ORDER BY x->>'rootFactId' COLLATE "C") INTO sources FROM jsonb_array_elements(b->'sources') x;
  b:=jsonb_set(b,'{sources}',sources);
 ELSIF k='allocated_profit_calculate' THEN
  b:=jsonb_set(b,'{versionIds}',(SELECT coalesce(jsonb_agg(x ORDER BY x#>>'{}' COLLATE "C"),'[]') FROM jsonb_array_elements(b->'versionIds') x));
 END IF;
 RETURN finance_cost_hash(jsonb_build_object('kind',k,'targetId',target,'input',b));
END $$;
CREATE FUNCTION finance_command_table(k text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
 SELECT CASE k WHEN 'statement_record' THEN 'finance_statements' WHEN 'fx_rate_record' THEN 'finance_fx_rates'
 WHEN 'metric_upsert' THEN 'finance_profit_metric_versions' WHEN 'profit_calculate' THEN 'finance_profit_runs'
 WHEN 'bill_record' THEN 'finance_payable_bills' WHEN 'payment_record' THEN 'finance_payable_payments'
 WHEN 'payment_allocate' THEN 'finance_payment_allocation_batches' WHEN 'allocation_release' THEN 'finance_allocation_releases'
 WHEN 'bill_adjustment_record' THEN 'finance_bill_adjustments' WHEN 'payment_adjustment_record' THEN 'finance_payment_adjustments'
 WHEN 'cost_version_approve' THEN 'finance_cost_allocation_versions' WHEN 'allocated_profit_calculate' THEN 'finance_allocated_profit_runs' END
$$;
-- Reconstruct exclusively from the inserted owner's columns, never a caller's marker.
CREATE FUNCTION finance_command_row_binding(k text,r jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public AS $$
DECLARE body jsonb; target uuid; parent uuid; version integer; actor uuid; v finance_profit_metric_versions;
BEGIN
 actor:=coalesce(r->>'recorded_by',r->>'created_by',r->>'calculated_by',r->>'reviewed_by')::uuid;
 IF k='statement_record' THEN body:=(r->'source_input')||jsonb_build_object('idempotencyKey',r->>'idempotency_key');
 ELSIF k='fx_rate_record' THEN
  body:=jsonb_build_object('source',r->>'source','baseCurrency',r->>'base_currency','quoteCurrency',r->>'quote_currency',
   'rateNumerator',r->'rate_numerator','rateDenominator',r->'rate_denominator','effectiveAt',finance_command_iso(r->>'effective_at'),
   'retrievedAt',finance_command_iso(r->>'retrieved_at'),'idempotencyKey',r->>'idempotency_key');
  IF r->'monetary_basis' IS DISTINCT FROM 'null'::jsonb AND r->'monetary_basis' IS NOT NULL THEN body:=body||'{"rateUnit":"major_to_major"}'; END IF;
 ELSIF k='metric_upsert' THEN
  body:=(r->'request_identity')||jsonb_build_object('reportingCurrency',r->>'reporting_currency','revenueFactTypes',r->'revenue_fact_types',
   'costFactTypes',r->'cost_fact_types','requiredFactTypes',r->'required_fact_types','reasonCode',r->>'reason_code','idempotencyKey',r->>'idempotency_key');
  target:=(r->'request_identity'->>'metricId')::uuid;parent:=(r->>'metric_id')::uuid;version:=(r->>'version_number')::integer;
 ELSIF k='profit_calculate' THEN
  SELECT * INTO v FROM finance_profit_metric_versions WHERE tenant_id=(r->>'tenant_id')::uuid AND id=(r->>'metric_version_id')::uuid;
  target:=(r->>'metric_id')::uuid;
  body:=jsonb_build_object('metricId',target,'expectedMetricVersion',v.version_number,'statementIds',r->'statement_ids','fxRateIds',r->'fx_rate_ids',
   'coverageDimension',r->'diagnostics'->'coverage'->>'dimension','idempotencyKey',r->>'idempotency_key');
 ELSIF k='bill_record' THEN
  body:=jsonb_build_object('supplierId',r->>'supplier_id','kind',r->>'kind','externalBillId',r->>'external_bill_id','currency',r->>'currency',
   'amountMinor',r->'amount_minor','issuedAt',finance_command_iso(r->>'issued_at'),'dueAt',finance_command_iso(r->>'due_at'),
   'procurementInvoiceId',r->'procurement_invoice_id','idempotencyKey',r->>'idempotency_key');
 ELSIF k='payment_record' THEN
  body:=jsonb_build_object('supplierId',r->>'supplier_id','externalPaymentId',r->>'external_payment_id','currency',r->>'currency',
   'amountMinor',r->'amount_minor','paidAt',finance_command_iso(r->>'paid_at'),'method',r->>'method','evidenceReference',r->>'evidence_reference','idempotencyKey',r->>'idempotency_key');
 ELSIF k='payment_allocate' THEN body:=r->'input';target:=(r->>'payment_id')::uuid;
 ELSIF k='allocation_release' THEN target:=(r->>'allocation_id')::uuid;body:=jsonb_build_object('reasonCode',r->>'reason_code','idempotencyKey',r->>'idempotency_key');
 ELSIF k='bill_adjustment_record' THEN body:=r->'input';target:=(r->>'bill_id')::uuid;
 ELSIF k='payment_adjustment_record' THEN body:=r->'input';target:=(r->>'payment_id')::uuid;
 ELSIF k='cost_version_approve' THEN
  body:=r->'request_identity'->'input';target:=(body->>'allocationId')::uuid;parent:=(r->>'allocation_id')::uuid;version:=(r->>'version_number')::integer;
 ELSIF k='allocated_profit_calculate' THEN body:=r->'request_identity'->'input';target:=(r->>'base_run_id')::uuid;
 ELSE RAISE EXCEPTION 'finance_original_kind_invalid' USING ERRCODE='23514'; END IF;
 RETURN jsonb_build_object('targetId',target,'actorId',actor,'parentId',parent,'version',version,'ownerInputChecksum',finance_command_body_hash(k,target,body));
END $$;
--> statement-breakpoint
CREATE FUNCTION guard_finance_command() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE p finance_original_write_proofs; existing boolean; table_name text;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'finance_original_immutable' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('finance-original:'||NEW.tenant_id||':'||NEW.kind||':'||NEW.request_key,0));
 END IF;
 table_name:=finance_command_table(NEW.kind);
 IF table_name IS NULL OR NEW.id::text!~'^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
  OR length(NEW.request_key) NOT BETWEEN 8 AND 200 OR NEW.request_key<>btrim(NEW.request_key) OR NEW.contract_version<>'finance-command-v1'
  OR NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid
  OR NEW.authority_snapshot->>'tenantId' IS DISTINCT FROM NEW.tenant_id::text OR NEW.authority_snapshot->>'userId' IS DISTINCT FROM NEW.created_by::text
  OR jsonb_typeof(NEW.authority_snapshot->'permissions') IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION 'finance_original_identity_invalid' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.created_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid OR NEW.status<>'prepared' OR NEW.result_id IS NOT NULL
   OR NEW.completed_at IS NOT NULL OR NEW.acknowledged_at IS NOT NULL OR NEW.redacted_at IS NOT NULL OR NEW.encrypted_input IS NULL THEN
   RAISE EXCEPTION 'finance_original_initial_invalid' USING ERRCODE='23514';END IF;
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I WHERE tenant_id=$1 AND idempotency_key=$2)',table_name) INTO existing USING NEW.tenant_id,NEW.request_key;
  IF existing THEN RAISE EXCEPTION 'finance_original_existing_raw' USING ERRCODE='23514';END IF;
  NEW.created_at:=date_trunc('milliseconds',clock_timestamp());NEW.expires_at:=NEW.created_at+interval '7 days';
 ELSE
  IF (to_jsonb(NEW)-ARRAY['status','result_id','error_code','encrypted_input','completed_at','acknowledged_at','redacted_at']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['status','result_id','error_code','encrypted_input','completed_at','acknowledged_at','redacted_at'])
   OR OLD.encrypted_input IS NULL AND NEW.encrypted_input IS NOT NULL OR NEW.encrypted_input IS NOT NULL AND NEW.encrypted_input IS DISTINCT FROM OLD.encrypted_input
   OR OLD.redacted_at IS NOT NULL AND NEW.redacted_at IS DISTINCT FROM OLD.redacted_at
   OR OLD.acknowledged_at IS NOT NULL AND NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at
   OR OLD.status<>'prepared' AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.result_id IS DISTINCT FROM OLD.result_id OR NEW.completed_at IS DISTINCT FROM OLD.completed_at)
   OR NEW.error_code IS NOT NULL THEN RAISE EXCEPTION 'finance_original_immutable' USING ERRCODE='23514';END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
   IF NEW.status='expired' THEN
    IF NEW.expires_at>clock_timestamp() OR NEW.encrypted_input IS NOT NULL THEN RAISE EXCEPTION 'finance_original_expiry_invalid' USING ERRCODE='23514';END IF;
   ELSIF NEW.created_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid OR NEW.expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'finance_original_transition_invalid' USING ERRCODE='23514';
   END IF;
  END IF;
  IF NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at AND NEW.created_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid THEN
   RAISE EXCEPTION 'finance_original_ack_invalid' USING ERRCODE='23514';END IF;
  IF NEW.encrypted_input IS DISTINCT FROM OLD.encrypted_input AND NEW.status NOT IN('cancelled','expired') AND NEW.acknowledged_at IS NULL AND NEW.expires_at>clock_timestamp() THEN
   RAISE EXCEPTION 'finance_original_redaction_invalid' USING ERRCODE='23514';END IF;
  IF NEW.status='succeeded' AND OLD.status='prepared' THEN
   SELECT * INTO p FROM finance_original_write_proofs WHERE tenant_id=NEW.tenant_id AND kind=NEW.kind AND result_id=NEW.result_id;
   IF p.command_id IS DISTINCT FROM NEW.id OR p.creation_transaction_id IS DISTINCT FROM pg_current_xact_id()::text
    OR p.actor_id IS DISTINCT FROM NEW.created_by OR p.request_key IS DISTINCT FROM NEW.request_key OR p.target_id IS DISTINCT FROM NEW.target_id
    OR p.owner_input_checksum IS DISTINCT FROM NEW.owner_input_checksum THEN RAISE EXCEPTION 'finance_original_actual_result_missing' USING ERRCODE='23514';END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
-- This trigger sorts before the existing owners' BEFORE business locks. SQL
-- transports use the same generic-key -> command -> business lock order as APIs.
CREATE FUNCTION admit_finance_original_owner() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE c finance_commands;k text:=TG_ARGV[0];requested uuid:=nullif(current_setting('app.finance_command_id',true),'')::uuid;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('finance-original:'||NEW.tenant_id||':'||k||':'||NEW.idempotency_key,0));
 SELECT * INTO c FROM finance_commands WHERE tenant_id=NEW.tenant_id AND kind=k AND request_key=NEW.idempotency_key FOR UPDATE;
 IF c.id IS NOT NULL AND (c.id IS DISTINCT FROM requested OR c.status<>'prepared' OR c.encrypted_input IS NULL OR c.expires_at<=clock_timestamp()
  OR c.created_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid)
  OR requested IS NOT NULL AND c.id IS NULL THEN RAISE EXCEPTION 'finance_original_owner_admission_invalid' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION mint_finance_original_proof() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE k text:=TG_ARGV[0];r jsonb:=to_jsonb(NEW);b jsonb;c finance_commands;requested uuid:=nullif(current_setting('app.finance_command_id',true),'')::uuid;
BEGIN
 IF finance_command_table(k) IS DISTINCT FROM TG_TABLE_NAME OR TG_OP<>'INSERT' THEN RAISE EXCEPTION 'finance_original_owner_invalid' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('finance-original:'||NEW.tenant_id||':'||k||':'||NEW.idempotency_key,0));
 b:=finance_command_row_binding(k,r);
 IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid OR b->>'actorId' IS DISTINCT FROM nullif(current_setting('app.user_id',true),'') THEN
  RAISE EXCEPTION 'finance_original_actor_invalid' USING ERRCODE='23514';END IF;
 SELECT * INTO c FROM finance_commands WHERE tenant_id=NEW.tenant_id AND kind=k AND request_key=NEW.idempotency_key FOR UPDATE;
 IF c.id IS NOT NULL AND (c.id IS DISTINCT FROM requested OR c.status<>'prepared' OR c.encrypted_input IS NULL OR c.expires_at<=clock_timestamp()
  OR c.created_by::text IS DISTINCT FROM b->>'actorId' OR c.target_id IS DISTINCT FROM (b->>'targetId')::uuid
  OR c.owner_input_checksum IS DISTINCT FROM b->>'ownerInputChecksum') OR requested IS NOT NULL AND c.id IS NULL THEN
  RAISE EXCEPTION 'finance_original_owner_binding_invalid' USING ERRCODE='23514';END IF;
 INSERT INTO finance_original_write_proofs(tenant_id,kind,result_id,command_id,request_key,actor_id,target_id,owner_input_checksum,creation_transaction_id,parent_id,version)
 VALUES(NEW.tenant_id,k,NEW.id,c.id,NEW.idempotency_key,(b->>'actorId')::uuid,(b->>'targetId')::uuid,b->>'ownerInputChecksum',pg_current_xact_id()::text,(b->>'parentId')::uuid,(b->>'version')::integer);
 RETURN NEW;
END $$;
CREATE FUNCTION require_finance_command_outcome() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE c finance_commands; action_name text; type_name text; audit_id uuid:=NEW.result_id;
BEGIN
 action_name:=CASE NEW.kind WHEN 'statement_record' THEN 'finance.statement.record' WHEN 'fx_rate_record' THEN 'finance.fx_rate.record'
  WHEN 'metric_upsert' THEN 'finance.profit_metric.version' WHEN 'profit_calculate' THEN 'finance.profit.calculate'
  WHEN 'bill_record' THEN 'finance.payables.bill_recorded' WHEN 'payment_record' THEN 'finance.payables.payment_recorded'
  WHEN 'payment_allocate' THEN 'finance.payables.payment_allocated' WHEN 'allocation_release' THEN 'finance.payables.allocation_released'
  WHEN 'bill_adjustment_record' THEN 'finance.payables.bill_adjustment_recorded' WHEN 'payment_adjustment_record' THEN 'finance.payables.payment_adjustment_recorded'
  WHEN 'cost_version_approve' THEN 'finance.cost_allocation.version_approved' WHEN 'allocated_profit_calculate' THEN 'finance.cost_allocation.profit_calculated' END;
 type_name:=CASE NEW.kind WHEN 'statement_record' THEN 'finance_statement' WHEN 'fx_rate_record' THEN 'finance_fx_rate'
  WHEN 'metric_upsert' THEN 'finance_profit_metric' WHEN 'profit_calculate' THEN 'finance_profit_run'
  WHEN 'bill_record' THEN 'finance_payable_bill' WHEN 'payment_record' THEN 'finance_payable_payment'
  WHEN 'payment_allocate' THEN 'finance_payment_allocation_batch' WHEN 'allocation_release' THEN 'finance_allocation_release'
  WHEN 'bill_adjustment_record' THEN 'finance_bill_adjustment' WHEN 'payment_adjustment_record' THEN 'finance_payment_adjustment'
  WHEN 'cost_version_approve' THEN 'finance_cost_allocation_version' WHEN 'allocated_profit_calculate' THEN 'finance_allocated_profit_run' END;
 IF NEW.kind='metric_upsert' THEN audit_id:=NEW.parent_id;END IF;
 IF NOT EXISTS(SELECT 1 FROM audit_events a WHERE a.tenant_id=NEW.tenant_id AND a.actor_user_id=NEW.actor_id AND a.action=action_name
  AND a.entity_type=type_name AND a.entity_id=audit_id AND a.result='success'
  AND a.xmin::text=mod(pg_current_xact_id()::text::numeric,4294967296)::bigint::text) THEN
  RAISE EXCEPTION 'finance_original_owner_audit_missing' USING ERRCODE='23514';END IF;
 IF NEW.command_id IS NOT NULL THEN
  SELECT * INTO c FROM finance_commands WHERE tenant_id=NEW.tenant_id AND id=NEW.command_id;
  IF c.status IS DISTINCT FROM 'succeeded' OR c.kind IS DISTINCT FROM NEW.kind OR c.result_id IS DISTINCT FROM NEW.result_id
   OR c.created_by IS DISTINCT FROM NEW.actor_id OR c.owner_input_checksum IS DISTINCT FROM NEW.owner_input_checksum
   OR NEW.creation_transaction_id IS DISTINCT FROM pg_current_xact_id()::text THEN
   RAISE EXCEPTION 'finance_original_outcome_missing' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE FUNCTION require_finance_command_audit() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE action_name text;
BEGIN
 action_name:=CASE WHEN TG_OP='INSERT' THEN 'prepare' WHEN NEW.status='succeeded' AND OLD.status='prepared' THEN 'execute'
  WHEN NEW.status='cancelled' AND OLD.status='prepared' THEN 'cancel' WHEN NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at THEN 'acknowledge' END;
 IF action_name IS NOT NULL AND NOT EXISTS(SELECT 1 FROM audit_events a WHERE a.tenant_id=NEW.tenant_id AND a.actor_user_id=NEW.created_by
  AND a.entity_id=NEW.id AND a.entity_type='finance_command' AND a.action='finance.command.'||action_name AND a.result='success'
  AND a.xmin::text=mod(pg_current_xact_id()::text::numeric,4294967296)::bigint::text) THEN
  RAISE EXCEPTION 'finance_original_atomic_audit_missing' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
DO $$ DECLARE k text;n text;BEGIN
 FOREACH k IN ARRAY ARRAY['statement_record','fx_rate_record','metric_upsert','profit_calculate','bill_record','payment_record','payment_allocate',
  'allocation_release','bill_adjustment_record','payment_adjustment_record','cost_version_approve','allocated_profit_calculate'] LOOP
  n:=finance_command_table(k);
  EXECUTE format('CREATE TRIGGER a_finance_original_admission BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION admit_finance_original_owner(%L)',n,k);
  EXECUTE format('CREATE TRIGGER %I AFTER INSERT ON %I FOR EACH ROW EXECUTE FUNCTION mint_finance_original_proof(%L)',n||'_original_proof',n,k);
 END LOOP;
 FOREACH n IN ARRAY ARRAY['finance_commands','finance_original_write_proofs'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',n);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',n);
  EXECUTE format('CREATE POLICY %I ON %I USING(tenant_id=current_setting(''app.tenant_id'',true)::uuid) WITH CHECK(tenant_id=current_setting(''app.tenant_id'',true)::uuid)',n||'_tenant',n);
 END LOOP;
END $$;
CREATE TRIGGER finance_commands_guard BEFORE INSERT OR UPDATE OR DELETE ON finance_commands FOR EACH ROW EXECUTE FUNCTION guard_finance_command();
CREATE TRIGGER finance_original_proof_immutable BEFORE UPDATE OR DELETE ON finance_original_write_proofs FOR EACH ROW EXECUTE FUNCTION prohibit_finance_payables_mutation();
CREATE CONSTRAINT TRIGGER finance_original_outcome_closed AFTER INSERT ON finance_original_write_proofs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_finance_command_outcome();
CREATE CONSTRAINT TRIGGER finance_original_audit_closed AFTER INSERT OR UPDATE ON finance_commands DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_finance_command_audit();
GRANT SELECT,INSERT,UPDATE ON finance_commands TO yummyai_app;
GRANT SELECT ON finance_original_write_proofs TO yummyai_app;
REVOKE ALL ON FUNCTION admit_finance_original_owner(),mint_finance_original_proof(),guard_finance_command(),require_finance_command_outcome(),require_finance_command_audit(),finance_command_iso(text),finance_command_body_hash(text,uuid,jsonb),finance_command_table(text),finance_command_row_binding(text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finance_command_iso(text),finance_command_body_hash(text,uuid,jsonb),finance_command_table(text),finance_command_row_binding(text,jsonb) TO yummyai_app;

--> statement-breakpoint
-- Normalize only future immutable statement inputs, once, for indexed source verification.
CREATE TABLE finance_statement_source_lines (
 tenant_id uuid NOT NULL,statement_id uuid NOT NULL,line_key text NOT NULL,input jsonb NOT NULL,creation_transaction_id text NOT NULL,
 PRIMARY KEY(tenant_id,statement_id,line_key),
 CONSTRAINT finance_statement_source_line_parent_fk FOREIGN KEY(tenant_id,statement_id) REFERENCES finance_statements(tenant_id,id)
);
ALTER TABLE finance_statement_source_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_statement_source_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY finance_statement_source_lines_tenant ON finance_statement_source_lines
 USING(tenant_id=current_setting('app.tenant_id',true)::uuid) WITH CHECK(tenant_id=current_setting('app.tenant_id',true)::uuid);
CREATE FUNCTION index_finance_statement_source_lines() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid
  OR NEW.recorded_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid THEN
  RAISE EXCEPTION 'finance_source_index_authority_invalid' USING ERRCODE='23514';END IF;
 INSERT INTO finance_statement_source_lines(tenant_id,statement_id,line_key,input,creation_transaction_id)
 SELECT NEW.tenant_id,NEW.id,line->>'lineKey',line,pg_current_xact_id()::text FROM jsonb_array_elements(NEW.source_input->'lines') line;
 RETURN NEW;
END $$;
CREATE TRIGGER a_finance_statement_source_index AFTER INSERT ON finance_statements FOR EACH ROW EXECUTE FUNCTION index_finance_statement_source_lines();
CREATE TRIGGER finance_statement_source_line_immutable BEFORE UPDATE OR DELETE ON finance_statement_source_lines FOR EACH ROW EXECUTE FUNCTION prohibit_finance_evidence_mutation();
GRANT SELECT ON finance_statement_source_lines TO yummyai_app;
REVOKE ALL ON FUNCTION index_finance_statement_source_lines() FROM PUBLIC;
CREATE OR REPLACE FUNCTION guard_finance_source_fact() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE s record; root finance_facts; source_statement finance_statements;
 parent_order orders; parent_line order_lines; sku skus; listing listings; link order_line_catalog_links; item jsonb; field text;
BEGIN
 SELECT source.id,source.tenant_id,source.source_identity,source.provider,source.scope_key,source.account_id,source.source_currency,source.xmin::text::bigint AS source_xid INTO s FROM finance_statements source WHERE tenant_id=NEW.tenant_id AND id=NEW.statement_id;
 IF NOT isfinite(NEW.occurred_at) OR extract(year from NEW.occurred_at AT TIME ZONE 'UTC') NOT BETWEEN 1 AND 9999 OR date_trunc('milliseconds',NEW.occurred_at)<>NEW.occurred_at THEN
  RAISE EXCEPTION 'finance_source_date_invalid' USING ERRCODE='23514'; END IF;
 IF s.id IS NULL OR s.source_identity IS NULL OR s.source_xid<>mod(txid_current(),4294967296)
  OR NEW.source_entry_id IS NULL OR NEW.source_entry_id='' OR finance_source_entry_utf16_length(NEW.source_entry_id) NOT BETWEEN 1 AND 300
  OR NEW.source_entry_id<>finance_source_entry_trim(NEW.source_entry_id) OR NEW.source_entry_id ~ '[[:cntrl:]]'
  OR NEW.source_provider IS DISTINCT FROM s.provider OR NEW.source_scope_key IS DISTINCT FROM s.scope_key
  OR NEW.account_id IS DISTINCT FROM s.account_id OR NEW.currency<>s.source_currency THEN
  RAISE EXCEPTION 'finance_source_entry_invalid' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM audit_events a WHERE a.tenant_id=NEW.tenant_id AND a.entity_id=s.id AND a.entity_type='finance_statement'
  AND a.action='finance.statement.record' AND a.result='success' AND a.xmin::text::bigint=mod(txid_current(),4294967296)) THEN
  RAISE EXCEPTION 'finance_statement_is_sealed' USING ERRCODE='23514'; END IF;
 SELECT input INTO item FROM finance_statement_source_lines WHERE tenant_id=NEW.tenant_id AND statement_id=NEW.statement_id AND line_key=NEW.line_key AND creation_transaction_id=pg_current_xact_id()::text;
 IF jsonb_typeof(item) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'finance_source_line_missing' USING ERRCODE='23514'; END IF;
 IF (SELECT array_agg(key ORDER BY key COLLATE "C") FROM jsonb_object_keys(item) key) IS DISTINCT FROM
  ARRAY['amountMinor','correctionKind','correctsFactId','currency','direction','externalReference','factType','lineKey','listingId','occurredAt','orderId','orderLineId','skuId','sourceEntryId','supplierId']::text[] THEN
  RAISE EXCEPTION 'finance_source_line_invalid' USING ERRCODE='23514'; END IF;
 FOREACH field IN ARRAY ARRAY['correctionKind','currency','direction','factType','lineKey','occurredAt','sourceEntryId'] LOOP
  IF jsonb_typeof(item->field) IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'finance_source_line_invalid' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF finance_source_date_supported(item->>'occurredAt') IS DISTINCT FROM true THEN RAISE EXCEPTION 'finance_source_date_invalid' USING ERRCODE='23514'; END IF;
 IF finance_source_entry_utf16_length(NEW.line_key) NOT BETWEEN 1 AND 300 OR NEW.line_key<>finance_source_entry_trim(NEW.line_key)
  OR (NEW.external_reference IS NOT NULL AND (finance_source_entry_utf16_length(NEW.external_reference) NOT BETWEEN 1 AND 300
   OR NEW.external_reference<>finance_source_entry_trim(NEW.external_reference))) THEN
  RAISE EXCEPTION 'finance_source_reference_invalid' USING ERRCODE='23514'; END IF;
 FOREACH field IN ARRAY ARRAY['correctsFactId','externalReference','listingId','orderId','orderLineId','skuId','supplierId'] LOOP
  IF jsonb_typeof(item->field) NOT IN ('string','null') THEN RAISE EXCEPTION 'finance_source_line_invalid' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF jsonb_typeof(item->'amountMinor') IS DISTINCT FROM 'number' OR item->>'amountMinor' !~ '^[0-9]+$'
  OR (item->>'amountMinor')::numeric IS DISTINCT FROM NEW.amount_minor::numeric OR item->>'sourceEntryId' IS DISTINCT FROM NEW.source_entry_id
  OR item->>'factType' IS DISTINCT FROM NEW.fact_type OR item->>'direction' IS DISTINCT FROM NEW.direction OR item->>'currency' IS DISTINCT FROM NEW.currency
  OR (item->>'occurredAt')::timestamptz IS DISTINCT FROM NEW.occurred_at OR item->>'externalReference' IS DISTINCT FROM NEW.external_reference
  OR (item->>'orderId')::uuid IS DISTINCT FROM NEW.order_id OR (item->>'orderLineId')::uuid IS DISTINCT FROM NEW.order_line_id
  OR (item->>'skuId')::uuid IS DISTINCT FROM NEW.sku_id OR (item->>'listingId')::uuid IS DISTINCT FROM NEW.listing_id
  OR (item->>'supplierId')::uuid IS DISTINCT FROM NEW.supplier_id OR item->>'correctionKind' IS DISTINCT FROM NEW.correction_kind
  OR (item->>'correctsFactId')::uuid IS DISTINCT FROM NEW.corrects_fact_id THEN
  RAISE EXCEPTION 'finance_source_line_mismatch' USING ERRCODE='23514'; END IF;
 IF s.source_identity->>'kind'='supplier' AND NEW.supplier_id IS DISTINCT FROM (s.source_identity->>'supplierId')::uuid THEN
  RAISE EXCEPTION 'finance_source_supplier_mismatch' USING ERRCODE='23514'; END IF;
 IF NEW.order_id IS NOT NULL THEN
  SELECT * INTO parent_order FROM orders WHERE tenant_id=NEW.tenant_id AND id=NEW.order_id;
  IF parent_order.id IS NULL OR (s.account_id IS NOT NULL AND (parent_order.account_id IS DISTINCT FROM s.account_id
   OR NOT EXISTS(SELECT 1 FROM marketplace_accounts a WHERE a.tenant_id=NEW.tenant_id AND a.id=s.account_id AND a.platform=parent_order.platform))) THEN
   RAISE EXCEPTION 'finance_order_account_mismatch' USING ERRCODE='23514'; END IF;
 END IF;
 IF NEW.order_line_id IS NOT NULL THEN
  SELECT * INTO parent_line FROM order_lines WHERE tenant_id=NEW.tenant_id AND id=NEW.order_line_id;
  IF parent_line.id IS NULL OR parent_line.order_id IS DISTINCT FROM NEW.order_id THEN
   RAISE EXCEPTION 'finance_order_line_mismatch' USING ERRCODE='23514'; END IF;
 END IF;
 IF NEW.sku_id IS NOT NULL THEN SELECT * INTO sku FROM skus WHERE tenant_id=NEW.tenant_id AND id=NEW.sku_id; END IF;
 IF NEW.listing_id IS NOT NULL THEN SELECT * INTO listing FROM listings WHERE tenant_id=NEW.tenant_id AND id=NEW.listing_id; END IF;
 IF (NEW.sku_id IS NOT NULL AND sku.id IS NULL) OR (NEW.listing_id IS NOT NULL AND listing.id IS NULL) THEN
  RAISE EXCEPTION 'finance_catalog_reference_missing' USING ERRCODE='23514'; END IF;
 IF NEW.correction_kind='original' THEN
  IF sku.id IS NOT NULL AND listing.id IS NOT NULL AND sku.spu_id<>listing.spu_id THEN
   RAISE EXCEPTION 'finance_sku_listing_mismatch' USING ERRCODE='23514'; END IF;
  IF listing.id IS NOT NULL AND coalesce(s.account_id,parent_order.account_id) IS NOT NULL
   AND NOT EXISTS(SELECT 1 FROM marketplace_accounts a WHERE a.tenant_id=NEW.tenant_id AND a.id=coalesce(s.account_id,parent_order.account_id) AND a.platform=listing.platform) THEN
   RAISE EXCEPTION 'finance_listing_account_mismatch' USING ERRCODE='23514'; END IF;
  IF parent_line.id IS NOT NULL THEN
   SELECT * INTO link FROM order_line_catalog_links WHERE tenant_id=NEW.tenant_id AND order_line_id=parent_line.id;
   IF (link.id IS NOT NULL AND ((NEW.sku_id IS NOT NULL AND link.sku_id IS NOT NULL AND link.sku_id<>NEW.sku_id)
    OR (NEW.listing_id IS NOT NULL AND link.listing_id IS NOT NULL AND link.listing_id<>NEW.listing_id)))
    OR (link.sku_id IS NULL AND sku.id IS NOT NULL AND parent_line.sku_code IS NOT NULL
     AND EXISTS(SELECT 1 FROM skus known WHERE known.tenant_id=NEW.tenant_id AND known.code=parent_line.sku_code AND known.id<>sku.id)) THEN
    RAISE EXCEPTION 'finance_order_catalog_mismatch' USING ERRCODE='23514'; END IF;
   IF (listing.id IS NOT NULL AND link.sku_id IS NOT NULL AND EXISTS(SELECT 1 FROM skus known WHERE known.tenant_id=NEW.tenant_id AND known.id=link.sku_id AND known.spu_id<>listing.spu_id))
    OR (sku.id IS NOT NULL AND link.listing_id IS NOT NULL AND EXISTS(SELECT 1 FROM listings known WHERE known.tenant_id=NEW.tenant_id AND known.id=link.listing_id AND known.spu_id<>sku.spu_id)) THEN
    RAISE EXCEPTION 'finance_order_catalog_mismatch' USING ERRCODE='23514'; END IF;
  END IF;
 ELSE
  PERFORM pg_advisory_xact_lock(hashtextextended('finance-correction:'||NEW.tenant_id||':'||NEW.corrects_fact_id,0));
  SELECT * INTO root FROM finance_facts WHERE tenant_id=NEW.tenant_id AND id=NEW.corrects_fact_id;
  SELECT * INTO source_statement FROM finance_statements WHERE tenant_id=NEW.tenant_id AND id=root.statement_id;
  IF root.id IS NULL OR root.correction_kind<>'original' OR root.source_entry_id IS NULL
   OR source_statement.provider IS DISTINCT FROM s.provider OR source_statement.scope_key IS DISTINCT FROM s.scope_key
   OR root.fact_type<>NEW.fact_type OR root.currency<>NEW.currency OR root.direction<>NEW.direction
   OR root.order_id IS DISTINCT FROM NEW.order_id OR root.order_line_id IS DISTINCT FROM NEW.order_line_id
   OR root.sku_id IS DISTINCT FROM NEW.sku_id OR root.listing_id IS DISTINCT FROM NEW.listing_id
   OR root.account_id IS DISTINCT FROM NEW.account_id OR root.supplier_id IS DISTINCT FROM NEW.supplier_id
   OR (NEW.correction_kind='reversal' AND root.amount_minor<>NEW.amount_minor)
   OR (NEW.correction_kind='replacement' AND NOT EXISTS(SELECT 1 FROM finance_facts WHERE tenant_id=NEW.tenant_id
    AND corrects_fact_id=root.id AND correction_kind='reversal')) THEN
   RAISE EXCEPTION 'finance_correction_root_mismatch' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
