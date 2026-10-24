CREATE TABLE pod_artwork_invocations (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, task_id uuid NOT NULL, attempt_number integer NOT NULL,
 phase text NOT NULL, started_at timestamptz NOT NULL DEFAULT now(), submitted_at timestamptz,
 received_at timestamptz, finished_at timestamptz, response_checksum text, provider_request_id text,
 model_key text, model_version text, reported_cost_usd numeric(20,8), metadata_valid boolean, result_version_id uuid,
 CONSTRAINT pod_invocations_task_fk FOREIGN KEY(tenant_id,task_id) REFERENCES pod_artwork_tasks(tenant_id,id) ON DELETE RESTRICT,
 CONSTRAINT pod_invocations_version_fk FOREIGN KEY(tenant_id,result_version_id) REFERENCES design_versions(tenant_id,id) ON DELETE RESTRICT,
 CONSTRAINT pod_invocations_id_check CHECK(substring(id::text from 15 for 1)='7'),
 CONSTRAINT pod_invocations_attempt_check CHECK(attempt_number BETWEEN 1 AND 20),
 CONSTRAINT pod_invocations_phase_check CHECK(phase IN ('pending','submitted','received','completed','failed','uncertain')),
 CONSTRAINT pod_invocations_cost_check CHECK(reported_cost_usd IS NULL OR reported_cost_usd>=0),
 CONSTRAINT pod_invocations_response_check CHECK((received_at IS NULL AND response_checksum IS NULL AND reported_cost_usd IS NULL AND metadata_valid IS NULL) OR (received_at IS NOT NULL AND submitted_at IS NOT NULL AND response_checksum IS NOT NULL AND response_checksum ~ '^[a-f0-9]{64}$' AND metadata_valid IS NOT NULL)),
 CONSTRAINT pod_invocations_boundary_check CHECK((phase NOT IN ('submitted','received','completed','uncertain') OR submitted_at IS NOT NULL) AND (phase NOT IN ('received','completed') OR received_at IS NOT NULL) AND (phase<>'completed' OR (result_version_id IS NOT NULL AND finished_at IS NOT NULL)))
);
--> statement-breakpoint
CREATE UNIQUE INDEX pod_invocations_task_attempt_unique ON pod_artwork_invocations(tenant_id,task_id,attempt_number);
CREATE INDEX pod_invocations_task_idx ON pod_artwork_invocations(tenant_id,task_id,started_at);
ALTER TABLE pod_artwork_invocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE pod_artwork_invocations FORCE ROW LEVEL SECURITY;
CREATE POLICY pod_invocations_tenant_policy ON pod_artwork_invocations FOR ALL TO yummyai_app
 USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid))
 WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
GRANT SELECT,INSERT,UPDATE ON pod_artwork_invocations TO yummyai_app;
--> statement-breakpoint
CREATE FUNCTION protect_pod_invocation_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.id<>OLD.id OR NEW.tenant_id<>OLD.tenant_id OR NEW.task_id<>OLD.task_id OR NEW.attempt_number<>OLD.attempt_number
 OR NEW.started_at<>OLD.started_at
 OR (OLD.submitted_at IS NOT NULL AND NEW.submitted_at IS DISTINCT FROM OLD.submitted_at)
 OR (OLD.received_at IS NOT NULL AND (to_jsonb(NEW)-ARRAY['phase','finished_at','result_version_id']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['phase','finished_at','result_version_id']))
 OR (OLD.phase IN ('completed','failed','uncertain') AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD))
 OR (NEW.phase='submitted' AND OLD.phase NOT IN ('pending','submitted'))
 OR (NEW.phase='received' AND OLD.phase NOT IN ('submitted','received'))
 OR (NEW.phase='completed' AND OLD.phase<>'received')
 THEN RAISE EXCEPTION 'POD invocation evidence is immutable' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER pod_invocation_receipt_immutable BEFORE UPDATE ON pod_artwork_invocations FOR EACH ROW EXECUTE FUNCTION protect_pod_invocation_receipt();
