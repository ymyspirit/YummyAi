-- Historical usage remains unknown. Never infer zero or rewrite frozen receipts.
ALTER TABLE ai_assist_runs ADD COLUMN token_usage jsonb;
ALTER TABLE order_design_model_calls ADD COLUMN token_usage jsonb;
ALTER TABLE pod_artwork_invocations ADD COLUMN token_usage jsonb;
ALTER TABLE ai_assist_executions ADD COLUMN response_receipt_transaction_id xid8;
ALTER TABLE ai_assist_executions ADD CONSTRAINT ai_assist_executions_receipt_origin_check
 CHECK(response_receipt_transaction_id IS NULL OR received_at IS NOT NULL);
ALTER TABLE ai_assist_runs ADD CONSTRAINT ai_assist_runs_token_usage_check
 CHECK(token_usage IS NULL OR (status<>'queued' AND jsonb_typeof(token_usage)='object' AND coalesce(token_usage->>'version','')='model-token-usage-v1'));
ALTER TABLE order_design_model_calls ADD CONSTRAINT order_design_model_calls_token_usage_check
 CHECK(token_usage IS NULL OR (received_at IS NOT NULL AND jsonb_typeof(token_usage)='object' AND coalesce(token_usage->>'version','')='model-token-usage-v1'));
