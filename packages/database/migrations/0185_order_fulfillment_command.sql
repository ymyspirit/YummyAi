ALTER TABLE production_milestone_events ADD COLUMN request_checksum text;
ALTER TABLE production_milestone_events ADD CONSTRAINT production_milestone_request_checksum_check
 CHECK(request_checksum IS NULL OR request_checksum~'^[a-f0-9]{64}$');
-- Historical events keep NULL. A new checksum is not fabricated for old writes.
CREATE TABLE order_fulfillment_command_intents (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), created_by uuid NOT NULL REFERENCES app_users(id),
 request_id uuid NOT NULL, contract_version text NOT NULL DEFAULT 'fulfillment-command-v1',
 order_id uuid NOT NULL, line_ids jsonb NOT NULL, kind text NOT NULL, target_id uuid NOT NULL,
 request_key text NOT NULL, request_checksum text NOT NULL, owner_checksum text NOT NULL,
 authority_snapshot jsonb NOT NULL, encrypted_input text,
 status text NOT NULL DEFAULT 'prepared', generation integer NOT NULL DEFAULT 0, lease_token uuid, lease_expires_at timestamptz,
 error_code text, acknowledged_at timestamptz, redacted_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 CONSTRAINT order_fulfillment_command_order_fk FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id),
 CONSTRAINT order_fulfillment_command_kind_check CHECK(kind IN ('delivery_create','delivery_feedback','production_milestone','quality_inspection','quality_group_inspection','production_recovery','whole_production_milestone','whole_quality_inspection','shipment_create','whole_shipment_create','shipment_version','shipment_review','shipment_dispatch','shipment_platform_confirmation')),
 CONSTRAINT order_fulfillment_command_status_check CHECK(status IN ('prepared','executing','uncertain','rejected','cancelled','expired')),
 CONSTRAINT order_fulfillment_command_hash_check CHECK(request_checksum~'^[a-f0-9]{64}$' AND owner_checksum~'^[a-f0-9]{64}$'),
 CONSTRAINT order_fulfillment_command_identity_check CHECK(substring(id::text from 15 for 1)='7' AND length(request_key) BETWEEN 1 AND 300 AND generation>=0),
 CONSTRAINT order_fulfillment_command_lease_check CHECK((lease_token IS NULL)=(lease_expires_at IS NULL)),
 CONSTRAINT order_fulfillment_command_lines_check CHECK(jsonb_typeof(line_ids)='array' AND jsonb_array_length(line_ids) BETWEEN 1 AND 100),
 CONSTRAINT order_fulfillment_command_expiry_check CHECK(expires_at>created_at AND expires_at<=created_at+interval '7 days'),
 CONSTRAINT order_fulfillment_command_error_check CHECK(error_code IS NULL OR error_code IN ('conflict','source_unavailable','forbidden','unknown','superseded')),
 UNIQUE(tenant_id,id)
);
CREATE UNIQUE INDEX order_fulfillment_command_request_unique ON order_fulfillment_command_intents(tenant_id,created_by,request_id);
CREATE UNIQUE INDEX order_fulfillment_command_owner_key_unique ON order_fulfillment_command_intents(tenant_id,kind,target_id,request_key);
CREATE INDEX order_fulfillment_command_open_idx ON order_fulfillment_command_intents(tenant_id,created_by,order_id,acknowledged_at,created_at);
ALTER TABLE order_fulfillment_command_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_fulfillment_command_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY order_fulfillment_command_tenant ON order_fulfillment_command_intents
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT ON order_fulfillment_command_intents TO yummyai_app;
GRANT UPDATE(status,generation,lease_token,lease_expires_at,error_code,acknowledged_at,redacted_at,encrypted_input)
 ON order_fulfillment_command_intents TO yummyai_app;
--> statement-breakpoint
CREATE FUNCTION order_fulfillment_command_source_available(command order_fulfillment_command_intents)
RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM orders o LEFT JOIN order_protected_details p ON p.tenant_id=o.tenant_id AND p.order_id=o.id
 WHERE o.tenant_id=command.tenant_id AND o.id=command.order_id AND o.address_status<>'anonymized'
 AND ((o.address_status='missing' AND p.id IS NULL) OR (p.status='protected' AND p.retention_expires_at>clock_timestamp()))
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(command.line_ids) requested(id)
  LEFT JOIN order_lines l ON l.tenant_id=command.tenant_id AND l.order_id=command.order_id AND l.id=requested.id::uuid
  LEFT JOIN order_work_items w ON w.tenant_id=l.tenant_id AND w.id=l.id
  WHERE l.id IS NULL OR (w.id IS NOT NULL AND (w.encrypted_data_key IS NULL OR w.archived_at IS NOT NULL OR w.expires_at<=clock_timestamp()))))
