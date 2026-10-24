-- Retained transports bind new actual advertising owners. No history is backfilled.
CREATE TABLE advertising_original_write_proofs (
 tenant_id uuid NOT NULL REFERENCES organizations(id),account_id uuid NOT NULL,kind text NOT NULL,result_id uuid NOT NULL,
 command_id uuid,request_key text NOT NULL,actor_id uuid NOT NULL REFERENCES app_users(id),target_id uuid,scope_key text NOT NULL,
 owner_input_checksum text,creation_transaction_id text NOT NULL,parent_id uuid,version integer,
 PRIMARY KEY(tenant_id,kind,result_id),
 CONSTRAINT advertising_original_proof_account_fk FOREIGN KEY(tenant_id,account_id) REFERENCES marketplace_accounts(tenant_id,id),
 CONSTRAINT advertising_original_proof_hash CHECK((kind='import_commit')=(owner_input_checksum IS NULL)
   AND (owner_input_checksum IS NULL OR owner_input_checksum~'^[a-f0-9]{64}$'))
);
CREATE UNIQUE INDEX advertising_original_proof_command ON advertising_original_write_proofs(tenant_id,command_id) WHERE command_id IS NOT NULL;
CREATE UNIQUE INDEX advertising_original_proof_key ON advertising_original_write_proofs(tenant_id,account_id,kind,
 (CASE WHEN kind IN('action_transition','import_archive') THEN target_id::text ELSE 'root' END),request_key);
CREATE TABLE advertising_commands (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES organizations(id),account_id uuid NOT NULL,created_by uuid NOT NULL REFERENCES app_users(id),
 kind text NOT NULL,target_id uuid,scope_key text NOT NULL,request_key text NOT NULL,request_checksum text NOT NULL,owner_input_checksum text NOT NULL,
 authority_snapshot jsonb NOT NULL,encrypted_input text,contract_version text NOT NULL DEFAULT 'advertising-command-v1',
 status text NOT NULL DEFAULT 'prepared',result_id uuid,parent_id uuid,version integer,error_code text,
 created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,completed_at timestamptz,acknowledged_at timestamptz,redacted_at timestamptz,
 CONSTRAINT advertising_commands_scope UNIQUE(tenant_id,id),
 CONSTRAINT advertising_command_account_fk FOREIGN KEY(tenant_id,account_id) REFERENCES marketplace_accounts(tenant_id,id),
 CONSTRAINT advertising_command_actual_result_fk FOREIGN KEY(tenant_id,kind,result_id) REFERENCES advertising_original_write_proofs(tenant_id,kind,result_id),
 CONSTRAINT advertising_commands_result CHECK((status='succeeded')=(result_id IS NOT NULL) AND (status='prepared')=(completed_at IS NULL)
   AND (status='succeeded' OR parent_id IS NULL AND version IS NULL)),
 CONSTRAINT advertising_commands_status CHECK(status IN('prepared','succeeded','cancelled','expired')),
 CONSTRAINT advertising_commands_input_state CHECK((status<>'prepared' OR encrypted_input IS NOT NULL AND redacted_at IS NULL)
   AND (status NOT IN('cancelled','expired') OR encrypted_input IS NULL AND redacted_at IS NOT NULL) AND error_code IS NULL),
 CONSTRAINT advertising_commands_cipher CHECK(encrypted_input IS NULL OR octet_length(encrypted_input) BETWEEN 44 AND 47185920),
 CONSTRAINT advertising_commands_hash CHECK(request_checksum~'^[a-f0-9]{64}$' AND owner_input_checksum~'^[a-f0-9]{64}$'),
 CONSTRAINT advertising_commands_time CHECK(expires_at=created_at+interval '7 days' AND (completed_at IS NULL OR completed_at>=created_at)
   AND (acknowledged_at IS NULL OR acknowledged_at>=completed_at) AND (redacted_at IS NULL OR redacted_at>=created_at)),
 CONSTRAINT advertising_commands_redaction CHECK((encrypted_input IS NULL)=(redacted_at IS NOT NULL)
   AND (acknowledged_at IS NULL OR status<>'prepared' AND encrypted_input IS NULL))
);
ALTER TABLE advertising_original_write_proofs ADD CONSTRAINT advertising_original_proof_command_fk
 FOREIGN KEY(tenant_id,command_id) REFERENCES advertising_commands(tenant_id,id);
CREATE UNIQUE INDEX advertising_commands_key ON advertising_commands(tenant_id,account_id,kind,
 (CASE WHEN kind IN('action_transition','import_archive') THEN target_id::text ELSE 'root' END),request_key);
