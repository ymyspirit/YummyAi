-- Follow-up arrangements only; no business state, old-record backfill or role grants.

CREATE TABLE procurement_order_followups (
 object_id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id),
 assigned_user_id uuid REFERENCES app_users(id) ON DELETE RESTRICT, internal_due_at timestamptz,
 escalation_user_id uuid REFERENCES app_users(id) ON DELETE RESTRICT, escalation_delay_minutes integer,
 revision integer NOT NULL CONSTRAINT procurement_order_followups_revision_check CHECK(revision>0),
 reason_code text NOT NULL CONSTRAINT procurement_order_followups_reason_check CHECK(reason_code IN ('initial_assignment','handoff','deadline_update','correction')),
 updated_by uuid NOT NULL REFERENCES app_users(id), updated_at timestamptz NOT NULL DEFAULT now(),
 attention_cycle integer NOT NULL DEFAULT 1 CONSTRAINT procurement_order_followups_cycle_check CHECK(attention_cycle>0),
 observed_source_checksum text NOT NULL CONSTRAINT procurement_order_followups_checksum_check CHECK(observed_source_checksum ~ '^[a-f0-9]{64}$'),
 attention_next_at timestamptz, attention_last_error text CONSTRAINT procurement_order_followups_error_check CHECK(attention_last_error IS NULL OR attention_last_error IN ('RECIPIENT_UNAVAILABLE','ESCALATION_UNAVAILABLE','SOURCE_UNAVAILABLE','DISPATCH_FAILED')),
 assignment_notified_at timestamptz, due_notified_at timestamptz, escalation_notified_at timestamptz,
 CONSTRAINT procurement_order_followups_member_0_fk FOREIGN KEY(tenant_id,assigned_user_id) REFERENCES memberships(tenant_id,user_id) ON DELETE RESTRICT,
 CONSTRAINT procurement_order_followups_member_1_fk FOREIGN KEY(tenant_id,escalation_user_id) REFERENCES memberships(tenant_id,user_id) ON DELETE RESTRICT,
 CONSTRAINT procurement_order_followups_member_2_fk FOREIGN KEY(tenant_id,updated_by) REFERENCES memberships(tenant_id,user_id) ON DELETE RESTRICT,
 CONSTRAINT procurement_order_followups_source_fk FOREIGN KEY(tenant_id,object_id) REFERENCES inventory_purchase_orders(tenant_id,id) ON DELETE RESTRICT,
 CONSTRAINT procurement_order_followups_escalation_check CHECK((escalation_user_id IS NULL AND escalation_delay_minutes IS NULL) OR (escalation_user_id IS NOT NULL AND assigned_user_id IS NOT NULL AND internal_due_at IS NOT NULL AND escalation_user_id<>assigned_user_id AND escalation_delay_minutes BETWEEN 1 AND 10080))
);
CREATE INDEX procurement_order_followups_attention_idx ON procurement_order_followups(tenant_id,attention_next_at);
CREATE INDEX procurement_order_followups_assignee_due_idx ON procurement_order_followups(tenant_id,assigned_user_id,internal_due_at,object_id);
ALTER TABLE procurement_order_followups ENABLE ROW LEVEL SECURITY;
ALTER TABLE procurement_order_followups FORCE ROW LEVEL SECURITY;
CREATE POLICY procurement_order_followups_tenant_policy ON procurement_order_followups FOR ALL TO yummyai_app USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
GRANT SELECT,INSERT,UPDATE ON procurement_order_followups TO yummyai_app;

