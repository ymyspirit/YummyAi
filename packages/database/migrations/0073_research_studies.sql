CREATE TABLE "research_study_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"research_item_id" uuid NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"content" jsonb NOT NULL,
	"request_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_study_revision_valid" CHECK ("research_study_revisions"."version" > 0 and substring("research_study_revisions"."id"::text from 15 for 1) = '7')
);
--> statement-breakpoint
ALTER TABLE "research_study_revisions" ADD CONSTRAINT "research_study_revisions_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_study_revisions" ADD CONSTRAINT "research_study_revisions_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_study_revisions" ADD CONSTRAINT "research_study_item_fk" FOREIGN KEY ("tenant_id","research_item_id") REFERENCES "public"."research_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_study_revisions" ADD CONSTRAINT "research_study_snapshot_fk" FOREIGN KEY ("tenant_id","snapshot_id") REFERENCES "public"."capture_snapshots"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "research_study_item_version_unique" ON "research_study_revisions" USING btree ("tenant_id","research_item_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "research_study_request_unique" ON "research_study_revisions" USING btree ("tenant_id","request_id");
--> statement-breakpoint
ALTER TABLE research_study_revisions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE research_study_revisions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY research_study_revisions_tenant_policy ON research_study_revisions
FOR ALL TO yummyai_app
USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
--> statement-breakpoint
GRANT SELECT, INSERT ON research_study_revisions TO yummyai_app;
--> statement-breakpoint
CREATE FUNCTION protect_research_study_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Research study revisions are immutable' USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER research_study_revisions_immutable BEFORE UPDATE OR DELETE ON research_study_revisions
FOR EACH ROW EXECUTE FUNCTION protect_research_study_history();
