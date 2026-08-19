CREATE TABLE "fulfillment_automation_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"action" text NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"code" text,
	"summary" text,
	"encrypted_detail" text,
	"detail_checksum" text,
	"idempotency_key" text NOT NULL,
	"actor_user_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fulfillment_automation_events_id_uuidv7_check" CHECK (substring("fulfillment_automation_events"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "fulfillment_automation_events_sequence_check" CHECK ("fulfillment_automation_events"."sequence" > 0),
	CONSTRAINT "fulfillment_automation_events_action_check" CHECK ("fulfillment_automation_events"."action" in ('scheduled','claimed','completed','retry_scheduled','failed','dead_letter','cancelled','reconciliation_required','reconciled')),
	CONSTRAINT "fulfillment_automation_events_detail_check" CHECK (("fulfillment_automation_events"."encrypted_detail" is null and "fulfillment_automation_events"."detail_checksum" is null) or ("fulfillment_automation_events"."encrypted_detail" is not null and "fulfillment_automation_events"."detail_checksum" ~ '^[0-9a-f]{64}$'))
);
--> statement-breakpoint
CREATE TABLE "fulfillment_automation_policies" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"hourly_quota" integer DEFAULT 20 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fulfillment_automation_policies_quota_check" CHECK ("fulfillment_automation_policies"."hourly_quota" between 1 and 1000),
	CONSTRAINT "fulfillment_automation_policies_attempts_check" CHECK ("fulfillment_automation_policies"."max_attempts" between 1 and 5)
);
--> statement-breakpoint
CREATE TABLE "fulfillment_automation_tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"run_at" timestamp with time zone NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer NOT NULL,
	"projection_version" integer DEFAULT 1 NOT NULL,
	"idempotency_key" text NOT NULL,
	"requested_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fulfillment_automation_tasks_id_uuidv7_check" CHECK (substring("fulfillment_automation_tasks"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "fulfillment_automation_tasks_type_check" CHECK ("fulfillment_automation_tasks"."type" in ('attention_scan','shipment_reconciliation_scan','pii_retention_scan')),
	CONSTRAINT "fulfillment_automation_tasks_status_check" CHECK ("fulfillment_automation_tasks"."status" in ('scheduled','running','completed','failed','cancelled','dead_letter','reconciliation_required')),
	CONSTRAINT "fulfillment_automation_tasks_attempts_check" CHECK ("fulfillment_automation_tasks"."attempt_count" >= 0 and "fulfillment_automation_tasks"."max_attempts" between 1 and 5 and "fulfillment_automation_tasks"."attempt_count" <= "fulfillment_automation_tasks"."max_attempts"),
	CONSTRAINT "fulfillment_automation_tasks_version_check" CHECK ("fulfillment_automation_tasks"."projection_version" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "fulfillment_automation_tasks_tenant_id_unique" ON "fulfillment_automation_tasks" USING btree ("tenant_id","id");--> statement-breakpoint
ALTER TABLE "fulfillment_automation_events" ADD CONSTRAINT "fulfillment_automation_events_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillment_automation_events" ADD CONSTRAINT "fulfillment_automation_events_actor_user_id_app_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillment_automation_events" ADD CONSTRAINT "fulfillment_automation_events_task_fk" FOREIGN KEY ("tenant_id","task_id") REFERENCES "public"."fulfillment_automation_tasks"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillment_automation_policies" ADD CONSTRAINT "fulfillment_automation_policies_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillment_automation_policies" ADD CONSTRAINT "fulfillment_automation_policies_updated_by_app_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillment_automation_tasks" ADD CONSTRAINT "fulfillment_automation_tasks_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillment_automation_tasks" ADD CONSTRAINT "fulfillment_automation_tasks_requested_by_app_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."app_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fulfillment_automation_events_tenant_id_unique" ON "fulfillment_automation_events" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "fulfillment_automation_events_sequence_unique" ON "fulfillment_automation_events" USING btree ("tenant_id","task_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "fulfillment_automation_events_idempotency_unique" ON "fulfillment_automation_events" USING btree ("tenant_id","task_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "fulfillment_automation_tasks_idempotency_unique" ON "fulfillment_automation_tasks" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "fulfillment_automation_tasks_queue_idx" ON "fulfillment_automation_tasks" USING btree ("tenant_id","status","run_at");--> statement-breakpoint
CREATE INDEX "fulfillment_automation_tasks_quota_idx" ON "fulfillment_automation_tasks" USING btree ("tenant_id","created_at");
--> statement-breakpoint
ALTER TABLE "fulfillment_automation_policies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "fulfillment_automation_policies" FORCE ROW LEVEL SECURITY;
CREATE POLICY "fulfillment_automation_policies_tenant_policy" ON "fulfillment_automation_policies" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT, UPDATE ON "fulfillment_automation_policies" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "fulfillment_automation_tasks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "fulfillment_automation_tasks" FORCE ROW LEVEL SECURITY;
CREATE POLICY "fulfillment_automation_tasks_tenant_policy" ON "fulfillment_automation_tasks" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT, UPDATE ON "fulfillment_automation_tasks" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "fulfillment_automation_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "fulfillment_automation_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "fulfillment_automation_events_tenant_policy" ON "fulfillment_automation_events" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "fulfillment_automation_events" TO yummyai_app;
