CREATE TABLE "model_preferences" (
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"defaults" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_preferences_tenant_id_user_id_pk" PRIMARY KEY("tenant_id","user_id"),
	CONSTRAINT "model_preferences_revision_check" CHECK ("model_preferences"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "model_preferences" ADD CONSTRAINT "model_preferences_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_preferences" ADD CONSTRAINT "model_preferences_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE model_preferences ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE model_preferences FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY model_preferences_owner_policy ON model_preferences FOR ALL TO yummyai_app
USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid) AND user_id = (SELECT nullif(current_setting('app.user_id', true), '')::uuid))
WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid) AND user_id = (SELECT nullif(current_setting('app.user_id', true), '')::uuid));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON model_preferences TO yummyai_app;
