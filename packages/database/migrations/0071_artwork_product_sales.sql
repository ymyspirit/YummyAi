CREATE TABLE "artwork_master_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"artwork_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"name" text NOT NULL,
	"mode" text NOT NULL,
	"creative_version_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"tags" jsonb NOT NULL,
	"research_item_ids" jsonb NOT NULL,
	"customization" jsonb NOT NULL,
	"instructions" text NOT NULL,
	CONSTRAINT "artwork_master_versions_id_uuidv7_check" CHECK (substring("artwork_master_versions"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "artwork_master_versions_mode_check" CHECK ("artwork_master_versions"."mode" in ('fixed','personalized_text','customer_image') and "artwork_master_versions"."version_number" > 0)
);

--> statement-breakpoint

CREATE TABLE "artwork_masters" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"code" text NOT NULL,
	"version_number" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "artwork_masters_id_uuidv7_check" CHECK (substring("artwork_masters"."id"::text from 15 for 1) = '7')
);

--> statement-breakpoint

CREATE TABLE "development_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resource_id" uuid NOT NULL,
	"action" text NOT NULL,
	"reason" text NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"result" jsonb NOT NULL,
	CONSTRAINT "development_events_id_uuidv7_check" CHECK (substring("development_events"."id"::text from 15 for 1) = '7')
);

--> statement-breakpoint

CREATE TABLE "product_specification_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"specification_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"name" text NOT NULL,
	"attributes" jsonb NOT NULL,
	"facts" jsonb NOT NULL,
	"process_profile_version_id" uuid NOT NULL,
	"canvas_print_spec_version_id" uuid,
	"stock_item_id" uuid,
	CONSTRAINT "product_specification_versions_id_uuidv7_check" CHECK (substring("product_specification_versions"."id"::text from 15 for 1) = '7')
);

--> statement-breakpoint

CREATE TABLE "product_specifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"spu_id" uuid NOT NULL,
	"code" text NOT NULL,
	"version_number" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "product_specifications_id_uuidv7_check" CHECK (substring("product_specifications"."id"::text from 15 for 1) = '7')
);

--> statement-breakpoint

CREATE TABLE "product_styles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"artwork_id" uuid NOT NULL,
	"spu_id" uuid NOT NULL,
	CONSTRAINT "product_styles_id_uuidv7_check" CHECK (substring("product_styles"."id"::text from 15 for 1) = '7')
);

--> statement-breakpoint

CREATE TABLE "sales_channel_bindings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"package_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"external_sku" text NOT NULL,
	"external_listing_id" text NOT NULL,
	"marketplace_id" text NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"evidence" text NOT NULL,
	CONSTRAINT "sales_channel_bindings_id_uuidv7_check" CHECK (substring("sales_channel_bindings"."id"::text from 15 for 1) = '7')
);

--> statement-breakpoint

