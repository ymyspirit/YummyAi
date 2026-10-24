CREATE UNIQUE INDEX ai_budget_ledger_tenant_id_unique ON ai_budget_ledger(tenant_id,id);
CREATE UNIQUE INDEX pod_invocations_tenant_id_unique ON pod_artwork_invocations(tenant_id,id);
--> statement-breakpoint
CREATE TABLE model_billing_reconciliations (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,owner text NOT NULL,subject_id uuid NOT NULL,
 assist_run_id uuid,pod_invocation_id uuid,sequence integer NOT NULL,previous_id uuid,
 command_id uuid NOT NULL,request_checksum text NOT NULL,basis_fingerprint text NOT NULL,
 amount_usd numeric(20,8) NOT NULL,evidence_kind text NOT NULL,invoice_reference text NOT NULL,
 provider_request_id text NOT NULL,proof_checksum text NOT NULL,budget_ledger_id uuid,budget_impact jsonb,
 checked_by uuid NOT NULL REFERENCES app_users(id),checked_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT model_billing_assist_fk FOREIGN KEY(tenant_id,assist_run_id) REFERENCES ai_assist_runs(tenant_id,id) ON DELETE RESTRICT,
 CONSTRAINT model_billing_pod_fk FOREIGN KEY(tenant_id,pod_invocation_id) REFERENCES pod_artwork_invocations(tenant_id,id) ON DELETE RESTRICT,
 CONSTRAINT model_billing_budget_fk FOREIGN KEY(tenant_id,budget_ledger_id) REFERENCES ai_budget_ledger(tenant_id,id) ON DELETE RESTRICT,
 CONSTRAINT model_billing_id_check CHECK(substring(id::text from 15 for 1)='7'),
 CONSTRAINT model_billing_subject_check CHECK((owner='assist' AND assist_run_id=subject_id AND assist_run_id IS NOT NULL AND pod_invocation_id IS NULL) OR (owner='pod' AND pod_invocation_id=subject_id AND pod_invocation_id IS NOT NULL AND assist_run_id IS NULL)),
 CONSTRAINT model_billing_sequence_check CHECK(sequence>0 AND ((sequence=1 AND previous_id IS NULL) OR (sequence>1 AND previous_id IS NOT NULL))),
 CONSTRAINT model_billing_amount_check CHECK(amount_usd>=0 AND amount_usd<=99999999.999999),
 CONSTRAINT model_billing_evidence_check CHECK(evidence_kind IN ('provider_invoice','provider_usage','provider_support') AND proof_checksum ~ '^[a-f0-9]{64}$' AND request_checksum ~ '^[a-f0-9]{64}$' AND basis_fingerprint ~ '^[a-f0-9]{64}$'),
 CONSTRAINT model_billing_budget_owner_check CHECK((owner='assist' AND budget_ledger_id IS NOT NULL AND budget_impact IS NOT NULL) OR (owner='pod' AND budget_ledger_id IS NULL AND budget_impact IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX model_billing_tenant_id_unique ON model_billing_reconciliations(tenant_id,id);
CREATE UNIQUE INDEX model_billing_subject_id_unique ON model_billing_reconciliations(tenant_id,owner,subject_id,id);
CREATE UNIQUE INDEX model_billing_subject_sequence_unique ON model_billing_reconciliations(tenant_id,owner,subject_id,sequence);
CREATE UNIQUE INDEX model_billing_command_unique ON model_billing_reconciliations(tenant_id,command_id);
ALTER TABLE model_billing_reconciliations ADD CONSTRAINT model_billing_previous_fk FOREIGN KEY(tenant_id,owner,subject_id,previous_id) REFERENCES model_billing_reconciliations(tenant_id,owner,subject_id,id) ON DELETE RESTRICT;
ALTER TABLE model_billing_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_billing_reconciliations FORCE ROW LEVEL SECURITY;
CREATE POLICY model_billing_tenant_policy ON model_billing_reconciliations FOR ALL TO yummyai_app
 USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid))
 WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
GRANT SELECT,INSERT ON model_billing_reconciliations TO yummyai_app;
--> statement-breakpoint
CREATE FUNCTION protect_model_billing_reconciliation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Model billing reconciliation is append-only' USING ERRCODE='55000'; END; $$;
CREATE TRIGGER model_billing_immutable BEFORE UPDATE OR DELETE ON model_billing_reconciliations FOR EACH ROW EXECUTE FUNCTION protect_model_billing_reconciliation();
--> statement-breakpoint
-- Serialized immutable corrections are the only new route to changing a terminal budget.
-- Both functions remain invokers under the ordinary application role and forced RLS.
CREATE FUNCTION guard_model_billing_reconciliation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior model_billing_reconciliations%ROWTYPE;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text || ':ai-assist-budget',0));
 SELECT * INTO prior FROM model_billing_reconciliations WHERE tenant_id=NEW.tenant_id AND owner=NEW.owner AND subject_id=NEW.subject_id ORDER BY sequence DESC LIMIT 1;
 IF (FOUND AND (NEW.sequence<>prior.sequence+1 OR NEW.previous_id IS DISTINCT FROM prior.id)) OR
    (NOT FOUND AND (NEW.sequence<>1 OR NEW.previous_id IS NOT NULL)) THEN
  RAISE EXCEPTION 'Model billing correction must extend its latest immutable receipt' USING ERRCODE='23514';
 END IF;
 IF NEW.checked_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid THEN
  RAISE EXCEPTION 'Model billing reviewer must match the current actor' USING ERRCODE='23514';
 END IF;
 IF EXISTS(SELECT 1 FROM model_billing_reconciliations r WHERE r.tenant_id=NEW.tenant_id AND r.proof_checksum=NEW.proof_checksum AND r.invoice_reference=NEW.invoice_reference AND r.provider_request_id=NEW.provider_request_id AND (r.owner<>NEW.owner OR r.subject_id<>NEW.subject_id)) THEN
  RAISE EXCEPTION 'Model billing source request already belongs to another invocation' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER model_billing_chain BEFORE INSERT ON model_billing_reconciliations FOR EACH ROW EXECUTE FUNCTION guard_model_billing_reconciliation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_ai_budget_settlement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-'state'-'amount_usd') IS DISTINCT FROM (to_jsonb(OLD)-'state'-'amount_usd') THEN
  RAISE EXCEPTION 'AI budget ledger identity and provenance are immutable' USING ERRCODE='23514';
 END IF;
 IF NEW.state=OLD.state AND NEW.amount_usd=OLD.amount_usd THEN RETURN NEW; END IF;
 IF pg_trigger_depth()>1 AND NEW.state='committed' AND EXISTS(
  SELECT 1 FROM model_billing_reconciliations r WHERE r.tenant_id=OLD.tenant_id AND r.owner='assist' AND r.assist_run_id=OLD.request_id AND r.budget_ledger_id=OLD.id
   AND r.xmin=(txid_current()%4294967296)::text::xid
   AND r.budget_impact->>'beforeState'=OLD.state AND (r.budget_impact->>'beforeAmountUsd')::numeric=OLD.amount_usd
   AND (r.budget_impact->>'afterAmountUsd')::numeric=NEW.amount_usd AND ceil(r.amount_usd*1000000)/1000000=NEW.amount_usd
 ) THEN RETURN NEW; END IF;
 IF OLD.state<>'reserved' OR NEW.state NOT IN ('committed','released') THEN
  RAISE EXCEPTION 'AI budget ledger only permits a reservation to be settled or released' USING ERRCODE='23514';
 END IF;
 IF NEW.state='released' AND NEW.amount_usd IS DISTINCT FROM OLD.amount_usd THEN
  RAISE EXCEPTION 'Releasing an AI budget reservation must retain its original amount' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE FUNCTION apply_model_billing_budget() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original ai_budget_ledger%ROWTYPE; expected numeric;
