-- Agent coordination references original domain commands; no private business body is copied.
CREATE FUNCTION agent_command_binding_valid(pin jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE field text;domain_name text;kind_name text;
BEGIN
 IF jsonb_typeof(pin) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
 IF (pin-ARRAY['domain','kind','targetId','accountId','requestKeyHash','ownerRequestChecksum'])<>'{}'::jsonb
  OR NOT(pin?&ARRAY['domain','kind','targetId','accountId','requestKeyHash','ownerRequestChecksum']) THEN RETURN false;END IF;
 FOREACH field IN ARRAY ARRAY['domain','kind','requestKeyHash','ownerRequestChecksum'] LOOP
  IF jsonb_typeof(pin->field) IS DISTINCT FROM 'string' THEN RETURN false;END IF;
 END LOOP;
 IF (pin->>'requestKeyHash'~'^[a-f0-9]{64}$') IS NOT TRUE OR(pin->>'ownerRequestChecksum'~'^[a-f0-9]{64}$') IS NOT TRUE THEN RETURN false;END IF;
 FOREACH field IN ARRAY ARRAY['targetId','accountId'] LOOP
  IF pin->field<>'null'::jsonb THEN
   IF jsonb_typeof(pin->field) IS DISTINCT FROM 'string' OR(pin->>field~'^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') IS NOT TRUE THEN RETURN false;END IF;
  END IF;
 END LOOP;
 domain_name:=pin->>'domain';kind_name:=pin->>'kind';
 IF domain_name='advertising' THEN IF pin->'accountId'='null'::jsonb THEN RETURN false;END IF;
 ELSIF pin->'accountId'<>'null'::jsonb THEN RETURN false;END IF;
 RETURN CASE domain_name
  WHEN 'procurement' THEN kind_name IN('requisition_create','rfq_create','quote_record','purchase_create','supply_purchase_create','purchase_revise','purchase_review','invoice_record','invoice_reconcile')
  WHEN 'incoming' THEN kind_name IN('publish_standard','record_arrival','record_inspection','review_inspection','post_inspection','return_rejected')
  WHEN 'production' THEN kind_name IN('approved_design','reviewed_line','reviewed_order')
  WHEN 'finance' THEN kind_name IN('statement_record','fx_rate_record','metric_upsert','profit_calculate','bill_record','payment_record','payment_allocate','allocation_release','bill_adjustment_record','payment_adjustment_record','cost_version_approve','allocated_profit_calculate')
  WHEN 'advertising' THEN kind_name IN('import_commit','goal_save','observation_record','analysis_run','action_transition','import_archive','export_seal') ELSE false END;
END $$;
--> statement-breakpoint
CREATE TABLE agent_command_requests (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES organizations(id),owner_id uuid NOT NULL REFERENCES app_users(id),request_id uuid NOT NULL,
 version text NOT NULL DEFAULT 'erp-agent-command-v1',request_checksum text NOT NULL,operation text NOT NULL,original_checksum text NOT NULL,
 binding jsonb NOT NULL,origin_ceiling jsonb NOT NULL,owner_command_id uuid,
 confirmed_at timestamptz,confirmation_checksum text,creation_transaction_id text,confirmation_transaction_id text,
 link_transaction_id text,cancellation_transaction_id text,acknowledgement_transaction_id text,
 cancelled_at timestamptz,acknowledged_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,
 CONSTRAINT agent_command_requests_tenant_id_unique UNIQUE(tenant_id,id),
 CONSTRAINT agent_command_requests_request_unique UNIQUE(tenant_id,owner_id,request_id),
 CONSTRAINT agent_command_requests_version_check CHECK(version='erp-agent-command-v1'),
 CONSTRAINT agent_command_requests_operation_check CHECK(operation IN('prepare','adopt')),
 CONSTRAINT agent_command_requests_hash_check CHECK(request_checksum~'^[a-f0-9]{64}$' AND original_checksum~'^[a-f0-9]{64}$'),
 CONSTRAINT agent_command_requests_confirmation_check CHECK((confirmed_at IS NULL AND confirmation_checksum IS NULL AND confirmation_transaction_id IS NULL)
  OR(confirmed_at IS NOT NULL AND confirmation_checksum~'^[a-f0-9]{64}$' AND confirmation_transaction_id IS NOT NULL AND owner_command_id IS NOT NULL)),
 CONSTRAINT agent_command_requests_time_check CHECK(expires_at>created_at AND updated_at>=created_at),
 CONSTRAINT agent_command_requests_binding_check CHECK(agent_command_binding_valid(binding) IS TRUE)
);
CREATE INDEX agent_command_requests_owner_idx ON agent_command_requests(tenant_id,owner_id,id);
ALTER TABLE agent_command_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_command_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_command_requests_tenant_policy ON agent_command_requests FOR ALL TO yummyai_app
 USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid))
 WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
