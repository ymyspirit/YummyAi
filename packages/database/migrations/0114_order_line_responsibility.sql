-- Follow-up arrangements have no business completion state and no historical backfill.
CREATE TABLE order_line_responsibilities (
  work_item_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES organizations(id),
  assigned_user_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
  internal_due_at timestamptz,
  escalation_user_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
  escalation_delay_minutes integer,
  revision integer NOT NULL CHECK(revision>0),
  reason_code text NOT NULL CHECK(reason_code IN ('initial_assignment','handoff','deadline_update','correction')),
  updated_by uuid NOT NULL REFERENCES app_users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  attention_cycle integer NOT NULL DEFAULT 1 CHECK(attention_cycle>0),
  observed_source_checksum text NOT NULL CHECK(observed_source_checksum ~ '^[a-f0-9]{64}$'),
  attention_next_at timestamptz,
  attention_last_error text CHECK(attention_last_error IS NULL OR attention_last_error IN ('RECIPIENT_UNAVAILABLE','ESCALATION_UNAVAILABLE','SOURCE_UNAVAILABLE','DISPATCH_FAILED')),
  assignment_notified_at timestamptz,
  due_notified_at timestamptz,
  escalation_notified_at timestamptz,
  CONSTRAINT order_line_responsibilities_work_fk FOREIGN KEY(tenant_id,work_item_id) REFERENCES order_work_items(tenant_id,id) ON DELETE CASCADE,
  CONSTRAINT order_line_responsibilities_escalation_check CHECK (
    (escalation_user_id IS NULL AND escalation_delay_minutes IS NULL) OR
    (escalation_user_id IS NOT NULL AND assigned_user_id IS NOT NULL AND internal_due_at IS NOT NULL AND escalation_user_id<>assigned_user_id AND escalation_delay_minutes BETWEEN 1 AND 10080)
  )
);
CREATE INDEX order_line_responsibilities_attention_idx ON order_line_responsibilities(tenant_id,attention_next_at);
CREATE INDEX order_line_responsibilities_assignee_due_idx ON order_line_responsibilities(tenant_id,assigned_user_id,internal_due_at,work_item_id);
ALTER TABLE order_line_responsibilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_line_responsibilities FORCE ROW LEVEL SECURITY;
CREATE POLICY order_line_responsibilities_tenant_policy ON order_line_responsibilities FOR ALL TO yummyai_app
  USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid))
  WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
GRANT SELECT,INSERT,UPDATE ON order_line_responsibilities TO yummyai_app;
