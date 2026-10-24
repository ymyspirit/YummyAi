ALTER TABLE marketplace_store_node_executions DROP CONSTRAINT store_node_execution_operation_check;
ALTER TABLE marketplace_store_node_executions ADD CONSTRAINT store_node_execution_operation_check CHECK(operation IN
 ('marketplace.capabilities.sync.v1','marketplace.publication.validation-preview.v1','marketplace.publication.amazon-submit.v1','marketplace.publication.amazon-status.v1'));
ALTER TABLE marketplace_store_node_execution_steps DROP CONSTRAINT store_node_step_request_class_check;
ALTER TABLE marketplace_store_node_execution_steps ADD CONSTRAINT store_node_step_request_class_check CHECK(request_class IN
 ('amazon_lwa','amazon_participations','amazon_product_definition','amazon_schema','amazon_meta_schema','amazon_listing_validation_preview','amazon_listing_submit','amazon_listing_status',
  'etsy_refresh','etsy_shop','etsy_sections','etsy_return_policies','etsy_taxonomy','etsy_shipping_profiles','etsy_readiness_profiles','etsy_taxonomy_properties'));
ALTER TABLE marketplace_store_node_executions DROP CONSTRAINT store_node_execution_success_shape;
ALTER TABLE marketplace_store_node_executions ADD CONSTRAINT store_node_execution_success_shape CHECK
 ((operation='marketplace.capabilities.sync.v1' AND (state='succeeded')=(snapshot_id IS NOT NULL) AND (snapshot_id IS NULL OR completion_checksum IS NOT NULL))
 OR (operation IN ('marketplace.publication.validation-preview.v1','marketplace.publication.amazon-submit.v1','marketplace.publication.amazon-status.v1') AND snapshot_id IS NULL AND (state<>'succeeded' OR completion_checksum IS NOT NULL)));
