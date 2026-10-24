-- Wall-clock timestamps remain original evidence. Do not infer a sequence for
-- existing runs; only new admissions reserve the next connection-local value.
ALTER TABLE shipos_connections ADD COLUMN sync_sequence bigint NOT NULL DEFAULT 0;
ALTER TABLE shipos_connections ADD CONSTRAINT shipos_connections_sequence_check CHECK(sync_sequence >= 0);
ALTER TABLE shipos_sync_runs ADD COLUMN sync_sequence bigint;
ALTER TABLE shipos_sync_runs ADD CONSTRAINT shipos_sync_runs_sequence_check CHECK(sync_sequence IS NULL OR sync_sequence > 0);
CREATE UNIQUE INDEX shipos_sync_runs_sequence_unique ON shipos_sync_runs(tenant_id,connection_id,sync_sequence);
CREATE INDEX shipos_snapshots_order_run_idx ON shipos_order_snapshots(tenant_id,local_order_id,run_id);
--> statement-breakpoint
CREATE FUNCTION protect_shipos_sync_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'ShipOS sync history is immutable' USING ERRCODE='23514'; END IF;
 IF ROW(NEW.id,NEW.tenant_id,NEW.connection_id,NEW.connection_version,NEW.idempotency_key,NEW.request_checksum,NEW.order_numbers,NEW.created_by,NEW.created_at,NEW.sync_sequence)
   IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.connection_id,OLD.connection_version,OLD.idempotency_key,OLD.request_checksum,OLD.order_numbers,OLD.created_by,OLD.created_at,OLD.sync_sequence)
 THEN RAISE EXCEPTION 'ShipOS sync identity is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER shipos_sync_runs_identity_immutable BEFORE UPDATE OR DELETE ON shipos_sync_runs FOR EACH ROW EXECUTE FUNCTION protect_shipos_sync_identity();
CREATE FUNCTION protect_shipos_sync_sequence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'INSERT' THEN
   IF NEW.sync_sequence <> 0 THEN RAISE EXCEPTION 'ShipOS sequence must start at zero' USING ERRCODE='23514'; END IF;
 ELSIF NEW.sync_sequence IS DISTINCT FROM OLD.sync_sequence AND NEW.sync_sequence IS DISTINCT FROM OLD.sync_sequence + 1 THEN
   RAISE EXCEPTION 'ShipOS sequence must advance by one' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER shipos_connections_sequence_monotonic BEFORE INSERT OR UPDATE ON shipos_connections FOR EACH ROW EXECUTE FUNCTION protect_shipos_sync_sequence();
