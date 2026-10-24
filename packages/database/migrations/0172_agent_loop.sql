-- Independent bounded agent ABI. Legacy Assist/workflow rows and checksums stay unchanged.
CREATE TABLE agent_loop_runs (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES organizations(id),owner_id uuid NOT NULL REFERENCES app_users(id),request_id uuid NOT NULL,
 version text NOT NULL DEFAULT 'erp-agent-loop-v1',request_checksum text NOT NULL,input_checksum text NOT NULL,encrypted_input text,
 origin_ceiling jsonb NOT NULL,execution_contract jsonb NOT NULL,read_execution_contract jsonb NOT NULL,model_snapshot jsonb NOT NULL,
 allowed_tools jsonb NOT NULL,limits jsonb NOT NULL,budget_ledger_id uuid NOT NULL,cap_usd numeric(14,6) NOT NULL,
 known_cost_usd numeric(14,6) NOT NULL DEFAULT 0,unknown_cost integer NOT NULL DEFAULT 0,status text NOT NULL DEFAULT 'queued',revision integer NOT NULL DEFAULT 1,
 model_turns integer NOT NULL DEFAULT 0,tool_calls integer NOT NULL DEFAULT 0,observed_rows integer NOT NULL DEFAULT 0,
 lease_token uuid,lease_expires_at timestamptz,dispatch_count integer NOT NULL DEFAULT 0,last_dispatched_at timestamptz,next_attempt_at timestamptz NOT NULL DEFAULT now(),
 stop_requested_at timestamptz,encrypted_result text,result_checksum text,error_code text,creation_transaction_id text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,deadline_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,
 CONSTRAINT agent_loop_runs_tenant_id_unique UNIQUE(tenant_id,id),CONSTRAINT agent_loop_runs_request_unique UNIQUE(tenant_id,owner_id,request_id),
 CONSTRAINT agent_loop_runs_ledger_unique UNIQUE(tenant_id,budget_ledger_id),
 CONSTRAINT agent_loop_run_ledger_fk FOREIGN KEY(tenant_id,budget_ledger_id) REFERENCES ai_budget_ledger(tenant_id,id),
 CONSTRAINT agent_loop_runs_version_check CHECK(version='erp-agent-loop-v1'),
 CONSTRAINT agent_loop_runs_hash_check CHECK(request_checksum~'^[a-f0-9]{64}$' AND input_checksum~'^[a-f0-9]{64}$'),
 CONSTRAINT agent_loop_runs_status_check CHECK(status IN('queued','running','stopping','completed','partial','failed','uncertain','stopped','expired')),
 CONSTRAINT agent_loop_runs_count_check CHECK(revision>0 AND model_turns BETWEEN 0 AND 8 AND tool_calls BETWEEN 0 AND 32 AND observed_rows BETWEEN 0 AND 1000 AND dispatch_count>=0 AND unknown_cost IN(0,1)),
 CONSTRAINT agent_loop_runs_cost_check CHECK(cap_usd>0 AND known_cost_usd>=0),
 CONSTRAINT agent_loop_runs_lease_check CHECK((lease_token IS NULL)=(lease_expires_at IS NULL)),
 CONSTRAINT agent_loop_runs_result_check CHECK((encrypted_result IS NULL AND result_checksum IS NULL) OR(encrypted_result IS NOT NULL AND result_checksum~'^[a-f0-9]{64}$')),
 CONSTRAINT agent_loop_runs_time_check CHECK(deadline_at>created_at AND expires_at>deadline_at)
);
CREATE INDEX agent_loop_runs_owner_idx ON agent_loop_runs(tenant_id,owner_id,created_at);
CREATE INDEX agent_loop_runs_dispatch_idx ON agent_loop_runs(tenant_id,status,next_attempt_at);
--> statement-breakpoint
CREATE TABLE agent_loop_steps (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,run_id uuid NOT NULL,sequence integer NOT NULL,kind text NOT NULL,phase text NOT NULL DEFAULT 'preparing',
 label text NOT NULL,tool text,input_checksum text NOT NULL,previous_checksum text NOT NULL,encrypted_input text,
 submission_state text NOT NULL DEFAULT 'not_submitted',submitted_at timestamptz,received_at timestamptz,encrypted_response text,response_checksum text,provider_request_id text,
 input_tokens integer,output_tokens integer,cost_usd numeric(14,6),encrypted_output text,output_checksum text,error_code text,
 created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,
 CONSTRAINT agent_loop_steps_tenant_id_unique UNIQUE(tenant_id,id),CONSTRAINT agent_loop_steps_sequence_unique UNIQUE(tenant_id,run_id,sequence),
 CONSTRAINT agent_loop_step_run_fk FOREIGN KEY(tenant_id,run_id) REFERENCES agent_loop_runs(tenant_id,id),
 CONSTRAINT agent_loop_steps_sequence_check CHECK(sequence BETWEEN 1 AND 16),
 CONSTRAINT agent_loop_steps_kind_check CHECK((kind='model' AND tool IS NULL) OR(kind='read' AND tool IN('orders.exceptions.page','inventory.balances.page'))),
 CONSTRAINT agent_loop_steps_phase_check CHECK(phase IN('preparing','submitted','response_ready','completed','failed','uncertain')),
 CONSTRAINT agent_loop_steps_hash_check CHECK(input_checksum~'^[a-f0-9]{64}$' AND previous_checksum~'^[a-f0-9]{64}$'),
 CONSTRAINT agent_loop_steps_submission_check CHECK(submission_state IN('not_submitted','submitted','received') AND(kind='model' OR submission_state='not_submitted')),
 CONSTRAINT agent_loop_steps_response_check CHECK(encrypted_response IS NULL OR(kind='model' AND submission_state='received' AND received_at IS NOT NULL AND response_checksum~'^[a-f0-9]{64}$')),
 CONSTRAINT agent_loop_steps_output_check CHECK((encrypted_output IS NULL OR output_checksum IS NOT NULL) AND(output_checksum IS NULL OR output_checksum~'^[a-f0-9]{64}$')),
 CONSTRAINT agent_loop_steps_usage_check CHECK((input_tokens IS NULL OR input_tokens>=0) AND(output_tokens IS NULL OR output_tokens>=0) AND(cost_usd IS NULL OR cost_usd>=0)),
 CONSTRAINT agent_loop_steps_label_check CHECK(length(label) BETWEEN 1 AND 160 AND(provider_request_id IS NULL OR length(provider_request_id)<=512))
);
--> statement-breakpoint
ALTER TABLE agent_loop_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_loop_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_loop_runs_tenant_policy ON agent_loop_runs FOR ALL TO yummyai_app
 USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid))
 WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
