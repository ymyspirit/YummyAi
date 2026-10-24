-- Confirmed capacity is new data. Existing factory references and production
-- history are deliberately not converted into bookings or owner proofs.
CREATE TABLE factory_capacity_pools (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES organizations(id),factory_id uuid NOT NULL,factory_version_id uuid NOT NULL,
 code text NOT NULL,time_zone text NOT NULL,unit text NOT NULL,current_version_number integer NOT NULL,
 created_by uuid NOT NULL REFERENCES app_users(id),created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT factory_capacity_pool_factory_fk FOREIGN KEY(tenant_id,factory_id) REFERENCES fulfillment_factories(tenant_id,id),
 CONSTRAINT factory_capacity_pool_factory_version_fk FOREIGN KEY(tenant_id,factory_id,factory_version_id) REFERENCES fulfillment_factory_versions(tenant_id,factory_id,id),
 CONSTRAINT factory_capacity_pool_base CHECK(unit IN('each','minute') AND current_version_number>0)
);
CREATE UNIQUE INDEX factory_capacity_pools_scope ON factory_capacity_pools(tenant_id,id);
CREATE UNIQUE INDEX factory_capacity_pools_parent ON factory_capacity_pools(tenant_id,factory_id,id);
CREATE UNIQUE INDEX factory_capacity_pools_code ON factory_capacity_pools(tenant_id,factory_id,code);
CREATE TABLE factory_capacity_versions (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES organizations(id),factory_id uuid NOT NULL,pool_id uuid NOT NULL,version_number integer NOT NULL,
 profile jsonb NOT NULL,idempotency_key uuid NOT NULL,request_checksum text NOT NULL,created_by uuid NOT NULL REFERENCES app_users(id),created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT factory_capacity_version_pool_fk FOREIGN KEY(tenant_id,factory_id,pool_id) REFERENCES factory_capacity_pools(tenant_id,factory_id,id),
 CONSTRAINT factory_capacity_version_fields CHECK(version_number>0 AND request_checksum~'^[a-f0-9]{64}$' AND jsonb_typeof(profile)='object')
);
CREATE UNIQUE INDEX factory_capacity_versions_scope ON factory_capacity_versions(tenant_id,id);
CREATE UNIQUE INDEX factory_capacity_versions_parent ON factory_capacity_versions(tenant_id,pool_id,id);
CREATE UNIQUE INDEX factory_capacity_versions_number ON factory_capacity_versions(tenant_id,pool_id,version_number);
CREATE UNIQUE INDEX factory_capacity_versions_request ON factory_capacity_versions(tenant_id,idempotency_key);
CREATE TABLE factory_capacity_reservations (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES organizations(id),factory_id uuid NOT NULL,pool_id uuid NOT NULL,pool_version_id uuid NOT NULL,
 production_order_id uuid NOT NULL,production_version_id uuid NOT NULL,capability_version_id uuid NOT NULL,local_date date NOT NULL,time_zone text NOT NULL,unit text NOT NULL,
 quantity integer NOT NULL,units_per_item integer NOT NULL,total_units bigint NOT NULL,work_starts_at timestamptz NOT NULL,work_ends_at timestamptz NOT NULL,
 creation_transaction_id text NOT NULL DEFAULT pg_current_xact_id()::text,created_by uuid NOT NULL REFERENCES app_users(id),created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT factory_capacity_reservation_pool_fk FOREIGN KEY(tenant_id,factory_id,pool_id) REFERENCES factory_capacity_pools(tenant_id,factory_id,id),
 CONSTRAINT factory_capacity_reservation_version_fk FOREIGN KEY(tenant_id,pool_id,pool_version_id) REFERENCES factory_capacity_versions(tenant_id,pool_id,id),
 CONSTRAINT factory_capacity_reservation_production_fk FOREIGN KEY(tenant_id,production_order_id) REFERENCES production_orders(tenant_id,id),
 CONSTRAINT factory_capacity_reservation_production_version_fk FOREIGN KEY(tenant_id,production_version_id,production_order_id,quantity) REFERENCES production_order_versions(tenant_id,id,production_order_id,quantity),
 CONSTRAINT factory_capacity_reservation_capability_fk FOREIGN KEY(tenant_id,factory_id,capability_version_id) REFERENCES factory_capability_versions(tenant_id,factory_id,id),
 CONSTRAINT factory_capacity_reservation_amount CHECK(quantity BETWEEN 1 AND 100000 AND units_per_item BETWEEN 1 AND 1000000 AND total_units=quantity::bigint*units_per_item AND total_units BETWEEN 1 AND 1000000000),
 CONSTRAINT factory_capacity_reservation_time CHECK(work_ends_at>work_starts_at)
);
CREATE UNIQUE INDEX factory_capacity_reservations_scope ON factory_capacity_reservations(tenant_id,id);
CREATE UNIQUE INDEX factory_capacity_reservations_production_pool ON factory_capacity_reservations(tenant_id,production_version_id,pool_id);
CREATE INDEX factory_capacity_reservations_day ON factory_capacity_reservations(tenant_id,pool_id,local_date);
CREATE INDEX factory_capacity_reservations_production ON factory_capacity_reservations(tenant_id,production_order_id);
CREATE TABLE factory_capacity_events (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES organizations(id),reservation_id uuid NOT NULL,sequence integer NOT NULL,kind text NOT NULL,units bigint NOT NULL,milestone_event_id uuid,
 created_by uuid NOT NULL REFERENCES app_users(id),created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT factory_capacity_event_reservation_fk FOREIGN KEY(tenant_id,reservation_id) REFERENCES factory_capacity_reservations(tenant_id,id),
 CONSTRAINT factory_capacity_event_milestone_fk FOREIGN KEY(tenant_id,milestone_event_id) REFERENCES production_milestone_events(tenant_id,id),
 CONSTRAINT factory_capacity_event_kind CHECK(kind IN('reserve','commit','release') AND units>0 AND sequence>0 AND ((kind='reserve')=(milestone_event_id IS NULL)))
);
CREATE UNIQUE INDEX factory_capacity_events_sequence ON factory_capacity_events(tenant_id,reservation_id,sequence);
CREATE UNIQUE INDEX factory_capacity_events_milestone ON factory_capacity_events(tenant_id,reservation_id,milestone_event_id);
CREATE TABLE factory_capacity_owner_proofs (
 tenant_id uuid NOT NULL REFERENCES organizations(id),owner_kind text NOT NULL,owner_id uuid NOT NULL,production_order_id uuid NOT NULL,
 production_version_id uuid,milestone_event_id uuid,quantity integer,milestone_type text,creation_transaction_id text NOT NULL,
 created_by uuid NOT NULL REFERENCES app_users(id),created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT factory_capacity_owner_production_fk FOREIGN KEY(tenant_id,production_order_id) REFERENCES production_orders(tenant_id,id),
 CONSTRAINT factory_capacity_owner_version_fk FOREIGN KEY(tenant_id,production_version_id,production_order_id,quantity) REFERENCES production_order_versions(tenant_id,id,production_order_id,quantity),
 CONSTRAINT factory_capacity_owner_milestone_fk FOREIGN KEY(tenant_id,milestone_event_id) REFERENCES production_milestone_events(tenant_id,id),
 CONSTRAINT factory_capacity_owner_proof_shape CHECK((owner_kind='version' AND owner_id=production_version_id AND quantity>0 AND milestone_event_id IS NULL AND milestone_type IS NULL)
  OR(owner_kind='milestone' AND owner_id=milestone_event_id AND production_version_id IS NULL AND quantity IS NULL AND milestone_type IS NOT NULL))
);
CREATE UNIQUE INDEX factory_capacity_owner_proofs_identity ON factory_capacity_owner_proofs(tenant_id,owner_kind,owner_id);
--> statement-breakpoint
CREATE FUNCTION factory_capacity_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN RAISE EXCEPTION 'factory_capacity_immutable' USING ERRCODE='23514';END $$;
CREATE FUNCTION factory_capacity_pool_base_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE current_factory fulfillment_factories;current_profile fulfillment_factory_versions;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext('factory:'||NEW.factory_id::text));
 PERFORM pg_advisory_xact_lock(hashtextextended('factory-capacity-pool:'||NEW.id::text,0));
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-'current_version_number') IS DISTINCT FROM (to_jsonb(OLD)-'current_version_number')
   OR NEW.current_version_number<>OLD.current_version_number+1 THEN RAISE EXCEPTION 'factory_capacity_pool_identity_immutable' USING ERRCODE='23514';END IF;
 ELSE
  IF (SELECT count(*) FROM factory_capacity_pools WHERE tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id)>=200
   THEN RAISE EXCEPTION 'factory_capacity_pool_limit' USING ERRCODE='23514';END IF;
  SELECT * INTO current_factory FROM fulfillment_factories WHERE tenant_id=NEW.tenant_id AND id=NEW.factory_id;
  SELECT * INTO current_profile FROM fulfillment_factory_versions WHERE tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id AND id=NEW.factory_version_id;
  IF current_factory.id IS NULL OR current_factory.status='archived' OR current_profile.version_number IS DISTINCT FROM current_factory.current_version_number
   OR current_profile.profile->>'timeZone' IS DISTINCT FROM NEW.time_zone OR NEW.current_version_number<>1
   OR NEW.created_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid
   OR NEW.code!~'^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$' OR length(NEW.time_zone)>80 OR NEW.time_zone~'^[+-]'
   OR NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE lower(name)=lower(NEW.time_zone))
   THEN RAISE EXCEPTION 'factory_capacity_pool_basis_invalid' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION factory_capacity_intervals_valid(value jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE part jsonb;previous_end text;
BEGIN
 IF jsonb_typeof(value) IS DISTINCT FROM 'array' OR jsonb_array_length(value)>12 THEN RETURN false;END IF;
 FOR part IN SELECT e FROM jsonb_array_elements(value)e ORDER BY e->>'start' LOOP
  IF jsonb_typeof(part) IS DISTINCT FROM 'object' OR part-ARRAY['start','end']<>'{}'::jsonb OR jsonb_typeof(part->'start') IS DISTINCT FROM 'string' OR jsonb_typeof(part->'end') IS DISTINCT FROM 'string'
   OR part->>'start'!~'^([01][0-9]|2[0-3]):[0-5][0-9]$' OR part->>'end'!~'^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$'
   OR part->>'start'>=part->>'end' OR (previous_end IS NOT NULL AND part->>'start'<previous_end) THEN RETURN false;END IF;
  previous_end:=part->>'end';
 END LOOP;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
CREATE FUNCTION guard_factory_capacity_version() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE pool factory_capacity_pools;p jsonb;day jsonb;binding jsonb;latest integer;local_day date;original_input jsonb;original_request jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext('factory:'||NEW.factory_id::text));
 PERFORM pg_advisory_xact_lock(hashtextextended('factory-capacity-pool:'||NEW.pool_id::text,0));
 SELECT * INTO pool FROM factory_capacity_pools WHERE tenant_id=NEW.tenant_id AND id=NEW.pool_id AND factory_id=NEW.factory_id;
 SELECT coalesce(max(version_number),0) INTO latest FROM factory_capacity_versions WHERE tenant_id=NEW.tenant_id AND pool_id=NEW.pool_id;
 p:=NEW.profile;
 IF pool.id IS NULL OR NEW.version_number<>latest+1 OR (latest>0 AND pool.current_version_number<>latest)
  OR NEW.created_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid
  OR p-ARRAY['name','status','dailyCapacityUnits','weekly','exceptions','cutoffTime','bindings','evidenceReference','notes']<>'{}'::jsonb
  OR jsonb_typeof(p->'name') IS DISTINCT FROM 'string' OR p->>'name' IS DISTINCT FROM finance_source_entry_trim(p->>'name') OR finance_source_entry_utf16_length(p->>'name') NOT BETWEEN 1 AND 200
  OR coalesce(p->>'status','') NOT IN('draft','active','paused','archived')
  OR NOT(p?'dailyCapacityUnits') OR (p->'dailyCapacityUnits'<>'null'::jsonb AND (jsonb_typeof(p->'dailyCapacityUnits') IS DISTINCT FROM 'number' OR p->>'dailyCapacityUnits'!~'^[0-9]{1,10}$' OR (p->>'dailyCapacityUnits')::numeric>1000000000))
  OR jsonb_typeof(p->'weekly') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'weekly')<>7
  OR jsonb_typeof(p->'exceptions') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'exceptions')>366
  OR jsonb_typeof(p->'bindings') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'bindings')>100
  OR NOT(p?'cutoffTime') OR (p->'cutoffTime'<>'null'::jsonb AND (jsonb_typeof(p->'cutoffTime') IS DISTINCT FROM 'string' OR p->>'cutoffTime'!~'^([01][0-9]|2[0-3]):[0-5][0-9]$'))
  OR jsonb_typeof(p->'evidenceReference') IS DISTINCT FROM 'string' OR p->>'evidenceReference' IS DISTINCT FROM finance_source_entry_trim(p->>'evidenceReference') OR finance_source_entry_utf16_length(p->>'evidenceReference')>2000
  OR jsonb_typeof(p->'notes') IS DISTINCT FROM 'string' OR p->>'notes' IS DISTINCT FROM finance_source_entry_trim(p->>'notes') OR finance_source_entry_utf16_length(p->>'notes')>4000
  THEN RAISE EXCEPTION 'factory_capacity_profile_invalid' USING ERRCODE='23514';END IF;
 IF p->>'status'='active' AND(p->'dailyCapacityUnits'='null'::jsonb OR jsonb_array_length(p->'bindings')=0 OR finance_source_entry_utf16_length(p->>'evidenceReference')<5)
  THEN RAISE EXCEPTION 'factory_capacity_profile_unconfirmed' USING ERRCODE='23514';END IF;
 IF (SELECT count(DISTINCT d->>'weekday') FROM jsonb_array_elements(p->'weekly')d)<>7
  OR (SELECT count(DISTINCT d->>'localDate') FROM jsonb_array_elements(p->'exceptions')d)<>jsonb_array_length(p->'exceptions')
  OR (SELECT count(DISTINCT b->>'capabilityVersionId') FROM jsonb_array_elements(p->'bindings')b)<>jsonb_array_length(p->'bindings')
  THEN RAISE EXCEPTION 'factory_capacity_profile_duplicates' USING ERRCODE='23514';END IF;
 FOR day IN SELECT d FROM jsonb_array_elements(p->'weekly')d LOOP
  IF jsonb_typeof(day) IS DISTINCT FROM 'object' OR day-ARRAY['weekday','intervals']<>'{}'::jsonb OR jsonb_typeof(day->'weekday') IS DISTINCT FROM 'number' OR day->>'weekday'!~'^[1-7]$' OR NOT factory_capacity_intervals_valid(day->'intervals')
   THEN RAISE EXCEPTION 'factory_capacity_week_invalid' USING ERRCODE='23514';END IF;
 END LOOP;
 FOR day IN SELECT d FROM jsonb_array_elements(p->'exceptions')d LOOP
  IF jsonb_typeof(day) IS DISTINCT FROM 'object' OR day-ARRAY['localDate','intervals','capacityUnits']<>'{}'::jsonb OR jsonb_typeof(day->'localDate') IS DISTINCT FROM 'string' OR day->>'localDate'!~'^20[0-9]{2}-[0-9]{2}-[0-9]{2}$'
   OR NOT factory_capacity_intervals_valid(day->'intervals') OR jsonb_typeof(day->'capacityUnits') IS DISTINCT FROM 'number'
   OR day->>'capacityUnits'!~'^[0-9]{1,10}$' OR (day->>'capacityUnits')::numeric>1000000000
   OR(jsonb_array_length(day->'intervals')=0 AND (day->>'capacityUnits')::numeric<>0)
   THEN RAISE EXCEPTION 'factory_capacity_exception_invalid' USING ERRCODE='23514';END IF;
  local_day:=(day->>'localDate')::date;
  IF local_day::text<>day->>'localDate' THEN RAISE EXCEPTION 'factory_capacity_exception_invalid' USING ERRCODE='23514';END IF;
 END LOOP;
 FOR binding IN SELECT b FROM jsonb_array_elements(p->'bindings')b LOOP
  IF jsonb_typeof(binding) IS DISTINCT FROM 'object' OR binding-ARRAY['capabilityVersionId','unitsPerItem']<>'{}'::jsonb OR jsonb_typeof(binding->'capabilityVersionId') IS DISTINCT FROM 'string' OR binding->>'capabilityVersionId' IS DISTINCT FROM (binding->>'capabilityVersionId')::uuid::text
   OR jsonb_typeof(binding->'unitsPerItem') IS DISTINCT FROM 'number' OR binding->>'unitsPerItem'!~'^[0-9]{1,7}$' OR (binding->>'unitsPerItem')::numeric NOT BETWEEN 1 AND 1000000
   OR NOT EXISTS(SELECT 1 FROM factory_capability_versions c WHERE c.tenant_id=NEW.tenant_id AND c.factory_id=NEW.factory_id AND c.id=(binding->>'capabilityVersionId')::uuid)
   THEN RAISE EXCEPTION 'factory_capacity_binding_invalid' USING ERRCODE='23514';END IF;
 END LOOP;
 IF NEW.version_number=1 THEN
  original_input:=jsonb_build_object('factoryVersionId',pool.factory_version_id::text,'code',pool.code,'timeZone',pool.time_zone,'unit',pool.unit,'profile',p,'idempotencyKey',NEW.idempotency_key::text);
  original_request:=jsonb_build_object('operation','create','factoryId',NEW.factory_id::text,'input',original_input);
 ELSE
  original_input:=jsonb_build_object('expectedVersion',NEW.version_number-1,'profile',p,'idempotencyKey',NEW.idempotency_key::text);
  original_request:=jsonb_build_object('operation','revise','factoryId',NEW.factory_id::text,'poolId',pool.id::text,'input',original_input);
 END IF;
 IF NEW.request_checksum IS DISTINCT FROM encode(sha256(convert_to(invoice_reconciliation_canonical(original_request),'UTF8')),'hex')
  THEN RAISE EXCEPTION 'factory_capacity_original_request_required' USING ERRCODE='23514';END IF;
 RETURN NEW;
EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow OR invalid_parameter_value THEN RAISE EXCEPTION 'factory_capacity_profile_invalid' USING ERRCODE='23514';
END $$;
CREATE FUNCTION require_factory_capacity_pool_version() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE pool factory_capacity_pools;latest integer;amount integer;pool_identity uuid;birth record;
BEGIN
 IF TG_TABLE_NAME='factory_capacity_pools' THEN pool_identity:=NEW.id;ELSE pool_identity:=NEW.pool_id;END IF;
 SELECT * INTO pool FROM factory_capacity_pools WHERE tenant_id=NEW.tenant_id AND id=pool_identity;
 SELECT max(version_number),count(*) INTO latest,amount FROM factory_capacity_versions WHERE tenant_id=NEW.tenant_id AND pool_id=pool_identity;
 IF pool.id IS NULL OR latest IS DISTINCT FROM pool.current_version_number OR amount<>pool.current_version_number
  THEN RAISE EXCEPTION 'factory_capacity_pool_version_required' USING ERRCODE='23514';END IF;
 -- Recheck births in this transaction even if their earlier deferred triggers
 -- were flushed before a later configuration change.
 FOR birth IN SELECT p.id FROM production_order_versions p JOIN factory_capacity_owner_proofs proof
  ON proof.tenant_id=p.tenant_id AND proof.owner_kind='version' AND proof.owner_id=p.id
  WHERE p.tenant_id=pool.tenant_id AND p.factory_id=pool.factory_id AND proof.creation_transaction_id=pg_current_xact_id()::text LOOP
  PERFORM assert_factory_capacity_production_version(pool.tenant_id,birth.id);
 END LOOP;
 RETURN NULL;
