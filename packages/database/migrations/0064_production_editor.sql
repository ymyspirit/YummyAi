CREATE TABLE production_editor_projects (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), name text NOT NULL,
 status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','deleted')), encrypted_data_key text,
 source_report_line_id uuid, source_report_version_id uuid, current_version_id uuid, version_number integer NOT NULL DEFAULT 0,
 reviewed_version_id uuid, reviewed_by uuid REFERENCES app_users(id), reviewed_at timestamptz, expires_at timestamptz,
 created_by uuid NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT production_editor_projects_tenant_id_unique UNIQUE(tenant_id,id),
 CONSTRAINT production_editor_projects_source_check CHECK ((source_report_line_id IS NULL AND source_report_version_id IS NULL) OR (source_report_line_id IS NOT NULL AND source_report_version_id IS NOT NULL AND expires_at IS NOT NULL)),
 CONSTRAINT production_editor_projects_report_line_fk FOREIGN KEY(tenant_id,source_report_line_id) REFERENCES amazon_order_report_lines(tenant_id,id),
 CONSTRAINT production_editor_projects_report_version_fk FOREIGN KEY(tenant_id,source_report_line_id,source_report_version_id) REFERENCES amazon_order_report_versions(tenant_id,report_line_id,id)
);
CREATE INDEX production_editor_projects_retention_idx ON production_editor_projects(tenant_id,expires_at);
CREATE TABLE production_editor_versions (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), project_id uuid NOT NULL, version_number integer NOT NULL,
 encrypted_document text NOT NULL, checksum text NOT NULL, created_by uuid NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT production_editor_versions_scope_unique UNIQUE(tenant_id,project_id,id),
 CONSTRAINT production_editor_versions_number_unique UNIQUE(tenant_id,project_id,version_number),
 CONSTRAINT production_editor_versions_project_fk FOREIGN KEY(tenant_id,project_id) REFERENCES production_editor_projects(tenant_id,id)
);
ALTER TABLE production_editor_projects ADD CONSTRAINT production_editor_projects_current_version_fk FOREIGN KEY(tenant_id,id,current_version_id) REFERENCES production_editor_versions(tenant_id,project_id,id);
ALTER TABLE production_editor_projects ADD CONSTRAINT production_editor_projects_review_version_fk FOREIGN KEY(tenant_id,id,reviewed_version_id) REFERENCES production_editor_versions(tenant_id,project_id,id);
CREATE TABLE production_editor_images (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), project_id uuid NOT NULL, encrypted_metadata text NOT NULL,
 original_object_key text NOT NULL, preview_object_key text NOT NULL, checksum text NOT NULL, byte_size bigint NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), CONSTRAINT production_editor_images_scope_unique UNIQUE(tenant_id,project_id,id),
 CONSTRAINT production_editor_images_project_fk FOREIGN KEY(tenant_id,project_id) REFERENCES production_editor_projects(tenant_id,id)
);
CREATE TABLE production_editor_renders (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), project_id uuid NOT NULL, version_id uuid NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','completed','failed')), encrypted_options text NOT NULL,
 encrypted_manifest text, processing_token uuid, started_at timestamptz, attempt integer NOT NULL DEFAULT 0, error_code text,
 requested_by uuid NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT production_editor_renders_tenant_id_unique UNIQUE(tenant_id,id),
 CONSTRAINT production_editor_renders_version_fk FOREIGN KEY(tenant_id,project_id,version_id) REFERENCES production_editor_versions(tenant_id,project_id,id)
);
--> statement-breakpoint
CREATE FUNCTION prevent_production_editor_version_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Production editor versions and images are immutable' USING ERRCODE = '55000'; END;
$$;
CREATE TRIGGER production_editor_versions_immutable BEFORE UPDATE OR DELETE ON production_editor_versions FOR EACH ROW EXECUTE FUNCTION prevent_production_editor_version_mutation();
CREATE TRIGGER production_editor_images_immutable BEFORE UPDATE OR DELETE ON production_editor_images FOR EACH ROW EXECUTE FUNCTION prevent_production_editor_version_mutation();
--> statement-breakpoint
ALTER TABLE production_editor_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_editor_projects FORCE ROW LEVEL SECURITY;
CREATE POLICY production_editor_projects_tenant_policy ON production_editor_projects FOR ALL TO yummyai_app USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
ALTER TABLE production_editor_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_editor_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY production_editor_versions_tenant_policy ON production_editor_versions FOR ALL TO yummyai_app USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
ALTER TABLE production_editor_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_editor_images FORCE ROW LEVEL SECURITY;
CREATE POLICY production_editor_images_tenant_policy ON production_editor_images FOR ALL TO yummyai_app USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
ALTER TABLE production_editor_renders ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_editor_renders FORCE ROW LEVEL SECURITY;
CREATE POLICY production_editor_renders_tenant_policy ON production_editor_renders FOR ALL TO yummyai_app USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
GRANT SELECT,INSERT,UPDATE ON production_editor_projects,production_editor_renders TO yummyai_app;
GRANT SELECT,INSERT ON production_editor_versions,production_editor_images TO yummyai_app;
