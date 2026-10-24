-- Independent native ABI on the original durable parent/fee/item tables.
-- Old174 run/step guard bodies, ledger task type, audit and slot algorithms stay unchanged.
ALTER TABLE agent_plan_runs DROP CONSTRAINT agent_plan_runs_version_check;
ALTER TABLE agent_plan_runs ADD CONSTRAINT agent_plan_runs_version_check CHECK(version IN('erp-agent-plan-v1','erp-agent-native-v1'));
ALTER TABLE agent_plan_runs DROP CONSTRAINT agent_plan_runs_count_check;
ALTER TABLE agent_plan_runs ADD CONSTRAINT agent_plan_runs_count_check CHECK(revision>0 AND model_turns BETWEEN 0 AND (CASE WHEN version='erp-agent-native-v1' THEN 16 ELSE 8 END) AND tool_calls BETWEEN 0 AND 32 AND observed_rows BETWEEN 0 AND (CASE WHEN version='erp-agent-native-v1' THEN 10000 ELSE 1000 END) AND dispatch_count>=0 AND unknown_cost IN(0,1));
ALTER TABLE agent_plan_steps DROP CONSTRAINT agent_plan_steps_sequence_check;
ALTER TABLE agent_plan_steps ADD CONSTRAINT agent_plan_steps_sequence_check CHECK(sequence BETWEEN 1 AND 32);
ALTER TABLE agent_plan_steps DROP CONSTRAINT agent_plan_steps_kind_check;
ALTER TABLE agent_plan_steps ADD CONSTRAINT agent_plan_steps_kind_check CHECK((kind='model' AND tool IS NULL) OR (kind='definition' AND (tool IS NULL OR tool IN('orders.exceptions.page','inventory.balances.page','knowledge.search','creative.history','factory.capacity'))) OR (kind='read' AND tool IN('orders.exceptions.page','inventory.balances.page','knowledge.search','creative.history','factory.capacity')));
--> statement-breakpoint
CREATE FUNCTION agent_native_plan_require_member(parent agent_plan_runs,needs_domains boolean) RETURNS void
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE permission_bit text;needed integer;domain_item jsonb;required_bits text[]:=ARRAY['workflow:read','workflow:run'];
BEGIN
 IF parent.tenant_id::text IS DISTINCT FROM current_setting('app.tenant_id',true)
  OR parent.owner_id::text IS DISTINCT FROM current_setting('app.user_id',true) THEN
  RAISE EXCEPTION 'agent_identity_invalid' USING ERRCODE='23514';END IF;
 -- Lock actual membership grants; a caller's aggregate scope is never authority.
 PERFORM 1 FROM memberships m JOIN membership_roles mr ON mr.tenant_id=m.tenant_id AND mr.membership_id=m.id
  JOIN roles r ON r.tenant_id=mr.tenant_id AND r.id=mr.role_id WHERE m.tenant_id=parent.tenant_id AND m.user_id=parent.owner_id
  ORDER BY m.id,mr.role_id FOR SHARE OF m,mr,r;
 IF needs_domains THEN
  FOR permission_bit IN SELECT CASE x WHEN 'orders.exceptions.page' THEN 'order:read' WHEN 'factory.capacity' THEN 'order:read' WHEN 'inventory.balances.page' THEN 'inventory:read' WHEN 'creative.history' THEN 'design:read' WHEN 'knowledge.search' THEN 'workflow:read' ELSE 'agent:invalid' END FROM jsonb_array_elements_text(parent.allowed_reads) x LOOP
   required_bits:=array_append(required_bits,permission_bit);
  END LOOP;
  IF parent.allowed_reads?'creative.history' THEN required_bits:=array_append(required_bits,'asset:read');END IF;
  FOR domain_item IN SELECT x FROM jsonb_array_elements(parent.allowed_commands) x LOOP
   CASE domain_item->>'domain'
    WHEN 'procurement' THEN required_bits:=array_append(required_bits,'procurement:read');
    WHEN 'incoming' THEN required_bits:=required_bits||ARRAY['procurement:read','inventory:read'];
    WHEN 'production' THEN required_bits:=required_bits||ARRAY['order:read','order:pii:read'];
    WHEN 'finance' THEN required_bits:=array_append(required_bits,'finance:read');
    WHEN 'advertising' THEN required_bits:=array_append(required_bits,'customer_intelligence:read');
    ELSE RAISE EXCEPTION 'agent_plan_command_invalid' USING ERRCODE='23514';END CASE;
  END LOOP;
 ELSE required_bits:=ARRAY['workflow:run'];END IF;
 FOREACH permission_bit IN ARRAY required_bits LOOP
  needed:=CASE WHEN permission_bit IN('order:read','order:pii:read','finance:read') OR(permission_bit='inventory:read' AND parent.allowed_reads?'inventory.balances.page') THEN 3 ELSE 1 END;
  IF integration_client_permission_rank(parent.tenant_id,parent.owner_id,permission_bit)<needed
   OR NOT(parent.origin_ceiling->'permissions'?permission_bit)
   OR(needed=3 AND coalesce(parent.origin_ceiling->'permissionScopes'->>permission_bit,parent.origin_ceiling->>'dataScope') IS DISTINCT FROM 'tenant') THEN
   RAISE EXCEPTION 'agent_member_scope_invalid' USING ERRCODE='23514';END IF;
 END LOOP;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION agent_plan_require_member(parent agent_plan_runs,needs_domains boolean) RETURNS void
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE permission_bit text;needed integer;domain_item jsonb;required_bits text[]:=ARRAY['workflow:read','workflow:run'];
BEGIN
 IF parent.version='erp-agent-native-v1' THEN PERFORM agent_native_plan_require_member(parent,needs_domains);RETURN;END IF;
 IF parent.tenant_id::text IS DISTINCT FROM current_setting('app.tenant_id',true)
  OR parent.owner_id::text IS DISTINCT FROM current_setting('app.user_id',true) THEN
  RAISE EXCEPTION 'agent_identity_invalid' USING ERRCODE='23514';END IF;
 -- Lock actual membership grants; a caller's aggregate scope is never authority.
 PERFORM 1 FROM memberships m JOIN membership_roles mr ON mr.tenant_id=m.tenant_id AND mr.membership_id=m.id
  JOIN roles r ON r.tenant_id=mr.tenant_id AND r.id=mr.role_id WHERE m.tenant_id=parent.tenant_id AND m.user_id=parent.owner_id
  ORDER BY m.id,mr.role_id FOR SHARE OF m,mr,r;
 IF needs_domains THEN
  FOR permission_bit IN SELECT CASE x WHEN 'orders.exceptions.page' THEN 'order:read' ELSE 'inventory:read' END FROM jsonb_array_elements_text(parent.allowed_reads) x LOOP
   required_bits:=array_append(required_bits,permission_bit);
  END LOOP;
  FOR domain_item IN SELECT x FROM jsonb_array_elements(parent.allowed_commands) x LOOP
   CASE domain_item->>'domain'
    WHEN 'procurement' THEN required_bits:=array_append(required_bits,'procurement:read');
    WHEN 'incoming' THEN required_bits:=required_bits||ARRAY['procurement:read','inventory:read'];
    WHEN 'production' THEN required_bits:=required_bits||ARRAY['order:read','order:pii:read'];
    WHEN 'finance' THEN required_bits:=array_append(required_bits,'finance:read');
    WHEN 'advertising' THEN required_bits:=array_append(required_bits,'customer_intelligence:read');
    ELSE RAISE EXCEPTION 'agent_plan_command_invalid' USING ERRCODE='23514';END CASE;
  END LOOP;
 ELSE required_bits:=ARRAY['workflow:run'];END IF;
 FOREACH permission_bit IN ARRAY required_bits LOOP
  needed:=CASE WHEN permission_bit IN('order:read','order:pii:read','finance:read') OR(permission_bit='inventory:read' AND parent.allowed_reads?'inventory.balances.page') THEN 3 ELSE 1 END;
  IF integration_client_permission_rank(parent.tenant_id,parent.owner_id,permission_bit)<needed
   OR NOT(parent.origin_ceiling->'permissions'?permission_bit)
   OR(needed=3 AND coalesce(parent.origin_ceiling->'permissionScopes'->>permission_bit,parent.origin_ceiling->>'dataScope') IS DISTINCT FROM 'tenant') THEN
   RAISE EXCEPTION 'agent_member_scope_invalid' USING ERRCODE='23514';END IF;
 END LOOP;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION agent_plan_check_selection(parent agent_plan_runs) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE item jsonb;probe jsonb;
