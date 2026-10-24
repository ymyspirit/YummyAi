ALTER TABLE marketplace_store_node_executions DROP CONSTRAINT marketplace_store_node_executions_operation_check;
ALTER TABLE marketplace_store_node_executions ADD CONSTRAINT store_node_execution_operation_check
 CHECK(operation IN ('marketplace.capabilities.sync.v1','marketplace.publication.validation-preview.v1'));
ALTER TABLE marketplace_store_node_execution_steps DROP CONSTRAINT marketplace_store_node_execution_steps_request_class_check;
ALTER TABLE marketplace_store_node_execution_steps ADD CONSTRAINT store_node_step_request_class_check CHECK(request_class IN
 ('amazon_lwa','amazon_participations','amazon_product_definition','amazon_schema','amazon_meta_schema','amazon_listing_validation_preview',
  'etsy_refresh','etsy_shop','etsy_sections','etsy_return_policies','etsy_taxonomy','etsy_shipping_profiles','etsy_readiness_profiles','etsy_taxonomy_properties'));
ALTER TABLE marketplace_store_node_executions DROP CONSTRAINT store_node_execution_success_shape;
ALTER TABLE marketplace_store_node_executions ADD CONSTRAINT store_node_execution_success_shape CHECK
 ((operation='marketplace.capabilities.sync.v1' AND (state='succeeded')=(snapshot_id IS NOT NULL) AND (snapshot_id IS NULL OR completion_checksum IS NOT NULL))
 OR (operation='marketplace.publication.validation-preview.v1' AND snapshot_id IS NULL AND (state<>'succeeded' OR completion_checksum IS NOT NULL)));
--> statement-breakpoint
CREATE TABLE marketplace_publication_intents (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), request_id uuid NOT NULL,
 created_by uuid NOT NULL, membership_id uuid NOT NULL, authority_ceiling jsonb NOT NULL,
 authorization_generation uuid NOT NULL, route text NOT NULL, request_key uuid, request_checksum text, target jsonb, node_execution_id uuid,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT publication_intent_ids_check CHECK(substring(id::text from 15 for 1)='7' AND (request_key IS NULL OR substring(request_key::text from 15 for 1)='7')),
 CONSTRAINT publication_intent_digest_check CHECK(request_checksum IS NULL OR request_checksum~'^[a-f0-9]{64}$'),
 CONSTRAINT publication_intent_route_check CHECK(
  (route='central' AND request_key IS NULL AND request_checksum IS NULL AND target IS NULL AND node_execution_id IS NULL)
  OR (route='node_preview' AND request_key IS NOT NULL AND request_checksum IS NOT NULL AND target IS NOT NULL AND node_execution_id IS NOT NULL)),
 CONSTRAINT publication_intent_request_fk FOREIGN KEY(tenant_id,request_id) REFERENCES marketplace_publication_requests(tenant_id,id),
 CONSTRAINT publication_intent_execution_fk FOREIGN KEY(tenant_id,node_execution_id) REFERENCES marketplace_store_node_executions(tenant_id,id),
 CONSTRAINT publication_intent_request_unique UNIQUE(tenant_id,request_id),
 CONSTRAINT publication_intent_actor_key_unique UNIQUE(tenant_id,created_by,request_key),
 CONSTRAINT publication_intent_execution_unique UNIQUE(tenant_id,node_execution_id)
);
--> statement-breakpoint
ALTER TABLE marketplace_publication_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_publication_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY publication_intent_tenant ON marketplace_publication_intents FOR ALL TO yummyai_app
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT ON marketplace_publication_intents TO yummyai_app;
--> statement-breakpoint
CREATE FUNCTION guard_publication_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Immutable Publication intent' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM marketplace_publication_requests r WHERE r.tenant_id=NEW.tenant_id AND r.id=NEW.request_id AND r.created_by=NEW.created_by)
 THEN RAISE EXCEPTION 'Publication intent owner mismatch' USING ERRCODE='23514'; END IF;
 IF NEW.route='node_preview' AND NOT EXISTS(SELECT 1 FROM marketplace_store_node_executions e JOIN marketplace_publication_requests r
  ON r.tenant_id=e.tenant_id AND r.id=NEW.request_id
  WHERE e.tenant_id=NEW.tenant_id AND e.id=NEW.node_execution_id AND e.created_by=NEW.created_by AND e.membership_id=NEW.membership_id
  AND e.request_id=NEW.request_key AND e.request_checksum=NEW.request_checksum AND e.authorization_generation=NEW.authorization_generation
  AND e.account_id=r.account_id AND e.operation='marketplace.publication.validation-preview.v1'
  AND e.input->>'publicationRequestId'=r.id::text AND e.input->'target'=NEW.target AND r.action='amazon_validation_preview')
 THEN RAISE EXCEPTION 'Publication node reference mismatch' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER publication_intent_guard BEFORE INSERT OR UPDATE OR DELETE ON marketplace_publication_intents
 FOR EACH ROW EXECUTE FUNCTION guard_publication_intent();
