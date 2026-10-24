CREATE TABLE production_command_intents (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), created_by uuid NOT NULL REFERENCES app_users(id),
 order_id uuid NOT NULL, kind text NOT NULL, target_id uuid NOT NULL, line_ids jsonb NOT NULL,
 request_key text NOT NULL, request_checksum text NOT NULL, owner_checksum text NOT NULL,
 authority_snapshot jsonb NOT NULL, admission_kind text NOT NULL DEFAULT 'new_request', encrypted_input text, contract_version text NOT NULL DEFAULT 'production-command-v1',
 status text NOT NULL DEFAULT 'prepared', generation integer NOT NULL DEFAULT 0, lease_token uuid, lease_expires_at timestamptz,
 result_ids jsonb, error_code text, completed_at timestamptz, acknowledged_at timestamptz, redacted_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 CONSTRAINT production_command_intents_order_fk FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id),
 CONSTRAINT production_command_intents_kind_check CHECK(kind IN ('approved_design','reviewed_line','reviewed_order')),
 CONSTRAINT production_command_intents_admission_check CHECK(admission_kind IN ('new_request','existing_receipt')),
 CONSTRAINT production_command_intents_status_check CHECK(status IN ('prepared','executing','succeeded','rejected','uncertain','cancelled','expired')),
 CONSTRAINT production_command_intents_checksum_check CHECK(request_checksum~'^[a-f0-9]{64}$' AND owner_checksum~'^[a-f0-9]{64}$'),
 CONSTRAINT production_command_intents_identity_check CHECK(substring(id::text from 15 for 1)='7' AND length(request_key) BETWEEN 8 AND 200 AND generation>=0),
 CONSTRAINT production_command_intents_lease_check CHECK((lease_token IS NULL)=(lease_expires_at IS NULL)),
 CONSTRAINT production_command_intents_lines_check CHECK(jsonb_typeof(line_ids)='array' AND jsonb_array_length(line_ids) BETWEEN 1 AND 100),
 CONSTRAINT production_command_intents_expiry_check CHECK(expires_at>created_at),
 UNIQUE(tenant_id,id)
);
CREATE UNIQUE INDEX production_command_intents_actor_key_unique ON production_command_intents(tenant_id,created_by,kind,target_id,request_key);
CREATE INDEX production_command_intents_business_key_idx ON production_command_intents(tenant_id,kind,target_id,request_key);
CREATE INDEX production_command_intents_source_idx ON production_command_intents(tenant_id,order_id);
CREATE INDEX production_command_intents_owner_open_idx ON production_command_intents(tenant_id,created_by,order_id,acknowledged_at,created_at);
CREATE TABLE production_command_attempts (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, intent_id uuid NOT NULL, generation integer NOT NULL,
 lease_token uuid NOT NULL, status text NOT NULL DEFAULT 'executing', result_ids jsonb, error_code text,
 started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 CONSTRAINT production_command_attempts_intent_fk FOREIGN KEY(tenant_id,intent_id) REFERENCES production_command_intents(tenant_id,id),
 CONSTRAINT production_command_attempts_identity_check CHECK(substring(id::text from 15 for 1)='7' AND generation>0),
 CONSTRAINT production_command_attempts_status_check CHECK(status IN ('executing','succeeded','rejected','uncertain','superseded')),
 CONSTRAINT production_command_attempts_finished_check CHECK((status='executing')=(finished_at IS NULL)),
 UNIQUE(tenant_id,intent_id,generation)
);
--> statement-breakpoint
ALTER TABLE production_command_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_command_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY production_command_intents_tenant ON production_command_intents
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE production_command_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_command_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY production_command_attempts_tenant ON production_command_attempts
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT ON production_command_intents,production_command_attempts TO yummyai_app;
GRANT UPDATE(status,generation,lease_token,lease_expires_at,result_ids,error_code,completed_at,acknowledged_at,redacted_at,encrypted_input) ON production_command_intents TO yummyai_app;
GRANT UPDATE(status,result_ids,error_code,finished_at) ON production_command_attempts TO yummyai_app;
--> statement-breakpoint
CREATE FUNCTION production_command_source_available(command production_command_intents) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM orders o LEFT JOIN order_protected_details p ON p.tenant_id=o.tenant_id AND p.order_id=o.id
 WHERE o.tenant_id=command.tenant_id AND o.id=command.order_id AND o.address_status<>'anonymized'
 AND ((o.address_status='missing' AND p.id IS NULL) OR (p.status='protected' AND p.retention_expires_at>clock_timestamp()))
 AND (command.kind='approved_design' OR NOT EXISTS(
  SELECT 1 FROM jsonb_array_elements_text(command.line_ids) requested(id)
  LEFT JOIN order_work_items w ON w.tenant_id=command.tenant_id AND w.id=requested.id::uuid
  WHERE w.id IS NULL OR w.encrypted_data_key IS NULL OR w.archived_at IS NOT NULL OR w.expires_at<=clock_timestamp())))
