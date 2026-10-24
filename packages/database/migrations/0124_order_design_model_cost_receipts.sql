ALTER TABLE order_design_agent_runs ALTER COLUMN actual_cost_usd TYPE numeric(20,8);
CREATE TABLE order_design_model_calls (
 id uuid PRIMARY KEY CHECK(substring(id::text from 15 for 1)='7'), tenant_id uuid NOT NULL REFERENCES organizations(id),
 run_id uuid NOT NULL, step_id uuid NOT NULL, request_id uuid NOT NULL,
 attempt integer NOT NULL CHECK(attempt>0), claim_token uuid NOT NULL,
 budget_ledger_id uuid NOT NULL, requested_by uuid NOT NULL REFERENCES app_users(id),
 submitted_at timestamptz NOT NULL DEFAULT clock_timestamp(), received_at timestamptz,
 cost_report_state text NOT NULL DEFAULT 'pending', reported_cost_usd numeric(20,8),
 CONSTRAINT order_design_model_calls_run_fk FOREIGN KEY(tenant_id,run_id) REFERENCES order_design_agent_runs(tenant_id,id),
 CONSTRAINT order_design_model_calls_step_fk FOREIGN KEY(tenant_id,step_id) REFERENCES order_design_agent_steps(tenant_id,id),
 CONSTRAINT order_design_model_calls_budget_fk FOREIGN KEY(tenant_id,budget_ledger_id) REFERENCES ai_budget_ledger(tenant_id,id),
 CONSTRAINT order_design_model_calls_receipt_check CHECK(
  (received_at IS NULL AND cost_report_state='pending' AND reported_cost_usd IS NULL)
  OR (received_at IS NOT NULL AND ((cost_report_state='reported' AND reported_cost_usd IS NOT NULL AND reported_cost_usd>=0 AND reported_cost_usd<=1000000)
   OR (cost_report_state IN ('unknown','invalid') AND reported_cost_usd IS NULL))))
);
CREATE UNIQUE INDEX order_design_model_calls_tenant_id_unique ON order_design_model_calls(tenant_id,id);
CREATE UNIQUE INDEX order_design_model_calls_attempt_unique ON order_design_model_calls(tenant_id,step_id,attempt);
CREATE UNIQUE INDEX order_design_model_calls_claim_unique ON order_design_model_calls(tenant_id,step_id,claim_token);
CREATE UNIQUE INDEX order_design_model_calls_budget_unique ON order_design_model_calls(tenant_id,budget_ledger_id);
ALTER TABLE order_design_model_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_design_model_calls FORCE ROW LEVEL SECURITY;
CREATE POLICY order_design_model_calls_tenant ON order_design_model_calls FOR ALL TO yummyai_app
 USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid))
 WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
