-- Original assist facts and legacy runs are unchanged. New runs record their own execution intent.
CREATE TABLE ai_assist_executions (
 run_id uuid PRIMARY KEY, tenant_id uuid NOT NULL,
 contract_version text NOT NULL DEFAULT 'assist-execution-v1', input_fingerprint text NOT NULL, policy_checksum text NOT NULL,
 phase text NOT NULL DEFAULT 'pending', submission_state text NOT NULL DEFAULT 'not_submitted',
 attempt_count integer NOT NULL DEFAULT 0, dispatch_count integer NOT NULL DEFAULT 0,
 last_dispatched_at timestamptz, lease_token uuid, lease_expires_at timestamptz,
 encrypted_response text, response_checksum text, provider_request_id text,
 submitted_at timestamptz, received_at timestamptz, next_attempt_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT ai_assist_executions_run_fk FOREIGN KEY(tenant_id,run_id) REFERENCES ai_assist_runs(tenant_id,id) ON DELETE RESTRICT,
 CONSTRAINT ai_assist_executions_phase_check CHECK(phase IN ('pending','preparing','response_ready','completed','failed','uncertain')),
 CONSTRAINT ai_assist_executions_submission_check CHECK(submission_state IN ('not_submitted','submitted','received')),
 CONSTRAINT ai_assist_executions_attempt_check CHECK(attempt_count BETWEEN 0 AND 3 AND dispatch_count>=0),
 CONSTRAINT ai_assist_executions_lease_check CHECK((lease_token IS NULL)=(lease_expires_at IS NULL)),
 CONSTRAINT ai_assist_executions_response_check CHECK(encrypted_response IS NULL OR (response_checksum ~ '^[a-f0-9]{64}$' AND submission_state='received' AND received_at IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX ai_assist_executions_dispatch_idx ON ai_assist_executions(tenant_id,phase,next_attempt_at);
--> statement-breakpoint
ALTER TABLE ai_assist_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_assist_executions FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_assist_executions_tenant_policy ON ai_assist_executions FOR ALL TO yummyai_app
 USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid))
 WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
GRANT SELECT,INSERT,UPDATE ON ai_assist_executions TO yummyai_app;
--> statement-breakpoint
CREATE FUNCTION protect_ai_assist_execution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.run_id<>OLD.run_id OR NEW.tenant_id<>OLD.tenant_id OR NEW.contract_version<>OLD.contract_version
 OR NEW.input_fingerprint<>OLD.input_fingerprint OR NEW.policy_checksum<>OLD.policy_checksum
 OR (OLD.encrypted_response IS NOT NULL AND NEW.encrypted_response IS DISTINCT FROM OLD.encrypted_response AND NEW.encrypted_response IS NOT NULL)
 OR (OLD.response_checksum IS NOT NULL AND NEW.response_checksum IS DISTINCT FROM OLD.response_checksum)
 OR (OLD.submission_state='received' AND NEW.submission_state<>'received')
 OR (OLD.submission_state='submitted' AND NEW.submission_state='not_submitted')
 OR (OLD.phase IN ('completed','failed','uncertain') AND (to_jsonb(NEW)-ARRAY['encrypted_response','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['encrypted_response','updated_at']))
 THEN RAISE EXCEPTION 'AI assist execution evidence is immutable' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER ai_assist_execution_immutable BEFORE UPDATE ON ai_assist_executions FOR EACH ROW EXECUTE FUNCTION protect_ai_assist_execution();