$$;
CREATE FUNCTION guard_production_command_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.created_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid
   OR NEW.authority_snapshot->>'tenantId' IS DISTINCT FROM NEW.tenant_id::text
   OR NEW.authority_snapshot->>'userId' IS DISTINCT FROM NEW.created_by::text
   OR NEW.contract_version<>'production-command-v1' THEN
   RAISE EXCEPTION 'production command must bind its original authenticated actor' USING ERRCODE='23514';
  END IF;
 ELSE
  IF (to_jsonb(OLD)-ARRAY['status','generation','lease_token','lease_expires_at','result_ids','error_code','completed_at','acknowledged_at','redacted_at','encrypted_input'])
   IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['status','generation','lease_token','lease_expires_at','result_ids','error_code','completed_at','acknowledged_at','redacted_at','encrypted_input'])
   OR (OLD.encrypted_input IS DISTINCT FROM NEW.encrypted_input AND NOT(OLD.encrypted_input IS NOT NULL AND NEW.encrypted_input IS NULL
    AND (NEW.acknowledged_at IS NOT NULL OR NEW.expires_at<=clock_timestamp() OR NOT production_command_source_available(NEW))))
   OR NEW.generation<OLD.generation OR NEW.generation>OLD.generation+1
   OR (OLD.result_ids IS NOT NULL AND NEW.result_ids IS DISTINCT FROM OLD.result_ids)
   OR (OLD.acknowledged_at IS NOT NULL AND NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at) THEN
   RAISE EXCEPTION 'production command original input and receipts are immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.created_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid AND NOT(
    NEW.encrypted_input IS NULL AND NOT production_command_source_available(NEW)
    AND NEW.status IN ('uncertain','succeeded','rejected','cancelled','expired') AND NEW.lease_token IS NULL
    AND NEW.result_ids IS NOT DISTINCT FROM OLD.result_ids AND NEW.acknowledged_at IS NOT DISTINCT FROM OLD.acknowledged_at) THEN
   RAISE EXCEPTION 'only the original actor may recover this production command' USING ERRCODE='23514';
  END IF;
 END IF;
 IF NEW.status='executing' AND (NEW.encrypted_input IS NULL OR NEW.lease_token IS NULL OR NEW.generation<1) THEN
  RAISE EXCEPTION 'executing production command needs retained input and a lease' USING ERRCODE='23514';
 END IF;
 IF NEW.status='succeeded' THEN
  IF NEW.result_ids IS NULL OR jsonb_typeof(NEW.result_ids)<>'array' OR jsonb_array_length(NEW.result_ids)<>jsonb_array_length(NEW.line_ids)
   OR (SELECT count(DISTINCT requested.id) FROM jsonb_array_elements_text(NEW.result_ids) requested(id))<>jsonb_array_length(NEW.line_ids)
   OR (SELECT count(DISTINCT requested.id) FROM jsonb_array_elements_text(NEW.line_ids) requested(id))<>jsonb_array_length(NEW.line_ids)
   OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(NEW.result_ids) requested(id)
    LEFT JOIN production_orders p ON p.tenant_id=NEW.tenant_id AND p.id=requested.id::uuid
    WHERE p.id IS NULL OR p.order_id<>NEW.order_id OR p.created_by<>NEW.created_by OR NOT NEW.line_ids ? p.order_line_id::text
     OR p.idempotency_key<>CASE WHEN NEW.kind='reviewed_order' THEN 'whole-order:'||NEW.request_key ELSE NEW.request_key END
     OR (NEW.kind<>'reviewed_line' AND p.request_checksum IS DISTINCT FROM NEW.owner_checksum)
     OR (NEW.kind='reviewed_line' AND NOT EXISTS(SELECT 1 FROM order_work_events e WHERE e.tenant_id=NEW.tenant_id
      AND e.work_item_id=p.order_line_id AND e.idempotency_key::text=lower(NEW.request_key) AND e.actor_id=NEW.created_by AND e.request_hash=NEW.owner_checksum))) THEN
   RAISE EXCEPTION 'production command success requires committed owner evidence' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_original_production_command BEFORE INSERT OR UPDATE ON production_command_intents FOR EACH ROW EXECUTE FUNCTION guard_production_command_intent();
