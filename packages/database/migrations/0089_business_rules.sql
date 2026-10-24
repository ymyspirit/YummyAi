CREATE TABLE business_rules (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), code text NOT NULL,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0), latest_version integer NOT NULL DEFAULT 1 CHECK(latest_version>0), active_version integer,
 created_by uuid NOT NULL REFERENCES app_users(id), updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT business_rules_tenant_id_unique UNIQUE(tenant_id,id), CONSTRAINT business_rules_code_unique UNIQUE(tenant_id,code)
);
CREATE TABLE business_rule_versions (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), rule_id uuid NOT NULL, version integer NOT NULL CHECK(version>0),
 definition jsonb NOT NULL, scope_spu_id uuid, change_reason text NOT NULL, idempotency_key uuid NOT NULL, request_checksum text NOT NULL,
 created_by uuid NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT business_rule_versions_tenant_id_unique UNIQUE(tenant_id,id),
 CONSTRAINT business_rule_versions_number_unique UNIQUE(tenant_id,rule_id,version),
 CONSTRAINT business_rule_versions_request_unique UNIQUE(tenant_id,idempotency_key),
 CONSTRAINT business_rule_versions_rule_fk FOREIGN KEY(tenant_id,rule_id) REFERENCES business_rules(tenant_id,id),
 CONSTRAINT business_rule_versions_spu_fk FOREIGN KEY(tenant_id,scope_spu_id) REFERENCES spus(tenant_id,id),
 CONSTRAINT business_rule_versions_scope_check CHECK (
   (definition->>'scopeKind'='all' AND definition->>'productType' IS NULL AND definition->>'spuId' IS NULL AND scope_spu_id IS NULL) OR
   (definition->>'scopeKind'='product_type' AND definition->>'productType' IN ('shaped_pillow','tire_cover','rectangular_print') AND definition->>'spuId' IS NULL AND scope_spu_id IS NULL) OR
   (definition->>'scopeKind'='spu' AND definition->>'productType' IS NULL AND scope_spu_id IS NOT NULL AND definition->>'spuId'=scope_spu_id::text)
 )
);
ALTER TABLE business_rules ADD CONSTRAINT business_rules_latest_fk FOREIGN KEY(tenant_id,id,latest_version) REFERENCES business_rule_versions(tenant_id,rule_id,version) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE business_rules ADD CONSTRAINT business_rules_active_fk FOREIGN KEY(tenant_id,id,active_version) REFERENCES business_rule_versions(tenant_id,rule_id,version) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE business_rule_events (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), rule_id uuid NOT NULL, version integer NOT NULL,
 action text NOT NULL CHECK(action IN ('create','revise','publish','disable')), reason text NOT NULL,
 created_by uuid NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT business_rule_events_version_fk FOREIGN KEY(tenant_id,rule_id,version) REFERENCES business_rule_versions(tenant_id,rule_id,version)
);
--> statement-breakpoint
CREATE FUNCTION protect_business_rule_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Business rule history is immutable'; END $$;
CREATE TRIGGER business_rule_versions_immutable BEFORE UPDATE OR DELETE ON business_rule_versions FOR EACH ROW EXECUTE FUNCTION protect_business_rule_history();
CREATE TRIGGER business_rule_events_immutable BEFORE UPDATE OR DELETE ON business_rule_events FOR EACH ROW EXECUTE FUNCTION protect_business_rule_history();
ALTER TABLE business_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_rules FORCE ROW LEVEL SECURITY;
ALTER TABLE business_rule_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_rule_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE business_rule_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_rule_events FORCE ROW LEVEL SECURITY;
CREATE POLICY business_rules_tenant ON business_rules FOR ALL TO yummyai_app USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
CREATE POLICY business_rule_versions_tenant ON business_rule_versions FOR ALL TO yummyai_app USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
CREATE POLICY business_rule_events_tenant ON business_rule_events FOR ALL TO yummyai_app USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
GRANT SELECT,INSERT,UPDATE ON business_rules TO yummyai_app;
GRANT SELECT,INSERT ON business_rule_versions,business_rule_events TO yummyai_app;