GRANT SELECT,INSERT,UPDATE ON agent_loop_runs TO yummyai_app;
ALTER TABLE agent_loop_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_loop_steps FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_loop_steps_tenant_policy ON agent_loop_steps FOR ALL TO yummyai_app
 USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid))
 WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
GRANT SELECT,INSERT,UPDATE ON agent_loop_steps TO yummyai_app;
--> statement-breakpoint
CREATE FUNCTION agent_loop_require_member(parent agent_loop_runs,needs_domains boolean) RETURNS void
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE permission_bit text;needed integer;required_bits text[]:=ARRAY['workflow:read','workflow:run'];
BEGIN
 IF parent.tenant_id::text IS DISTINCT FROM current_setting('app.tenant_id',true)
  OR parent.owner_id::text IS DISTINCT FROM current_setting('app.user_id',true) THEN
  RAISE EXCEPTION 'agent_identity_invalid' USING ERRCODE='23514';END IF;
 -- Lock actual membership grants; a caller's aggregate scope is never authority.
 PERFORM 1 FROM memberships m JOIN membership_roles mr ON mr.tenant_id=m.tenant_id AND mr.membership_id=m.id
  JOIN roles r ON r.tenant_id=mr.tenant_id AND r.id=mr.role_id WHERE m.tenant_id=parent.tenant_id AND m.user_id=parent.owner_id
  ORDER BY m.id,mr.role_id FOR SHARE OF m,mr,r;
 IF needs_domains THEN
  FOR permission_bit IN SELECT CASE x WHEN 'orders.exceptions.page' THEN 'order:read' ELSE 'inventory:read' END FROM jsonb_array_elements_text(parent.allowed_tools) x LOOP
   required_bits:=array_append(required_bits,permission_bit);
  END LOOP;
 ELSE required_bits:=ARRAY['workflow:run'];END IF;
 FOREACH permission_bit IN ARRAY required_bits LOOP
  needed:=(CASE WHEN permission_bit LIKE 'workflow:%' THEN 1 ELSE 3 END);
  IF integration_client_permission_rank(parent.tenant_id,parent.owner_id,permission_bit)<needed
   OR NOT(parent.origin_ceiling->'permissions'?permission_bit)
   OR(needed=3 AND coalesce(parent.origin_ceiling->'permissionScopes'->>permission_bit,parent.origin_ceiling->>'dataScope') IS DISTINCT FROM 'tenant') THEN
   RAISE EXCEPTION 'agent_member_scope_invalid' USING ERRCODE='23514';END IF;
 END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION guard_agent_loop_run() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE ledger ai_budget_ledger%ROWTYPE;item text;
 dispatch_fields text[]:=ARRAY['dispatch_count','last_dispatched_at','next_attempt_at','updated_at','revision'];
 private_fields text[]:=ARRAY['encrypted_input','encrypted_result','result_checksum','updated_at','revision'];
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'agent_history_immutable' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.version<>'erp-agent-loop-v1' OR NEW.encrypted_input IS NULL OR NEW.status<>'queued' OR NEW.model_turns<>0 OR NEW.tool_calls<>0 OR NEW.observed_rows<>0
   OR NEW.known_cost_usd<>0 OR NEW.unknown_cost<>0 OR NEW.lease_token IS NOT NULL OR NEW.encrypted_result IS NOT NULL OR NEW.error_code IS NOT NULL
   OR NEW.stop_requested_at IS NOT NULL OR NEW.completed_at IS NOT NULL OR NEW.dispatch_count<>0 OR NEW.revision<>1
   OR NEW.origin_ceiling->>'tenantId' IS DISTINCT FROM NEW.tenant_id::text OR NEW.origin_ceiling->>'userId' IS DISTINCT FROM NEW.owner_id::text
   OR jsonb_typeof(NEW.allowed_tools) IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.allowed_tools) NOT BETWEEN 1 AND 2
   OR(SELECT count(*)<>count(DISTINCT x) FROM jsonb_array_elements_text(NEW.allowed_tools) x)
   OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(NEW.allowed_tools) x WHERE x NOT IN('orders.exceptions.page','inventory.balances.page'))
   OR NEW.execution_contract->>'executorKey' IS DISTINCT FROM 'erp.agent.loop' OR NEW.execution_contract->'skill'->>'version' IS DISTINCT FROM 'erp-agent-loop-v1'
   OR NEW.read_execution_contract->>'executorKey' IS DISTINCT FROM 'erp.agent.read'
   OR(NEW.limits->>'maxModelTurns')::integer NOT BETWEEN 2 AND 8 OR(NEW.limits->>'maxToolCalls')::integer NOT BETWEEN 2 AND 32
   OR(NEW.limits->>'maxRows')::integer NOT BETWEEN 1 AND 1000 OR(NEW.limits->>'maxOutputTokens')::integer NOT BETWEEN 128 AND 4096
   OR(NEW.limits->>'maxPromptBytes')::integer NOT BETWEEN 4096 AND 1048576 OR(NEW.limits->>'deadlineSeconds')::integer NOT BETWEEN 30 AND 600
   OR NEW.deadline_at>clock_timestamp()+interval '601 seconds' OR NEW.expires_at>clock_timestamp()+interval '1 day 1 second' THEN
   RAISE EXCEPTION 'agent_birth_invalid' USING ERRCODE='23514';END IF;
  IF jsonb_typeof(NEW.limits) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'agent_limits_invalid' USING ERRCODE='23514';END IF;
  IF(SELECT count(*) FROM jsonb_object_keys(NEW.limits))<>6 THEN RAISE EXCEPTION 'agent_limits_invalid' USING ERRCODE='23514';END IF;
  FOREACH item IN ARRAY ARRAY['maxModelTurns','maxToolCalls','maxRows','maxOutputTokens','maxPromptBytes','deadlineSeconds'] LOOP
   IF jsonb_typeof(NEW.limits->item) IS DISTINCT FROM 'number' OR(NEW.limits->>item)::numeric<>trunc((NEW.limits->>item)::numeric) THEN
    RAISE EXCEPTION 'agent_limits_invalid' USING ERRCODE='23514';END IF;
  END LOOP;
  PERFORM agent_loop_require_member(NEW,true);
  SELECT * INTO ledger FROM ai_budget_ledger WHERE tenant_id=NEW.tenant_id AND id=NEW.budget_ledger_id FOR UPDATE;
  IF NOT FOUND OR ledger.request_id<>NEW.id OR ledger.task_type<>'erp_agent' OR ledger.state<>'reserved' OR ledger.amount_usd<>NEW.cap_usd
   OR ledger.model_key IS DISTINCT FROM NEW.model_snapshot->>'model'
   OR NOT EXISTS(SELECT 1 FROM ai_budget_ledger l WHERE l.id=ledger.id AND l.tenant_id=NEW.tenant_id AND l.xmin::text=(pg_current_xact_id()::text::numeric%4294967296)::text) THEN
   RAISE EXCEPTION 'agent_original_budget_required' USING ERRCODE='23514';END IF;
  NEW.creation_transaction_id:=pg_current_xact_id()::text;RETURN NEW;
 END IF;
 IF (to_jsonb(NEW)-ARRAY['status','revision','known_cost_usd','unknown_cost','model_turns','tool_calls','observed_rows','lease_token','lease_expires_at',
  'dispatch_count','last_dispatched_at','next_attempt_at','stop_requested_at','encrypted_input','encrypted_result','result_checksum','error_code','updated_at','completed_at'])
  IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['status','revision','known_cost_usd','unknown_cost','model_turns','tool_calls','observed_rows','lease_token','lease_expires_at',
  'dispatch_count','last_dispatched_at','next_attempt_at','stop_requested_at','encrypted_input','encrypted_result','result_checksum','error_code','updated_at','completed_at']) THEN
  RAISE EXCEPTION 'agent_pin_immutable' USING ERRCODE='23514';END IF;
 IF NEW.revision NOT IN(OLD.revision,OLD.revision+1) OR NEW.dispatch_count<OLD.dispatch_count
  OR NEW.model_turns<OLD.model_turns OR NEW.tool_calls<OLD.tool_calls OR NEW.observed_rows<OLD.observed_rows OR NEW.known_cost_usd<OLD.known_cost_usd
  OR(OLD.stop_requested_at IS NOT NULL AND NEW.stop_requested_at IS DISTINCT FROM OLD.stop_requested_at) THEN
  RAISE EXCEPTION 'agent_progress_monotone' USING ERRCODE='23514';END IF;
 NEW.revision:=OLD.revision+1;
 -- The dispatcher has no business identity. It may only alter discoverability metadata.
 IF(to_jsonb(NEW)-dispatch_fields) IS NOT DISTINCT FROM(to_jsonb(OLD)-dispatch_fields) THEN RETURN NEW;END IF;
 IF OLD.expires_at<=clock_timestamp() AND NEW.encrypted_input IS NULL AND NEW.encrypted_result IS NULL AND NEW.result_checksum IS NULL
  AND(to_jsonb(NEW)-private_fields) IS NOT DISTINCT FROM(to_jsonb(OLD)-private_fields) THEN RETURN NEW;END IF;
 IF OLD.owner_id::text IS DISTINCT FROM current_setting('app.user_id',true) THEN RAISE EXCEPTION 'agent_owner_required' USING ERRCODE='23514';END IF;
 IF OLD.status IN('completed','partial','failed','uncertain','stopped','expired') THEN RAISE EXCEPTION 'agent_terminal_immutable' USING ERRCODE='23514';END IF;
 IF NEW.encrypted_input IS DISTINCT FROM OLD.encrypted_input THEN RAISE EXCEPTION 'agent_input_immutable' USING ERRCODE='23514';END IF;
 IF OLD.encrypted_result IS NOT NULL AND(NEW.encrypted_result IS DISTINCT FROM OLD.encrypted_result OR NEW.result_checksum IS DISTINCT FROM OLD.result_checksum) THEN
  RAISE EXCEPTION 'agent_result_immutable' USING ERRCODE='23514';END IF;
 IF(OLD.encrypted_result IS NULL AND NEW.encrypted_result IS NOT NULL) OR NEW.status='completed' THEN
  PERFORM agent_loop_require_member(OLD,true);
  IF OLD.stop_requested_at IS NOT NULL OR NEW.stop_requested_at IS NOT NULL OR OLD.deadline_at<=clock_timestamp()
   OR OLD.lease_token IS NULL OR OLD.lease_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'agent_result_adoption_invalid' USING ERRCODE='23514';END IF;
 END IF;
 IF OLD.stop_requested_at IS NULL AND NEW.stop_requested_at IS NOT NULL THEN
  PERFORM agent_loop_require_member(OLD,false);
  IF NEW.status<>'stopping' OR NEW.lease_token IS DISTINCT FROM OLD.lease_token OR NEW.lease_expires_at IS DISTINCT FROM OLD.lease_expires_at THEN
   RAISE EXCEPTION 'agent_stop_invalid' USING ERRCODE='23514';END IF;
 END IF;
 IF NEW.status='queued' AND OLD.status<>'queued' OR OLD.stop_requested_at IS NOT NULL AND NEW.status IN('queued','running') THEN
  RAISE EXCEPTION 'agent_state_invalid' USING ERRCODE='23514';END IF;
 IF NEW.model_turns>(NEW.limits->>'maxModelTurns')::integer OR NEW.tool_calls>(NEW.limits->>'maxToolCalls')::integer
  OR NEW.observed_rows>(NEW.limits->>'maxRows')::integer THEN RAISE EXCEPTION 'agent_bound_exceeded' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER agent_loop_run_guard BEFORE INSERT OR UPDATE OR DELETE ON agent_loop_runs FOR EACH ROW EXECUTE FUNCTION guard_agent_loop_run();
