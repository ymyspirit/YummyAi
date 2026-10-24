-- New durable inputs do not infer or modify any historical procurement fact.
CREATE UNIQUE INDEX procurement_write_tenant_id_unique ON inventory_procurement_write_requests(tenant_id,id);
CREATE TABLE inventory_procurement_commands (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), created_by uuid NOT NULL REFERENCES app_users(id),
 kind text NOT NULL, operation text NOT NULL, target_id uuid,
 request_key text NOT NULL, request_checksum text NOT NULL, authority_snapshot jsonb NOT NULL, encrypted_input text,
 contract_version text NOT NULL DEFAULT 'procurement-command-v1', status text NOT NULL DEFAULT 'prepared', result_proof_id uuid, error_code text,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 completed_at timestamptz, acknowledged_at timestamptz, redacted_at timestamptz,
 CONSTRAINT procurement_command_proof_fk FOREIGN KEY(tenant_id,result_proof_id) REFERENCES inventory_procurement_write_requests(tenant_id,id) ON DELETE RESTRICT,
 CONSTRAINT procurement_commands_identity CHECK(substring(id::text from 15 for 1)='7' AND request_checksum~'^[a-f0-9]{64}$' AND length(request_key) BETWEEN 8 AND 200 AND contract_version='procurement-command-v1'),
 CONSTRAINT procurement_commands_kind CHECK(kind IN ('requisition_create','rfq_create','quote_record','purchase_create','supply_purchase_create','purchase_revise','purchase_review')
  AND operation=CASE WHEN kind='supply_purchase_create' THEN 'purchase_create' ELSE kind END
  AND ((kind IN ('requisition_create','purchase_create'))=(target_id IS NULL)) AND (target_id IS NULL OR substring(target_id::text from 15 for 1)='7')),
 CONSTRAINT procurement_commands_status CHECK(status IN ('prepared','succeeded','cancelled','expired')),
 CONSTRAINT procurement_commands_result CHECK((status='succeeded')=(result_proof_id IS NOT NULL) AND (status='prepared')=(completed_at IS NULL)),
 CONSTRAINT procurement_commands_privacy CHECK((encrypted_input IS NULL)=(redacted_at IS NOT NULL) AND (status<>'prepared' OR encrypted_input IS NOT NULL)
  AND (status NOT IN ('cancelled','expired') OR encrypted_input IS NULL) AND (acknowledged_at IS NULL OR status<>'prepared' AND encrypted_input IS NULL)),
 CONSTRAINT procurement_commands_authority CHECK((jsonb_typeof(authority_snapshot)='object' AND authority_snapshot->>'tenantId'=tenant_id::text AND authority_snapshot->>'userId'=created_by::text) IS TRUE),
 CONSTRAINT procurement_commands_time CHECK(expires_at>created_at AND (completed_at IS NULL OR completed_at>=created_at) AND (acknowledged_at IS NULL OR acknowledged_at>=completed_at)),
 CONSTRAINT procurement_commands_error CHECK(error_code IS NULL),
 CONSTRAINT procurement_commands_input_size CHECK(encrypted_input IS NULL OR length(encrypted_input) BETWEEN 1 AND 1048576)
);
CREATE UNIQUE INDEX procurement_commands_scope ON inventory_procurement_commands(tenant_id,id);
CREATE UNIQUE INDEX procurement_commands_key ON inventory_procurement_commands(tenant_id,operation,request_key);
CREATE UNIQUE INDEX procurement_commands_unacknowledged ON inventory_procurement_commands(tenant_id,kind,created_by,coalesce(target_id,'00000000-0000-0000-0000-000000000000'::uuid)) WHERE acknowledged_at IS NULL;
CREATE INDEX procurement_commands_retention ON inventory_procurement_commands(tenant_id,expires_at) WHERE encrypted_input IS NOT NULL;
ALTER TABLE inventory_procurement_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_procurement_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY procurement_commands_tenant ON inventory_procurement_commands
 USING(tenant_id=current_setting('app.tenant_id',true)::uuid) WITH CHECK(tenant_id=current_setting('app.tenant_id',true)::uuid);
