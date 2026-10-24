-- Durable, tenant-private originals for bounded database operations. No queues.
CREATE TABLE inventory_incoming_commands (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), created_by uuid NOT NULL REFERENCES app_users(id),
 kind text NOT NULL, target_id uuid NOT NULL, posting_id uuid,
 request_key text NOT NULL, request_checksum text NOT NULL, authority_snapshot jsonb NOT NULL, encrypted_input text,
 contract_version text NOT NULL DEFAULT 'incoming-command-v1', status text NOT NULL DEFAULT 'prepared', result_id uuid, error_code text,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 completed_at timestamptz, acknowledged_at timestamptz, redacted_at timestamptz,
 CONSTRAINT incoming_commands_scope UNIQUE(tenant_id,id),
 CONSTRAINT incoming_commands_key UNIQUE(tenant_id,kind,request_key),
 CONSTRAINT incoming_commands_identity CHECK(substring(id::text from 15 for 1)='7' AND request_checksum~'^[a-f0-9]{64}$' AND length(request_key) BETWEEN 8 AND 200 AND contract_version='incoming-command-v1'),
 CONSTRAINT incoming_commands_kind CHECK(kind IN ('publish_standard','record_arrival','record_inspection','review_inspection','post_inspection','return_rejected') AND (kind='return_rejected')=(posting_id IS NOT NULL)),
 CONSTRAINT incoming_commands_status CHECK(status IN ('prepared','succeeded','rejected','cancelled','expired')),
 CONSTRAINT incoming_commands_result CHECK((status='succeeded')=(result_id IS NOT NULL) AND (status='prepared')=(completed_at IS NULL)),
 CONSTRAINT incoming_commands_privacy CHECK((encrypted_input IS NULL)=(redacted_at IS NOT NULL) AND (status<>'prepared' OR encrypted_input IS NOT NULL) AND (status NOT IN ('cancelled','expired') OR encrypted_input IS NULL) AND (acknowledged_at IS NULL OR status<>'prepared' AND encrypted_input IS NULL)),
 CONSTRAINT incoming_commands_authority CHECK(jsonb_typeof(authority_snapshot)='object' AND authority_snapshot ?& ARRAY['tenantId','userId','permissions'] AND authority_snapshot->>'tenantId'=tenant_id::text AND authority_snapshot->>'userId'=created_by::text AND jsonb_typeof(authority_snapshot->'permissions')='array'),
 CONSTRAINT incoming_commands_time CHECK(expires_at>created_at AND (completed_at IS NULL OR completed_at>=created_at) AND (acknowledged_at IS NULL OR acknowledged_at>=completed_at)),
 CONSTRAINT incoming_commands_error CHECK((status='rejected')=(error_code IS NOT NULL) AND (error_code IS NULL OR error_code='input_unavailable'))
);
CREATE UNIQUE INDEX incoming_commands_unacknowledged ON inventory_incoming_commands(tenant_id,kind,target_id,created_by) WHERE acknowledged_at IS NULL;
CREATE INDEX incoming_commands_retention ON inventory_incoming_commands(tenant_id,expires_at) WHERE encrypted_input IS NOT NULL;
ALTER TABLE inventory_incoming_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_incoming_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY incoming_commands_tenant ON inventory_incoming_commands
 USING(tenant_id=current_setting('app.tenant_id',true)::uuid) WITH CHECK(tenant_id=current_setting('app.tenant_id',true)::uuid);
