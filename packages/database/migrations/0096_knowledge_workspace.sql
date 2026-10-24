CREATE TABLE knowledge_entries (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 latest_version integer NOT NULL DEFAULT 1 CHECK(latest_version>0), active_version integer, state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','in_review','published')),
 created_by uuid NOT NULL REFERENCES app_users(id), updated_at timestamptz NOT NULL DEFAULT now(), archived_at timestamptz,
 CONSTRAINT knowledge_entries_tenant_id_unique UNIQUE(tenant_id,id)
);
CREATE TABLE knowledge_versions (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), entry_id uuid NOT NULL, version integer NOT NULL CHECK(version>0),
 fields jsonb NOT NULL, scope_spu_id uuid, checksum text NOT NULL, reason text NOT NULL, request_id uuid NOT NULL, request_checksum text NOT NULL,
 created_by uuid NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT knowledge_versions_number_unique UNIQUE(tenant_id,entry_id,version), CONSTRAINT knowledge_versions_request_unique UNIQUE(tenant_id,request_id),
 FOREIGN KEY(tenant_id,entry_id) REFERENCES knowledge_entries(tenant_id,id), FOREIGN KEY(tenant_id,scope_spu_id) REFERENCES spus(tenant_id,id),
 CHECK ((scope_spu_id IS NULL AND fields->>'spuId' IS NULL) OR (scope_spu_id IS NOT NULL AND fields->>'spuId'=scope_spu_id::text))
);
ALTER TABLE knowledge_entries ADD CONSTRAINT knowledge_entries_latest_fk FOREIGN KEY(tenant_id,id,latest_version) REFERENCES knowledge_versions(tenant_id,entry_id,version) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE knowledge_entries ADD CONSTRAINT knowledge_entries_active_fk FOREIGN KEY(tenant_id,id,active_version) REFERENCES knowledge_versions(tenant_id,entry_id,version) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE knowledge_events (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), entry_id uuid NOT NULL, version integer NOT NULL,
 action text NOT NULL CHECK(action IN ('create','revise','submit','publish','reject','disable','archive')), reason text NOT NULL,
 request_id uuid NOT NULL, request_checksum text NOT NULL, created_by uuid NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,request_id), FOREIGN KEY(tenant_id,entry_id,version) REFERENCES knowledge_versions(tenant_id,entry_id,version)
);
--> statement-breakpoint
CREATE FUNCTION protect_knowledge_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Knowledge history is immutable'; END $$;
CREATE TRIGGER knowledge_versions_immutable BEFORE UPDATE OR DELETE ON knowledge_versions FOR EACH ROW EXECUTE FUNCTION protect_knowledge_history();
CREATE TRIGGER knowledge_events_immutable BEFORE UPDATE OR DELETE ON knowledge_events FOR EACH ROW EXECUTE FUNCTION protect_knowledge_history();
ALTER TABLE knowledge_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_events FORCE ROW LEVEL SECURITY;
CREATE POLICY knowledge_entries_tenant ON knowledge_entries FOR ALL TO yummyai_app USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
CREATE POLICY knowledge_versions_tenant ON knowledge_versions FOR ALL TO yummyai_app USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
CREATE POLICY knowledge_events_tenant ON knowledge_events FOR ALL TO yummyai_app USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
GRANT SELECT,INSERT,UPDATE ON knowledge_entries TO yummyai_app;
GRANT SELECT,INSERT ON knowledge_versions,knowledge_events TO yummyai_app;
CREATE INDEX knowledge_entries_workspace ON knowledge_entries(tenant_id,updated_at DESC);
CREATE INDEX knowledge_versions_scope ON knowledge_versions(tenant_id,scope_spu_id);
