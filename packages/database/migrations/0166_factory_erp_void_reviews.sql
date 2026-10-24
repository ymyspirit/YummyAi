-- A review records an operator's conclusion about one original void observation.
-- It changes no binding, production, QC, quantity, capacity, stock or shipment.
CREATE TABLE factory_erp_void_reviews (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES organizations(id),factory_id uuid NOT NULL,binding_id uuid NOT NULL,
 observation_id uuid NOT NULL,review_revision integer NOT NULL,previous_review_id uuid,
 source_import_id uuid NOT NULL,source_row_number integer NOT NULL,outcome text NOT NULL,reason_code text NOT NULL,
 idempotency_key uuid NOT NULL,request_canonical text NOT NULL,request_checksum text NOT NULL,input jsonb NOT NULL,result jsonb NOT NULL,
 created_by uuid NOT NULL REFERENCES app_users(id),creation_transaction_id text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT factory_erp_void_reviews_factory_fk FOREIGN KEY(tenant_id,factory_id) REFERENCES fulfillment_factories(tenant_id,id),
 CONSTRAINT factory_erp_void_reviews_binding_fk FOREIGN KEY(tenant_id,binding_id) REFERENCES factory_erp_bindings(tenant_id,id),
 CONSTRAINT factory_erp_void_reviews_observation_fk FOREIGN KEY(tenant_id,observation_id) REFERENCES factory_erp_observations(tenant_id,id),
 CONSTRAINT factory_erp_void_reviews_source_fk FOREIGN KEY(tenant_id,source_import_id) REFERENCES factory_erp_imports(tenant_id,id),
 CONSTRAINT factory_erp_void_reviews_id CHECK(substring(id::text from 15 for 1)='7'),
 CONSTRAINT factory_erp_void_reviews_revision_shape CHECK(review_revision BETWEEN 1 AND 1000000 AND((review_revision=1)=(previous_review_id IS NULL))),
 CONSTRAINT factory_erp_void_reviews_row CHECK(source_row_number BETWEEN 2 AND 5001),
 CONSTRAINT factory_erp_void_reviews_outcome CHECK(outcome IN('confirmed_active','confirmed_voided','export_record_incorrect','followup_required')
  AND reason_code IN('factory_contact','corrected_export','conflicting_records','binding_mismatch','needs_factory_confirmation')
  AND((outcome='followup_required')=(reason_code IN('conflicting_records','binding_mismatch','needs_factory_confirmation')))),
 CONSTRAINT factory_erp_void_reviews_hash CHECK(request_checksum=encode(sha256(convert_to(request_canonical,'UTF8')),'hex'))
);
CREATE UNIQUE INDEX factory_erp_void_reviews_scope ON factory_erp_void_reviews(tenant_id,id);
CREATE UNIQUE INDEX factory_erp_void_reviews_request ON factory_erp_void_reviews(tenant_id,idempotency_key);
CREATE UNIQUE INDEX factory_erp_void_reviews_revision ON factory_erp_void_reviews(tenant_id,observation_id,review_revision);
CREATE UNIQUE INDEX factory_erp_void_reviews_previous ON factory_erp_void_reviews(tenant_id,previous_review_id) WHERE previous_review_id IS NOT NULL;
CREATE UNIQUE INDEX factory_erp_void_reviews_birth ON factory_erp_void_reviews(tenant_id,creation_transaction_id);
CREATE INDEX factory_erp_void_reviews_binding ON factory_erp_void_reviews(tenant_id,binding_id,id);
ALTER TABLE factory_erp_void_reviews ADD CONSTRAINT factory_erp_void_reviews_previous_fk
 FOREIGN KEY(tenant_id,previous_review_id) REFERENCES factory_erp_void_reviews(tenant_id,id);
ALTER TABLE factory_erp_void_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE factory_erp_void_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON factory_erp_void_reviews
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT ON factory_erp_void_reviews TO yummyai_app;
CREATE TRIGGER factory_erp_void_review_immutable BEFORE UPDATE OR DELETE ON factory_erp_void_reviews
 FOR EACH ROW EXECUTE FUNCTION factory_capacity_immutable();