GRANT SELECT,INSERT,UPDATE ON order_design_model_calls TO yummyai_app;
--> statement-breakpoint
CREATE FUNCTION protect_order_design_model_call() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Original model call evidence is immutable' USING ERRCODE='55000'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.received_at IS NOT NULL OR NEW.cost_report_state<>'pending' OR NEW.reported_cost_usd IS NOT NULL
   OR NOT EXISTS(SELECT 1 FROM order_design_agent_runs r JOIN order_design_agent_steps s ON s.tenant_id=r.tenant_id AND s.run_id=r.id
    JOIN ai_budget_ledger b ON b.tenant_id=s.tenant_id AND b.request_id=s.request_id
    WHERE r.tenant_id=NEW.tenant_id AND r.id=NEW.run_id AND r.status='running' AND r.processing_token=NEW.claim_token
     AND r.requested_by=NEW.requested_by AND s.id=NEW.step_id AND s.status='running' AND s.attempt=NEW.attempt AND s.request_id=NEW.request_id
     AND s.key ~ '^(enhance_image|cutout_subject)(_|$)' AND b.id=NEW.budget_ledger_id AND b.task_type='order_design' AND b.state='reserved')
  THEN RAISE EXCEPTION 'Model call must retain its original active submission and reservation' USING ERRCODE='55000'; END IF;
  NEW.submitted_at:=clock_timestamp();RETURN NEW;
 END IF;
 IF (to_jsonb(NEW)-'received_at'-'cost_report_state'-'reported_cost_usd') IS DISTINCT FROM (to_jsonb(OLD)-'received_at'-'cost_report_state'-'reported_cost_usd')
 THEN RAISE EXCEPTION 'Original model call identity is immutable' USING ERRCODE='55000'; END IF;
 IF OLD.received_at IS NOT NULL AND NEW IS DISTINCT FROM OLD
 THEN RAISE EXCEPTION 'Original reported model cost is immutable' USING ERRCODE='55000'; END IF;
 IF OLD.received_at IS NULL AND NEW.received_at IS NOT NULL THEN NEW.received_at:=clock_timestamp();END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER order_design_model_call_guard BEFORE INSERT OR UPDATE OR DELETE ON order_design_model_calls FOR EACH ROW EXECUTE FUNCTION protect_order_design_model_call();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_ai_budget_settlement() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (to_jsonb(NEW)-'state'-'amount_usd') IS DISTINCT FROM (to_jsonb(OLD)-'state'-'amount_usd') THEN
  RAISE EXCEPTION 'AI budget ledger identity and provenance are immutable' USING ERRCODE='23514';
 END IF;
 IF NEW.state=OLD.state AND NEW.amount_usd=OLD.amount_usd THEN RETURN NEW;END IF;
 IF pg_trigger_depth()>1 AND NEW.state='committed' AND EXISTS(
  SELECT 1 FROM model_billing_reconciliations r WHERE r.tenant_id=OLD.tenant_id AND r.owner='assist' AND r.assist_run_id=OLD.request_id AND r.budget_ledger_id=OLD.id
   AND r.xmin=(txid_current()%4294967296)::text::xid
   AND r.budget_impact->>'beforeState'=OLD.state AND (r.budget_impact->>'beforeAmountUsd')::numeric=OLD.amount_usd
   AND (r.budget_impact->>'afterAmountUsd')::numeric=NEW.amount_usd AND ceil(r.amount_usd*1000000)/1000000=NEW.amount_usd
 ) THEN RETURN NEW;END IF;
 IF pg_trigger_depth()>1 AND NEW.state='committed' AND OLD.task_type='order_design' AND EXISTS(
  SELECT 1 FROM order_design_model_calls c WHERE c.tenant_id=OLD.tenant_id AND c.budget_ledger_id=OLD.id AND c.request_id=OLD.request_id
   AND c.received_at IS NOT NULL AND c.cost_report_state='reported' AND c.xmin=(txid_current()%4294967296)::text::xid
   AND ceil(c.reported_cost_usd*1000000)/1000000=NEW.amount_usd
 ) THEN RETURN NEW;END IF;
 IF OLD.state<>'reserved' OR NEW.state NOT IN ('committed','released') THEN
  RAISE EXCEPTION 'AI budget ledger only permits a reservation to be settled or released' USING ERRCODE='23514';
 END IF;
 IF NEW.state='released' AND NEW.amount_usd IS DISTINCT FROM OLD.amount_usd THEN
  RAISE EXCEPTION 'Releasing an AI budget reservation must retain its original amount' USING ERRCODE='23514';
 END IF;RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE FUNCTION settle_order_design_model_cost() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 UPDATE ai_budget_ledger SET state='committed',amount_usd=ceil(NEW.reported_cost_usd*1000000)/1000000
 WHERE tenant_id=NEW.tenant_id AND id=NEW.budget_ledger_id;
 RETURN NEW;
END; $$;
CREATE TRIGGER order_design_model_cost_settlement AFTER UPDATE ON order_design_model_calls
 FOR EACH ROW WHEN(OLD.received_at IS NULL AND NEW.received_at IS NOT NULL AND NEW.cost_report_state='reported')
 EXECUTE FUNCTION settle_order_design_model_cost();