CREATE UNIQUE INDEX advertising_commands_unacknowledged ON advertising_commands(tenant_id,account_id,kind,created_by,scope_key) WHERE acknowledged_at IS NULL;
CREATE INDEX advertising_commands_retention ON advertising_commands(tenant_id,expires_at) WHERE encrypted_input IS NOT NULL;
CREATE TABLE advertising_owner_mutation_evidence (
 tenant_id uuid NOT NULL REFERENCES organizations(id),account_id uuid NOT NULL,kind text NOT NULL,parent_id uuid NOT NULL,version integer NOT NULL,
 phase text NOT NULL,event_id uuid,actor_id uuid NOT NULL REFERENCES app_users(id),before_state jsonb NOT NULL,after_state jsonb NOT NULL,
 creation_transaction_id text NOT NULL,PRIMARY KEY(tenant_id,kind,parent_id,version,phase),
 CONSTRAINT advertising_owner_mutation_account_fk FOREIGN KEY(tenant_id,account_id) REFERENCES marketplace_accounts(tenant_id,id),
 CHECK(kind IN('action_transition','import_archive') AND phase IN('mutation','event') AND (phase='event')=(event_id IS NOT NULL)
   AND (kind='import_archive' AND version=0 OR kind='action_transition' AND version>1))
);
CREATE TABLE advertising_command_audit_receipts (
 tenant_id uuid NOT NULL REFERENCES organizations(id),audit_id uuid NOT NULL REFERENCES audit_events(id),creation_transaction_id text NOT NULL,
 PRIMARY KEY(tenant_id,audit_id)
);
--> statement-breakpoint
CREATE FUNCTION ad_command_table(k text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
 SELECT CASE k WHEN 'import_commit' THEN 'ad_import_batches' WHEN 'goal_save' THEN 'ad_goal_versions'
 WHEN 'observation_record' THEN 'ad_observations' WHEN 'analysis_run' THEN 'ad_analysis_runs'
 WHEN 'action_transition' THEN 'ad_action_events' WHEN 'import_archive' THEN 'ad_import_events' WHEN 'export_seal' THEN 'ad_exports' END
$$;
CREATE FUNCTION ad_command_requested_id() RETURNS uuid LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public AS $$
DECLARE requested text:=nullif(current_setting('app.advertising_command_id',true),'');
BEGIN
 IF requested IS NULL THEN RETURN NULL;END IF;
 IF requested!~'^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' THEN
  RAISE EXCEPTION 'advertising_command_marker_invalid' USING ERRCODE='23514';END IF;
 RETURN requested::uuid;
END $$;
CREATE FUNCTION advertising_command_now() RETURNS timestamptz LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public AS $$
 SELECT clock_timestamp()
$$;
--> statement-breakpoint
CREATE FUNCTION capture_advertising_owner_mutation() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE k text;v integer;before_state jsonb;after_state jsonb;requested uuid:=ad_command_requested_id();
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid
  OR nullif(current_setting('app.user_id',true),'') IS NULL THEN RAISE EXCEPTION 'advertising_original_actor_invalid' USING ERRCODE='23514';END IF;
 IF requested IS NOT NULL AND NOT EXISTS(SELECT 1 FROM advertising_commands c WHERE c.tenant_id=NEW.tenant_id AND c.id=requested
   AND c.account_id=NEW.account_id AND c.created_by=nullif(current_setting('app.user_id',true),'')::uuid AND c.status='prepared'
   AND c.encrypted_input IS NOT NULL AND c.expires_at>advertising_command_now()) THEN
  RAISE EXCEPTION 'advertising_original_mutation_admission_invalid' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='ad_actions' THEN
  k:='action_transition';v:=NEW.revision;
  before_state:=jsonb_build_object('status',OLD.status,'revision',OLD.revision,'executedAt',OLD.executed_at,
   'actualBeforeMinor',OLD.actual_before_minor,'actualAfterMinor',OLD.actual_after_minor);
  after_state:=jsonb_build_object('status',NEW.status,'revision',NEW.revision,'executedAt',NEW.executed_at,
   'actualBeforeMinor',NEW.actual_before_minor,'actualAfterMinor',NEW.actual_after_minor);
 ELSE
  IF OLD.archived_at IS NOT NULL OR NEW.archived_at IS NULL THEN RAISE EXCEPTION 'advertising_original_archive_invalid' USING ERRCODE='23514';END IF;
  k:='import_archive';v:=0;before_state:=jsonb_build_object('archivedAt',OLD.archived_at);after_state:=jsonb_build_object('archivedAt',NEW.archived_at);
 END IF;
 INSERT INTO advertising_owner_mutation_evidence(tenant_id,account_id,kind,parent_id,version,phase,event_id,actor_id,before_state,after_state,creation_transaction_id)
 VALUES(NEW.tenant_id,NEW.account_id,k,NEW.id,v,'mutation',NULL,nullif(current_setting('app.user_id',true),'')::uuid,before_state,after_state,pg_current_xact_id()::text);
 RETURN NEW;
END $$;
CREATE FUNCTION ad_command_event_class(r jsonb) RETURNS text LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public AS $$
DECLARE a ad_actions;m advertising_owner_mutation_evidence;requested uuid:=ad_command_requested_id();
BEGIN
 IF (r->>'idempotency_key')!~'^(generated|invalidate):' THEN RETURN 'actual';END IF;
 SELECT * INTO a FROM ad_actions WHERE tenant_id=(r->>'tenant_id')::uuid AND account_id=(r->>'account_id')::uuid AND id=(r->>'action_id')::uuid;
 IF a.id IS NULL THEN RAISE EXCEPTION 'advertising_original_parent_invalid' USING ERRCODE='23514';END IF;
 IF r->>'idempotency_key'='generated:'||a.run_id::text THEN
  IF r->>'status' IS DISTINCT FROM 'pending' OR r->'data' IS DISTINCT FROM jsonb_build_object('runId',a.run_id)
   OR a.created_by IS DISTINCT FROM (r->>'created_by')::uuid OR NOT EXISTS(SELECT 1 FROM advertising_original_write_proofs p
    WHERE p.tenant_id=a.tenant_id AND p.account_id=a.account_id AND p.kind='analysis_run' AND p.result_id=a.run_id
      AND p.actor_id=(r->>'created_by')::uuid AND p.creation_transaction_id=pg_current_xact_id()::text AND p.command_id IS NOT DISTINCT FROM requested)
   OR requested IS NOT NULL AND NOT EXISTS(SELECT 1 FROM advertising_commands c WHERE c.tenant_id=a.tenant_id AND c.id=requested
     AND c.kind='analysis_run' AND c.status='prepared') THEN RAISE EXCEPTION 'advertising_original_generated_event_invalid' USING ERRCODE='23514';END IF;
  RETURN 'generated';
 END IF;
 SELECT * INTO m FROM advertising_owner_mutation_evidence WHERE tenant_id=a.tenant_id AND account_id=a.account_id AND kind='action_transition'
  AND parent_id=a.id AND version=a.revision AND phase='mutation' AND creation_transaction_id=pg_current_xact_id()::text;
 IF r->>'idempotency_key' IS DISTINCT FROM 'invalidate:'||a.revision::text OR r->>'status' IS DISTINCT FROM 'stale' OR r->'data' IS DISTINCT FROM '{}'::jsonb
  OR m.actor_id IS DISTINCT FROM (r->>'created_by')::uuid OR m.after_state->>'status' IS DISTINCT FROM 'stale'
  OR NOT EXISTS(SELECT 1 FROM advertising_original_write_proofs p WHERE p.tenant_id=a.tenant_id AND p.account_id=a.account_id
   AND p.kind IN('import_commit','goal_save','observation_record','import_archive') AND p.actor_id=(r->>'created_by')::uuid
   AND p.creation_transaction_id=pg_current_xact_id()::text AND p.command_id IS NOT DISTINCT FROM requested)
  OR requested IS NOT NULL AND NOT EXISTS(SELECT 1 FROM advertising_commands c WHERE c.tenant_id=a.tenant_id AND c.id=requested
    AND c.kind IN('import_commit','goal_save','observation_record','import_archive') AND c.status='prepared') THEN
  RAISE EXCEPTION 'advertising_original_invalidation_event_invalid' USING ERRCODE='23514';END IF;
 RETURN 'invalidation';
END $$;
CREATE FUNCTION admit_advertising_original_owner() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE k text:=TG_ARGV[0];target uuid;
BEGIN
 IF ad_command_table(k) IS DISTINCT FROM TG_TABLE_NAME OR NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid
  OR NEW.created_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid THEN
  RAISE EXCEPTION 'advertising_original_actor_invalid' USING ERRCODE='23514';END IF;
 IF k='action_transition' THEN
  IF ad_command_event_class(to_jsonb(NEW))<>'actual' THEN RETURN NEW;END IF;
  target:=NEW.action_id;
 ELSIF k='import_archive' THEN target:=NEW.import_id;
 ELSIF k='export_seal' THEN target:=NEW.run_id;END IF;
 PERFORM ad_command_assert_request(k,NEW.account_id,target,NEW.idempotency_key);
 RETURN NEW;
END $$;
CREATE FUNCTION mint_advertising_original_proof() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE k text:=TG_ARGV[0];r jsonb:=to_jsonb(NEW);b jsonb;c advertising_commands;m advertising_owner_mutation_evidence;
 requested uuid:=ad_command_requested_id();event_class text:='actual';event_version integer;event_parent uuid;
BEGIN
 IF TG_OP<>'INSERT' OR ad_command_table(k) IS DISTINCT FROM TG_TABLE_NAME THEN RAISE EXCEPTION 'advertising_original_owner_invalid' USING ERRCODE='23514';END IF;
 IF k='action_transition' THEN
  event_class:=ad_command_event_class(r);
  IF event_class='generated' THEN RETURN NEW;END IF;
  event_parent:=NEW.action_id;
  IF event_class='invalidation' THEN
   SELECT revision INTO event_version FROM ad_actions WHERE tenant_id=NEW.tenant_id AND account_id=NEW.account_id AND id=event_parent;
  ELSE
   IF jsonb_typeof(NEW.data->'expectedRevision') IS DISTINCT FROM 'number' OR (NEW.data->>'expectedRevision')!~'^[1-9][0-9]*$'
    OR (NEW.data->>'expectedRevision')::numeric>2147483646 THEN RAISE EXCEPTION 'advertising_original_event_invalid' USING ERRCODE='23514';END IF;
   event_version:=(NEW.data->>'expectedRevision')::integer+1;
  END IF;
 ELSIF k='import_archive' THEN event_parent:=NEW.import_id;event_version:=0;END IF;
 IF event_parent IS NOT NULL THEN
  SELECT * INTO m FROM advertising_owner_mutation_evidence WHERE tenant_id=NEW.tenant_id AND account_id=NEW.account_id AND kind=k
   AND parent_id=event_parent AND version=event_version AND phase='mutation' AND creation_transaction_id=pg_current_xact_id()::text;
  IF m.actor_id IS DISTINCT FROM NEW.created_by THEN RAISE EXCEPTION 'advertising_original_parent_mutation_missing' USING ERRCODE='23514';END IF;
  IF k='action_transition' THEN
   IF m.after_state->>'status' IS DISTINCT FROM NEW.status OR event_class='actual' AND (
    m.before_state->>'status' IS DISTINCT FROM NEW.data->>'expectedStatus' OR (m.before_state->>'revision')::integer IS DISTINCT FROM event_version-1) THEN
   RAISE EXCEPTION 'advertising_original_parent_mutation_invalid' USING ERRCODE='23514';END IF;
   IF NEW.status='executed' AND ((m.after_state->>'executedAt')::timestamptz IS DISTINCT FROM (NEW.data->>'executedAt')::timestamptz
    OR m.after_state->>'actualBeforeMinor' IS DISTINCT FROM NEW.data->>'actualBeforeMinor'
    OR m.after_state->>'actualAfterMinor' IS DISTINCT FROM NEW.data->>'actualAfterMinor') THEN
   RAISE EXCEPTION 'advertising_original_execution_invalid' USING ERRCODE='23514';END IF;
  END IF;
  INSERT INTO advertising_owner_mutation_evidence(tenant_id,account_id,kind,parent_id,version,phase,event_id,actor_id,before_state,after_state,creation_transaction_id)
   VALUES(m.tenant_id,m.account_id,m.kind,m.parent_id,m.version,'event',NEW.id,m.actor_id,m.before_state,m.after_state,pg_current_xact_id()::text);
 END IF;
 IF event_class<>'actual' THEN RETURN NEW;END IF;
 b:=ad_command_result_binding(k,NEW.id);
 IF b IS NULL OR b->>'actorId' IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')
  OR NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid THEN
  RAISE EXCEPTION 'advertising_original_actor_invalid' USING ERRCODE='23514';END IF;
 SELECT * INTO c FROM advertising_commands ac WHERE ac.tenant_id=NEW.tenant_id AND ac.account_id=NEW.account_id AND ac.kind=k
  AND ac.request_key=NEW.idempotency_key AND (k NOT IN('action_transition','import_archive') OR ac.target_id=(b->>'targetId')::uuid);
 IF c.id IS NOT NULL AND (c.id IS DISTINCT FROM requested OR c.status<>'prepared' OR c.encrypted_input IS NULL OR c.expires_at<=advertising_command_now()
  OR c.created_by IS DISTINCT FROM NEW.created_by OR c.target_id IS DISTINCT FROM (b->>'targetId')::uuid OR c.scope_key IS DISTINCT FROM b->>'scopeKey'
  OR k<>'import_commit' AND c.owner_input_checksum IS DISTINCT FROM b->>'ownerInputChecksum') OR requested IS NOT NULL AND c.id IS NULL THEN
  RAISE EXCEPTION 'advertising_original_owner_binding_invalid' USING ERRCODE='23514';END IF;
 INSERT INTO advertising_original_write_proofs(tenant_id,account_id,kind,result_id,command_id,request_key,actor_id,target_id,scope_key,
   owner_input_checksum,creation_transaction_id,parent_id,version)
 VALUES(NEW.tenant_id,NEW.account_id,k,NEW.id,c.id,NEW.idempotency_key,NEW.created_by,(b->>'targetId')::uuid,b->>'scopeKey',
   CASE WHEN k='import_commit' THEN NULL ELSE b->>'ownerInputChecksum' END,pg_current_xact_id()::text,(b->>'parentId')::uuid,(b->>'version')::integer);
 RETURN NEW;
END $$;
CREATE FUNCTION ad_command_key_lock(k text,account uuid,target uuid,request_key text) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE tenant uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;
BEGIN
 IF tenant IS NULL OR account IS NULL OR ad_command_table(k) IS NULL OR request_key IS NULL
  OR k IN('action_transition','import_archive','export_seal') AND target IS NULL
  OR k NOT IN('action_transition','import_archive','export_seal') AND target IS NOT NULL THEN
  RAISE EXCEPTION 'advertising_command_request_invalid' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('advertising-original:'||tenant||':'||account||':'||k||':'||
  CASE WHEN k IN('action_transition','import_archive') THEN target::text ELSE 'root' END||':'||request_key,0));
