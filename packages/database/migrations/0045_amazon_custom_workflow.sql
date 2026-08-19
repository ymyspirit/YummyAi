CREATE TABLE "amazon_custom_workflow_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"step_key" text NOT NULL,
	"action" text NOT NULL,
	"from_status" text NOT NULL,
	"to_status" text NOT NULL,
	"note" text,
	"actor_user_id" uuid,
	"workflow_revision" integer NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "amazon_custom_workflow_events_id_uuidv7_check" CHECK (substring("amazon_custom_workflow_events"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "amazon_custom_workflow_events_action_check" CHECK ("amazon_custom_workflow_events"."action" in ('workflow_started','step_started','step_blocked','step_unblocked','step_completed','step_reopened')),
	CONSTRAINT "amazon_custom_workflow_events_step_key_check" CHECK ("amazon_custom_workflow_events"."step_key" in ('research_capture','research_review','product_plan','provisional_facts','seller_facts','customization_schema','spu_sku','design_proof','authorized_assets','studio_draft','studio_content','content_review','seller_central','online_qa')),
	CONSTRAINT "amazon_custom_workflow_events_from_status_check" CHECK ("amazon_custom_workflow_events"."from_status" in ('not_started','in_progress','blocked','completed')),
	CONSTRAINT "amazon_custom_workflow_events_to_status_check" CHECK ("amazon_custom_workflow_events"."to_status" in ('not_started','in_progress','blocked','completed')),
	CONSTRAINT "amazon_custom_workflow_events_revision_check" CHECK ("amazon_custom_workflow_events"."workflow_revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "amazon_custom_workflow_steps" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"step_key" text NOT NULL,
	"status" text NOT NULL,
	"note" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "amazon_custom_workflow_steps_id_uuidv7_check" CHECK (substring("amazon_custom_workflow_steps"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "amazon_custom_workflow_steps_status_check" CHECK ("amazon_custom_workflow_steps"."status" in ('not_started','in_progress','blocked','completed')),
	CONSTRAINT "amazon_custom_workflow_steps_key_check" CHECK ("amazon_custom_workflow_steps"."step_key" in ('research_capture','research_review','product_plan','provisional_facts','seller_facts','customization_schema','spu_sku','design_proof','authorized_assets','studio_draft','studio_content','content_review','seller_central','online_qa')),
	CONSTRAINT "amazon_custom_workflow_steps_blocker_check" CHECK ("amazon_custom_workflow_steps"."status" <> 'blocked' or length("amazon_custom_workflow_steps"."note") > 0),
	CONSTRAINT "amazon_custom_workflow_steps_started_check" CHECK ("amazon_custom_workflow_steps"."status" = 'not_started' or "amazon_custom_workflow_steps"."started_at" is not null),
	CONSTRAINT "amazon_custom_workflow_steps_completed_check" CHECK ("amazon_custom_workflow_steps"."status" <> 'completed' or "amazon_custom_workflow_steps"."completed_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "amazon_custom_workflows" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"product_plan_id" uuid NOT NULL,
	"status" text NOT NULL,
	"current_step_key" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "amazon_custom_workflows_id_uuidv7_check" CHECK (substring("amazon_custom_workflows"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "amazon_custom_workflows_status_check" CHECK ("amazon_custom_workflows"."status" in ('active','blocked','completed')),
	CONSTRAINT "amazon_custom_workflows_current_step_check" CHECK (("amazon_custom_workflows"."status" = 'completed' and "amazon_custom_workflows"."current_step_key" is null) or ("amazon_custom_workflows"."status" <> 'completed' and "amazon_custom_workflows"."current_step_key" in ('research_capture','research_review','product_plan','provisional_facts','seller_facts','customization_schema','spu_sku','design_proof','authorized_assets','studio_draft','studio_content','content_review','seller_central','online_qa'))),
	CONSTRAINT "amazon_custom_workflows_revision_check" CHECK ("amazon_custom_workflows"."revision" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "amazon_custom_workflows_tenant_id_unique" ON "amazon_custom_workflows" USING btree ("tenant_id","id");
--> statement-breakpoint
ALTER TABLE "amazon_custom_workflow_events" ADD CONSTRAINT "amazon_custom_workflow_events_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amazon_custom_workflow_events" ADD CONSTRAINT "amazon_custom_workflow_events_actor_user_id_app_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amazon_custom_workflow_events" ADD CONSTRAINT "amazon_custom_workflow_events_workflow_fk" FOREIGN KEY ("tenant_id","workflow_id") REFERENCES "public"."amazon_custom_workflows"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amazon_custom_workflow_steps" ADD CONSTRAINT "amazon_custom_workflow_steps_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amazon_custom_workflow_steps" ADD CONSTRAINT "amazon_custom_workflow_steps_updated_by_app_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amazon_custom_workflow_steps" ADD CONSTRAINT "amazon_custom_workflow_steps_workflow_fk" FOREIGN KEY ("tenant_id","workflow_id") REFERENCES "public"."amazon_custom_workflows"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amazon_custom_workflows" ADD CONSTRAINT "amazon_custom_workflows_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amazon_custom_workflows" ADD CONSTRAINT "amazon_custom_workflows_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amazon_custom_workflows" ADD CONSTRAINT "amazon_custom_workflows_product_plan_fk" FOREIGN KEY ("tenant_id","product_plan_id") REFERENCES "public"."product_plans"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "amazon_custom_workflow_events_tenant_id_unique" ON "amazon_custom_workflow_events" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX "amazon_custom_workflow_events_workflow_idx" ON "amazon_custom_workflow_events" USING btree ("tenant_id","workflow_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "amazon_custom_workflow_steps_tenant_id_unique" ON "amazon_custom_workflow_steps" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "amazon_custom_workflow_steps_key_unique" ON "amazon_custom_workflow_steps" USING btree ("tenant_id","workflow_id","step_key");--> statement-breakpoint
CREATE INDEX "amazon_custom_workflow_steps_workflow_idx" ON "amazon_custom_workflow_steps" USING btree ("tenant_id","workflow_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "amazon_custom_workflows_plan_unique" ON "amazon_custom_workflows" USING btree ("tenant_id","product_plan_id");--> statement-breakpoint
CREATE INDEX "amazon_custom_workflows_status_idx" ON "amazon_custom_workflows" USING btree ("tenant_id","status","updated_at");
--> statement-breakpoint
CREATE FUNCTION prevent_amazon_custom_workflow_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'amazon custom workflow events are immutable' USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER amazon_custom_workflow_events_immutable BEFORE UPDATE OR DELETE ON amazon_custom_workflow_events FOR EACH ROW EXECUTE FUNCTION prevent_amazon_custom_workflow_event_mutation();
--> statement-breakpoint
ALTER TABLE "amazon_custom_workflows" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "amazon_custom_workflows" FORCE ROW LEVEL SECURITY;
CREATE POLICY "amazon_custom_workflows_tenant_policy" ON "amazon_custom_workflows" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
ALTER TABLE "amazon_custom_workflow_steps" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "amazon_custom_workflow_steps" FORCE ROW LEVEL SECURITY;
CREATE POLICY "amazon_custom_workflow_steps_tenant_policy" ON "amazon_custom_workflow_steps" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
ALTER TABLE "amazon_custom_workflow_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "amazon_custom_workflow_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "amazon_custom_workflow_events_tenant_policy" ON "amazon_custom_workflow_events" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT, UPDATE ON amazon_custom_workflows, amazon_custom_workflow_steps TO yummyai_app;
GRANT SELECT, INSERT ON amazon_custom_workflow_events TO yummyai_app;