--> statement-breakpoint
CREATE FUNCTION guard_agent_loop_step() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE parent agent_loop_runs%ROWTYPE;prior agent_loop_steps%ROWTYPE;n integer;
 private_fields text[]:=ARRAY['encrypted_input','encrypted_output','encrypted_response'];
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'agent_history_immutable' USING ERRCODE='23514';END IF;
 SELECT * INTO parent FROM agent_loop_runs WHERE tenant_id=NEW.tenant_id AND id=NEW.run_id FOR UPDATE;
 IF NOT FOUND OR parent.owner_id::text IS DISTINCT FROM current_setting('app.user_id',true) THEN RAISE EXCEPTION 'agent_owner_required' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' AND parent.expires_at<=clock_timestamp() AND NEW.encrypted_input IS NULL AND NEW.encrypted_output IS NULL AND NEW.encrypted_response IS NULL
  AND(to_jsonb(NEW)-private_fields) IS NOT DISTINCT FROM(to_jsonb(OLD)-private_fields) THEN RETURN NEW;END IF;
 IF parent.status NOT IN('running','stopping') OR parent.lease_token IS NULL OR parent.lease_expires_at<=clock_timestamp() THEN
  RAISE EXCEPTION 'agent_live_lease_required' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' THEN
  PERFORM agent_loop_require_member(parent,true);
  SELECT count(*) INTO n FROM agent_loop_steps WHERE tenant_id=NEW.tenant_id AND run_id=NEW.run_id;
  IF n>0 THEN SELECT * INTO prior FROM agent_loop_steps WHERE tenant_id=NEW.tenant_id AND run_id=NEW.run_id ORDER BY sequence DESC LIMIT 1;END IF;
  IF parent.stop_requested_at IS NOT NULL OR parent.deadline_at<=clock_timestamp() OR parent.expires_at<=clock_timestamp()
   OR NEW.sequence<>n+1 OR n>=15 OR NEW.kind<>(CASE WHEN n%2=0 THEN 'model' ELSE 'read' END)
   OR(n>0 AND(prior.phase<>'completed' OR NEW.previous_checksum IS DISTINCT FROM prior.output_checksum))
   OR(n=0 AND NEW.previous_checksum<>parent.input_checksum) OR NEW.phase<>'preparing' OR NEW.encrypted_input IS NULL
   OR NEW.submission_state<>'not_submitted' OR NEW.submitted_at IS NOT NULL OR NEW.received_at IS NOT NULL OR NEW.encrypted_response IS NOT NULL
   OR NEW.encrypted_output IS NOT NULL OR NEW.cost_usd IS NOT NULL OR NEW.completed_at IS NOT NULL OR NEW.error_code IS NOT NULL
   OR(NEW.kind='read' AND NOT(parent.allowed_tools?NEW.tool)) THEN RAISE EXCEPTION 'agent_step_birth_invalid' USING ERRCODE='23514';END IF;
  RETURN NEW;
 END IF;
 IF(to_jsonb(NEW)-ARRAY['phase','submission_state','submitted_at','received_at','encrypted_response','response_checksum','provider_request_id','input_tokens','output_tokens','cost_usd','encrypted_output','output_checksum','error_code','completed_at'])
  IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['phase','submission_state','submitted_at','received_at','encrypted_response','response_checksum','provider_request_id','input_tokens','output_tokens','cost_usd','encrypted_output','output_checksum','error_code','completed_at']) THEN
  RAISE EXCEPTION 'agent_step_input_immutable' USING ERRCODE='23514';END IF;
 IF OLD.phase IN('completed','failed','uncertain') AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'agent_step_terminal_immutable' USING ERRCODE='23514';END IF;
 IF OLD.submission_state='received' AND(NEW.submission_state<>'received'
  OR ROW(NEW.received_at,NEW.encrypted_response,NEW.response_checksum,NEW.provider_request_id,NEW.input_tokens,NEW.output_tokens,NEW.cost_usd)
   IS DISTINCT FROM ROW(OLD.received_at,OLD.encrypted_response,OLD.response_checksum,OLD.provider_request_id,OLD.input_tokens,OLD.output_tokens,OLD.cost_usd))
  OR OLD.submission_state='submitted' AND NEW.submission_state='not_submitted'
  OR OLD.submitted_at IS NOT NULL AND NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN RAISE EXCEPTION 'agent_response_immutable' USING ERRCODE='23514';END IF;
 IF OLD.submission_state='not_submitted' AND NEW.submission_state<>'not_submitted' THEN
  PERFORM agent_loop_require_member(parent,true);
  IF NEW.submission_state<>'submitted' OR NEW.phase<>'submitted' OR NEW.submitted_at IS NULL OR parent.stop_requested_at IS NOT NULL
   OR parent.deadline_at<=clock_timestamp() OR parent.unknown_cost<>0 OR parent.known_cost_usd>=parent.cap_usd THEN
   RAISE EXCEPTION 'agent_submit_invalid' USING ERRCODE='23514';END IF;
 END IF;
 IF OLD.submission_state='submitted' AND NEW.submission_state='received' AND(NEW.encrypted_response IS NULL OR NEW.response_checksum IS NULL OR NEW.received_at IS NULL) THEN
  RAISE EXCEPTION 'agent_response_checkpoint_required' USING ERRCODE='23514';END IF;
 IF NEW.phase='completed' AND(NEW.encrypted_output IS NULL OR NEW.output_checksum IS NULL OR NEW.completed_at IS NULL
  OR NEW.kind='model' AND(NEW.submission_state<>'received' OR NEW.encrypted_response IS NULL OR NEW.cost_usd IS NULL)) THEN
  RAISE EXCEPTION 'agent_completed_checkpoint_required' USING ERRCODE='23514';END IF;
 IF NEW.phase='completed' AND OLD.phase<>'completed' THEN
  PERFORM agent_loop_require_member(parent,true);
  IF parent.stop_requested_at IS NOT NULL OR parent.deadline_at<=clock_timestamp() THEN RAISE EXCEPTION 'agent_step_adoption_invalid' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER agent_loop_step_guard BEFORE INSERT OR UPDATE OR DELETE ON agent_loop_steps FOR EACH ROW EXECUTE FUNCTION guard_agent_loop_step();
