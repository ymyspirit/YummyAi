CREATE TABLE "order_work_assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"work_item_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"preview_object_key" text NOT NULL,
	"encrypted_metadata" text NOT NULL,
	"checksum" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_work_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"work_item_id" uuid NOT NULL,
	"action" text NOT NULL,
	"from_state" text NOT NULL,
	"to_state" text NOT NULL,
	"revision" integer NOT NULL,
	"encrypted_reason" text NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_work_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"report_line_id" uuid,
	"source_version_id" uuid,
	"encrypted_data_key" text,
	"revision" integer DEFAULT 0 NOT NULL,
	"projection_version" integer DEFAULT 1 NOT NULL,
	"preparation" text DEFAULT 'pending_review' NOT NULL,
	"artwork" text DEFAULT 'not_pushed' NOT NULL,
	"proof" text DEFAULT 'not_required' NOT NULL,
	"held" boolean DEFAULT false NOT NULL,
	"print_sku" text,
	"pushed_revision_id" uuid,
	"editor_project_id" uuid,
	"approved_editor_version_id" uuid,
	"due_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_work_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"work_item_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"source_version_id" uuid,
	"profile_version_id" uuid,
	"encrypted_draft" text NOT NULL,
	"checksum" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "print_profile_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"name" text NOT NULL,
	"product_type" text NOT NULL,
	"project_id" uuid NOT NULL,
	"source_version_id" uuid NOT NULL,
	"instructions" text NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "print_profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"version_number" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "order_work_assets_scope_unique" ON "order_work_assets" USING btree ("tenant_id","work_item_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_work_events_request_unique" ON "order_work_events" USING btree ("tenant_id","work_item_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "order_work_items_tenant_id_unique" ON "order_work_items" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_work_revisions_scope_unique" ON "order_work_revisions" USING btree ("tenant_id","work_item_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_work_revisions_number_unique" ON "order_work_revisions" USING btree ("tenant_id","work_item_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "print_profile_versions_tenant_id_unique" ON "print_profile_versions" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "print_profile_versions_number_unique" ON "print_profile_versions" USING btree ("tenant_id","profile_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "print_profile_versions_request_unique" ON "print_profile_versions" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "print_profiles_tenant_id_unique" ON "print_profiles" USING btree ("tenant_id","id");--> statement-breakpoint
ALTER TABLE "production_orders" ALTER COLUMN "routing_decision_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "production_orders" ALTER COLUMN "purchase_order_version_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "production_order_versions" ADD COLUMN "source_work_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "production_order_versions" ADD COLUMN "source_editor_project_id" uuid;--> statement-breakpoint
ALTER TABLE "production_order_versions" ADD COLUMN "source_editor_version_id" uuid;--> statement-breakpoint
ALTER TABLE "production_order_versions" ADD COLUMN "source_render_id" uuid;--> statement-breakpoint
ALTER TABLE "production_orders" ADD COLUMN "source_work_item_id" uuid;--> statement-breakpoint
ALTER TABLE "production_editor_projects" ADD COLUMN "source_work_item_id" uuid;--> statement-breakpoint
ALTER TABLE "production_editor_projects" ADD COLUMN "source_work_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "order_work_assets" ADD CONSTRAINT "order_work_assets_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_work_assets" ADD CONSTRAINT "order_work_assets_work_fk" FOREIGN KEY ("tenant_id","work_item_id") REFERENCES "public"."order_work_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_work_events" ADD CONSTRAINT "order_work_events_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_work_events" ADD CONSTRAINT "order_work_events_actor_id_app_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_work_events" ADD CONSTRAINT "order_work_events_work_fk" FOREIGN KEY ("tenant_id","work_item_id") REFERENCES "public"."order_work_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_work_items" ADD CONSTRAINT "order_work_items_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_work_items" ADD CONSTRAINT "order_work_items_line_fk" FOREIGN KEY ("tenant_id","id") REFERENCES "public"."order_lines"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_work_items" ADD CONSTRAINT "order_work_items_report_fk" FOREIGN KEY ("tenant_id","report_line_id") REFERENCES "public"."amazon_order_report_lines"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_work_items" ADD CONSTRAINT "order_work_items_source_fk" FOREIGN KEY ("tenant_id","report_line_id","source_version_id") REFERENCES "public"."amazon_order_report_versions"("tenant_id","report_line_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_work_items" ADD CONSTRAINT "order_work_items_editor_fk" FOREIGN KEY ("tenant_id","editor_project_id") REFERENCES "public"."production_editor_projects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_work_revisions" ADD CONSTRAINT "order_work_revisions_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_work_revisions" ADD CONSTRAINT "order_work_revisions_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_work_revisions" ADD CONSTRAINT "order_work_revisions_work_fk" FOREIGN KEY ("tenant_id","work_item_id") REFERENCES "public"."order_work_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_work_revisions" ADD CONSTRAINT "order_work_revisions_profile_fk" FOREIGN KEY ("tenant_id","profile_version_id") REFERENCES "public"."print_profile_versions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_profile_versions" ADD CONSTRAINT "print_profile_versions_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_profile_versions" ADD CONSTRAINT "print_profile_versions_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_profile_versions" ADD CONSTRAINT "print_profile_versions_profile_fk" FOREIGN KEY ("tenant_id","profile_id") REFERENCES "public"."print_profiles"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_profile_versions" ADD CONSTRAINT "print_profile_versions_editor_fk" FOREIGN KEY ("tenant_id","project_id","source_version_id") REFERENCES "public"."production_editor_versions"("tenant_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_profiles" ADD CONSTRAINT "print_profiles_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_work_events_history_idx" ON "order_work_events" USING btree ("tenant_id","work_item_id","occurred_at");--> statement-breakpoint
CREATE INDEX "order_work_items_queue_idx" ON "order_work_items" USING btree ("tenant_id","preparation","artwork","due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "print_profiles_code_unique" ON "print_profiles" USING btree ("tenant_id",lower("code"));
--> statement-breakpoint
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['order_work_items','order_work_revisions','order_work_assets','order_work_events','print_profiles','print_profile_versions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO yummyai_app USING (tenant_id = (SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid)) WITH CHECK (tenant_id = (SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid))', table_name || '_tenant_policy', table_name);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON order_work_items, print_profiles TO yummyai_app;
GRANT SELECT, INSERT ON order_work_revisions, order_work_assets, order_work_events, print_profile_versions TO yummyai_app;
--> statement-breakpoint
CREATE FUNCTION protect_order_work_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Order work history is immutable' USING ERRCODE = '55000'; END;
$$;
CREATE TRIGGER order_work_revisions_immutable BEFORE UPDATE OR DELETE ON order_work_revisions FOR EACH ROW EXECUTE FUNCTION protect_order_work_history();
CREATE TRIGGER order_work_assets_immutable BEFORE UPDATE OR DELETE ON order_work_assets FOR EACH ROW EXECUTE FUNCTION protect_order_work_history();
CREATE TRIGGER order_work_events_immutable BEFORE UPDATE OR DELETE ON order_work_events FOR EACH ROW EXECUTE FUNCTION protect_order_work_history();
CREATE TRIGGER print_profile_versions_immutable BEFORE UPDATE OR DELETE ON print_profile_versions FOR EACH ROW EXECUTE FUNCTION protect_order_work_history();
--> statement-breakpoint
ALTER TABLE order_work_items ADD CONSTRAINT order_work_status_check CHECK (preparation IN ('pending_review','needs_information','ready_to_push','pushed') AND artwork IN ('not_pushed','queued','starting','in_progress','in_review','changes_requested','approved') AND proof IN ('not_required','pending','approved','changes_requested') AND revision >= 0 AND projection_version > 0);
ALTER TABLE order_work_items ADD CONSTRAINT order_work_pushed_revision_fk FOREIGN KEY (tenant_id,id,pushed_revision_id) REFERENCES order_work_revisions(tenant_id,work_item_id,id);
ALTER TABLE production_editor_projects ADD CONSTRAINT production_editor_work_source_fk FOREIGN KEY (tenant_id,source_work_item_id,source_work_revision_id) REFERENCES order_work_revisions(tenant_id,work_item_id,id);
ALTER TABLE production_editor_projects ADD CONSTRAINT production_editor_work_source_check CHECK ((source_work_item_id IS NULL AND source_work_revision_id IS NULL) OR (source_work_item_id IS NOT NULL AND source_work_revision_id IS NOT NULL AND expires_at IS NOT NULL AND source_report_line_id IS NULL));
CREATE UNIQUE INDEX production_editor_work_revision_unique ON production_editor_projects(tenant_id,source_work_revision_id) WHERE status = 'active';
ALTER TABLE production_orders ADD CONSTRAINT production_order_work_fk FOREIGN KEY (tenant_id,source_work_item_id) REFERENCES order_work_items(tenant_id,id);
ALTER TABLE production_orders ADD CONSTRAINT production_order_release_source_check CHECK ((routing_decision_id IS NOT NULL AND purchase_order_version_id IS NOT NULL) OR (source_work_item_id IS NOT NULL AND routing_decision_id IS NULL AND purchase_order_version_id IS NULL));
ALTER TABLE production_order_versions ADD CONSTRAINT production_version_editor_fk FOREIGN KEY (tenant_id,source_editor_project_id,source_editor_version_id) REFERENCES production_editor_versions(tenant_id,project_id,id);
ALTER TABLE production_order_versions ADD CONSTRAINT production_version_render_fk FOREIGN KEY (tenant_id,source_render_id) REFERENCES production_editor_renders(tenant_id,id);