END $$;
CREATE TRIGGER factory_capacity_version_guard BEFORE INSERT ON factory_capacity_versions FOR EACH ROW EXECUTE FUNCTION guard_factory_capacity_version();
CREATE CONSTRAINT TRIGGER factory_capacity_pool_version_required AFTER INSERT OR UPDATE ON factory_capacity_pools DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_factory_capacity_pool_version();
CREATE CONSTRAINT TRIGGER factory_capacity_version_header_required AFTER INSERT ON factory_capacity_versions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_factory_capacity_pool_version();
--> statement-breakpoint
-- All supported wall-clock inputs have minute precision in 2000-2099. Enumerate
-- UTC offsets instead of PostgreSQL's default gap normalization/fold preference.
CREATE FUNCTION factory_capacity_local_instant(zone text,wall timestamp) RETURNS timestamptz LANGUAGE plpgsql STABLE STRICT SET search_path=pg_catalog,public AS $$
DECLARE matches integer;instant timestamptz;
BEGIN
 IF zone~'^[+-]' OR wall<timestamp '2000-01-01' OR wall>=timestamp '2100-01-01' OR date_trunc('minute',wall)<>wall
  OR NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE lower(name)=lower(zone)) THEN RAISE EXCEPTION 'factory_capacity_local_time_invalid' USING ERRCODE='23514';END IF;
 SELECT count(*),min(candidate) INTO matches,instant FROM (
  SELECT (wall-make_interval(mins=>offset_minutes)) AT TIME ZONE 'UTC' AS candidate FROM generate_series(-1440,1440)offset_minutes
 ) candidates WHERE candidate AT TIME ZONE zone=wall;
 IF matches<>1 THEN RAISE EXCEPTION 'factory_capacity_local_time_invalid' USING ERRCODE='23514';END IF;
 RETURN instant;
