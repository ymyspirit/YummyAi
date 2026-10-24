-- Expire only private copies. Original observations, bindings, requests and proofs remain.
INSERT INTO app_users(id,oidc_subject,email,display_name)
 VALUES('00000000-0000-7000-8000-000000000009','system:factory-erp-source-retention','factory-erp-retention@system.invalid','Factory ERP source retention');
CREATE FUNCTION reject_factory_erp_retention_membership() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.user_id='00000000-0000-7000-8000-000000000009'::uuid THEN RAISE EXCEPTION 'factory_erp_retention_actor_noninteractive' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER factory_erp_retention_noninteractive BEFORE INSERT OR UPDATE ON memberships FOR EACH ROW EXECUTE FUNCTION reject_factory_erp_retention_membership();
CREATE FUNCTION factory_erp_source_now() RETURNS timestamptz LANGUAGE sql VOLATILE SET search_path=pg_catalog,public AS $$ SELECT clock_timestamp() $$;
REVOKE ALL ON FUNCTION factory_erp_source_now() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION factory_erp_source_now() TO yummyai_app;
ALTER TABLE factory_erp_imports ALTER COLUMN encrypted_payload DROP NOT NULL;
ALTER TABLE factory_erp_imports ADD COLUMN private_redacted_at timestamptz;
ALTER TABLE factory_erp_imports ADD CONSTRAINT factory_erp_imports_private_pair CHECK((encrypted_payload IS NULL)=(private_redacted_at IS NOT NULL));
ALTER TABLE factory_erp_observations ALTER COLUMN encrypted_payload DROP NOT NULL;
ALTER TABLE factory_erp_observations ADD COLUMN private_redacted_at timestamptz;
ALTER TABLE factory_erp_observations ADD CONSTRAINT factory_erp_observations_private_pair CHECK((encrypted_payload IS NULL)=(private_redacted_at IS NOT NULL));
ALTER TABLE factory_erp_bindings ALTER COLUMN encrypted_payload DROP NOT NULL;
ALTER TABLE factory_erp_bindings ADD COLUMN private_redacted_at timestamptz;
ALTER TABLE factory_erp_bindings ADD CONSTRAINT factory_erp_bindings_private_pair CHECK((encrypted_payload IS NULL)=(private_redacted_at IS NOT NULL));
CREATE INDEX factory_erp_imports_retention ON factory_erp_imports(tenant_id,expires_at,id) WHERE private_redacted_at IS NULL;
CREATE INDEX factory_erp_observations_import ON factory_erp_observations(tenant_id,import_id,id);
CREATE INDEX factory_erp_applications_import ON factory_erp_applications(tenant_id,import_id,id);
CREATE INDEX factory_erp_bindings_application ON factory_erp_bindings(tenant_id,application_id,id);
--> statement-breakpoint
CREATE TABLE factory_erp_source_purges (
 import_id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES organizations(id),object_key text NOT NULL,stored_checksum text NOT NULL,
 redacted_at timestamptz NOT NULL,creation_transaction_id text NOT NULL,
 lease_token uuid,lease_expires_at timestamptz,attempts integer NOT NULL DEFAULT 0,next_attempt_at timestamptz NOT NULL DEFAULT now(),
 last_failure_code text,purged_at timestamptz,deleted_versions integer,completion_transaction_id text,
 CONSTRAINT factory_erp_source_purges_source_fk FOREIGN KEY(tenant_id,import_id) REFERENCES factory_erp_imports(tenant_id,id),
 CONSTRAINT factory_erp_source_purges_lease_pair CHECK((lease_token IS NULL)=(lease_expires_at IS NULL)),
 CONSTRAINT factory_erp_source_purges_counts CHECK(attempts>=0 AND(deleted_versions IS NULL OR deleted_versions BETWEEN 0 AND 100000)),
 CONSTRAINT factory_erp_source_purges_failure CHECK(last_failure_code IS NULL OR last_failure_code IN('storage_delete_failed','absence_unconfirmed')),
 CONSTRAINT factory_erp_source_purges_completed CHECK((purged_at IS NULL)=(completion_transaction_id IS NULL) AND(purged_at IS NULL)=(deleted_versions IS NULL)
  AND(purged_at IS NULL OR(lease_token IS NOT NULL AND last_failure_code IS NULL AND purged_at>=redacted_at)))
);
CREATE UNIQUE INDEX factory_erp_source_purges_scope ON factory_erp_source_purges(tenant_id,import_id);
CREATE UNIQUE INDEX factory_erp_source_purges_token ON factory_erp_source_purges(lease_token) WHERE lease_token IS NOT NULL;
CREATE INDEX factory_erp_source_purges_due ON factory_erp_source_purges(tenant_id,next_attempt_at,import_id) WHERE purged_at IS NULL;
ALTER TABLE factory_erp_source_purges ENABLE ROW LEVEL SECURITY;
ALTER TABLE factory_erp_source_purges FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON factory_erp_source_purges USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON factory_erp_source_purges TO yummyai_app;
--> statement-breakpoint
-- Keep the genuine163 definition immutable; only its two source-clock calls change here.
DO $$ DECLARE definition text;BEGIN
 definition:=pg_get_functiondef('guard_factory_erp_record()'::regprocedure);
 IF(length(definition)-length(replace(definition,'clock_timestamp()','')))/length('clock_timestamp()')<>2
  THEN RAISE EXCEPTION 'factory_erp_source_clock_shape_changed';END IF;
 EXECUTE replace(definition,'clock_timestamp()','factory_erp_source_now()');
