CREATE TABLE "product_supply_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"product_plan_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"sku_id" uuid,
	"current_version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_supply_links_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "product_supply_version_check" CHECK ("product_supply_links"."current_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "product_supply_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"link_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"stock_item_id" uuid,
	"terms" jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_supply_versions_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "product_supply_versions_number_check" CHECK ("product_supply_versions"."version_number" > 0),
	CONSTRAINT "product_supply_versions_stock_check" CHECK (("product_supply_versions"."terms"->>'stockItemId')::uuid is not distinct from "product_supply_versions"."stock_item_id")
);
--> statement-breakpoint
ALTER TABLE "inventory_purchase_orders" ADD COLUMN "source_supply_version_id" uuid;--> statement-breakpoint
ALTER TABLE "inventory_purchase_orders" ADD COLUMN "source_supply_request_hash" text;--> statement-breakpoint
ALTER TABLE "inventory_purchase_orders" ADD COLUMN "purpose" text DEFAULT 'general' NOT NULL;--> statement-breakpoint
ALTER TABLE "product_supply_links" ADD CONSTRAINT "product_supply_links_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_supply_links" ADD CONSTRAINT "product_supply_links_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_supply_links" ADD CONSTRAINT "product_supply_product_fk" FOREIGN KEY ("tenant_id","product_plan_id") REFERENCES "public"."product_plans"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_supply_links" ADD CONSTRAINT "product_supply_supplier_fk" FOREIGN KEY ("tenant_id","supplier_id") REFERENCES "public"."fulfillment_suppliers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_supply_links" ADD CONSTRAINT "product_supply_sku_fk" FOREIGN KEY ("tenant_id","sku_id") REFERENCES "public"."skus"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_supply_versions" ADD CONSTRAINT "product_supply_versions_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_supply_versions" ADD CONSTRAINT "product_supply_versions_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_supply_versions" ADD CONSTRAINT "product_supply_versions_link_fk" FOREIGN KEY ("tenant_id","link_id") REFERENCES "public"."product_supply_links"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_supply_versions" ADD CONSTRAINT "product_supply_versions_stock_fk" FOREIGN KEY ("tenant_id","stock_item_id") REFERENCES "public"."inventory_stock_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_supply_links_identity_unique" ON "product_supply_links" USING btree ("tenant_id","product_plan_id","supplier_id",coalesce("sku_id", '00000000-0000-0000-0000-000000000000'::uuid));--> statement-breakpoint
CREATE UNIQUE INDEX "product_supply_versions_number_unique" ON "product_supply_versions" USING btree ("tenant_id","link_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "product_supply_versions_request_unique" ON "product_supply_versions" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
ALTER TABLE "inventory_purchase_orders" ADD CONSTRAINT "inventory_purchase_orders_supply_fk" FOREIGN KEY ("tenant_id","source_supply_version_id") REFERENCES "public"."product_supply_versions"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['product_supply_links','product_supply_versions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO yummyai_app USING (tenant_id = (SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid)) WITH CHECK (tenant_id = (SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid))', table_name || '_tenant_policy', table_name);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON product_supply_links TO yummyai_app;
GRANT SELECT, INSERT ON product_supply_versions TO yummyai_app;
--> statement-breakpoint
CREATE FUNCTION protect_product_supply_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Product supply versions are immutable' USING ERRCODE = '55000'; END;
$$;
CREATE TRIGGER product_supply_versions_immutable BEFORE UPDATE OR DELETE ON product_supply_versions FOR EACH ROW EXECUTE FUNCTION protect_product_supply_version();
--> statement-breakpoint
CREATE FUNCTION protect_product_supply_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(OLD.id,OLD.tenant_id,OLD.product_plan_id,OLD.supplier_id,OLD.sku_id,OLD.created_by,OLD.created_at) IS DISTINCT FROM ROW(NEW.id,NEW.tenant_id,NEW.product_plan_id,NEW.supplier_id,NEW.sku_id,NEW.created_by,NEW.created_at) OR NEW.current_version <> OLD.current_version + 1 THEN
    RAISE EXCEPTION 'Supply identity is immutable and versions must advance by one' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM product_supply_versions WHERE tenant_id = NEW.tenant_id AND link_id = NEW.id AND version_number = NEW.current_version) THEN
    RAISE EXCEPTION 'Supply version is missing' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER product_supply_identity_immutable BEFORE UPDATE ON product_supply_links FOR EACH ROW EXECUTE FUNCTION protect_product_supply_identity();
--> statement-breakpoint
CREATE FUNCTION protect_purchase_supply_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(OLD.source_supply_version_id,OLD.source_supply_request_hash,OLD.purpose) IS DISTINCT FROM ROW(NEW.source_supply_version_id,NEW.source_supply_request_hash,NEW.purpose) THEN
    RAISE EXCEPTION 'Purchase supply provenance is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER purchase_supply_source_immutable BEFORE UPDATE ON inventory_purchase_orders FOR EACH ROW EXECUTE FUNCTION protect_purchase_supply_source();
