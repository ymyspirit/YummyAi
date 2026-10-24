CREATE TABLE "creative_studio_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"namespace" text NOT NULL,
	"key" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"value" jsonb,
	"asset_id" uuid,
	"deleted_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "creative_studio_entries_revision_check" CHECK ("creative_studio_entries"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "creative_studio_generations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"request_id" uuid NOT NULL,
	"input" jsonb NOT NULL,
	"model_snapshot" jsonb NOT NULL,
	"references" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"provider_task_id" text,
	"asset_id" uuid,
	"result_text" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "creative_studio_generation_status_check" CHECK ("creative_studio_generations"."status" in ('queued','running','completed','failed'))
);
--> statement-breakpoint
CREATE TABLE "creative_studio_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"value" jsonb,
	"asset_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "creative_studio_entries" ADD CONSTRAINT "creative_studio_entries_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_studio_entries" ADD CONSTRAINT "creative_studio_entries_owner_id_app_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_studio_entries" ADD CONSTRAINT "creative_studio_entries_asset_fk" FOREIGN KEY ("tenant_id","asset_id") REFERENCES "public"."asset_files"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_studio_generations" ADD CONSTRAINT "creative_studio_generations_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_studio_generations" ADD CONSTRAINT "creative_studio_generations_owner_id_app_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_studio_generations" ADD CONSTRAINT "creative_studio_generation_asset_fk" FOREIGN KEY ("tenant_id","asset_id") REFERENCES "public"."asset_files"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_studio_revisions" ADD CONSTRAINT "creative_studio_revisions_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "creative_studio_entries_tenant_id_unique" ON "creative_studio_entries" USING btree ("tenant_id","id");--> statement-breakpoint
ALTER TABLE "creative_studio_revisions" ADD CONSTRAINT "creative_studio_revisions_entry_fk" FOREIGN KEY ("tenant_id","entry_id") REFERENCES "public"."creative_studio_entries"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_studio_revisions" ADD CONSTRAINT "creative_studio_revisions_asset_fk" FOREIGN KEY ("tenant_id","asset_id") REFERENCES "public"."asset_files"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "creative_studio_entries_address_unique" ON "creative_studio_entries" USING btree ("tenant_id","owner_id","scope","namespace","key");--> statement-breakpoint
CREATE UNIQUE INDEX "creative_studio_generation_request_unique" ON "creative_studio_generations" USING btree ("tenant_id","owner_id","request_id");--> statement-breakpoint
CREATE INDEX "creative_studio_generation_owner_idx" ON "creative_studio_generations" USING btree ("tenant_id","owner_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "creative_studio_revisions_number_unique" ON "creative_studio_revisions" USING btree ("tenant_id","entry_id","revision");
--> statement-breakpoint
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['creative_studio_entries','creative_studio_generations','creative_studio_revisions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO yummyai_app USING (tenant_id = (SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid)) WITH CHECK (tenant_id = (SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid))', table_name || '_tenant_policy', table_name);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON creative_studio_entries, creative_studio_generations TO yummyai_app;
GRANT SELECT, INSERT ON creative_studio_revisions TO yummyai_app;
--> statement-breakpoint
CREATE FUNCTION prevent_creative_studio_revision_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Creative studio revisions are immutable' USING ERRCODE = '55000'; END;
$$;
CREATE TRIGGER creative_studio_revisions_immutable BEFORE UPDATE OR DELETE ON creative_studio_revisions FOR EACH ROW EXECUTE FUNCTION prevent_creative_studio_revision_mutation();
--> statement-breakpoint
CREATE FUNCTION protect_creative_studio_entry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(OLD.id,OLD.tenant_id,OLD.owner_id,OLD.scope,OLD.namespace,OLD.key) IS DISTINCT FROM ROW(NEW.id,NEW.tenant_id,NEW.owner_id,NEW.scope,NEW.namespace,NEW.key) OR NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'Creative studio entry identity is immutable and revisions must advance by one' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER creative_studio_entry_version_guard BEFORE UPDATE ON creative_studio_entries FOR EACH ROW EXECUTE FUNCTION protect_creative_studio_entry();
--> statement-breakpoint
CREATE FUNCTION protect_creative_studio_generation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(OLD.id,OLD.tenant_id,OLD.owner_id,OLD.scope,OLD.request_id,OLD.input,OLD.model_snapshot,OLD.references,OLD.created_at) IS DISTINCT FROM ROW(NEW.id,NEW.tenant_id,NEW.owner_id,NEW.scope,NEW.request_id,NEW.input,NEW.model_snapshot,NEW.references,NEW.created_at) THEN
    RAISE EXCEPTION 'Creative studio generation input is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER creative_studio_generation_input_guard BEFORE UPDATE ON creative_studio_generations FOR EACH ROW EXECUTE FUNCTION protect_creative_studio_generation();
