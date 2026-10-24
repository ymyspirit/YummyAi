-- Independent native-v4 ABI and operator completion. Existing 186 rows and historical guards retain their meaning.
ALTER TABLE agent_plan_runs DROP CONSTRAINT agent_plan_runs_version_check;
ALTER TABLE agent_plan_runs ADD CONSTRAINT agent_plan_runs_version_check CHECK(version IN('erp-agent-plan-v1','erp-agent-native-v1','erp-agent-native-v2','erp-agent-native-v3','erp-agent-native-v4'));
ALTER TABLE agent_plan_runs DROP CONSTRAINT agent_plan_runs_count_check;
ALTER TABLE agent_plan_runs ADD CONSTRAINT agent_plan_runs_count_check CHECK(revision>0 AND model_turns BETWEEN 0 AND (CASE WHEN version IN('erp-agent-native-v2','erp-agent-native-v3','erp-agent-native-v4') THEN 48 WHEN version='erp-agent-native-v1' THEN 16 ELSE 8 END) AND tool_calls BETWEEN 0 AND (CASE WHEN version IN('erp-agent-native-v2','erp-agent-native-v3','erp-agent-native-v4') THEN 192 ELSE 32 END) AND observed_rows BETWEEN 0 AND (CASE WHEN version IN('erp-agent-native-v1','erp-agent-native-v2','erp-agent-native-v3','erp-agent-native-v4') THEN 10000 ELSE 1000 END) AND dispatch_count>=0 AND unknown_cost IN(0,1));
--> statement-breakpoint
CREATE FUNCTION agent_native_v4_plan_require_member(parent agent_plan_runs,needs_domains boolean) RETURNS void
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
  FOR permission_bit IN SELECT CASE x WHEN 'orders.exceptions.page' THEN 'order:read' WHEN 'factory.capacity' THEN 'order:read' WHEN 'inventory.balances.page' THEN 'inventory:read' WHEN 'creative.history' THEN 'design:read' WHEN 'knowledge.search' THEN 'workflow:read' WHEN 'research.evidence' THEN 'research:read' WHEN 'catalog.sku' THEN 'product:read' WHEN 'listing.version' THEN 'listing:read' WHEN 'orders.fulfillment' THEN 'order:read' WHEN 'orders.order' THEN 'order:read' WHEN 'finance.profit_run' THEN 'finance:read' WHEN 'advertising.analysis' THEN 'customer_intelligence:read' ELSE 'agent:invalid' END FROM jsonb_array_elements_text(parent.allowed_reads) x LOOP
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
    WHEN 'fulfillment' THEN
     required_bits:=required_bits||ARRAY['order:read','order:pii:read','order:write'];
     IF domain_item->>'kind' IN('delivery_create','delivery_feedback') THEN required_bits:=required_bits||ARRAY['design:read','asset:read'];END IF;
    ELSE RAISE EXCEPTION 'agent_plan_command_invalid' USING ERRCODE='23514';END CASE;
  END LOOP;
 ELSE required_bits:=ARRAY['workflow:run'];END IF;
 FOREACH permission_bit IN ARRAY required_bits LOOP
  needed:=CASE WHEN permission_bit IN('order:read','order:pii:read','order:write','finance:read') OR(permission_bit IN('design:read','asset:read') AND EXISTS(SELECT 1 FROM jsonb_array_elements(parent.allowed_commands) x WHERE x->>'domain'='fulfillment' AND x->>'kind' IN('delivery_create','delivery_feedback'))) OR(permission_bit='inventory:read' AND parent.allowed_reads?'inventory.balances.page') THEN 3 ELSE 1 END;
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
 IF parent.version='erp-agent-native-v4' THEN PERFORM agent_native_v4_plan_require_member(parent,needs_domains);RETURN;END IF;
 IF parent.version='erp-agent-native-v3' THEN PERFORM agent_native_v3_plan_require_member(parent,needs_domains);RETURN;END IF;
 IF parent.version='erp-agent-native-v2' THEN PERFORM agent_native_v2_plan_require_member(parent,needs_domains);RETURN;END IF;
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
 IF jsonb_typeof(parent.allowed_commands) IS DISTINCT FROM 'array' OR jsonb_array_length(parent.allowed_commands) NOT BETWEEN (CASE WHEN parent.version IN('erp-agent-native-v1','erp-agent-native-v2','erp-agent-native-v3','erp-agent-native-v4') THEN 0 ELSE 1 END) AND(CASE WHEN parent.version='erp-agent-native-v4' THEN 51 ELSE 37 END) THEN
  RAISE EXCEPTION 'agent_plan_commands_invalid' USING ERRCODE='23514';END IF;
 IF(SELECT count(*)<>count(DISTINCT x) FROM jsonb_array_elements(parent.allowed_commands) x) THEN RAISE EXCEPTION 'agent_plan_commands_invalid' USING ERRCODE='23514';END IF;
 FOR item IN SELECT x FROM jsonb_array_elements(parent.allowed_commands) x LOOP
  IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR(item-ARRAY['domain','kind'])<>'{}'::jsonb OR (item?&ARRAY['domain','kind']) IS NOT TRUE THEN
   RAISE EXCEPTION 'agent_plan_commands_invalid' USING ERRCODE='23514';END IF;
  IF parent.version='erp-agent-native-v4' AND item->>'domain'='fulfillment' THEN
   IF (item->>'kind' IN('delivery_create','delivery_feedback','production_milestone','quality_inspection','quality_group_inspection','production_recovery','whole_production_milestone','whole_quality_inspection','shipment_create','whole_shipment_create','shipment_version','shipment_review','shipment_dispatch','shipment_platform_confirmation')) IS NOT TRUE THEN
    RAISE EXCEPTION 'agent_plan_commands_invalid' USING ERRCODE='23514';END IF;
  ELSE
  probe:=jsonb_build_object('domain',item->'domain','kind',item->'kind','targetId',null,'accountId',CASE WHEN item->>'domain'='advertising' THEN to_jsonb('00000000-0000-7000-8000-000000000000'::text) ELSE 'null'::jsonb END,'requestKeyHash',repeat('0',64),'ownerRequestChecksum',repeat('0',64));
  IF agent_command_binding_valid(probe) IS NOT TRUE THEN RAISE EXCEPTION 'agent_plan_commands_invalid' USING ERRCODE='23514';END IF;
  END IF;
 END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION guard_agent_native_v4_plan_run() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE ledger ai_budget_ledger%ROWTYPE;item text;
 dispatch_fields text[]:=ARRAY['dispatch_count','last_dispatched_at','next_attempt_at','updated_at','revision'];
 private_fields text[]:=ARRAY['encrypted_input','encrypted_result','result_checksum','updated_at','revision'];
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'agent_history_immutable' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.version<>'erp-agent-native-v4' OR NEW.encrypted_input IS NULL OR NEW.status<>'queued' OR NEW.model_turns<>0 OR NEW.tool_calls<>0 OR NEW.observed_rows<>0
   OR NEW.known_cost_usd<>0 OR NEW.unknown_cost<>0 OR NEW.lease_token IS NOT NULL OR NEW.encrypted_result IS NOT NULL OR NEW.error_code IS NOT NULL
   OR NEW.stop_requested_at IS NOT NULL OR NEW.stop_transaction_id IS NOT NULL OR NEW.completed_at IS NOT NULL OR NEW.dispatch_count<>0 OR NEW.revision<>1
   OR NEW.origin_ceiling->>'tenantId' IS DISTINCT FROM NEW.tenant_id::text OR NEW.origin_ceiling->>'userId' IS DISTINCT FROM NEW.owner_id::text
   OR jsonb_typeof(NEW.allowed_reads) IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.allowed_reads) NOT BETWEEN 1 AND 12
   OR(SELECT count(*)<>count(DISTINCT x) FROM jsonb_array_elements_text(NEW.allowed_reads) x)
   OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(NEW.allowed_reads) x WHERE x NOT IN('orders.exceptions.page','inventory.balances.page','knowledge.search','creative.history','factory.capacity','research.evidence','catalog.sku','listing.version','orders.order','finance.profit_run','advertising.analysis','orders.fulfillment'))
   OR NEW.execution_contract->>'executorKey' IS DISTINCT FROM 'erp.agent.native.v4' OR NEW.execution_contract->'skill'->>'version' IS DISTINCT FROM 'erp-agent-native-v4'
   OR NEW.read_execution_contract->>'executorKey' IS DISTINCT FROM 'erp.agent.native.v4'
   OR NEW.read_execution_contract->'skill'->>'key' IS DISTINCT FROM 'erp.agent.native.v4.read'
   OR NEW.read_execution_contract->'skill'->>'version' IS DISTINCT FROM 'erp-agent-native-v4'
   OR(NEW.limits->>'maxModelTurns')::integer NOT BETWEEN 2 AND 48 OR(NEW.limits->>'maxToolCalls')::integer NOT BETWEEN 2 AND 192
   OR(NEW.limits->>'maxRows')::integer NOT BETWEEN 1 AND 10000 OR(NEW.limits->>'maxOutputTokens')::integer NOT BETWEEN 128 AND 8192
   OR(NEW.limits->>'maxPromptBytes')::integer NOT BETWEEN 4096 AND 1048576 OR(NEW.limits->>'deadlineSeconds')::integer NOT BETWEEN 30 AND 1800
   OR coalesce((NEW.limits->>'maxProposals')::integer,0) NOT BETWEEN 1 AND 8
   OR NEW.deadline_at>clock_timestamp()+interval '1801 seconds' OR NEW.expires_at>clock_timestamp()+interval '1 day 1 second' THEN
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
CREATE FUNCTION guard_agent_native_v4_plan_step() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE parent agent_plan_runs%ROWTYPE;prior agent_plan_steps%ROWTYPE;n integer;
 private_fields text[]:=ARRAY['encrypted_input','encrypted_output','encrypted_response'];
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'agent_history_immutable' USING ERRCODE='23514';END IF;
 SELECT * INTO parent FROM agent_plan_runs WHERE tenant_id=NEW.tenant_id AND id=NEW.run_id FOR UPDATE;
 IF NOT FOUND OR parent.version<>'erp-agent-native-v4' OR parent.owner_id::text IS DISTINCT FROM current_setting('app.user_id',true) THEN RAISE EXCEPTION 'agent_owner_required' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' AND parent.expires_at<=clock_timestamp() AND NEW.encrypted_input IS NULL AND NEW.encrypted_output IS NULL AND NEW.encrypted_response IS NULL
  AND(to_jsonb(NEW)-private_fields) IS NOT DISTINCT FROM(to_jsonb(OLD)-private_fields) THEN RETURN NEW;END IF;
 IF parent.status NOT IN('running','stopping') OR parent.lease_token IS NULL OR parent.lease_expires_at<=clock_timestamp() THEN
  RAISE EXCEPTION 'agent_live_lease_required' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' THEN
  PERFORM agent_plan_require_member(parent,true);
  SELECT count(*) INTO n FROM agent_plan_steps WHERE tenant_id=NEW.tenant_id AND run_id=NEW.run_id;
  IF n>0 THEN SELECT * INTO prior FROM agent_plan_steps WHERE tenant_id=NEW.tenant_id AND run_id=NEW.run_id ORDER BY sequence DESC LIMIT 1;END IF;
  IF parent.stop_requested_at IS NOT NULL OR parent.deadline_at<=clock_timestamp() OR parent.expires_at<=clock_timestamp()
   OR NEW.sequence<>n+1 OR n>=95 OR (n%2=0 AND NEW.kind<>'model') OR (n%2=1 AND NEW.kind NOT IN('read','definition'))
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
CREATE FUNCTION agent_plan_is_native_v4(tenant uuid,run uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT coalesce((SELECT version='erp-agent-native-v4' FROM agent_plan_runs WHERE tenant_id=tenant AND id=run),false)
$$;
CREATE FUNCTION agent_plan_item_is_native_v4(tenant uuid,item uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT coalesce((SELECT r.version='erp-agent-native-v4' FROM agent_plan_items i JOIN agent_plan_runs r ON r.tenant_id=i.tenant_id AND r.id=i.run_id WHERE i.tenant_id=tenant AND i.id=item),false)
$$;
--> statement-breakpoint
CREATE TRIGGER agent_plan_run_native_v4_insert_guard BEFORE INSERT ON agent_plan_runs FOR EACH ROW WHEN(NEW.version='erp-agent-native-v4') EXECUTE FUNCTION guard_agent_native_v4_plan_run();
DROP TRIGGER agent_plan_step_legacy_insert_guard ON agent_plan_steps;
CREATE TRIGGER agent_plan_step_legacy_insert_guard BEFORE INSERT ON agent_plan_steps FOR EACH ROW WHEN(NOT agent_plan_is_native(NEW.tenant_id,NEW.run_id) AND NOT agent_plan_is_native_v2(NEW.tenant_id,NEW.run_id) AND NOT agent_plan_is_native_v3(NEW.tenant_id,NEW.run_id) AND NOT agent_plan_is_native_v4(NEW.tenant_id,NEW.run_id)) EXECUTE FUNCTION guard_agent_plan_step();
CREATE TRIGGER agent_plan_step_native_v4_insert_guard BEFORE INSERT ON agent_plan_steps FOR EACH ROW WHEN(agent_plan_is_native_v4(NEW.tenant_id,NEW.run_id)) EXECUTE FUNCTION guard_agent_native_v4_plan_step();
CREATE TRIGGER agent_plan_run_native_v4_update_guard BEFORE UPDATE ON agent_plan_runs FOR EACH ROW WHEN(OLD.version='erp-agent-native-v4' OR NEW.version='erp-agent-native-v4') EXECUTE FUNCTION guard_agent_native_v4_plan_run();
DROP TRIGGER agent_plan_step_legacy_update_guard ON agent_plan_steps;
CREATE TRIGGER agent_plan_step_legacy_update_guard BEFORE UPDATE ON agent_plan_steps FOR EACH ROW WHEN(NOT agent_plan_is_native(OLD.tenant_id,OLD.run_id) AND NOT agent_plan_is_native_v2(OLD.tenant_id,OLD.run_id) AND NOT agent_plan_is_native_v3(OLD.tenant_id,OLD.run_id) AND NOT agent_plan_is_native_v4(OLD.tenant_id,OLD.run_id)) EXECUTE FUNCTION guard_agent_plan_step();
CREATE TRIGGER agent_plan_step_native_v4_update_guard BEFORE UPDATE ON agent_plan_steps FOR EACH ROW WHEN(agent_plan_is_native_v4(OLD.tenant_id,OLD.run_id)) EXECUTE FUNCTION guard_agent_native_v4_plan_step();
CREATE TRIGGER agent_plan_run_native_v4_delete_guard BEFORE DELETE ON agent_plan_runs FOR EACH ROW WHEN(OLD.version='erp-agent-native-v4') EXECUTE FUNCTION guard_agent_native_v4_plan_run();
DROP TRIGGER agent_plan_step_legacy_delete_guard ON agent_plan_steps;
CREATE TRIGGER agent_plan_step_legacy_delete_guard BEFORE DELETE ON agent_plan_steps FOR EACH ROW WHEN(NOT agent_plan_is_native(OLD.tenant_id,OLD.run_id) AND NOT agent_plan_is_native_v2(OLD.tenant_id,OLD.run_id) AND NOT agent_plan_is_native_v3(OLD.tenant_id,OLD.run_id) AND NOT agent_plan_is_native_v4(OLD.tenant_id,OLD.run_id)) EXECUTE FUNCTION guard_agent_plan_step();
CREATE TRIGGER agent_plan_step_native_v4_delete_guard BEFORE DELETE ON agent_plan_steps FOR EACH ROW WHEN(agent_plan_is_native_v4(OLD.tenant_id,OLD.run_id)) EXECUTE FUNCTION guard_agent_native_v4_plan_step();
--> statement-breakpoint
ALTER TABLE agent_plan_items
 ADD COLUMN original_protocol text,
 ADD COLUMN original_order_id uuid,
 ADD COLUMN fulfillment_intent_id uuid,
 ADD COLUMN encrypted_completion text,
 ADD COLUMN completion_checksum text,
 ADD COLUMN completion_bound_at timestamptz,
 ADD COLUMN completion_transaction_id text,
 ADD COLUMN completion_redacted_at timestamptz,
 ADD CONSTRAINT agent_plan_item_order_fk FOREIGN KEY(tenant_id,original_order_id) REFERENCES orders(tenant_id,id),
 ADD CONSTRAINT agent_plan_item_fulfillment_fk FOREIGN KEY(tenant_id,fulfillment_intent_id) REFERENCES order_fulfillment_command_intents(tenant_id,id),
 ADD CONSTRAINT agent_plan_items_original_protocol_check CHECK(original_protocol IS NULL OR original_protocol IN('erp-agent-command-v1','erp-agent-fulfillment-command-v1')),
 ADD CONSTRAINT agent_plan_items_original_xor_check CHECK(NOT(agent_command_id IS NOT NULL AND fulfillment_intent_id IS NOT NULL) AND(fulfillment_intent_id IS NULL OR(original_protocol IS NOT DISTINCT FROM 'erp-agent-fulfillment-command-v1' AND completion_checksum IS NOT NULL))),
 ADD CONSTRAINT agent_plan_items_completion_check CHECK(
  (completion_checksum IS NULL AND encrypted_completion IS NULL AND completion_bound_at IS NULL AND completion_transaction_id IS NULL AND completion_redacted_at IS NULL)
  OR(completion_checksum IS NOT NULL AND completion_checksum~'^[a-f0-9]{64}$' AND original_protocol IS NOT DISTINCT FROM 'erp-agent-fulfillment-command-v1'
   AND original_order_id IS NOT NULL AND original_checksum IS NOT NULL AND preparation_request_checksum IS NOT NULL AND preparation_requested_at IS NOT NULL
   AND completion_bound_at IS NOT NULL AND completion_transaction_id IS NOT NULL AND completion_transaction_id~'^[0-9]+$'
   AND((encrypted_completion IS NOT NULL AND completion_redacted_at IS NULL) OR(encrypted_completion IS NULL AND completion_redacted_at IS NOT NULL))));
CREATE UNIQUE INDEX agent_plan_items_fulfillment_unique ON agent_plan_items(tenant_id,fulfillment_intent_id);
--> statement-breakpoint
-- Historical item guards keep their bodies and receive only historical rows.
CREATE FUNCTION guard_agent_plan_legacy_item_extension() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.original_protocol IS NOT NULL OR NEW.original_order_id IS NOT NULL OR NEW.fulfillment_intent_id IS NOT NULL
  OR NEW.encrypted_completion IS NOT NULL OR NEW.completion_checksum IS NOT NULL OR NEW.completion_bound_at IS NOT NULL
  OR NEW.completion_transaction_id IS NOT NULL OR NEW.completion_redacted_at IS NOT NULL THEN
  RAISE EXCEPTION 'agent_legacy_item_extension_forbidden' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
DROP TRIGGER agent_plan_item_guard ON agent_plan_items;
CREATE TRIGGER agent_plan_item_guard_insert BEFORE INSERT ON agent_plan_items FOR EACH ROW
 WHEN(NOT agent_plan_is_native_v4(NEW.tenant_id,NEW.run_id)) EXECUTE FUNCTION guard_agent_plan_item();
CREATE TRIGGER agent_plan_item_guard_update BEFORE UPDATE ON agent_plan_items FOR EACH ROW
 WHEN(NOT agent_plan_is_native_v4(OLD.tenant_id,OLD.run_id)) EXECUTE FUNCTION guard_agent_plan_item();
CREATE TRIGGER agent_plan_item_guard_delete BEFORE DELETE ON agent_plan_items FOR EACH ROW
 WHEN(NOT agent_plan_is_native_v4(OLD.tenant_id,OLD.run_id)) EXECUTE FUNCTION guard_agent_plan_item();
CREATE TRIGGER agent_plan_item_legacy_extension_guard BEFORE INSERT OR UPDATE ON agent_plan_items FOR EACH ROW
 WHEN(NOT agent_plan_is_native_v4(NEW.tenant_id,NEW.run_id)) EXECUTE FUNCTION guard_agent_plan_legacy_item_extension();
--> statement-breakpoint
CREATE FUNCTION guard_agent_native_v4_plan_item() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE parent agent_plan_runs%ROWTYPE;model agent_plan_steps%ROWTYPE;command agent_command_requests%ROWTYPE;
 original order_fulfillment_command_intents%ROWTYPE;
 changing_completion boolean;redacting_completion boolean;
 mutable text[]:=ARRAY['original_checksum','preparation_request_checksum','preparation_requested_at','agent_command_id','fulfillment_intent_id',
  'preparation_transaction_id','link_transaction_id','encrypted_completion','completion_checksum','completion_bound_at','completion_transaction_id','completion_redacted_at'];
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'agent_plan_item_history_immutable' USING ERRCODE='23514';END IF;
 SELECT * INTO parent FROM agent_plan_runs WHERE tenant_id=NEW.tenant_id AND id=NEW.run_id FOR UPDATE;
 IF parent.id IS NULL OR parent.version<>'erp-agent-native-v4' OR parent.owner_id::text IS DISTINCT FROM current_setting('app.user_id',true)
  OR parent.tenant_id::text IS DISTINCT FROM current_setting('app.tenant_id',true) THEN
  RAISE EXCEPTION 'agent_plan_item_owner_required' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' THEN
  PERFORM agent_plan_check_ceiling(parent,true);PERFORM agent_plan_require_member(parent,true);
  SELECT * INTO model FROM agent_plan_steps WHERE tenant_id=NEW.tenant_id AND id=NEW.model_step_id;
  IF model.run_id IS DISTINCT FROM parent.id OR model.kind<>'model' OR model.phase<>'completed' OR model.output_checksum IS NULL OR model.response_checksum IS NULL
   OR NEW.id<>agent_plan_slot_id(parent.id,NEW.position) OR NEW.position>=(parent.limits->>'maxProposals')::integer
   OR parent.stop_requested_at IS NOT NULL OR parent.deadline_at<=clock_timestamp() OR parent.lease_token IS NULL OR parent.lease_expires_at<=clock_timestamp()
   OR NEW.original_protocol IS NULL OR NEW.agent_command_id IS NOT NULL OR NEW.fulfillment_intent_id IS NOT NULL OR NEW.preparation_requested_at IS NOT NULL
   OR NEW.creation_transaction_id IS NOT NULL OR NEW.preparation_transaction_id IS NOT NULL OR NEW.link_transaction_id IS NOT NULL
   OR NEW.completion_checksum IS NOT NULL OR NEW.encrypted_completion IS NOT NULL OR NEW.completion_bound_at IS NOT NULL
   OR NEW.completion_transaction_id IS NOT NULL OR NEW.completion_redacted_at IS NOT NULL
   OR(NEW.original_protocol='erp-agent-fulfillment-command-v1' AND(NEW.original_checksum IS NOT NULL OR NEW.preparation_request_checksum IS NOT NULL))
   OR(NEW.original_protocol='erp-agent-command-v1' AND NEW.original_order_id IS NOT NULL)
   OR NEW.model_step_id IS DISTINCT FROM(SELECT id FROM agent_plan_steps WHERE tenant_id=parent.tenant_id AND run_id=parent.id ORDER BY sequence DESC LIMIT 1) THEN
   RAISE EXCEPTION 'agent_plan_item_birth_invalid' USING ERRCODE='23514';END IF;
  NEW.created_at:=clock_timestamp();NEW.creation_transaction_id:=pg_current_xact_id()::text;RETURN NEW;
 END IF;
 IF(to_jsonb(NEW)-mutable) IS DISTINCT FROM(to_jsonb(OLD)-mutable) THEN
  RAISE EXCEPTION 'agent_plan_item_pin_immutable' USING ERRCODE='23514';END IF;
 IF NEW.preparation_transaction_id IS DISTINCT FROM OLD.preparation_transaction_id OR NEW.link_transaction_id IS DISTINCT FROM OLD.link_transaction_id
  OR NEW.completion_transaction_id IS DISTINCT FROM OLD.completion_transaction_id THEN
  RAISE EXCEPTION 'agent_plan_item_transaction_server_owned' USING ERRCODE='23514';END IF;
 IF OLD.preparation_requested_at IS NOT NULL AND NEW.preparation_requested_at IS DISTINCT FROM OLD.preparation_requested_at
  OR OLD.agent_command_id IS NOT NULL AND NEW.agent_command_id IS DISTINCT FROM OLD.agent_command_id
  OR OLD.fulfillment_intent_id IS NOT NULL AND NEW.fulfillment_intent_id IS DISTINCT FROM OLD.fulfillment_intent_id THEN
  RAISE EXCEPTION 'agent_plan_item_progress_monotone' USING ERRCODE='23514';END IF;
 changing_completion:=OLD.completion_checksum IS NULL AND NEW.completion_checksum IS NOT NULL;
 redacting_completion:=OLD.encrypted_completion IS NOT NULL AND NEW.encrypted_completion IS NULL;
 IF changing_completion THEN
  IF NEW.original_protocol<>'erp-agent-fulfillment-command-v1' OR NEW.original_order_id IS NULL
   OR OLD.original_checksum IS NOT NULL OR OLD.preparation_request_checksum IS NOT NULL OR OLD.preparation_requested_at IS NOT NULL
   OR NEW.original_checksum IS NULL OR NEW.preparation_request_checksum IS NULL OR NEW.original_checksum<>NEW.preparation_request_checksum
   OR NEW.encrypted_completion IS NULL OR NEW.completion_bound_at IS NULL OR NEW.completion_redacted_at IS NOT NULL
   OR NEW.preparation_requested_at IS NULL OR parent.encrypted_input IS NULL OR parent.encrypted_result IS NULL
   OR parent.status NOT IN('completed','partial') OR parent.stop_requested_at IS NOT NULL OR parent.expires_at<=clock_timestamp() THEN
   RAISE EXCEPTION 'agent_plan_item_completion_invalid' USING ERRCODE='23514';END IF;
  PERFORM agent_plan_check_ceiling(parent,true);PERFORM agent_plan_require_member(parent,true);
  NEW.completion_bound_at:=clock_timestamp();NEW.completion_transaction_id:=pg_current_xact_id()::text;
 ELSE
  IF NEW.original_checksum IS DISTINCT FROM OLD.original_checksum OR NEW.preparation_request_checksum IS DISTINCT FROM OLD.preparation_request_checksum
   OR NEW.completion_checksum IS DISTINCT FROM OLD.completion_checksum OR NEW.completion_bound_at IS DISTINCT FROM OLD.completion_bound_at THEN
   RAISE EXCEPTION 'agent_plan_item_completion_immutable' USING ERRCODE='23514';END IF;
  IF redacting_completion THEN
   IF OLD.completion_redacted_at IS NOT NULL OR NEW.completion_redacted_at IS NULL
    OR(parent.encrypted_input IS NOT NULL AND parent.expires_at>clock_timestamp()) THEN
    RAISE EXCEPTION 'agent_plan_item_completion_retained' USING ERRCODE='23514';END IF;
   NEW.completion_redacted_at:=clock_timestamp();
  ELSIF NEW.encrypted_completion IS DISTINCT FROM OLD.encrypted_completion OR NEW.completion_redacted_at IS DISTINCT FROM OLD.completion_redacted_at THEN
   RAISE EXCEPTION 'agent_plan_item_completion_immutable' USING ERRCODE='23514';END IF;
 END IF;
 IF OLD.preparation_requested_at IS NULL AND NEW.preparation_requested_at IS NOT NULL THEN
  IF parent.status NOT IN('completed','partial') OR parent.encrypted_input IS NULL OR parent.encrypted_result IS NULL
   OR parent.stop_requested_at IS NOT NULL OR parent.expires_at<=clock_timestamp() OR NEW.original_checksum IS NULL
   OR(NEW.original_protocol='erp-agent-fulfillment-command-v1' AND NOT changing_completion) THEN
   RAISE EXCEPTION 'agent_plan_item_not_preparable' USING ERRCODE='23514';END IF;
  PERFORM agent_plan_check_ceiling(parent,true);PERFORM agent_plan_require_member(parent,true);
  NEW.preparation_requested_at:=clock_timestamp();NEW.preparation_transaction_id:=pg_current_xact_id()::text;
 ELSIF NOT redacting_completion THEN PERFORM agent_plan_check_ceiling(parent,false);END IF;
 IF OLD.agent_command_id IS NULL AND NEW.agent_command_id IS NOT NULL OR OLD.fulfillment_intent_id IS NULL AND NEW.fulfillment_intent_id IS NOT NULL THEN
  NEW.link_transaction_id:=pg_current_xact_id()::text;
 END IF;
 IF NEW.agent_command_id IS NOT NULL THEN
  SELECT * INTO command FROM agent_command_requests WHERE tenant_id=NEW.tenant_id AND id=NEW.agent_command_id;
  IF NEW.original_protocol<>'erp-agent-command-v1' OR NEW.fulfillment_intent_id IS NOT NULL OR command.owner_id IS DISTINCT FROM parent.owner_id
   OR command.request_id IS DISTINCT FROM NEW.id OR command.request_checksum IS DISTINCT FROM NEW.preparation_request_checksum
   OR command.original_checksum IS DISTINCT FROM NEW.original_checksum OR command.operation IS DISTINCT FROM 'prepare'
   OR command.owner_command_id IS NULL OR NEW.preparation_requested_at IS NULL
   OR agent_plan_ceiling_contains(parent.origin_ceiling,command.origin_ceiling) IS NOT TRUE THEN
   RAISE EXCEPTION 'agent_plan_item_original_required' USING ERRCODE='23514';END IF;
 END IF;
 IF NEW.fulfillment_intent_id IS NOT NULL THEN
  SELECT * INTO original FROM order_fulfillment_command_intents WHERE tenant_id=NEW.tenant_id AND id=NEW.fulfillment_intent_id;
  IF NEW.original_protocol<>'erp-agent-fulfillment-command-v1' OR NEW.agent_command_id IS NOT NULL
   OR original.contract_version IS DISTINCT FROM 'erp-agent-fulfillment-command-v1' OR original.created_by IS DISTINCT FROM parent.owner_id
   OR original.request_id IS DISTINCT FROM NEW.id OR original.request_key IS DISTINCT FROM NEW.id::text
   OR original.order_id IS DISTINCT FROM NEW.original_order_id OR original.request_checksum IS DISTINCT FROM NEW.original_checksum
   OR original.request_checksum IS DISTINCT FROM NEW.preparation_request_checksum OR NEW.preparation_requested_at IS NULL OR NEW.completion_checksum IS NULL
   OR agent_plan_ceiling_contains(parent.origin_ceiling,original.authority_snapshot) IS NOT TRUE THEN
   RAISE EXCEPTION 'agent_plan_item_original_required' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER agent_plan_item_native_v4_guard_insert BEFORE INSERT ON agent_plan_items FOR EACH ROW
 WHEN(agent_plan_is_native_v4(NEW.tenant_id,NEW.run_id)) EXECUTE FUNCTION guard_agent_native_v4_plan_item();
CREATE TRIGGER agent_plan_item_native_v4_guard_update BEFORE UPDATE ON agent_plan_items FOR EACH ROW
 WHEN(agent_plan_is_native_v4(OLD.tenant_id,OLD.run_id)) EXECUTE FUNCTION guard_agent_native_v4_plan_item();
CREATE TRIGGER agent_plan_item_native_v4_guard_delete BEFORE DELETE ON agent_plan_items FOR EACH ROW
 WHEN(agent_plan_is_native_v4(OLD.tenant_id,OLD.run_id)) EXECUTE FUNCTION guard_agent_native_v4_plan_item();
--> statement-breakpoint
DROP TRIGGER agent_plan_item_closure ON agent_plan_items;
CREATE CONSTRAINT TRIGGER agent_plan_item_closure AFTER INSERT OR UPDATE ON agent_plan_items DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 WHEN(NOT agent_plan_is_native_v4(NEW.tenant_id,NEW.run_id)) EXECUTE FUNCTION require_agent_plan_item_closure();
CREATE FUNCTION require_agent_native_v4_item_closure() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE item agent_plan_items%ROWTYPE;parent agent_plan_runs%ROWTYPE;action_name text;
 own_xmin text:=(pg_current_xact_id()::text::numeric%4294967296)::text;actions text[];
BEGIN
 SELECT * INTO item FROM agent_plan_items WHERE tenant_id=NEW.tenant_id AND id=NEW.id;
 SELECT * INTO parent FROM agent_plan_runs WHERE tenant_id=item.tenant_id AND id=item.run_id;
 IF parent.id IS NULL OR parent.version<>'erp-agent-native-v4'
  OR(TG_OP='INSERT' AND(parent.encrypted_result IS NULL OR parent.result_checksum IS NULL OR parent.status NOT IN('completed','partial'))) THEN
  RAISE EXCEPTION 'agent_plan_item_result_required' USING ERRCODE='23514';END IF;
 actions:=CASE WHEN item.creation_transaction_id=pg_current_xact_id()::text THEN ARRAY['agent.plan.item.create'] ELSE ARRAY[]::text[] END;
 IF TG_OP='UPDATE' THEN
  IF OLD.preparation_requested_at IS NULL AND NEW.preparation_requested_at IS NOT NULL THEN actions:=array_append(actions,'agent.plan.item.prepare');END IF;
  IF OLD.completion_checksum IS NULL AND NEW.completion_checksum IS NOT NULL THEN actions:=array_append(actions,'agent.plan.item.complete');END IF;
  IF OLD.agent_command_id IS NULL AND NEW.agent_command_id IS NOT NULL OR OLD.fulfillment_intent_id IS NULL AND NEW.fulfillment_intent_id IS NOT NULL THEN
   actions:=array_append(actions,'agent.plan.item.link');END IF;
  IF OLD.encrypted_completion IS NOT NULL AND NEW.encrypted_completion IS NULL THEN actions:=array_append(actions,'agent.plan.item.redact');END IF;
 END IF;
 FOREACH action_name IN ARRAY actions LOOP
  IF NOT EXISTS(SELECT 1 FROM audit_events a WHERE a.tenant_id=item.tenant_id AND a.actor_user_id=parent.owner_id
   AND a.entity_type='agent_plan_item' AND a.entity_id=item.id AND a.action=action_name AND a.result='success' AND a.xmin::text=own_xmin
   AND a.metadata->>'proposalChecksum'=item.proposal_checksum AND a.metadata->>'runId'=parent.id::text
   AND(action_name NOT IN('agent.plan.item.complete','agent.plan.item.redact') OR a.metadata->>'completionChecksum'=item.completion_checksum)
   AND(action_name<>'agent.plan.item.link' OR(item.fulfillment_intent_id IS NOT NULL AND a.metadata->>'fulfillmentIntentId'=item.fulfillment_intent_id::text)
    OR(item.agent_command_id IS NOT NULL AND a.metadata->>'agentCommandId'=item.agent_command_id::text))) THEN
   RAISE EXCEPTION 'agent_plan_item_action_audit_required' USING ERRCODE='23514';END IF;
 END LOOP;
 IF(SELECT count(*) FROM agent_plan_items WHERE tenant_id=parent.tenant_id AND run_id=parent.id)>(parent.limits->>'maxProposals')::integer
  OR EXISTS(SELECT 1 FROM agent_plan_items i WHERE i.tenant_id=parent.tenant_id AND i.run_id=parent.id AND i.position>0
   AND NOT EXISTS(SELECT 1 FROM agent_plan_items p WHERE p.tenant_id=i.tenant_id AND p.run_id=i.run_id AND p.position=i.position-1)) THEN
  RAISE EXCEPTION 'agent_plan_item_sequence_invalid' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER agent_plan_item_native_v4_closure AFTER INSERT OR UPDATE ON agent_plan_items DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 WHEN(agent_plan_is_native_v4(NEW.tenant_id,NEW.run_id)) EXECUTE FUNCTION require_agent_native_v4_item_closure();
--> statement-breakpoint
DROP TRIGGER agent_plan_item_audit_guard ON audit_events;
CREATE TRIGGER agent_plan_item_audit_guard BEFORE INSERT ON audit_events FOR EACH ROW
 WHEN(NEW.action LIKE 'agent.plan.item.%' AND NOT agent_plan_item_is_native_v4(NEW.tenant_id,NEW.entity_id)) EXECUTE FUNCTION guard_agent_plan_item_audit();
CREATE FUNCTION guard_agent_native_v4_item_audit() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE item agent_plan_items%ROWTYPE;parent agent_plan_runs%ROWTYPE;event_transaction text;
 own_xmin text:=(pg_current_xact_id()::text::numeric%4294967296)::text;
BEGIN
 SELECT * INTO item FROM agent_plan_items WHERE tenant_id=NEW.tenant_id AND id=NEW.entity_id;
 SELECT * INTO parent FROM agent_plan_runs WHERE tenant_id=item.tenant_id AND id=item.run_id;
 IF item.id IS NULL OR parent.version<>'erp-agent-native-v4' OR NEW.entity_type<>'agent_plan_item' OR NEW.actor_user_id IS DISTINCT FROM parent.owner_id
  OR NEW.actor_user_id::text IS DISTINCT FROM current_setting('app.user_id',true) OR NEW.result<>'success'
  OR NEW.metadata->>'proposalChecksum' IS DISTINCT FROM item.proposal_checksum OR NEW.metadata->>'runId' IS DISTINCT FROM parent.id::text THEN
  RAISE EXCEPTION 'agent_plan_item_audit_parent_required' USING ERRCODE='23514';END IF;
 CASE NEW.action
  WHEN 'agent.plan.item.create' THEN event_transaction:=item.creation_transaction_id;
  WHEN 'agent.plan.item.prepare' THEN event_transaction:=item.preparation_transaction_id;
  WHEN 'agent.plan.item.complete' THEN
   event_transaction:=item.completion_transaction_id;
   IF NEW.metadata->>'completionChecksum' IS DISTINCT FROM item.completion_checksum OR NEW.metadata->>'originalChecksum' IS DISTINCT FROM item.original_checksum
    OR NEW.metadata->>'preparationRequestChecksum' IS DISTINCT FROM item.preparation_request_checksum
    OR NEW.metadata->>'provenance' IS DISTINCT FROM 'operator_completed_not_model_evidence' THEN
    RAISE EXCEPTION 'agent_plan_item_audit_completion_required' USING ERRCODE='23514';END IF;
  WHEN 'agent.plan.item.link' THEN
   event_transaction:=item.link_transaction_id;
   IF(item.fulfillment_intent_id IS NOT NULL AND NEW.metadata->>'fulfillmentIntentId' IS DISTINCT FROM item.fulfillment_intent_id::text)
    OR(item.agent_command_id IS NOT NULL AND NEW.metadata->>'agentCommandId' IS DISTINCT FROM item.agent_command_id::text) THEN
    RAISE EXCEPTION 'agent_plan_item_audit_original_required' USING ERRCODE='23514';END IF;
  WHEN 'agent.plan.item.redact' THEN
   IF item.encrypted_completion IS NOT NULL OR item.completion_redacted_at IS NULL OR NEW.metadata->>'completionChecksum' IS DISTINCT FROM item.completion_checksum
    OR NOT EXISTS(SELECT 1 FROM agent_plan_items i WHERE i.tenant_id=item.tenant_id AND i.id=item.id AND i.xmin::text=own_xmin) THEN
    RAISE EXCEPTION 'agent_plan_item_audit_redaction_required' USING ERRCODE='23514';END IF;
   event_transaction:=pg_current_xact_id()::text;
  ELSE RAISE EXCEPTION 'agent_plan_item_audit_action_invalid' USING ERRCODE='23514';
 END CASE;
 IF event_transaction IS DISTINCT FROM pg_current_xact_id()::text THEN RAISE EXCEPTION 'agent_plan_item_audit_transaction_required' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER agent_plan_item_native_v4_audit_guard BEFORE INSERT ON audit_events FOR EACH ROW
 WHEN(NEW.action LIKE 'agent.plan.item.%' AND agent_plan_item_is_native_v4(NEW.tenant_id,NEW.entity_id)) EXECUTE FUNCTION guard_agent_native_v4_item_audit();
--> statement-breakpoint
-- Hold the original parent through the native owner's final business fence.
-- Unrelated manual/old-protocol intents retain their original source predicate.
CREATE FUNCTION order_fulfillment_agent_plan_source_available(command order_fulfillment_command_intents)
RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,public AS $$
DECLARE item agent_plan_items%ROWTYPE;parent agent_plan_runs%ROWTYPE;
BEGIN
 SELECT * INTO item FROM agent_plan_items WHERE tenant_id=command.tenant_id AND id=command.request_id;
 IF item.id IS NULL THEN RETURN true;END IF;
 SELECT * INTO parent FROM agent_plan_runs WHERE tenant_id=item.tenant_id AND id=item.run_id FOR SHARE;
 IF parent.version IS DISTINCT FROM 'erp-agent-native-v4' THEN RETURN true;END IF;
 RETURN item.original_protocol IS NOT DISTINCT FROM 'erp-agent-fulfillment-command-v1'
  AND command.contract_version IS NOT DISTINCT FROM 'erp-agent-fulfillment-command-v1'
  AND item.preparation_requested_at IS NOT NULL AND item.completion_checksum IS NOT NULL AND item.encrypted_completion IS NOT NULL
  AND item.original_order_id IS NOT DISTINCT FROM command.order_id AND parent.owner_id IS NOT DISTINCT FROM command.created_by
  AND command.request_key IS NOT DISTINCT FROM item.id::text
  AND command.request_checksum IS NOT DISTINCT FROM item.original_checksum
  AND command.request_checksum IS NOT DISTINCT FROM item.preparation_request_checksum
  AND(item.fulfillment_intent_id IS NULL OR item.fulfillment_intent_id=command.id)
  AND parent.stop_requested_at IS NULL AND parent.expires_at>clock_timestamp() AND parent.status IN('completed','partial')
  AND parent.encrypted_input IS NOT NULL AND parent.encrypted_result IS NOT NULL
  AND agent_plan_ceiling_contains(parent.origin_ceiling,command.authority_snapshot) IS TRUE;
END $$;
CREATE FUNCTION guard_agent_native_v4_fulfillment_child_birth() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE item agent_plan_items%ROWTYPE;parent agent_plan_runs%ROWTYPE;
BEGIN
 SELECT * INTO item FROM agent_plan_items WHERE tenant_id=NEW.tenant_id AND id=NEW.request_id;
 IF item.id IS NULL THEN RETURN NEW;END IF;
 SELECT * INTO parent FROM agent_plan_runs WHERE tenant_id=item.tenant_id AND id=item.run_id FOR SHARE;
 IF parent.version IS DISTINCT FROM 'erp-agent-native-v4' THEN RETURN NEW;END IF;
 IF order_fulfillment_agent_plan_source_available(NEW) IS NOT TRUE THEN
  RAISE EXCEPTION 'agent_plan_original_birth_required' USING ERRCODE='23514';END IF;
 PERFORM agent_plan_check_ceiling(parent,true);PERFORM agent_plan_require_member(parent,true);
 RETURN NEW;
END $$;
CREATE TRIGGER agent_native_v4_fulfillment_child_birth_guard BEFORE INSERT ON order_fulfillment_command_intents
 FOR EACH ROW EXECUTE FUNCTION guard_agent_native_v4_fulfillment_child_birth();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION order_fulfillment_command_source_available(command order_fulfillment_command_intents)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT order_fulfillment_agent_plan_source_available(command) AND EXISTS(SELECT 1 FROM orders o LEFT JOIN order_protected_details p ON p.tenant_id=o.tenant_id AND p.order_id=o.id
 WHERE o.tenant_id=command.tenant_id AND o.id=command.order_id AND o.address_status<>'anonymized'
 AND ((o.address_status='missing' AND p.id IS NULL) OR (p.status='protected' AND p.retention_expires_at>clock_timestamp()))
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(command.line_ids) requested(id)
  LEFT JOIN order_lines l ON l.tenant_id=command.tenant_id AND l.order_id=command.order_id AND l.id=requested.id::uuid
  LEFT JOIN order_work_items w ON w.tenant_id=l.tenant_id AND w.id=l.id
  WHERE l.id IS NULL OR (w.id IS NOT NULL AND (w.encrypted_data_key IS NULL OR w.archived_at IS NOT NULL OR w.expires_at<=clock_timestamp()))))
$$;