CREATE TABLE "sales_package_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sku_id" uuid NOT NULL,
	"recipe_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"listing_id" uuid NOT NULL,
	"listing_version_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"marketplace_id" text NOT NULL,
	"locale" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"checksum" text NOT NULL,
	CONSTRAINT "sales_package_versions_id_uuidv7_check" CHECK (substring("sales_package_versions"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "sales_package_versions_platform_check" CHECK ("sales_package_versions"."platform" in ('amazon','etsy') and "sales_package_versions"."version_number" > 0)
);

--> statement-breakpoint

CREATE TABLE "sales_recipe_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sku_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"artwork_version_id" uuid NOT NULL,
	"specification_version_id" uuid NOT NULL,
	"status" text DEFAULT 'pending_adaptation' NOT NULL,
	"editor_project_id" uuid,
	"editor_version_id" uuid,
	"render_id" uuid,
	"design_version_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_recipe_versions_id_uuidv7_check" CHECK (substring("sales_recipe_versions"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "sales_recipe_versions_status_check" CHECK ("sales_recipe_versions"."status" in ('pending_adaptation','in_adaptation','approved') and "sales_recipe_versions"."version_number" > 0)
);

--> statement-breakpoint

CREATE TABLE "sales_sku_definitions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sku_id" uuid NOT NULL,
	"style_id" uuid NOT NULL,
	"spu_id" uuid NOT NULL,
	"specification_id" uuid NOT NULL,
	"version_number" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "sales_sku_definitions_id_uuidv7_check" CHECK (substring("sales_sku_definitions"."id"::text from 15 for 1) = '7')
);

--> statement-breakpoint

DROP INDEX "listings_channel_unique";
--> statement-breakpoint

ALTER TABLE "listings" ADD COLUMN "style_id" uuid;
--> statement-breakpoint

ALTER TABLE "production_editor_projects" ADD COLUMN "source_sales_sku_id" uuid;
--> statement-breakpoint

ALTER TABLE "production_editor_projects" ADD COLUMN "source_sales_recipe_id" uuid;
--> statement-breakpoint

CREATE UNIQUE INDEX "artwork_master_versions_tenant_id_unique" ON "artwork_master_versions" USING btree ("tenant_id","id");
--> statement-breakpoint

CREATE UNIQUE INDEX "artwork_master_versions_number_unique" ON "artwork_master_versions" USING btree ("tenant_id","artwork_id","version_number");
--> statement-breakpoint

CREATE UNIQUE INDEX "artwork_master_versions_scope_unique" ON "artwork_master_versions" USING btree ("tenant_id","artwork_id","id");
--> statement-breakpoint

CREATE UNIQUE INDEX "artwork_masters_tenant_id_unique" ON "artwork_masters" USING btree ("tenant_id","id");
--> statement-breakpoint

CREATE UNIQUE INDEX "artwork_masters_code_unique" ON "artwork_masters" USING btree ("tenant_id",lower("code"));
--> statement-breakpoint

CREATE UNIQUE INDEX "development_events_tenant_id_unique" ON "development_events" USING btree ("tenant_id","id");
--> statement-breakpoint

CREATE UNIQUE INDEX "development_events_request_unique" ON "development_events" USING btree ("tenant_id","idempotency_key");
--> statement-breakpoint

CREATE INDEX "development_events_resource_idx" ON "development_events" USING btree ("tenant_id","resource_id","created_at");
--> statement-breakpoint

CREATE UNIQUE INDEX "product_specification_versions_tenant_id_unique" ON "product_specification_versions" USING btree ("tenant_id","id");
--> statement-breakpoint

CREATE UNIQUE INDEX "product_specification_versions_number_unique" ON "product_specification_versions" USING btree ("tenant_id","specification_id","version_number");
--> statement-breakpoint

CREATE UNIQUE INDEX "product_specification_versions_scope_unique" ON "product_specification_versions" USING btree ("tenant_id","specification_id","id");
--> statement-breakpoint

CREATE UNIQUE INDEX "product_specifications_tenant_id_unique" ON "product_specifications" USING btree ("tenant_id","id");
--> statement-breakpoint

CREATE UNIQUE INDEX "product_specifications_code_unique" ON "product_specifications" USING btree ("tenant_id","spu_id",lower("code"));
--> statement-breakpoint

CREATE UNIQUE INDEX "product_specifications_spu_scope_unique" ON "product_specifications" USING btree ("tenant_id","spu_id","id");
--> statement-breakpoint

CREATE UNIQUE INDEX "product_styles_tenant_id_unique" ON "product_styles" USING btree ("tenant_id","id");
--> statement-breakpoint

CREATE UNIQUE INDEX "product_styles_pair_unique" ON "product_styles" USING btree ("tenant_id","artwork_id","spu_id");
--> statement-breakpoint

CREATE UNIQUE INDEX "product_styles_spu_scope_unique" ON "product_styles" USING btree ("tenant_id","spu_id","id");
--> statement-breakpoint

CREATE UNIQUE INDEX "sales_channel_bindings_tenant_id_unique" ON "sales_channel_bindings" USING btree ("tenant_id","id");
--> statement-breakpoint

CREATE UNIQUE INDEX "sales_channel_bindings_effective_unique" ON "sales_channel_bindings" USING btree ("tenant_id","account_id","marketplace_id","external_sku","external_listing_id","effective_from");
--> statement-breakpoint

CREATE INDEX "sales_channel_bindings_lookup_idx" ON "sales_channel_bindings" USING btree ("tenant_id","account_id","external_sku","effective_from");
--> statement-breakpoint

CREATE UNIQUE INDEX "sales_package_versions_tenant_id_unique" ON "sales_package_versions" USING btree ("tenant_id","id");
--> statement-breakpoint

CREATE UNIQUE INDEX "sales_package_versions_number_unique" ON "sales_package_versions" USING btree ("tenant_id","sku_id","platform","marketplace_id","locale","version_number");
--> statement-breakpoint

CREATE UNIQUE INDEX "sales_recipe_versions_tenant_id_unique" ON "sales_recipe_versions" USING btree ("tenant_id","id");
--> statement-breakpoint

CREATE UNIQUE INDEX "sales_recipe_versions_number_unique" ON "sales_recipe_versions" USING btree ("tenant_id","sku_id","version_number");
--> statement-breakpoint

CREATE UNIQUE INDEX "sales_recipe_versions_scope_unique" ON "sales_recipe_versions" USING btree ("tenant_id","sku_id","id");
--> statement-breakpoint

CREATE UNIQUE INDEX "sales_sku_definitions_tenant_id_unique" ON "sales_sku_definitions" USING btree ("tenant_id","id");
--> statement-breakpoint

CREATE UNIQUE INDEX "sales_sku_definitions_sku_unique" ON "sales_sku_definitions" USING btree ("tenant_id","sku_id");
--> statement-breakpoint

CREATE UNIQUE INDEX "sales_sku_definitions_pair_unique" ON "sales_sku_definitions" USING btree ("tenant_id","style_id","specification_id");
--> statement-breakpoint

CREATE UNIQUE INDEX "listings_style_channel_unique" ON "listings" USING btree ("tenant_id","style_id","platform","marketplace_id","locale") WHERE "listings"."style_id" is not null;
--> statement-breakpoint

CREATE UNIQUE INDEX "listings_channel_unique" ON "listings" USING btree ("tenant_id","spu_id","platform","marketplace_id","locale") WHERE "listings"."style_id" is null;
--> statement-breakpoint

ALTER TABLE "artwork_master_versions" ADD CONSTRAINT "artwork_master_versions_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "artwork_master_versions" ADD CONSTRAINT "artwork_master_versions_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "artwork_master_versions" ADD CONSTRAINT "artwork_master_versions_tenant_id_artwork_id_artwork_masters_tenant_id_id_fk" FOREIGN KEY ("tenant_id","artwork_id") REFERENCES "public"."artwork_masters"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "artwork_master_versions" ADD CONSTRAINT "artwork_master_versions_tenant_id_creative_version_id_creative_design_versions_tenant_id_id_fk" FOREIGN KEY ("tenant_id","creative_version_id") REFERENCES "public"."creative_design_versions"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "artwork_master_versions" ADD CONSTRAINT "artwork_master_versions_tenant_id_asset_id_asset_files_tenant_id_id_fk" FOREIGN KEY ("tenant_id","asset_id") REFERENCES "public"."asset_files"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "artwork_masters" ADD CONSTRAINT "artwork_masters_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "artwork_masters" ADD CONSTRAINT "artwork_masters_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "development_events" ADD CONSTRAINT "development_events_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "development_events" ADD CONSTRAINT "development_events_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "product_specification_versions" ADD CONSTRAINT "product_specification_versions_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "product_specification_versions" ADD CONSTRAINT "product_specification_versions_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "product_specification_versions" ADD CONSTRAINT "product_specification_versions_tenant_id_specification_id_product_specifications_tenant_id_id_fk" FOREIGN KEY ("tenant_id","specification_id") REFERENCES "public"."product_specifications"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "product_specification_versions" ADD CONSTRAINT "product_specification_versions_tenant_id_process_profile_version_id_print_profile_versions_tenant_id_id_fk" FOREIGN KEY ("tenant_id","process_profile_version_id") REFERENCES "public"."print_profile_versions"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "product_specification_versions" ADD CONSTRAINT "product_specification_versions_tenant_id_canvas_print_spec_version_id_canvas_print_spec_versions_tenant_id_id_fk" FOREIGN KEY ("tenant_id","canvas_print_spec_version_id") REFERENCES "public"."canvas_print_spec_versions"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "product_specification_versions" ADD CONSTRAINT "product_specification_versions_tenant_id_stock_item_id_inventory_stock_items_tenant_id_id_fk" FOREIGN KEY ("tenant_id","stock_item_id") REFERENCES "public"."inventory_stock_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "product_specifications" ADD CONSTRAINT "product_specifications_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "product_specifications" ADD CONSTRAINT "product_specifications_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "product_specifications" ADD CONSTRAINT "product_specifications_tenant_id_spu_id_spus_tenant_id_id_fk" FOREIGN KEY ("tenant_id","spu_id") REFERENCES "public"."spus"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "product_styles" ADD CONSTRAINT "product_styles_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "product_styles" ADD CONSTRAINT "product_styles_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "product_styles" ADD CONSTRAINT "product_styles_tenant_id_artwork_id_artwork_masters_tenant_id_id_fk" FOREIGN KEY ("tenant_id","artwork_id") REFERENCES "public"."artwork_masters"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "product_styles" ADD CONSTRAINT "product_styles_tenant_id_spu_id_spus_tenant_id_id_fk" FOREIGN KEY ("tenant_id","spu_id") REFERENCES "public"."spus"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "sales_channel_bindings" ADD CONSTRAINT "sales_channel_bindings_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "sales_channel_bindings" ADD CONSTRAINT "sales_channel_bindings_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "sales_channel_bindings" ADD CONSTRAINT "sales_channel_bindings_tenant_id_package_id_sales_package_versions_tenant_id_id_fk" FOREIGN KEY ("tenant_id","package_id") REFERENCES "public"."sales_package_versions"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "sales_channel_bindings" ADD CONSTRAINT "sales_channel_bindings_tenant_id_account_id_marketplace_accounts_tenant_id_id_fk" FOREIGN KEY ("tenant_id","account_id") REFERENCES "public"."marketplace_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "sales_package_versions" ADD CONSTRAINT "sales_package_versions_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "sales_package_versions" ADD CONSTRAINT "sales_package_versions_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "sales_package_versions" ADD CONSTRAINT "sales_package_versions_tenant_id_sku_id_recipe_id_sales_recipe_versions_tenant_id_sku_id_id_fk" FOREIGN KEY ("tenant_id","sku_id","recipe_id") REFERENCES "public"."sales_recipe_versions"("tenant_id","sku_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "sales_package_versions" ADD CONSTRAINT "sales_package_versions_tenant_id_listing_id_listings_tenant_id_id_fk" FOREIGN KEY ("tenant_id","listing_id") REFERENCES "public"."listings"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "sales_package_versions" ADD CONSTRAINT "sales_package_versions_tenant_id_listing_version_id_listing_versions_tenant_id_id_fk" FOREIGN KEY ("tenant_id","listing_version_id") REFERENCES "public"."listing_versions"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "sales_recipe_versions" ADD CONSTRAINT "sales_recipe_versions_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "sales_recipe_versions" ADD CONSTRAINT "sales_recipe_versions_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "sales_recipe_versions" ADD CONSTRAINT "sales_recipe_versions_tenant_id_sku_id_sales_sku_definitions_tenant_id_sku_id_fk" FOREIGN KEY ("tenant_id","sku_id") REFERENCES "public"."sales_sku_definitions"("tenant_id","sku_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "sales_recipe_versions" ADD CONSTRAINT "sales_recipe_versions_tenant_id_artwork_version_id_artwork_master_versions_tenant_id_id_fk" FOREIGN KEY ("tenant_id","artwork_version_id") REFERENCES "public"."artwork_master_versions"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "sales_recipe_versions" ADD CONSTRAINT "sales_recipe_versions_tenant_id_specification_version_id_product_specification_versions_tenant_id_id_fk" FOREIGN KEY ("tenant_id","specification_version_id") REFERENCES "public"."product_specification_versions"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "sales_recipe_versions" ADD CONSTRAINT "sales_recipe_versions_tenant_id_editor_project_id_production_editor_projects_tenant_id_id_fk" FOREIGN KEY ("tenant_id","editor_project_id") REFERENCES "public"."production_editor_projects"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "sales_recipe_versions" ADD CONSTRAINT "sales_recipe_versions_tenant_id_editor_project_id_editor_version_id_production_editor_versions_tenant_id_project_id_id_fk" FOREIGN KEY ("tenant_id","editor_project_id","editor_version_id") REFERENCES "public"."production_editor_versions"("tenant_id","project_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "sales_recipe_versions" ADD CONSTRAINT "sales_recipe_versions_tenant_id_render_id_production_editor_renders_tenant_id_id_fk" FOREIGN KEY ("tenant_id","render_id") REFERENCES "public"."production_editor_renders"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "sales_recipe_versions" ADD CONSTRAINT "sales_recipe_versions_tenant_id_design_version_id_design_versions_tenant_id_id_fk" FOREIGN KEY ("tenant_id","design_version_id") REFERENCES "public"."design_versions"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "sales_sku_definitions" ADD CONSTRAINT "sales_sku_definitions_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "sales_sku_definitions" ADD CONSTRAINT "sales_sku_definitions_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "sales_sku_definitions" ADD CONSTRAINT "sales_sku_definitions_tenant_id_sku_id_skus_tenant_id_id_fk" FOREIGN KEY ("tenant_id","sku_id") REFERENCES "public"."skus"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "sales_sku_definitions" ADD CONSTRAINT "sales_sku_definitions_tenant_id_spu_id_style_id_product_styles_tenant_id_spu_id_id_fk" FOREIGN KEY ("tenant_id","spu_id","style_id") REFERENCES "public"."product_styles"("tenant_id","spu_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "sales_sku_definitions" ADD CONSTRAINT "sales_sku_definitions_tenant_id_spu_id_specification_id_product_specifications_tenant_id_spu_id_id_fk" FOREIGN KEY ("tenant_id","spu_id","specification_id") REFERENCES "public"."product_specifications"("tenant_id","spu_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['artwork_masters','artwork_master_versions','product_specifications','product_specification_versions','product_styles','sales_sku_definitions','sales_recipe_versions','sales_package_versions','sales_channel_bindings','development_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO yummyai_app USING (tenant_id = (SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid)) WITH CHECK (tenant_id = (SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid))', table_name || '_tenant_policy', table_name);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO yummyai_app', table_name);
  END LOOP;
  FOREACH table_name IN ARRAY ARRAY['artwork_master_versions','product_specification_versions','product_styles','sales_package_versions','sales_channel_bindings','development_events'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION protect_order_work_history()', table_name || '_immutable', table_name);
  END LOOP;
END $$;
GRANT UPDATE ON artwork_masters, product_specifications, sales_sku_definitions, sales_recipe_versions TO yummyai_app;
--> statement-breakpoint
CREATE FUNCTION protect_approved_sales_recipe() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'approved' THEN RAISE EXCEPTION 'Approved sales recipes are immutable' USING ERRCODE = '55000'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sales_recipe_approved_immutable BEFORE UPDATE OR DELETE ON sales_recipe_versions FOR EACH ROW EXECUTE FUNCTION protect_approved_sales_recipe();
--> statement-breakpoint
CREATE UNIQUE INDEX skus_tenant_spu_scope_unique ON skus(tenant_id,spu_id,id);
ALTER TABLE sales_sku_definitions ADD CONSTRAINT sales_definition_sku_spu_fk FOREIGN KEY (tenant_id,spu_id,sku_id) REFERENCES skus(tenant_id,spu_id,id);
ALTER TABLE listings ADD CONSTRAINT listings_style_spu_fk FOREIGN KEY (tenant_id,spu_id,style_id) REFERENCES product_styles(tenant_id,spu_id,id);
ALTER TABLE production_editor_projects ADD CONSTRAINT production_editor_sales_recipe_fk FOREIGN KEY (tenant_id,source_sales_sku_id,source_sales_recipe_id) REFERENCES sales_recipe_versions(tenant_id,sku_id,id);
ALTER TABLE production_editor_projects ADD CONSTRAINT production_editor_sales_source_check CHECK ((source_sales_sku_id IS NULL AND source_sales_recipe_id IS NULL) OR (source_sales_sku_id IS NOT NULL AND source_sales_recipe_id IS NOT NULL AND source_work_item_id IS NULL AND source_report_line_id IS NULL AND expires_at IS NULL));
CREATE UNIQUE INDEX production_editor_sales_recipe_unique ON production_editor_projects(tenant_id,source_sales_recipe_id) WHERE status = 'active';
