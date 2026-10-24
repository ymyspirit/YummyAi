CREATE TABLE agent_methods (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), method_key text NOT NULL,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0), latest_version integer NOT NULL DEFAULT 1 CHECK(latest_version>0), active_version integer,
 state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','in_review','published')),
 withdrawal_generation integer NOT NULL DEFAULT 0 CHECK(withdrawal_generation>=0), adopted_at timestamptz, disabled_at timestamptz,
 created_by uuid NOT NULL REFERENCES app_users(id), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,method_key), CHECK(method_key ~ '^[a-z][a-z0-9_.-]{2,159}$'),
 CHECK(active_version IS NULL OR (adopted_at IS NOT NULL AND disabled_at IS NULL))
);
CREATE TABLE agent_method_versions (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), method_id uuid NOT NULL, version integer NOT NULL CHECK(version>0),
 definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object' AND octet_length(definition::text)<=131072),
 checksum text NOT NULL CHECK(checksum ~ '^[a-f0-9]{64}$'), reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 600),
 request_id uuid NOT NULL, request_checksum text NOT NULL CHECK(request_checksum ~ '^[a-f0-9]{64}$'),
 created_by uuid NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,method_id,version), UNIQUE(tenant_id,request_id),
 FOREIGN KEY(tenant_id,method_id) REFERENCES agent_methods(tenant_id,id)
);
ALTER TABLE agent_methods ADD CONSTRAINT agent_methods_latest_fk FOREIGN KEY(tenant_id,id,latest_version) REFERENCES agent_method_versions(tenant_id,method_id,version) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE agent_methods ADD CONSTRAINT agent_methods_active_fk FOREIGN KEY(tenant_id,id,active_version) REFERENCES agent_method_versions(tenant_id,method_id,version) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE agent_method_events (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), method_id uuid NOT NULL, version integer NOT NULL,
 revision integer NOT NULL CHECK(revision>0), action text NOT NULL CHECK(action IN ('create','revise','submit','publish','reject','disable')),
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 600), request_id uuid NOT NULL,
 request_checksum text NOT NULL CHECK(request_checksum ~ '^[a-f0-9]{64}$'), created_by uuid NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,request_id), FOREIGN KEY(tenant_id,method_id,version) REFERENCES agent_method_versions(tenant_id,method_id,version)
);
--> statement-breakpoint
CREATE FUNCTION protect_agent_method_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.id<>OLD.id OR NEW.tenant_id<>OLD.tenant_id OR NEW.method_key<>OLD.method_key OR NEW.created_by<>OLD.created_by
 OR NEW.revision<=OLD.revision OR NEW.latest_version<OLD.latest_version OR NEW.withdrawal_generation<OLD.withdrawal_generation
 OR (OLD.adopted_at IS NOT NULL AND NEW.adopted_at IS DISTINCT FROM OLD.adopted_at)
 THEN RAISE EXCEPTION 'Agent method identity and adoption history are immutable' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER agent_method_identity BEFORE UPDATE ON agent_methods FOR EACH ROW EXECUTE FUNCTION protect_agent_method_identity();
CREATE FUNCTION protect_agent_method_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Agent method history is immutable' USING ERRCODE='55000'; END; $$;
CREATE TRIGGER agent_method_version_immutable BEFORE UPDATE OR DELETE ON agent_method_versions FOR EACH ROW EXECUTE FUNCTION protect_agent_method_history();
CREATE TRIGGER agent_method_event_immutable BEFORE UPDATE OR DELETE ON agent_method_events FOR EACH ROW EXECUTE FUNCTION protect_agent_method_history();
CREATE FUNCTION validate_agent_method_provenance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ref jsonb;
BEGIN
 IF NEW.definition->>'methodKey' IS DISTINCT FROM (SELECT method_key FROM agent_methods WHERE tenant_id=NEW.tenant_id AND id=NEW.method_id)
 OR jsonb_typeof(NEW.definition->'knowledgeReferences') IS DISTINCT FROM 'array'
 OR jsonb_array_length(NEW.definition->'knowledgeReferences')>4
 THEN RAISE EXCEPTION 'Invalid agent method definition' USING ERRCODE='23514'; END IF;
 FOR ref IN SELECT * FROM jsonb_array_elements(NEW.definition->'knowledgeReferences') LOOP
  IF NOT EXISTS(SELECT 1 FROM knowledge_versions v WHERE v.tenant_id=NEW.tenant_id AND v.id=(ref->>'versionId')::uuid
   AND v.entry_id=(ref->>'entryId')::uuid AND v.version=(ref->>'version')::integer AND v.checksum=ref->>'checksum'
   AND v.scope_spu_id IS NULL AND v.fields->>'platform'='all' AND v.fields->>'market'='ALL')
  THEN RAISE EXCEPTION 'Method provenance must use same-tenant general knowledge' USING ERRCODE='23514'; END IF;
 END LOOP;
 RETURN NEW;
END; $$;
CREATE TRIGGER agent_method_provenance BEFORE INSERT ON agent_method_versions FOR EACH ROW EXECUTE FUNCTION validate_agent_method_provenance();
--> statement-breakpoint
ALTER TABLE agent_methods ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_methods FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_method_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_method_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_method_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_method_events FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_methods_tenant ON agent_methods FOR ALL TO yummyai_app USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
CREATE POLICY agent_method_versions_tenant ON agent_method_versions FOR ALL TO yummyai_app USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
CREATE POLICY agent_method_events_tenant ON agent_method_events FOR ALL TO yummyai_app USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
GRANT SELECT,INSERT,UPDATE ON agent_methods TO yummyai_app;
GRANT SELECT,INSERT ON agent_method_versions,agent_method_events TO yummyai_app;
