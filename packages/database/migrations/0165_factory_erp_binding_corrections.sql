-- Binding changes append an explicit operator decision. They never alter a
-- production, QC, capacity, shipment, source claim or original observation.
ALTER TABLE factory_erp_bindings ADD COLUMN revision integer NOT NULL DEFAULT 1;
ALTER TABLE factory_erp_bindings ADD COLUMN previous_binding_id uuid;
ALTER TABLE factory_erp_bindings ADD COLUMN released_by uuid;
ALTER TABLE factory_erp_binding_items ADD COLUMN released_by uuid;
ALTER TABLE factory_erp_bindings ADD CONSTRAINT factory_erp_bindings_revision_shape
 CHECK(revision BETWEEN 1 AND 1000000 AND((revision=1)=(previous_binding_id IS NULL)));
ALTER TABLE factory_erp_bindings ADD CONSTRAINT factory_erp_bindings_previous_fk
 FOREIGN KEY(tenant_id,previous_binding_id) REFERENCES factory_erp_bindings(tenant_id,id);
DROP INDEX factory_erp_bindings_external;
DROP INDEX factory_erp_binding_items_delivery;
DROP INDEX factory_erp_binding_items_version;
CREATE UNIQUE INDEX factory_erp_bindings_external ON factory_erp_bindings(tenant_id,factory_id,external_key) WHERE released_by IS NULL;
CREATE UNIQUE INDEX factory_erp_binding_items_delivery ON factory_erp_binding_items(tenant_id,delivery_item_id) WHERE released_by IS NULL;
CREATE UNIQUE INDEX factory_erp_binding_items_version ON factory_erp_binding_items(tenant_id,production_order_id,production_version_id) WHERE released_by IS NULL;
CREATE UNIQUE INDEX factory_erp_bindings_revision ON factory_erp_bindings(tenant_id,factory_id,external_key,revision);
CREATE UNIQUE INDEX factory_erp_bindings_previous ON factory_erp_bindings(tenant_id,previous_binding_id) WHERE previous_binding_id IS NOT NULL;
--> statement-breakpoint
CREATE TABLE factory_erp_binding_changes (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES organizations(id),factory_id uuid NOT NULL,binding_id uuid NOT NULL,
 source_import_id uuid NOT NULL,source_row_number integer NOT NULL,action text NOT NULL,
 replacement_binding_id uuid,replacement_application_id uuid,idempotency_key uuid NOT NULL,
 request_canonical text NOT NULL,request_checksum text NOT NULL,input jsonb NOT NULL,result jsonb NOT NULL,
 created_by uuid NOT NULL REFERENCES app_users(id),creation_transaction_id text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT factory_erp_binding_changes_factory_fk FOREIGN KEY(tenant_id,factory_id) REFERENCES fulfillment_factories(tenant_id,id),
 CONSTRAINT factory_erp_binding_changes_binding_fk FOREIGN KEY(tenant_id,binding_id) REFERENCES factory_erp_bindings(tenant_id,id),
 CONSTRAINT factory_erp_binding_changes_source_fk FOREIGN KEY(tenant_id,source_import_id) REFERENCES factory_erp_imports(tenant_id,id),
 CONSTRAINT factory_erp_binding_changes_replacement_fk FOREIGN KEY(tenant_id,replacement_binding_id) REFERENCES factory_erp_bindings(tenant_id,id) DEFERRABLE INITIALLY DEFERRED,
 CONSTRAINT factory_erp_binding_changes_application_fk FOREIGN KEY(tenant_id,replacement_application_id) REFERENCES factory_erp_applications(tenant_id,id) DEFERRABLE INITIALLY DEFERRED,
 CONSTRAINT factory_erp_binding_changes_action CHECK(action IN('release','correct') AND(action='correct')=(replacement_binding_id IS NOT NULL) AND(action='correct')=(replacement_application_id IS NOT NULL)),
 CONSTRAINT factory_erp_binding_changes_row CHECK(source_row_number BETWEEN 2 AND 5001),
 CONSTRAINT factory_erp_binding_changes_hash CHECK(request_checksum=encode(sha256(convert_to(request_canonical,'UTF8')),'hex'))
);
CREATE UNIQUE INDEX factory_erp_binding_changes_scope ON factory_erp_binding_changes(tenant_id,id);
CREATE UNIQUE INDEX factory_erp_binding_changes_request ON factory_erp_binding_changes(tenant_id,idempotency_key);
CREATE UNIQUE INDEX factory_erp_binding_changes_binding ON factory_erp_binding_changes(tenant_id,binding_id);
CREATE UNIQUE INDEX factory_erp_binding_changes_birth ON factory_erp_binding_changes(tenant_id,creation_transaction_id);
CREATE INDEX factory_erp_binding_changes_factory ON factory_erp_binding_changes(tenant_id,factory_id,id);
ALTER TABLE factory_erp_binding_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE factory_erp_binding_changes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON factory_erp_binding_changes
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT ON factory_erp_binding_changes TO yummyai_app;
CREATE TRIGGER factory_erp_binding_change_immutable BEFORE UPDATE OR DELETE ON factory_erp_binding_changes
 FOR EACH ROW EXECUTE FUNCTION factory_capacity_immutable();
