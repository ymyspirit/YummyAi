CREATE TABLE "canvas_production_handoffs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"creative_version_id" uuid NOT NULL,
	"template_project_id" uuid NOT NULL,
	"template_version_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"template_name" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "creative_design_batches" ADD COLUMN "canvas_workflow" jsonb;--> statement-breakpoint
ALTER TABLE "canvas_production_handoffs" ADD CONSTRAINT "canvas_production_handoffs_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvas_production_handoffs" ADD CONSTRAINT "canvas_production_handoffs_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvas_production_handoffs" ADD CONSTRAINT "canvas_production_handoffs_batch_fk" FOREIGN KEY ("tenant_id","batch_id") REFERENCES "public"."creative_design_batches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvas_production_handoffs" ADD CONSTRAINT "canvas_production_handoffs_creative_fk" FOREIGN KEY ("tenant_id","creative_version_id") REFERENCES "public"."creative_design_versions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvas_production_handoffs" ADD CONSTRAINT "canvas_production_handoffs_template_fk" FOREIGN KEY ("tenant_id","template_project_id","template_version_id") REFERENCES "public"."production_editor_versions"("tenant_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvas_production_handoffs" ADD CONSTRAINT "canvas_production_handoffs_project_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."production_editor_projects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "canvas_production_handoffs_version_template_unique" ON "canvas_production_handoffs" USING btree ("tenant_id","creative_version_id","template_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "creative_design_batches_canvas_parent_unique" ON "creative_design_batches" USING btree ("tenant_id",("canvas_workflow"->>'parentBatchId')) WHERE "creative_design_batches"."canvas_workflow"->>'parentBatchId' is not null;
--> statement-breakpoint
ALTER TABLE canvas_production_handoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE canvas_production_handoffs FORCE ROW LEVEL SECURITY;
CREATE POLICY canvas_production_handoffs_tenant_policy ON canvas_production_handoffs FOR ALL TO yummyai_app
USING (tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid))
WITH CHECK (tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
GRANT SELECT,INSERT ON canvas_production_handoffs TO yummyai_app;
CREATE TRIGGER canvas_production_handoffs_immutable BEFORE UPDATE OR DELETE ON canvas_production_handoffs
FOR EACH ROW EXECUTE FUNCTION prevent_production_editor_version_mutation();
