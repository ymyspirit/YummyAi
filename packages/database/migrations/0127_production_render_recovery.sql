-- This directory contains only routing UUIDs. All render/project reads continue
-- through withTenant and the forced RLS application role.
CREATE TABLE production_render_dispatch_tenants (
 tenant_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE
);
ALTER TABLE production_render_dispatch_tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_render_dispatch_tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY production_render_dispatch_tenants_read ON production_render_dispatch_tenants FOR SELECT TO yummyai_app USING(true);
CREATE POLICY production_render_dispatch_tenants_register ON production_render_dispatch_tenants FOR INSERT TO yummyai_app WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
GRANT SELECT,INSERT ON production_render_dispatch_tenants TO yummyai_app;
--> statement-breakpoint
-- Backfill routing IDs without reading private rows outside tenant RLS.
INSERT INTO production_render_dispatch_tenants(tenant_id) SELECT id FROM organizations ON CONFLICT DO NOTHING;
CREATE FUNCTION register_production_render_dispatch_tenant() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 INSERT INTO public.production_render_dispatch_tenants(tenant_id) VALUES(NEW.tenant_id) ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
CREATE TRIGGER production_render_register_tenant AFTER INSERT ON production_editor_renders
 FOR EACH ROW EXECUTE FUNCTION register_production_render_dispatch_tenant();
--> statement-breakpoint
ALTER TABLE production_editor_renders ADD COLUMN lease_until timestamptz;
ALTER TABLE production_editor_renders ADD COLUMN next_dispatch_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX production_editor_renders_dispatch_idx ON production_editor_renders(tenant_id,status,next_dispatch_at,id);