ALTER TABLE marketplace_publication_intents DROP CONSTRAINT publication_intent_route_check;
ALTER TABLE marketplace_publication_intents ADD CONSTRAINT publication_intent_route_check CHECK
 ((route='central' AND request_key IS NULL AND request_checksum IS NULL AND target IS NULL AND node_execution_id IS NULL)
 OR (route IN ('node_preview','node_submit') AND request_key IS NOT NULL AND request_checksum IS NOT NULL AND target IS NOT NULL AND node_execution_id IS NOT NULL));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_publication_intent() RETURNS trigger LANGUAGE plpgsql AS $$
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
 IF NEW.route='node_submit' AND NOT EXISTS(SELECT 1 FROM marketplace_store_node_executions e JOIN marketplace_publication_requests r
  ON r.tenant_id=e.tenant_id AND r.id=NEW.request_id JOIN marketplace_publication_requests p ON p.tenant_id=r.tenant_id AND p.id=r.parent_request_id
  WHERE e.tenant_id=NEW.tenant_id AND e.id=NEW.node_execution_id AND e.created_by=NEW.created_by AND e.membership_id=NEW.membership_id
  AND e.request_id=NEW.request_key AND e.request_checksum=NEW.request_checksum AND e.authorization_generation=NEW.authorization_generation
  AND e.account_id=r.account_id AND e.operation='marketplace.publication.amazon-submit.v1' AND e.input->>'publicationRequestId'=r.id::text
  AND e.input->'target'=NEW.target AND r.action='amazon_submit' AND p.action='amazon_validation_preview'
  AND NEW.target->>'previewRequestId'=p.id::text AND NEW.target->>'payloadChecksum'=r.payload_checksum AND NEW.target->>'sku'=r.payload->>'sku')
 THEN RAISE EXCEPTION 'Publication submission reference mismatch' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TABLE marketplace_publication_node_operations (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES organizations(id),request_id uuid NOT NULL,
 kind text NOT NULL,request_key uuid NOT NULL,request_checksum text NOT NULL,target jsonb NOT NULL,node_execution_id uuid NOT NULL,
 created_by uuid NOT NULL,membership_id uuid NOT NULL,authority_ceiling jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT publication_node_operation_id_check CHECK(substring(id::text from 15 for 1)='7' AND substring(request_key::text from 15 for 1)='7'),
 CONSTRAINT publication_node_operation_kind_check CHECK(kind IN ('submit','status')),
 CONSTRAINT publication_node_operation_digest_check CHECK(request_checksum~'^[a-f0-9]{64}$'),
 CONSTRAINT publication_node_operation_request_fk FOREIGN KEY(tenant_id,request_id) REFERENCES marketplace_publication_requests(tenant_id,id),
 CONSTRAINT publication_node_operation_execution_fk FOREIGN KEY(tenant_id,node_execution_id) REFERENCES marketplace_store_node_executions(tenant_id,id),
 CONSTRAINT publication_node_operation_tenant_unique UNIQUE(tenant_id,id),
 CONSTRAINT publication_node_operation_key_unique UNIQUE(tenant_id,created_by,request_key),
 CONSTRAINT publication_node_operation_execution_unique UNIQUE(tenant_id,node_execution_id)
);
CREATE UNIQUE INDEX publication_node_one_submit ON marketplace_publication_node_operations(tenant_id,request_id) WHERE kind='submit';
CREATE TABLE marketplace_publication_node_results (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES organizations(id),operation_id uuid NOT NULL,request_id uuid NOT NULL,event_id uuid,
 result jsonb NOT NULL,adopted_as_request_status boolean NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT publication_node_result_operation_fk FOREIGN KEY(tenant_id,operation_id) REFERENCES marketplace_publication_node_operations(tenant_id,id),
 CONSTRAINT publication_node_result_request_fk FOREIGN KEY(tenant_id,request_id) REFERENCES marketplace_publication_requests(tenant_id,id),
 CONSTRAINT publication_node_result_event_fk FOREIGN KEY(event_id) REFERENCES marketplace_publication_events(id),
 CONSTRAINT publication_node_result_operation_unique UNIQUE(tenant_id,operation_id)
);
--> statement-breakpoint
ALTER TABLE marketplace_publication_node_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_publication_node_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY publication_node_operation_tenant ON marketplace_publication_node_operations FOR ALL TO yummyai_app
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE marketplace_publication_node_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_publication_node_results FORCE ROW LEVEL SECURITY;
CREATE POLICY publication_node_result_tenant ON marketplace_publication_node_results FOR ALL TO yummyai_app
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT ON marketplace_publication_node_operations,marketplace_publication_node_results TO yummyai_app;
--> statement-breakpoint
CREATE FUNCTION guard_publication_node_operation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Immutable Publication node operation' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM marketplace_store_node_executions e JOIN marketplace_publication_requests r ON r.tenant_id=e.tenant_id AND r.id=NEW.request_id
  JOIN marketplace_publication_intents i ON i.tenant_id=r.tenant_id AND i.request_id=r.id
  WHERE e.tenant_id=NEW.tenant_id AND e.id=NEW.node_execution_id AND e.created_by=NEW.created_by AND e.membership_id=NEW.membership_id
  AND e.authority_ceiling=NEW.authority_ceiling AND e.request_id=NEW.request_key AND e.request_checksum=NEW.request_checksum
  AND e.account_id=r.account_id AND e.input->>'operationId'=NEW.id::text AND e.input->>'publicationRequestId'=r.id::text AND e.input->'target'=NEW.target
  AND r.action='amazon_submit' AND i.route='node_submit' AND i.created_by=NEW.created_by
  AND ((NEW.kind='submit' AND e.operation='marketplace.publication.amazon-submit.v1' AND i.node_execution_id=e.id AND i.target=NEW.target)
   OR (NEW.kind='status' AND e.operation='marketplace.publication.amazon-status.v1' AND NEW.target->>'publicationRequestId'=r.id::text
    AND NEW.target->>'submissionExecutionId'=i.node_execution_id::text)))
 THEN RAISE EXCEPTION 'Publication operation reference mismatch' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER publication_node_operation_guard BEFORE INSERT OR UPDATE OR DELETE ON marketplace_publication_node_operations
 FOR EACH ROW EXECUTE FUNCTION guard_publication_node_operation();
CREATE FUNCTION guard_publication_node_result() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Immutable Publication node result' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM marketplace_publication_node_operations o WHERE o.tenant_id=NEW.tenant_id AND o.id=NEW.operation_id AND o.request_id=NEW.request_id
  AND NEW.result->>'publicationRequestId'=o.request_id::text AND NEW.result->>'payloadChecksum'=o.target->>'payloadChecksum' AND NEW.result->>'externalListingId'=o.target->>'sku'
  AND ((o.kind='submit' AND NEW.adopted_as_request_status AND NEW.result->>'status' IN ('submission_accepted','publication_failed') AND length(NEW.result->>'externalSubmissionId')>0)
   OR (o.kind='status' AND NEW.result->>'status' IN ('published','sync_pending','publication_failed','deactivated') AND NEW.result->'sourceSubmissionId'=o.target->'sourceSubmissionId'
    AND (NOT NEW.adopted_as_request_status OR o.target->>'sourceSubmissionId' IS NOT NULL)))
  AND ((NOT NEW.adopted_as_request_status AND NEW.event_id IS NULL) OR (NEW.adopted_as_request_status AND EXISTS(SELECT 1 FROM marketplace_publication_events e
   WHERE e.tenant_id=NEW.tenant_id AND e.request_id=NEW.request_id AND e.id=NEW.event_id AND e.status=NEW.result->>'status'))))
 THEN RAISE EXCEPTION 'Publication result reference mismatch' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER publication_node_result_guard BEFORE INSERT OR UPDATE OR DELETE ON marketplace_publication_node_results
 FOR EACH ROW EXECUTE FUNCTION guard_publication_node_result();
