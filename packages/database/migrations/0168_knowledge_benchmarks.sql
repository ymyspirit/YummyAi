-- Published benchmark inputs, actual native attempts, fixed grading and complete cost.
-- No old evaluation or model/budget history is backfilled.
CREATE TABLE knowledge_benchmark_datasets (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES organizations(id),created_by uuid NOT NULL REFERENCES app_users(id),created_at timestamptz NOT NULL DEFAULT now(),creation_transaction_id text NOT NULL,
 revision integer NOT NULL CHECK(revision>0),fields jsonb NOT NULL,data_scope text NOT NULL CHECK(data_scope IN('self','team','tenant')),updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(jsonb_typeof(fields)='object' AND jsonb_typeof(fields->'items')='array' AND jsonb_array_length(fields->'items') BETWEEN 1 AND 50),CHECK(substring(id::text from 15 for 1)='7')
);
CREATE UNIQUE INDEX knowledge_benchmark_datasets_tenant_id_unique ON knowledge_benchmark_datasets(tenant_id,id);
CREATE TABLE knowledge_benchmark_versions (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES organizations(id),created_by uuid NOT NULL REFERENCES app_users(id),created_at timestamptz NOT NULL DEFAULT now(),creation_transaction_id text NOT NULL,
 dataset_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),dataset_revision integer NOT NULL CHECK(dataset_revision>0),name text NOT NULL,checksum text NOT NULL CHECK(checksum~'^[a-f0-9]{64}$'),
 item_count integer NOT NULL CHECK(item_count BETWEEN 2 AND 50),data_scope text NOT NULL CHECK(data_scope IN('self','team','tenant')),basis_expires_at timestamptz NOT NULL,manifest jsonb NOT NULL,
 FOREIGN KEY(tenant_id,dataset_id) REFERENCES knowledge_benchmark_datasets(tenant_id,id),UNIQUE(tenant_id,dataset_id,version),CHECK(substring(id::text from 15 for 1)='7')
);
CREATE UNIQUE INDEX knowledge_benchmark_versions_tenant_id_unique ON knowledge_benchmark_versions(tenant_id,id);
CREATE TABLE knowledge_benchmark_items (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES organizations(id),created_by uuid NOT NULL REFERENCES app_users(id),created_at timestamptz NOT NULL DEFAULT now(),creation_transaction_id text NOT NULL,
 version_id uuid NOT NULL,ordinal integer NOT NULL CHECK(ordinal BETWEEN 0 AND 49),case_id uuid NOT NULL,fields jsonb NOT NULL,
 case_checksum text NOT NULL CHECK(case_checksum~'^[a-f0-9]{64}$'),basis_fingerprint text NOT NULL CHECK(basis_fingerprint~'^[a-f0-9]{64}$'),task_fingerprint text NOT NULL CHECK(task_fingerprint~'^[a-f0-9]{64}$'),
 source_pins jsonb NOT NULL,method jsonb,encrypted_basis text,expires_at timestamptz NOT NULL,
 FOREIGN KEY(tenant_id,version_id) REFERENCES knowledge_benchmark_versions(tenant_id,id),FOREIGN KEY(tenant_id,case_id) REFERENCES knowledge_evaluation_cases(tenant_id,id),
 UNIQUE(tenant_id,version_id,ordinal),UNIQUE(tenant_id,case_id),CHECK(jsonb_typeof(source_pins)='array' AND jsonb_array_length(source_pins)<=6),CHECK(substring(id::text from 15 for 1)='7')
);
CREATE UNIQUE INDEX knowledge_benchmark_items_tenant_id_unique ON knowledge_benchmark_items(tenant_id,id);
CREATE TABLE knowledge_benchmark_experiments (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES organizations(id),created_by uuid NOT NULL REFERENCES app_users(id),created_at timestamptz NOT NULL DEFAULT now(),creation_transaction_id text NOT NULL,
 dataset_version_id uuid NOT NULL,label text NOT NULL,baseline_version text NOT NULL CHECK(baseline_version='extractive-arithmetic-v1'),
 grader_version text NOT NULL CHECK(grader_version='knowledge-benchmark-checks-v1'),cost_version text NOT NULL CHECK(cost_version='all-attempts-latest-outcome-v1'),
 model_id uuid NOT NULL,model_snapshot jsonb NOT NULL,route_fingerprint text NOT NULL CHECK(route_fingerprint~'^[a-f0-9]{64}$'),max_attempts_per_item integer NOT NULL CHECK(max_attempts_per_item BETWEEN 1 AND 5),
 item_count integer NOT NULL CHECK(item_count BETWEEN 2 AND 50),data_scope text NOT NULL CHECK(data_scope IN('self','team','tenant')),
 FOREIGN KEY(tenant_id,dataset_version_id) REFERENCES knowledge_benchmark_versions(tenant_id,id),CHECK(model_snapshot->>'id'=model_id::text),CHECK(substring(id::text from 15 for 1)='7')
);
CREATE UNIQUE INDEX knowledge_benchmark_experiments_tenant_id_unique ON knowledge_benchmark_experiments(tenant_id,id);
CREATE TABLE knowledge_benchmark_attempts (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES organizations(id),created_by uuid NOT NULL REFERENCES app_users(id),created_at timestamptz NOT NULL DEFAULT now(),creation_transaction_id text NOT NULL,
 experiment_id uuid NOT NULL,item_id uuid NOT NULL,arm text NOT NULL CHECK(arm IN('baseline','candidate')),ordinal integer NOT NULL CHECK(ordinal BETWEEN 1 AND 5),
 evaluation_run_id uuid,request_id uuid NOT NULL,request_checksum text NOT NULL CHECK(request_checksum~'^[a-f0-9]{64}$'),
 FOREIGN KEY(tenant_id,experiment_id) REFERENCES knowledge_benchmark_experiments(tenant_id,id),FOREIGN KEY(tenant_id,item_id) REFERENCES knowledge_benchmark_items(tenant_id,id),
 FOREIGN KEY(tenant_id,evaluation_run_id) REFERENCES knowledge_evaluation_runs(tenant_id,id),UNIQUE(tenant_id,request_id),UNIQUE(tenant_id,experiment_id,item_id,arm,ordinal),UNIQUE(tenant_id,evaluation_run_id),
 CHECK((arm='baseline' AND ordinal=1 AND evaluation_run_id IS NULL) OR (arm='candidate' AND evaluation_run_id IS NOT NULL)),CHECK(substring(id::text from 15 for 1)='7')
);
CREATE UNIQUE INDEX knowledge_benchmark_attempts_tenant_id_unique ON knowledge_benchmark_attempts(tenant_id,id);
CREATE TABLE knowledge_benchmark_assessments (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES organizations(id),created_by uuid NOT NULL REFERENCES app_users(id),created_at timestamptz NOT NULL DEFAULT now(),creation_transaction_id text NOT NULL,
 attempt_id uuid NOT NULL,grader_version text NOT NULL CHECK(grader_version='knowledge-benchmark-checks-v1'),case_checksum text NOT NULL CHECK(case_checksum~'^[a-f0-9]{64}$'),
 basis_fingerprint text NOT NULL CHECK(basis_fingerprint~'^[a-f0-9]{64}$'),output_checksum text NOT NULL CHECK(output_checksum~'^[a-f0-9]{64}$'),
 hard_pass boolean NOT NULL,checks jsonb NOT NULL,proof text NOT NULL CHECK(octet_length(proof) BETWEEN 1 AND 1048576),encrypted_output text,expires_at timestamptz NOT NULL,
 FOREIGN KEY(tenant_id,attempt_id) REFERENCES knowledge_benchmark_attempts(tenant_id,id),UNIQUE(tenant_id,attempt_id),
 CHECK(jsonb_typeof(checks)='array' AND jsonb_array_length(checks) BETWEEN 7 AND 50),CHECK(substring(id::text from 15 for 1)='7')
);
CREATE UNIQUE INDEX knowledge_benchmark_assessments_tenant_id_unique ON knowledge_benchmark_assessments(tenant_id,id);
CREATE TABLE knowledge_benchmark_reviews (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES organizations(id),created_by uuid NOT NULL REFERENCES app_users(id),created_at timestamptz NOT NULL DEFAULT now(),creation_transaction_id text NOT NULL,
 attempt_id uuid NOT NULL,assessment_id uuid NOT NULL,previous_id uuid,sequence integer NOT NULL CHECK(sequence>0),
 decision text NOT NULL CHECK(decision IN('pass','fail','needs_review')),minutes numeric(12,3) NOT NULL CHECK(minutes>=0 AND minutes<1000000),
 hourly_usd numeric(24,8) CHECK(hourly_usd>=0 AND hourly_usd<10000000000),reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 1000),
 FOREIGN KEY(tenant_id,attempt_id) REFERENCES knowledge_benchmark_attempts(tenant_id,id),FOREIGN KEY(tenant_id,assessment_id) REFERENCES knowledge_benchmark_assessments(tenant_id,id),
 UNIQUE(tenant_id,attempt_id,sequence),CHECK((sequence=1 AND previous_id IS NULL) OR(sequence>1 AND previous_id IS NOT NULL)),CHECK(substring(id::text from 15 for 1)='7')
);
CREATE UNIQUE INDEX knowledge_benchmark_reviews_tenant_id_unique ON knowledge_benchmark_reviews(tenant_id,id);
CREATE TABLE knowledge_benchmark_expenses (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES organizations(id),created_by uuid NOT NULL REFERENCES app_users(id),created_at timestamptz NOT NULL DEFAULT now(),creation_transaction_id text NOT NULL,
 experiment_id uuid NOT NULL,arm text NOT NULL CHECK(arm IN('baseline','candidate')),previous_id uuid,sequence integer NOT NULL CHECK(sequence>0),
 storage_usd numeric(24,8) CHECK(storage_usd>=0 AND storage_usd<10000000000),maintenance_usd numeric(24,8) CHECK(maintenance_usd>=0 AND maintenance_usd<10000000000),
 activity_fingerprint text NOT NULL CHECK(activity_fingerprint~'^[a-f0-9]{64}$'),period_start timestamptz NOT NULL,period_end timestamptz NOT NULL,allocation_basis text NOT NULL CHECK(length(allocation_basis) BETWEEN 1 AND 1000),
 FOREIGN KEY(tenant_id,experiment_id) REFERENCES knowledge_benchmark_experiments(tenant_id,id),UNIQUE(tenant_id,experiment_id,arm,sequence),
 CHECK(period_end>=period_start),CHECK((sequence=1 AND previous_id IS NULL) OR(sequence>1 AND previous_id IS NOT NULL)),CHECK(substring(id::text from 15 for 1)='7')
);
CREATE UNIQUE INDEX knowledge_benchmark_expenses_tenant_id_unique ON knowledge_benchmark_expenses(tenant_id,id);
CREATE TABLE knowledge_benchmark_commands (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES organizations(id),created_by uuid NOT NULL REFERENCES app_users(id),created_at timestamptz NOT NULL DEFAULT now(),creation_transaction_id text NOT NULL,
 request_id uuid NOT NULL,operation text NOT NULL CHECK(operation IN('dataset.create','dataset.save','dataset.publish','experiment.create','attempt.start','attempt.review','expense.record','report.create')),
 parent_id uuid,request_checksum text NOT NULL CHECK(request_checksum~'^[a-f0-9]{64}$'),data_scope text NOT NULL CHECK(data_scope IN('self','team','tenant')),receipt jsonb NOT NULL,
 UNIQUE(tenant_id,request_id),CHECK(jsonb_typeof(receipt)='object' AND receipt->>'id'~'^[a-f0-9-]{36}$' AND (receipt->>'revision')::integer>0),CHECK(substring(id::text from 15 for 1)='7')
);
CREATE UNIQUE INDEX knowledge_benchmark_commands_tenant_id_unique ON knowledge_benchmark_commands(tenant_id,id);
CREATE TABLE knowledge_benchmark_reports (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES organizations(id),created_by uuid NOT NULL REFERENCES app_users(id),created_at timestamptz NOT NULL DEFAULT now(),creation_transaction_id text NOT NULL,
 experiment_id uuid NOT NULL,sequence integer NOT NULL CHECK(sequence>0),manifest_checksum text NOT NULL CHECK(manifest_checksum~'^[a-f0-9]{64}$'),manifest jsonb NOT NULL,
 proof text NOT NULL CHECK(octet_length(proof) BETWEEN 1 AND 1048576),FOREIGN KEY(tenant_id,experiment_id) REFERENCES knowledge_benchmark_experiments(tenant_id,id),UNIQUE(tenant_id,experiment_id,sequence),CHECK(substring(id::text from 15 for 1)='7')
);
CREATE UNIQUE INDEX knowledge_benchmark_reports_tenant_id_unique ON knowledge_benchmark_reports(tenant_id,id);