BEGIN
 IF NEW.owner<>'assist' THEN RETURN NEW; END IF;
 SELECT * INTO original FROM ai_budget_ledger WHERE tenant_id=NEW.tenant_id AND id=NEW.budget_ledger_id FOR UPDATE;
 expected:=ceil(NEW.amount_usd*1000000)/1000000;
 IF NOT FOUND OR original.request_id<>NEW.subject_id OR
  NEW.budget_impact->>'ledgerId' IS DISTINCT FROM original.id::text OR
  NEW.budget_impact->>'afterState' IS DISTINCT FROM 'committed' OR
  (NEW.budget_impact->>'afterAmountUsd')::numeric IS DISTINCT FROM expected OR
  (NEW.budget_impact->>'periodStartedAt')::timestamptz IS DISTINCT FROM original.created_at THEN
  RAISE EXCEPTION 'Model billing budget identity or period does not match its original ledger' USING ERRCODE='23514';
 END IF;
 IF NEW.budget_impact->>'beforeState' IS NULL THEN
  IF NEW.budget_impact->>'beforeAmountUsd' IS NOT NULL OR original.state<>'committed' OR original.amount_usd<>expected OR NOT EXISTS(SELECT 1 FROM ai_budget_ledger l WHERE l.tenant_id=NEW.tenant_id AND l.id=original.id AND l.xmin=(txid_current()%4294967296)::text::xid) THEN
   RAISE EXCEPTION 'New model billing budget must be created in this transaction' USING ERRCODE='23514';
  END IF;
 ELSE
  IF NEW.budget_impact->>'beforeState' IS DISTINCT FROM original.state OR (NEW.budget_impact->>'beforeAmountUsd')::numeric IS DISTINCT FROM original.amount_usd THEN
   RAISE EXCEPTION 'Model billing original budget amount has changed' USING ERRCODE='23514';
  END IF;
  UPDATE ai_budget_ledger SET state='committed',amount_usd=expected WHERE tenant_id=NEW.tenant_id AND id=original.id;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER model_billing_apply AFTER INSERT ON model_billing_reconciliations FOR EACH ROW EXECUTE FUNCTION apply_model_billing_budget();