GRANT SELECT,INSERT,UPDATE ON agent_command_requests TO yummyai_app;
--> statement-breakpoint
CREATE FUNCTION agent_command_require_actor(parent agent_command_requests,write_action boolean) RETURNS void
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE permission_bit text;needed text[]:=ARRAY['workflow:read'];
BEGIN
 IF parent.tenant_id::text IS DISTINCT FROM current_setting('app.tenant_id',true) OR parent.owner_id::text IS DISTINCT FROM current_setting('app.user_id',true)
  OR parent.origin_ceiling->>'tenantId' IS DISTINCT FROM parent.tenant_id::text OR parent.origin_ceiling->>'userId' IS DISTINCT FROM parent.owner_id::text THEN
  RAISE EXCEPTION 'agent_command_identity_invalid' USING ERRCODE='23514';END IF;
 IF write_action THEN needed:=array_append(needed,'workflow:run');END IF;
 PERFORM 1 FROM memberships m JOIN membership_roles mr ON mr.tenant_id=m.tenant_id AND mr.membership_id=m.id
 JOIN roles r ON r.tenant_id=mr.tenant_id AND r.id=mr.role_id WHERE m.tenant_id=parent.tenant_id AND m.user_id=parent.owner_id ORDER BY m.id,mr.role_id FOR SHARE OF m,mr,r;
 FOREACH permission_bit IN ARRAY needed LOOP
  IF integration_client_permission_rank(parent.tenant_id,parent.owner_id,permission_bit)<1 OR(parent.origin_ceiling->'permissions'?permission_bit) IS NOT TRUE THEN
   RAISE EXCEPTION 'agent_command_authority_required' USING ERRCODE='23514';END IF;
 END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION agent_command_check_birth_ceiling(parent agent_command_requests) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE pin jsonb:=parent.origin_ceiling;item jsonb;permission_bit text;scope_name text;needed integer;ceiling_rank integer:=1;member uuid;wanted_team_id uuid;entry record;actual_team_hash text;
