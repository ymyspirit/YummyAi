ALTER TABLE spus ADD COLUMN capabilities jsonb NOT NULL DEFAULT '{"processes":"","customizationScope":"","packaging":""}'::jsonb;
CREATE TABLE sales_plans (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES organizations(id),
 spu_id uuid NOT NULL,
 revision integer NOT NULL DEFAULT 1 CHECK(revision > 0),
 fields jsonb NOT NULL,
 created_by uuid NOT NULL REFERENCES app_users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 archived_at timestamptz,
 CONSTRAINT sales_plans_tenant_id_unique UNIQUE(tenant_id,id),
 CONSTRAINT sales_plans_spu_id_unique UNIQUE(tenant_id,spu_id,id),
 FOREIGN KEY(tenant_id,spu_id) REFERENCES spus(tenant_id,id),
 CONSTRAINT sales_plans_mode_check CHECK(
   fields->>'mode' IN ('custom','standard') AND fields->>'fulfillment' IN ('fbm','fba')
   AND NOT(fields->>'mode'='custom' AND fields->>'fulfillment'='fba'))
);
CREATE INDEX sales_plans_spu_idx ON sales_plans(tenant_id,spu_id,updated_at);
ALTER TABLE sales_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_plans FORCE ROW LEVEL SECURITY;
CREATE POLICY sales_plans_tenant ON sales_plans FOR ALL TO yummyai_app
 USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid))
 WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
GRANT SELECT,INSERT,UPDATE ON sales_plans TO yummyai_app;
--> statement-breakpoint
ALTER TABLE listings ADD COLUMN sales_plan_id uuid;
ALTER TABLE listings ADD COLUMN sales_plan_revision integer;
ALTER TABLE listings ADD CONSTRAINT listings_sales_plan_fk FOREIGN KEY(tenant_id,spu_id,sales_plan_id) REFERENCES sales_plans(tenant_id,spu_id,id);
DROP INDEX listings_channel_unique;
DROP INDEX listings_style_channel_unique;
CREATE UNIQUE INDEX listings_channel_unique ON listings(tenant_id,spu_id,platform,marketplace_id,locale) WHERE style_id IS NULL AND sales_plan_id IS NULL;
CREATE UNIQUE INDEX listings_style_channel_unique ON listings(tenant_id,style_id,platform,marketplace_id,locale) WHERE style_id IS NOT NULL AND sales_plan_id IS NULL;
CREATE UNIQUE INDEX listings_sales_plan_channel_unique ON listings(tenant_id,sales_plan_id,platform,marketplace_id,locale) WHERE sales_plan_id IS NOT NULL;
--> statement-breakpoint
CREATE FUNCTION protect_sales_plan_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.id<>OLD.id OR NEW.tenant_id<>OLD.tenant_id OR NEW.spu_id<>OLD.spu_id OR NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at
 OR NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'Sales plan identity is immutable and revisions must advance'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER sales_plans_identity BEFORE UPDATE ON sales_plans FOR EACH ROW EXECUTE FUNCTION protect_sales_plan_identity();
