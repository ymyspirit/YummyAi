CREATE TABLE "model_provider_configs" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "provider" text NOT NULL,
  "label" text NOT NULL,
  "endpoint" text,
  "encrypted_api_key" text NOT NULL,
  "status" text DEFAULT 'enabled' NOT NULL,
  "created_by" uuid REFERENCES "app_users"("id") ON DELETE SET NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "model_provider_configs_id_uuidv7_check" CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "model_provider_configs_provider_check" CHECK ("provider" IN ('openai', 'anthropic', 'openai-compatible')),
  CONSTRAINT "model_provider_configs_status_check" CHECK ("status" IN ('enabled', 'disabled'))
);
CREATE UNIQUE INDEX "model_provider_configs_tenant_label_unique" ON "model_provider_configs" ("tenant_id", "label");
CREATE UNIQUE INDEX "model_provider_configs_tenant_id_unique" ON "model_provider_configs" ("tenant_id", "id");
CREATE INDEX "model_provider_configs_tenant_status_idx" ON "model_provider_configs" ("tenant_id", "status");
--> statement-breakpoint
CREATE TABLE "model_routes" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "model_key" text NOT NULL,
  "task_type" text NOT NULL,
  "targets" jsonb NOT NULL,
  "status" text DEFAULT 'enabled' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "model_routes_id_uuidv7_check" CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "model_routes_status_check" CHECK ("status" IN ('enabled', 'disabled'))
);
CREATE UNIQUE INDEX "model_routes_tenant_model_task_unique" ON "model_routes" ("tenant_id", "model_key", "task_type");
CREATE UNIQUE INDEX "model_routes_tenant_id_unique" ON "model_routes" ("tenant_id", "id");
--> statement-breakpoint
CREATE TABLE "ai_budget_policies" (
  "tenant_id" uuid PRIMARY KEY REFERENCES "organizations"("id") ON DELETE CASCADE,
  "monthly_cap_usd" numeric(14,6) NOT NULL,
  "default_task_cap_usd" numeric(14,6) NOT NULL,
  "task_caps_usd" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE TABLE "ai_budget_ledger" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "request_id" uuid NOT NULL,
  "task_type" text NOT NULL,
  "model_key" text NOT NULL,
  "provider" text NOT NULL,
  "amount_usd" numeric(14,6) NOT NULL,
  "state" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "ai_budget_ledger_id_uuidv7_check" CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "ai_budget_ledger_state_check" CHECK ("state" IN ('reserved', 'committed', 'released')),
  CONSTRAINT "ai_budget_ledger_amount_check" CHECK ("amount_usd" >= 0)
);
CREATE INDEX "ai_budget_ledger_month_idx" ON "ai_budget_ledger" ("tenant_id", "created_at");
CREATE INDEX "ai_budget_ledger_request_idx" ON "ai_budget_ledger" ("tenant_id", "request_id");
--> statement-breakpoint
ALTER TABLE "model_provider_configs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "model_provider_configs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "model_provider_configs_tenant_policy" ON "model_provider_configs" FOR ALL TO yummyai_app
  USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
ALTER TABLE "model_routes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "model_routes" FORCE ROW LEVEL SECURITY;
CREATE POLICY "model_routes_tenant_policy" ON "model_routes" FOR ALL TO yummyai_app
  USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
ALTER TABLE "ai_budget_policies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_budget_policies" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ai_budget_policies_tenant_policy" ON "ai_budget_policies" FOR ALL TO yummyai_app
  USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
ALTER TABLE "ai_budget_ledger" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_budget_ledger" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ai_budget_ledger_tenant_policy" ON "ai_budget_ledger" FOR ALL TO yummyai_app
  USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT, UPDATE ON model_provider_configs, model_routes, ai_budget_policies TO yummyai_app;
GRANT SELECT, INSERT ON ai_budget_ledger TO yummyai_app;
