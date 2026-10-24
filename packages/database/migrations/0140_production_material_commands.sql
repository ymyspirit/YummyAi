CREATE TABLE production_material_commands (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), production_order_id uuid NOT NULL, binding_id uuid NOT NULL,
 created_by uuid NOT NULL REFERENCES app_users(id), request_key text NOT NULL, request_checksum text NOT NULL,
 authority_snapshot jsonb NOT NULL, encrypted_input text, contract_version text NOT NULL DEFAULT 'material-command-v1',
 status text NOT NULL DEFAULT 'prepared', entry_id uuid, error_code text,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, completed_at timestamptz, acknowledged_at timestamptz, redacted_at timestamptz,
 CONSTRAINT production_material_commands_scope UNIQUE(tenant_id,id),
 CONSTRAINT production_material_commands_key UNIQUE(tenant_id,production_order_id,request_key),
 FOREIGN KEY(tenant_id,binding_id,production_order_id) REFERENCES production_manufacturing_bindings(tenant_id,id,production_order_id),
 FOREIGN KEY(tenant_id,entry_id) REFERENCES production_material_entries(tenant_id,id),
 CONSTRAINT production_material_commands_identity CHECK(substring(id::text from 15 for 1)='7' AND request_checksum~'^[a-f0-9]{64}$' AND length(request_key) BETWEEN 8 AND 200 AND contract_version='material-command-v1'),
 CONSTRAINT production_material_commands_status CHECK(status IN ('prepared','succeeded','rejected','cancelled','expired')),
 CONSTRAINT production_material_commands_result CHECK((status='succeeded')=(entry_id IS NOT NULL) AND (status='prepared')=(completed_at IS NULL)),
 CONSTRAINT production_material_commands_privacy CHECK((encrypted_input IS NULL)=(redacted_at IS NOT NULL) AND (status<>'prepared' OR encrypted_input IS NOT NULL) AND (status NOT IN ('cancelled','expired') OR encrypted_input IS NULL) AND (acknowledged_at IS NULL OR status<>'prepared' AND encrypted_input IS NULL)),
 CONSTRAINT production_material_commands_authority CHECK(jsonb_typeof(authority_snapshot)='object' AND authority_snapshot ?& ARRAY['tenantId','userId','permissions'] AND authority_snapshot->>'tenantId'=tenant_id::text AND authority_snapshot->>'userId'=created_by::text AND jsonb_typeof(authority_snapshot->'permissions')='array'),
 CONSTRAINT production_material_commands_time CHECK(expires_at>created_at),
 CONSTRAINT production_material_commands_error CHECK(error_code IS NULL OR error_code IN ('basis_changed','input_unavailable'))
);
CREATE UNIQUE INDEX production_material_commands_unacknowledged ON production_material_commands(tenant_id,production_order_id,created_by) WHERE acknowledged_at IS NULL;
CREATE INDEX production_material_commands_retention ON production_material_commands(tenant_id,expires_at) WHERE encrypted_input IS NOT NULL;
ALTER TABLE production_material_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_material_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY production_material_commands_tenant ON production_material_commands
 USING(tenant_id=current_setting('app.tenant_id',true)::uuid) WITH CHECK(tenant_id=current_setting('app.tenant_id',true)::uuid);
GRANT SELECT,INSERT,UPDATE ON production_material_commands TO yummyai_app;
--> statement-breakpoint
CREATE FUNCTION guard_production_material_command() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e production_material_entries;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'material command evidence is immutable' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' AND current_setting('app.user_id',true) IS DISTINCT FROM NEW.created_by::text THEN
  RAISE EXCEPTION 'material command requires its actual original actor' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(OLD)-ARRAY['status','entry_id','error_code','encrypted_input','completed_at','acknowledged_at','redacted_at']) IS DISTINCT FROM
     (to_jsonb(NEW)-ARRAY['status','entry_id','error_code','encrypted_input','completed_at','acknowledged_at','redacted_at'])
    OR OLD.status<>'prepared' AND (OLD.status,OLD.entry_id,OLD.error_code,OLD.completed_at) IS DISTINCT FROM (NEW.status,NEW.entry_id,NEW.error_code,NEW.completed_at)
    OR OLD.encrypted_input IS NULL AND NEW.encrypted_input IS NOT NULL
    OR OLD.encrypted_input IS NOT NULL AND NEW.encrypted_input IS NOT NULL AND OLD.encrypted_input<>NEW.encrypted_input
    OR OLD.acknowledged_at IS NOT NULL AND OLD.acknowledged_at IS DISTINCT FROM NEW.acknowledged_at
    OR OLD.redacted_at IS NOT NULL AND OLD.redacted_at IS DISTINCT FROM NEW.redacted_at THEN
   RAISE EXCEPTION 'material command original input and outcome are immutable' USING ERRCODE='23514';
  END IF;
 END IF;
 IF NEW.status='succeeded' THEN
  SELECT * INTO e FROM production_material_entries WHERE tenant_id=NEW.tenant_id AND id=NEW.entry_id;
  IF e.id IS NULL OR e.production_order_id<>NEW.production_order_id OR e.binding_id<>NEW.binding_id OR e.created_by<>NEW.created_by
    OR e.idempotency_key<>NEW.request_key OR e.request_checksum<>NEW.request_checksum THEN
   RAISE EXCEPTION 'material command success requires its original committed fact' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER original_material_command BEFORE INSERT OR UPDATE OR DELETE ON production_material_commands FOR EACH ROW EXECUTE FUNCTION guard_production_material_command();
--> statement-breakpoint
CREATE FUNCTION enforce_material_command_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c production_material_commands;
BEGIN
 SELECT * INTO c FROM production_material_commands WHERE tenant_id=NEW.tenant_id AND production_order_id=NEW.production_order_id AND request_key=NEW.idempotency_key;
 IF c.id IS NOT NULL AND (c.status<>'prepared' OR c.created_by<>NEW.created_by OR c.request_checksum<>NEW.request_checksum OR c.binding_id<>NEW.binding_id
   OR c.expires_at<=clock_timestamp() OR current_setting('app.material_command_id',true) IS DISTINCT FROM c.id::text) THEN
  RAISE EXCEPTION 'material entry requires the original admitted command' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER material_command_admission BEFORE INSERT ON production_material_entries FOR EACH ROW EXECUTE FUNCTION enforce_material_command_admission();
--> statement-breakpoint
CREATE FUNCTION require_atomic_material_command_outcome() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c production_material_commands;
BEGIN
 SELECT * INTO c FROM production_material_commands WHERE tenant_id=NEW.tenant_id AND production_order_id=NEW.production_order_id AND request_key=NEW.idempotency_key;
 IF c.id IS NOT NULL AND (c.status<>'succeeded' OR c.entry_id IS DISTINCT FROM NEW.id) THEN
  RAISE EXCEPTION 'material command and its actual fact must commit together' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER atomic_material_command_outcome AFTER INSERT ON production_material_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_atomic_material_command_outcome();