ALTER TABLE factory_erp_bindings ADD CONSTRAINT factory_erp_bindings_release_fk
 FOREIGN KEY(tenant_id,released_by) REFERENCES factory_erp_binding_changes(tenant_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE factory_erp_binding_items ADD CONSTRAINT factory_erp_binding_items_release_fk
 FOREIGN KEY(tenant_id,released_by) REFERENCES factory_erp_binding_changes(tenant_id,id) DEFERRABLE INITIALLY DEFERRED;
GRANT UPDATE(released_by) ON factory_erp_bindings,factory_erp_binding_items TO yummyai_app;
--> statement-breakpoint
CREATE FUNCTION factory_erp_association_valid(value jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE k text;n integer;
BEGIN
 IF jsonb_typeof(value) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
 IF NOT value?&ARRAY['expectedActiveBindingId','expectedRevision','expectedReleaseId','confirmed']
  OR value-ARRAY['expectedActiveBindingId','expectedRevision','expectedReleaseId','confirmed']<>'{}'::jsonb
  OR value->'confirmed' IS DISTINCT FROM 'true'::jsonb OR jsonb_typeof(value->'expectedRevision') IS DISTINCT FROM 'number'
  OR value->>'expectedRevision'!~'^\d+$' THEN RETURN false;END IF;
 n:=(value->>'expectedRevision')::integer;
 IF n NOT BETWEEN 0 AND 1000000 THEN RETURN false;END IF;
 FOREACH k IN ARRAY ARRAY['expectedActiveBindingId','expectedReleaseId'] LOOP
  IF value->k IS DISTINCT FROM 'null'::jsonb AND(jsonb_typeof(value->k) IS DISTINCT FROM 'string'
   OR value->>k!~'^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$') THEN RETURN false;END IF;
 END LOOP;
 RETURN CASE WHEN n=0 THEN value->'expectedActiveBindingId'='null'::jsonb AND value->'expectedReleaseId'='null'::jsonb
  WHEN value->'expectedActiveBindingId'<>'null'::jsonb THEN value->'expectedReleaseId'='null'::jsonb
  ELSE value->'expectedReleaseId'<>'null'::jsonb END;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION factory_erp_association_valid(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION factory_erp_association_valid(jsonb) TO yummyai_app;
CREATE OR REPLACE FUNCTION factory_erp_apply_input_valid(value jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE r jsonb;i jsonb;row_numbers integer[]:=ARRAY[]::integer[];items text[]:=ARRAY[]::text[];productions text[]:=ARRAY[]::text[];k text;
BEGIN
 IF jsonb_typeof(value) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
 IF NOT value?&ARRAY['fileChecksum','previewChecksum','idempotencyKey','rows','confirmed'] OR value-ARRAY['fileChecksum','previewChecksum','idempotencyKey','rows','confirmed']<>'{}'::jsonb
  OR value->'confirmed' IS DISTINCT FROM 'true'::jsonb THEN RETURN false;END IF;
 FOREACH k IN ARRAY ARRAY['fileChecksum','previewChecksum'] LOOP
  IF jsonb_typeof(value->k) IS DISTINCT FROM 'string' OR value->>k!~'^[a-f0-9]{64}$' THEN RETURN false;END IF;
 END LOOP;
 IF jsonb_typeof(value->'idempotencyKey') IS DISTINCT FROM 'string' OR value->>'idempotencyKey'!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
  OR jsonb_typeof(value->'rows') IS DISTINCT FROM 'array' THEN RETURN false;END IF;
 IF jsonb_array_length(value->'rows') NOT BETWEEN 1 AND 5000 THEN RETURN false;END IF;
 FOR r IN SELECT x FROM jsonb_array_elements(value->'rows') x LOOP
  IF jsonb_typeof(r) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
  IF NOT r?&ARRAY['rowNumber','items','wholeGroupConfirmed'] OR r-ARRAY['rowNumber','items','wholeGroupConfirmed','association']<>'{}'::jsonb
   OR jsonb_typeof(r->'rowNumber') IS DISTINCT FROM 'number' OR r->>'rowNumber'!~'^\d+$' OR(r->>'rowNumber')::integer NOT BETWEEN 2 AND 5001
   OR(r->>'rowNumber')::integer=ANY(row_numbers) OR r->'wholeGroupConfirmed' IS DISTINCT FROM 'true'::jsonb OR jsonb_typeof(r->'items') IS DISTINCT FROM 'array'
   OR r?'association' AND NOT factory_erp_association_valid(r->'association') THEN RETURN false;END IF;
  IF jsonb_array_length(r->'items') NOT BETWEEN 1 AND 50 THEN RETURN false;END IF;
  row_numbers:=array_append(row_numbers,(r->>'rowNumber')::integer);
  FOR i IN SELECT x FROM jsonb_array_elements(r->'items') x LOOP
   IF jsonb_typeof(i) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
   IF NOT i?&ARRAY['deliveryItemId','productionOrderId','productionVersionId','fileChecksum','manufacturingChecksum'] OR i-ARRAY['deliveryItemId','productionOrderId','productionVersionId','fileChecksum','manufacturingChecksum']<>'{}'::jsonb THEN RETURN false;END IF;
   FOREACH k IN ARRAY ARRAY['deliveryItemId','productionOrderId','productionVersionId'] LOOP
    IF jsonb_typeof(i->k) IS DISTINCT FROM 'string' OR i->>k!~'^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' THEN RETURN false;END IF;
   END LOOP;
   FOREACH k IN ARRAY ARRAY['fileChecksum','manufacturingChecksum'] LOOP
    IF jsonb_typeof(i->k) IS DISTINCT FROM 'string' OR i->>k!~'^[a-f0-9]{64}$' THEN RETURN false;END IF;
   END LOOP;
   IF i->>'deliveryItemId'=ANY(items) OR i->>'productionOrderId'=ANY(productions) THEN RETURN false;END IF;
   items:=array_append(items,i->>'deliveryItemId');productions:=array_append(productions,i->>'productionOrderId');
  END LOOP;
 END LOOP;RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
--> statement-breakpoint
CREATE FUNCTION factory_erp_binding_items_value(tenant uuid,binding_identity uuid) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('deliveryItemId',i.delivery_item_id,'productionOrderId',i.production_order_id,
  'productionVersionId',i.production_version_id,'fileChecksum',i.file_checksum,'manufacturingChecksum',i.manufacturing_checksum)
  ORDER BY i.delivery_item_id::text COLLATE "C"),'[]'::jsonb) FROM factory_erp_binding_items i WHERE i.tenant_id=tenant AND i.binding_id=binding_identity
$$;
REVOKE ALL ON FUNCTION factory_erp_binding_items_value(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION factory_erp_binding_items_value(uuid,uuid) TO yummyai_app;
CREATE FUNCTION factory_erp_binding_change_input_valid(value jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE source_value jsonb;k text;
BEGIN
 IF jsonb_typeof(value) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
 IF NOT value?&ARRAY['expectedRevision','expectedItemsChecksum','expectedObservationSequence','source','reasonCode','idempotencyKey','confirmed','action']
  OR value-ARRAY['expectedRevision','expectedItemsChecksum','expectedObservationSequence','source','reasonCode','idempotencyKey','confirmed','action','items','wholeGroupConfirmed']<>'{}'::jsonb
  OR value->'confirmed' IS DISTINCT FROM 'true'::jsonb OR jsonb_typeof(value->'action') IS DISTINCT FROM 'string' OR value->>'action' NOT IN('release','correct')
  OR jsonb_typeof(value->'reasonCode') IS DISTINCT FROM 'string' OR value->>'reasonCode' NOT IN('wrong_group','factory_number_reused','duplicate_binding','operator_confirmed_change')
  OR jsonb_typeof(value->'expectedRevision') IS DISTINCT FROM 'number' OR value->>'expectedRevision'!~'^\d+$'
  OR(value->>'expectedRevision')::integer NOT BETWEEN 1 AND 1000000
  OR jsonb_typeof(value->'expectedObservationSequence') IS DISTINCT FROM 'number' OR value->>'expectedObservationSequence'!~'^\d+$'
  OR(value->>'expectedObservationSequence')::numeric NOT BETWEEN 0 AND 9007199254740991
  OR jsonb_typeof(value->'expectedItemsChecksum') IS DISTINCT FROM 'string' OR value->>'expectedItemsChecksum'!~'^[a-f0-9]{64}$'
  OR jsonb_typeof(value->'idempotencyKey') IS DISTINCT FROM 'string' OR value->>'idempotencyKey'!~'^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' THEN RETURN false;END IF;
 source_value:=value->'source';
 IF jsonb_typeof(source_value) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
 IF NOT source_value?&ARRAY['importId','fileChecksum','previewChecksum','rowNumber'] OR source_value-ARRAY['importId','fileChecksum','previewChecksum','rowNumber']<>'{}'::jsonb
  OR jsonb_typeof(source_value->'importId') IS DISTINCT FROM 'string' OR source_value->>'importId'!~'^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
  OR jsonb_typeof(source_value->'rowNumber') IS DISTINCT FROM 'number' OR source_value->>'rowNumber'!~'^\d+$'
  OR(source_value->>'rowNumber')::integer NOT BETWEEN 2 AND 5001 THEN RETURN false;END IF;
 FOREACH k IN ARRAY ARRAY['fileChecksum','previewChecksum'] LOOP
  IF jsonb_typeof(source_value->k) IS DISTINCT FROM 'string' OR source_value->>k!~'^[a-f0-9]{64}$' THEN RETURN false;END IF;
 END LOOP;
 IF value->>'action'='release' THEN RETURN NOT(value?'items' OR value?'wholeGroupConfirmed');END IF;
 RETURN value?&ARRAY['items','wholeGroupConfirmed'] AND value->'wholeGroupConfirmed'='true'::jsonb
  AND factory_erp_apply_input_valid(jsonb_build_object('fileChecksum',source_value->'fileChecksum','previewChecksum',source_value->'previewChecksum',
   'idempotencyKey',value->'idempotencyKey','confirmed',true,'rows',jsonb_build_array(jsonb_build_object('rowNumber',source_value->'rowNumber','items',value->'items','wholeGroupConfirmed',true))));
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION factory_erp_binding_change_input_valid(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION factory_erp_binding_change_input_valid(jsonb) TO yummyai_app;
CREATE FUNCTION factory_erp_binding_timestamp_valid(value jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
BEGIN
 IF jsonb_typeof(value) IS DISTINCT FROM 'string' OR(value#>>'{}')!~'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$' THEN RETURN false;END IF;
 PERFORM(value#>>'{}')::timestamptz;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION factory_erp_binding_timestamp_valid(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION factory_erp_binding_timestamp_valid(jsonb) TO yummyai_app;
CREATE FUNCTION factory_erp_binding_application_result_valid(value jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE k text;observation jsonb;
BEGIN
 IF jsonb_typeof(value) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
 IF NOT value?&ARRAY['id','importId','fileChecksum','previewChecksum','requestChecksum','createdAt','appliedRows','observations']
  OR value-ARRAY['id','importId','fileChecksum','previewChecksum','requestChecksum','createdAt','appliedRows','observations']<>'{}'::jsonb
  OR value->'appliedRows' IS DISTINCT FROM '1'::jsonb OR NOT factory_erp_binding_timestamp_valid(value->'createdAt')
  OR jsonb_typeof(value->'observations') IS DISTINCT FROM 'array' THEN RETURN false;END IF;
 IF jsonb_array_length(value->'observations')<>1 THEN RETURN false;END IF;
 FOREACH k IN ARRAY ARRAY['id','importId'] LOOP
  IF jsonb_typeof(value->k) IS DISTINCT FROM 'string' OR value->>k!~'^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' THEN RETURN false;END IF;
 END LOOP;
 FOREACH k IN ARRAY ARRAY['fileChecksum','previewChecksum','requestChecksum'] LOOP
  IF jsonb_typeof(value->k) IS DISTINCT FROM 'string' OR value->>k!~'^[a-f0-9]{64}$' THEN RETURN false;END IF;
 END LOOP;
 observation:=value->'observations'->0;
 IF jsonb_typeof(observation) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
 IF NOT observation?&ARRAY['rowNumber','bindingId','observationId','disposition','status']
  OR observation-ARRAY['rowNumber','bindingId','observationId','disposition','status']<>'{}'::jsonb
  OR jsonb_typeof(observation->'rowNumber') IS DISTINCT FROM 'number' OR observation->>'rowNumber'!~'^\d+$' OR(observation->>'rowNumber')::integer NOT BETWEEN 2 AND 5001
  OR jsonb_typeof(observation->'disposition') IS DISTINCT FROM 'string' OR observation->>'disposition' NOT IN('advanced','unchanged','exception')
  OR observation->'status' IS DISTINCT FROM 'null'::jsonb AND(jsonb_typeof(observation->'status') IS DISTINCT FROM 'string' OR observation->>'status' NOT IN('scheduled','shipped')) THEN RETURN false;END IF;
 FOREACH k IN ARRAY ARRAY['bindingId','observationId'] LOOP
  IF jsonb_typeof(observation->k) IS DISTINCT FROM 'string' OR observation->>k!~'^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' THEN RETURN false;END IF;
 END LOOP;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION factory_erp_binding_application_result_valid(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION factory_erp_binding_application_result_valid(jsonb) TO yummyai_app;
--> statement-breakpoint
-- Pre-insert CAS runs before the original163 owner guards. Its source lock is
-- also acquired before the shared factory advisory slot, matching retention.
CREATE FUNCTION guard_factory_erp_association() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE source_row factory_erp_imports;head factory_erp_bindings;row_input jsonb;claim jsonb;pin jsonb;
BEGIN
 PERFORM factory_erp_require_authority(NEW.tenant_id,NEW.created_by);
 IF NOT factory_erp_apply_input_valid(NEW.input) THEN RAISE EXCEPTION 'factory_erp_application_invalid' USING ERRCODE='23514';END IF;
 SELECT * INTO source_row FROM factory_erp_imports WHERE tenant_id=NEW.tenant_id AND id=NEW.import_id FOR SHARE;
 IF source_row.id IS NULL OR source_row.expires_at<=factory_erp_source_now() OR source_row.encrypted_payload IS NULL OR source_row.private_redacted_at IS NOT NULL
  THEN RAISE EXCEPTION 'factory_erp_private_source_expired' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('factory-erp-apply:'||NEW.tenant_id::text||':'||source_row.factory_id::text,0));
 FOR row_input IN SELECT value FROM jsonb_array_elements(NEW.input->'rows') LOOP
  SELECT c INTO claim FROM jsonb_array_elements(source_row.source_claims) c WHERE(c->>'rowNumber')::integer=(row_input->>'rowNumber')::integer;
  IF claim IS NULL THEN RAISE EXCEPTION 'factory_erp_observation_source_required' USING ERRCODE='23514';END IF;
  SELECT * INTO head FROM factory_erp_bindings WHERE tenant_id=NEW.tenant_id AND factory_id=source_row.factory_id AND external_key=claim->>'externalKey'
   ORDER BY revision DESC LIMIT 1 FOR SHARE;
  IF NOT row_input?'association' THEN
   IF head.id IS NOT NULL AND(head.revision<>1 OR head.released_by IS NOT NULL)
    THEN RAISE EXCEPTION 'factory_erp_association_changed' USING ERRCODE='23514';END IF;
  ELSE
   pin:=row_input->'association';
   IF pin->>'expectedActiveBindingId' IS DISTINCT FROM(CASE WHEN head.released_by IS NULL THEN head.id::text ELSE NULL END)
    OR(pin->>'expectedRevision')::integer IS DISTINCT FROM coalesce(head.revision,0)
    OR pin->>'expectedReleaseId' IS DISTINCT FROM(CASE WHEN head.released_by IS NOT NULL THEN head.released_by::text ELSE NULL END)
    THEN RAISE EXCEPTION 'factory_erp_association_changed' USING ERRCODE='23514';END IF;
  END IF;
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER a_factory_erp_association BEFORE INSERT ON factory_erp_applications FOR EACH ROW EXECUTE FUNCTION guard_factory_erp_association();
CREATE FUNCTION guard_factory_erp_binding_birth() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE application_row factory_erp_applications;head factory_erp_bindings;parent_row factory_erp_bindings;prior_change factory_erp_binding_changes;
BEGIN
 IF TG_TABLE_NAME='factory_erp_bindings' THEN
  IF NEW.released_by IS NOT NULL THEN RAISE EXCEPTION 'factory_erp_binding_closed' USING ERRCODE='23514';END IF;
  SELECT * INTO application_row FROM factory_erp_applications WHERE tenant_id=NEW.tenant_id AND id=NEW.application_id;
  IF application_row.id IS NULL OR application_row.creation_transaction_id IS DISTINCT FROM pg_current_xact_id()::text
   THEN RAISE EXCEPTION 'factory_erp_application_birth_required' USING ERRCODE='23514';END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('factory-erp-apply:'||NEW.tenant_id::text||':'||NEW.factory_id::text,0));
  SELECT * INTO head FROM factory_erp_bindings WHERE tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id AND external_key=NEW.external_key ORDER BY revision DESC LIMIT 1 FOR SHARE;
  IF head.id IS NULL THEN
   IF NEW.revision<>1 OR NEW.previous_binding_id IS NOT NULL THEN RAISE EXCEPTION 'factory_erp_binding_sequence_invalid' USING ERRCODE='23514';END IF;
   ELSIF head.released_by IS NULL OR NEW.previous_binding_id IS DISTINCT FROM head.id OR NEW.revision<>head.revision+1
    THEN RAISE EXCEPTION 'factory_erp_binding_sequence_invalid' USING ERRCODE='23514';
   ELSE
    SELECT * INTO prior_change FROM factory_erp_binding_changes WHERE tenant_id=NEW.tenant_id AND id=head.released_by;
    IF prior_change.id IS NULL OR prior_change.binding_id IS DISTINCT FROM head.id
     THEN RAISE EXCEPTION 'factory_erp_binding_sequence_invalid' USING ERRCODE='23514';END IF;
    -- An early deferred flush must not let a standalone release acquire an
    -- undeclared successor later in the same transaction.
    IF prior_change.creation_transaction_id=pg_current_xact_id()::text AND(prior_change.action IS DISTINCT FROM 'correct'
     OR prior_change.replacement_binding_id IS DISTINCT FROM NEW.id OR prior_change.replacement_application_id IS DISTINCT FROM NEW.application_id)
     THEN RAISE EXCEPTION 'factory_erp_binding_change_correction_required' USING ERRCODE='23514';END IF;
   END IF;
 ELSE
  SELECT * INTO parent_row FROM factory_erp_bindings WHERE tenant_id=NEW.tenant_id AND id=NEW.binding_id;
  IF parent_row.id IS NULL OR parent_row.released_by IS NOT NULL THEN RAISE EXCEPTION 'factory_erp_binding_closed' USING ERRCODE='23514';END IF;
  IF TG_TABLE_NAME='factory_erp_binding_items' THEN
   IF NEW.released_by IS NOT NULL THEN RAISE EXCEPTION 'factory_erp_binding_closed' USING ERRCODE='23514';END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER a_factory_erp_binding_birth BEFORE INSERT ON factory_erp_bindings FOR EACH ROW EXECUTE FUNCTION guard_factory_erp_binding_birth();
CREATE TRIGGER a_factory_erp_binding_active BEFORE INSERT ON factory_erp_binding_items FOR EACH ROW EXECUTE FUNCTION guard_factory_erp_binding_birth();
CREATE TRIGGER a_factory_erp_binding_active BEFORE INSERT ON factory_erp_observations FOR EACH ROW EXECUTE FUNCTION guard_factory_erp_binding_birth();
--> statement-breakpoint
CREATE FUNCTION guard_factory_erp_binding_change() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE current_binding factory_erp_bindings;head factory_erp_bindings;source_row factory_erp_imports;previous_source uuid;claim jsonb;actual_sequence bigint;
 expected_canonical text;sorted_items jsonb;
BEGIN
 PERFORM factory_erp_require_authority(NEW.tenant_id,NEW.created_by);
 IF NOT factory_erp_binding_change_input_valid(NEW.input) OR NEW.action IS DISTINCT FROM NEW.input->>'action'
  OR NEW.idempotency_key::text IS DISTINCT FROM NEW.input->>'idempotencyKey'
  OR NEW.source_import_id::text IS DISTINCT FROM NEW.input->'source'->>'importId'
  OR NEW.source_row_number IS DISTINCT FROM(NEW.input->'source'->>'rowNumber')::integer
  THEN RAISE EXCEPTION 'factory_erp_binding_change_request_invalid' USING ERRCODE='23514';END IF;
 expected_canonical:=invoice_reconciliation_canonical(jsonb_build_object('version',1,'operation','factory-erp-binding-change','bindingId',NEW.binding_id,'input',NEW.input));
 IF NEW.request_canonical IS DISTINCT FROM expected_canonical OR NEW.request_checksum IS DISTINCT FROM encode(sha256(convert_to(expected_canonical,'UTF8')),'hex')
  THEN RAISE EXCEPTION 'factory_erp_binding_change_request_invalid' USING ERRCODE='23514';END IF;
 SELECT a.import_id INTO previous_source FROM factory_erp_bindings b JOIN factory_erp_applications a ON a.tenant_id=b.tenant_id AND a.id=b.application_id WHERE b.tenant_id=NEW.tenant_id AND b.id=NEW.binding_id;
 PERFORM 1 FROM factory_erp_imports s WHERE s.tenant_id=NEW.tenant_id AND s.id=ANY(ARRAY[previous_source,NEW.source_import_id]) ORDER BY s.id FOR SHARE;
 SELECT * INTO source_row FROM factory_erp_imports WHERE tenant_id=NEW.tenant_id AND id=NEW.source_import_id;
 IF source_row.id IS NULL OR source_row.factory_id IS DISTINCT FROM NEW.factory_id OR source_row.expires_at<=factory_erp_source_now()
  OR source_row.encrypted_payload IS NULL OR source_row.private_redacted_at IS NOT NULL
  OR source_row.file_checksum IS DISTINCT FROM NEW.input->'source'->>'fileChecksum' OR source_row.preview_checksum IS DISTINCT FROM NEW.input->'source'->>'previewChecksum'
  THEN RAISE EXCEPTION 'factory_erp_binding_change_source_required' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('factory-erp-apply:'||NEW.tenant_id::text||':'||NEW.factory_id::text,0));
 PERFORM 1 FROM fulfillment_factories f JOIN fulfillment_suppliers s ON s.tenant_id=f.tenant_id AND s.id=f.supplier_id
  WHERE f.tenant_id=NEW.tenant_id AND f.id=NEW.factory_id AND f.status='active' AND s.status='active' FOR SHARE OF f,s;
 IF NOT FOUND THEN RAISE EXCEPTION 'factory_erp_binding_change_source_required' USING ERRCODE='23514';END IF;
 SELECT * INTO current_binding FROM factory_erp_bindings WHERE tenant_id=NEW.tenant_id AND id=NEW.binding_id FOR UPDATE;
 IF current_binding.id IS NULL OR current_binding.factory_id IS DISTINCT FROM NEW.factory_id OR current_binding.released_by IS NOT NULL
  THEN RAISE EXCEPTION 'factory_erp_binding_change_basis_changed' USING ERRCODE='23514';END IF;
 SELECT * INTO head FROM factory_erp_bindings WHERE tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id AND external_key=current_binding.external_key ORDER BY revision DESC LIMIT 1;
 SELECT coalesce(max(sequence),0) INTO actual_sequence FROM factory_erp_observations WHERE tenant_id=NEW.tenant_id AND binding_id=current_binding.id;
 IF head.id IS DISTINCT FROM current_binding.id OR current_binding.revision IS DISTINCT FROM(NEW.input->>'expectedRevision')::integer
  OR current_binding.items_checksum IS DISTINCT FROM NEW.input->>'expectedItemsChecksum' OR actual_sequence IS DISTINCT FROM(NEW.input->>'expectedObservationSequence')::bigint
  OR EXISTS(SELECT 1 FROM factory_erp_binding_items i WHERE i.tenant_id=NEW.tenant_id AND i.binding_id=current_binding.id AND i.released_by IS NOT NULL)
  OR current_binding.items_checksum IS DISTINCT FROM encode(sha256(convert_to(invoice_reconciliation_canonical(factory_erp_binding_items_value(NEW.tenant_id,current_binding.id)),'UTF8')),'hex')
  THEN RAISE EXCEPTION 'factory_erp_binding_change_basis_changed' USING ERRCODE='23514';END IF;
 SELECT c INTO claim FROM jsonb_array_elements(source_row.source_claims) c WHERE(c->>'rowNumber')::integer=NEW.source_row_number;
 IF claim IS NULL OR claim->>'externalKey' IS DISTINCT FROM current_binding.external_key OR claim->>'rawStatus' NOT IN('已审核','已出库','已作废') OR claim->>'rawStatus' IS NULL
  THEN RAISE EXCEPTION 'factory_erp_binding_change_source_required' USING ERRCODE='23514';END IF;
 IF NEW.action='correct' THEN
  SELECT jsonb_agg(value ORDER BY (value->>'deliveryItemId') COLLATE "C") INTO sorted_items FROM jsonb_array_elements(NEW.input->'items');
  IF encode(sha256(convert_to(invoice_reconciliation_canonical(sorted_items),'UTF8')),'hex')=current_binding.items_checksum
   THEN RAISE EXCEPTION 'factory_erp_binding_change_same_group' USING ERRCODE='23514';END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM audit_events a WHERE a.tenant_id=NEW.tenant_id AND a.entity_type='factory_erp_binding_change' AND a.entity_id=NEW.id AND a.action='factory_erp.binding_changed' AND a.result='success')
  THEN RAISE EXCEPTION 'factory_erp_binding_change_sealed' USING ERRCODE='23514';END IF;
 NEW.creation_transaction_id:=pg_current_xact_id()::text;
 RETURN NEW;
END $$;
CREATE TRIGGER factory_erp_binding_change_guard BEFORE INSERT ON factory_erp_binding_changes FOR EACH ROW EXECUTE FUNCTION guard_factory_erp_binding_change();
--> statement-breakpoint
-- UPDATE rights remain column-specific. The original164 redaction function is
-- retained verbatim and still validates every change to private source copies.
DROP TRIGGER factory_erp_private_immutable ON factory_erp_bindings;
CREATE TRIGGER factory_erp_private_immutable BEFORE UPDATE OF encrypted_payload,private_redacted_at OR DELETE ON factory_erp_bindings
 FOR EACH ROW EXECUTE FUNCTION guard_factory_erp_private_redaction();
DROP TRIGGER factory_erp_redaction_closure ON factory_erp_bindings;
CREATE CONSTRAINT TRIGGER factory_erp_redaction_closure AFTER UPDATE ON factory_erp_bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 WHEN(OLD.encrypted_payload IS DISTINCT FROM NEW.encrypted_payload OR OLD.private_redacted_at IS DISTINCT FROM NEW.private_redacted_at)
 EXECUTE FUNCTION require_factory_erp_redaction_closure();
CREATE FUNCTION guard_factory_erp_binding_release() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE event_row factory_erp_binding_changes;parent_identity uuid;parent_row factory_erp_bindings;
BEGIN
 IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'factory_erp_binding_history_immutable' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='factory_erp_bindings' AND NEW.released_by IS NOT DISTINCT FROM OLD.released_by THEN
  IF(NEW.encrypted_payload IS NOT DISTINCT FROM OLD.encrypted_payload AND NEW.private_redacted_at IS NOT DISTINCT FROM OLD.private_redacted_at)
   OR(to_jsonb(NEW)-ARRAY['encrypted_payload','private_redacted_at']) IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['encrypted_payload','private_redacted_at'])
   THEN RAISE EXCEPTION 'factory_erp_binding_history_immutable' USING ERRCODE='23514';END IF;
  RETURN NEW;
 END IF;
 IF OLD.released_by IS NOT NULL OR NEW.released_by IS NULL OR(to_jsonb(NEW)-'released_by') IS DISTINCT FROM(to_jsonb(OLD)-'released_by')
  THEN RAISE EXCEPTION 'factory_erp_binding_history_immutable' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='factory_erp_bindings' THEN parent_identity:=OLD.id;ELSE parent_identity:=OLD.binding_id;END IF;
 SELECT * INTO event_row FROM factory_erp_binding_changes WHERE tenant_id=OLD.tenant_id AND id=NEW.released_by;
 IF event_row.id IS NULL OR event_row.binding_id IS DISTINCT FROM parent_identity OR event_row.creation_transaction_id IS DISTINCT FROM pg_current_xact_id()::text
  OR event_row.created_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid
  THEN RAISE EXCEPTION 'factory_erp_binding_release_required' USING ERRCODE='23514';END IF;
 PERFORM factory_erp_require_authority(OLD.tenant_id,event_row.created_by);
 IF EXISTS(SELECT 1 FROM audit_events a WHERE a.tenant_id=OLD.tenant_id AND a.entity_type='factory_erp_binding_change' AND a.entity_id=event_row.id AND a.action='factory_erp.binding_changed' AND a.result='success')
  THEN RAISE EXCEPTION 'factory_erp_binding_change_sealed' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='factory_erp_binding_items' THEN
  SELECT * INTO parent_row FROM factory_erp_bindings WHERE tenant_id=OLD.tenant_id AND id=parent_identity;
  IF parent_row.released_by IS DISTINCT FROM event_row.id THEN RAISE EXCEPTION 'factory_erp_binding_release_required' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER a_factory_erp_binding_release BEFORE UPDATE OR DELETE ON factory_erp_bindings FOR EACH ROW EXECUTE FUNCTION guard_factory_erp_binding_release();
DROP TRIGGER factory_erp_immutable ON factory_erp_binding_items;
CREATE TRIGGER factory_erp_binding_release BEFORE UPDATE OR DELETE ON factory_erp_binding_items FOR EACH ROW EXECUTE FUNCTION guard_factory_erp_binding_release();
--> statement-breakpoint
CREATE FUNCTION require_factory_erp_binding_change() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE event_row factory_erp_binding_changes;original_binding factory_erp_bindings;replacement factory_erp_bindings;application_row factory_erp_applications;
 actual_sequence bigint;item_count integer;input_items jsonb;actual_items jsonb;row_input jsonb;pin jsonb;output jsonb;k text;
 xid text:=pg_current_xact_id()::text;
BEGIN
 IF TG_TABLE_NAME='factory_erp_binding_changes' THEN event_row:=NEW;
 ELSE SELECT * INTO event_row FROM factory_erp_binding_changes WHERE tenant_id=NEW.tenant_id AND id=NEW.released_by;END IF;
 IF event_row.id IS NULL OR event_row.creation_transaction_id IS DISTINCT FROM xid THEN RAISE EXCEPTION 'factory_erp_binding_change_birth_required' USING ERRCODE='23514';END IF;
 SELECT * INTO original_binding FROM factory_erp_bindings WHERE tenant_id=event_row.tenant_id AND id=event_row.binding_id;
 SELECT coalesce(max(sequence),0) INTO actual_sequence FROM factory_erp_observations WHERE tenant_id=event_row.tenant_id AND binding_id=original_binding.id;
 SELECT count(*) INTO item_count FROM factory_erp_binding_items WHERE tenant_id=event_row.tenant_id AND binding_id=original_binding.id;
 IF original_binding.id IS NULL OR original_binding.released_by IS DISTINCT FROM event_row.id OR original_binding.factory_id IS DISTINCT FROM event_row.factory_id
  OR item_count NOT BETWEEN 1 AND 50 OR EXISTS(SELECT 1 FROM factory_erp_binding_items i WHERE i.tenant_id=event_row.tenant_id AND i.binding_id=original_binding.id AND i.released_by IS DISTINCT FROM event_row.id)
  OR original_binding.quantity IS DISTINCT FROM(SELECT sum(i.quantity)::integer FROM factory_erp_binding_items i WHERE i.tenant_id=event_row.tenant_id AND i.binding_id=original_binding.id)
  OR original_binding.revision IS DISTINCT FROM(event_row.input->>'expectedRevision')::integer
  OR original_binding.items_checksum IS DISTINCT FROM event_row.input->>'expectedItemsChecksum'
  OR actual_sequence IS DISTINCT FROM(event_row.input->>'expectedObservationSequence')::bigint
  THEN RAISE EXCEPTION 'factory_erp_binding_change_closure_required' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM audit_events a WHERE a.tenant_id=event_row.tenant_id AND a.entity_id=event_row.id AND a.entity_type='factory_erp_binding_change'
  AND a.action='factory_erp.binding_changed' AND a.actor_user_id=event_row.created_by AND a.result='success' AND a.xmin::text=(xid::numeric%4294967296)::bigint::text)
  THEN RAISE EXCEPTION 'factory_erp_binding_change_audit_required' USING ERRCODE='23514';END IF;
 output:=event_row.result;
 IF jsonb_typeof(output) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'factory_erp_binding_change_result_invalid' USING ERRCODE='23514';END IF;
 IF NOT factory_erp_binding_timestamp_valid(output->'createdAt') THEN RAISE EXCEPTION 'factory_erp_binding_change_result_invalid' USING ERRCODE='23514';END IF;
 IF NOT output?&ARRAY['id','bindingId','factoryId','action','reasonCode','source','originalRevision','originalItemsChecksum','originalObservationSequence','replacementBindingId','replacementRevision','application','requestChecksum','createdAt']
  OR output-ARRAY['id','bindingId','factoryId','action','reasonCode','source','originalRevision','originalItemsChecksum','originalObservationSequence','replacementBindingId','replacementRevision','application','requestChecksum','createdAt']<>'{}'::jsonb
  OR output->>'id' IS DISTINCT FROM event_row.id::text OR output->>'bindingId' IS DISTINCT FROM original_binding.id::text
  OR output->>'factoryId' IS DISTINCT FROM event_row.factory_id::text OR output->>'action' IS DISTINCT FROM event_row.action
  OR output->>'reasonCode' IS DISTINCT FROM event_row.input->>'reasonCode' OR output->'source' IS DISTINCT FROM event_row.input->'source'
  OR output->'originalRevision' IS DISTINCT FROM to_jsonb(original_binding.revision) OR output->>'originalItemsChecksum' IS DISTINCT FROM original_binding.items_checksum
  OR output->'originalObservationSequence' IS DISTINCT FROM to_jsonb(actual_sequence) OR output->>'requestChecksum' IS DISTINCT FROM event_row.request_checksum
  OR(output->>'createdAt')::timestamptz IS DISTINCT FROM event_row.created_at
  THEN RAISE EXCEPTION 'factory_erp_binding_change_result_invalid' USING ERRCODE='23514';END IF;
 FOREACH k IN ARRAY ARRAY['id','bindingId','factoryId','action','reasonCode','originalItemsChecksum','requestChecksum'] LOOP
  IF jsonb_typeof(output->k) IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'factory_erp_binding_change_result_invalid' USING ERRCODE='23514';END IF;
 END LOOP;
 IF event_row.action='release' THEN
  IF event_row.replacement_binding_id IS NOT NULL OR event_row.replacement_application_id IS NOT NULL OR output->'replacementBindingId' IS DISTINCT FROM 'null'::jsonb
   OR output->'replacementRevision' IS DISTINCT FROM 'null'::jsonb OR output->'application' IS DISTINCT FROM 'null'::jsonb
   OR EXISTS(SELECT 1 FROM factory_erp_bindings b WHERE b.tenant_id=event_row.tenant_id AND b.previous_binding_id=original_binding.id AND b.creation_transaction_id=xid)
   THEN RAISE EXCEPTION 'factory_erp_binding_change_correction_required' USING ERRCODE='23514';END IF;
 ELSE
  IF NOT factory_erp_binding_application_result_valid(output->'application') THEN RAISE EXCEPTION 'factory_erp_binding_change_result_invalid' USING ERRCODE='23514';END IF;
  SELECT * INTO replacement FROM factory_erp_bindings WHERE tenant_id=event_row.tenant_id AND id=event_row.replacement_binding_id;
  SELECT * INTO application_row FROM factory_erp_applications WHERE tenant_id=event_row.tenant_id AND id=event_row.replacement_application_id;
  IF replacement.id IS NULL OR application_row.id IS NULL OR replacement.creation_transaction_id IS DISTINCT FROM xid OR application_row.creation_transaction_id IS DISTINCT FROM xid
   OR replacement.created_by IS DISTINCT FROM event_row.created_by OR application_row.created_by IS DISTINCT FROM event_row.created_by
   OR replacement.factory_id IS DISTINCT FROM original_binding.factory_id OR replacement.external_key IS DISTINCT FROM original_binding.external_key
   OR replacement.revision<>original_binding.revision+1 OR replacement.previous_binding_id IS DISTINCT FROM original_binding.id OR replacement.released_by IS NOT NULL
   OR replacement.application_id IS DISTINCT FROM application_row.id OR application_row.import_id IS DISTINCT FROM event_row.source_import_id
   OR application_row.idempotency_key IS DISTINCT FROM event_row.idempotency_key OR output->'application' IS DISTINCT FROM application_row.result
   OR output->>'replacementBindingId' IS DISTINCT FROM replacement.id::text OR jsonb_typeof(output->'replacementBindingId') IS DISTINCT FROM 'string'
   OR output->'replacementRevision' IS DISTINCT FROM to_jsonb(replacement.revision)
   THEN RAISE EXCEPTION 'factory_erp_binding_change_correction_required' USING ERRCODE='23514';END IF;
  IF jsonb_array_length(application_row.input->'rows')<>1 OR application_row.input->'confirmed' IS DISTINCT FROM 'true'::jsonb
   THEN RAISE EXCEPTION 'factory_erp_binding_change_correction_required' USING ERRCODE='23514';END IF;
  row_input:=application_row.input->'rows'->0;pin:=row_input->'association';
  SELECT jsonb_agg(value ORDER BY (value->>'deliveryItemId') COLLATE "C") INTO input_items FROM jsonb_array_elements(event_row.input->'items');
  actual_items:=factory_erp_binding_items_value(event_row.tenant_id,replacement.id);
  IF(row_input->>'rowNumber')::integer IS DISTINCT FROM event_row.source_row_number OR NOT factory_erp_association_valid(pin)
   OR pin->'expectedActiveBindingId' IS DISTINCT FROM 'null'::jsonb OR pin->'expectedRevision' IS DISTINCT FROM to_jsonb(original_binding.revision)
   OR pin->>'expectedReleaseId' IS DISTINCT FROM event_row.id::text OR actual_items IS DISTINCT FROM input_items
   OR replacement.items_checksum=original_binding.items_checksum
   OR jsonb_array_length(application_row.result->'observations')<>1 OR(application_row.result->>'appliedRows')::integer<>1
   OR application_row.result->'observations'->0->>'bindingId' IS DISTINCT FROM replacement.id::text
   THEN RAISE EXCEPTION 'factory_erp_binding_change_correction_required' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER factory_erp_binding_change_closure AFTER INSERT ON factory_erp_binding_changes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_factory_erp_binding_change();
CREATE CONSTRAINT TRIGGER factory_erp_binding_release_closure AFTER UPDATE ON factory_erp_bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 WHEN(OLD.released_by IS DISTINCT FROM NEW.released_by) EXECUTE FUNCTION require_factory_erp_binding_change();
CREATE CONSTRAINT TRIGGER factory_erp_binding_release_closure AFTER UPDATE ON factory_erp_binding_items DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 WHEN(OLD.released_by IS DISTINCT FROM NEW.released_by) EXECUTE FUNCTION require_factory_erp_binding_change();
--> statement-breakpoint
-- This is additive to163's full owner closure, not a replacement for its source,
-- whole-group, raw-status, actual file, transaction birth and audit checks.
CREATE FUNCTION require_factory_erp_association() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE row_input jsonb;pin jsonb;row_link factory_erp_application_rows;b factory_erp_bindings;previous_binding factory_erp_bindings;
BEGIN
 FOR row_input IN SELECT value FROM jsonb_array_elements(NEW.input->'rows') LOOP
  SELECT * INTO row_link FROM factory_erp_application_rows WHERE tenant_id=NEW.tenant_id AND application_id=NEW.id AND row_number=(row_input->>'rowNumber')::integer;
  SELECT * INTO b FROM factory_erp_bindings WHERE tenant_id=NEW.tenant_id AND id=row_link.binding_id;
  IF b.id IS NULL OR b.released_by IS NOT NULL OR EXISTS(SELECT 1 FROM factory_erp_binding_items i WHERE i.tenant_id=NEW.tenant_id AND i.binding_id=b.id AND i.released_by IS NOT NULL)
   THEN RAISE EXCEPTION 'factory_erp_binding_closed' USING ERRCODE='23514';END IF;
  IF b.items_checksum IS DISTINCT FROM encode(sha256(convert_to(invoice_reconciliation_canonical(factory_erp_binding_items_value(NEW.tenant_id,b.id)),'UTF8')),'hex')
   THEN RAISE EXCEPTION 'factory_erp_original_group_changed' USING ERRCODE='23514';END IF;
  IF NOT row_input?'association' THEN
   IF b.revision<>1 OR b.previous_binding_id IS NOT NULL THEN RAISE EXCEPTION 'factory_erp_association_changed' USING ERRCODE='23514';END IF;
  ELSE
   pin:=row_input->'association';
   IF NOT factory_erp_association_valid(pin) THEN RAISE EXCEPTION 'factory_erp_association_changed' USING ERRCODE='23514';END IF;
   IF b.application_id=NEW.id THEN
    IF b.creation_transaction_id IS DISTINCT FROM pg_current_xact_id()::text THEN RAISE EXCEPTION 'factory_erp_application_birth_required' USING ERRCODE='23514';END IF;
    IF b.previous_binding_id IS NULL THEN
     IF pin->'expectedActiveBindingId' IS DISTINCT FROM 'null'::jsonb OR pin->'expectedRevision' IS DISTINCT FROM '0'::jsonb OR pin->'expectedReleaseId' IS DISTINCT FROM 'null'::jsonb
      THEN RAISE EXCEPTION 'factory_erp_association_changed' USING ERRCODE='23514';END IF;
    ELSE
     SELECT * INTO previous_binding FROM factory_erp_bindings WHERE tenant_id=NEW.tenant_id AND id=b.previous_binding_id;
     IF previous_binding.id IS NULL OR previous_binding.factory_id IS DISTINCT FROM b.factory_id OR previous_binding.external_key IS DISTINCT FROM b.external_key
      OR previous_binding.released_by IS NULL OR b.revision<>previous_binding.revision+1
      OR pin->'expectedActiveBindingId' IS DISTINCT FROM 'null'::jsonb OR pin->'expectedRevision' IS DISTINCT FROM to_jsonb(previous_binding.revision)
      OR pin->>'expectedReleaseId' IS DISTINCT FROM previous_binding.released_by::text
      THEN RAISE EXCEPTION 'factory_erp_association_changed' USING ERRCODE='23514';END IF;
    END IF;
   ELSIF pin->>'expectedActiveBindingId' IS DISTINCT FROM b.id::text OR pin->'expectedRevision' IS DISTINCT FROM to_jsonb(b.revision) OR pin->'expectedReleaseId' IS DISTINCT FROM 'null'::jsonb
    THEN RAISE EXCEPTION 'factory_erp_association_changed' USING ERRCODE='23514';END IF;
  END IF;
 END LOOP;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER factory_erp_application_association AFTER INSERT ON factory_erp_applications DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_factory_erp_association();
