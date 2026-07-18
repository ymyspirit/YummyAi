CREATE TABLE "design_tasks" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "sku_id" uuid NOT NULL,
  "title" text NOT NULL,
  "brief" text NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,
  "primary_version_id" uuid,
  "due_at" timestamptz,
  "created_by" uuid REFERENCES "app_users"("id") ON DELETE SET NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "design_tasks_id_uuidv7_check" CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "design_tasks_status_check" CHECK ("status" IN ('open','in_review','approved','archived')),
  CONSTRAINT "design_tasks_sku_fk" FOREIGN KEY ("tenant_id", "sku_id") REFERENCES "skus"("tenant_id", "id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "design_tasks_tenant_id_unique" ON "design_tasks" ("tenant_id", "id");
CREATE INDEX "design_tasks_sku_idx" ON "design_tasks" ("tenant_id", "sku_id", "updated_at");
--> statement-breakpoint
CREATE TABLE "design_versions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "task_id" uuid NOT NULL,
  "version_number" integer NOT NULL,
  "status" text DEFAULT 'pending_review' NOT NULL,
  "change_note" text,
  "rejection_reason" text,
  "created_by" uuid REFERENCES "app_users"("id") ON DELETE SET NULL,
  "reviewed_by" uuid REFERENCES "app_users"("id") ON DELETE SET NULL,
  "reviewed_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "design_versions_id_uuidv7_check" CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "design_versions_number_check" CHECK ("version_number" > 0),
  CONSTRAINT "design_versions_status_check" CHECK ("status" IN ('pending_review','approved','rejected')),
  CONSTRAINT "design_versions_rejection_check" CHECK ("status" <> 'rejected' OR length("rejection_reason") > 0),
  CONSTRAINT "design_versions_task_fk" FOREIGN KEY ("tenant_id", "task_id") REFERENCES "design_tasks"("tenant_id", "id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "design_versions_tenant_id_unique" ON "design_versions" ("tenant_id", "id");
CREATE UNIQUE INDEX "design_versions_task_number_unique" ON "design_versions" ("tenant_id", "task_id", "version_number");
CREATE INDEX "design_versions_task_idx" ON "design_versions" ("tenant_id", "task_id", "created_at");
--> statement-breakpoint
CREATE TABLE "design_version_files" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "version_id" uuid NOT NULL,
  "asset_file_id" uuid NOT NULL,
  "role" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "design_version_files_id_uuidv7_check" CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "design_version_files_role_check" CHECK ("role" IN ('source','effect','production')),
  CONSTRAINT "design_version_files_version_fk" FOREIGN KEY ("tenant_id", "version_id") REFERENCES "design_versions"("tenant_id", "id") ON DELETE CASCADE,
  CONSTRAINT "design_version_files_asset_fk" FOREIGN KEY ("tenant_id", "asset_file_id") REFERENCES "asset_files"("tenant_id", "id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "design_version_files_tenant_id_unique" ON "design_version_files" ("tenant_id", "id");
CREATE UNIQUE INDEX "design_version_files_pair_unique" ON "design_version_files" ("tenant_id", "version_id", "asset_file_id", "role");
CREATE INDEX "design_version_files_version_idx" ON "design_version_files" ("tenant_id", "version_id", "role");
--> statement-breakpoint
CREATE FUNCTION prevent_approved_design_version_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'approved' THEN
    RAISE EXCEPTION 'approved design versions are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER design_versions_immutable BEFORE UPDATE OR DELETE ON design_versions FOR EACH ROW EXECUTE FUNCTION prevent_approved_design_version_mutation();
--> statement-breakpoint
ALTER TABLE "design_tasks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "design_tasks" FORCE ROW LEVEL SECURITY;
CREATE POLICY "design_tasks_tenant_policy" ON "design_tasks" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
ALTER TABLE "design_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "design_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "design_versions_tenant_policy" ON "design_versions" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
ALTER TABLE "design_version_files" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "design_version_files" FORCE ROW LEVEL SECURITY;
CREATE POLICY "design_version_files_tenant_policy" ON "design_version_files" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT, UPDATE, DELETE ON design_tasks, design_versions, design_version_files TO yummyai_app;
