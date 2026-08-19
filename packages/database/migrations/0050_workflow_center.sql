CREATE TABLE "workflow_definitions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "stable_key" text NOT NULL,
  "name" text NOT NULL,
  "description" text DEFAULT '' NOT NULL,
  "category" text NOT NULL,
  "scope" text NOT NULL,
  "status" text NOT NULL,
  "current_draft_version_id" uuid,
  "current_published_version_id" uuid,
  "revision" integer DEFAULT 0 NOT NULL,
  "created_by" uuid REFERENCES "app_users"("id") ON DELETE set null,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "workflow_definitions_id_uuidv7_check" CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "workflow_definitions_scope_check" CHECK ("scope" in ('official','team','personal')),
  CONSTRAINT "workflow_definitions_status_check" CHECK ("status" in ('draft','published','archived')),
  CONSTRAINT "workflow_definitions_revision_check" CHECK ("revision" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_definitions_tenant_id_unique" ON "workflow_definitions" ("tenant_id","id");
CREATE UNIQUE INDEX "workflow_definitions_stable_key_unique" ON "workflow_definitions" ("tenant_id","stable_key");
CREATE INDEX "workflow_definitions_catalog_idx" ON "workflow_definitions" ("tenant_id","scope","status","updated_at");
--> statement-breakpoint
CREATE TABLE "workflow_definition_versions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "definition_id" uuid NOT NULL,
  "version" integer NOT NULL,
  "status" text NOT NULL,
  "graph" jsonb NOT NULL,
  "validation" jsonb NOT NULL,
  "checksum" text NOT NULL,
  "created_by" uuid REFERENCES "app_users"("id") ON DELETE set null,
  "published_by" uuid REFERENCES "app_users"("id") ON DELETE set null,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "published_at" timestamp with time zone,
  CONSTRAINT "workflow_definition_versions_id_uuidv7_check" CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "workflow_definition_versions_version_check" CHECK ("version" > 0),
  CONSTRAINT "workflow_definition_versions_status_check" CHECK ("status" in ('draft','published')),
  CONSTRAINT "workflow_definition_versions_checksum_check" CHECK ("checksum" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "workflow_definition_versions_definition_fk" FOREIGN KEY ("tenant_id","definition_id") REFERENCES "workflow_definitions"("tenant_id","id") ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_definition_versions_tenant_id_unique" ON "workflow_definition_versions" ("tenant_id","id");
CREATE UNIQUE INDEX "workflow_definition_versions_number_unique" ON "workflow_definition_versions" ("tenant_id","definition_id","version");
CREATE INDEX "workflow_definition_versions_status_idx" ON "workflow_definition_versions" ("tenant_id","definition_id","status");
--> statement-breakpoint
ALTER TABLE "workflow_definitions" ADD CONSTRAINT "workflow_definitions_draft_version_fk" FOREIGN KEY ("tenant_id","current_draft_version_id") REFERENCES "workflow_definition_versions"("tenant_id","id") ON DELETE set null;
ALTER TABLE "workflow_definitions" ADD CONSTRAINT "workflow_definitions_published_version_fk" FOREIGN KEY ("tenant_id","current_published_version_id") REFERENCES "workflow_definition_versions"("tenant_id","id") ON DELETE restrict;
--> statement-breakpoint
CREATE TABLE "workflow_runs" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "definition_id" uuid NOT NULL,
  "definition_version_id" uuid NOT NULL,
  "product_plan_id" uuid NOT NULL,
  "legacy_amazon_workflow_id" uuid,
  "title" text NOT NULL,
  "status" text NOT NULL,
  "current_node_id" text,
  "revision" integer DEFAULT 1 NOT NULL,
  "started_by" uuid REFERENCES "app_users"("id") ON DELETE set null,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "workflow_runs_id_uuidv7_check" CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "workflow_runs_status_check" CHECK ("status" in ('not_started','active','blocked','failed','completed','cancelled')),
  CONSTRAINT "workflow_runs_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "workflow_runs_definition_fk" FOREIGN KEY ("tenant_id","definition_id") REFERENCES "workflow_definitions"("tenant_id","id") ON DELETE restrict,
  CONSTRAINT "workflow_runs_definition_version_fk" FOREIGN KEY ("tenant_id","definition_version_id") REFERENCES "workflow_definition_versions"("tenant_id","id") ON DELETE restrict,
  CONSTRAINT "workflow_runs_product_plan_fk" FOREIGN KEY ("tenant_id","product_plan_id") REFERENCES "product_plans"("tenant_id","id") ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_runs_tenant_id_unique" ON "workflow_runs" ("tenant_id","id");
CREATE UNIQUE INDEX "workflow_runs_legacy_amazon_unique" ON "workflow_runs" ("tenant_id","legacy_amazon_workflow_id") WHERE "legacy_amazon_workflow_id" IS NOT NULL;
CREATE INDEX "workflow_runs_status_idx" ON "workflow_runs" ("tenant_id","status","updated_at");
CREATE INDEX "workflow_runs_product_idx" ON "workflow_runs" ("tenant_id","product_plan_id","updated_at");
--> statement-breakpoint
CREATE TABLE "workflow_node_runs" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "run_id" uuid NOT NULL,
  "node_id" text NOT NULL,
  "status" text NOT NULL,
  "note" text,
  "blocker_reason" text,
  "parameter_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "assigned_user_id" uuid REFERENCES "app_users"("id") ON DELETE set null,
  "updated_by" uuid REFERENCES "app_users"("id") ON DELETE set null,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "workflow_node_runs_id_uuidv7_check" CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "workflow_node_runs_status_check" CHECK ("status" in ('not_started','in_progress','blocked','failed','completed','skipped','cancelled')),
  CONSTRAINT "workflow_node_runs_attempt_count_check" CHECK ("attempt_count" >= 0),
  CONSTRAINT "workflow_node_runs_blocker_check" CHECK ("status" <> 'blocked' or length("blocker_reason") > 0),
  CONSTRAINT "workflow_node_runs_run_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "workflow_runs"("tenant_id","id") ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_node_runs_tenant_id_unique" ON "workflow_node_runs" ("tenant_id","id");
CREATE UNIQUE INDEX "workflow_node_runs_node_unique" ON "workflow_node_runs" ("tenant_id","run_id","node_id");
CREATE INDEX "workflow_node_runs_status_idx" ON "workflow_node_runs" ("tenant_id","run_id","status","updated_at");
--> statement-breakpoint
CREATE TABLE "workflow_node_attempts" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "node_run_id" uuid NOT NULL,
  "attempt_number" integer NOT NULL,
  "status" text NOT NULL,
  "queue_job_id" text,
  "error_code" text,
  "error_message" text,
  "queued_at" timestamp with time zone DEFAULT now() NOT NULL,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  CONSTRAINT "workflow_node_attempts_id_uuidv7_check" CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "workflow_node_attempts_number_check" CHECK ("attempt_number" > 0),
  CONSTRAINT "workflow_node_attempts_status_check" CHECK ("status" in ('queued','running','failed','completed','cancelled')),
  CONSTRAINT "workflow_node_attempts_node_run_fk" FOREIGN KEY ("tenant_id","node_run_id") REFERENCES "workflow_node_runs"("tenant_id","id") ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_node_attempts_tenant_id_unique" ON "workflow_node_attempts" ("tenant_id","id");
CREATE UNIQUE INDEX "workflow_node_attempts_number_unique" ON "workflow_node_attempts" ("tenant_id","node_run_id","attempt_number");
CREATE INDEX "workflow_node_attempts_status_idx" ON "workflow_node_attempts" ("tenant_id","status","queued_at");
--> statement-breakpoint
CREATE TABLE "workflow_artifact_links" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "run_id" uuid NOT NULL,
  "node_run_id" uuid NOT NULL,
  "artifact_type" text NOT NULL,
  "artifact_id" text NOT NULL,
  "artifact_version" text,
  "label" text NOT NULL,
  "validation_status" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "workflow_artifact_links_id_uuidv7_check" CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "workflow_artifact_links_validation_check" CHECK ("validation_status" in ('pending','valid','invalid')),
  CONSTRAINT "workflow_artifact_links_run_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "workflow_runs"("tenant_id","id") ON DELETE cascade,
  CONSTRAINT "workflow_artifact_links_node_run_fk" FOREIGN KEY ("tenant_id","node_run_id") REFERENCES "workflow_node_runs"("tenant_id","id") ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_artifact_links_tenant_id_unique" ON "workflow_artifact_links" ("tenant_id","id");
CREATE INDEX "workflow_artifact_links_run_idx" ON "workflow_artifact_links" ("tenant_id","run_id","created_at");
--> statement-breakpoint
CREATE TABLE "workflow_run_events" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "run_id" uuid NOT NULL,
  "node_id" text,
  "type" text NOT NULL,
  "from_status" text,
  "to_status" text,
  "note" text,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "actor_user_id" uuid REFERENCES "app_users"("id") ON DELETE set null,
  "run_revision" integer NOT NULL,
  "occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "workflow_run_events_id_uuidv7_check" CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "workflow_run_events_revision_check" CHECK ("run_revision" > 0),
  CONSTRAINT "workflow_run_events_run_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "workflow_runs"("tenant_id","id") ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_run_events_tenant_id_unique" ON "workflow_run_events" ("tenant_id","id");
CREATE INDEX "workflow_run_events_run_idx" ON "workflow_run_events" ("tenant_id","run_id","occurred_at");
--> statement-breakpoint
CREATE FUNCTION prevent_workflow_definition_version_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'workflow definition versions are immutable' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER workflow_definition_versions_immutable BEFORE UPDATE OR DELETE ON workflow_definition_versions FOR EACH ROW EXECUTE FUNCTION prevent_workflow_definition_version_mutation();
CREATE FUNCTION prevent_workflow_run_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'workflow run events are immutable' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER workflow_run_events_immutable BEFORE UPDATE OR DELETE ON workflow_run_events FOR EACH ROW EXECUTE FUNCTION prevent_workflow_run_event_mutation();
--> statement-breakpoint
ALTER TABLE "workflow_definitions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workflow_definitions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "workflow_definitions_tenant_policy" ON "workflow_definitions" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
ALTER TABLE "workflow_definition_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workflow_definition_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "workflow_definition_versions_tenant_policy" ON "workflow_definition_versions" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
ALTER TABLE "workflow_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workflow_runs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "workflow_runs_tenant_policy" ON "workflow_runs" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
ALTER TABLE "workflow_node_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workflow_node_runs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "workflow_node_runs_tenant_policy" ON "workflow_node_runs" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
ALTER TABLE "workflow_node_attempts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workflow_node_attempts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "workflow_node_attempts_tenant_policy" ON "workflow_node_attempts" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
ALTER TABLE "workflow_artifact_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workflow_artifact_links" FORCE ROW LEVEL SECURITY;
CREATE POLICY "workflow_artifact_links_tenant_policy" ON "workflow_artifact_links" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
ALTER TABLE "workflow_run_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workflow_run_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "workflow_run_events_tenant_policy" ON "workflow_run_events" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON workflow_definitions, workflow_runs, workflow_node_runs, workflow_node_attempts TO yummyai_app;
GRANT SELECT, INSERT ON workflow_definition_versions, workflow_artifact_links, workflow_run_events TO yummyai_app;
