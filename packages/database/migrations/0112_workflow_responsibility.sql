-- Existing nodes retain their assigned user, without invented deadlines or alerts.
ALTER TABLE workflow_node_runs
  ADD COLUMN due_at timestamptz,
  ADD COLUMN escalation_user_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
  ADD COLUMN escalation_delay_minutes integer,
  ADD COLUMN responsibility_revision integer NOT NULL DEFAULT 0,
  ADD COLUMN attention_next_at timestamptz,
  ADD COLUMN attention_last_error text,
  ADD COLUMN assignment_notified_at timestamptz,
  ADD COLUMN due_notified_at timestamptz,
  ADD COLUMN escalation_notified_at timestamptz;
--> statement-breakpoint
ALTER TABLE workflow_node_runs ADD CONSTRAINT workflow_node_runs_responsibility_check CHECK (responsibility_revision>=0 AND (escalation_delay_minutes IS NULL OR escalation_delay_minutes BETWEEN 1 AND 10080));
--> statement-breakpoint
ALTER TABLE workflow_node_runs ADD CONSTRAINT workflow_node_runs_escalation_check CHECK (escalation_user_id IS NULL OR (due_at IS NOT NULL AND escalation_delay_minutes IS NOT NULL AND escalation_user_id<>assigned_user_id));
--> statement-breakpoint
CREATE INDEX workflow_node_runs_attention_idx ON workflow_node_runs(tenant_id,attention_next_at) WHERE responsibility_revision>0 AND attention_next_at IS NOT NULL;
--> statement-breakpoint
ALTER TABLE notifications ADD COLUMN deduplication_key text;
--> statement-breakpoint
CREATE UNIQUE INDEX notifications_deduplication_unique ON notifications(tenant_id,user_id,deduplication_key) WHERE deduplication_key IS NOT NULL;
--> statement-breakpoint
ALTER TABLE notifications ADD CONSTRAINT notifications_deduplication_length_check CHECK (deduplication_key IS NULL OR length(deduplication_key) BETWEEN 1 AND 300);
--> statement-breakpoint
CREATE FUNCTION protect_deduplicated_notification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.deduplication_key IS DISTINCT FROM OLD.deduplication_key OR
     (OLD.deduplication_key IS NOT NULL AND
      (NEW.id,NEW.tenant_id,NEW.user_id,NEW.kind,NEW.title,NEW.body,NEW.resource_type,NEW.resource_id,NEW.metadata,NEW.created_at)
      IS DISTINCT FROM
      (OLD.id,OLD.tenant_id,OLD.user_id,OLD.kind,OLD.title,OLD.body,OLD.resource_type,OLD.resource_id,OLD.metadata,OLD.created_at)) THEN
    RAISE EXCEPTION 'Deduplicated notification identity and content are immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER notifications_deduplication_immutable BEFORE UPDATE ON notifications FOR EACH ROW EXECUTE FUNCTION protect_deduplicated_notification();