--> statement-breakpoint
CREATE FUNCTION require_agent_loop_closure() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE parent agent_loop_runs%ROWTYPE;ledger ai_budget_ledger%ROWTYPE;born text:=pg_current_xact_id()::text;
 own_xmin text:=(pg_current_xact_id()::text::numeric%4294967296)::text;known numeric;submitted integer;models integer;unknown boolean;
BEGIN
 IF TG_TABLE_NAME='ai_budget_ledger' THEN
  SELECT * INTO parent FROM agent_loop_runs WHERE tenant_id=NEW.tenant_id AND budget_ledger_id=NEW.id;
 ELSIF TG_TABLE_NAME='agent_loop_steps' THEN SELECT * INTO parent FROM agent_loop_runs WHERE tenant_id=NEW.tenant_id AND id=NEW.run_id;
 ELSE SELECT * INTO parent FROM agent_loop_runs WHERE tenant_id=NEW.tenant_id AND id=NEW.id;END IF;
 IF parent.id IS NULL THEN RAISE EXCEPTION 'agent_original_run_required' USING ERRCODE='23514';END IF;
 SELECT * INTO ledger FROM ai_budget_ledger WHERE tenant_id=parent.tenant_id AND id=parent.budget_ledger_id;
 IF parent.creation_transaction_id=born THEN
  IF NOT EXISTS(SELECT 1 FROM ai_budget_ledger l WHERE l.id=ledger.id AND l.tenant_id=parent.tenant_id AND l.xmin::text=own_xmin) OR ledger.request_id<>parent.id OR ledger.task_type<>'erp_agent'
   OR ledger.state<>'reserved' OR ledger.amount_usd<>parent.cap_usd
   OR(SELECT count(*) FROM audit_events a WHERE a.tenant_id=parent.tenant_id AND a.actor_user_id=parent.owner_id
    AND a.entity_type='agent_loop_run' AND a.entity_id=parent.id AND a.action='agent.loop.create' AND a.result='success' AND a.xmin::text=own_xmin
    AND a.metadata->>'requestChecksum'=parent.request_checksum AND a.metadata->>'inputChecksum'=parent.input_checksum
    AND a.metadata->>'budgetLedgerId'=ledger.id::text)<>1 THEN RAISE EXCEPTION 'agent_birth_audit_required' USING ERRCODE='23514';END IF;
 END IF;
 IF TG_TABLE_NAME='agent_loop_runs' THEN
  IF TG_OP='UPDATE' THEN
   IF OLD.stop_requested_at IS NULL AND NEW.stop_requested_at IS NOT NULL THEN
    IF NOT EXISTS(SELECT 1 FROM audit_events a WHERE a.tenant_id=parent.tenant_id AND a.actor_user_id=parent.owner_id AND a.entity_type='agent_loop_run'
     AND a.entity_id=parent.id AND a.action='agent.loop.stop' AND a.result='success' AND a.xmin::text=own_xmin AND a.metadata->>'requestChecksum'=parent.request_checksum) THEN
     RAISE EXCEPTION 'agent_stop_audit_required' USING ERRCODE='23514';END IF;
   END IF;
  END IF;
 END IF;
 SELECT coalesce(sum(cost_usd) FILTER(WHERE submission_state='received'),0),count(*) FILTER(WHERE submission_state<>'not_submitted'),count(*),
  coalesce(bool_or(submission_state<>'not_submitted' AND(submission_state<>'received' OR cost_usd IS NULL)),false)
  INTO known,submitted,models,unknown FROM agent_loop_steps WHERE tenant_id=parent.tenant_id AND run_id=parent.id AND kind='model';
 IF parent.model_turns<>models OR parent.known_cost_usd<>known THEN RAISE EXCEPTION 'agent_step_totals_invalid' USING ERRCODE='23514';END IF;
 IF parent.status='completed' AND(parent.encrypted_result IS NULL OR parent.result_checksum IS NULL OR models=0
  OR NOT EXISTS(SELECT 1 FROM agent_loop_steps s WHERE s.tenant_id=parent.tenant_id AND s.run_id=parent.id AND s.kind='model'
   AND s.phase='completed' AND s.submission_state='received' AND s.response_checksum IS NOT NULL AND s.output_checksum IS NOT NULL
   AND s.cost_usd IS NOT NULL AND s.sequence=(SELECT max(x.sequence) FROM agent_loop_steps x WHERE x.tenant_id=parent.tenant_id AND x.run_id=parent.id)))
  AND parent.expires_at>clock_timestamp() THEN RAISE EXCEPTION 'agent_completion_evidence_required' USING ERRCODE='23514';END IF;
 IF parent.status IN('completed','partial','failed','uncertain','stopped','expired') THEN
  IF parent.unknown_cost<>(CASE WHEN unknown THEN 1 ELSE 0 END)
   OR unknown AND(ledger.state<>'reserved' OR ledger.amount_usd<>parent.cap_usd)
   OR NOT unknown AND submitted=0 AND ledger.state<>'released'
   OR NOT unknown AND submitted>0 AND(ledger.state<>'committed' OR ledger.amount_usd<>known) THEN
   RAISE EXCEPTION 'agent_terminal_budget_invalid' USING ERRCODE='23514';END IF;
 ELSIF ledger.state<>'reserved' OR ledger.amount_usd<>parent.cap_usd THEN RAISE EXCEPTION 'agent_active_budget_required' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER agent_loop_run_closure AFTER INSERT OR UPDATE ON agent_loop_runs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_agent_loop_closure();