GRANT SELECT,INSERT,UPDATE ON inventory_incoming_commands TO yummyai_app;
--> statement-breakpoint
CREATE FUNCTION incoming_command_fact_matches(c inventory_incoming_commands) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE table_name text; fact jsonb; parent_id uuid;
BEGIN
 table_name:=CASE c.kind WHEN 'publish_standard' THEN 'inventory_incoming_standards' WHEN 'record_arrival' THEN 'inventory_procurement_arrivals'
  WHEN 'record_inspection' THEN 'inventory_incoming_inspections' WHEN 'review_inspection' THEN 'inventory_incoming_inspection_reviews'
  WHEN 'post_inspection' THEN 'inventory_incoming_postings' WHEN 'return_rejected' THEN 'inventory_incoming_returns' END;
 IF table_name IS NULL OR c.result_id IS NULL THEN RETURN false; END IF;
 EXECUTE format('SELECT to_jsonb(f) FROM %I f WHERE tenant_id=$1 AND id=$2',table_name) INTO fact USING c.tenant_id,c.result_id;
 IF fact IS NULL OR fact->>'created_by'<>c.created_by::text OR fact->>'idempotency_key'<>c.request_key OR fact->>'request_checksum'<>c.request_checksum THEN RETURN false; END IF;
 IF c.kind='publish_standard' THEN parent_id:=(fact->>'stock_item_id')::uuid;
 ELSIF c.kind='record_arrival' THEN parent_id:=(fact->>'purchase_order_id')::uuid;
 ELSIF c.kind='review_inspection' THEN
  SELECT arrival_line_id INTO parent_id FROM inventory_incoming_inspections WHERE tenant_id=c.tenant_id AND id=(fact->>'inspection_id')::uuid;
 ELSIF c.kind='return_rejected' THEN
  IF (fact->>'posting_id')::uuid<>c.posting_id THEN RETURN false; END IF;
  SELECT arrival_line_id INTO parent_id FROM inventory_incoming_postings WHERE tenant_id=c.tenant_id AND id=c.posting_id;
 ELSE parent_id:=(fact->>'arrival_line_id')::uuid; END IF;
 RETURN parent_id IS NOT DISTINCT FROM c.target_id;
END $$;
REVOKE ALL ON FUNCTION incoming_command_fact_matches(inventory_incoming_commands) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION incoming_command_fact_matches(inventory_incoming_commands) TO yummyai_app;
--> statement-breakpoint
CREATE FUNCTION guard_incoming_command() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE maintenance boolean;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'incoming command evidence is immutable' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  IF current_setting('app.user_id',true) IS DISTINCT FROM NEW.created_by::text OR NEW.status<>'prepared' OR NEW.acknowledged_at IS NOT NULL OR NEW.redacted_at IS NOT NULL THEN
   RAISE EXCEPTION 'incoming command requires its actual original actor and preparation' USING ERRCODE='23514';
  END IF;
  -- Database authority fixes both clocks; the caller cannot extend retention.
  NEW.created_at:=clock_timestamp(); NEW.expires_at:=NEW.created_at+interval '7 days';
  IF NEW.kind='publish_standard' THEN
   IF NOT EXISTS(SELECT 1 FROM inventory_stock_items WHERE tenant_id=NEW.tenant_id AND id=NEW.target_id) THEN RAISE EXCEPTION 'original stock target missing' USING ERRCODE='23514'; END IF;
  ELSIF NEW.kind='record_arrival' THEN
   IF NOT EXISTS(SELECT 1 FROM inventory_purchase_orders WHERE tenant_id=NEW.tenant_id AND id=NEW.target_id) THEN RAISE EXCEPTION 'original purchase target missing' USING ERRCODE='23514'; END IF;
  ELSIF NOT EXISTS(SELECT 1 FROM inventory_procurement_arrival_lines WHERE tenant_id=NEW.tenant_id AND id=NEW.target_id) THEN
   RAISE EXCEPTION 'original arrival target missing' USING ERRCODE='23514';
  END IF;
  IF NEW.kind='return_rejected' AND NOT EXISTS(SELECT 1 FROM inventory_incoming_postings WHERE tenant_id=NEW.tenant_id AND id=NEW.posting_id AND arrival_line_id=NEW.target_id) THEN
   RAISE EXCEPTION 'original return target missing' USING ERRCODE='23514';
  END IF;
 END IF;
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(OLD)-ARRAY['status','result_id','error_code','encrypted_input','completed_at','acknowledged_at','redacted_at']) IS DISTINCT FROM
     (to_jsonb(NEW)-ARRAY['status','result_id','error_code','encrypted_input','completed_at','acknowledged_at','redacted_at'])
    OR OLD.status<>'prepared' AND (OLD.status,OLD.result_id,OLD.error_code,OLD.completed_at) IS DISTINCT FROM (NEW.status,NEW.result_id,NEW.error_code,NEW.completed_at)
    OR OLD.encrypted_input IS NULL AND NEW.encrypted_input IS NOT NULL
    OR OLD.encrypted_input IS NOT NULL AND NEW.encrypted_input IS NOT NULL AND OLD.encrypted_input<>NEW.encrypted_input
    OR OLD.acknowledged_at IS NOT NULL AND OLD.acknowledged_at IS DISTINCT FROM NEW.acknowledged_at
    OR OLD.redacted_at IS NOT NULL AND OLD.redacted_at IS DISTINCT FROM NEW.redacted_at THEN
   RAISE EXCEPTION 'incoming command original and outcome are immutable' USING ERRCODE='23514';
  END IF;
  maintenance:=OLD.expires_at<=clock_timestamp() AND OLD.encrypted_input IS NOT NULL AND NEW.encrypted_input IS NULL
    AND NEW.redacted_at IS NOT NULL AND NEW.acknowledged_at IS NOT DISTINCT FROM OLD.acknowledged_at
    AND NEW.status=CASE WHEN OLD.status='prepared' THEN 'expired' ELSE OLD.status END;
  IF current_setting('app.user_id',true) IS DISTINCT FROM OLD.created_by::text AND NOT maintenance THEN
   RAISE EXCEPTION 'incoming command belongs to its original actor' USING ERRCODE='23514';
  END IF;
  IF NEW.status='expired' AND OLD.status='prepared' AND OLD.expires_at>clock_timestamp() OR
    NEW.status='succeeded' AND OLD.status='prepared' AND (OLD.expires_at<=clock_timestamp() OR current_setting('app.incoming_command_id',true) IS DISTINCT FROM OLD.id::text) THEN
   RAISE EXCEPTION 'incoming command is not admitted for execution' USING ERRCODE='23514';
  END IF;
 END IF;
 IF NEW.status='succeeded' AND NOT incoming_command_fact_matches(NEW) THEN
  RAISE EXCEPTION 'incoming command success requires its actual original fact' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_incoming_command() FROM PUBLIC;