END $$;
CREATE FUNCTION factory_erp_require_retention_actor(tenant uuid) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF tenant IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid
  OR nullif(current_setting('app.user_id',true),'')::uuid IS DISTINCT FROM '00000000-0000-7000-8000-000000000009'::uuid
  THEN RAISE EXCEPTION 'factory_erp_retention_actor_required' USING ERRCODE='23514';END IF;
END $$;
REVOKE ALL ON FUNCTION factory_erp_require_retention_actor(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION factory_erp_require_retention_actor(uuid) TO yummyai_app;
CREATE FUNCTION guard_factory_erp_private_insert() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE source_id uuid;source_row factory_erp_imports;
BEGIN
 IF TG_TABLE_NAME<>'factory_erp_applications' THEN
  IF NEW.encrypted_payload IS NULL OR NEW.private_redacted_at IS NOT NULL THEN RAISE EXCEPTION 'factory_erp_original_private_source_required' USING ERRCODE='23514';END IF;
 END IF;
 IF TG_TABLE_NAME='factory_erp_imports' THEN RETURN NEW;END IF;
 IF TG_TABLE_NAME='factory_erp_bindings' THEN SELECT a.import_id INTO source_id FROM factory_erp_applications a WHERE a.tenant_id=NEW.tenant_id AND a.id=NEW.application_id;
 ELSE source_id:=NEW.import_id;END IF;
 -- A live application holds the source until its whole transaction commits.
 -- Retention takes FOR UPDATE SKIP LOCKED, then sees all committed child copies.
 SELECT * INTO source_row FROM factory_erp_imports WHERE tenant_id=NEW.tenant_id AND id=source_id FOR SHARE;
 IF source_row.id IS NULL OR source_row.expires_at<=factory_erp_source_now() OR source_row.encrypted_payload IS NULL OR source_row.private_redacted_at IS NOT NULL
  THEN RAISE EXCEPTION 'factory_erp_private_source_expired' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['factory_erp_imports','factory_erp_applications','factory_erp_bindings','factory_erp_observations'] LOOP
  EXECUTE format('CREATE TRIGGER factory_erp_current_source BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION guard_factory_erp_private_insert()',t);
 END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION guard_factory_erp_private_redaction() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE source_id uuid;source_row factory_erp_imports;
BEGIN
 IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'factory_erp_private_history_immutable' USING ERRCODE='23514';END IF;
 PERFORM factory_erp_require_retention_actor(OLD.tenant_id);
 IF TG_TABLE_NAME='factory_erp_imports' THEN source_id:=OLD.id;
 ELSIF TG_TABLE_NAME='factory_erp_bindings' THEN SELECT a.import_id INTO source_id FROM factory_erp_applications a WHERE a.tenant_id=OLD.tenant_id AND a.id=OLD.application_id;
 ELSE source_id:=OLD.import_id;END IF;
 SELECT * INTO source_row FROM factory_erp_imports WHERE tenant_id=OLD.tenant_id AND id=source_id FOR UPDATE;
 IF source_row.id IS NULL OR source_row.expires_at>factory_erp_source_now() OR OLD.encrypted_payload IS NULL OR NEW.encrypted_payload IS NOT NULL
  OR OLD.private_redacted_at IS NOT NULL OR NEW.private_redacted_at IS NULL
  OR(to_jsonb(NEW)-ARRAY['encrypted_payload','private_redacted_at']) IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['encrypted_payload','private_redacted_at'])
  THEN RAISE EXCEPTION 'factory_erp_only_due_private_redaction' USING ERRCODE='23514';END IF;
 NEW.private_redacted_at:=factory_erp_source_now();RETURN NEW;
