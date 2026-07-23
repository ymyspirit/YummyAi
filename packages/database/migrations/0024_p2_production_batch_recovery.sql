CREATE TABLE "production_batch_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"type" text NOT NULL,
	"external_event_id" text,
	"evidence_code" text NOT NULL,
	"encrypted_note" text,
	"actor_user_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "production_batch_events_id_uuidv7_check" CHECK (substring("production_batch_events"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "production_batch_events_sequence_check" CHECK ("production_batch_events"."sequence" > 0),
	CONSTRAINT "production_batch_events_type_check" CHECK ("production_batch_events"."type" in ('released','started','completed','failed','cancel_requested','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "production_batch_members" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"production_order_id" uuid NOT NULL,
	"added_by" uuid,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "production_batch_members_id_uuidv7_check" CHECK (substring("production_batch_members"."id"::text from 15 for 1) = '7')
);
--> statement-breakpoint
CREATE TABLE "production_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"projection_version" integer DEFAULT 1 NOT NULL,
	"expected_completion_at" timestamp with time zone NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "production_batches_id_uuidv7_check" CHECK (substring("production_batches"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "production_batches_status_check" CHECK ("production_batches"."status" in ('planned','released','in_progress','completed','failed','cancel_requested','cancelled')),
	CONSTRAINT "production_batches_version_check" CHECK ("production_batches"."projection_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "production_recovery_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"recovery_case_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"action" text NOT NULL,
	"from_status" text NOT NULL,
	"to_status" text NOT NULL,
	"outcome_code" text NOT NULL,
	"encrypted_note" text,
	"external_reference" text,
	"actor_user_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "production_recovery_events_id_uuidv7_check" CHECK (substring("production_recovery_events"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "production_recovery_events_sequence_check" CHECK ("production_recovery_events"."sequence" > 0),
	CONSTRAINT "production_recovery_events_action_check" CHECK ("production_recovery_events"."action" in ('start','resolve','cancel')),
	CONSTRAINT "production_recovery_events_status_check" CHECK ("production_recovery_events"."from_status" in ('open','in_progress','resolved','cancelled') and "production_recovery_events"."to_status" in ('open','in_progress','resolved','cancelled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "production_batch_events_tenant_id_unique" ON "production_batch_events" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "production_batch_members_tenant_id_unique" ON "production_batch_members" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "production_batches_tenant_id_unique" ON "production_batches" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "production_recovery_events_tenant_id_unique" ON "production_recovery_events" USING btree ("tenant_id","id");--> statement-breakpoint
ALTER TABLE "production_batch_events" ADD CONSTRAINT "production_batch_events_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_batch_events" ADD CONSTRAINT "production_batch_events_actor_user_id_app_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_batch_events" ADD CONSTRAINT "production_batch_events_batch_fk" FOREIGN KEY ("tenant_id","batch_id") REFERENCES "public"."production_batches"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_batch_members" ADD CONSTRAINT "production_batch_members_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_batch_members" ADD CONSTRAINT "production_batch_members_added_by_app_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_batch_members" ADD CONSTRAINT "production_batch_members_batch_fk" FOREIGN KEY ("tenant_id","batch_id") REFERENCES "public"."production_batches"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_batch_members" ADD CONSTRAINT "production_batch_members_order_fk" FOREIGN KEY ("tenant_id","production_order_id") REFERENCES "public"."production_orders"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_batches" ADD CONSTRAINT "production_batches_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_batches" ADD CONSTRAINT "production_batches_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_batches" ADD CONSTRAINT "production_batches_supplier_fk" FOREIGN KEY ("tenant_id","supplier_id") REFERENCES "public"."fulfillment_suppliers"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_recovery_events" ADD CONSTRAINT "production_recovery_events_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_recovery_events" ADD CONSTRAINT "production_recovery_events_actor_user_id_app_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_recovery_events" ADD CONSTRAINT "production_recovery_events_case_fk" FOREIGN KEY ("tenant_id","recovery_case_id") REFERENCES "public"."production_recovery_cases"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "production_batch_events_sequence_unique" ON "production_batch_events" USING btree ("tenant_id","batch_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "production_batch_events_external_unique" ON "production_batch_events" USING btree ("tenant_id","batch_id","external_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "production_batch_members_order_unique" ON "production_batch_members" USING btree ("tenant_id","production_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "production_batch_members_pair_unique" ON "production_batch_members" USING btree ("tenant_id","batch_id","production_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "production_batches_idempotency_unique" ON "production_batches" USING btree ("tenant_id","supplier_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "production_batches_queue_idx" ON "production_batches" USING btree ("tenant_id","status","expected_completion_at");--> statement-breakpoint
CREATE UNIQUE INDEX "production_recovery_events_sequence_unique" ON "production_recovery_events" USING btree ("tenant_id","recovery_case_id","sequence");
--> statement-breakpoint
ALTER TABLE "production_batches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "production_batches" FORCE ROW LEVEL SECURITY;
CREATE POLICY "production_batches_tenant_policy" ON "production_batches" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT, UPDATE ON "production_batches" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "production_batch_members" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "production_batch_members" FORCE ROW LEVEL SECURITY;
CREATE POLICY "production_batch_members_tenant_policy" ON "production_batch_members" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "production_batch_members" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "production_batch_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "production_batch_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "production_batch_events_tenant_policy" ON "production_batch_events" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "production_batch_events" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "production_recovery_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "production_recovery_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "production_recovery_events_tenant_policy" ON "production_recovery_events" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "production_recovery_events" TO yummyai_app;