ALTER TABLE knowledge_evaluation_cases ADD COLUMN benchmark_version_id uuid;
ALTER TABLE knowledge_evaluation_cases ADD CONSTRAINT knowledge_evaluation_case_benchmark_fk FOREIGN KEY(tenant_id,benchmark_version_id)
 REFERENCES knowledge_benchmark_versions(tenant_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE knowledge_benchmark_reviews ADD CONSTRAINT knowledge_benchmark_review_previous_fk FOREIGN KEY(tenant_id,previous_id) REFERENCES knowledge_benchmark_reviews(tenant_id,id);
ALTER TABLE knowledge_benchmark_expenses ADD CONSTRAINT knowledge_benchmark_expense_previous_fk FOREIGN KEY(tenant_id,previous_id) REFERENCES knowledge_benchmark_expenses(tenant_id,id);

CREATE TABLE knowledge_benchmark_retention_jobs (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES organizations(id),created_by uuid NOT NULL REFERENCES app_users(id),
 kind text NOT NULL CHECK(kind IN('basis','baseline-output')),resource_id uuid NOT NULL,expires_at timestamptz NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','completed')),created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,
 UNIQUE(tenant_id,kind,resource_id),CHECK((state='pending' AND completed_at IS NULL) OR(state='completed' AND completed_at IS NOT NULL))
);
CREATE INDEX knowledge_benchmark_retention_due ON knowledge_benchmark_retention_jobs(tenant_id,expires_at) WHERE state='pending';
--> statement-breakpoint
CREATE FUNCTION knowledge_benchmark_now() RETURNS timestamptz LANGUAGE sql VOLATILE SET search_path=pg_catalog,public AS $$ SELECT clock_timestamp() $$;
CREATE FUNCTION knowledge_benchmark_checksum(value jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
 SELECT encode(sha256(convert_to(invoice_reconciliation_canonical(value),'UTF8')),'hex')
$$;
CREATE FUNCTION knowledge_benchmark_require_authority(tenant uuid,actor uuid,pinned_scope text,operation text) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE bits text[]:=ARRAY['workflow:read'];bit text;actual integer;needed integer;
BEGIN
 IF tenant IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid OR actor IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid
  OR pinned_scope NOT IN('self','team','tenant') THEN RAISE EXCEPTION 'benchmark_actor_invalid' USING ERRCODE='23514';END IF;
 IF operation IN('manage','run','publish') THEN bits:=array_append(bits,'workflow:manage');END IF;
 IF operation IN('run','publish') THEN bits:=array_append(bits,'workflow:run');END IF;
 IF operation IN('review','publish') THEN bits:=array_append(bits,'workflow:approve');END IF;
 needed:=CASE pinned_scope WHEN 'tenant' THEN 3 WHEN 'team' THEN 2 ELSE 1 END;
 PERFORM 1 FROM memberships m JOIN membership_roles mr ON mr.tenant_id=m.tenant_id AND mr.membership_id=m.id JOIN roles r ON r.tenant_id=mr.tenant_id AND r.id=mr.role_id
  WHERE m.tenant_id=tenant AND m.user_id=actor ORDER BY m.id,mr.role_id FOR SHARE OF m,mr,r;
 FOREACH bit IN ARRAY bits LOOP
  SELECT coalesce(max(CASE r.data_scope WHEN 'tenant' THEN 3 WHEN 'team' THEN 2 WHEN 'self' THEN 1 ELSE 0 END),0) INTO actual
   FROM memberships m JOIN membership_roles mr ON mr.tenant_id=m.tenant_id AND mr.membership_id=m.id JOIN roles r ON r.tenant_id=mr.tenant_id AND r.id=mr.role_id
   WHERE m.tenant_id=tenant AND m.user_id=actor AND m.status='active' AND(r.permissions?bit OR r.permissions?'*');
  IF actual<needed THEN RAISE EXCEPTION 'benchmark_current_authority_required' USING ERRCODE='23514';END IF;
 END LOOP;
END $$;
CREATE FUNCTION knowledge_benchmark_case_valid(value jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE task jsonb;operand jsonb;
BEGIN
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
CREATE FUNCTION knowledge_benchmark_activity(experiment uuid,which_arm text) RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT knowledge_benchmark_checksum(jsonb_build_object('version',1,'experimentId',experiment,'arm',which_arm,
  'attemptIds',coalesce((SELECT jsonb_agg(a.id ORDER BY a.id) FROM knowledge_benchmark_attempts a WHERE a.experiment_id=experiment AND a.arm=which_arm),'[]'::jsonb),
  'assessmentIds',coalesce((SELECT jsonb_agg(s.id ORDER BY s.id) FROM knowledge_benchmark_assessments s JOIN knowledge_benchmark_attempts a ON a.tenant_id=s.tenant_id AND a.id=s.attempt_id WHERE a.experiment_id=experiment AND a.arm=which_arm),'[]'::jsonb),
  'reviewIds',coalesce((SELECT jsonb_agg(r.id ORDER BY r.id) FROM knowledge_benchmark_reviews r JOIN knowledge_benchmark_attempts a ON a.tenant_id=r.tenant_id AND a.id=r.attempt_id WHERE a.experiment_id=experiment AND a.arm=which_arm),'[]'::jsonb)))
$$;
CREATE FUNCTION knowledge_benchmark_route(model uuid) RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT knowledge_benchmark_checksum(jsonb_build_object('version',1,'routeId',r.id,'taskType',r.task_type,'targets',r.targets,
  'provider',jsonb_build_object('id',p.id,'provider',p.provider,'endpoint',p.endpoint)))
 FROM model_routes r JOIN model_provider_configs p ON p.tenant_id=r.tenant_id AND p.id=(r.targets->0->>'providerConfigId')::uuid
 WHERE r.id=model AND r.status='enabled' AND p.status='enabled' AND jsonb_array_length(r.targets)=1 AND r.task_type IN('studio_analysis','studio_text')
$$;
REVOKE ALL ON FUNCTION knowledge_benchmark_require_authority(uuid,uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION knowledge_benchmark_require_authority(uuid,uuid,text,text) TO yummyai_app;
--> statement-breakpoint
CREATE FUNCTION guard_knowledge_benchmark_record() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE pinned_scope text;operation text;parent record;attempt record;previous record;item record;born text:=pg_current_xact_id()::text;
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
 IF pinned_scope IS NULL THEN RAISE EXCEPTION 'benchmark_parent_unavailable' USING ERRCODE='23514';END IF;
 PERFORM knowledge_benchmark_require_authority(NEW.tenant_id,NEW.created_by,pinned_scope,operation);
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION require_knowledge_benchmark_record() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
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
   OR NOT EXISTS(SELECT 1 FROM knowledge_evaluation_cases c WHERE c.id=NEW.case_id AND c.tenant_id=NEW.tenant_id AND c.benchmark_version_id=NEW.version_id AND c.revision=1 AND c.archived_at IS NULL
    AND c.fields=NEW.fields->'evaluation' AND knowledge_benchmark_checksum(c.fields)=NEW.case_checksum)
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
   IF NOT EXISTS(SELECT 1 FROM knowledge_evaluation_runs e JOIN knowledge_evaluation_protocols p ON p.tenant_id=e.tenant_id AND p.run_id=e.id
     JOIN ai_assist_runs a ON a.tenant_id=e.tenant_id AND a.id=e.assist_run_id
     WHERE e.id=NEW.evaluation_run_id AND e.case_id=item.case_id AND e.request_id=NEW.request_id AND e.created_by=NEW.created_by
      AND a.creation_transaction_id::text=born AND p.creation_transaction_id=born AND p.basis_fingerprint=item.basis_fingerprint AND p.data_scope=parent.data_scope
      AND p.model_id=parent.model_id AND a.model_snapshot->>'providerConfigId'=(SELECT r.targets->0->>'providerConfigId' FROM model_routes r WHERE r.id=parent.model_id))
    OR NOT EXISTS(SELECT 1 FROM knowledge_benchmark_commands c WHERE c.receipt->>'id'=NEW.id::text AND c.operation='attempt.start' AND c.parent_id=NEW.experiment_id
     AND c.request_id=NEW.request_id AND c.request_checksum=NEW.request_checksum AND c.creation_transaction_id=born)
    THEN RAISE EXCEPTION 'benchmark_native_attempt_required' USING ERRCODE='23514';END IF;
  END IF;
 ELSIF TG_TABLE_NAME='knowledge_benchmark_assessments' THEN
  SELECT * INTO attempt FROM knowledge_benchmark_attempts WHERE id=NEW.attempt_id;
  SELECT * INTO item FROM knowledge_benchmark_items WHERE id=attempt.item_id;
  event_action:='benchmark.assessment';event_resource:=NEW.attempt_id;
  IF attempt.arm='candidate' AND NOT EXISTS(SELECT 1 FROM knowledge_evaluation_assessments s JOIN knowledge_evaluation_runs e ON e.tenant_id=s.tenant_id AND e.id=s.run_id
    JOIN ai_assist_runs a ON a.tenant_id=e.tenant_id AND a.id=e.assist_run_id WHERE s.run_id=attempt.evaluation_run_id AND s.output_checksum=NEW.output_checksum
     AND s.basis_fingerprint=NEW.basis_fingerprint AND s.creation_transaction_id=born AND a.status='completed')
   THEN RAISE EXCEPTION 'benchmark_native_assessment_required' USING ERRCODE='23514';END IF;
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
CREATE FUNCTION guard_knowledge_benchmark_case() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP<>'INSERT' AND OLD.benchmark_version_id IS NOT NULL THEN RAISE EXCEPTION 'benchmark_published_case_immutable' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' AND NEW.benchmark_version_id IS DISTINCT FROM OLD.benchmark_version_id THEN RAISE EXCEPTION 'benchmark_case_marker_immutable' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' AND NEW.benchmark_version_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM knowledge_benchmark_versions v WHERE v.id=NEW.benchmark_version_id AND v.tenant_id=NEW.tenant_id
  AND v.creation_transaction_id=pg_current_xact_id()::text) THEN RAISE EXCEPTION 'benchmark_published_case_birth_invalid' USING ERRCODE='23514';END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER a_knowledge_benchmark_published_case BEFORE INSERT OR UPDATE OR DELETE ON knowledge_evaluation_cases FOR EACH ROW EXECUTE FUNCTION guard_knowledge_benchmark_case();
CREATE FUNCTION require_knowledge_benchmark_case() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.benchmark_version_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM knowledge_benchmark_items i WHERE i.tenant_id=NEW.tenant_id
   AND i.case_id=NEW.id AND i.version_id=NEW.benchmark_version_id AND i.created_by=nullif(current_setting('app.user_id',true),'')::uuid
   AND i.creation_transaction_id=pg_current_xact_id()::text AND i.fields->'evaluation'=NEW.fields AND i.case_checksum=knowledge_benchmark_checksum(NEW.fields)) THEN
  RAISE EXCEPTION 'benchmark_published_case_item_required' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER knowledge_benchmark_case_closure AFTER INSERT ON knowledge_evaluation_cases
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_knowledge_benchmark_case();
CREATE FUNCTION require_knowledge_benchmark_native() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE marker uuid;
BEGIN
 SELECT benchmark_version_id INTO marker FROM knowledge_evaluation_cases WHERE id=NEW.case_id AND tenant_id=NEW.tenant_id;
 IF marker IS NOT NULL AND NOT EXISTS(SELECT 1 FROM knowledge_benchmark_attempts a JOIN knowledge_benchmark_items i ON i.tenant_id=a.tenant_id AND i.id=a.item_id
  WHERE a.evaluation_run_id=NEW.id AND a.tenant_id=NEW.tenant_id AND a.created_by=NEW.created_by AND i.case_id=NEW.case_id AND i.version_id=marker
   AND a.creation_transaction_id=pg_current_xact_id()::text) THEN RAISE EXCEPTION 'benchmark_native_attempt_required' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER knowledge_benchmark_native_closure AFTER INSERT ON knowledge_evaluation_runs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_knowledge_benchmark_native();
CREATE FUNCTION guard_knowledge_benchmark_audit() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.action LIKE 'benchmark.%' AND(NEW.created_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid
  OR NEW.action NOT IN('benchmark.dataset.create','benchmark.dataset.save','benchmark.dataset.publish','benchmark.experiment.create','benchmark.attempt.start',
   'benchmark.assessment','benchmark.attempt.review','benchmark.expense.record','benchmark.report.create','benchmark.body.purged')) THEN
   RAISE EXCEPTION 'benchmark_audit_actor_invalid' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER a_knowledge_benchmark_audit BEFORE INSERT ON knowledge_governance_events FOR EACH ROW EXECUTE FUNCTION guard_knowledge_benchmark_audit();
CREATE FUNCTION require_knowledge_benchmark_audit() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE born text:=pg_current_xact_id()::text;current_xid text:=(pg_current_xact_id()::text::numeric%4294967296)::text;valid boolean;
BEGIN
 IF NEW.action NOT LIKE 'benchmark.%' THEN RETURN NULL;END IF;
 IF (SELECT count(*) FROM knowledge_governance_events e WHERE e.tenant_id=NEW.tenant_id AND e.created_by=NEW.created_by
    AND e.action=NEW.action AND e.resource_id=NEW.resource_id AND e.xmin::text=current_xid)<>1 THEN
  RAISE EXCEPTION 'benchmark_audit_duplicate' USING ERRCODE='23514';END IF;
 IF NEW.action='benchmark.assessment' THEN
  SELECT EXISTS(SELECT 1 FROM knowledge_benchmark_assessments s WHERE s.tenant_id=NEW.tenant_id AND s.created_by=NEW.created_by
   AND s.attempt_id=NEW.resource_id AND s.creation_transaction_id=born AND s.id::text=NEW.detail->>'assessmentId'
   AND s.output_checksum=NEW.detail->>'outputChecksum') INTO valid;
 ELSIF NEW.action='benchmark.body.purged' THEN
  SELECT EXISTS(SELECT 1 FROM knowledge_benchmark_retention_jobs j WHERE j.tenant_id=NEW.tenant_id AND j.created_by=NEW.created_by
   AND j.resource_id=NEW.resource_id AND j.id::text=NEW.detail->>'jobId' AND j.kind=NEW.detail->>'kind' AND j.state='completed'
   AND j.xmin::text=current_xid AND ((j.kind='basis' AND EXISTS(SELECT 1 FROM knowledge_benchmark_items i WHERE i.tenant_id=j.tenant_id
     AND i.id=j.resource_id AND i.encrypted_basis IS NULL AND i.xmin::text=current_xid)) OR(j.kind='baseline-output' AND EXISTS(
     SELECT 1 FROM knowledge_benchmark_assessments s WHERE s.tenant_id=j.tenant_id AND s.id=j.resource_id AND s.encrypted_output IS NULL AND s.xmin::text=current_xid)))) INTO valid;
 ELSE
  SELECT EXISTS(SELECT 1 FROM knowledge_benchmark_commands c WHERE c.tenant_id=NEW.tenant_id AND c.created_by=NEW.created_by
   AND c.creation_transaction_id=born AND NEW.action='benchmark.'||c.operation AND c.receipt->>'id'=NEW.resource_id::text) INTO valid;
 END IF;
 IF NOT coalesce(valid,false) THEN RAISE EXCEPTION 'benchmark_audit_result_required' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER knowledge_benchmark_audit_closure AFTER INSERT ON knowledge_governance_events
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_knowledge_benchmark_audit();
--> statement-breakpoint
CREATE FUNCTION register_knowledge_benchmark_retention() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_TABLE_NAME<>'knowledge_benchmark_items' AND to_jsonb(NEW)->>'encrypted_output' IS NULL THEN RETURN NULL;END IF;
  INSERT INTO knowledge_benchmark_retention_jobs(id,tenant_id,created_by,kind,resource_id,expires_at)
   VALUES(NEW.id,NEW.tenant_id,NEW.created_by,CASE WHEN TG_TABLE_NAME='knowledge_benchmark_items' THEN 'basis' ELSE 'baseline-output' END,NEW.id,NEW.expires_at);
 RETURN NULL;
END $$;
CREATE TRIGGER knowledge_benchmark_basis_retention AFTER INSERT ON knowledge_benchmark_items FOR EACH ROW EXECUTE FUNCTION register_knowledge_benchmark_retention();
CREATE TRIGGER knowledge_benchmark_output_retention AFTER INSERT ON knowledge_benchmark_assessments FOR EACH ROW EXECUTE FUNCTION register_knowledge_benchmark_retention();
CREATE FUNCTION guard_knowledge_benchmark_retention_job() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE actual record;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'benchmark_retention_history_immutable' USING ERRCODE='23514';END IF;
 IF NEW.kind='basis' THEN SELECT created_by,expires_at,(encrypted_basis IS NULL) AS cleared INTO actual FROM knowledge_benchmark_items WHERE id=NEW.resource_id;
 ELSE SELECT created_by,expires_at,(encrypted_output IS NULL) AS cleared INTO actual FROM knowledge_benchmark_assessments WHERE id=NEW.resource_id;END IF;
 IF actual.created_by IS DISTINCT FROM NEW.created_by OR actual.expires_at IS DISTINCT FROM NEW.expires_at OR NEW.id IS DISTINCT FROM NEW.resource_id THEN
  RAISE EXCEPTION 'benchmark_retention_source_invalid' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' AND((to_jsonb(NEW)-ARRAY['state','completed_at']) IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['state','completed_at'])
  OR OLD.state<>'pending' OR NEW.state<>'completed' OR NOT actual.cleared OR NEW.expires_at>knowledge_benchmark_now()) THEN
  RAISE EXCEPTION 'benchmark_retention_completion_invalid' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER a_knowledge_benchmark_retention_job BEFORE INSERT OR UPDATE OR DELETE ON knowledge_benchmark_retention_jobs FOR EACH ROW EXECUTE FUNCTION guard_knowledge_benchmark_retention_job();
ALTER TABLE knowledge_benchmark_retention_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_benchmark_retention_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY knowledge_benchmark_retention_route ON knowledge_benchmark_retention_jobs TO yummyai_app USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON knowledge_benchmark_retention_jobs TO yummyai_app;

ALTER TABLE knowledge_benchmark_datasets ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_benchmark_datasets FORCE ROW LEVEL SECURITY;
CREATE POLICY knowledge_benchmark_datasets_private ON knowledge_benchmark_datasets TO yummyai_app
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND created_by=nullif(current_setting('app.user_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND created_by=nullif(current_setting('app.user_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON knowledge_benchmark_datasets TO yummyai_app;
CREATE TRIGGER a_knowledge_benchmark_datasets BEFORE INSERT OR UPDATE OR DELETE ON knowledge_benchmark_datasets FOR EACH ROW EXECUTE FUNCTION guard_knowledge_benchmark_record();
CREATE CONSTRAINT TRIGGER knowledge_benchmark_datasets_closure AFTER INSERT OR UPDATE ON knowledge_benchmark_datasets
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_knowledge_benchmark_record();

ALTER TABLE knowledge_benchmark_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_benchmark_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY knowledge_benchmark_versions_private ON knowledge_benchmark_versions TO yummyai_app
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND created_by=nullif(current_setting('app.user_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND created_by=nullif(current_setting('app.user_id',true),'')::uuid);
GRANT SELECT,INSERT ON knowledge_benchmark_versions TO yummyai_app;
CREATE TRIGGER a_knowledge_benchmark_versions BEFORE INSERT OR UPDATE OR DELETE ON knowledge_benchmark_versions FOR EACH ROW EXECUTE FUNCTION guard_knowledge_benchmark_record();
CREATE CONSTRAINT TRIGGER knowledge_benchmark_versions_closure AFTER INSERT ON knowledge_benchmark_versions
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_knowledge_benchmark_record();

ALTER TABLE knowledge_benchmark_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_benchmark_items FORCE ROW LEVEL SECURITY;
CREATE POLICY knowledge_benchmark_items_private ON knowledge_benchmark_items TO yummyai_app
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND created_by=nullif(current_setting('app.user_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND created_by=nullif(current_setting('app.user_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON knowledge_benchmark_items TO yummyai_app;
CREATE TRIGGER a_knowledge_benchmark_items BEFORE INSERT OR UPDATE OR DELETE ON knowledge_benchmark_items FOR EACH ROW EXECUTE FUNCTION guard_knowledge_benchmark_record();
CREATE CONSTRAINT TRIGGER knowledge_benchmark_items_closure AFTER INSERT OR UPDATE ON knowledge_benchmark_items
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_knowledge_benchmark_record();

ALTER TABLE knowledge_benchmark_experiments ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_benchmark_experiments FORCE ROW LEVEL SECURITY;
CREATE POLICY knowledge_benchmark_experiments_private ON knowledge_benchmark_experiments TO yummyai_app
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND created_by=nullif(current_setting('app.user_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND created_by=nullif(current_setting('app.user_id',true),'')::uuid);
GRANT SELECT,INSERT ON knowledge_benchmark_experiments TO yummyai_app;
CREATE TRIGGER a_knowledge_benchmark_experiments BEFORE INSERT OR UPDATE OR DELETE ON knowledge_benchmark_experiments FOR EACH ROW EXECUTE FUNCTION guard_knowledge_benchmark_record();
CREATE CONSTRAINT TRIGGER knowledge_benchmark_experiments_closure AFTER INSERT ON knowledge_benchmark_experiments
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_knowledge_benchmark_record();

ALTER TABLE knowledge_benchmark_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_benchmark_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY knowledge_benchmark_attempts_private ON knowledge_benchmark_attempts TO yummyai_app
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND created_by=nullif(current_setting('app.user_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND created_by=nullif(current_setting('app.user_id',true),'')::uuid);
GRANT SELECT,INSERT ON knowledge_benchmark_attempts TO yummyai_app;
CREATE TRIGGER a_knowledge_benchmark_attempts BEFORE INSERT OR UPDATE OR DELETE ON knowledge_benchmark_attempts FOR EACH ROW EXECUTE FUNCTION guard_knowledge_benchmark_record();
CREATE CONSTRAINT TRIGGER knowledge_benchmark_attempts_closure AFTER INSERT ON knowledge_benchmark_attempts
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_knowledge_benchmark_record();

ALTER TABLE knowledge_benchmark_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_benchmark_assessments FORCE ROW LEVEL SECURITY;
CREATE POLICY knowledge_benchmark_assessments_private ON knowledge_benchmark_assessments TO yummyai_app
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND created_by=nullif(current_setting('app.user_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND created_by=nullif(current_setting('app.user_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON knowledge_benchmark_assessments TO yummyai_app;
CREATE TRIGGER a_knowledge_benchmark_assessments BEFORE INSERT OR UPDATE OR DELETE ON knowledge_benchmark_assessments FOR EACH ROW EXECUTE FUNCTION guard_knowledge_benchmark_record();
CREATE CONSTRAINT TRIGGER knowledge_benchmark_assessments_closure AFTER INSERT OR UPDATE ON knowledge_benchmark_assessments
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_knowledge_benchmark_record();

ALTER TABLE knowledge_benchmark_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_benchmark_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY knowledge_benchmark_reviews_private ON knowledge_benchmark_reviews TO yummyai_app
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND created_by=nullif(current_setting('app.user_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND created_by=nullif(current_setting('app.user_id',true),'')::uuid);
GRANT SELECT,INSERT ON knowledge_benchmark_reviews TO yummyai_app;
CREATE TRIGGER a_knowledge_benchmark_reviews BEFORE INSERT OR UPDATE OR DELETE ON knowledge_benchmark_reviews FOR EACH ROW EXECUTE FUNCTION guard_knowledge_benchmark_record();
CREATE CONSTRAINT TRIGGER knowledge_benchmark_reviews_closure AFTER INSERT ON knowledge_benchmark_reviews
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_knowledge_benchmark_record();

ALTER TABLE knowledge_benchmark_expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_benchmark_expenses FORCE ROW LEVEL SECURITY;
CREATE POLICY knowledge_benchmark_expenses_private ON knowledge_benchmark_expenses TO yummyai_app
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND created_by=nullif(current_setting('app.user_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND created_by=nullif(current_setting('app.user_id',true),'')::uuid);
GRANT SELECT,INSERT ON knowledge_benchmark_expenses TO yummyai_app;
CREATE TRIGGER a_knowledge_benchmark_expenses BEFORE INSERT OR UPDATE OR DELETE ON knowledge_benchmark_expenses FOR EACH ROW EXECUTE FUNCTION guard_knowledge_benchmark_record();
CREATE CONSTRAINT TRIGGER knowledge_benchmark_expenses_closure AFTER INSERT ON knowledge_benchmark_expenses
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_knowledge_benchmark_record();

ALTER TABLE knowledge_benchmark_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_benchmark_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY knowledge_benchmark_commands_private ON knowledge_benchmark_commands TO yummyai_app
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND created_by=nullif(current_setting('app.user_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND created_by=nullif(current_setting('app.user_id',true),'')::uuid);
GRANT SELECT,INSERT ON knowledge_benchmark_commands TO yummyai_app;
CREATE TRIGGER a_knowledge_benchmark_commands BEFORE INSERT OR UPDATE OR DELETE ON knowledge_benchmark_commands FOR EACH ROW EXECUTE FUNCTION guard_knowledge_benchmark_record();
CREATE CONSTRAINT TRIGGER knowledge_benchmark_commands_closure AFTER INSERT ON knowledge_benchmark_commands
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_knowledge_benchmark_record();

ALTER TABLE knowledge_benchmark_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_benchmark_reports FORCE ROW LEVEL SECURITY;
CREATE POLICY knowledge_benchmark_reports_private ON knowledge_benchmark_reports TO yummyai_app
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND created_by=nullif(current_setting('app.user_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND created_by=nullif(current_setting('app.user_id',true),'')::uuid);
GRANT SELECT,INSERT ON knowledge_benchmark_reports TO yummyai_app;
CREATE TRIGGER a_knowledge_benchmark_reports BEFORE INSERT OR UPDATE OR DELETE ON knowledge_benchmark_reports FOR EACH ROW EXECUTE FUNCTION guard_knowledge_benchmark_record();
CREATE CONSTRAINT TRIGGER knowledge_benchmark_reports_closure AFTER INSERT ON knowledge_benchmark_reports
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_knowledge_benchmark_record();

