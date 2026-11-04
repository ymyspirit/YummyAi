CREATE TABLE logistics_accounts (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES organizations(id),created_by uuid NOT NULL REFERENCES app_users(id),created_at timestamptz NOT NULL DEFAULT now(),
 version integer NOT NULL CHECK(version>0),verified_version_id uuid,verified_at timestamptz,channels jsonb NOT NULL DEFAULT '[]'::jsonb,UNIQUE(tenant_id,id)
);
CREATE TABLE logistics_account_versions (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES organizations(id),created_by uuid NOT NULL REFERENCES app_users(id),created_at timestamptz NOT NULL DEFAULT now(),
 account_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),profile jsonb NOT NULL,encrypted_credentials text NOT NULL,request_key uuid NOT NULL,request_hash text NOT NULL,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,account_id,version),UNIQUE(tenant_id,request_key),FOREIGN KEY(tenant_id,account_id) REFERENCES logistics_accounts(tenant_id,id)
);
ALTER TABLE logistics_accounts ADD FOREIGN KEY(tenant_id,verified_version_id) REFERENCES logistics_account_versions(tenant_id,id);
CREATE TRIGGER logistics_account_versions_immutable BEFORE UPDATE OR DELETE ON logistics_account_versions FOR EACH ROW EXECUTE FUNCTION protect_logistics_history();
--> statement-breakpoint
DO $$ DECLARE tab text; BEGIN FOREACH tab IN ARRAY ARRAY['logistics_accounts','logistics_account_versions'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
 EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK(substring(id::text from 15 for 1)=''7'')',tab,tab||'_uuidv7');
 EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO yummyai_app USING(tenant_id=(SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid))',tab||'_tenant_policy',tab);
 EXECUTE format('GRANT SELECT,INSERT ON %I TO yummyai_app',tab);
END LOOP;END $$;
GRANT UPDATE ON logistics_accounts TO yummyai_app;
