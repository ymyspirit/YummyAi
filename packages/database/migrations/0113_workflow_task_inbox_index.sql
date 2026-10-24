CREATE INDEX IF NOT EXISTS workflow_node_runs_assignee_due_idx
  ON workflow_node_runs (tenant_id, assigned_user_id, due_at, id);