--> statement-breakpoint
CREATE FUNCTION factory_erp_void_observation_valid(value jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE k text;
BEGIN
 IF jsonb_typeof(value) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
 IF NOT value?&ARRAY['id','sequence','importId','rowNumber','rowChecksum','fileChecksum','previewChecksum','recordedAt']
  OR value-ARRAY['id','sequence','importId','rowNumber','rowChecksum','fileChecksum','previewChecksum','recordedAt']<>'{}'::jsonb
  OR jsonb_typeof(value->'sequence') IS DISTINCT FROM 'number' OR value->>'sequence'!~'^\d+$'
  OR(value->>'sequence')::numeric NOT BETWEEN 1 AND 9007199254740991
  OR jsonb_typeof(value->'rowNumber') IS DISTINCT FROM 'number' OR value->>'rowNumber'!~'^\d+$'
  OR(value->>'rowNumber')::integer NOT BETWEEN 2 AND 5001 OR NOT factory_erp_binding_timestamp_valid(value->'recordedAt') THEN RETURN false;END IF;
 FOREACH k IN ARRAY ARRAY['id','importId'] LOOP
  IF jsonb_typeof(value->k) IS DISTINCT FROM 'string' OR value->>k!~'^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' THEN RETURN false;END IF;
 END LOOP;
 FOREACH k IN ARRAY ARRAY['rowChecksum','fileChecksum','previewChecksum'] LOOP
  IF jsonb_typeof(value->k) IS DISTINCT FROM 'string' OR value->>k!~'^[a-f0-9]{64}$' THEN RETURN false;END IF;
 END LOOP;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION factory_erp_void_observation_valid(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION factory_erp_void_observation_valid(jsonb) TO yummyai_app;
CREATE FUNCTION factory_erp_void_review_input_valid(value jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE k text;source_value jsonb;
BEGIN
 IF jsonb_typeof(value) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
 IF NOT value?&ARRAY['expectedBindingRevision','expectedItemsChecksum','expectedObservationSequence','observation','expectedPreviousReviewId','source','outcome','reasonCode','provenance','confirmed','idempotencyKey']
  OR value-ARRAY['expectedBindingRevision','expectedItemsChecksum','expectedObservationSequence','observation','expectedPreviousReviewId','source','outcome','reasonCode','provenance','confirmed','idempotencyKey']<>'{}'::jsonb
  OR value->'confirmed' IS DISTINCT FROM 'true'::jsonb OR value->'provenance' IS DISTINCT FROM '"operator_attested"'::jsonb
  OR jsonb_typeof(value->'outcome') IS DISTINCT FROM 'string' OR value->>'outcome' NOT IN('confirmed_active','confirmed_voided','export_record_incorrect','followup_required')
  OR jsonb_typeof(value->'reasonCode') IS DISTINCT FROM 'string' OR value->>'reasonCode' NOT IN('factory_contact','corrected_export','conflicting_records','binding_mismatch','needs_factory_confirmation')
  OR((value->>'outcome'='followup_required') IS DISTINCT FROM(value->>'reasonCode' IN('conflicting_records','binding_mismatch','needs_factory_confirmation')))
  OR jsonb_typeof(value->'expectedBindingRevision') IS DISTINCT FROM 'number' OR value->>'expectedBindingRevision'!~'^\d+$'
  OR(value->>'expectedBindingRevision')::integer NOT BETWEEN 1 AND 1000000
  OR jsonb_typeof(value->'expectedObservationSequence') IS DISTINCT FROM 'number' OR value->>'expectedObservationSequence'!~'^\d+$'
  OR(value->>'expectedObservationSequence')::numeric NOT BETWEEN 1 AND 9007199254740991
  OR jsonb_typeof(value->'expectedItemsChecksum') IS DISTINCT FROM 'string' OR value->>'expectedItemsChecksum'!~'^[a-f0-9]{64}$'
  OR NOT factory_erp_void_observation_valid(value->'observation') THEN RETURN false;END IF;
 IF(value->'observation'->>'sequence')::numeric>(value->>'expectedObservationSequence')::numeric THEN RETURN false;END IF;
 IF value->'expectedPreviousReviewId' IS DISTINCT FROM 'null'::jsonb AND(jsonb_typeof(value->'expectedPreviousReviewId') IS DISTINCT FROM 'string'
  OR value->>'expectedPreviousReviewId'!~'^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$') THEN RETURN false;END IF;
 IF jsonb_typeof(value->'idempotencyKey') IS DISTINCT FROM 'string' OR value->>'idempotencyKey'!~'^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' THEN RETURN false;END IF;
 source_value:=value->'source';
 IF jsonb_typeof(source_value) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
 IF NOT source_value?&ARRAY['importId','fileChecksum','previewChecksum','rowNumber'] OR source_value-ARRAY['importId','fileChecksum','previewChecksum','rowNumber']<>'{}'::jsonb
  OR jsonb_typeof(source_value->'importId') IS DISTINCT FROM 'string' OR source_value->>'importId'!~'^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
  OR jsonb_typeof(source_value->'rowNumber') IS DISTINCT FROM 'number' OR source_value->>'rowNumber'!~'^\d+$'
  OR(source_value->>'rowNumber')::integer NOT BETWEEN 2 AND 5001 THEN RETURN false;END IF;
 FOREACH k IN ARRAY ARRAY['fileChecksum','previewChecksum'] LOOP
  IF jsonb_typeof(source_value->k) IS DISTINCT FROM 'string' OR source_value->>k!~'^[a-f0-9]{64}$' THEN RETURN false;END IF;
 END LOOP;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION factory_erp_void_review_input_valid(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION factory_erp_void_review_input_valid(jsonb) TO yummyai_app;
--> statement-breakpoint
CREATE FUNCTION guard_factory_erp_void_review() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE b factory_erp_bindings;observed factory_erp_observations;source_row factory_erp_imports;original_source factory_erp_imports;previous_review factory_erp_void_reviews;
 root_source_id uuid;void_source_id uuid;claim jsonb;original_claim jsonb;actual_sequence bigint;actual_items bigint;actual_quantity bigint;expected_canonical text;
BEGIN
 PERFORM factory_erp_require_authority(NEW.tenant_id,NEW.created_by);
 IF NOT factory_erp_void_review_input_valid(NEW.input) THEN RAISE EXCEPTION 'factory_erp_void_review_request_invalid' USING ERRCODE='23514';END IF;
 IF NEW.idempotency_key::text IS DISTINCT FROM NEW.input->>'idempotencyKey'
  OR NEW.observation_id::text IS DISTINCT FROM NEW.input->'observation'->>'id' OR NEW.source_import_id::text IS DISTINCT FROM NEW.input->'source'->>'importId'
  OR NEW.source_row_number IS DISTINCT FROM(NEW.input->'source'->>'rowNumber')::integer OR NEW.outcome IS DISTINCT FROM NEW.input->>'outcome'
  OR NEW.reason_code IS DISTINCT FROM NEW.input->>'reasonCode' OR NEW.previous_review_id::text IS DISTINCT FROM NEW.input->>'expectedPreviousReviewId'
  THEN RAISE EXCEPTION 'factory_erp_void_review_request_invalid' USING ERRCODE='23514';END IF;
 expected_canonical:=invoice_reconciliation_canonical(jsonb_build_object('version',1,'operation','factory-erp-void-review','bindingId',NEW.binding_id,'input',NEW.input));
 IF NEW.request_canonical IS DISTINCT FROM expected_canonical OR NEW.request_checksum IS DISTINCT FROM encode(sha256(convert_to(expected_canonical,'UTF8')),'hex')
  THEN RAISE EXCEPTION 'factory_erp_void_review_request_invalid' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM factory_erp_void_reviews r WHERE r.tenant_id=NEW.tenant_id AND r.creation_transaction_id=pg_current_xact_id()::text)
  THEN RAISE EXCEPTION 'factory_erp_void_review_birth_required' USING ERRCODE='23514';END IF;
 SELECT a.import_id INTO root_source_id FROM factory_erp_bindings current_binding JOIN factory_erp_applications a ON a.tenant_id=current_binding.tenant_id AND a.id=current_binding.application_id
  WHERE current_binding.tenant_id=NEW.tenant_id AND current_binding.id=NEW.binding_id;
 SELECT import_id INTO void_source_id FROM factory_erp_observations WHERE tenant_id=NEW.tenant_id AND id=NEW.observation_id;
 PERFORM 1 FROM factory_erp_imports s WHERE s.tenant_id=NEW.tenant_id AND s.id=ANY(ARRAY[root_source_id,void_source_id,NEW.source_import_id]) ORDER BY s.id FOR SHARE;
 PERFORM pg_advisory_xact_lock(hashtextextended('factory-erp-apply:'||NEW.tenant_id::text||':'||NEW.factory_id::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('factory-erp-void-review:'||NEW.tenant_id::text||':'||NEW.idempotency_key::text,0));
 SELECT * INTO b FROM factory_erp_bindings WHERE tenant_id=NEW.tenant_id AND id=NEW.binding_id FOR UPDATE;
 SELECT coalesce(max(sequence),0) INTO actual_sequence FROM factory_erp_observations WHERE tenant_id=NEW.tenant_id AND binding_id=NEW.binding_id;
 SELECT count(*),coalesce(sum(quantity),0) INTO actual_items,actual_quantity FROM factory_erp_binding_items WHERE tenant_id=NEW.tenant_id AND binding_id=NEW.binding_id;
 IF b.id IS NULL OR b.factory_id IS DISTINCT FROM NEW.factory_id OR b.released_by IS NOT NULL
  OR b.revision IS DISTINCT FROM(NEW.input->>'expectedBindingRevision')::integer OR b.items_checksum IS DISTINCT FROM NEW.input->>'expectedItemsChecksum'
  OR actual_sequence NOT BETWEEN 1 AND 9007199254740991 OR actual_sequence IS DISTINCT FROM(NEW.input->>'expectedObservationSequence')::bigint
  OR actual_items NOT BETWEEN 1 AND 50 OR actual_quantity IS DISTINCT FROM b.quantity::bigint
  OR EXISTS(SELECT 1 FROM factory_erp_binding_items i WHERE i.tenant_id=NEW.tenant_id AND i.binding_id=b.id AND i.released_by IS NOT NULL)
  OR b.items_checksum IS DISTINCT FROM encode(sha256(convert_to(invoice_reconciliation_canonical(factory_erp_binding_items_value(NEW.tenant_id,b.id)),'UTF8')),'hex')
  THEN RAISE EXCEPTION 'factory_erp_void_review_basis_changed' USING ERRCODE='23514';END IF;
 -- No later supplier UPDATE is needed by this owner. Its active-state locks
 -- follow the factory slot rather than blocking an owner waiting for that slot.
 PERFORM 1 FROM fulfillment_factories f JOIN fulfillment_suppliers s ON s.tenant_id=f.tenant_id AND s.id=f.supplier_id
  WHERE f.tenant_id=NEW.tenant_id AND f.id=b.factory_id AND f.status='active' AND s.status='active' FOR SHARE OF f,s;
 IF NOT FOUND THEN RAISE EXCEPTION 'factory_erp_void_review_source_required' USING ERRCODE='23514';END IF;
 SELECT * INTO observed FROM factory_erp_observations WHERE tenant_id=NEW.tenant_id AND id=NEW.observation_id;
 SELECT * INTO original_source FROM factory_erp_imports WHERE tenant_id=NEW.tenant_id AND id=observed.import_id;
 IF observed.id IS NULL OR observed.binding_id IS DISTINCT FROM b.id OR observed.raw_status IS DISTINCT FROM '已作废' OR original_source.id IS NULL
  OR original_source.factory_id IS DISTINCT FROM b.factory_id OR observed.sequence IS DISTINCT FROM(NEW.input->'observation'->>'sequence')::bigint
  OR observed.import_id::text IS DISTINCT FROM NEW.input->'observation'->>'importId' OR observed.row_number IS DISTINCT FROM(NEW.input->'observation'->>'rowNumber')::integer
  OR observed.row_checksum IS DISTINCT FROM NEW.input->'observation'->>'rowChecksum' OR original_source.file_checksum IS DISTINCT FROM NEW.input->'observation'->>'fileChecksum'
  OR original_source.preview_checksum IS DISTINCT FROM NEW.input->'observation'->>'previewChecksum'
  OR date_trunc('milliseconds',observed.created_at) IS DISTINCT FROM(NEW.input->'observation'->>'recordedAt')::timestamptz
  THEN RAISE EXCEPTION 'factory_erp_void_review_basis_changed' USING ERRCODE='23514';END IF;
 SELECT c INTO original_claim FROM jsonb_array_elements(original_source.source_claims) c WHERE(c->>'rowNumber')::integer=observed.row_number;
 IF original_claim IS NULL OR original_claim->>'rawStatus' IS DISTINCT FROM '已作废' OR original_claim->>'rowChecksum' IS DISTINCT FROM observed.row_checksum
  OR original_claim->>'externalKey' IS DISTINCT FROM b.external_key OR original_claim->'quantity' IS DISTINCT FROM to_jsonb(b.quantity)
  THEN RAISE EXCEPTION 'factory_erp_void_review_basis_changed' USING ERRCODE='23514';END IF;
 SELECT * INTO source_row FROM factory_erp_imports WHERE tenant_id=NEW.tenant_id AND id=NEW.source_import_id;
 IF source_row.id IS NULL OR source_row.factory_id IS DISTINCT FROM b.factory_id OR source_row.expires_at<=factory_erp_source_now()
  OR source_row.encrypted_payload IS NULL OR source_row.private_redacted_at IS NOT NULL
  OR source_row.file_checksum IS DISTINCT FROM NEW.input->'source'->>'fileChecksum' OR source_row.preview_checksum IS DISTINCT FROM NEW.input->'source'->>'previewChecksum'
  THEN RAISE EXCEPTION 'factory_erp_void_review_source_required' USING ERRCODE='23514';END IF;
 SELECT c INTO claim FROM jsonb_array_elements(source_row.source_claims) c WHERE(c->>'rowNumber')::integer=NEW.source_row_number;
 IF claim IS NULL OR claim->>'externalKey' IS DISTINCT FROM b.external_key OR claim->'quantity' IS DISTINCT FROM to_jsonb(b.quantity)
  OR claim->>'rawStatus' IS NULL OR claim->>'rawStatus' NOT IN('已审核','已出库','已作废')
  OR NEW.reason_code='corrected_export' AND((NEW.outcome IN('confirmed_active','export_record_incorrect') AND claim->>'rawStatus' NOT IN('已审核','已出库'))
   OR(NEW.outcome='confirmed_voided' AND claim->>'rawStatus'<>'已作废'))
  THEN RAISE EXCEPTION 'factory_erp_void_review_source_required' USING ERRCODE='23514';END IF;
 SELECT * INTO previous_review FROM factory_erp_void_reviews WHERE tenant_id=NEW.tenant_id AND observation_id=NEW.observation_id ORDER BY review_revision DESC LIMIT 1;
 IF NEW.previous_review_id IS DISTINCT FROM previous_review.id OR NEW.review_revision IS DISTINCT FROM coalesce(previous_review.review_revision,0)+1
  OR previous_review.id IS NOT NULL AND(previous_review.binding_id IS DISTINCT FROM NEW.binding_id OR previous_review.factory_id IS DISTINCT FROM NEW.factory_id)
  THEN RAISE EXCEPTION 'factory_erp_void_review_previous_changed' USING ERRCODE='23514';END IF;
 -- This also rejects old audits whose 32-bit xmin could match after wraparound.
 IF EXISTS(SELECT 1 FROM audit_events a WHERE a.tenant_id=NEW.tenant_id AND a.entity_type='factory_erp_void_review' AND a.entity_id=NEW.id AND a.action='factory_erp.void_reviewed' AND a.result='success')
  THEN RAISE EXCEPTION 'factory_erp_void_review_sealed' USING ERRCODE='23514';END IF;
 NEW.creation_transaction_id:=pg_current_xact_id()::text;
 RETURN NEW;
END $$;
CREATE TRIGGER factory_erp_void_review_guard BEFORE INSERT ON factory_erp_void_reviews FOR EACH ROW EXECUTE FUNCTION guard_factory_erp_void_review();
--> statement-breakpoint
CREATE FUNCTION require_factory_erp_void_review() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE output jsonb;expected_output jsonb;xid text:=pg_current_xact_id()::text;
BEGIN
 IF NEW.creation_transaction_id IS DISTINCT FROM xid THEN RAISE EXCEPTION 'factory_erp_void_review_birth_required' USING ERRCODE='23514';END IF;
 output:=NEW.result;
 IF jsonb_typeof(output) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'factory_erp_void_review_result_invalid' USING ERRCODE='23514';END IF;
 IF NOT factory_erp_binding_timestamp_valid(output->'createdAt') THEN RAISE EXCEPTION 'factory_erp_void_review_result_invalid' USING ERRCODE='23514';END IF;
 expected_output:=jsonb_build_object('id',NEW.id,'bindingId',NEW.binding_id,'factoryId',NEW.factory_id,'observation',NEW.input->'observation','source',NEW.input->'source',
  'originalBindingRevision',NEW.input->'expectedBindingRevision','originalItemsChecksum',NEW.input->'expectedItemsChecksum','originalObservationSequence',NEW.input->'expectedObservationSequence',
  'reviewRevision',NEW.review_revision,'previousReviewId',NEW.previous_review_id,'outcome',NEW.outcome,'reasonCode',NEW.reason_code,'provenance','operator_attested',
  'requestChecksum',NEW.request_checksum,'createdAt',output->'createdAt');
 IF output IS DISTINCT FROM expected_output OR(output->>'createdAt')::timestamptz IS DISTINCT FROM NEW.created_at
  THEN RAISE EXCEPTION 'factory_erp_void_review_result_invalid' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM audit_events a WHERE a.tenant_id=NEW.tenant_id AND a.entity_id=NEW.id AND a.entity_type='factory_erp_void_review'
  AND a.action='factory_erp.void_reviewed' AND a.actor_user_id=NEW.created_by AND a.result='success' AND a.xmin::text=(xid::numeric%4294967296)::bigint::text)
  THEN RAISE EXCEPTION 'factory_erp_void_review_audit_required' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER factory_erp_void_review_closure AFTER INSERT ON factory_erp_void_reviews DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_factory_erp_void_review();