END $$;
CREATE FUNCTION factory_capacity_calendar_day(profile jsonb,zone text,local_day date,instant timestamptz)
 RETURNS TABLE(first_start timestamptz,last_end timestamptz,working_minutes bigint,remaining_minutes bigint,cutoff_at timestamptz,limit_units bigint)
 LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public AS $$
DECLARE exception_day jsonb;parts jsonb;part jsonb;start_at timestamptz;end_at timestamptz;duration numeric:=0;remaining numeric:=0;
BEGIN
 SELECT d INTO exception_day FROM jsonb_array_elements(profile->'exceptions')d WHERE d->>'localDate'=local_day::text;
 IF exception_day IS NOT NULL THEN parts:=exception_day->'intervals';limit_units:=(exception_day->>'capacityUnits')::bigint;
 ELSE
  SELECT d->'intervals' INTO parts FROM jsonb_array_elements(profile->'weekly')d WHERE (d->>'weekday')::integer=extract(isodow FROM local_day)::integer;
  limit_units:=(profile->>'dailyCapacityUnits')::bigint;
 END IF;
 IF NOT factory_capacity_intervals_valid(parts) OR jsonb_array_length(parts)=0 OR limit_units IS NULL
  THEN RAISE EXCEPTION 'factory_capacity_day_unconfirmed' USING ERRCODE='23514';END IF;
 FOR part IN SELECT p FROM jsonb_array_elements(parts)p ORDER BY p->>'start' LOOP
  start_at:=factory_capacity_local_instant(zone,local_day+(part->>'start')::time);
  end_at:=factory_capacity_local_instant(zone,CASE WHEN part->>'end'='24:00' THEN (local_day+1)::timestamp ELSE local_day+(part->>'end')::time END);
  IF end_at<=start_at OR(last_end IS NOT NULL AND start_at<last_end) THEN RAISE EXCEPTION 'factory_capacity_calendar_invalid' USING ERRCODE='23514';END IF;
  IF first_start IS NULL THEN first_start:=start_at;END IF;last_end:=end_at;
  duration:=duration+extract(epoch FROM(end_at-start_at));
  remaining:=remaining+greatest(0,extract(epoch FROM(end_at-greatest(instant,start_at))));
 END LOOP;
 working_minutes:=floor(duration/60)::bigint;remaining_minutes:=floor(remaining/60)::bigint;
 IF profile->>'cutoffTime' IS NOT NULL THEN cutoff_at:=factory_capacity_local_instant(zone,local_day+(profile->>'cutoffTime')::time);END IF;
 RETURN NEXT;