END $$;
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['factory_erp_imports','factory_erp_bindings','factory_erp_observations'] LOOP
  EXECUTE format('DROP TRIGGER factory_erp_immutable ON %I',t);
  EXECUTE format('CREATE TRIGGER factory_erp_private_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION guard_factory_erp_private_redaction()',t);
  EXECUTE format('GRANT UPDATE(encrypted_payload,private_redacted_at) ON %I TO yummyai_app',t);
 END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION guard_factory_erp_source_purge() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE source_row factory_erp_imports;n timestamptz:=factory_erp_source_now();xid text:=pg_current_xact_id()::text;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'factory_erp_purge_receipt_immutable' USING ERRCODE='23514';END IF;
 PERFORM factory_erp_require_retention_actor(NEW.tenant_id);
 SELECT * INTO source_row FROM factory_erp_imports WHERE tenant_id=NEW.tenant_id AND id=NEW.import_id;
 IF source_row.id IS NULL OR source_row.expires_at>n OR source_row.encrypted_payload IS NOT NULL OR source_row.private_redacted_at IS NULL
  OR NEW.object_key IS DISTINCT FROM source_row.object_key OR NEW.stored_checksum IS DISTINCT FROM source_row.stored_checksum
  OR NEW.redacted_at IS DISTINCT FROM source_row.private_redacted_at
  OR EXISTS(SELECT 1 FROM factory_erp_observations o WHERE o.tenant_id=NEW.tenant_id AND o.import_id=NEW.import_id AND o.encrypted_payload IS NOT NULL)
  OR EXISTS(SELECT 1 FROM factory_erp_bindings b JOIN factory_erp_applications a ON a.tenant_id=b.tenant_id AND a.id=b.application_id WHERE a.tenant_id=NEW.tenant_id AND a.import_id=NEW.import_id AND b.encrypted_payload IS NOT NULL)
  THEN RAISE EXCEPTION 'factory_erp_redacted_exact_source_required' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.creation_transaction_id IS DISTINCT FROM xid OR NEW.attempts<>0 OR NEW.lease_token IS NOT NULL OR NEW.lease_expires_at IS NOT NULL
   OR NEW.last_failure_code IS NOT NULL OR NEW.purged_at IS NOT NULL OR NEW.deleted_versions IS NOT NULL OR NEW.completion_transaction_id IS NOT NULL
   THEN RAISE EXCEPTION 'factory_erp_purge_birth_required' USING ERRCODE='23514';END IF;
  NEW.next_attempt_at:=n;RETURN NEW;
 END IF;
 IF OLD.purged_at IS NOT NULL OR(to_jsonb(NEW)-ARRAY['lease_token','lease_expires_at','attempts','next_attempt_at','last_failure_code','purged_at','deleted_versions','completion_transaction_id'])
  IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['lease_token','lease_expires_at','attempts','next_attempt_at','last_failure_code','purged_at','deleted_versions','completion_transaction_id'])
  THEN RAISE EXCEPTION 'factory_erp_purge_receipt_immutable' USING ERRCODE='23514';END IF;
 IF NEW.purged_at IS NOT NULL THEN
  IF OLD.lease_token IS NULL OR OLD.lease_expires_at<=n OR NEW.lease_token IS DISTINCT FROM OLD.lease_token OR NEW.lease_expires_at IS DISTINCT FROM OLD.lease_expires_at
   OR NEW.attempts<>OLD.attempts OR NEW.next_attempt_at IS DISTINCT FROM OLD.next_attempt_at OR NEW.last_failure_code IS NOT NULL
   OR NEW.deleted_versions IS NULL OR NEW.completion_transaction_id IS DISTINCT FROM xid
   THEN RAISE EXCEPTION 'factory_erp_active_purge_lease_required' USING ERRCODE='23514';END IF;
  NEW.purged_at:=n;RETURN NEW;
 END IF;
 IF NEW.completion_transaction_id IS NOT NULL OR NEW.deleted_versions IS NOT NULL THEN RAISE EXCEPTION 'factory_erp_purge_completion_required' USING ERRCODE='23514';END IF;
 IF NEW.attempts=OLD.attempts+1 THEN
  IF OLD.next_attempt_at>n OR(OLD.lease_token IS NOT NULL AND OLD.lease_expires_at>n) OR NEW.lease_token IS NULL OR NEW.lease_token IS NOT DISTINCT FROM OLD.lease_token
   OR NEW.lease_expires_at<n+interval '29 seconds' OR NEW.lease_expires_at>n+interval '301 seconds' OR NEW.last_failure_code IS NOT NULL OR NEW.next_attempt_at IS DISTINCT FROM OLD.next_attempt_at
   THEN RAISE EXCEPTION 'factory_erp_purge_claim_required' USING ERRCODE='23514';END IF;
 ELSIF NEW.attempts=OLD.attempts THEN
  IF OLD.lease_token IS NULL OR OLD.lease_expires_at<=n OR NEW.lease_token IS NOT NULL OR NEW.lease_expires_at IS NOT NULL
   OR NEW.last_failure_code IS NULL OR NEW.next_attempt_at<n+interval '1 second' OR NEW.next_attempt_at>n+interval '1 hour'
   THEN RAISE EXCEPTION 'factory_erp_purge_retry_required' USING ERRCODE='23514';END IF;
 ELSE RAISE EXCEPTION 'factory_erp_purge_transition_invalid' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER factory_erp_purge_guard BEFORE INSERT OR UPDATE OR DELETE ON factory_erp_source_purges FOR EACH ROW EXECUTE FUNCTION guard_factory_erp_source_purge();