CREATE CONSTRAINT TRIGGER agent_loop_step_closure AFTER INSERT OR UPDATE ON agent_loop_steps DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_agent_loop_closure();
CREATE CONSTRAINT TRIGGER agent_loop_budget_birth AFTER INSERT ON ai_budget_ledger DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.task_type='erp_agent') EXECUTE FUNCTION require_agent_loop_closure();
--> statement-breakpoint
-- Add a narrow guard alongside the historical global settlement guard.
CREATE FUNCTION protect_agent_loop_budget() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE parent agent_loop_runs%ROWTYPE;known numeric;submitted integer;unknown boolean;
BEGIN
 IF OLD.task_type<>'erp_agent' THEN RETURN NEW;END IF;
 IF NEW.state=OLD.state AND NEW.amount_usd=OLD.amount_usd THEN RETURN NEW;END IF;
 SELECT * INTO parent FROM agent_loop_runs WHERE tenant_id=OLD.tenant_id AND id=OLD.request_id AND budget_ledger_id=OLD.id FOR UPDATE;
 SELECT coalesce(sum(cost_usd) FILTER(WHERE submission_state='received'),0),count(*) FILTER(WHERE submission_state<>'not_submitted'),
  coalesce(bool_or(submission_state<>'not_submitted' AND(submission_state<>'received' OR cost_usd IS NULL)),false)
  INTO known,submitted,unknown FROM agent_loop_steps WHERE tenant_id=OLD.tenant_id AND run_id=OLD.request_id AND kind='model';
 IF parent.id IS NULL OR parent.status NOT IN('completed','partial','failed','uncertain','stopped','expired') OR unknown
  OR(submitted=0 AND(NEW.state<>'released' OR NEW.amount_usd<>parent.cap_usd))
  OR(submitted>0 AND(NEW.state<>'committed' OR NEW.amount_usd<>known)) THEN RAISE EXCEPTION 'agent_budget_settlement_invalid' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER agent_loop_budget_guard BEFORE UPDATE ON ai_budget_ledger FOR EACH ROW EXECUTE FUNCTION protect_agent_loop_budget();