END $$;
CREATE FUNCTION mint_factory_capacity_owner_proof() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid;
BEGIN
 actor:=CASE WHEN TG_TABLE_NAME='production_order_versions' THEN (to_jsonb(NEW)->>'created_by')::uuid ELSE (to_jsonb(NEW)->>'actor_user_id')::uuid END;
 IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid OR actor IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid THEN
  RAISE EXCEPTION 'factory_capacity_owner_context_required' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='production_order_versions' THEN
  INSERT INTO factory_capacity_owner_proofs(tenant_id,owner_kind,owner_id,production_order_id,production_version_id,quantity,creation_transaction_id,created_by)
   VALUES(NEW.tenant_id,'version',NEW.id,NEW.production_order_id,NEW.id,NEW.quantity,pg_current_xact_id()::text,actor);
 ELSE
  INSERT INTO factory_capacity_owner_proofs(tenant_id,owner_kind,owner_id,production_order_id,milestone_event_id,milestone_type,creation_transaction_id,created_by)
   VALUES(NEW.tenant_id,'milestone',NEW.id,NEW.production_order_id,NEW.id,NEW.type,pg_current_xact_id()::text,actor);
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION mint_factory_capacity_owner_proof() FROM PUBLIC;
CREATE TRIGGER production_version_capacity_birth AFTER INSERT ON production_order_versions FOR EACH ROW EXECUTE FUNCTION mint_factory_capacity_owner_proof();
CREATE TRIGGER production_milestone_capacity_birth AFTER INSERT ON production_milestone_events FOR EACH ROW EXECUTE FUNCTION mint_factory_capacity_owner_proof();
--> statement-breakpoint
CREATE FUNCTION guard_factory_capacity_reservation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE pool factory_capacity_pools;version factory_capacity_versions;production production_order_versions;production_root production_orders;calendar record;used_units numeric;outstanding numeric;instant timestamptz;today date;current_factory fulfillment_factories;current_factory_version fulfillment_factory_versions;pinned_factory_version fulfillment_factory_versions;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext('factory:'||NEW.factory_id::text));
 PERFORM pg_advisory_xact_lock(hashtextextended('factory-capacity-pool:'||NEW.pool_id::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('factory-capacity-day:'||NEW.pool_id::text||':'||NEW.local_date::text,0));
 SELECT * INTO pool FROM factory_capacity_pools WHERE tenant_id=NEW.tenant_id AND id=NEW.pool_id;
 SELECT * INTO version FROM factory_capacity_versions WHERE tenant_id=NEW.tenant_id AND id=NEW.pool_version_id AND pool_id=pool.id;
 SELECT * INTO production FROM production_order_versions WHERE tenant_id=NEW.tenant_id AND id=NEW.production_version_id AND production_order_id=NEW.production_order_id;
 SELECT * INTO production_root FROM production_orders WHERE tenant_id=NEW.tenant_id AND id=NEW.production_order_id;
 IF pool.id IS NULL OR version.id IS NULL OR production.id IS NULL OR pool.factory_id<>NEW.factory_id OR production.factory_id IS DISTINCT FROM NEW.factory_id
  OR production_root.id IS NULL OR production_root.factory_id IS DISTINCT FROM NEW.factory_id OR production_root.current_version_number<>production.version_number
  OR production.capability_version_id IS DISTINCT FROM NEW.capability_version_id OR production.quantity<>NEW.quantity
  OR pool.unit<>NEW.unit OR pool.time_zone<>NEW.time_zone OR pool.current_version_number<>version.version_number OR version.profile->>'status' IS DISTINCT FROM 'active'
  OR NEW.created_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid
  OR NOT EXISTS(SELECT 1 FROM factory_capacity_owner_proofs proof WHERE proof.tenant_id=NEW.tenant_id AND proof.owner_kind='version' AND proof.owner_id=NEW.production_version_id
    AND proof.production_order_id=NEW.production_order_id AND proof.quantity=NEW.quantity AND proof.creation_transaction_id=pg_current_xact_id()::text)
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(version.profile->'bindings') binding WHERE binding->>'capabilityVersionId'=NEW.capability_version_id::text AND (binding->>'unitsPerItem')::numeric=NEW.units_per_item)
 THEN RAISE EXCEPTION 'factory_capacity_reservation_original_required' USING ERRCODE='23514';END IF;
 instant:=clock_timestamp();today:=(instant AT TIME ZONE pool.time_zone)::date;
 SELECT * INTO current_factory FROM fulfillment_factories WHERE tenant_id=NEW.tenant_id AND id=NEW.factory_id FOR SHARE;
 SELECT * INTO current_factory_version FROM fulfillment_factory_versions WHERE tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id AND version_number=current_factory.current_version_number;
 SELECT * INTO pinned_factory_version FROM fulfillment_factory_versions WHERE tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id AND id=production.factory_version_id;
 IF current_factory.status IS DISTINCT FROM 'active' OR current_factory_version.profile->>'timeZone' IS DISTINCT FROM pool.time_zone
  OR pinned_factory_version.profile->>'timeZone' IS DISTINCT FROM pool.time_zone
  THEN RAISE EXCEPTION 'factory_capacity_factory_basis_changed' USING ERRCODE='23514';END IF;
 SELECT * INTO calendar FROM factory_capacity_calendar_day(version.profile,pool.time_zone,NEW.local_date,instant);
 IF NEW.local_date<today OR NEW.work_starts_at IS DISTINCT FROM calendar.first_start OR NEW.work_ends_at IS DISTINCT FROM calendar.last_end
  OR NEW.work_ends_at>production.expected_completion_at OR(NEW.local_date=today AND(calendar.remaining_minutes=0 OR(calendar.cutoff_at IS NOT NULL AND instant>=calendar.cutoff_at)))
  THEN RAISE EXCEPTION 'factory_capacity_reservation_date_invalid' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM production_orders p WHERE p.tenant_id=NEW.tenant_id AND p.factory_id=NEW.factory_id AND p.id<>NEW.production_order_id
  AND NOT EXISTS(SELECT 1 FROM factory_capacity_reservations r WHERE r.tenant_id=p.tenant_id AND r.production_order_id=p.id)
  AND(p.status NOT IN('completed','cancelled') OR(NEW.local_date=today AND((p.created_at AT TIME ZONE pool.time_zone)::date=today OR(p.updated_at AT TIME ZONE pool.time_zone)::date=today
   OR EXISTS(SELECT 1 FROM production_milestone_events m WHERE m.tenant_id=p.tenant_id AND m.production_order_id=p.id AND m.type IN('completed','cancelled') AND(m.recorded_at AT TIME ZONE pool.time_zone)::date=today)))))
  THEN RAISE EXCEPTION 'factory_capacity_legacy_untracked' USING ERRCODE='23514';END IF;
 SELECT coalesce(sum(r.total_units-coalesce(e.released,0)),0),coalesce(sum(r.total_units-coalesce(e.released,0)-coalesce(e.committed,0)),0) INTO used_units,outstanding FROM factory_capacity_reservations r
  LEFT JOIN(SELECT reservation_id,sum(units) FILTER(WHERE kind='release') AS released,sum(units) FILTER(WHERE kind='commit') AS committed FROM factory_capacity_events WHERE tenant_id=NEW.tenant_id GROUP BY reservation_id)e ON e.reservation_id=r.id
  WHERE r.tenant_id=NEW.tenant_id AND r.pool_id=NEW.pool_id AND r.local_date=NEW.local_date;
 IF calendar.limit_units<0 OR used_units+NEW.total_units>calendar.limit_units OR(pool.unit='minute' AND(calendar.limit_units>calendar.working_minutes OR(NEW.local_date=today AND outstanding+NEW.total_units>calendar.remaining_minutes)))
  THEN RAISE EXCEPTION 'factory_capacity_insufficient' USING ERRCODE='23514';END IF;
 NEW.creation_transaction_id:=pg_current_xact_id()::text;NEW.created_at:=clock_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER factory_capacity_reservation_guard BEFORE INSERT ON factory_capacity_reservations FOR EACH ROW EXECUTE FUNCTION guard_factory_capacity_reservation();