BEGIN
 IF jsonb_typeof(pin) IS DISTINCT FROM 'object' OR(pin-ARRAY['tenantId','userId','teamId','teamIds','teamAuthority','permissions','permissionScopes','dataScope'])<>'{}'::jsonb
  OR jsonb_typeof(pin->'permissions') IS DISTINCT FROM 'array' OR coalesce(pin->>'dataScope','') NOT IN('self','team','tenant') THEN
  RAISE EXCEPTION 'agent_command_ceiling_shape_invalid' USING ERRCODE='23514';END IF;
 IF (SELECT count(*)<>count(DISTINCT x) FROM jsonb_array_elements(pin->'permissions') x) THEN
  RAISE EXCEPTION 'agent_command_ceiling_shape_invalid' USING ERRCODE='23514';END IF;
 IF pin?'permissionScopes' THEN
  IF jsonb_typeof(pin->'permissionScopes') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'agent_command_ceiling_shape_invalid' USING ERRCODE='23514';END IF;
  FOR entry IN SELECT * FROM jsonb_each(pin->'permissionScopes') LOOP
   IF (pin->'permissions'?entry.key) IS NOT TRUE OR jsonb_typeof(entry.value) IS DISTINCT FROM 'string' OR(entry.value#>>'{}') NOT IN('self','team','tenant') THEN
    RAISE EXCEPTION 'agent_command_ceiling_shape_invalid' USING ERRCODE='23514';END IF;
  END LOOP;
 END IF;
 FOR item IN SELECT x FROM jsonb_array_elements(pin->'permissions') x LOOP
  IF jsonb_typeof(item) IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'agent_command_ceiling_shape_invalid' USING ERRCODE='23514';END IF;
  permission_bit:=item#>>'{}';scope_name:=CASE WHEN pin?'permissionScopes' THEN pin->'permissionScopes'->>permission_bit ELSE pin->>'dataScope' END;
  IF scope_name IS NULL OR length(permission_bit) NOT BETWEEN 1 AND 128 THEN RAISE EXCEPTION 'agent_command_ceiling_shape_invalid' USING ERRCODE='23514';END IF;
  needed:=CASE scope_name WHEN 'tenant' THEN 3 WHEN 'team' THEN 2 WHEN 'self' THEN 1 ELSE 99 END;
  ceiling_rank:=greatest(ceiling_rank,needed);
  IF integration_client_permission_rank(parent.tenant_id,parent.owner_id,permission_bit)<needed THEN
   RAISE EXCEPTION 'agent_command_ceiling_exceeds_member' USING ERRCODE='23514';END IF;
 END LOOP;
 IF (CASE pin->>'dataScope' WHEN 'tenant' THEN 3 WHEN 'team' THEN 2 ELSE 1 END)<>ceiling_rank THEN
  RAISE EXCEPTION 'agent_command_ceiling_aggregate_invalid' USING ERRCODE='23514';END IF;
 SELECT id INTO member FROM memberships WHERE tenant_id=parent.tenant_id AND user_id=parent.owner_id AND status='active' FOR SHARE;
 IF member IS NULL THEN RAISE EXCEPTION 'agent_command_ceiling_member_required' USING ERRCODE='23514';END IF;
 PERFORM 1 FROM organization_team_members tm JOIN organization_teams t ON t.tenant_id=tm.tenant_id AND t.id=tm.team_id
  WHERE tm.tenant_id=parent.tenant_id AND tm.membership_id=member ORDER BY tm.id FOR SHARE OF tm,t;
 IF pin?'teamIds' THEN
  IF jsonb_typeof(pin->'teamIds') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'agent_command_ceiling_shape_invalid' USING ERRCODE='23514';END IF;
  IF jsonb_array_length(pin->'teamIds')>200 OR(SELECT count(*)<>count(DISTINCT x) FROM jsonb_array_elements(pin->'teamIds') x) THEN
   RAISE EXCEPTION 'agent_command_ceiling_shape_invalid' USING ERRCODE='23514';END IF;
 END IF;
 FOR item IN SELECT x FROM jsonb_array_elements(coalesce(pin->'teamIds','[]'::jsonb)) x UNION ALL SELECT pin->'teamId' WHERE pin?'teamId' LOOP
  IF jsonb_typeof(item) IS DISTINCT FROM 'string' OR(item#>>'{}'~'^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') IS NOT TRUE THEN
   RAISE EXCEPTION 'agent_command_ceiling_shape_invalid' USING ERRCODE='23514';END IF;
  wanted_team_id:=(item#>>'{}')::uuid;
  IF NOT EXISTS(SELECT 1 FROM organization_team_members tm JOIN organization_teams t ON t.tenant_id=tm.tenant_id AND t.id=tm.team_id
   WHERE tm.tenant_id=parent.tenant_id AND tm.membership_id=member AND tm.team_id=wanted_team_id AND tm.active AND t.status='active') THEN
   RAISE EXCEPTION 'agent_command_ceiling_team_exceeds_member' USING ERRCODE='23514';END IF;
 END LOOP;
 IF pin?'teamAuthority' THEN
  SELECT encode(sha256(convert_to('['||coalesce(string_agg('{"id":'||to_json(tm.id::text)::text||',"teamId":'||to_json(t.id::text)::text||',"revision":'||tm.revision::text||',"teamRevision":'||t.access_generation::text||'}',',' ORDER BY t.id),'')||']','UTF8')),'hex') INTO actual_team_hash
   FROM organization_team_members tm JOIN organization_teams t ON t.tenant_id=tm.tenant_id AND t.id=tm.team_id
   WHERE tm.tenant_id=parent.tenant_id AND tm.membership_id=member AND tm.active AND t.status='active';
  IF pin->>'teamAuthority' IS DISTINCT FROM actual_team_hash THEN RAISE EXCEPTION 'agent_command_ceiling_team_stamp_invalid' USING ERRCODE='23514';END IF;
 END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION agent_command_check_owner(parent agent_command_requests) RETURNS void
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE original jsonb;owner_table text;
BEGIN
 IF parent.owner_command_id IS NULL THEN RETURN;END IF;
 owner_table:=CASE parent.binding->>'domain' WHEN 'procurement' THEN 'inventory_procurement_commands' WHEN 'incoming' THEN 'inventory_incoming_commands'
  WHEN 'production' THEN 'production_command_intents' WHEN 'finance' THEN 'finance_commands' WHEN 'advertising' THEN 'advertising_commands' END;
 IF owner_table IS NULL THEN RAISE EXCEPTION 'agent_command_owner_invalid' USING ERRCODE='23514';END IF;
 EXECUTE format('SELECT to_jsonb(x) FROM %I x WHERE x.tenant_id=$1 AND x.id=$2',owner_table) INTO original USING parent.tenant_id,parent.owner_command_id;
 IF original IS NULL OR original->>'created_by' IS DISTINCT FROM parent.owner_id::text OR original->>'kind' IS DISTINCT FROM parent.binding->>'kind'
  OR original->>'target_id' IS DISTINCT FROM parent.binding->>'targetId' OR original->>'account_id' IS DISTINCT FROM parent.binding->>'accountId'
  OR original->>'request_checksum' IS DISTINCT FROM parent.binding->>'ownerRequestChecksum'
  OR encode(sha256(convert_to(original->>'request_key','UTF8')),'hex') IS DISTINCT FROM parent.binding->>'requestKeyHash' THEN
  RAISE EXCEPTION 'agent_command_original_reference_required' USING ERRCODE='23514';END IF;
 IF parent.cancelled_at IS NOT NULL AND original->>'status' IS DISTINCT FROM 'cancelled' OR
  parent.acknowledged_at IS NOT NULL AND original->>'acknowledged_at' IS NULL THEN
  RAISE EXCEPTION 'agent_command_native_action_required' USING ERRCODE='23514';END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION guard_agent_command_request() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'agent_command_history_immutable' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' THEN
  PERFORM agent_command_require_actor(NEW,true);
  PERFORM agent_command_check_birth_ceiling(NEW);
  IF NEW.owner_command_id IS NOT NULL OR NEW.confirmed_at IS NOT NULL OR NEW.confirmation_checksum IS NOT NULL OR NEW.creation_transaction_id IS NOT NULL
   OR NEW.confirmation_transaction_id IS NOT NULL OR NEW.cancelled_at IS NOT NULL OR NEW.acknowledged_at IS NOT NULL
   OR NEW.link_transaction_id IS NOT NULL OR NEW.cancellation_transaction_id IS NOT NULL OR NEW.acknowledgement_transaction_id IS NOT NULL THEN
   RAISE EXCEPTION 'agent_command_clean_birth_required' USING ERRCODE='23514';END IF;
  NEW.created_at:=clock_timestamp();NEW.updated_at:=NEW.created_at;NEW.expires_at:=NEW.created_at+interval '7 days';
  NEW.creation_transaction_id:=pg_current_xact_id()::text;RETURN NEW;
 END IF;
 IF (to_jsonb(NEW)-ARRAY['owner_command_id','confirmed_at','confirmation_checksum','confirmation_transaction_id','link_transaction_id','cancellation_transaction_id','acknowledgement_transaction_id','cancelled_at','acknowledged_at','updated_at'])
  IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['owner_command_id','confirmed_at','confirmation_checksum','confirmation_transaction_id','link_transaction_id','cancellation_transaction_id','acknowledgement_transaction_id','cancelled_at','acknowledged_at','updated_at']) THEN
  RAISE EXCEPTION 'agent_command_input_immutable' USING ERRCODE='23514';END IF;
 PERFORM agent_command_require_actor(NEW,NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at OR NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at OR NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at);
 IF NEW.link_transaction_id IS DISTINCT FROM OLD.link_transaction_id OR NEW.cancellation_transaction_id IS DISTINCT FROM OLD.cancellation_transaction_id
  OR NEW.acknowledgement_transaction_id IS DISTINCT FROM OLD.acknowledgement_transaction_id OR NEW.confirmation_transaction_id IS DISTINCT FROM OLD.confirmation_transaction_id THEN
  RAISE EXCEPTION 'agent_command_transaction_is_server_owned' USING ERRCODE='23514';END IF;
 IF OLD.owner_command_id IS NOT NULL AND NEW.owner_command_id IS DISTINCT FROM OLD.owner_command_id OR OLD.confirmed_at IS NOT NULL AND
  (NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at OR NEW.confirmation_checksum IS DISTINCT FROM OLD.confirmation_checksum OR NEW.confirmation_transaction_id IS DISTINCT FROM OLD.confirmation_transaction_id)
  OR OLD.cancelled_at IS NOT NULL AND NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at OR OLD.acknowledged_at IS NOT NULL AND NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at THEN
  RAISE EXCEPTION 'agent_command_progress_monotone' USING ERRCODE='23514';END IF;
 IF OLD.confirmed_at IS NULL AND NEW.confirmed_at IS NOT NULL THEN
  IF NEW.confirmation_transaction_id IS NOT NULL OR NEW.owner_command_id IS NULL OR NEW.expires_at<=clock_timestamp() THEN
   RAISE EXCEPTION 'agent_command_live_confirmation_required' USING ERRCODE='23514';END IF;
  NEW.confirmed_at:=clock_timestamp();NEW.confirmation_transaction_id:=pg_current_xact_id()::text;
 END IF;
 IF OLD.owner_command_id IS NULL AND NEW.owner_command_id IS NOT NULL THEN NEW.link_transaction_id:=pg_current_xact_id()::text;END IF;
 IF OLD.cancelled_at IS NULL AND NEW.cancelled_at IS NOT NULL THEN NEW.cancelled_at:=clock_timestamp();NEW.cancellation_transaction_id:=pg_current_xact_id()::text;END IF;
 IF OLD.acknowledged_at IS NULL AND NEW.acknowledged_at IS NOT NULL THEN NEW.acknowledged_at:=clock_timestamp();NEW.acknowledgement_transaction_id:=pg_current_xact_id()::text;END IF;
 NEW.updated_at:=clock_timestamp();PERFORM agent_command_check_owner(NEW);RETURN NEW;
END $$;
CREATE TRIGGER agent_command_request_guard BEFORE INSERT OR UPDATE OR DELETE ON agent_command_requests FOR EACH ROW EXECUTE FUNCTION guard_agent_command_request();
--> statement-breakpoint
CREATE FUNCTION require_agent_command_audit() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE current_row agent_command_requests%ROWTYPE;own_xmin text:=(pg_current_xact_id()::text::numeric%4294967296)::text;event_action text;
BEGIN
 SELECT * INTO current_row FROM agent_command_requests WHERE tenant_id=NEW.tenant_id AND id=NEW.id;
 IF NOT FOUND THEN RAISE EXCEPTION 'agent_command_parent_required' USING ERRCODE='23514';END IF;
 IF current_row.creation_transaction_id=pg_current_xact_id()::text AND NOT EXISTS(SELECT 1 FROM audit_events a
  WHERE a.tenant_id=current_row.tenant_id AND a.actor_user_id=current_row.owner_id AND a.entity_type='agent_command_request' AND a.entity_id=current_row.id
  AND a.action='agent.command.create' AND a.result='success' AND a.xmin::text=own_xmin AND a.metadata->>'requestChecksum'=current_row.request_checksum
  AND a.metadata->>'originalChecksum'=current_row.original_checksum) THEN
  RAISE EXCEPTION 'agent_command_birth_audit_required' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' THEN
  FOR event_action IN SELECT unnest(array_remove(ARRAY[
   CASE WHEN OLD.owner_command_id IS NULL AND NEW.owner_command_id IS NOT NULL THEN 'agent.command.link' END,
   CASE WHEN OLD.confirmed_at IS NULL AND NEW.confirmed_at IS NOT NULL THEN 'agent.command.confirm' END,
   CASE WHEN OLD.cancelled_at IS NULL AND NEW.cancelled_at IS NOT NULL THEN 'agent.command.cancel' END,
   CASE WHEN OLD.acknowledged_at IS NULL AND NEW.acknowledged_at IS NOT NULL THEN 'agent.command.acknowledge' END]::text[],NULL)) LOOP
  IF NOT EXISTS(SELECT 1 FROM audit_events a WHERE a.tenant_id=current_row.tenant_id AND a.actor_user_id=current_row.owner_id
   AND a.entity_type='agent_command_request' AND a.entity_id=current_row.id AND a.action=event_action AND a.result='success' AND a.xmin::text=own_xmin
   AND a.metadata->>'requestChecksum'=current_row.request_checksum AND a.metadata->>'ownerCommandId'=current_row.owner_command_id::text
   AND(event_action<>'agent.command.confirm' OR a.metadata->>'confirmationChecksum'=current_row.confirmation_checksum)) THEN
   RAISE EXCEPTION 'agent_command_action_audit_required' USING ERRCODE='23514';END IF;
  END LOOP;
 END IF;
 PERFORM agent_command_check_owner(current_row);RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER agent_command_audit_closure AFTER INSERT OR UPDATE ON agent_command_requests
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_agent_command_audit();
--> statement-breakpoint
CREATE FUNCTION require_agent_command_audit_parent() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE parent agent_command_requests%ROWTYPE;event_transaction text;
BEGIN
 SELECT * INTO parent FROM agent_command_requests WHERE tenant_id=NEW.tenant_id AND id=NEW.entity_id;
 IF NOT FOUND OR NEW.entity_type<>'agent_command_request' OR NEW.actor_user_id IS DISTINCT FROM parent.owner_id OR NEW.result<>'success'
  OR NEW.metadata->>'requestChecksum' IS DISTINCT FROM parent.request_checksum OR NEW.metadata->>'originalChecksum' IS DISTINCT FROM parent.original_checksum THEN
  RAISE EXCEPTION 'agent_command_audit_parent_required' USING ERRCODE='23514';END IF;
 PERFORM agent_command_require_actor(parent,NEW.action<>'agent.command.link');
 CASE NEW.action
  WHEN 'agent.command.create' THEN event_transaction:=parent.creation_transaction_id;
  WHEN 'agent.command.link' THEN event_transaction:=parent.link_transaction_id;
  WHEN 'agent.command.confirm' THEN
   IF NEW.metadata->>'confirmationChecksum' IS DISTINCT FROM parent.confirmation_checksum THEN
    RAISE EXCEPTION 'agent_command_confirmation_audit_required' USING ERRCODE='23514';END IF;
   event_transaction:=parent.confirmation_transaction_id;
  WHEN 'agent.command.cancel' THEN event_transaction:=parent.cancellation_transaction_id;
  WHEN 'agent.command.acknowledge' THEN event_transaction:=parent.acknowledgement_transaction_id;
  WHEN 'agent.command.confirm_replay' THEN
   IF parent.confirmed_at IS NULL OR NEW.metadata->>'confirmationChecksum' IS DISTINCT FROM parent.confirmation_checksum THEN
    RAISE EXCEPTION 'agent_command_confirmation_audit_required' USING ERRCODE='23514';END IF;
   event_transaction:=pg_current_xact_id()::text;
  ELSE RAISE EXCEPTION 'agent_command_audit_action_invalid' USING ERRCODE='23514';
 END CASE;
 IF event_transaction IS DISTINCT FROM pg_current_xact_id()::text OR NEW.action<>'agent.command.create' AND
  (parent.owner_command_id IS NULL OR NEW.metadata->>'ownerCommandId' IS DISTINCT FROM parent.owner_command_id::text) THEN
  RAISE EXCEPTION 'agent_command_same_transaction_audit_required' USING ERRCODE='23514';END IF;
 PERFORM agent_command_check_owner(parent);RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER agent_command_audit_parent_closure AFTER INSERT ON audit_events
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 WHEN(NEW.entity_type='agent_command_request' OR NEW.action LIKE 'agent.command.%')
 EXECUTE FUNCTION require_agent_command_audit_parent();