GRANT SELECT,INSERT,UPDATE ON inventory_procurement_commands TO yummyai_app;
--> statement-breakpoint
CREATE FUNCTION procurement_command_fact_matches(c inventory_procurement_commands) RETURNS boolean LANGUAGE sql AS $$
 SELECT EXISTS(SELECT 1 FROM inventory_procurement_write_requests p WHERE p.tenant_id=c.tenant_id AND p.id=c.result_proof_id
  AND p.operation=c.operation AND p.target_id IS NOT DISTINCT FROM c.target_id AND p.created_by=c.created_by
  AND p.idempotency_key=c.request_key AND p.request_checksum=c.request_checksum)
$$;
REVOKE ALL ON FUNCTION procurement_command_fact_matches(inventory_procurement_commands) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION procurement_command_fact_matches(inventory_procurement_commands) TO yummyai_app;

CREATE FUNCTION guard_procurement_command() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE maintenance boolean; xid_text text:=mod(pg_current_xact_id()::text::numeric,4294967296)::bigint::text;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'procurement command evidence is immutable' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('procurement-original:'||NEW.tenant_id::text||':'||NEW.operation||':'||NEW.request_key,0));
  IF current_setting('app.user_id',true) IS DISTINCT FROM NEW.created_by::text OR NEW.status<>'prepared' OR NEW.result_proof_id IS NOT NULL
   OR NEW.completed_at IS NOT NULL OR NEW.acknowledged_at IS NOT NULL OR NEW.redacted_at IS NOT NULL OR NEW.encrypted_input IS NULL THEN
   RAISE EXCEPTION 'procurement command requires its actual actor and original preparation' USING ERRCODE='23514';
  END IF;
  NEW.created_at:=clock_timestamp(); NEW.expires_at:=NEW.created_at+interval '7 days';
  IF EXISTS(SELECT 1 FROM inventory_procurement_write_requests WHERE tenant_id=NEW.tenant_id AND operation=NEW.operation AND idempotency_key=NEW.request_key) THEN
   RAISE EXCEPTION 'an existing actual procurement cannot become a new prepared command' USING ERRCODE='23514';
  END IF;
  IF NEW.kind='rfq_create' AND NOT EXISTS(SELECT 1 FROM inventory_procurement_requisitions WHERE tenant_id=NEW.tenant_id AND id=NEW.target_id)
   OR NEW.kind='quote_record' AND NOT EXISTS(SELECT 1 FROM inventory_procurement_rfqs WHERE tenant_id=NEW.tenant_id AND id=NEW.target_id)
   OR NEW.kind IN ('purchase_revise','purchase_review') AND NOT EXISTS(SELECT 1 FROM inventory_purchase_orders WHERE tenant_id=NEW.tenant_id AND id=NEW.target_id)
   OR NEW.kind='supply_purchase_create' AND NOT EXISTS(SELECT 1 FROM product_supply_links WHERE tenant_id=NEW.tenant_id AND id=NEW.target_id) THEN
   RAISE EXCEPTION 'original procurement target missing' USING ERRCODE='23514';
  END IF;
 END IF;
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(OLD)-ARRAY['status','result_proof_id','encrypted_input','completed_at','acknowledged_at','redacted_at']) IS DISTINCT FROM
    (to_jsonb(NEW)-ARRAY['status','result_proof_id','encrypted_input','completed_at','acknowledged_at','redacted_at'])
   OR OLD.status<>'prepared' AND (OLD.status,OLD.result_proof_id,OLD.completed_at) IS DISTINCT FROM (NEW.status,NEW.result_proof_id,NEW.completed_at)
   OR OLD.encrypted_input IS NULL AND NEW.encrypted_input IS NOT NULL
   OR OLD.encrypted_input IS NOT NULL AND NEW.encrypted_input IS NOT NULL AND OLD.encrypted_input<>NEW.encrypted_input
   OR OLD.acknowledged_at IS NOT NULL AND OLD.acknowledged_at IS DISTINCT FROM NEW.acknowledged_at
   OR OLD.redacted_at IS NOT NULL AND OLD.redacted_at IS DISTINCT FROM NEW.redacted_at THEN
   RAISE EXCEPTION 'procurement original and outcome are immutable' USING ERRCODE='23514';
  END IF;
  maintenance:=OLD.expires_at<=clock_timestamp() AND OLD.encrypted_input IS NOT NULL AND NEW.encrypted_input IS NULL AND NEW.redacted_at IS NOT NULL
   AND NEW.acknowledged_at IS NOT DISTINCT FROM OLD.acknowledged_at AND NEW.status=CASE WHEN OLD.status='prepared' THEN 'expired' ELSE OLD.status END;
  IF current_setting('app.user_id',true) IS DISTINCT FROM OLD.created_by::text AND NOT maintenance THEN
   RAISE EXCEPTION 'procurement command belongs to its actual original actor' USING ERRCODE='23514';
  END IF;
  IF NEW.status='expired' AND OLD.status='prepared' AND OLD.expires_at>clock_timestamp() OR NEW.status='succeeded' AND OLD.status='prepared'
   AND (OLD.expires_at<=clock_timestamp() OR current_setting('app.procurement_command_id',true) IS DISTINCT FROM OLD.id::text
    OR NOT EXISTS(SELECT 1 FROM inventory_procurement_write_requests p WHERE p.tenant_id=NEW.tenant_id AND p.id=NEW.result_proof_id AND p.xmin::text=xid_text)) THEN
   RAISE EXCEPTION 'procurement command is not admitted to its actual transaction' USING ERRCODE='23514';
  END IF;
 END IF;
 IF NEW.status='succeeded' AND NOT procurement_command_fact_matches(NEW) THEN
  RAISE EXCEPTION 'procurement command success requires its actual original fact' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_procurement_command() FROM PUBLIC;