END $$;
CREATE FUNCTION ad_command_assert_request(k text,account uuid,target uuid,request_key text) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE c advertising_commands;requested uuid:=ad_command_requested_id();tenant uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;
BEGIN
 PERFORM ad_command_key_lock(k,account,target,request_key);
 SELECT * INTO c FROM advertising_commands ac WHERE ac.tenant_id=tenant AND ac.account_id=account AND ac.kind=k AND ac.request_key=ad_command_assert_request.request_key
  AND (k NOT IN('action_transition','import_archive') OR ac.target_id=target) FOR UPDATE;
 IF c.id IS NOT NULL AND (c.id IS DISTINCT FROM requested OR c.status<>'prepared' OR c.encrypted_input IS NULL OR c.redacted_at IS NOT NULL
   OR c.expires_at<=advertising_command_now() OR c.created_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid
   OR c.target_id IS DISTINCT FROM target) OR requested IS NOT NULL AND c.id IS NULL THEN
  RAISE EXCEPTION 'advertising_original_owner_admission_invalid' USING ERRCODE='23514';END IF;
END $$;
-- Canonical hashing is independent of the old locale-dependent adHash.
CREATE FUNCTION ad_command_result_binding(k text,result uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,public AS $$
DECLARE r jsonb;p jsonb;body jsonb;manifest jsonb;raw_hash text;account uuid;target uuid;parent uuid;actor uuid;revision integer;
 scope_key text:='root';table_name text:=ad_command_table(k);tenant uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;
BEGIN
 IF table_name IS NULL THEN RAISE EXCEPTION 'advertising_original_kind_invalid' USING ERRCODE='23514';END IF;
 EXECUTE format('SELECT to_jsonb(r) FROM %I r WHERE tenant_id=$1 AND id=$2',table_name) INTO r USING tenant,result;
 IF r IS NULL THEN RETURN NULL;END IF;
 account:=(r->>'account_id')::uuid;actor:=(r->>'created_by')::uuid;
 IF k='import_commit' THEN
  SELECT min(ai.metadata->>'rawInputChecksum'),coalesce(jsonb_agg(jsonb_build_object('fileName',ai.file_name,'checksum',ai.checksum,
   'byteSize',ai.byte_size,'reportType',ai.report_type,'metadata',ai.metadata) ORDER BY ai.checksum COLLATE "C",ai.file_name COLLATE "C"),'[]')
   INTO raw_hash,manifest FROM ad_imports ai WHERE ai.tenant_id=tenant AND ai.account_id=account AND ai.batch_id=result;
  body:=jsonb_build_object('batchInputChecksum',r->>'input_checksum','rawInputChecksum',raw_hash,'fileManifest',manifest);
 ELSIF k='goal_save' THEN
  SELECT to_jsonb(ap) INTO p FROM ad_products ap WHERE ap.tenant_id=tenant AND ap.account_id=account AND ap.id=(r->>'product_id')::uuid;
  IF p IS NULL THEN RAISE EXCEPTION 'advertising_original_parent_invalid' USING ERRCODE='23514';END IF;
  scope_key:='product:'||(p->>'marketplace')||':'||(p->>'currency')||':'||(p->>'asin');parent:=(p->>'id')::uuid;revision:=(r->>'revision')::integer;
  body:=jsonb_build_object('scope',jsonb_build_object('accountId',account,'marketplace',p->>'marketplace','currency',p->>'currency','asin',p->>'asin'),
   'fields',r->'fields','revision',revision);
 ELSIF k='observation_record' THEN
  p:=r->'data'->'scope';
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR lower(p->>'accountId') IS DISTINCT FROM account::text THEN
   RAISE EXCEPTION 'advertising_original_parent_invalid' USING ERRCODE='23514';END IF;
  scope_key:='product:'||(p->>'marketplace')||':'||(p->>'currency')||':'||(p->>'asin');body:=jsonb_build_object('data',r->'data');
 ELSIF k='analysis_run' THEN
  IF lower(r->'input'->>'accountId') IS DISTINCT FROM account::text OR r->'input'->>'idempotencyKey' IS DISTINCT FROM r->>'idempotency_key' THEN
   RAISE EXCEPTION 'advertising_original_input_invalid' USING ERRCODE='23514';END IF;
  body:=jsonb_build_object('input',r->'input');
 ELSIF k='action_transition' THEN
  IF r->>'idempotency_key'~'^(generated|invalidate):' OR jsonb_typeof(r->'data') IS DISTINCT FROM 'object'
   OR jsonb_typeof(r->'data'->'expectedRevision') IS DISTINCT FROM 'number' OR (r->'data'->>'expectedRevision')!~'^[1-9][0-9]*$'
   OR (r->'data'->>'expectedRevision')::numeric>2147483646
   OR r->'data'->>'idempotencyKey' IS DISTINCT FROM r->>'idempotency_key' OR r->'data'->>'status' IS DISTINCT FROM r->>'status'
   OR r->'data'->>'reason' IS DISTINCT FROM r->>'reason' OR jsonb_typeof(r->'data'->'expectedStatus') IS DISTINCT FROM 'string' THEN
   RAISE EXCEPTION 'advertising_original_event_invalid' USING ERRCODE='23514';END IF;
  SELECT to_jsonb(a) INTO p FROM ad_actions a INNER JOIN ad_analysis_runs ar ON ar.tenant_id=a.tenant_id AND ar.id=a.run_id AND ar.account_id=a.account_id
   WHERE a.tenant_id=tenant AND a.account_id=account AND a.id=(r->>'action_id')::uuid;
  IF p IS NULL OR lower(p->'recommendation'->>'accountId') IS DISTINCT FROM account::text THEN
   RAISE EXCEPTION 'advertising_original_parent_invalid' USING ERRCODE='23514';END IF;
  target:=(r->>'action_id')::uuid;parent:=target;revision:=(r->'data'->>'expectedRevision')::integer+1;scope_key:=target::text;
  body:=jsonb_build_object('actionId',target,'status',r->>'status','reason',r->>'reason','data',r->'data','revision',revision);
 ELSIF k='import_archive' THEN
  target:=(r->>'import_id')::uuid;parent:=target;scope_key:=target::text;
  IF NOT EXISTS(SELECT 1 FROM ad_imports ai WHERE ai.tenant_id=tenant AND ai.account_id=account AND ai.id=target) THEN
   RAISE EXCEPTION 'advertising_original_parent_invalid' USING ERRCODE='23514';END IF;
  body:=jsonb_build_object('importId',target,'reason',r->>'reason');
 ELSE
  target:=(r->>'run_id')::uuid;parent:=target;scope_key:=target::text;
  IF NOT EXISTS(SELECT 1 FROM ad_analysis_runs ar WHERE ar.tenant_id=tenant AND ar.account_id=account AND ar.id=target)
   OR lower(r->'data'->'run'->>'id') IS DISTINCT FROM target::text OR lower(r->'data'->'run'->>'accountId') IS DISTINCT FROM account::text
   OR jsonb_typeof(r->'data'->'actions') IS DISTINCT FROM 'array' THEN
   RAISE EXCEPTION 'advertising_original_parent_invalid' USING ERRCODE='23514';END IF;
  body:=jsonb_build_object('runId',target,'actionIds',(SELECT coalesce(jsonb_agg(lower(x->>'id') ORDER BY lower(x->>'id') COLLATE "C"),'[]')
   FROM jsonb_array_elements(r->'data'->'actions') x),'reviewReason',r->>'review_reason');
 END IF;
 RETURN jsonb_build_object('accountId',account,'targetId',target,'scopeKey',scope_key,'requestKey',r->>'idempotency_key','actorId',actor,
  'parentId',parent,'version',revision,'projection',body,
  'ownerInputChecksum',finance_cost_hash(jsonb_build_object('kind',k,'accountId',account,'targetId',target,'scopeKey',scope_key,'projection',body)));
END $$;
--> statement-breakpoint
CREATE FUNCTION capture_advertising_command_audit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.result='success' AND (NEW.action IN('advertising.import','advertising.goal.version','advertising.observation','advertising.analyze',
   'advertising.action.transition','advertising.import.archive','advertising.export.seal')
   OR NEW.action IN('advertising.command.prepare','advertising.command.execute','advertising.command.cancel','advertising.command.acknowledge')) THEN
  IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid
   OR NEW.actor_user_id IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid THEN
   RAISE EXCEPTION 'advertising_original_audit_actor_invalid' USING ERRCODE='23514';END IF;
  INSERT INTO advertising_command_audit_receipts(tenant_id,audit_id,creation_transaction_id) VALUES(NEW.tenant_id,NEW.id,pg_current_xact_id()::text);
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION ad_command_has_owner_audit(k text,actor uuid,owner_result uuid,parent uuid,revision integer) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM audit_events a INNER JOIN advertising_command_audit_receipts ar ON ar.tenant_id=a.tenant_id AND ar.audit_id=a.id
  WHERE a.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND a.actor_user_id=actor AND a.result='success'
   AND ar.creation_transaction_id=pg_current_xact_id()::text
   AND a.action=CASE k WHEN 'import_commit' THEN 'advertising.import' WHEN 'goal_save' THEN 'advertising.goal.version'
    WHEN 'observation_record' THEN 'advertising.observation' WHEN 'analysis_run' THEN 'advertising.analyze'
    WHEN 'action_transition' THEN 'advertising.action.transition' WHEN 'import_archive' THEN 'advertising.import.archive' WHEN 'export_seal' THEN 'advertising.export.seal' END
   AND a.entity_type=CASE k WHEN 'import_commit' THEN 'ad_import_batch' WHEN 'goal_save' THEN 'ad_goal_version'
    WHEN 'observation_record' THEN 'ad_observation' WHEN 'analysis_run' THEN 'ad_analysis_run'
    WHEN 'action_transition' THEN 'ad_action' WHEN 'import_archive' THEN 'ad_import' WHEN 'export_seal' THEN 'ad_export' END
   AND a.entity_id=CASE WHEN k IN('action_transition','import_archive') THEN parent ELSE owner_result END
   AND (k NOT IN('action_transition','goal_save') OR a.metadata->'revision'=to_jsonb(revision)))