$$;
CREATE FUNCTION guard_order_fulfillment_command() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.created_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid
   OR NEW.authority_snapshot->>'tenantId' IS DISTINCT FROM NEW.tenant_id::text
   OR NEW.authority_snapshot->>'userId' IS DISTINCT FROM NEW.created_by::text
   OR NEW.contract_version<>'fulfillment-command-v1' OR NEW.status<>'prepared' OR NEW.generation<>0
   OR NEW.lease_token IS NOT NULL OR NEW.encrypted_input IS NULL OR NEW.acknowledged_at IS NOT NULL
   OR NEW.redacted_at IS NOT NULL OR NOT order_fulfillment_command_source_available(NEW)
   OR (SELECT count(DISTINCT id) FROM jsonb_array_elements_text(NEW.line_ids) ids(id))<>jsonb_array_length(NEW.line_ids) THEN
   RAISE EXCEPTION 'fulfillment intent must bind original actor, retained source and immutable identity' USING ERRCODE='23514';
  END IF;
 ELSE
  IF (to_jsonb(OLD)-ARRAY['status','generation','lease_token','lease_expires_at','error_code','acknowledged_at','redacted_at','encrypted_input'])
   IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['status','generation','lease_token','lease_expires_at','error_code','acknowledged_at','redacted_at','encrypted_input'])
   OR (OLD.encrypted_input IS DISTINCT FROM NEW.encrypted_input AND NOT(OLD.encrypted_input IS NOT NULL AND NEW.encrypted_input IS NULL
    AND (NEW.acknowledged_at IS NOT NULL OR NEW.expires_at<=clock_timestamp() OR NOT order_fulfillment_command_source_available(NEW)
     OR (NEW.created_by=nullif(current_setting('app.user_id',true),'')::uuid AND NEW.status='expired' AND NEW.error_code='source_unavailable'))))
   OR NEW.generation<OLD.generation OR NEW.generation>OLD.generation+1
   OR (OLD.acknowledged_at IS NOT NULL AND NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at)
   OR (OLD.redacted_at IS NOT NULL AND NEW.redacted_at IS DISTINCT FROM OLD.redacted_at)
   OR (OLD.status IN ('cancelled','expired') AND NEW.status<>OLD.status) THEN
   RAISE EXCEPTION 'fulfillment original input and identity are immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.created_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid AND NOT(
   NEW.encrypted_input IS NULL AND NOT order_fulfillment_command_source_available(NEW)
   AND NEW.status IN ('uncertain','rejected','cancelled','expired') AND NEW.lease_token IS NULL
   AND NEW.acknowledged_at IS NOT DISTINCT FROM OLD.acknowledged_at) THEN
   RAISE EXCEPTION 'only original actor may recover fulfillment intent' USING ERRCODE='23514';
  END IF;
 END IF;
 IF NEW.status='executing' AND (NEW.encrypted_input IS NULL OR NEW.lease_token IS NULL OR NEW.generation<1
   OR NEW.acknowledged_at IS NOT NULL OR NEW.expires_at<=clock_timestamp() OR NOT order_fulfillment_command_source_available(NEW)) THEN
  RAISE EXCEPTION 'fulfillment execution requires retained original input and source' USING ERRCODE='23514';
 END IF;
 IF (NEW.status<>'executing' AND NEW.lease_token IS NOT NULL)
  OR (NEW.acknowledged_at IS NOT NULL AND NEW.encrypted_input IS NOT NULL) THEN
  RAISE EXCEPTION 'fulfillment lease and private-input lifecycle mismatch' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_original_order_fulfillment_command BEFORE INSERT OR UPDATE ON order_fulfillment_command_intents
 FOR EACH ROW EXECUTE FUNCTION guard_order_fulfillment_command();
--> statement-breakpoint
CREATE FUNCTION redact_unavailable_order_fulfillment_commands() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_order uuid;
BEGIN
 IF TG_TABLE_NAME='orders' THEN source_order:=NEW.id;
 ELSIF TG_TABLE_NAME='order_protected_details' THEN source_order:=NEW.order_id;
 ELSE SELECT order_id INTO source_order FROM order_lines WHERE tenant_id=NEW.tenant_id AND id=NEW.id;
 END IF;
 UPDATE order_fulfillment_command_intents c SET encrypted_input=NULL,redacted_at=coalesce(c.redacted_at,clock_timestamp()),
  lease_token=NULL,lease_expires_at=NULL,status=CASE WHEN c.status IN ('prepared','executing','uncertain') THEN 'expired' ELSE c.status END,
  error_code='source_unavailable'
 WHERE c.tenant_id=NEW.tenant_id AND c.order_id=source_order AND c.encrypted_input IS NOT NULL
  AND NOT order_fulfillment_command_source_available(c);
 RETURN NEW;
END $$;
CREATE TRIGGER redact_order_fulfillment_on_order AFTER UPDATE OF address_status ON orders
 FOR EACH ROW EXECUTE FUNCTION redact_unavailable_order_fulfillment_commands();
CREATE TRIGGER redact_order_fulfillment_on_privacy AFTER UPDATE OF status,retention_expires_at ON order_protected_details
 FOR EACH ROW EXECUTE FUNCTION redact_unavailable_order_fulfillment_commands();
CREATE TRIGGER redact_order_fulfillment_on_work AFTER UPDATE OF encrypted_data_key,archived_at,expires_at ON order_work_items
 FOR EACH ROW EXECUTE FUNCTION redact_unavailable_order_fulfillment_commands();
