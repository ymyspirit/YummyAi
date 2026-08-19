CREATE TABLE "job_progress_events" (
  "id" uuid PRIMARY KEY NOT NULL, "tenant_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "job_id" uuid NOT NULL, "requested_by" uuid REFERENCES "app_users"("id") ON DELETE SET NULL,
  "state" text NOT NULL, "progress" integer NOT NULL, "message" text, "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "occurred_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "job_progress_events_id_uuidv7_check" CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "job_progress_events_job_uuidv7_check" CHECK (substring("job_id"::text from 15 for 1) = '7'),
  CONSTRAINT "job_progress_events_state_check" CHECK ("state" IN ('queued','running','completed','failed','cancelled')),
  CONSTRAINT "job_progress_events_progress_check" CHECK ("progress" BETWEEN 0 AND 100)
);
CREATE UNIQUE INDEX "job_progress_events_tenant_id_unique" ON "job_progress_events" ("tenant_id", "id");
CREATE INDEX "job_progress_events_job_idx" ON "job_progress_events" ("tenant_id", "job_id", "occurred_at");
CREATE INDEX "job_progress_events_resume_idx" ON "job_progress_events" ("tenant_id", "occurred_at", "id");
--> statement-breakpoint
CREATE TABLE "notifications" (
  "id" uuid PRIMARY KEY NOT NULL, "tenant_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "app_users"("id") ON DELETE CASCADE,
  "kind" text NOT NULL, "title" text NOT NULL, "body" text NOT NULL, "resource_type" text, "resource_id" uuid,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL, "read_at" timestamptz, "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "notifications_id_uuidv7_check" CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "notifications_kind_check" CHECK ("kind" IN ('job_completed','job_failed','review_requested','review_decided','design_overdue','system'))
);
CREATE UNIQUE INDEX "notifications_tenant_id_unique" ON "notifications" ("tenant_id", "id");
CREATE INDEX "notifications_inbox_idx" ON "notifications" ("tenant_id", "user_id", "read_at", "created_at");
--> statement-breakpoint
ALTER TABLE "job_progress_events" ENABLE ROW LEVEL SECURITY; ALTER TABLE "job_progress_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "job_progress_events_tenant_policy" ON "job_progress_events" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY; ALTER TABLE "notifications" FORCE ROW LEVEL SECURITY;
CREATE POLICY "notifications_tenant_policy" ON "notifications" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT, UPDATE, DELETE ON job_progress_events, notifications TO yummyai_app;
