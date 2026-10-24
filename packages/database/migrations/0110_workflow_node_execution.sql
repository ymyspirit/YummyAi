ALTER TABLE workflow_node_attempts
  ADD COLUMN requested_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  ADD COLUMN input_snapshot jsonb, ADD COLUMN input_checksum text, ADD COLUMN output_snapshot jsonb,
  ADD COLUMN lease_token uuid, ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN recovery_count integer NOT NULL DEFAULT 0, ADD COLUMN dispatch_count integer NOT NULL DEFAULT 0,
  ADD COLUMN last_dispatched_at timestamptz, ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE workflow_node_attempts DROP CONSTRAINT workflow_node_attempts_status_check;
ALTER TABLE workflow_node_attempts ADD CONSTRAINT workflow_node_attempts_status_check CHECK(status IN ('queued','running','waiting','failed','completed','cancelled'));
ALTER TABLE workflow_node_attempts ADD CONSTRAINT workflow_node_attempts_snapshot_check CHECK(
  (input_snapshot IS NULL AND input_checksum IS NULL) OR (input_snapshot IS NOT NULL AND input_checksum IS NOT NULL AND input_checksum ~ '^[a-f0-9]{64}$')
);
ALTER TABLE workflow_node_attempts ADD CONSTRAINT workflow_node_attempts_lease_check CHECK(
  (lease_token IS NULL AND lease_expires_at IS NULL AND status <> 'running') OR
  (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND status = 'running') OR
  (status = 'running' AND input_snapshot IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
);
ALTER TABLE workflow_node_attempts ADD CONSTRAINT workflow_node_attempts_recovery_check CHECK(recovery_count BETWEEN 0 AND 3 AND dispatch_count >= 0);
--> statement-breakpoint
CREATE FUNCTION protect_workflow_attempt_input() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.tenant_id,NEW.node_run_id,NEW.attempt_number,NEW.requested_by,NEW.input_snapshot,NEW.input_checksum,NEW.queued_at)
    IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.node_run_id,OLD.attempt_number,OLD.requested_by,OLD.input_snapshot,OLD.input_checksum,OLD.queued_at) THEN
    RAISE EXCEPTION 'Workflow attempt input is immutable';
  END IF;
  IF OLD.status IN ('completed','cancelled') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Terminal workflow attempt is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER workflow_attempt_input_immutable BEFORE UPDATE ON workflow_node_attempts FOR EACH ROW EXECUTE FUNCTION protect_workflow_attempt_input();