ALTER TABLE pod_artwork_invocations ADD CONSTRAINT pod_invocations_token_usage_check
 CHECK(token_usage IS NULL OR (received_at IS NOT NULL AND jsonb_typeof(token_usage)='object' AND coalesce(token_usage->>'version','')='model-token-usage-v1'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_ai_assist_run() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE late_usage boolean;
BEGIN
 late_usage := OLD.token_usage IS NULL AND NEW.token_usage IS NOT NULL
  AND (to_jsonb(NEW)-'token_usage') IS NOT DISTINCT FROM (to_jsonb(OLD)-'token_usage')
  AND EXISTS(SELECT 1 FROM ai_assist_executions e WHERE e.tenant_id=OLD.tenant_id AND e.run_id=OLD.id
   AND e.submitted_at IS NOT NULL AND e.submission_state='received' AND e.received_at IS NOT NULL
   AND e.response_checksum IS NOT NULL AND e.response_receipt_transaction_id=pg_current_xact_id());
 IF (to_jsonb(NEW)-ARRAY['status','encrypted_input','encrypted_output','error_code','input_tokens','output_tokens','cost_usd','started_at','completed_at','token_usage']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['status','encrypted_input','encrypted_output','error_code','input_tokens','output_tokens','cost_usd','started_at','completed_at','token_usage'])
  OR (NEW.encrypted_input IS DISTINCT FROM OLD.encrypted_input AND NEW.encrypted_input IS NOT NULL)
  OR (OLD.status IN ('completed','failed','cancelled') AND NOT late_usage AND
   (to_jsonb(NEW)-ARRAY['encrypted_input','encrypted_output']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['encrypted_input','encrypted_output']))
  OR (OLD.encrypted_output IS NOT NULL AND NEW.encrypted_output IS DISTINCT FROM OLD.encrypted_output AND NEW.encrypted_output IS NOT NULL)
  OR (OLD.token_usage IS NOT NULL AND NEW.token_usage IS DISTINCT FROM OLD.token_usage)
 THEN RAISE EXCEPTION 'AI assist input and final results are immutable' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_ai_assist_execution() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE late_receipt boolean;
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.response_receipt_transaction_id IS NOT NULL OR NOT EXISTS(
   SELECT 1 FROM ai_assist_runs r WHERE r.tenant_id=NEW.tenant_id AND r.id=NEW.run_id
    AND r.creation_transaction_id=pg_current_xact_id())
  THEN RAISE EXCEPTION 'AI assist receipt origin is database-owned' USING ERRCODE='55000'; END IF;
  RETURN NEW;
 END IF;
 late_receipt := OLD.phase IN ('failed','uncertain') AND OLD.submission_state='submitted'
  AND OLD.submitted_at IS NOT NULL AND OLD.response_checksum IS NULL AND OLD.encrypted_response IS NULL
  AND NEW.submission_state='received' AND NEW.received_at IS NOT NULL
  AND NEW.response_checksum ~ '^[a-f0-9]{64}$'
  AND (to_jsonb(NEW)-ARRAY['encrypted_response','response_checksum','provider_request_id','submission_state','received_at','updated_at']) IS NOT DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['encrypted_response','response_checksum','provider_request_id','submission_state','received_at','updated_at']);
 IF NEW.run_id<>OLD.run_id OR NEW.tenant_id<>OLD.tenant_id OR NEW.contract_version<>OLD.contract_version
  OR NEW.response_receipt_transaction_id IS DISTINCT FROM OLD.response_receipt_transaction_id
  OR NEW.input_fingerprint<>OLD.input_fingerprint OR NEW.policy_checksum<>OLD.policy_checksum
  OR (OLD.encrypted_response IS NOT NULL AND NEW.encrypted_response IS DISTINCT FROM OLD.encrypted_response AND NEW.encrypted_response IS NOT NULL)
  OR (OLD.response_checksum IS NOT NULL AND NEW.response_checksum IS DISTINCT FROM OLD.response_checksum)
  OR (OLD.submission_state='received' AND NEW.submission_state<>'received')
  OR (OLD.submission_state='submitted' AND NEW.submission_state='not_submitted')
  OR (OLD.phase IN ('completed','failed','uncertain') AND NOT late_receipt AND
   (to_jsonb(NEW)-ARRAY['encrypted_response','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['encrypted_response','updated_at']))
 THEN RAISE EXCEPTION 'AI assist execution evidence is immutable' USING ERRCODE='55000'; END IF;
 IF OLD.received_at IS NULL AND NEW.received_at IS NOT NULL THEN NEW.response_receipt_transaction_id:=pg_current_xact_id(); END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER ai_assist_execution_receipt_origin BEFORE INSERT ON ai_assist_executions
 FOR EACH ROW EXECUTE FUNCTION protect_ai_assist_execution();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_order_design_model_call() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Original model call evidence is immutable' USING ERRCODE='55000'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.received_at IS NOT NULL OR NEW.cost_report_state<>'pending' OR NEW.reported_cost_usd IS NOT NULL OR NEW.token_usage IS NOT NULL
   OR NOT EXISTS(SELECT 1 FROM order_design_agent_runs r JOIN order_design_agent_steps s ON s.tenant_id=r.tenant_id AND s.run_id=r.id
    JOIN ai_budget_ledger b ON b.tenant_id=s.tenant_id AND b.request_id=s.request_id
    WHERE r.tenant_id=NEW.tenant_id AND r.id=NEW.run_id AND r.status='running' AND r.processing_token=NEW.claim_token
     AND r.requested_by=NEW.requested_by AND s.id=NEW.step_id AND s.status='running' AND s.attempt=NEW.attempt AND s.request_id=NEW.request_id
     AND s.key ~ '^(enhance_image|cutout_subject)(_|$)' AND b.id=NEW.budget_ledger_id AND b.task_type='order_design' AND b.state='reserved')
  THEN RAISE EXCEPTION 'Model call must retain its original active submission and reservation' USING ERRCODE='55000'; END IF;
  NEW.submitted_at:=clock_timestamp();RETURN NEW;
 END IF;
 IF (to_jsonb(NEW)-'received_at'-'cost_report_state'-'reported_cost_usd'-'token_usage') IS DISTINCT FROM
    (to_jsonb(OLD)-'received_at'-'cost_report_state'-'reported_cost_usd'-'token_usage')
 THEN RAISE EXCEPTION 'Original model call identity is immutable' USING ERRCODE='55000'; END IF;
 IF OLD.received_at IS NOT NULL AND NEW IS DISTINCT FROM OLD
 THEN RAISE EXCEPTION 'Original reported model cost is immutable' USING ERRCODE='55000'; END IF;
 IF OLD.received_at IS NULL AND NEW.received_at IS NOT NULL THEN NEW.received_at:=clock_timestamp();END IF;
 RETURN NEW;
END; $$;