CREATE FUNCTION guard_production_command_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE command production_command_intents;
BEGIN
 SELECT * INTO command FROM production_command_intents WHERE tenant_id=NEW.tenant_id AND id=NEW.intent_id;
 IF command.created_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid THEN
  RAISE EXCEPTION 'production attempts belong to their original actor' USING ERRCODE='23514';
 END IF;
 IF TG_OP='INSERT' THEN
  IF command.status<>'executing' OR command.generation<>NEW.generation OR command.lease_token IS DISTINCT FROM NEW.lease_token THEN
   RAISE EXCEPTION 'production attempt must match the current claim' USING ERRCODE='23514';
  END IF;
 ELSIF OLD.status<>'executing' OR (to_jsonb(OLD)-ARRAY['status','result_ids','error_code','finished_at'])
   IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['status','result_ids','error_code','finished_at']) THEN
  RAISE EXCEPTION 'finished production attempts are immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_original_production_attempt BEFORE INSERT OR UPDATE ON production_command_attempts FOR EACH ROW EXECUTE FUNCTION guard_production_command_attempt();
--> statement-breakpoint
CREATE FUNCTION redact_unavailable_production_commands() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_order uuid;
BEGIN
 IF TG_TABLE_NAME='orders' THEN source_order:=NEW.id;
 ELSIF TG_TABLE_NAME='order_protected_details' THEN source_order:=NEW.order_id;
 ELSE SELECT order_id INTO source_order FROM order_lines WHERE tenant_id=NEW.tenant_id AND id=NEW.id;
 END IF;
 UPDATE production_command_intents c SET encrypted_input=NULL,redacted_at=clock_timestamp(),lease_token=NULL,lease_expires_at=NULL,
  status=CASE WHEN c.status IN ('prepared','executing','uncertain') THEN 'uncertain' ELSE c.status END
 WHERE c.tenant_id=NEW.tenant_id AND c.order_id=source_order AND c.encrypted_input IS NOT NULL AND NOT production_command_source_available(c);
 RETURN NULL;
END $$;
CREATE TRIGGER redact_commands_after_order_privacy AFTER UPDATE OF address_status ON orders FOR EACH ROW EXECUTE FUNCTION redact_unavailable_production_commands();
CREATE TRIGGER redact_commands_after_protected_privacy AFTER UPDATE OF status,retention_expires_at ON order_protected_details FOR EACH ROW EXECUTE FUNCTION redact_unavailable_production_commands();
CREATE TRIGGER redact_commands_after_work_privacy AFTER UPDATE OF encrypted_data_key,expires_at,archived_at ON order_work_items FOR EACH ROW EXECUTE FUNCTION redact_unavailable_production_commands();