CREATE TRIGGER original_incoming_command BEFORE INSERT OR UPDATE OR DELETE ON inventory_incoming_commands FOR EACH ROW EXECUTE FUNCTION guard_incoming_command();
--> statement-breakpoint
CREATE FUNCTION enforce_incoming_command_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c inventory_incoming_commands;
BEGIN
 SELECT * INTO c FROM inventory_incoming_commands WHERE tenant_id=NEW.tenant_id AND kind=TG_ARGV[0] AND request_key=NEW.idempotency_key;
 IF c.id IS NOT NULL THEN
  IF c.status<>'prepared' OR c.created_by<>NEW.created_by OR c.request_checksum<>NEW.request_checksum OR c.expires_at<=clock_timestamp()
    OR current_setting('app.incoming_command_id',true) IS DISTINCT FROM c.id::text THEN
   RAISE EXCEPTION 'incoming fact requires the original admitted command' USING ERRCODE='23514';
  END IF;
  -- The deferred outcome verifies the actual parent as well as checksum and actor.
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION require_atomic_incoming_command_outcome() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c inventory_incoming_commands;
BEGIN
 SELECT * INTO c FROM inventory_incoming_commands WHERE tenant_id=NEW.tenant_id AND kind=TG_ARGV[0] AND request_key=NEW.idempotency_key;
 IF c.id IS NOT NULL AND (c.status<>'succeeded' OR c.result_id IS DISTINCT FROM NEW.id OR NOT incoming_command_fact_matches(c)) THEN
  RAISE EXCEPTION 'incoming command and its actual fact must commit together' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION enforce_incoming_command_admission() FROM PUBLIC;
REVOKE ALL ON FUNCTION require_atomic_incoming_command_outcome() FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE item record;
BEGIN
 FOR item IN SELECT * FROM (VALUES
  ('inventory_incoming_standards','publish_standard'),('inventory_procurement_arrivals','record_arrival'),
  ('inventory_incoming_inspections','record_inspection'),('inventory_incoming_inspection_reviews','review_inspection'),
  ('inventory_incoming_postings','post_inspection'),('inventory_incoming_returns','return_rejected')) AS v(table_name,kind)
 LOOP
  EXECUTE format('CREATE TRIGGER incoming_command_admission BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION enforce_incoming_command_admission(%L)',item.table_name,item.kind);
  EXECUTE format('CREATE CONSTRAINT TRIGGER atomic_incoming_command_outcome AFTER INSERT ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_atomic_incoming_command_outcome(%L)',item.table_name,item.kind);
 END LOOP;
END $$;
