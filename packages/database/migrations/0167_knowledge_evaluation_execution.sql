-- Future evaluation intents and completed assessments belong to the native
-- Assist transaction. Legacy rows and private-content retention are unchanged.
ALTER TABLE ai_assist_runs ADD COLUMN creation_transaction_id xid8;
CREATE FUNCTION guard_ai_assist_birth_transaction() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='INSERT' THEN NEW.creation_transaction_id:=pg_current_xact_id();
 ELSIF NEW.creation_transaction_id IS DISTINCT FROM OLD.creation_transaction_id THEN
  RAISE EXCEPTION 'ai_assist_birth_immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER a_ai_assist_birth_transaction BEFORE INSERT OR UPDATE ON ai_assist_runs
 FOR EACH ROW EXECUTE FUNCTION guard_ai_assist_birth_transaction();
ALTER TABLE knowledge_evaluation_runs ADD CONSTRAINT knowledge_evaluation_runs_tenant_id_unique UNIQUE(tenant_id,id);

CREATE TABLE knowledge_evaluation_protocols (
 run_id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES organizations(id),case_revision integer NOT NULL,
 case_checksum text NOT NULL,request_checksum text NOT NULL,basis_fingerprint text NOT NULL,input_fingerprint text NOT NULL,
 model_id uuid NOT NULL,prompt_version text NOT NULL,data_scope text NOT NULL,assertion_version text NOT NULL,proof text NOT NULL,
 created_by uuid NOT NULL REFERENCES app_users(id),creation_transaction_id text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT knowledge_evaluation_protocol_run_fk FOREIGN KEY(tenant_id,run_id) REFERENCES knowledge_evaluation_runs(tenant_id,id),
 CONSTRAINT knowledge_evaluation_protocol_revision CHECK(case_revision>0),
 CONSTRAINT knowledge_evaluation_protocol_hashes CHECK(case_checksum~'^[a-f0-9]{64}$' AND request_checksum~'^[a-f0-9]{64}$'
  AND basis_fingerprint~'^[a-f0-9]{64}$' AND input_fingerprint~'^[a-f0-9]{64}$'),
 CONSTRAINT knowledge_evaluation_protocol_version CHECK(assertion_version='knowledge-answer-assertions-v1' AND length(prompt_version)>0),
 CONSTRAINT knowledge_evaluation_protocol_scope CHECK(data_scope IN('self','team','tenant')),
 CONSTRAINT knowledge_evaluation_protocol_proof CHECK(octet_length(proof) BETWEEN 1 AND 1048576),
 CONSTRAINT knowledge_evaluation_protocol_birth CHECK(creation_transaction_id~'^[0-9]+$')
);
CREATE UNIQUE INDEX knowledge_evaluation_protocols_tenant_run_unique ON knowledge_evaluation_protocols(tenant_id,run_id);
CREATE TABLE knowledge_evaluation_assessments (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES organizations(id),run_id uuid NOT NULL,
 basis_fingerprint text NOT NULL,output_checksum text NOT NULL,assertion_version text NOT NULL,
 retrieval_recall double precision,cited_recall double precision,checks jsonb NOT NULL,result_checksum text NOT NULL,proof text NOT NULL,
 created_by uuid NOT NULL REFERENCES app_users(id),creation_transaction_id text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT knowledge_evaluation_assessment_protocol_fk FOREIGN KEY(tenant_id,run_id) REFERENCES knowledge_evaluation_protocols(tenant_id,run_id),
 CONSTRAINT knowledge_evaluation_assessment_id CHECK(substring(id::text from 15 for 1)='7'),
 CONSTRAINT knowledge_evaluation_assessment_hashes CHECK(basis_fingerprint~'^[a-f0-9]{64}$' AND output_checksum~'^[a-f0-9]{64}$' AND result_checksum~'^[a-f0-9]{64}$'),
 CONSTRAINT knowledge_evaluation_assessment_version CHECK(assertion_version='knowledge-answer-assertions-v1'),
 CONSTRAINT knowledge_evaluation_assessment_recall CHECK((retrieval_recall IS NULL OR retrieval_recall BETWEEN 0 AND 1)
  AND(cited_recall IS NULL OR cited_recall BETWEEN 0 AND 1)),
 CONSTRAINT knowledge_evaluation_assessment_proof CHECK(octet_length(proof) BETWEEN 1 AND 1048576),
 CONSTRAINT knowledge_evaluation_assessment_birth CHECK(creation_transaction_id~'^[0-9]+$')
);
CREATE UNIQUE INDEX knowledge_evaluation_assessments_tenant_id_unique ON knowledge_evaluation_assessments(tenant_id,id);
CREATE UNIQUE INDEX knowledge_evaluation_assessments_run_unique ON knowledge_evaluation_assessments(run_id);
CREATE INDEX knowledge_evaluation_start_receipt_lookup ON knowledge_governance_events(tenant_id,(detail->>'runId')) WHERE action='evaluation.start';
CREATE INDEX knowledge_evaluation_assessed_receipt_lookup ON knowledge_governance_events(tenant_id,resource_id) WHERE action='evaluation.assessed';
ALTER TABLE knowledge_evaluation_protocols ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_evaluation_protocols FORCE ROW LEVEL SECURITY;
CREATE POLICY knowledge_evaluation_protocols_private ON knowledge_evaluation_protocols TO yummyai_app
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND created_by=nullif(current_setting('app.user_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND created_by=nullif(current_setting('app.user_id',true),'')::uuid);
ALTER TABLE knowledge_evaluation_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_evaluation_assessments FORCE ROW LEVEL SECURITY;
CREATE POLICY knowledge_evaluation_assessments_private ON knowledge_evaluation_assessments TO yummyai_app
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND created_by=nullif(current_setting('app.user_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND created_by=nullif(current_setting('app.user_id',true),'')::uuid);
GRANT SELECT,INSERT ON knowledge_evaluation_protocols,knowledge_evaluation_assessments TO yummyai_app;
CREATE TRIGGER knowledge_evaluation_protocols_immutable BEFORE UPDATE OR DELETE ON knowledge_evaluation_protocols
 FOR EACH ROW EXECUTE FUNCTION protect_knowledge_history();
CREATE TRIGGER knowledge_evaluation_assessments_immutable BEFORE UPDATE OR DELETE ON knowledge_evaluation_assessments
 FOR EACH ROW EXECUTE FUNCTION protect_knowledge_history();
--> statement-breakpoint
CREATE FUNCTION knowledge_evaluation_require_authority(tenant uuid,actor uuid,needs_product boolean DEFAULT false,pinned_scope text DEFAULT 'self') RETURNS void
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE required text[]:=ARRAY['workflow:read','workflow:run','workflow:manage'];permission_name text;scope_rank integer;actual_rank integer;
BEGIN
 IF tenant IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid OR actor IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid
  THEN RAISE EXCEPTION 'knowledge_evaluation_actor_invalid' USING ERRCODE='23514';END IF;
 IF pinned_scope IS NULL OR pinned_scope NOT IN('self','team','tenant') THEN
  RAISE EXCEPTION 'knowledge_evaluation_protocol_invalid' USING ERRCODE='23514';END IF;
 scope_rank:=CASE pinned_scope WHEN 'tenant' THEN 3 WHEN 'team' THEN 2 ELSE 1 END;
 PERFORM 1 FROM memberships m JOIN membership_roles mr ON mr.tenant_id=m.tenant_id AND mr.membership_id=m.id
  JOIN roles r ON r.tenant_id=mr.tenant_id AND r.id=mr.role_id
  WHERE m.tenant_id=tenant AND m.user_id=actor ORDER BY m.id,mr.role_id FOR SHARE OF m,mr,r;
 IF needs_product THEN required:=array_append(required,'product:read');END IF;
 FOREACH permission_name IN ARRAY required LOOP
  SELECT coalesce(max(CASE r.data_scope WHEN 'tenant' THEN 3 WHEN 'team' THEN 2 WHEN 'self' THEN 1 ELSE 0 END),0) INTO actual_rank
   FROM memberships m JOIN membership_roles mr ON mr.tenant_id=m.tenant_id AND mr.membership_id=m.id
   JOIN roles r ON r.tenant_id=mr.tenant_id AND r.id=mr.role_id WHERE m.tenant_id=tenant AND m.user_id=actor AND m.status='active'
   AND(r.permissions?permission_name OR r.permissions?'*');
  -- Product object scope is separately checked by the original owner. Each
  -- workflow bit must independently cover the pinned evaluation scope.
  IF actual_rank<(CASE WHEN permission_name='product:read' THEN 1 ELSE scope_rank END) THEN
   RAISE EXCEPTION 'knowledge_evaluation_current_authority_required' USING ERRCODE='23514';
  END IF;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION knowledge_evaluation_require_authority(uuid,uuid,boolean,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION knowledge_evaluation_require_authority(uuid,uuid,boolean,text) TO yummyai_app;

CREATE FUNCTION guard_knowledge_evaluation_run_admission() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 PERFORM knowledge_evaluation_require_authority(NEW.tenant_id,NEW.created_by,false);
 PERFORM pg_advisory_xact_lock(hashtextextended('knowledge-eval-run:'||NEW.tenant_id::text||':'||NEW.request_id::text,0));
 RETURN NEW;
END $$;
CREATE TRIGGER a_knowledge_evaluation_run_admission BEFORE INSERT ON knowledge_evaluation_runs
 FOR EACH ROW EXECUTE FUNCTION guard_knowledge_evaluation_run_admission();

CREATE FUNCTION guard_knowledge_evaluation_protocol() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE eval_row knowledge_evaluation_runs;case_row knowledge_evaluation_cases;assist_row ai_assist_runs;expected_checksum text;
BEGIN
 PERFORM knowledge_evaluation_require_authority(NEW.tenant_id,NEW.created_by,false,NEW.data_scope);
 SELECT * INTO eval_row FROM knowledge_evaluation_runs WHERE tenant_id=NEW.tenant_id AND id=NEW.run_id;
 IF eval_row.id IS NULL OR eval_row.created_by IS DISTINCT FROM NEW.created_by THEN
  RAISE EXCEPTION 'knowledge_evaluation_native_owner_invalid' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('knowledge-eval-run:'||NEW.tenant_id::text||':'||eval_row.request_id::text,0));
 SELECT * INTO case_row FROM knowledge_evaluation_cases WHERE tenant_id=NEW.tenant_id AND id=eval_row.case_id FOR SHARE;
 IF case_row.id IS NULL OR case_row.archived_at IS NOT NULL OR NEW.case_revision IS DISTINCT FROM case_row.revision
  OR eval_row.case_snapshot IS DISTINCT FROM case_row.fields THEN
  RAISE EXCEPTION 'knowledge_evaluation_case_changed' USING ERRCODE='23514';END IF;
 IF jsonb_typeof(case_row.fields) IS DISTINCT FROM 'object' OR jsonb_typeof(case_row.fields->'search') IS DISTINCT FROM 'object'
  OR jsonb_typeof(case_row.fields->'search'->'spuIds') IS DISTINCT FROM 'array' OR jsonb_typeof(case_row.fields->'requiredEntryIds') IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION 'knowledge_evaluation_protocol_invalid' USING ERRCODE='23514';END IF;
 PERFORM knowledge_evaluation_require_authority(NEW.tenant_id,NEW.created_by,
  jsonb_typeof(case_row.fields->'search'->'spuIds')='array' AND jsonb_array_length(case_row.fields->'search'->'spuIds')>0,NEW.data_scope);
 SELECT * INTO assist_row FROM ai_assist_runs WHERE tenant_id=NEW.tenant_id AND id=eval_row.assist_run_id FOR SHARE;
 IF assist_row.id IS NULL OR assist_row.creation_transaction_id IS DISTINCT FROM pg_current_xact_id()
  OR assist_row.owner_id IS DISTINCT FROM NEW.created_by OR assist_row.kind IS DISTINCT FROM 'knowledge_answer'
  OR assist_row.scope IS DISTINCT FROM 'knowledge:'||eval_row.case_id::text OR assist_row.request_id IS DISTINCT FROM eval_row.request_id
  OR assist_row.status IS DISTINCT FROM 'queued' OR assist_row.started_at IS NOT NULL OR assist_row.completed_at IS NOT NULL
  OR assist_row.encrypted_input IS NULL OR assist_row.encrypted_output IS NOT NULL
  OR assist_row.model_snapshot->'id' IS DISTINCT FROM to_jsonb(NEW.model_id::text)
  OR assist_row.input_fingerprint IS DISTINCT FROM NEW.input_fingerprint OR assist_row.prompt_version IS DISTINCT FROM NEW.prompt_version THEN
  RAISE EXCEPTION 'knowledge_evaluation_native_owner_invalid' USING ERRCODE='23514';END IF;
 expected_checksum:=encode(sha256(convert_to(invoice_reconciliation_canonical(eval_row.case_snapshot),'UTF8')),'hex');
 IF NEW.case_checksum IS DISTINCT FROM expected_checksum OR NEW.request_checksum IS DISTINCT FROM
  encode(sha256(convert_to(invoice_reconciliation_canonical(jsonb_build_object('version',1,'operation','knowledge-evaluation-start','caseId',eval_row.case_id,
   'input',jsonb_build_object('modelId',NEW.model_id,'requestId',eval_row.request_id))),'UTF8')),'hex') THEN
  RAISE EXCEPTION 'knowledge_evaluation_protocol_invalid' USING ERRCODE='23514';END IF;
 -- Refuse a previously committed governance receipt even after xid32 wraps.
 IF EXISTS(SELECT 1 FROM knowledge_governance_events e WHERE e.tenant_id=NEW.tenant_id AND e.action='evaluation.start' AND e.detail->>'runId'=NEW.run_id::text) THEN
  RAISE EXCEPTION 'knowledge_evaluation_birth_required' USING ERRCODE='23514';END IF;
 NEW.creation_transaction_id:=pg_current_xact_id()::text;
 RETURN NEW;
END $$;
CREATE TRIGGER knowledge_evaluation_protocol_guard BEFORE INSERT ON knowledge_evaluation_protocols
 FOR EACH ROW EXECUTE FUNCTION guard_knowledge_evaluation_protocol();
--> statement-breakpoint
CREATE FUNCTION knowledge_evaluation_checks_valid(value jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE keys text[]:=ARRAY['answer_completed','retrieval','citation','expected_facts','forbidden','refusal','evidence'];item jsonb;check_index integer;
BEGIN
 IF jsonb_typeof(value) IS DISTINCT FROM 'array' THEN RETURN false;END IF;
 IF jsonb_array_length(value)<>7 THEN RETURN false;END IF;
 FOR check_index IN 0..6 LOOP
  item:=value->check_index;
  IF jsonb_typeof(item) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
  IF NOT item?&ARRAY['key','label','status','detail'] OR item-ARRAY['key','label','status','detail']<>'{}'::jsonb
   OR item->'key' IS DISTINCT FROM to_jsonb(keys[check_index+1]) OR jsonb_typeof(item->'label') IS DISTINCT FROM 'string'
   OR jsonb_typeof(item->'detail') IS DISTINCT FROM 'string' OR jsonb_typeof(item->'status') IS DISTINCT FROM 'string'
   OR item->>'status' NOT IN('pass','fail') THEN RETURN false;END IF;
 END LOOP;
 RETURN value->0->>'status'='pass';
END $$;
REVOKE ALL ON FUNCTION knowledge_evaluation_checks_valid(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION knowledge_evaluation_checks_valid(jsonb) TO yummyai_app;

CREATE FUNCTION guard_knowledge_evaluation_assessment() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE protocol_row knowledge_evaluation_protocols;eval_row knowledge_evaluation_runs;assist_row record;expected_checksum text;needs_product boolean;
BEGIN
 SELECT * INTO protocol_row FROM knowledge_evaluation_protocols WHERE tenant_id=NEW.tenant_id AND run_id=NEW.run_id;
 SELECT * INTO eval_row FROM knowledge_evaluation_runs WHERE tenant_id=NEW.tenant_id AND id=NEW.run_id;
 IF protocol_row.run_id IS NULL OR eval_row.id IS NULL OR NEW.created_by IS DISTINCT FROM protocol_row.created_by
  OR NEW.created_by IS DISTINCT FROM eval_row.created_by OR NEW.basis_fingerprint IS DISTINCT FROM protocol_row.basis_fingerprint
  OR NEW.assertion_version IS DISTINCT FROM protocol_row.assertion_version THEN
  RAISE EXCEPTION 'knowledge_evaluation_assessment_invalid' USING ERRCODE='23514';END IF;
 needs_product:=jsonb_typeof(eval_row.case_snapshot->'search'->'spuIds')='array' AND jsonb_array_length(eval_row.case_snapshot->'search'->'spuIds')>0;
 PERFORM knowledge_evaluation_require_authority(NEW.tenant_id,NEW.created_by,needs_product,protocol_row.data_scope);
 SELECT a.*,a.xmin::text AS update_transaction INTO assist_row FROM ai_assist_runs a WHERE a.tenant_id=NEW.tenant_id AND a.id=eval_row.assist_run_id;
 IF assist_row.id IS NULL OR assist_row.owner_id IS DISTINCT FROM NEW.created_by OR assist_row.status IS DISTINCT FROM 'completed'
  OR assist_row.completed_at IS NULL OR assist_row.encrypted_output IS NULL OR assist_row.creation_transaction_id IS NULL
  OR assist_row.update_transaction IS DISTINCT FROM (pg_current_xact_id()::text::numeric%4294967296)::bigint::text THEN
  RAISE EXCEPTION 'knowledge_evaluation_birth_required' USING ERRCODE='23514';END IF;
 IF NOT knowledge_evaluation_checks_valid(NEW.checks)
  OR(jsonb_array_length(eval_row.case_snapshot->'requiredEntryIds')=0) IS DISTINCT FROM (NEW.retrieval_recall IS NULL)
  OR(jsonb_array_length(eval_row.case_snapshot->'requiredEntryIds')=0) IS DISTINCT FROM (NEW.cited_recall IS NULL)
  OR NEW.checks->1->>'status' IS DISTINCT FROM(CASE WHEN NEW.retrieval_recall IS NULL OR NEW.retrieval_recall=1 THEN 'pass' ELSE 'fail' END)
  OR NEW.checks->2->>'status' IS DISTINCT FROM(CASE WHEN NEW.cited_recall IS NULL OR NEW.cited_recall=1 THEN 'pass' ELSE 'fail' END) THEN
  RAISE EXCEPTION 'knowledge_evaluation_assessment_invalid' USING ERRCODE='23514';END IF;
 expected_checksum:=encode(sha256(convert_to(invoice_reconciliation_canonical(jsonb_build_object('basisFingerprint',NEW.basis_fingerprint,
  'outputChecksum',NEW.output_checksum,'assertionVersion',NEW.assertion_version,'retrievalRecall',NEW.retrieval_recall,'citedRecall',NEW.cited_recall,'checks',NEW.checks)),'UTF8')),'hex');
 IF NEW.result_checksum IS DISTINCT FROM expected_checksum OR EXISTS(SELECT 1 FROM knowledge_governance_events e
  WHERE e.tenant_id=NEW.tenant_id AND e.resource_id=NEW.run_id AND e.action='evaluation.assessed') THEN
  RAISE EXCEPTION 'knowledge_evaluation_assessment_invalid' USING ERRCODE='23514';END IF;
 NEW.creation_transaction_id:=pg_current_xact_id()::text;
 RETURN NEW;
END $$;
CREATE TRIGGER knowledge_evaluation_assessment_guard BEFORE INSERT ON knowledge_evaluation_assessments
 FOR EACH ROW EXECUTE FUNCTION guard_knowledge_evaluation_assessment();
--> statement-breakpoint
CREATE FUNCTION guard_knowledge_evaluation_governance_event() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE protocol_row knowledge_evaluation_protocols;eval_row knowledge_evaluation_runs;assessment_row knowledge_evaluation_assessments;
BEGIN
 IF NEW.action NOT IN('evaluation.start','evaluation.assessed') THEN RETURN NEW;END IF;
 IF NEW.action='evaluation.start' THEN
  SELECT * INTO protocol_row FROM knowledge_evaluation_protocols WHERE tenant_id=NEW.tenant_id AND run_id::text=NEW.detail->>'runId';
  SELECT * INTO eval_row FROM knowledge_evaluation_runs WHERE tenant_id=NEW.tenant_id AND id=protocol_row.run_id;
  IF protocol_row.run_id IS NULL OR protocol_row.creation_transaction_id IS DISTINCT FROM pg_current_xact_id()::text
   OR NEW.created_by IS DISTINCT FROM protocol_row.created_by OR NEW.resource_id IS DISTINCT FROM eval_row.case_id
   OR NEW.detail IS DISTINCT FROM jsonb_build_object('runId',protocol_row.run_id,'assistRunId',eval_row.assist_run_id,'caseRevision',protocol_row.case_revision)
   OR EXISTS(SELECT 1 FROM knowledge_governance_events e WHERE e.tenant_id=NEW.tenant_id AND e.action='evaluation.start' AND e.detail->>'runId'=protocol_row.run_id::text) THEN
   RAISE EXCEPTION 'knowledge_evaluation_event_invalid' USING ERRCODE='23514';END IF;
 ELSE
  SELECT * INTO assessment_row FROM knowledge_evaluation_assessments WHERE tenant_id=NEW.tenant_id AND run_id=NEW.resource_id;
  IF assessment_row.id IS NULL OR assessment_row.creation_transaction_id IS DISTINCT FROM pg_current_xact_id()::text
   OR NEW.created_by IS DISTINCT FROM assessment_row.created_by
   OR NEW.detail IS DISTINCT FROM jsonb_build_object('assessmentId',assessment_row.id,'outputChecksum',assessment_row.output_checksum,'resultChecksum',assessment_row.result_checksum)
   OR EXISTS(SELECT 1 FROM knowledge_governance_events e WHERE e.tenant_id=NEW.tenant_id AND e.resource_id=NEW.resource_id AND e.action='evaluation.assessed') THEN
   RAISE EXCEPTION 'knowledge_evaluation_event_invalid' USING ERRCODE='23514';END IF;
 END IF;
 IF NEW.created_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid THEN
  RAISE EXCEPTION 'knowledge_evaluation_actor_invalid' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER a_knowledge_evaluation_governance_event BEFORE INSERT ON knowledge_governance_events
 FOR EACH ROW EXECUTE FUNCTION guard_knowledge_evaluation_governance_event();

CREATE FUNCTION require_knowledge_evaluation_protocol() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE protocol_row knowledge_evaluation_protocols;eval_row knowledge_evaluation_runs;assist_row ai_assist_runs;case_row knowledge_evaluation_cases;event_count bigint;
BEGIN
 IF TG_TABLE_NAME='knowledge_evaluation_runs' THEN eval_row:=NEW;
 ELSE SELECT * INTO eval_row FROM knowledge_evaluation_runs WHERE tenant_id=NEW.tenant_id AND id=NEW.run_id;END IF;
 SELECT * INTO protocol_row FROM knowledge_evaluation_protocols WHERE tenant_id=eval_row.tenant_id AND run_id=eval_row.id;
 IF protocol_row.run_id IS NULL OR protocol_row.creation_transaction_id IS DISTINCT FROM pg_current_xact_id()::text
  OR protocol_row.created_by IS DISTINCT FROM eval_row.created_by THEN
  RAISE EXCEPTION 'knowledge_evaluation_protocol_required' USING ERRCODE='23514';END IF;
 SELECT * INTO assist_row FROM ai_assist_runs WHERE tenant_id=eval_row.tenant_id AND id=eval_row.assist_run_id;
 SELECT * INTO case_row FROM knowledge_evaluation_cases WHERE tenant_id=eval_row.tenant_id AND id=eval_row.case_id;
 IF assist_row.id IS NULL OR assist_row.creation_transaction_id IS DISTINCT FROM pg_current_xact_id()
  OR assist_row.status IS DISTINCT FROM 'queued' OR assist_row.encrypted_input IS NULL OR assist_row.encrypted_output IS NOT NULL
  OR assist_row.owner_id IS DISTINCT FROM eval_row.created_by OR assist_row.request_id IS DISTINCT FROM eval_row.request_id
  OR assist_row.input_fingerprint IS DISTINCT FROM protocol_row.input_fingerprint OR assist_row.prompt_version IS DISTINCT FROM protocol_row.prompt_version
  OR assist_row.model_snapshot->'id' IS DISTINCT FROM to_jsonb(protocol_row.model_id::text) OR assist_row.scope IS DISTINCT FROM 'knowledge:'||eval_row.case_id::text
  OR case_row.revision IS DISTINCT FROM protocol_row.case_revision OR case_row.fields IS DISTINCT FROM eval_row.case_snapshot OR case_row.archived_at IS NOT NULL
  OR NOT EXISTS(SELECT 1 FROM ai_assist_executions e WHERE e.tenant_id=eval_row.tenant_id AND e.run_id=eval_row.assist_run_id
   AND e.contract_version='assist-execution-v1' AND e.input_fingerprint=protocol_row.input_fingerprint
   AND e.phase='pending' AND e.submission_state='not_submitted' AND e.attempt_count=0 AND e.dispatch_count=0) THEN
  RAISE EXCEPTION 'knowledge_evaluation_native_owner_invalid' USING ERRCODE='23514';END IF;
 SELECT count(*) INTO event_count FROM knowledge_governance_events e WHERE e.tenant_id=eval_row.tenant_id AND e.resource_id=eval_row.case_id
  AND e.action='evaluation.start' AND e.created_by=eval_row.created_by
  AND e.detail=jsonb_build_object('runId',eval_row.id,'assistRunId',eval_row.assist_run_id,'caseRevision',protocol_row.case_revision)
  AND e.xmin::text=(pg_current_xact_id()::text::numeric%4294967296)::bigint::text;
 IF event_count<>1 THEN RAISE EXCEPTION 'knowledge_evaluation_start_event_required' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER knowledge_evaluation_run_protocol AFTER INSERT ON knowledge_evaluation_runs
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_knowledge_evaluation_protocol();
CREATE CONSTRAINT TRIGGER knowledge_evaluation_protocol_closure AFTER INSERT ON knowledge_evaluation_protocols
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_knowledge_evaluation_protocol();
--> statement-breakpoint
CREATE FUNCTION require_knowledge_evaluation_assessment() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE assessment_row knowledge_evaluation_assessments;protocol_row knowledge_evaluation_protocols;eval_row knowledge_evaluation_runs;assist_row record;event_count bigint;
BEGIN
 IF TG_TABLE_NAME='knowledge_evaluation_assessments' THEN
  assessment_row:=NEW;
  SELECT * INTO eval_row FROM knowledge_evaluation_runs WHERE tenant_id=NEW.tenant_id AND id=NEW.run_id;
 ELSE
  IF NEW.status<>'completed' THEN RETURN NULL;END IF;
  IF TG_OP='UPDATE' THEN IF OLD.status='completed' THEN RETURN NULL;END IF;END IF;
  SELECT e.* INTO eval_row FROM knowledge_evaluation_runs e JOIN knowledge_evaluation_protocols p ON p.tenant_id=e.tenant_id AND p.run_id=e.id
   WHERE e.tenant_id=NEW.tenant_id AND e.assist_run_id=NEW.id;
  IF eval_row.id IS NULL THEN RETURN NULL;END IF;
  SELECT * INTO assessment_row FROM knowledge_evaluation_assessments WHERE tenant_id=eval_row.tenant_id AND run_id=eval_row.id;
 END IF;
 SELECT * INTO protocol_row FROM knowledge_evaluation_protocols WHERE tenant_id=eval_row.tenant_id AND run_id=eval_row.id;
 SELECT a.*,a.xmin::text AS update_transaction INTO assist_row FROM ai_assist_runs a WHERE a.tenant_id=eval_row.tenant_id AND a.id=eval_row.assist_run_id;
 IF assessment_row.id IS NULL OR assessment_row.creation_transaction_id IS DISTINCT FROM pg_current_xact_id()::text
  OR assessment_row.created_by IS DISTINCT FROM eval_row.created_by OR protocol_row.run_id IS NULL
  OR assessment_row.basis_fingerprint IS DISTINCT FROM protocol_row.basis_fingerprint OR assist_row.status IS DISTINCT FROM 'completed'
  OR assist_row.completed_at IS NULL OR assist_row.encrypted_output IS NULL
  OR assist_row.update_transaction IS DISTINCT FROM (pg_current_xact_id()::text::numeric%4294967296)::bigint::text
  OR NOT EXISTS(SELECT 1 FROM ai_assist_executions e WHERE e.tenant_id=eval_row.tenant_id AND e.run_id=eval_row.assist_run_id
   AND e.phase='completed' AND e.submission_state='received' AND e.received_at IS NOT NULL AND e.response_checksum IS NOT NULL) THEN
  RAISE EXCEPTION 'knowledge_evaluation_assessment_required' USING ERRCODE='23514';END IF;
 SELECT count(*) INTO event_count FROM knowledge_governance_events e WHERE e.tenant_id=eval_row.tenant_id AND e.resource_id=eval_row.id
  AND e.action='evaluation.assessed' AND e.created_by=assessment_row.created_by
  AND e.detail=jsonb_build_object('assessmentId',assessment_row.id,'outputChecksum',assessment_row.output_checksum,'resultChecksum',assessment_row.result_checksum)
  AND e.xmin::text=(pg_current_xact_id()::text::numeric%4294967296)::bigint::text;
 IF event_count<>1 THEN RAISE EXCEPTION 'knowledge_evaluation_assessed_event_required' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER knowledge_evaluation_assessment_closure AFTER INSERT ON knowledge_evaluation_assessments
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_knowledge_evaluation_assessment();
CREATE CONSTRAINT TRIGGER knowledge_evaluation_ai_completed AFTER INSERT OR UPDATE ON ai_assist_runs
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_knowledge_evaluation_assessment();

CREATE FUNCTION guard_knowledge_evaluation_case_seal() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW IS DISTINCT FROM OLD AND EXISTS(SELECT 1 FROM knowledge_evaluation_protocols p JOIN knowledge_evaluation_runs e ON e.tenant_id=p.tenant_id AND e.id=p.run_id
  WHERE e.tenant_id=OLD.tenant_id AND e.case_id=OLD.id AND p.creation_transaction_id=pg_current_xact_id()::text) THEN
  RAISE EXCEPTION 'knowledge_evaluation_case_sealed' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER a_knowledge_evaluation_case_seal BEFORE UPDATE ON knowledge_evaluation_cases
 FOR EACH ROW EXECUTE FUNCTION guard_knowledge_evaluation_case_seal();

-- Initial intent is dispatched only after commit. A prior early constraint
-- flush must not permit changing that intent later in its admission transaction.
CREATE FUNCTION guard_knowledge_evaluation_native_seal() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE assist_identity uuid;
BEGIN
 IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW;END IF;
 IF TG_TABLE_NAME='ai_assist_runs' THEN assist_identity:=OLD.id;ELSE assist_identity:=OLD.run_id;END IF;
 IF EXISTS(SELECT 1 FROM knowledge_evaluation_runs e JOIN knowledge_evaluation_protocols p ON p.tenant_id=e.tenant_id AND p.run_id=e.id
  WHERE e.tenant_id=OLD.tenant_id AND e.assist_run_id=assist_identity AND p.creation_transaction_id=pg_current_xact_id()::text) THEN
  RAISE EXCEPTION 'knowledge_evaluation_native_sealed' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER a_knowledge_evaluation_native_seal BEFORE UPDATE ON ai_assist_runs
 FOR EACH ROW EXECUTE FUNCTION guard_knowledge_evaluation_native_seal();
CREATE TRIGGER a_knowledge_evaluation_native_seal BEFORE UPDATE ON ai_assist_executions
 FOR EACH ROW EXECUTE FUNCTION guard_knowledge_evaluation_native_seal();