BEGIN
 IF jsonb_typeof(parent.allowed_commands) IS DISTINCT FROM 'array' OR jsonb_array_length(parent.allowed_commands) NOT BETWEEN (CASE WHEN parent.version='erp-agent-native-v1' THEN 0 ELSE 1 END) AND 37 THEN
  RAISE EXCEPTION 'agent_plan_commands_invalid' USING ERRCODE='23514';END IF;
 IF(SELECT count(*)<>count(DISTINCT x) FROM jsonb_array_elements(parent.allowed_commands) x) THEN RAISE EXCEPTION 'agent_plan_commands_invalid' USING ERRCODE='23514';END IF;
 FOR item IN SELECT x FROM jsonb_array_elements(parent.allowed_commands) x LOOP
  IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR(item-ARRAY['domain','kind'])<>'{}'::jsonb OR (item?&ARRAY['domain','kind']) IS NOT TRUE THEN
   RAISE EXCEPTION 'agent_plan_commands_invalid' USING ERRCODE='23514';END IF;
  probe:=jsonb_build_object('domain',item->'domain','kind',item->'kind','targetId',null,'accountId',CASE WHEN item->>'domain'='advertising' THEN to_jsonb('00000000-0000-7000-8000-000000000000'::text) ELSE 'null'::jsonb END,'requestKeyHash',repeat('0',64),'ownerRequestChecksum',repeat('0',64));
  IF agent_command_binding_valid(probe) IS NOT TRUE THEN RAISE EXCEPTION 'agent_plan_commands_invalid' USING ERRCODE='23514';END IF;
 END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION guard_agent_native_plan_run() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE ledger ai_budget_ledger%ROWTYPE;item text;
 dispatch_fields text[]:=ARRAY['dispatch_count','last_dispatched_at','next_attempt_at','updated_at','revision'];
 private_fields text[]:=ARRAY['encrypted_input','encrypted_result','result_checksum','updated_at','revision'];
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'agent_history_immutable' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.version<>'erp-agent-native-v1' OR NEW.encrypted_input IS NULL OR NEW.status<>'queued' OR NEW.model_turns<>0 OR NEW.tool_calls<>0 OR NEW.observed_rows<>0
   OR NEW.known_cost_usd<>0 OR NEW.unknown_cost<>0 OR NEW.lease_token IS NOT NULL OR NEW.encrypted_result IS NOT NULL OR NEW.error_code IS NOT NULL
   OR NEW.stop_requested_at IS NOT NULL OR NEW.stop_transaction_id IS NOT NULL OR NEW.completed_at IS NOT NULL OR NEW.dispatch_count<>0 OR NEW.revision<>1
   OR NEW.origin_ceiling->>'tenantId' IS DISTINCT FROM NEW.tenant_id::text OR NEW.origin_ceiling->>'userId' IS DISTINCT FROM NEW.owner_id::text
   OR jsonb_typeof(NEW.allowed_reads) IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.allowed_reads) NOT BETWEEN 1 AND 5
   OR(SELECT count(*)<>count(DISTINCT x) FROM jsonb_array_elements_text(NEW.allowed_reads) x)
   OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(NEW.allowed_reads) x WHERE x NOT IN('orders.exceptions.page','inventory.balances.page','knowledge.search','creative.history','factory.capacity'))
   OR NEW.execution_contract->>'executorKey' IS DISTINCT FROM 'erp.agent.native' OR NEW.execution_contract->'skill'->>'version' IS DISTINCT FROM 'erp-agent-native-v1'
   OR NEW.read_execution_contract->>'executorKey' IS DISTINCT FROM 'erp.agent.tools'
   OR(NEW.limits->>'maxModelTurns')::integer NOT BETWEEN 2 AND 16 OR(NEW.limits->>'maxToolCalls')::integer NOT BETWEEN 2 AND 32
   OR(NEW.limits->>'maxRows')::integer NOT BETWEEN 1 AND 10000 OR(NEW.limits->>'maxOutputTokens')::integer NOT BETWEEN 128 AND 8192
   OR(NEW.limits->>'maxPromptBytes')::integer NOT BETWEEN 4096 AND 1048576 OR(NEW.limits->>'deadlineSeconds')::integer NOT BETWEEN 30 AND 600
   OR coalesce((NEW.limits->>'maxProposals')::integer,0) NOT BETWEEN 1 AND 8
   OR NEW.deadline_at>clock_timestamp()+interval '601 seconds' OR NEW.expires_at>clock_timestamp()+interval '1 day 1 second' THEN
   RAISE EXCEPTION 'agent_birth_invalid' USING ERRCODE='23514';END IF;
  IF jsonb_typeof(NEW.limits) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'agent_limits_invalid' USING ERRCODE='23514';END IF;
  IF(SELECT count(*) FROM jsonb_object_keys(NEW.limits))<>7 THEN RAISE EXCEPTION 'agent_limits_invalid' USING ERRCODE='23514';END IF;
  FOREACH item IN ARRAY ARRAY['maxModelTurns','maxToolCalls','maxRows','maxOutputTokens','maxPromptBytes','deadlineSeconds','maxProposals'] LOOP
   IF jsonb_typeof(NEW.limits->item) IS DISTINCT FROM 'number' OR(NEW.limits->>item)::numeric<>trunc((NEW.limits->>item)::numeric) THEN
    RAISE EXCEPTION 'agent_limits_invalid' USING ERRCODE='23514';END IF;
  END LOOP;
  PERFORM agent_plan_check_selection(NEW);
  PERFORM agent_plan_check_ceiling(NEW,true,true);
  PERFORM agent_plan_require_member(NEW,true);
  SELECT * INTO ledger FROM ai_budget_ledger WHERE tenant_id=NEW.tenant_id AND id=NEW.budget_ledger_id FOR UPDATE;
  IF NOT FOUND OR ledger.request_id<>NEW.id OR ledger.task_type<>'erp_agent_plan' OR ledger.state<>'reserved' OR ledger.amount_usd<>NEW.cap_usd
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
 IF OLD.status IN('completed','partial','failed','uncertain','stopped','expired') THEN
  IF OLD.status IN('completed','partial') AND OLD.stop_requested_at IS NULL AND NEW.stop_requested_at IS NOT NULL
   AND(to_jsonb(NEW)-ARRAY['stop_requested_at','updated_at','revision']) IS NOT DISTINCT FROM(to_jsonb(OLD)-ARRAY['stop_requested_at','updated_at','revision']) THEN
   PERFORM agent_plan_require_member(OLD,false);NEW.stop_requested_at:=clock_timestamp();NEW.stop_transaction_id:=pg_current_xact_id()::text;RETURN NEW;
  END IF;
  RAISE EXCEPTION 'agent_terminal_immutable' USING ERRCODE='23514';END IF;
 IF NEW.encrypted_input IS DISTINCT FROM OLD.encrypted_input THEN RAISE EXCEPTION 'agent_input_immutable' USING ERRCODE='23514';END IF;
 IF OLD.encrypted_result IS NOT NULL AND(NEW.encrypted_result IS DISTINCT FROM OLD.encrypted_result OR NEW.result_checksum IS DISTINCT FROM OLD.result_checksum) THEN
  RAISE EXCEPTION 'agent_result_immutable' USING ERRCODE='23514';END IF;
 IF(OLD.encrypted_result IS NULL AND NEW.encrypted_result IS NOT NULL) OR NEW.status='completed' THEN
  PERFORM agent_plan_require_member(OLD,true);
  IF OLD.stop_requested_at IS NOT NULL OR NEW.stop_requested_at IS NOT NULL OR OLD.deadline_at<=clock_timestamp()
   OR OLD.lease_token IS NULL OR OLD.lease_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'agent_result_adoption_invalid' USING ERRCODE='23514';END IF;
 END IF;
 IF OLD.stop_requested_at IS NULL AND NEW.stop_requested_at IS NOT NULL THEN
  PERFORM agent_plan_require_member(OLD,false);
  IF NEW.status<>'stopping' OR NEW.lease_token IS DISTINCT FROM OLD.lease_token OR NEW.lease_expires_at IS DISTINCT FROM OLD.lease_expires_at THEN
   RAISE EXCEPTION 'agent_stop_invalid' USING ERRCODE='23514';END IF;
  NEW.stop_requested_at:=clock_timestamp();NEW.stop_transaction_id:=pg_current_xact_id()::text;
 END IF;
 IF NEW.status='queued' AND OLD.status<>'queued' OR OLD.stop_requested_at IS NOT NULL AND NEW.status IN('queued','running') THEN
  RAISE EXCEPTION 'agent_state_invalid' USING ERRCODE='23514';END IF;
 IF NEW.model_turns>(NEW.limits->>'maxModelTurns')::integer OR NEW.tool_calls>(NEW.limits->>'maxToolCalls')::integer
  OR NEW.observed_rows>(NEW.limits->>'maxRows')::integer THEN RAISE EXCEPTION 'agent_bound_exceeded' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION guard_agent_native_plan_step() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE parent agent_plan_runs%ROWTYPE;prior agent_plan_steps%ROWTYPE;n integer;
 private_fields text[]:=ARRAY['encrypted_input','encrypted_output','encrypted_response'];
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'agent_history_immutable' USING ERRCODE='23514';END IF;
 SELECT * INTO parent FROM agent_plan_runs WHERE tenant_id=NEW.tenant_id AND id=NEW.run_id FOR UPDATE;
 IF NOT FOUND OR parent.version<>'erp-agent-native-v1' OR parent.owner_id::text IS DISTINCT FROM current_setting('app.user_id',true) THEN RAISE EXCEPTION 'agent_owner_required' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' AND parent.expires_at<=clock_timestamp() AND NEW.encrypted_input IS NULL AND NEW.encrypted_output IS NULL AND NEW.encrypted_response IS NULL
  AND(to_jsonb(NEW)-private_fields) IS NOT DISTINCT FROM(to_jsonb(OLD)-private_fields) THEN RETURN NEW;END IF;
 IF parent.status NOT IN('running','stopping') OR parent.lease_token IS NULL OR parent.lease_expires_at<=clock_timestamp() THEN
  RAISE EXCEPTION 'agent_live_lease_required' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' THEN
  PERFORM agent_plan_require_member(parent,true);
  SELECT count(*) INTO n FROM agent_plan_steps WHERE tenant_id=NEW.tenant_id AND run_id=NEW.run_id;
  IF n>0 THEN SELECT * INTO prior FROM agent_plan_steps WHERE tenant_id=NEW.tenant_id AND run_id=NEW.run_id ORDER BY sequence DESC LIMIT 1;END IF;
  IF parent.stop_requested_at IS NOT NULL OR parent.deadline_at<=clock_timestamp() OR parent.expires_at<=clock_timestamp()
   OR NEW.sequence<>n+1 OR n>=31 OR (n%2=0 AND NEW.kind<>'model') OR (n%2=1 AND NEW.kind NOT IN('read','definition'))
   OR(n>0 AND(prior.phase<>'completed' OR NEW.previous_checksum IS DISTINCT FROM prior.output_checksum))
   OR(n=0 AND NEW.previous_checksum<>parent.input_checksum) OR NEW.phase<>'preparing' OR NEW.encrypted_input IS NULL
   OR NEW.submission_state<>'not_submitted' OR NEW.submitted_at IS NOT NULL OR NEW.received_at IS NOT NULL OR NEW.encrypted_response IS NOT NULL
   OR NEW.encrypted_output IS NOT NULL OR NEW.cost_usd IS NOT NULL OR NEW.completed_at IS NOT NULL OR NEW.error_code IS NOT NULL
   OR(NEW.kind='read' AND NEW.tool IS NULL)
   OR(NEW.kind IN('read','definition') AND NEW.tool IS NOT NULL AND NOT(parent.allowed_reads?NEW.tool)) THEN RAISE EXCEPTION 'agent_step_birth_invalid' USING ERRCODE='23514';END IF;
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
  PERFORM agent_plan_require_member(parent,true);
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
  PERFORM agent_plan_require_member(parent,true);
  IF parent.stop_requested_at IS NOT NULL OR parent.deadline_at<=clock_timestamp() THEN RAISE EXCEPTION 'agent_step_adoption_invalid' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