CREATE FUNCTION guard_factory_capacity_event() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE reservation factory_capacity_reservations;last_sequence integer;reserved numeric;committed numeric;released numeric;proof factory_capacity_owner_proofs;
BEGIN
 SELECT * INTO reservation FROM factory_capacity_reservations WHERE tenant_id=NEW.tenant_id AND id=NEW.reservation_id;
 IF reservation.id IS NULL THEN RAISE EXCEPTION 'factory_capacity_event_parent_required' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtext('factory:'||reservation.factory_id::text));
 PERFORM pg_advisory_xact_lock(hashtextextended('factory-capacity-pool:'||reservation.pool_id::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('factory-capacity-day:'||reservation.pool_id::text||':'||reservation.local_date::text,0));
 SELECT coalesce(max(sequence),0),coalesce(sum(units) FILTER(WHERE kind='reserve'),0),coalesce(sum(units) FILTER(WHERE kind='commit'),0),coalesce(sum(units) FILTER(WHERE kind='release'),0)
  INTO last_sequence,reserved,committed,released FROM factory_capacity_events WHERE tenant_id=NEW.tenant_id AND reservation_id=reservation.id;
 IF NEW.sequence<>last_sequence+1 OR NEW.created_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid THEN RAISE EXCEPTION 'factory_capacity_event_sequence_invalid' USING ERRCODE='23514';END IF;
 IF NEW.kind='reserve' THEN
  IF last_sequence<>0 OR NEW.units<>reservation.total_units OR reservation.creation_transaction_id<>pg_current_xact_id()::text OR NEW.milestone_event_id IS NOT NULL
   THEN RAISE EXCEPTION 'factory_capacity_reserve_event_invalid' USING ERRCODE='23514';END IF;
 ELSE
  SELECT * INTO proof FROM factory_capacity_owner_proofs WHERE tenant_id=NEW.tenant_id AND owner_kind='milestone' AND owner_id=NEW.milestone_event_id;
  IF proof.owner_id IS NULL OR proof.production_order_id<>reservation.production_order_id OR proof.creation_transaction_id<>pg_current_xact_id()::text
   OR proof.created_by<>NEW.created_by OR reserved<>reservation.total_units THEN RAISE EXCEPTION 'factory_capacity_actual_milestone_required' USING ERRCODE='23514';END IF;
  IF NEW.kind='commit' AND(proof.milestone_type<>'started' OR committed<>0 OR released<>0 OR NEW.units<>reservation.total_units)
   THEN RAISE EXCEPTION 'factory_capacity_commit_invalid' USING ERRCODE='23514';END IF;
  IF NEW.kind='release' AND(proof.milestone_type<>'cancelled' OR committed<>0 OR released<>0 OR NEW.units<>reservation.total_units)
   THEN RAISE EXCEPTION 'factory_capacity_release_invalid' USING ERRCODE='23514';END IF;
 END IF;
 NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER factory_capacity_event_guard BEFORE INSERT ON factory_capacity_events FOR EACH ROW EXECUTE FUNCTION guard_factory_capacity_event();
--> statement-breakpoint
CREATE FUNCTION assert_factory_capacity_production_version(tenant uuid,version_identity uuid) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE p production_order_versions;required_count integer;reserved_count integer;
BEGIN
 SELECT * INTO p FROM production_order_versions WHERE tenant_id=tenant AND id=version_identity;
 IF p.id IS NULL OR p.factory_id IS NULL OR p.capability_version_id IS NULL THEN RAISE EXCEPTION 'factory_capacity_new_production_required' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtext('factory:'||p.factory_id::text));
 SELECT count(*) INTO required_count FROM factory_capacity_pools pool JOIN factory_capacity_versions v ON v.tenant_id=pool.tenant_id AND v.pool_id=pool.id AND v.version_number=pool.current_version_number
  WHERE pool.tenant_id=p.tenant_id AND pool.factory_id=p.factory_id AND v.profile->>'status' IN('active','paused')
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(v.profile->'bindings') b WHERE b->>'capabilityVersionId'=p.capability_version_id::text);
 SELECT count(*) INTO reserved_count FROM factory_capacity_reservations r JOIN factory_capacity_pools pool ON pool.tenant_id=r.tenant_id AND pool.id=r.pool_id
  JOIN factory_capacity_versions v ON v.tenant_id=pool.tenant_id AND v.pool_id=pool.id AND v.version_number=pool.current_version_number AND v.id=r.pool_version_id
  WHERE r.tenant_id=p.tenant_id AND r.production_version_id=p.id AND r.production_order_id=p.production_order_id AND r.quantity=p.quantity
   AND r.creation_transaction_id=pg_current_xact_id()::text AND v.profile->>'status'='active'
   AND EXISTS(SELECT 1 FROM factory_capacity_events e WHERE e.tenant_id=r.tenant_id AND e.reservation_id=r.id AND e.kind='reserve' AND e.units=r.total_units);
 IF required_count=0 OR reserved_count<>required_count THEN RAISE EXCEPTION 'factory_capacity_all_pools_required' USING ERRCODE='23514';END IF;
 RETURN;
