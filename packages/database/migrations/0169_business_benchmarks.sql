-- Additive original-role benchmark adapters. No legacy rows or proofs are rewritten.
ALTER TABLE knowledge_benchmark_items ALTER COLUMN case_id DROP NOT NULL;
ALTER TABLE knowledge_benchmark_attempts ADD COLUMN native_run_id uuid;
ALTER TABLE ai_assist_runs ADD COLUMN benchmark_item_id uuid;
ALTER TABLE knowledge_benchmark_commands ADD COLUMN business_roles jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE ai_assist_runs ADD CONSTRAINT ai_assist_benchmark_item_fk FOREIGN KEY(tenant_id,benchmark_item_id) REFERENCES knowledge_benchmark_items(tenant_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE knowledge_benchmark_attempts ADD CONSTRAINT knowledge_benchmark_attempt_native_fk FOREIGN KEY(tenant_id,native_run_id) REFERENCES ai_assist_runs(tenant_id,id);
CREATE UNIQUE INDEX knowledge_benchmark_attempt_native_unique ON knowledge_benchmark_attempts(tenant_id,native_run_id);
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname,conrelid::regclass AS tbl FROM pg_constraint WHERE contype='c' AND
  ((conrelid='knowledge_benchmark_attempts'::regclass AND pg_get_constraintdef(oid) LIKE '%evaluation_run_id%')
   OR(conrelid='knowledge_benchmark_items'::regclass AND pg_get_constraintdef(oid) LIKE '%source_pins%')
   OR(conrelid='knowledge_benchmark_experiments'::regclass AND (pg_get_constraintdef(oid) LIKE '%baseline_version%' OR pg_get_constraintdef(oid) LIKE '%grader_version%'))
   OR(conrelid='knowledge_benchmark_assessments'::regclass AND pg_get_constraintdef(oid) LIKE '%grader_version%'))
 LOOP EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',c.tbl,c.conname);END LOOP;
END $$;
ALTER TABLE knowledge_benchmark_items ADD CONSTRAINT benchmark_source_pins_v2 CHECK(jsonb_typeof(source_pins)='array' AND jsonb_array_length(source_pins)<=CASE WHEN fields->>'role'='knowledge_answer' THEN 6 ELSE 32 END);
ALTER TABLE knowledge_benchmark_attempts ADD CONSTRAINT benchmark_native_kind_v2 CHECK((arm='baseline' AND ordinal=1 AND evaluation_run_id IS NULL AND native_run_id IS NULL)
 OR(arm='candidate' AND ((evaluation_run_id IS NOT NULL AND native_run_id IS NULL) OR(evaluation_run_id IS NULL AND native_run_id IS NOT NULL))));
ALTER TABLE knowledge_benchmark_experiments ADD CONSTRAINT benchmark_rule_version_v2 CHECK(baseline_version IN('extractive-arithmetic-v1','business-facts-v1'));
ALTER TABLE knowledge_benchmark_experiments ADD CONSTRAINT benchmark_grader_version_v2 CHECK(grader_version IN('knowledge-benchmark-checks-v1','business-benchmark-checks-v1'));
ALTER TABLE knowledge_benchmark_assessments ADD CONSTRAINT benchmark_assessment_version_v2 CHECK(grader_version IN('knowledge-benchmark-checks-v1','business-benchmark-checks-v1'));

--> statement-breakpoint
CREATE FUNCTION knowledge_benchmark_require_business_authority(tenant uuid,actor uuid,pinned_scope text,fields jsonb) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE bit text;bits text[]:=ARRAY[]::text[];actual integer;needed integer;
BEGIN
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(fields->'items') x WHERE x->>'role'='procurement_review') THEN bits:=bits||ARRAY['procurement:read','inventory:read'];END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(fields->'items') x WHERE x->>'role'='business_review') THEN bits:=bits||ARRAY['finance:read','order:read'];END IF;
 needed:=CASE pinned_scope WHEN 'tenant' THEN 3 WHEN 'team' THEN 2 WHEN 'self' THEN 1 ELSE 4 END;
 PERFORM 1 FROM memberships m JOIN membership_roles mr ON mr.tenant_id=m.tenant_id AND mr.membership_id=m.id JOIN roles r ON r.tenant_id=mr.tenant_id AND r.id=mr.role_id
  WHERE m.tenant_id=tenant AND m.user_id=actor ORDER BY m.id,mr.role_id FOR SHARE OF m,mr,r;
 FOREACH bit IN ARRAY bits LOOP
  SELECT coalesce(max(CASE r.data_scope WHEN 'tenant' THEN 3 WHEN 'team' THEN 2 WHEN 'self' THEN 1 ELSE 0 END),0) INTO actual
   FROM memberships m JOIN membership_roles mr ON mr.tenant_id=m.tenant_id AND mr.membership_id=m.id JOIN roles r ON r.tenant_id=mr.tenant_id AND r.id=mr.role_id
   WHERE m.tenant_id=tenant AND m.user_id=actor AND m.status='active' AND(r.permissions?bit OR r.permissions?'*');
  IF actual<3 OR actual<needed THEN RAISE EXCEPTION 'benchmark_business_authority_required' USING ERRCODE='23514';END IF;
 END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION knowledge_benchmark_command_business_roles(operation text,parent_id uuid,receipt jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public AS $$
DECLARE result_id uuid:=(receipt->>'id')::uuid;dataset_fields jsonb;experiment_id uuid;version_id uuid;
BEGIN
 CASE operation
 WHEN 'dataset.create','dataset.save' THEN SELECT fields INTO dataset_fields FROM knowledge_benchmark_datasets WHERE id=result_id;
 WHEN 'dataset.publish' THEN version_id:=result_id;
 WHEN 'experiment.create' THEN experiment_id:=result_id;
 WHEN 'attempt.start' THEN SELECT a.experiment_id INTO experiment_id FROM knowledge_benchmark_attempts a WHERE a.id=result_id;
 WHEN 'attempt.review' THEN SELECT a.experiment_id INTO experiment_id FROM knowledge_benchmark_reviews r JOIN knowledge_benchmark_attempts a ON a.id=r.attempt_id AND a.tenant_id=r.tenant_id WHERE r.id=result_id;
 WHEN 'expense.record' THEN SELECT e.experiment_id INTO experiment_id FROM knowledge_benchmark_expenses e WHERE e.id=result_id;
 WHEN 'report.create' THEN SELECT r.experiment_id INTO experiment_id FROM knowledge_benchmark_reports r WHERE r.id=result_id;
 ELSE RAISE EXCEPTION 'benchmark_command_result_invalid' USING ERRCODE='23514';END CASE;
 IF experiment_id IS NOT NULL THEN SELECT dataset_version_id INTO version_id FROM knowledge_benchmark_experiments WHERE id=experiment_id;END IF;
 IF version_id IS NOT NULL THEN SELECT manifest->'fields' INTO dataset_fields FROM knowledge_benchmark_versions WHERE id=version_id;END IF;
 RETURN coalesce((SELECT jsonb_agg(role ORDER BY role) FROM(SELECT DISTINCT x->>'role' AS role FROM jsonb_array_elements(dataset_fields->'items') x WHERE x->>'role' IN('business_review','procurement_review')) roles),'[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION knowledge_benchmark_command_business_roles(text,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION knowledge_benchmark_command_business_roles(text,uuid,jsonb) TO yummyai_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION knowledge_benchmark_case_valid(value jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE task jsonb;operand jsonb;
BEGIN
 IF value->>'role' IN('procurement_review','business_review') THEN
  IF (value-ARRAY['key','role','label','task','expectedFacts','forbiddenClaims','expectRefusal'])<>'{}'::jsonb
   OR coalesce(value->>'key','')!~'^[a-z][a-z0-9_-]{0,59}$' OR length(coalesce(value->>'label','')) NOT BETWEEN 1 AND 180
   OR jsonb_typeof(value->'task') IS DISTINCT FROM 'object' OR value->'task'->>'kind' IS DISTINCT FROM value->>'role'
   OR coalesce(value->'task'->>'expectedTaskFingerprint','')!~'^[a-f0-9]{64}$' OR coalesce(value->'task'->>'expectedFingerprint','')!~'^[a-f0-9]{64}$'
   OR value->'task'?'requestId' OR value->'task'?'modelId' OR jsonb_typeof(value->'expectRefusal') IS DISTINCT FROM 'boolean'
   OR jsonb_typeof(value->'expectedFacts') IS DISTINCT FROM 'array' OR jsonb_array_length(value->'expectedFacts')>20
   OR jsonb_typeof(value->'forbiddenClaims') IS DISTINCT FROM 'array' OR jsonb_array_length(value->'forbiddenClaims')>20
   OR EXISTS(SELECT 1 FROM jsonb_array_elements((value->'expectedFacts')||(value->'forbiddenClaims')) x WHERE jsonb_typeof(x)<>'string' OR length(x#>>'{}') NOT BETWEEN 1 AND 500)
   THEN RETURN false;END IF;
  RETURN true;
 END IF;
 IF value->>'role' IS DISTINCT FROM 'knowledge_answer' OR coalesce(value->>'key','')!~'^[a-z][a-z0-9_-]{0,59}$' OR jsonb_typeof(value->'evaluation') IS DISTINCT FROM 'object'
  OR jsonb_typeof(value->'calculations') IS DISTINCT FROM 'array' OR jsonb_array_length(value->'calculations')>20 THEN RETURN false;END IF;
 FOR task IN SELECT x FROM jsonb_array_elements(value->'calculations') x LOOP
  IF coalesce(task->>'key','')!~'^[a-z][a-z0-9_]{0,59}$' OR coalesce(task->>'operator','') NOT IN('sum','difference','product','quotient')
   OR jsonb_typeof(task->'operands') IS DISTINCT FROM 'array' OR jsonb_array_length(task->'operands') NOT BETWEEN 2 AND 20
   OR (task->>'scale')::integer NOT BETWEEN 0 AND 8 OR length(coalesce(task->>'unit','')) NOT BETWEEN 1 AND 40
   OR coalesce(task->>'expectedValue','')!~'^-?(0|[1-9][0-9]{0,11})(\.[0-9]{1,9})?$' THEN RETURN false;END IF;
  IF task->>'operator'='quotient' AND jsonb_array_length(task->'operands')<>2 THEN RETURN false;END IF;
  FOR operand IN SELECT x FROM jsonb_array_elements(task->'operands') x LOOP
   IF jsonb_typeof(operand)<>'string' OR operand#>>'{}'!~'^-?(0|[1-9][0-9]{0,11})(\.[0-9]{1,9})?$' THEN RETURN false;END IF;
  END LOOP;
 END LOOP;
 RETURN (SELECT count(*)=count(DISTINCT x->>'key') FROM jsonb_array_elements(value->'calculations') x);
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_knowledge_benchmark_record() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE business_fields jsonb;pinned_scope text;operation text;parent record;attempt record;previous record;item record;born text:=pg_current_xact_id()::text;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'benchmark_history_immutable' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' THEN
  IF TG_TABLE_NAME='knowledge_benchmark_items' THEN
   IF OLD.encrypted_basis IS NOT NULL AND NEW.encrypted_basis IS NULL AND OLD.expires_at<=knowledge_benchmark_now()
    AND(to_jsonb(NEW)-'encrypted_basis')=(to_jsonb(OLD)-'encrypted_basis') THEN RETURN NEW;END IF;
  ELSIF TG_TABLE_NAME='knowledge_benchmark_assessments' THEN
   IF OLD.encrypted_output IS NOT NULL AND NEW.encrypted_output IS NULL AND OLD.expires_at<=knowledge_benchmark_now()
    AND(to_jsonb(NEW)-'encrypted_output')=(to_jsonb(OLD)-'encrypted_output') THEN RETURN NEW;END IF;
  END IF;
  IF TG_TABLE_NAME<>'knowledge_benchmark_datasets' THEN RAISE EXCEPTION 'benchmark_history_immutable' USING ERRCODE='23514';END IF;
  IF(to_jsonb(NEW)-ARRAY['fields','revision','updated_at']) IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['fields','revision','updated_at'])
   OR NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'benchmark_dataset_revision_invalid' USING ERRCODE='23514';END IF;
  IF EXISTS(SELECT 1 FROM knowledge_benchmark_versions WHERE dataset_id=OLD.id AND creation_transaction_id=born) THEN
   RAISE EXCEPTION 'benchmark_publish_transaction_sealed' USING ERRCODE='23514';END IF;
 ELSE NEW.creation_transaction_id:=born;
 END IF;
 IF NEW.created_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid THEN RAISE EXCEPTION 'benchmark_actor_invalid' USING ERRCODE='23514';END IF;
 CASE TG_TABLE_NAME
 WHEN 'knowledge_benchmark_datasets' THEN pinned_scope:=NEW.data_scope;operation:='manage';
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.fields->'items') x WHERE x->>'role'='knowledge_answer')
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.fields->'items') x WHERE x->>'role'<>'knowledge_answer') THEN
   RAISE EXCEPTION 'benchmark_role_family_mixed' USING ERRCODE='23514';END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.fields->'items') x WHERE NOT knowledge_benchmark_case_valid(x)) THEN RAISE EXCEPTION 'benchmark_case_invalid' USING ERRCODE='23514';END IF;
 WHEN 'knowledge_benchmark_versions' THEN pinned_scope:=NEW.data_scope;operation:='publish';
  PERFORM pg_advisory_xact_lock(hashtextextended('knowledge-benchmark-dataset:'||NEW.tenant_id::text||':'||NEW.dataset_id::text,0));
  SELECT * INTO previous FROM knowledge_benchmark_versions WHERE dataset_id=NEW.dataset_id ORDER BY version DESC LIMIT 1;
  IF NEW.version<>coalesce(previous.version,0)+1 THEN RAISE EXCEPTION 'benchmark_version_sequence_invalid' USING ERRCODE='23514';END IF;
 WHEN 'knowledge_benchmark_items' THEN
  SELECT * INTO parent FROM knowledge_benchmark_versions WHERE id=NEW.version_id;
  pinned_scope:=parent.data_scope;operation:='publish';
  IF parent.creation_transaction_id IS DISTINCT FROM born OR NOT knowledge_benchmark_case_valid(NEW.fields) OR NEW.encrypted_basis IS NULL
   OR NEW.expires_at<=knowledge_benchmark_now() OR NEW.expires_at>knowledge_benchmark_now()+interval '30 days' THEN RAISE EXCEPTION 'benchmark_item_birth_invalid' USING ERRCODE='23514';END IF;
 WHEN 'knowledge_benchmark_experiments' THEN pinned_scope:=NEW.data_scope;operation:='run';
  SELECT manifest->'fields' INTO business_fields FROM knowledge_benchmark_versions WHERE id=NEW.dataset_version_id;
  IF NEW.baseline_version IS DISTINCT FROM (CASE WHEN business_fields->'items'->0->>'role'='knowledge_answer' THEN 'extractive-arithmetic-v1' ELSE 'business-facts-v1' END)
   OR NEW.grader_version IS DISTINCT FROM (CASE WHEN business_fields->'items'->0->>'role'='knowledge_answer' THEN 'knowledge-benchmark-checks-v1' ELSE 'business-benchmark-checks-v1' END) THEN
   RAISE EXCEPTION 'benchmark_role_policy_invalid' USING ERRCODE='23514';END IF;
  IF NEW.route_fingerprint IS DISTINCT FROM knowledge_benchmark_route(NEW.model_id) THEN RAISE EXCEPTION 'benchmark_route_changed' USING ERRCODE='23514';END IF;
 WHEN 'knowledge_benchmark_attempts' THEN
  SELECT * INTO parent FROM knowledge_benchmark_experiments WHERE id=NEW.experiment_id;
  SELECT * INTO item FROM knowledge_benchmark_items WHERE id=NEW.item_id;
  pinned_scope:=parent.data_scope;operation:='run';
  IF item.version_id IS DISTINCT FROM parent.dataset_version_id OR parent.created_by IS DISTINCT FROM NEW.created_by
   OR NEW.ordinal>parent.max_attempts_per_item THEN RAISE EXCEPTION 'benchmark_attempt_parent_invalid' USING ERRCODE='23514';END IF;
  IF NEW.arm='candidate' THEN
   PERFORM pg_advisory_xact_lock(hashtextextended('knowledge-benchmark-experiment:'||NEW.tenant_id::text||':'||NEW.experiment_id::text,0));
   SELECT * INTO previous FROM knowledge_benchmark_attempts WHERE experiment_id=NEW.experiment_id AND item_id=NEW.item_id AND arm='candidate' ORDER BY ordinal DESC LIMIT 1;
   IF NEW.ordinal<>coalesce(previous.ordinal,0)+1 OR parent.route_fingerprint IS DISTINCT FROM knowledge_benchmark_route(parent.model_id) THEN RAISE EXCEPTION 'benchmark_attempt_changed' USING ERRCODE='23514';END IF;
  ELSIF parent.creation_transaction_id IS DISTINCT FROM born THEN RAISE EXCEPTION 'benchmark_baseline_birth_invalid' USING ERRCODE='23514';END IF;
  IF EXISTS(SELECT 1 FROM knowledge_benchmark_expenses e WHERE e.experiment_id=NEW.experiment_id AND e.arm=NEW.arm AND e.creation_transaction_id=born) THEN
   RAISE EXCEPTION 'benchmark_expense_transaction_sealed' USING ERRCODE='23514';END IF;
 WHEN 'knowledge_benchmark_assessments' THEN
  SELECT * INTO attempt FROM knowledge_benchmark_attempts WHERE id=NEW.attempt_id;
  SELECT * INTO parent FROM knowledge_benchmark_experiments WHERE id=attempt.experiment_id;
  SELECT * INTO item FROM knowledge_benchmark_items WHERE id=attempt.item_id;
  pinned_scope:=parent.data_scope;operation:='run';
  IF NEW.case_checksum IS DISTINCT FROM item.case_checksum OR NEW.basis_fingerprint IS DISTINCT FROM item.basis_fingerprint OR NEW.expires_at IS DISTINCT FROM item.expires_at
   OR NEW.created_by IS DISTINCT FROM attempt.created_by OR NEW.hard_pass IS DISTINCT FROM NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.checks) c WHERE c->>'status'<>'pass')
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.checks) c WHERE coalesce(c->>'status','') NOT IN('pass','fail')) THEN RAISE EXCEPTION 'benchmark_assessment_invalid' USING ERRCODE='23514';END IF;
  IF attempt.arm='baseline' AND(attempt.creation_transaction_id<>born OR NEW.encrypted_output IS NULL)
   OR attempt.arm='candidate' AND NEW.encrypted_output IS NOT NULL THEN RAISE EXCEPTION 'benchmark_assessment_body_invalid' USING ERRCODE='23514';END IF;
 WHEN 'knowledge_benchmark_reviews' THEN
  SELECT * INTO attempt FROM knowledge_benchmark_attempts WHERE id=NEW.attempt_id;
  SELECT * INTO parent FROM knowledge_benchmark_experiments WHERE id=attempt.experiment_id;
  pinned_scope:=parent.data_scope;operation:='review';
  PERFORM pg_advisory_xact_lock(hashtextextended('knowledge-benchmark-experiment:'||NEW.tenant_id::text||':'||parent.id::text,0));
  SELECT * INTO previous FROM knowledge_benchmark_reviews WHERE attempt_id=NEW.attempt_id ORDER BY sequence DESC LIMIT 1;
  IF NEW.sequence<>coalesce(previous.sequence,0)+1 OR NEW.previous_id IS DISTINCT FROM previous.id
   OR NOT EXISTS(SELECT 1 FROM knowledge_benchmark_assessments s WHERE s.id=NEW.assessment_id AND s.attempt_id=NEW.attempt_id AND s.expires_at>knowledge_benchmark_now()) THEN
   RAISE EXCEPTION 'benchmark_review_changed' USING ERRCODE='23514';END IF;
  IF EXISTS(SELECT 1 FROM knowledge_benchmark_expenses e WHERE e.experiment_id=parent.id AND e.arm=attempt.arm AND e.creation_transaction_id=born) THEN
   RAISE EXCEPTION 'benchmark_expense_transaction_sealed' USING ERRCODE='23514';END IF;
 WHEN 'knowledge_benchmark_expenses' THEN
  SELECT * INTO parent FROM knowledge_benchmark_experiments WHERE id=NEW.experiment_id;
  pinned_scope:=parent.data_scope;operation:='review';
  PERFORM pg_advisory_xact_lock(hashtextextended('knowledge-benchmark-experiment:'||NEW.tenant_id::text||':'||parent.id::text,0));
  SELECT * INTO previous FROM knowledge_benchmark_expenses WHERE experiment_id=NEW.experiment_id AND arm=NEW.arm ORDER BY sequence DESC LIMIT 1;
  IF NEW.sequence<>coalesce(previous.sequence,0)+1 OR NEW.previous_id IS DISTINCT FROM previous.id
   OR NEW.activity_fingerprint IS DISTINCT FROM knowledge_benchmark_activity(NEW.experiment_id,NEW.arm) THEN RAISE EXCEPTION 'benchmark_expense_changed' USING ERRCODE='23514';END IF;
  IF date_trunc('milliseconds',NEW.period_start)>date_trunc('milliseconds',parent.created_at) OR NEW.period_end>knowledge_benchmark_now()+interval '5 seconds' OR EXISTS(
   SELECT 1 FROM knowledge_benchmark_attempts a WHERE a.experiment_id=parent.id AND a.arm=NEW.arm AND(date_trunc('milliseconds',a.created_at)>NEW.period_end
    OR EXISTS(SELECT 1 FROM knowledge_benchmark_assessments s WHERE s.attempt_id=a.id AND date_trunc('milliseconds',s.created_at)>NEW.period_end)
    OR EXISTS(SELECT 1 FROM knowledge_benchmark_reviews r WHERE r.attempt_id=a.id AND date_trunc('milliseconds',r.created_at)>NEW.period_end))) THEN
   RAISE EXCEPTION 'benchmark_expense_coverage_invalid' USING ERRCODE='23514';END IF;
 WHEN 'knowledge_benchmark_commands' THEN
  NEW.business_roles:=knowledge_benchmark_command_business_roles(NEW.operation,NEW.parent_id,NEW.receipt);
  business_fields:=jsonb_build_object('items',(SELECT coalesce(jsonb_agg(jsonb_build_object('role',x)),'[]'::jsonb) FROM jsonb_array_elements_text(NEW.business_roles) x));
  pinned_scope:=NEW.data_scope;operation:=CASE WHEN NEW.operation IN('dataset.create','dataset.save') THEN 'manage'
   WHEN NEW.operation='dataset.publish' THEN 'publish' WHEN NEW.operation IN('experiment.create','attempt.start') THEN 'run' ELSE 'review' END;
  PERFORM pg_advisory_xact_lock(hashtextextended('knowledge-benchmark-request:'||NEW.tenant_id::text||':'||NEW.request_id::text,0));
 WHEN 'knowledge_benchmark_reports' THEN
  SELECT * INTO parent FROM knowledge_benchmark_experiments WHERE id=NEW.experiment_id;pinned_scope:=parent.data_scope;operation:='review';
  IF NEW.manifest_checksum IS DISTINCT FROM knowledge_benchmark_checksum(NEW.manifest-'manifestChecksum') OR NEW.manifest->>'manifestChecksum' IS DISTINCT FROM NEW.manifest_checksum
   OR NEW.manifest->>'id' IS DISTINCT FROM NEW.id::text OR NEW.manifest->>'experimentId' IS DISTINCT FROM NEW.experiment_id::text
   OR (NEW.manifest->>'sequence')::integer IS DISTINCT FROM NEW.sequence THEN RAISE EXCEPTION 'benchmark_report_invalid' USING ERRCODE='23514';END IF;
 ELSE RAISE EXCEPTION 'benchmark_record_invalid' USING ERRCODE='23514';
 END CASE;
 IF TG_TABLE_NAME='knowledge_benchmark_datasets' THEN business_fields:=NEW.fields;
 ELSIF TG_TABLE_NAME='knowledge_benchmark_versions' THEN SELECT fields INTO business_fields FROM knowledge_benchmark_datasets WHERE id=NEW.dataset_id;
 ELSIF TG_TABLE_NAME='knowledge_benchmark_items' THEN SELECT manifest->'fields' INTO business_fields FROM knowledge_benchmark_versions WHERE id=NEW.version_id;
 ELSIF TG_TABLE_NAME IN('knowledge_benchmark_attempts','knowledge_benchmark_assessments','knowledge_benchmark_reviews','knowledge_benchmark_expenses','knowledge_benchmark_reports') THEN
  SELECT manifest->'fields' INTO business_fields FROM knowledge_benchmark_versions WHERE id=parent.dataset_version_id;
 END IF;
 IF business_fields IS NOT NULL THEN PERFORM knowledge_benchmark_require_business_authority(NEW.tenant_id,NEW.created_by,pinned_scope,business_fields);END IF;
 IF pinned_scope IS NULL THEN RAISE EXCEPTION 'benchmark_parent_unavailable' USING ERRCODE='23514';END IF;
 PERFORM knowledge_benchmark_require_authority(NEW.tenant_id,NEW.created_by,pinned_scope,operation);
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION require_knowledge_benchmark_record() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE born text:=pg_current_xact_id()::text;parent record;item record;attempt record;command record;event_action text;event_resource uuid:=NEW.id;pin jsonb;expected integer;
BEGIN
 IF TG_OP='UPDATE' AND TG_TABLE_NAME IN('knowledge_benchmark_items','knowledge_benchmark_assessments') THEN
  IF NOT EXISTS(SELECT 1 FROM knowledge_benchmark_retention_jobs j WHERE j.tenant_id=NEW.tenant_id AND j.resource_id=NEW.id AND j.created_by=NEW.created_by AND j.state='completed'
    AND j.xmin::text=(pg_current_xact_id()::text::numeric%4294967296)::text)
   OR NOT EXISTS(SELECT 1 FROM knowledge_governance_events e WHERE e.tenant_id=NEW.tenant_id AND e.resource_id=NEW.id AND e.created_by=NEW.created_by
    AND e.action='benchmark.body.purged' AND e.xmin::text=(pg_current_xact_id()::text::numeric%4294967296)::text) THEN
   RAISE EXCEPTION 'benchmark_retention_receipt_required' USING ERRCODE='23514';END IF;
  RETURN NULL;
 END IF;
 IF TG_TABLE_NAME='knowledge_benchmark_datasets' THEN
  event_action:=CASE WHEN TG_OP='INSERT' THEN 'benchmark.dataset.create' ELSE 'benchmark.dataset.save' END;
  IF NOT EXISTS(SELECT 1 FROM knowledge_benchmark_commands c WHERE c.receipt->>'id'=NEW.id::text AND(c.receipt->>'revision')::integer=NEW.revision AND c.creation_transaction_id=born
    AND c.operation=CASE WHEN TG_OP='INSERT' THEN 'dataset.create' ELSE 'dataset.save' END) THEN RAISE EXCEPTION 'benchmark_command_required' USING ERRCODE='23514';END IF;
 ELSIF TG_TABLE_NAME='knowledge_benchmark_versions' THEN
  event_action:='benchmark.dataset.publish';
  SELECT * INTO parent FROM knowledge_benchmark_datasets WHERE id=NEW.dataset_id;
  IF parent.revision IS DISTINCT FROM NEW.dataset_revision OR NEW.manifest->'fields' IS DISTINCT FROM parent.fields OR NEW.checksum IS DISTINCT FROM knowledge_benchmark_checksum(NEW.manifest)
   OR NEW.manifest->>'version' IS DISTINCT FROM 'knowledge-benchmark-dataset-v1' OR jsonb_array_length(NEW.manifest->'items') IS DISTINCT FROM NEW.item_count
   OR(SELECT count(*) FROM knowledge_benchmark_items i WHERE i.version_id=NEW.id AND i.creation_transaction_id=born)<>NEW.item_count THEN RAISE EXCEPTION 'benchmark_version_incomplete' USING ERRCODE='23514';END IF;
  IF NOT EXISTS(SELECT 1 FROM knowledge_benchmark_commands WHERE receipt->>'id'=NEW.id::text AND operation='dataset.publish' AND parent_id=NEW.dataset_id AND creation_transaction_id=born) THEN RAISE EXCEPTION 'benchmark_command_required' USING ERRCODE='23514';END IF;
 ELSIF TG_TABLE_NAME='knowledge_benchmark_items' THEN
  SELECT * INTO parent FROM knowledge_benchmark_versions WHERE id=NEW.version_id;
  pin:=parent.manifest->'items'->NEW.ordinal;
  IF pin->>'id' IS DISTINCT FROM NEW.id::text OR pin->>'caseId' IS DISTINCT FROM NEW.case_id::text OR pin->'fields' IS DISTINCT FROM NEW.fields OR(pin->>'ordinal')::integer IS DISTINCT FROM NEW.ordinal
   OR pin->>'caseChecksum' IS DISTINCT FROM NEW.case_checksum OR pin->>'basisFingerprint' IS DISTINCT FROM NEW.basis_fingerprint OR pin->>'taskFingerprint' IS DISTINCT FROM NEW.task_fingerprint
   OR pin->'sourcePins' IS DISTINCT FROM NEW.source_pins OR coalesce(pin->'method','null'::jsonb) IS DISTINCT FROM coalesce(NEW.method,'null'::jsonb)
   OR(pin->>'expiresAt')::timestamptz IS DISTINCT FROM NEW.expires_at
   OR (NEW.fields->>'role'='knowledge_answer' AND NOT EXISTS(SELECT 1 FROM knowledge_evaluation_cases c WHERE c.id=NEW.case_id AND c.tenant_id=NEW.tenant_id AND c.benchmark_version_id=NEW.version_id AND c.revision=1 AND c.archived_at IS NULL
    AND c.fields=NEW.fields->'evaluation' AND knowledge_benchmark_checksum(c.fields)=NEW.case_checksum))
   OR (NEW.fields->>'role'<>'knowledge_answer' AND (NEW.case_id IS NOT NULL OR NEW.case_checksum IS DISTINCT FROM knowledge_benchmark_checksum(NEW.fields)))
   THEN RAISE EXCEPTION 'benchmark_item_pin_invalid' USING ERRCODE='23514';END IF;
  event_action:='benchmark.dataset.publish';event_resource:=NEW.version_id;
 ELSIF TG_TABLE_NAME='knowledge_benchmark_experiments' THEN
  event_action:='benchmark.experiment.create';
  SELECT * INTO parent FROM knowledge_benchmark_versions WHERE id=NEW.dataset_version_id;
  IF parent.created_by IS DISTINCT FROM NEW.created_by OR NEW.data_scope IS DISTINCT FROM parent.data_scope OR NEW.item_count<>parent.item_count
   OR(SELECT count(*) FROM knowledge_benchmark_attempts a JOIN knowledge_benchmark_assessments s ON s.tenant_id=a.tenant_id AND s.attempt_id=a.id
      WHERE a.experiment_id=NEW.id AND a.arm='baseline' AND a.creation_transaction_id=born AND s.creation_transaction_id=born)<>NEW.item_count
   THEN RAISE EXCEPTION 'benchmark_baseline_incomplete' USING ERRCODE='23514';END IF;
  IF NOT EXISTS(SELECT 1 FROM knowledge_benchmark_commands WHERE receipt->>'id'=NEW.id::text AND operation='experiment.create' AND creation_transaction_id=born) THEN RAISE EXCEPTION 'benchmark_command_required' USING ERRCODE='23514';END IF;
 ELSIF TG_TABLE_NAME='knowledge_benchmark_attempts' THEN
  SELECT * INTO parent FROM knowledge_benchmark_experiments WHERE id=NEW.experiment_id;
  SELECT * INTO item FROM knowledge_benchmark_items WHERE id=NEW.item_id;
  IF NEW.arm='baseline' THEN
   event_action:='benchmark.experiment.create';event_resource:=NEW.experiment_id;
   IF NEW.request_checksum IS DISTINCT FROM knowledge_benchmark_checksum(jsonb_build_object('version',1,'operation','benchmark-baseline','experimentId',NEW.experiment_id,'itemId',NEW.item_id,'baselineVersion',parent.baseline_version))
    OR NOT EXISTS(SELECT 1 FROM knowledge_benchmark_assessments WHERE attempt_id=NEW.id AND creation_transaction_id=born) THEN RAISE EXCEPTION 'benchmark_baseline_invalid' USING ERRCODE='23514';END IF;
  ELSE
   event_action:='benchmark.attempt.start';
   IF (item.fields->>'role'='knowledge_answer' AND NOT EXISTS(SELECT 1 FROM knowledge_evaluation_runs e JOIN knowledge_evaluation_protocols p ON p.tenant_id=e.tenant_id AND p.run_id=e.id
     JOIN ai_assist_runs a ON a.tenant_id=e.tenant_id AND a.id=e.assist_run_id
     WHERE e.id=NEW.evaluation_run_id AND e.case_id=item.case_id AND e.request_id=NEW.request_id AND e.created_by=NEW.created_by
      AND a.creation_transaction_id::text=born AND p.creation_transaction_id=born AND p.basis_fingerprint=item.basis_fingerprint AND p.data_scope=parent.data_scope
      AND p.model_id=parent.model_id AND a.model_snapshot->>'providerConfigId'=(SELECT r.targets->0->>'providerConfigId' FROM model_routes r WHERE r.id=parent.model_id)))
    OR (item.fields->>'role'<>'knowledge_answer' AND NOT EXISTS(SELECT 1 FROM ai_assist_runs a JOIN ai_assist_executions e ON e.run_id=a.id AND e.tenant_id=a.tenant_id
     WHERE a.id=NEW.native_run_id AND a.tenant_id=NEW.tenant_id AND a.owner_id=NEW.created_by AND a.request_id=NEW.request_id
      AND a.kind=item.fields->>'role' AND a.benchmark_item_id=item.id AND a.creation_transaction_id::text=born AND a.prompt_version='erp-assist-2026-10-06-v6'
      AND a.model_snapshot->>'id'=parent.model_id::text AND a.model_snapshot->>'providerConfigId'=(SELECT r.targets->0->>'providerConfigId' FROM model_routes r WHERE r.id=parent.model_id)
      AND a.expires_at<=item.expires_at AND a.expires_at>knowledge_benchmark_now() AND e.input_fingerprint=a.input_fingerprint))
    OR NOT EXISTS(SELECT 1 FROM knowledge_benchmark_commands c WHERE c.receipt->>'id'=NEW.id::text AND c.operation='attempt.start' AND c.parent_id=NEW.experiment_id
     AND c.request_id=NEW.request_id AND c.request_checksum=NEW.request_checksum AND c.creation_transaction_id=born)
    THEN RAISE EXCEPTION 'benchmark_native_attempt_required' USING ERRCODE='23514';END IF;
  END IF;
 ELSIF TG_TABLE_NAME='knowledge_benchmark_assessments' THEN
  SELECT * INTO attempt FROM knowledge_benchmark_attempts WHERE id=NEW.attempt_id;
  SELECT * INTO item FROM knowledge_benchmark_items WHERE id=attempt.item_id;
  event_action:='benchmark.assessment';event_resource:=NEW.attempt_id;
  IF attempt.arm='candidate' AND ((item.fields->>'role'='knowledge_answer' AND NOT EXISTS(SELECT 1 FROM knowledge_evaluation_assessments s JOIN knowledge_evaluation_runs e ON e.tenant_id=s.tenant_id AND e.id=s.run_id
    JOIN ai_assist_runs a ON a.tenant_id=e.tenant_id AND a.id=e.assist_run_id WHERE s.run_id=attempt.evaluation_run_id AND s.output_checksum=NEW.output_checksum
     AND s.basis_fingerprint=NEW.basis_fingerprint AND s.creation_transaction_id=born AND a.status='completed'))
    OR(item.fields->>'role'<>'knowledge_answer' AND NOT EXISTS(SELECT 1 FROM ai_assist_runs a WHERE a.id=attempt.native_run_id AND a.tenant_id=NEW.tenant_id
     AND a.owner_id=NEW.created_by AND a.benchmark_item_id=item.id AND a.status='completed' AND a.encrypted_output IS NOT NULL
     AND a.xmin::text=(pg_current_xact_id()::text::numeric%4294967296)::text)))
   THEN RAISE EXCEPTION 'benchmark_native_assessment_required' USING ERRCODE='23514';END IF;
  IF NEW.grader_version IS DISTINCT FROM (CASE WHEN item.fields->>'role'='knowledge_answer' THEN 'knowledge-benchmark-checks-v1' ELSE 'business-benchmark-checks-v1' END) THEN
   RAISE EXCEPTION 'benchmark_grader_role_invalid' USING ERRCODE='23514';END IF;
  IF item.fields->>'role'<>'knowledge_answer' AND (SELECT count(DISTINCT c->>'key') FROM jsonb_array_elements(NEW.checks) c
    WHERE c->>'key' IN('business_role','business_schema','business_evidence','expected_facts','forbidden_claims','refusal','original_gaps','task_identity'))<>8 THEN
   RAISE EXCEPTION 'benchmark_business_check_required' USING ERRCODE='23514';END IF;
  FOR pin IN SELECT x FROM jsonb_array_elements(item.fields->'calculations') x LOOP
   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.checks) c WHERE c->>'key'='numeric:'||(pin->>'key')) THEN RAISE EXCEPTION 'benchmark_numeric_check_required' USING ERRCODE='23514';END IF;
  END LOOP;
 ELSIF TG_TABLE_NAME='knowledge_benchmark_reviews' THEN event_action:='benchmark.attempt.review';
  IF NOT EXISTS(SELECT 1 FROM knowledge_benchmark_commands WHERE receipt->>'id'=NEW.id::text AND operation='attempt.review' AND parent_id=NEW.attempt_id AND creation_transaction_id=born) THEN RAISE EXCEPTION 'benchmark_command_required' USING ERRCODE='23514';END IF;
 ELSIF TG_TABLE_NAME='knowledge_benchmark_expenses' THEN event_action:='benchmark.expense.record';
  IF NOT EXISTS(SELECT 1 FROM knowledge_benchmark_commands WHERE receipt->>'id'=NEW.id::text AND operation='expense.record' AND parent_id=NEW.experiment_id AND creation_transaction_id=born) THEN RAISE EXCEPTION 'benchmark_command_required' USING ERRCODE='23514';END IF;
 ELSIF TG_TABLE_NAME='knowledge_benchmark_commands' THEN
  event_action:='benchmark.'||NEW.operation;event_resource:=(NEW.receipt->>'id')::uuid;expected:=(NEW.receipt->>'revision')::integer;
  CASE NEW.operation
  WHEN 'dataset.create' THEN
   SELECT * INTO parent FROM knowledge_benchmark_datasets WHERE id=event_resource AND created_by=NEW.created_by AND creation_transaction_id=born AND revision=expected;
   IF parent.id IS NULL OR NEW.parent_id IS NOT NULL OR expected<>1 THEN RAISE EXCEPTION 'benchmark_command_result_invalid' USING ERRCODE='23514';END IF;
  WHEN 'dataset.save' THEN
   SELECT * INTO parent FROM knowledge_benchmark_datasets WHERE id=event_resource AND created_by=NEW.created_by AND revision=expected
    AND xmin::text=(pg_current_xact_id()::text::numeric%4294967296)::text;
   IF parent.id IS NULL OR NEW.parent_id IS DISTINCT FROM event_resource OR expected<2 THEN RAISE EXCEPTION 'benchmark_command_result_invalid' USING ERRCODE='23514';END IF;
  WHEN 'dataset.publish' THEN
   SELECT * INTO parent FROM knowledge_benchmark_versions WHERE id=event_resource AND dataset_id=NEW.parent_id AND created_by=NEW.created_by AND creation_transaction_id=born AND version=expected;
   IF parent.id IS NULL THEN RAISE EXCEPTION 'benchmark_command_result_invalid' USING ERRCODE='23514';END IF;
  WHEN 'experiment.create' THEN
   SELECT * INTO parent FROM knowledge_benchmark_experiments WHERE id=event_resource AND created_by=NEW.created_by AND creation_transaction_id=born;
   IF parent.id IS NULL OR NEW.parent_id IS NOT NULL OR expected<>1 THEN RAISE EXCEPTION 'benchmark_command_result_invalid' USING ERRCODE='23514';END IF;
  WHEN 'attempt.start' THEN
   SELECT * INTO parent FROM knowledge_benchmark_attempts WHERE id=event_resource AND experiment_id=NEW.parent_id AND created_by=NEW.created_by AND creation_transaction_id=born
    AND ordinal=expected AND request_id=NEW.request_id AND request_checksum=NEW.request_checksum AND arm='candidate';
   IF parent.id IS NULL THEN RAISE EXCEPTION 'benchmark_command_result_invalid' USING ERRCODE='23514';END IF;
  WHEN 'attempt.review' THEN
   SELECT * INTO parent FROM knowledge_benchmark_reviews WHERE id=event_resource AND attempt_id=NEW.parent_id AND created_by=NEW.created_by AND creation_transaction_id=born AND sequence=expected;
   IF parent.id IS NULL THEN RAISE EXCEPTION 'benchmark_command_result_invalid' USING ERRCODE='23514';END IF;
  WHEN 'expense.record' THEN
   SELECT * INTO parent FROM knowledge_benchmark_expenses WHERE id=event_resource AND experiment_id=NEW.parent_id AND created_by=NEW.created_by AND creation_transaction_id=born AND sequence=expected;
   IF parent.id IS NULL THEN RAISE EXCEPTION 'benchmark_command_result_invalid' USING ERRCODE='23514';END IF;
  WHEN 'report.create' THEN
   SELECT * INTO parent FROM knowledge_benchmark_reports WHERE id=event_resource AND experiment_id=NEW.parent_id AND created_by=NEW.created_by AND creation_transaction_id=born AND sequence=expected;
   IF parent.id IS NULL THEN RAISE EXCEPTION 'benchmark_command_result_invalid' USING ERRCODE='23514';END IF;
  ELSE RAISE EXCEPTION 'benchmark_command_result_invalid' USING ERRCODE='23514';
  END CASE;
 ELSIF TG_TABLE_NAME='knowledge_benchmark_reports' THEN event_action:='benchmark.report.create';
  SELECT * INTO parent FROM knowledge_benchmark_experiments WHERE id=NEW.experiment_id;
  SELECT * INTO item FROM knowledge_benchmark_versions WHERE id=parent.dataset_version_id;
  IF NEW.manifest->>'datasetVersionId' IS DISTINCT FROM item.id::text OR NEW.manifest->>'datasetChecksum' IS DISTINCT FROM item.checksum
   OR NEW.manifest->'attemptIds' IS DISTINCT FROM coalesce((SELECT jsonb_agg(a.id ORDER BY a.id) FROM knowledge_benchmark_attempts a WHERE a.experiment_id=NEW.experiment_id),'[]'::jsonb)
   OR NEW.manifest->'assessmentIds' IS DISTINCT FROM coalesce((SELECT jsonb_agg(s.id ORDER BY s.id) FROM knowledge_benchmark_assessments s JOIN knowledge_benchmark_attempts a ON a.tenant_id=s.tenant_id AND a.id=s.attempt_id WHERE a.experiment_id=NEW.experiment_id),'[]'::jsonb)
   OR NEW.manifest->'reviewIds' IS DISTINCT FROM coalesce((SELECT jsonb_agg(r.id ORDER BY r.id) FROM knowledge_benchmark_reviews r JOIN knowledge_benchmark_attempts a ON a.tenant_id=r.tenant_id AND a.id=r.attempt_id WHERE a.experiment_id=NEW.experiment_id),'[]'::jsonb)
   THEN RAISE EXCEPTION 'benchmark_report_evidence_incomplete' USING ERRCODE='23514';END IF;
  IF NOT EXISTS(SELECT 1 FROM knowledge_benchmark_commands WHERE receipt->>'id'=NEW.id::text AND operation='report.create' AND parent_id=NEW.experiment_id AND creation_transaction_id=born) THEN RAISE EXCEPTION 'benchmark_command_required' USING ERRCODE='23514';END IF;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM knowledge_governance_events e WHERE e.tenant_id=NEW.tenant_id AND e.created_by=NEW.created_by AND e.resource_id=event_resource AND e.action=event_action
   AND e.xmin::text=(pg_current_xact_id()::text::numeric%4294967296)::text) THEN RAISE EXCEPTION 'benchmark_audit_required' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION guard_business_benchmark_native() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='UPDATE' AND NEW.benchmark_item_id IS DISTINCT FROM OLD.benchmark_item_id THEN RAISE EXCEPTION 'benchmark_native_marker_immutable' USING ERRCODE='23514';END IF;
 IF NEW.benchmark_item_id IS NOT NULL AND NEW.kind NOT IN('procurement_review','business_review') THEN RAISE EXCEPTION 'benchmark_native_role_invalid' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER a_business_benchmark_native BEFORE INSERT OR UPDATE ON ai_assist_runs FOR EACH ROW EXECUTE FUNCTION guard_business_benchmark_native();
CREATE FUNCTION require_business_benchmark_native() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.benchmark_item_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM knowledge_benchmark_attempts a JOIN knowledge_benchmark_items i ON i.id=a.item_id AND i.tenant_id=a.tenant_id
   WHERE a.native_run_id=NEW.id AND a.tenant_id=NEW.tenant_id AND a.created_by=NEW.owner_id AND a.request_id=NEW.request_id
    AND a.creation_transaction_id=pg_current_xact_id()::text AND i.id=NEW.benchmark_item_id AND i.fields->>'role'=NEW.kind AND i.case_id IS NULL) THEN
  RAISE EXCEPTION 'benchmark_native_attempt_required' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER business_benchmark_native_closure AFTER INSERT ON ai_assist_runs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_business_benchmark_native();