--> statement-breakpoint
CREATE FUNCTION require_factory_erp_redaction_closure() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE source_id uuid;j factory_erp_source_purges;xid text:=pg_current_xact_id()::text;
BEGIN
 IF TG_TABLE_NAME='factory_erp_source_purges' THEN source_id:=NEW.import_id;
 ELSIF TG_TABLE_NAME='factory_erp_imports' THEN source_id:=NEW.id;
 ELSIF TG_TABLE_NAME='factory_erp_bindings' THEN SELECT a.import_id INTO source_id FROM factory_erp_applications a WHERE a.tenant_id=NEW.tenant_id AND a.id=NEW.application_id;
 ELSE source_id:=NEW.import_id;END IF;
 SELECT * INTO j FROM factory_erp_source_purges WHERE tenant_id=NEW.tenant_id AND import_id=source_id;
 IF j.import_id IS NULL THEN RAISE EXCEPTION 'factory_erp_redaction_outbox_required' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME<>'factory_erp_source_purges' OR TG_OP='INSERT' THEN
  IF j.creation_transaction_id IS DISTINCT FROM xid OR NOT EXISTS(SELECT 1 FROM audit_events a WHERE a.tenant_id=NEW.tenant_id AND a.entity_id=source_id AND a.entity_type='factory_erp_source'
   AND a.action='factory_erp.source_redacted' AND a.actor_user_id='00000000-0000-7000-8000-000000000009'::uuid AND a.result='success' AND a.xmin::text=(xid::numeric%4294967296)::bigint::text)
   THEN RAISE EXCEPTION 'factory_erp_redaction_audit_required' USING ERRCODE='23514';END IF;
 END IF;
 IF TG_TABLE_NAME='factory_erp_source_purges' THEN
  IF NEW.purged_at IS NOT NULL THEN
   IF NEW.completion_transaction_id IS DISTINCT FROM xid OR NOT EXISTS(SELECT 1 FROM audit_events a WHERE a.tenant_id=NEW.tenant_id AND a.entity_id=source_id AND a.entity_type='factory_erp_source'
    AND a.action='factory_erp.source_purged' AND a.actor_user_id='00000000-0000-7000-8000-000000000009'::uuid AND a.result='success' AND a.xmin::text=(xid::numeric%4294967296)::bigint::text)
    THEN RAISE EXCEPTION 'factory_erp_purge_audit_required' USING ERRCODE='23514';END IF;
  END IF;
 END IF;
 RETURN NULL;
END $$;
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['factory_erp_imports','factory_erp_bindings','factory_erp_observations'] LOOP
  EXECUTE format('CREATE CONSTRAINT TRIGGER factory_erp_redaction_closure AFTER UPDATE ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_factory_erp_redaction_closure()',t);
 END LOOP;
END $$;
CREATE CONSTRAINT TRIGGER factory_erp_purge_closure AFTER INSERT OR UPDATE ON factory_erp_source_purges DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_factory_erp_redaction_closure();
