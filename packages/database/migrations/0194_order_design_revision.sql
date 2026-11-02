-- Each reviewed order still has one initial run. Explicit operator feedback
-- creates a child attempt; the original candidate, steps and costs remain intact.
ALTER TABLE order_design_agent_runs ADD COLUMN parent_run_id uuid;
--> statement-breakpoint
ALTER TABLE order_design_agent_runs DROP CONSTRAINT order_design_runs_revision_unique;
--> statement-breakpoint
CREATE UNIQUE INDEX order_design_runs_initial_revision_unique
  ON order_design_agent_runs (tenant_id, work_item_id, work_revision_id)
  WHERE parent_run_id IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX order_design_runs_parent_unique
  ON order_design_agent_runs (tenant_id, parent_run_id) WHERE parent_run_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX order_design_runs_lineage_unique
  ON order_design_agent_runs (tenant_id, id, work_item_id, work_revision_id);
--> statement-breakpoint
ALTER TABLE order_design_agent_runs ADD CONSTRAINT order_design_runs_parent_fk
  FOREIGN KEY (tenant_id, parent_run_id, work_item_id, work_revision_id)
  REFERENCES order_design_agent_runs (tenant_id, id, work_item_id, work_revision_id);
--> statement-breakpoint
ALTER TABLE order_design_agent_commands DROP CONSTRAINT order_design_commands_action_check;
--> statement-breakpoint
ALTER TABLE order_design_agent_commands ADD CONSTRAINT order_design_commands_action_check
  CHECK (action IN ('resume', 'takeover', 'restore_response', 'revise'));
--> statement-breakpoint
ALTER TABLE order_design_agent_runs
  ADD COLUMN revision_feedback_objects jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN revision_feedback_purged_at timestamptz,
  ADD CONSTRAINT order_design_runs_parent_not_self CHECK (parent_run_id IS NULL OR parent_run_id <> id),
  ADD CONSTRAINT order_design_feedback_objects_check CHECK (jsonb_typeof(revision_feedback_objects)='array' AND jsonb_array_length(revision_feedback_objects)<=3);
--> statement-breakpoint
CREATE FUNCTION protect_order_design_revision_lineage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.parent_run_id IS DISTINCT FROM OLD.parent_run_id
    OR NEW.revision_feedback_objects IS DISTINCT FROM OLD.revision_feedback_objects THEN
    RAISE EXCEPTION 'Order design revision lineage and feedback locators are immutable';
  END IF;
  IF NEW.revision_feedback_purged_at IS DISTINCT FROM OLD.revision_feedback_purged_at THEN
    IF OLD.revision_feedback_purged_at IS NOT NULL OR NEW.revision_feedback_purged_at IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM order_work_items w JOIN order_lines l ON l.id=w.id
        JOIN orders o ON o.id=l.order_id
        WHERE w.tenant_id=NEW.tenant_id AND w.id=NEW.work_item_id
          AND (w.expires_at<=clock_timestamp() OR o.address_status='anonymized')
      ) THEN
      RAISE EXCEPTION 'Order design feedback purge needs an expired original owner';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER order_design_revision_lineage_immutable BEFORE UPDATE ON order_design_agent_runs
  FOR EACH ROW EXECUTE FUNCTION protect_order_design_revision_lineage();
--> statement-breakpoint
-- Preserve 0193's native original-call identity/usage invariants. The only
-- additional paid step is the explicit current-candidate image revision.
CREATE OR REPLACE FUNCTION protect_order_design_model_call() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Original model call evidence is immutable' USING ERRCODE='55000'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.received_at IS NOT NULL OR NEW.cost_report_state<>'pending' OR NEW.reported_cost_usd IS NOT NULL OR NEW.token_usage IS NOT NULL
   OR NOT EXISTS(SELECT 1 FROM order_design_agent_runs r JOIN order_design_agent_steps s ON s.tenant_id=r.tenant_id AND s.run_id=r.id
    JOIN ai_budget_ledger b ON b.tenant_id=s.tenant_id AND b.request_id=s.request_id
    WHERE r.tenant_id=NEW.tenant_id AND r.id=NEW.run_id AND r.status='running' AND r.processing_token=NEW.claim_token
     AND r.requested_by=NEW.requested_by AND s.id=NEW.step_id AND s.status='running' AND s.attempt=NEW.attempt AND s.request_id=NEW.request_id
     AND s.key ~ '^(enhance_image|cutout_subject|revise_image)(_|$)' AND b.id=NEW.budget_ledger_id AND b.task_type='order_design' AND b.state='reserved')
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