END $$;
CREATE FUNCTION require_factory_capacity_new_version() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE p production_order_versions;
BEGIN
 IF TG_TABLE_NAME='production_orders' THEN
  SELECT * INTO p FROM production_order_versions WHERE tenant_id=NEW.tenant_id AND production_order_id=NEW.id AND version_number=NEW.current_version_number;
 ELSE SELECT * INTO p FROM production_order_versions WHERE tenant_id=NEW.tenant_id AND id=NEW.id;END IF;
 PERFORM assert_factory_capacity_production_version(NEW.tenant_id,p.id);
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER production_requires_capacity AFTER INSERT ON production_orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_factory_capacity_new_version();
CREATE CONSTRAINT TRIGGER production_version_requires_capacity AFTER INSERT ON production_order_versions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_factory_capacity_new_version();
CREATE FUNCTION require_factory_capacity_milestone() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE r factory_capacity_reservations;committed numeric;released numeric;
BEGIN
 IF NEW.type NOT IN('started','cancelled') THEN RETURN NULL;END IF;
 FOR r IN SELECT * FROM factory_capacity_reservations WHERE tenant_id=NEW.tenant_id AND production_order_id=NEW.production_order_id LOOP
  SELECT coalesce(sum(units) FILTER(WHERE kind='commit'),0),coalesce(sum(units) FILTER(WHERE kind='release'),0) INTO committed,released
   FROM factory_capacity_events WHERE tenant_id=r.tenant_id AND reservation_id=r.id;
  IF NEW.type='started' AND NOT EXISTS(SELECT 1 FROM factory_capacity_events WHERE tenant_id=r.tenant_id AND reservation_id=r.id AND kind='commit' AND milestone_event_id=NEW.id AND units=r.total_units)
   THEN RAISE EXCEPTION 'factory_capacity_started_effect_required' USING ERRCODE='23514';END IF;
  IF NEW.type='cancelled' AND committed=0 AND(released<>r.total_units OR NOT EXISTS(SELECT 1 FROM factory_capacity_events WHERE tenant_id=r.tenant_id AND reservation_id=r.id AND kind='release' AND milestone_event_id=NEW.id AND units=r.total_units))
   THEN RAISE EXCEPTION 'factory_capacity_cancel_effect_required' USING ERRCODE='23514';END IF;
 END LOOP;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER production_milestone_requires_capacity AFTER INSERT ON production_milestone_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_factory_capacity_milestone();
--> statement-breakpoint
DO $$DECLARE name text;BEGIN
 FOREACH name IN ARRAY ARRAY['factory_capacity_pools','factory_capacity_versions','factory_capacity_reservations','factory_capacity_events','factory_capacity_owner_proofs'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',name);
  EXECUTE format('GRANT SELECT ON %I TO yummyai_app',name);
  IF name<>'factory_capacity_pools' THEN EXECUTE format('CREATE TRIGGER capacity_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION factory_capacity_immutable()',name);END IF;
 END LOOP;
END $$;
GRANT INSERT ON factory_capacity_pools,factory_capacity_versions,factory_capacity_reservations,factory_capacity_events TO yummyai_app;
GRANT UPDATE(current_version_number) ON factory_capacity_pools TO yummyai_app;
CREATE TRIGGER factory_capacity_pool_guard BEFORE INSERT OR UPDATE ON factory_capacity_pools FOR EACH ROW EXECUTE FUNCTION factory_capacity_pool_base_guard();
CREATE TRIGGER factory_capacity_pool_delete_guard BEFORE DELETE ON factory_capacity_pools FOR EACH ROW EXECUTE FUNCTION factory_capacity_immutable();