$$;
CREATE FUNCTION require_advertising_mutation_outcome() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.phase='mutation' AND NOT EXISTS(SELECT 1 FROM advertising_owner_mutation_evidence e WHERE e.tenant_id=NEW.tenant_id AND e.account_id=NEW.account_id
  AND e.kind=NEW.kind AND e.parent_id=NEW.parent_id AND e.version=NEW.version AND e.phase='event' AND e.event_id IS NOT NULL
  AND e.actor_id=NEW.actor_id AND e.creation_transaction_id=NEW.creation_transaction_id AND e.creation_transaction_id=pg_current_xact_id()::text
  AND e.before_state=NEW.before_state AND e.after_state=NEW.after_state) THEN
  RAISE EXCEPTION 'advertising_original_mutation_event_missing' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE FUNCTION require_advertising_command_outcome() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE c advertising_commands;b jsonb;file_count bigint;row_count bigint;raw_hash_count bigint;bad_files boolean;
BEGIN
 IF NEW.creation_transaction_id IS DISTINCT FROM pg_current_xact_id()::text THEN RAISE EXCEPTION 'advertising_original_transaction_invalid' USING ERRCODE='23514';END IF;
 b:=ad_command_result_binding(NEW.kind,NEW.result_id);
 IF b IS NULL OR b->>'accountId' IS DISTINCT FROM NEW.account_id::text OR b->>'actorId' IS DISTINCT FROM NEW.actor_id::text
  OR b->>'requestKey' IS DISTINCT FROM NEW.request_key OR b->>'targetId' IS DISTINCT FROM NEW.target_id::text
  OR b->>'scopeKey' IS DISTINCT FROM NEW.scope_key OR b->>'parentId' IS DISTINCT FROM NEW.parent_id::text
  OR b->>'version' IS DISTINCT FROM NEW.version::text
  OR NEW.kind<>'import_commit' AND b->>'ownerInputChecksum' IS DISTINCT FROM NEW.owner_input_checksum THEN
  RAISE EXCEPTION 'advertising_original_actual_binding_invalid' USING ERRCODE='23514';END IF;
 IF NEW.kind='import_commit' THEN
  SELECT count(*),coalesce(sum(ai.accepted_row_count),0),count(DISTINCT ai.metadata->>'rawInputChecksum'),
   coalesce(bool_or(ai.account_id<>NEW.account_id OR ai.created_by<>NEW.actor_id OR ai.metadata->>'rawInputChecksum' IS NULL
    OR (ai.metadata->>'rawInputChecksum')!~'^[a-f0-9]{64}$' OR ai.checksum!~'^[a-f0-9]{64}$'
    OR ai.accepted_row_count<>(SELECT count(*) FROM ad_facts af WHERE af.tenant_id=ai.tenant_id AND af.import_id=ai.id)),false)
   INTO file_count,row_count,raw_hash_count,bad_files FROM ad_imports ai WHERE ai.tenant_id=NEW.tenant_id AND ai.batch_id=NEW.result_id;
  IF file_count NOT BETWEEN 1 AND 20 OR raw_hash_count<>1 OR bad_files
   OR (SELECT count(DISTINCT ai.checksum) FROM ad_imports ai WHERE ai.tenant_id=NEW.tenant_id AND ai.batch_id=NEW.result_id)<>file_count
   OR NOT EXISTS(SELECT 1 FROM audit_events a INNER JOIN advertising_command_audit_receipts ar ON ar.tenant_id=a.tenant_id AND ar.audit_id=a.id
     WHERE a.tenant_id=NEW.tenant_id AND a.actor_user_id=NEW.actor_id AND a.entity_type='ad_import_batch' AND a.entity_id=NEW.result_id
      AND a.action='advertising.import' AND a.result='success' AND ar.creation_transaction_id=pg_current_xact_id()::text
      AND a.metadata->'fileCount'=to_jsonb(file_count) AND a.metadata->'rowCount'=to_jsonb(row_count)) THEN
   RAISE EXCEPTION 'advertising_original_import_manifest_invalid' USING ERRCODE='23514';END IF;
 END IF;
 IF NOT ad_command_has_owner_audit(NEW.kind,NEW.actor_id,NEW.result_id,NEW.parent_id,NEW.version) THEN
  RAISE EXCEPTION 'advertising_original_owner_audit_missing' USING ERRCODE='23514';END IF;
 IF NEW.command_id IS NOT NULL THEN
  SELECT * INTO c FROM advertising_commands WHERE tenant_id=NEW.tenant_id AND id=NEW.command_id;
  IF c.status IS DISTINCT FROM 'succeeded' OR c.account_id IS DISTINCT FROM NEW.account_id OR c.kind IS DISTINCT FROM NEW.kind
   OR c.result_id IS DISTINCT FROM NEW.result_id OR c.parent_id IS DISTINCT FROM NEW.parent_id OR c.version IS DISTINCT FROM NEW.version
   OR c.created_by IS DISTINCT FROM NEW.actor_id OR c.owner_input_checksum IS DISTINCT FROM b->>'ownerInputChecksum'
   OR c.target_id IS DISTINCT FROM NEW.target_id OR c.scope_key IS DISTINCT FROM NEW.scope_key OR c.request_key IS DISTINCT FROM NEW.request_key THEN
   RAISE EXCEPTION 'advertising_original_outcome_missing' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE FUNCTION guard_advertising_command() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE p advertising_original_write_proofs;b jsonb;existing boolean;table_name text;tenant uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'advertising_original_immutable' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' THEN PERFORM ad_command_key_lock(NEW.kind,NEW.account_id,NEW.target_id,NEW.request_key);END IF;
 table_name:=ad_command_table(NEW.kind);
 IF table_name IS NULL OR NEW.id::text!~'^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
  OR NEW.tenant_id IS DISTINCT FROM tenant OR length(NEW.request_key) NOT BETWEEN 8 AND 200 OR NEW.request_key<>btrim(NEW.request_key)
  OR NEW.request_key~'^(generated|invalidate):' OR NEW.contract_version<>'advertising-command-v1'
  OR NEW.authority_snapshot->>'tenantId' IS DISTINCT FROM NEW.tenant_id::text OR NEW.authority_snapshot->>'userId' IS DISTINCT FROM NEW.created_by::text
  OR jsonb_typeof(NEW.authority_snapshot->'permissions') IS DISTINCT FROM 'array'
  OR NEW.kind IN('action_transition','import_archive','export_seal') AND (NEW.target_id IS NULL OR NEW.scope_key IS DISTINCT FROM NEW.target_id::text)
  OR NEW.kind NOT IN('action_transition','import_archive','export_seal') AND NEW.target_id IS NOT NULL
  OR NEW.kind IN('goal_save','observation_record') AND NEW.scope_key!~'^product:[A-Z]{2}:[A-Z]{3}:[A-Z0-9]{10}$'
  OR NEW.kind IN('import_commit','analysis_run') AND NEW.scope_key<>'root' THEN
  RAISE EXCEPTION 'advertising_original_identity_invalid' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.created_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid OR NEW.status<>'prepared'
   OR NEW.result_id IS NOT NULL OR NEW.parent_id IS NOT NULL OR NEW.version IS NOT NULL OR NEW.completed_at IS NOT NULL
   OR NEW.acknowledged_at IS NOT NULL OR NEW.redacted_at IS NOT NULL OR NEW.encrypted_input IS NULL THEN
   RAISE EXCEPTION 'advertising_original_initial_invalid' USING ERRCODE='23514';END IF;
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I WHERE tenant_id=$1 AND account_id=$2 AND idempotency_key=$3%s)',table_name,
   CASE WHEN NEW.kind='action_transition' THEN ' AND action_id=$4' WHEN NEW.kind='import_archive' THEN ' AND import_id=$4' ELSE '' END)
   INTO existing USING NEW.tenant_id,NEW.account_id,NEW.request_key,NEW.target_id;
  IF existing THEN RAISE EXCEPTION 'advertising_original_existing_raw' USING ERRCODE='23514';END IF;
  NEW.created_at:=date_trunc('milliseconds',advertising_command_now());NEW.expires_at:=NEW.created_at+interval '7 days';
 ELSE
  IF (to_jsonb(NEW)-ARRAY['status','result_id','parent_id','version','error_code','encrypted_input','completed_at','acknowledged_at','redacted_at']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['status','result_id','parent_id','version','error_code','encrypted_input','completed_at','acknowledged_at','redacted_at'])
   OR OLD.encrypted_input IS NULL AND NEW.encrypted_input IS NOT NULL
   OR NEW.encrypted_input IS NOT NULL AND NEW.encrypted_input IS DISTINCT FROM OLD.encrypted_input
   OR OLD.redacted_at IS NOT NULL AND NEW.redacted_at IS DISTINCT FROM OLD.redacted_at
   OR OLD.acknowledged_at IS NOT NULL AND NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at
   OR OLD.status<>'prepared' AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.result_id IS DISTINCT FROM OLD.result_id
    OR NEW.parent_id IS DISTINCT FROM OLD.parent_id OR NEW.version IS DISTINCT FROM OLD.version OR NEW.completed_at IS DISTINCT FROM OLD.completed_at)
   OR NEW.error_code IS NOT NULL THEN RAISE EXCEPTION 'advertising_original_immutable' USING ERRCODE='23514';END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
   IF NEW.status='expired' THEN
    IF NEW.expires_at>advertising_command_now() OR NEW.encrypted_input IS NOT NULL THEN RAISE EXCEPTION 'advertising_original_expiry_invalid' USING ERRCODE='23514';END IF;
   ELSIF NEW.status NOT IN('succeeded','cancelled') OR NEW.created_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid
     OR NEW.expires_at<=advertising_command_now() THEN RAISE EXCEPTION 'advertising_original_transition_invalid' USING ERRCODE='23514';END IF;
   IF NEW.acknowledged_at IS NOT NULL THEN RAISE EXCEPTION 'advertising_original_ack_invalid' USING ERRCODE='23514';END IF;
   NEW.completed_at:=date_trunc('milliseconds',advertising_command_now());
  END IF;
  IF NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at THEN
   IF NEW.created_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid OR OLD.status='prepared' THEN
    RAISE EXCEPTION 'advertising_original_ack_invalid' USING ERRCODE='23514';END IF;
   NEW.acknowledged_at:=date_trunc('milliseconds',advertising_command_now());
  END IF;
  IF NEW.encrypted_input IS DISTINCT FROM OLD.encrypted_input THEN
   IF NEW.status NOT IN('cancelled','expired') AND NEW.acknowledged_at IS NULL AND NEW.expires_at>advertising_command_now() THEN
    RAISE EXCEPTION 'advertising_original_redaction_invalid' USING ERRCODE='23514';END IF;
   NEW.redacted_at:=date_trunc('milliseconds',advertising_command_now());
  END IF;
  IF NEW.status='succeeded' AND OLD.status='prepared' THEN
   SELECT * INTO p FROM advertising_original_write_proofs WHERE tenant_id=NEW.tenant_id AND kind=NEW.kind AND result_id=NEW.result_id;
   b:=ad_command_result_binding(NEW.kind,NEW.result_id);
   IF p.command_id IS DISTINCT FROM NEW.id OR p.creation_transaction_id IS DISTINCT FROM pg_current_xact_id()::text
    OR p.account_id IS DISTINCT FROM NEW.account_id OR p.actor_id IS DISTINCT FROM NEW.created_by OR p.request_key IS DISTINCT FROM NEW.request_key
    OR p.target_id IS DISTINCT FROM NEW.target_id OR p.scope_key IS DISTINCT FROM NEW.scope_key OR p.parent_id IS DISTINCT FROM NEW.parent_id OR p.version IS DISTINCT FROM NEW.version
    OR b IS NULL OR b->>'ownerInputChecksum' IS DISTINCT FROM NEW.owner_input_checksum
    OR NEW.kind<>'import_commit' AND p.owner_input_checksum IS DISTINCT FROM NEW.owner_input_checksum THEN
    RAISE EXCEPTION 'advertising_original_actual_result_missing' USING ERRCODE='23514';END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION require_advertising_command_audit() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE operation text;
