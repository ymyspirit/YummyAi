-- This infrastructure index exposes tenant UUIDs only to the dispatcher. Every
-- order, execution, outbox, and private asset read still uses tenant RLS.
CREATE TABLE order_design_dispatch_tenants (
 tenant_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE
);
ALTER TABLE order_design_dispatch_tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_design_dispatch_tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY order_design_dispatch_tenants_read ON order_design_dispatch_tenants FOR SELECT TO yummyai_app USING(true);
CREATE POLICY order_design_dispatch_tenants_register ON order_design_dispatch_tenants FOR INSERT TO yummyai_app WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
GRANT SELECT,INSERT ON order_design_dispatch_tenants TO yummyai_app;
--> statement-breakpoint
CREATE TABLE order_design_agent_runs (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), work_item_id uuid NOT NULL, work_revision_id uuid NOT NULL,
 revision integer NOT NULL DEFAULT 1 CHECK (revision > 0), status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','awaiting_review','needs_attention','cancelled')),
 executor_key text NOT NULL, recipe_version text NOT NULL, policy_version text NOT NULL, model_route_id uuid,
 encrypted_snapshot text NOT NULL, input_checksum text NOT NULL CHECK (input_checksum ~ '^[0-9a-f]{64}$'),
 project_id uuid, current_editor_version_id uuid, processing_token uuid, lease_until timestamptz, error_code text,
 quality_diagnostics jsonb NOT NULL DEFAULT '[]'::jsonb,
 estimated_cost_usd numeric(14,6) CHECK (estimated_cost_usd >= 0), actual_cost_usd numeric(14,6) CHECK (actual_cost_usd >= 0),
 cost_status text NOT NULL DEFAULT 'unknown' CHECK (cost_status IN ('not_required','estimated','unknown','reported')),
 requested_by uuid NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT order_design_runs_tenant_id_unique UNIQUE(tenant_id,id),
 CONSTRAINT order_design_runs_revision_unique UNIQUE(tenant_id,work_item_id,work_revision_id),
 CONSTRAINT order_design_runs_work_fk FOREIGN KEY(tenant_id,work_item_id) REFERENCES order_work_items(tenant_id,id),
 CONSTRAINT order_design_runs_revision_fk FOREIGN KEY(tenant_id,work_item_id,work_revision_id) REFERENCES order_work_revisions(tenant_id,work_item_id,id),
 CONSTRAINT order_design_runs_project_fk FOREIGN KEY(tenant_id,project_id) REFERENCES production_editor_projects(tenant_id,id),
 CONSTRAINT order_design_runs_editor_version_fk FOREIGN KEY(tenant_id,project_id,current_editor_version_id) REFERENCES production_editor_versions(tenant_id,project_id,id)
);
--> statement-breakpoint
CREATE INDEX order_design_runs_status_idx ON order_design_agent_runs(tenant_id,status,updated_at);
CREATE TABLE order_design_agent_steps (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), run_id uuid NOT NULL,
 key text NOT NULL, label text NOT NULL, position integer NOT NULL CHECK(position>=0), status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','completed','failed','uncertain','skipped')),
 attempt integer NOT NULL DEFAULT 0 CHECK(attempt>=0), request_id uuid NOT NULL,
 encrypted_input text NOT NULL, encrypted_output text, input_checksum text NOT NULL CHECK(input_checksum ~ '^[0-9a-f]{64}$'),
 output_asset_id uuid, output_version_id uuid, error_code text, started_at timestamptz, completed_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT order_design_steps_tenant_id_unique UNIQUE(tenant_id,id),
 CONSTRAINT order_design_steps_key_unique UNIQUE(tenant_id,run_id,key),
 CONSTRAINT order_design_steps_run_fk FOREIGN KEY(tenant_id,run_id) REFERENCES order_design_agent_runs(tenant_id,id)
);
--> statement-breakpoint
CREATE TABLE order_design_agent_outbox (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), run_id uuid NOT NULL, requested_by uuid NOT NULL REFERENCES app_users(id),
 dispatched_at timestamptz, next_attempt_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT order_design_outbox_run_fk FOREIGN KEY(tenant_id,run_id) REFERENCES order_design_agent_runs(tenant_id,id)
);
CREATE INDEX order_design_outbox_pending_idx ON order_design_agent_outbox(tenant_id,dispatched_at,next_attempt_at);
CREATE TABLE order_design_agent_commands (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), run_id uuid NOT NULL, idempotency_key uuid NOT NULL,
 action text NOT NULL CHECK(action IN ('resume','takeover')), request_checksum text NOT NULL, requested_by uuid NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT order_design_commands_run_fk FOREIGN KEY(tenant_id,run_id) REFERENCES order_design_agent_runs(tenant_id,id),
 CONSTRAINT order_design_commands_idempotency_unique UNIQUE(tenant_id,run_id,idempotency_key)
);
--> statement-breakpoint
ALTER TABLE order_design_agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_design_agent_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE order_design_agent_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_design_agent_steps FORCE ROW LEVEL SECURITY;
ALTER TABLE order_design_agent_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_design_agent_outbox FORCE ROW LEVEL SECURITY;
ALTER TABLE order_design_agent_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_design_agent_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY order_design_runs_tenant_policy ON order_design_agent_runs FOR ALL TO yummyai_app USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
CREATE POLICY order_design_steps_tenant_policy ON order_design_agent_steps FOR ALL TO yummyai_app USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
CREATE POLICY order_design_outbox_tenant_policy ON order_design_agent_outbox FOR ALL TO yummyai_app USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
CREATE POLICY order_design_commands_tenant_policy ON order_design_agent_commands FOR ALL TO yummyai_app USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
GRANT SELECT,INSERT,UPDATE ON order_design_agent_runs,order_design_agent_steps,order_design_agent_outbox TO yummyai_app;
GRANT SELECT,INSERT ON order_design_agent_commands TO yummyai_app;