-- No security definer or bypass: parent version lookup obeys the caller's forced RLS.
CREATE FUNCTION agent_plan_is_native(tenant uuid,run uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT coalesce((SELECT version='erp-agent-native-v1' FROM agent_plan_runs WHERE tenant_id=tenant AND id=run),false)
$$;
DROP TRIGGER agent_plan_run_guard ON agent_plan_runs;
DROP TRIGGER agent_plan_step_guard ON agent_plan_steps;
--> statement-breakpoint
CREATE TRIGGER agent_plan_run_legacy_insert_guard BEFORE INSERT ON agent_plan_runs FOR EACH ROW WHEN(NEW.version='erp-agent-plan-v1') EXECUTE FUNCTION guard_agent_plan_run();
--> statement-breakpoint
CREATE TRIGGER agent_plan_run_legacy_update_guard BEFORE UPDATE ON agent_plan_runs FOR EACH ROW WHEN((OLD.version='erp-agent-plan-v1') OR (NEW.version='erp-agent-plan-v1')) EXECUTE FUNCTION guard_agent_plan_run();
--> statement-breakpoint
CREATE TRIGGER agent_plan_run_legacy_delete_guard BEFORE DELETE ON agent_plan_runs FOR EACH ROW WHEN(OLD.version='erp-agent-plan-v1') EXECUTE FUNCTION guard_agent_plan_run();
--> statement-breakpoint
CREATE TRIGGER agent_plan_run_native_insert_guard BEFORE INSERT ON agent_plan_runs FOR EACH ROW WHEN(NEW.version='erp-agent-native-v1') EXECUTE FUNCTION guard_agent_native_plan_run();
--> statement-breakpoint
CREATE TRIGGER agent_plan_run_native_update_guard BEFORE UPDATE ON agent_plan_runs FOR EACH ROW WHEN((OLD.version='erp-agent-native-v1') OR (NEW.version='erp-agent-native-v1')) EXECUTE FUNCTION guard_agent_native_plan_run();
--> statement-breakpoint
CREATE TRIGGER agent_plan_run_native_delete_guard BEFORE DELETE ON agent_plan_runs FOR EACH ROW WHEN(OLD.version='erp-agent-native-v1') EXECUTE FUNCTION guard_agent_native_plan_run();
--> statement-breakpoint
CREATE TRIGGER agent_plan_step_legacy_insert_guard BEFORE INSERT ON agent_plan_steps FOR EACH ROW WHEN(NOT agent_plan_is_native(NEW.tenant_id,NEW.run_id)) EXECUTE FUNCTION guard_agent_plan_step();
--> statement-breakpoint
CREATE TRIGGER agent_plan_step_legacy_update_guard BEFORE UPDATE ON agent_plan_steps FOR EACH ROW WHEN(NOT agent_plan_is_native(OLD.tenant_id,OLD.run_id)) EXECUTE FUNCTION guard_agent_plan_step();
--> statement-breakpoint
CREATE TRIGGER agent_plan_step_legacy_delete_guard BEFORE DELETE ON agent_plan_steps FOR EACH ROW WHEN(NOT agent_plan_is_native(OLD.tenant_id,OLD.run_id)) EXECUTE FUNCTION guard_agent_plan_step();
--> statement-breakpoint
CREATE TRIGGER agent_plan_step_native_insert_guard BEFORE INSERT ON agent_plan_steps FOR EACH ROW WHEN(agent_plan_is_native(NEW.tenant_id,NEW.run_id)) EXECUTE FUNCTION guard_agent_native_plan_step();
--> statement-breakpoint
CREATE TRIGGER agent_plan_step_native_update_guard BEFORE UPDATE ON agent_plan_steps FOR EACH ROW WHEN(agent_plan_is_native(OLD.tenant_id,OLD.run_id)) EXECUTE FUNCTION guard_agent_native_plan_step();
--> statement-breakpoint
CREATE TRIGGER agent_plan_step_native_delete_guard BEFORE DELETE ON agent_plan_steps FOR EACH ROW WHEN(agent_plan_is_native(OLD.tenant_id,OLD.run_id)) EXECUTE FUNCTION guard_agent_native_plan_step();