BEGIN
 operation:=CASE WHEN TG_OP='INSERT' THEN 'prepare' WHEN NEW.status='succeeded' AND OLD.status='prepared' THEN 'execute'
  WHEN NEW.status='cancelled' AND OLD.status='prepared' THEN 'cancel' WHEN NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at THEN 'acknowledge' END;
 IF operation IS NOT NULL AND NOT EXISTS(SELECT 1 FROM audit_events a INNER JOIN advertising_command_audit_receipts ar ON ar.tenant_id=a.tenant_id AND ar.audit_id=a.id
   WHERE a.tenant_id=NEW.tenant_id AND a.actor_user_id=NEW.created_by AND a.entity_type='advertising_command' AND a.entity_id=NEW.id
    AND a.action='advertising.command.'||operation AND a.result='success' AND ar.creation_transaction_id=pg_current_xact_id()::text) THEN
  RAISE EXCEPTION 'advertising_original_atomic_audit_missing' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE FUNCTION guard_advertising_import_child() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE p advertising_original_write_proofs;batch uuid;account uuid;requested uuid:=ad_command_requested_id();
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid THEN
  RAISE EXCEPTION 'advertising_original_actor_invalid' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='ad_imports' THEN batch:=NEW.batch_id;account:=NEW.account_id;
 ELSE
  SELECT ai.batch_id,ai.account_id INTO batch,account FROM ad_imports ai WHERE ai.tenant_id=NEW.tenant_id AND ai.id=NEW.import_id;
 END IF;
 SELECT * INTO p FROM advertising_original_write_proofs WHERE tenant_id=NEW.tenant_id AND kind='import_commit' AND result_id=batch;
 IF p.account_id IS DISTINCT FROM account OR p.actor_id IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid
  OR p.creation_transaction_id IS DISTINCT FROM pg_current_xact_id()::text OR p.command_id IS DISTINCT FROM requested
  OR p.command_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM advertising_commands c WHERE c.tenant_id=p.tenant_id AND c.id=p.command_id AND c.status='prepared')
  OR ad_command_has_owner_audit('import_commit',p.actor_id,p.result_id,NULL,NULL) THEN
  RAISE EXCEPTION 'advertising_original_import_sealed' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='ad_imports' THEN
  IF NEW.created_by IS DISTINCT FROM p.actor_id THEN RAISE EXCEPTION 'advertising_original_actor_invalid' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION prohibit_advertising_original_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN RAISE EXCEPTION 'advertising_original_immutable' USING ERRCODE='23514';END $$;
