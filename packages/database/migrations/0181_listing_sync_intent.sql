CREATE TABLE marketplace_listing_sync_intents (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), request_key uuid NOT NULL,
 created_by uuid NOT NULL, request_id uuid NOT NULL, request_checksum text NOT NULL CHECK(request_checksum~'^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT listing_sync_intent_ids_check CHECK(substring(id::text from 15 for 1)='7' AND substring(request_key::text from 15 for 1)='7'),
 CONSTRAINT listing_sync_intent_request_fk FOREIGN KEY(tenant_id,request_id) REFERENCES marketplace_listing_sync_requests(tenant_id,id),
 CONSTRAINT listing_sync_intent_actor_key_unique UNIQUE(tenant_id,created_by,request_key),
 CONSTRAINT listing_sync_intent_request_unique UNIQUE(tenant_id,request_id)
);
--> statement-breakpoint
ALTER TABLE marketplace_listing_sync_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_listing_sync_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY listing_sync_intent_tenant ON marketplace_listing_sync_intents FOR ALL TO yummyai_app
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT ON marketplace_listing_sync_intents TO yummyai_app;
--> statement-breakpoint
CREATE FUNCTION guard_listing_sync_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Immutable Listing sync intent' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM marketplace_listing_sync_requests r WHERE r.tenant_id=NEW.tenant_id AND r.id=NEW.request_id AND r.created_by=NEW.created_by)
 THEN RAISE EXCEPTION 'Listing sync intent owner mismatch' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER listing_sync_intent_guard BEFORE INSERT OR UPDATE OR DELETE ON marketplace_listing_sync_intents
 FOR EACH ROW EXECUTE FUNCTION guard_listing_sync_intent();