CREATE TRIGGER procurement_commands_guard BEFORE INSERT OR UPDATE OR DELETE ON inventory_procurement_commands FOR EACH ROW EXECUTE FUNCTION guard_procurement_command();
--> statement-breakpoint
CREATE FUNCTION admit_prepared_procurement_fact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE command inventory_procurement_commands%ROWTYPE;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('procurement-original:'||NEW.tenant_id::text||':'||NEW.operation||':'||NEW.idempotency_key,0));
 SELECT * INTO command FROM inventory_procurement_commands WHERE tenant_id=NEW.tenant_id AND operation=NEW.operation AND request_key=NEW.idempotency_key FOR UPDATE;
 IF command.id IS NOT NULL AND (command.status<>'prepared' OR command.expires_at<=clock_timestamp()
  OR current_setting('app.procurement_command_id',true) IS DISTINCT FROM command.id::text OR command.created_by<>NEW.created_by
  OR command.request_checksum<>NEW.request_checksum OR command.target_id IS DISTINCT FROM NEW.target_id) THEN
  RAISE EXCEPTION 'prepared procurement must execute through its actual original command' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION admit_prepared_procurement_fact() FROM PUBLIC;
CREATE TRIGGER procurement_write_command_admission BEFORE INSERT ON inventory_procurement_write_requests FOR EACH ROW EXECUTE FUNCTION admit_prepared_procurement_fact();
--> statement-breakpoint
-- A prepared command's business fact cannot commit while its actual outcome is
-- still unknown. This reverse constraint also checks late insertion of a command.
CREATE FUNCTION require_procurement_command_outcome() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE command inventory_procurement_commands%ROWTYPE;
 xid_text text:=mod(pg_current_xact_id()::text::numeric,4294967296)::bigint::text;
BEGIN
 SELECT * INTO command FROM inventory_procurement_commands WHERE tenant_id=NEW.tenant_id AND operation=NEW.operation AND request_key=NEW.idempotency_key;
 IF command.id IS NOT NULL AND (command.status<>'succeeded' OR command.result_proof_id IS DISTINCT FROM NEW.id
  OR command.created_by<>NEW.created_by OR command.target_id IS DISTINCT FROM NEW.target_id OR command.request_checksum<>NEW.request_checksum
  OR NOT EXISTS(SELECT 1 FROM inventory_procurement_commands c WHERE c.tenant_id=command.tenant_id AND c.id=command.id AND c.xmin::text=xid_text)) THEN
  RAISE EXCEPTION 'procurement fact and actual command outcome must commit together' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION require_procurement_command_outcome() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER procurement_command_outcome_required AFTER INSERT ON inventory_procurement_write_requests
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_procurement_command_outcome();