--> statement-breakpoint
DO $$ DECLARE k text;table_name text;BEGIN
 FOREACH k IN ARRAY ARRAY['import_commit','goal_save','observation_record','analysis_run','action_transition','import_archive','export_seal'] LOOP
  table_name:=ad_command_table(k);
  EXECUTE format('CREATE TRIGGER a_advertising_original_admission BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION admit_advertising_original_owner(%L)',table_name,k);
  EXECUTE format('CREATE TRIGGER %I AFTER INSERT ON %I FOR EACH ROW EXECUTE FUNCTION mint_advertising_original_proof(%L)',table_name||'_advertising_proof',table_name,k);
 END LOOP;
 FOREACH table_name IN ARRAY ARRAY['advertising_commands','advertising_original_write_proofs','advertising_owner_mutation_evidence','advertising_command_audit_receipts'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
  EXECUTE format('CREATE POLICY %I ON %I USING(tenant_id=current_setting(''app.tenant_id'',true)::uuid) WITH CHECK(tenant_id=current_setting(''app.tenant_id'',true)::uuid)',table_name||'_tenant',table_name);
 END LOOP;
END $$;
CREATE TRIGGER advertising_commands_guard BEFORE INSERT OR UPDATE OR DELETE ON advertising_commands FOR EACH ROW EXECUTE FUNCTION guard_advertising_command();
CREATE TRIGGER advertising_original_proof_immutable BEFORE UPDATE OR DELETE ON advertising_original_write_proofs FOR EACH ROW EXECUTE FUNCTION prohibit_advertising_original_mutation();
CREATE TRIGGER advertising_owner_mutation_immutable BEFORE UPDATE OR DELETE ON advertising_owner_mutation_evidence FOR EACH ROW EXECUTE FUNCTION prohibit_advertising_original_mutation();
CREATE TRIGGER advertising_command_audit_receipt_immutable BEFORE UPDATE OR DELETE ON advertising_command_audit_receipts FOR EACH ROW EXECUTE FUNCTION prohibit_advertising_original_mutation();
CREATE TRIGGER ad_actions_original_mutation AFTER UPDATE ON ad_actions FOR EACH ROW EXECUTE FUNCTION capture_advertising_owner_mutation();
CREATE TRIGGER ad_imports_original_mutation AFTER UPDATE ON ad_imports FOR EACH ROW EXECUTE FUNCTION capture_advertising_owner_mutation();
CREATE TRIGGER audit_advertising_command_receipt AFTER INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION capture_advertising_command_audit();
CREATE TRIGGER a_advertising_import_open BEFORE INSERT ON ad_imports FOR EACH ROW EXECUTE FUNCTION guard_advertising_import_child();
CREATE TRIGGER a_advertising_import_open BEFORE INSERT ON ad_facts FOR EACH ROW EXECUTE FUNCTION guard_advertising_import_child();
CREATE CONSTRAINT TRIGGER advertising_original_outcome_closed AFTER INSERT ON advertising_original_write_proofs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_advertising_command_outcome();
CREATE CONSTRAINT TRIGGER advertising_original_mutation_closed AFTER INSERT ON advertising_owner_mutation_evidence DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_advertising_mutation_outcome();
CREATE CONSTRAINT TRIGGER advertising_original_audit_closed AFTER INSERT OR UPDATE ON advertising_commands DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_advertising_command_audit();
GRANT SELECT,INSERT,UPDATE ON advertising_commands TO yummyai_app;
GRANT SELECT ON advertising_original_write_proofs,advertising_owner_mutation_evidence,advertising_command_audit_receipts TO yummyai_app;
REVOKE ALL ON FUNCTION advertising_command_now(),ad_command_table(text),ad_command_requested_id(),ad_command_key_lock(text,uuid,uuid,text),ad_command_assert_request(text,uuid,uuid,text),
 ad_command_result_binding(text,uuid),capture_advertising_owner_mutation(),ad_command_event_class(jsonb),admit_advertising_original_owner(),
 mint_advertising_original_proof(),capture_advertising_command_audit(),ad_command_has_owner_audit(text,uuid,uuid,uuid,integer),
 require_advertising_mutation_outcome(),require_advertising_command_outcome(),guard_advertising_command(),require_advertising_command_audit(),
 guard_advertising_import_child(),prohibit_advertising_original_mutation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION advertising_command_now(),ad_command_table(text),ad_command_requested_id(),ad_command_key_lock(text,uuid,uuid,text),ad_command_assert_request(text,uuid,uuid,text),
 ad_command_result_binding(text,uuid),ad_command_event_class(jsonb),ad_command_has_owner_audit(text,uuid,uuid,uuid,integer) TO yummyai_app;
