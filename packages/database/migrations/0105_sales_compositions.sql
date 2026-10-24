ALTER TABLE product_styles ADD COLUMN composition_key text;
DROP INDEX product_styles_pair_unique;
CREATE UNIQUE INDEX product_styles_pair_unique ON product_styles(tenant_id,artwork_id,spu_id) WHERE composition_key IS NULL;
CREATE UNIQUE INDEX product_styles_composition_unique ON product_styles(tenant_id,spu_id,composition_key) WHERE composition_key IS NOT NULL;
--> statement-breakpoint
CREATE TABLE sales_recipe_print_bindings (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), created_by uuid NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(),
 recipe_id uuid NOT NULL, position integer NOT NULL CHECK(position>=0 AND position<30), artwork_version_id uuid NOT NULL, binding jsonb NOT NULL CHECK(jsonb_typeof(binding)='object'),
 UNIQUE(tenant_id,id), CONSTRAINT sales_recipe_print_bindings_position_unique UNIQUE(tenant_id,recipe_id,position),
 FOREIGN KEY(tenant_id,recipe_id) REFERENCES sales_recipe_versions(tenant_id,id),
 FOREIGN KEY(tenant_id,artwork_version_id) REFERENCES artwork_master_versions(tenant_id,id),
 CHECK(binding->>'artworkVersionId'=artwork_version_id::text)
);
CREATE FUNCTION protect_sales_recipe_print_binding() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Sales recipe print pins are immutable'; END IF;
 IF NOT EXISTS(SELECT 1 FROM sales_recipe_versions WHERE tenant_id=NEW.tenant_id AND id=NEW.recipe_id AND status='pending_adaptation' AND editor_project_id IS NULL)
 THEN RAISE EXCEPTION 'Cannot append print pins after adaptation'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER sales_recipe_print_binding_immutable BEFORE INSERT OR UPDATE OR DELETE ON sales_recipe_print_bindings FOR EACH ROW EXECUTE FUNCTION protect_sales_recipe_print_binding();
ALTER TABLE sales_recipe_print_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_recipe_print_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY sales_recipe_print_bindings_tenant_policy ON sales_recipe_print_bindings FOR ALL TO yummyai_app USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
GRANT SELECT,INSERT ON sales_recipe_print_bindings TO yummyai_app;
--> statement-breakpoint
ALTER TABLE sales_channel_bindings ADD COLUMN custom_choice jsonb NOT NULL DEFAULT '{}'::jsonb, ADD COLUMN custom_choice_key text NOT NULL DEFAULT 'legacy';
DROP INDEX sales_channel_bindings_effective_unique;
CREATE UNIQUE INDEX sales_channel_bindings_effective_unique ON sales_channel_bindings(tenant_id,account_id,marketplace_id,external_sku,external_listing_id,custom_choice_key,effective_from);