CREATE TABLE after_sales_case_followups (
 object_id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id),
 assigned_user_id uuid REFERENCES app_users(id) ON DELETE RESTRICT, internal_due_at timestamptz,
 escalation_user_id uuid REFERENCES app_users(id) ON DELETE RESTRICT, escalation_delay_minutes integer,
 revision integer NOT NULL CONSTRAINT after_sales_case_followups_revision_check CHECK(revision>0),
 reason_code text NOT NULL CONSTRAINT after_sales_case_followups_reason_check CHECK(reason_code IN ('initial_assignment','handoff','deadline_update','correction')),
 updated_by uuid NOT NULL REFERENCES app_users(id), updated_at timestamptz NOT NULL DEFAULT now(),
 attention_cycle integer NOT NULL DEFAULT 1 CONSTRAINT after_sales_case_followups_cycle_check CHECK(attention_cycle>0),
 observed_source_checksum text NOT NULL CONSTRAINT after_sales_case_followups_checksum_check CHECK(observed_source_checksum ~ '^[a-f0-9]{64}$'),
 attention_next_at timestamptz, attention_last_error text CONSTRAINT after_sales_case_followups_error_check CHECK(attention_last_error IS NULL OR attention_last_error IN ('RECIPIENT_UNAVAILABLE','ESCALATION_UNAVAILABLE','SOURCE_UNAVAILABLE','DISPATCH_FAILED')),
 assignment_notified_at timestamptz, due_notified_at timestamptz, escalation_notified_at timestamptz,
 CONSTRAINT after_sales_case_followups_member_0_fk FOREIGN KEY(tenant_id,assigned_user_id) REFERENCES memberships(tenant_id,user_id) ON DELETE RESTRICT,
 CONSTRAINT after_sales_case_followups_member_1_fk FOREIGN KEY(tenant_id,escalation_user_id) REFERENCES memberships(tenant_id,user_id) ON DELETE RESTRICT,
 CONSTRAINT after_sales_case_followups_member_2_fk FOREIGN KEY(tenant_id,updated_by) REFERENCES memberships(tenant_id,user_id) ON DELETE RESTRICT,
 CONSTRAINT after_sales_case_followups_source_fk FOREIGN KEY(tenant_id,object_id) REFERENCES after_sales_cases(tenant_id,id) ON DELETE RESTRICT,
 CONSTRAINT after_sales_case_followups_escalation_check CHECK((escalation_user_id IS NULL AND escalation_delay_minutes IS NULL) OR (escalation_user_id IS NOT NULL AND assigned_user_id IS NOT NULL AND internal_due_at IS NOT NULL AND escalation_user_id<>assigned_user_id AND escalation_delay_minutes BETWEEN 1 AND 10080))
);
CREATE INDEX after_sales_case_followups_attention_idx ON after_sales_case_followups(tenant_id,attention_next_at);
CREATE INDEX after_sales_case_followups_assignee_due_idx ON after_sales_case_followups(tenant_id,assigned_user_id,internal_due_at,object_id);
ALTER TABLE after_sales_case_followups ENABLE ROW LEVEL SECURITY;
ALTER TABLE after_sales_case_followups FORCE ROW LEVEL SECURITY;
CREATE POLICY after_sales_case_followups_tenant_policy ON after_sales_case_followups FOR ALL TO yummyai_app USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
GRANT SELECT,INSERT,UPDATE ON after_sales_case_followups TO yummyai_app;

CREATE TABLE order_exception_followups (
 object_id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id),
 assigned_user_id uuid REFERENCES app_users(id) ON DELETE RESTRICT, internal_due_at timestamptz,
 escalation_user_id uuid REFERENCES app_users(id) ON DELETE RESTRICT, escalation_delay_minutes integer,
 revision integer NOT NULL CONSTRAINT order_exception_followups_revision_check CHECK(revision>0),
 reason_code text NOT NULL CONSTRAINT order_exception_followups_reason_check CHECK(reason_code IN ('initial_assignment','handoff','deadline_update','correction')),
 updated_by uuid NOT NULL REFERENCES app_users(id), updated_at timestamptz NOT NULL DEFAULT now(),
 attention_cycle integer NOT NULL DEFAULT 1 CONSTRAINT order_exception_followups_cycle_check CHECK(attention_cycle>0),
 observed_source_checksum text NOT NULL CONSTRAINT order_exception_followups_checksum_check CHECK(observed_source_checksum ~ '^[a-f0-9]{64}$'),
 attention_next_at timestamptz, attention_last_error text CONSTRAINT order_exception_followups_error_check CHECK(attention_last_error IS NULL OR attention_last_error IN ('RECIPIENT_UNAVAILABLE','ESCALATION_UNAVAILABLE','SOURCE_UNAVAILABLE','DISPATCH_FAILED')),
 assignment_notified_at timestamptz, due_notified_at timestamptz, escalation_notified_at timestamptz,
 CONSTRAINT order_exception_followups_member_0_fk FOREIGN KEY(tenant_id,assigned_user_id) REFERENCES memberships(tenant_id,user_id) ON DELETE RESTRICT,
 CONSTRAINT order_exception_followups_member_1_fk FOREIGN KEY(tenant_id,escalation_user_id) REFERENCES memberships(tenant_id,user_id) ON DELETE RESTRICT,
 CONSTRAINT order_exception_followups_member_2_fk FOREIGN KEY(tenant_id,updated_by) REFERENCES memberships(tenant_id,user_id) ON DELETE RESTRICT,
 CONSTRAINT order_exception_followups_source_fk FOREIGN KEY(tenant_id,object_id) REFERENCES order_exceptions(tenant_id,id) ON DELETE RESTRICT,
 CONSTRAINT order_exception_followups_escalation_check CHECK((escalation_user_id IS NULL AND escalation_delay_minutes IS NULL) OR (escalation_user_id IS NOT NULL AND assigned_user_id IS NOT NULL AND internal_due_at IS NOT NULL AND escalation_user_id<>assigned_user_id AND escalation_delay_minutes BETWEEN 1 AND 10080))
);
CREATE INDEX order_exception_followups_attention_idx ON order_exception_followups(tenant_id,attention_next_at);
CREATE INDEX order_exception_followups_assignee_due_idx ON order_exception_followups(tenant_id,assigned_user_id,internal_due_at,object_id);
ALTER TABLE order_exception_followups ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_exception_followups FORCE ROW LEVEL SECURITY;
CREATE POLICY order_exception_followups_tenant_policy ON order_exception_followups FOR ALL TO yummyai_app USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
GRANT SELECT,INSERT,UPDATE ON order_exception_followups TO yummyai_app;