--> statement-breakpoint
CREATE FUNCTION guard_agent_loop_audit() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE parent agent_loop_runs%ROWTYPE;own_xmin text:=(pg_current_xact_id()::text::numeric%4294967296)::text;
BEGIN
 SELECT * INTO parent FROM agent_loop_runs WHERE tenant_id=NEW.tenant_id AND id=NEW.entity_id;
 IF parent.id IS NULL OR NEW.entity_type<>'agent_loop_run' OR NEW.actor_user_id IS DISTINCT FROM parent.owner_id OR NEW.result<>'success'
  OR NEW.actor_user_id::text IS DISTINCT FROM current_setting('app.user_id',true) OR NEW.metadata->>'requestChecksum' IS DISTINCT FROM parent.request_checksum THEN
  RAISE EXCEPTION 'agent_audit_identity_invalid' USING ERRCODE='23514';END IF;
 IF NEW.action='agent.loop.create' THEN
  IF parent.creation_transaction_id IS DISTINCT FROM pg_current_xact_id()::text OR NEW.metadata->>'inputChecksum' IS DISTINCT FROM parent.input_checksum
   OR NEW.metadata->>'budgetLedgerId' IS DISTINCT FROM parent.budget_ledger_id::text THEN RAISE EXCEPTION 'agent_audit_birth_invalid' USING ERRCODE='23514';END IF;
 ELSIF NEW.action='agent.loop.stop' THEN
  IF parent.stop_requested_at IS NULL OR parent.stop_requested_at<transaction_timestamp()
   OR NOT EXISTS(SELECT 1 FROM agent_loop_runs r WHERE r.tenant_id=parent.tenant_id AND r.id=parent.id AND r.xmin::text=own_xmin) THEN
   RAISE EXCEPTION 'agent_audit_stop_invalid' USING ERRCODE='23514';END IF;
 ELSE RAISE EXCEPTION 'agent_audit_action_invalid' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER agent_loop_audit_guard BEFORE INSERT ON audit_events FOR EACH ROW WHEN(NEW.action LIKE 'agent.loop.%') EXECUTE FUNCTION guard_agent_loop_audit();
