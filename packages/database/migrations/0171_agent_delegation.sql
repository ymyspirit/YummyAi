-- Historical clients/events are left byte-for-byte intact. NULL delegation is
-- deliberately not reconstructed from today's roles; it requires a new key.
ALTER TABLE integration_api_clients ADD COLUMN delegation jsonb;
ALTER TABLE integration_api_clients ADD COLUMN delegation_request jsonb;
ALTER TABLE integration_api_clients ADD COLUMN creation_transaction_id text;
ALTER TABLE integration_api_clients ADD COLUMN revocation_transaction_id text;
ALTER TABLE integration_api_client_events ADD COLUMN creation_transaction_id text;
--> statement-breakpoint
CREATE FUNCTION integration_client_delegation_valid(scopes jsonb,pin jsonb,input jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE item jsonb;bit record;
BEGIN
 IF jsonb_typeof(scopes) IS DISTINCT FROM 'array' OR jsonb_array_length(scopes) NOT BETWEEN 1 AND 9
  OR (SELECT count(*)<>count(DISTINCT x) FROM jsonb_array_elements(scopes) x)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(scopes) x WHERE x NOT IN('forecast:read','operations:read','inventory:read','finance:read','customer_intelligence:read','supplier_performance:read','order:read','product:read','listing:read')) THEN RETURN false;END IF;
 IF jsonb_typeof(pin) IS DISTINCT FROM 'object' OR(pin-ARRAY['version','membershipId','permissionScopes','teamIds','capturedAt','requestChecksum'])<>'{}'::jsonb
  OR pin->>'version' IS DISTINCT FROM 'integration-api-delegation-v1'
  OR coalesce(pin->>'membershipId','')!~'^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  OR jsonb_typeof(pin->'permissionScopes') IS DISTINCT FROM 'object'
  OR(SELECT count(*) FROM jsonb_object_keys(pin->'permissionScopes'))<>jsonb_array_length(scopes)
  OR jsonb_typeof(pin->'teamIds') IS DISTINCT FROM 'array' OR jsonb_array_length(pin->'teamIds')>200
  OR(SELECT count(*)<>count(DISTINCT x) FROM jsonb_array_elements(pin->'teamIds') x)
  OR coalesce(pin->>'capturedAt','')!~'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$'
  OR coalesce(pin->>'requestChecksum','')!~'^[a-f0-9]{64}$' THEN RETURN false;END IF;
 FOR bit IN SELECT * FROM jsonb_each(pin->'permissionScopes') LOOP
  IF NOT(scopes?bit.key) OR jsonb_typeof(bit.value)<>'string' OR bit.value#>>'{}' NOT IN('self','team','tenant') THEN RETURN false;END IF;
 END LOOP;
 FOR item IN SELECT x FROM jsonb_array_elements(pin->'teamIds') x LOOP
  IF jsonb_typeof(item)<>'string' OR item#>>'{}'!~'^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN RETURN false;END IF;
 END LOOP;
 IF jsonb_typeof(input) IS DISTINCT FROM 'object' OR(input-ARRAY['label','scopes','expiresAt','idempotencyKey','scopeLimits','teamIds'])<>'{}'::jsonb
  OR jsonb_typeof(input->'label') IS DISTINCT FROM 'string' OR length(input->>'label') NOT BETWEEN 1 AND 120
  OR jsonb_typeof(input->'idempotencyKey') IS DISTINCT FROM 'string' OR length(input->>'idempotencyKey') NOT BETWEEN 8 AND 200
  OR input->'scopes' IS DISTINCT FROM scopes OR NOT(input?'expiresAt')
  OR (input->'expiresAt'<>'null'::jsonb AND (jsonb_typeof(input->'expiresAt')<>'string' OR input->>'expiresAt'!~'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$'))
  OR(input?'scopeLimits' AND input->'scopeLimits' IS DISTINCT FROM pin->'permissionScopes') THEN RETURN false;END IF;
 IF input?'teamIds' THEN
  IF jsonb_typeof(input->'teamIds') IS DISTINCT FROM 'array' OR jsonb_array_length(input->'teamIds')<>jsonb_array_length(pin->'teamIds')
   OR NOT((input->'teamIds') @> (pin->'teamIds') AND (pin->'teamIds') @> (input->'teamIds')) THEN RETURN false;END IF;
 END IF;
 RETURN pin->>'requestChecksum'=encode(sha256(convert_to(invoice_reconciliation_canonical(input),'UTF8')),'hex');
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
ALTER TABLE integration_api_clients ADD CONSTRAINT integration_client_delegation_shape CHECK(
 (delegation IS NULL AND delegation_request IS NULL AND creation_transaction_id IS NULL) OR
 (delegation IS NOT NULL AND delegation_request IS NOT NULL AND creation_transaction_id~'^[0-9]+$'
  AND integration_client_delegation_valid(scopes,delegation,delegation_request)));
--> statement-breakpoint
CREATE FUNCTION integration_client_permission_rank(tenant uuid,actor uuid,permission_bit text) RETURNS integer
LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT coalesce(max(CASE r.data_scope WHEN 'tenant' THEN 3 WHEN 'team' THEN 2 WHEN 'self' THEN 1 ELSE 0 END),0)::integer
 FROM memberships m JOIN membership_roles mr ON mr.tenant_id=m.tenant_id AND mr.membership_id=m.id
 JOIN roles r ON r.tenant_id=mr.tenant_id AND r.id=mr.role_id
 WHERE m.tenant_id=tenant AND m.user_id=actor AND m.status='active' AND r.permissions?permission_bit
$$;
CREATE FUNCTION integration_client_require_manager(tenant uuid,actor uuid,owner_id uuid) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE actual integer;
BEGIN
 IF tenant::text IS DISTINCT FROM current_setting('app.tenant_id',true) OR actor::text IS DISTINCT FROM current_setting('app.user_id',true) THEN
  RAISE EXCEPTION 'integration_client_identity_invalid' USING ERRCODE='23514';END IF;
 PERFORM 1 FROM memberships m JOIN membership_roles mr ON mr.tenant_id=m.tenant_id AND mr.membership_id=m.id
  JOIN roles r ON r.tenant_id=mr.tenant_id AND r.id=mr.role_id
  WHERE m.tenant_id=tenant AND m.user_id=actor ORDER BY m.id,mr.role_id FOR SHARE OF m,mr,r;
 actual:=integration_client_permission_rank(tenant,actor,'integration:manage');
 IF actual=0 OR(actual<3 AND owner_id IS DISTINCT FROM actor) THEN
  RAISE EXCEPTION 'integration_client_manage_not_authorized' USING ERRCODE='23514';END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION guard_integration_client() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE bit record;needed integer;actor uuid:=nullif(current_setting('app.user_id',true),'')::uuid;member uuid;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'integration_client_history_immutable' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-ARRAY['status','revoked_at','revocation_transaction_id']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','revoked_at','revocation_transaction_id'])
   OR NEW.revocation_transaction_id IS DISTINCT FROM OLD.revocation_transaction_id OR OLD.status<>'active' OR NEW.status<>'revoked' THEN
   RAISE EXCEPTION 'integration_client_original_immutable' USING ERRCODE='23514';END IF;
  PERFORM integration_client_require_manager(NEW.tenant_id,actor,NEW.created_by);
  NEW.revocation_transaction_id:=pg_current_xact_id()::text;NEW.revoked_at:=clock_timestamp();RETURN NEW;
 END IF;
 IF NEW.creation_transaction_id IS NOT NULL OR NEW.revocation_transaction_id IS NOT NULL OR NEW.status<>'active' OR NEW.revoked_at IS NOT NULL
  OR NOT integration_client_delegation_valid(NEW.scopes,NEW.delegation,NEW.delegation_request)
  OR NEW.created_by IS DISTINCT FROM actor OR NEW.key_prefix IS DISTINCT FROM 'yai_'||NEW.id::text
  OR NEW.label IS DISTINCT FROM NEW.delegation_request->>'label' OR NEW.idempotency_key IS DISTINCT FROM NEW.delegation_request->>'idempotencyKey'
  OR NEW.expires_at IS DISTINCT FROM (NEW.delegation_request->>'expiresAt')::timestamptz THEN
  RAISE EXCEPTION 'integration_client_birth_invalid' USING ERRCODE='23514';END IF;
 PERFORM integration_client_require_manager(NEW.tenant_id,actor,NEW.created_by);
 SELECT id INTO member FROM memberships WHERE tenant_id=NEW.tenant_id AND user_id=actor AND status='active' FOR SHARE;
 IF member IS NULL OR NEW.delegation->>'membershipId' IS DISTINCT FROM member::text THEN RAISE EXCEPTION 'integration_client_membership_invalid' USING ERRCODE='23514';END IF;
 IF (NEW.delegation->>'capturedAt')::timestamptz<statement_timestamp()-interval '30 seconds' OR (NEW.delegation->>'capturedAt')::timestamptz>clock_timestamp()+interval '1 second'
  OR(NEW.expires_at IS NOT NULL AND NEW.expires_at<=clock_timestamp()) THEN RAISE EXCEPTION 'integration_client_birth_time_invalid' USING ERRCODE='23514';END IF;
 FOR bit IN SELECT * FROM jsonb_each_text(NEW.delegation->'permissionScopes') LOOP
  needed:=CASE bit.value WHEN 'tenant' THEN 3 WHEN 'team' THEN 2 ELSE 1 END;
  IF integration_client_permission_rank(NEW.tenant_id,actor,bit.key)<needed THEN RAISE EXCEPTION 'integration_client_scope_exceeds_member' USING ERRCODE='23514';END IF;
 END LOOP;
 PERFORM 1 FROM organization_team_members tm JOIN organization_teams t ON t.tenant_id=tm.tenant_id AND t.id=tm.team_id
  WHERE tm.tenant_id=NEW.tenant_id AND tm.membership_id=member ORDER BY tm.id FOR SHARE OF tm,t;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(NEW.delegation->'teamIds') wanted WHERE NOT EXISTS(
  SELECT 1 FROM organization_team_members tm JOIN organization_teams t ON t.tenant_id=tm.tenant_id AND t.id=tm.team_id
   WHERE tm.tenant_id=NEW.tenant_id AND tm.membership_id=member AND tm.team_id=wanted::uuid AND tm.active AND t.status='active')) THEN
  RAISE EXCEPTION 'integration_client_team_exceeds_member' USING ERRCODE='23514';END IF;
 NEW.creation_transaction_id:=pg_current_xact_id()::text;NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER integration_client_guard BEFORE INSERT OR UPDATE OR DELETE ON integration_api_clients FOR EACH ROW EXECUTE FUNCTION guard_integration_client();
--> statement-breakpoint
CREATE FUNCTION guard_integration_client_event() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE client integration_api_clients%ROWTYPE;actor uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'integration_client_event_immutable' USING ERRCODE='23514';END IF;
 SELECT * INTO client FROM integration_api_clients WHERE id=NEW.client_id AND tenant_id=NEW.tenant_id FOR SHARE;
 IF client.id IS NULL OR NEW.actor_user_id IS DISTINCT FROM actor OR NEW.creation_transaction_id IS NOT NULL
  OR length(NEW.idempotency_key) NOT BETWEEN 8 AND 200 OR NEW.reason_code!~'^[A-Z0-9][A-Z0-9._-]{0,99}$' THEN
  RAISE EXCEPTION 'integration_client_event_invalid' USING ERRCODE='23514';END IF;
 PERFORM integration_client_require_manager(NEW.tenant_id,actor,client.created_by);
 IF NEW.action='created' AND(client.creation_transaction_id IS DISTINCT FROM pg_current_xact_id()::text OR NEW.actor_user_id IS DISTINCT FROM client.created_by
  OR NEW.reason_code<>'CLIENT_CREATED' OR NEW.idempotency_key<>client.idempotency_key) THEN
  RAISE EXCEPTION 'integration_client_birth_event_invalid' USING ERRCODE='23514';END IF;
 NEW.creation_transaction_id:=pg_current_xact_id()::text;NEW.occurred_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER integration_client_event_guard BEFORE INSERT OR UPDATE OR DELETE ON integration_api_client_events FOR EACH ROW EXECUTE FUNCTION guard_integration_client_event();
--> statement-breakpoint
CREATE FUNCTION require_integration_client_closure() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE client integration_api_clients%ROWTYPE;action_name text;born text:=pg_current_xact_id()::text;
 own_xmin text:=(pg_current_xact_id()::text::numeric%4294967296)::text;event integration_api_client_events%ROWTYPE;actor uuid;
BEGIN
 IF TG_TABLE_NAME='integration_api_clients' THEN
  SELECT * INTO client FROM integration_api_clients WHERE id=NEW.id AND tenant_id=NEW.tenant_id;
  action_name:=CASE WHEN TG_OP='INSERT' THEN 'created' ELSE 'revoked' END;
 ELSE
  SELECT * INTO client FROM integration_api_clients WHERE id=NEW.client_id AND tenant_id=NEW.tenant_id;
  action_name:=NEW.action;
 END IF;
 SELECT * INTO event FROM integration_api_client_events e WHERE e.client_id=client.id AND e.tenant_id=client.tenant_id AND e.action=action_name AND e.creation_transaction_id=born;
 actor:=nullif(current_setting('app.user_id',true),'')::uuid;
 IF client.id IS NULL OR event.id IS NULL OR event.actor_user_id IS DISTINCT FROM actor
  OR(action_name='created' AND(client.creation_transaction_id IS DISTINCT FROM born OR client.delegation IS NULL OR event.idempotency_key<>client.idempotency_key))
  OR(action_name='revoked' AND(client.status<>'revoked' OR client.revoked_at IS NULL OR client.revocation_transaction_id IS DISTINCT FROM born)) THEN
  RAISE EXCEPTION 'integration_client_event_required' USING ERRCODE='23514';END IF;
 IF (SELECT count(*) FROM integration_api_client_events e WHERE e.client_id=client.id AND e.tenant_id=client.tenant_id AND e.action=action_name AND e.creation_transaction_id=born)<>1 THEN
  RAISE EXCEPTION 'integration_client_single_event_required' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM audit_events a WHERE a.tenant_id=client.tenant_id AND a.actor_user_id=actor
  AND a.entity_type='integration_api_client' AND a.entity_id=client.id AND a.result='success'
  AND a.action=CASE WHEN action_name='created' THEN 'integration.api_client.create' ELSE 'integration.api_client.revoke' END AND a.xmin::text=own_xmin
  AND CASE WHEN action_name='created' THEN a.metadata->>'requestChecksum'=client.delegation->>'requestChecksum' ELSE a.metadata->>'reasonCode'=event.reason_code END) THEN
  RAISE EXCEPTION 'integration_client_audit_required' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER integration_client_closure AFTER INSERT OR UPDATE ON integration_api_clients
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_integration_client_closure();
CREATE CONSTRAINT TRIGGER integration_client_event_closure AFTER INSERT ON integration_api_client_events
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_integration_client_closure();
--> statement-breakpoint
-- The old loader cannot represent a per-permission ceiling. Keeping it usable
-- for new keys would turn a self-scoped key back into tenant authority.
CREATE OR REPLACE FUNCTION authenticate_integration_api_client(requested_client_id uuid,requested_secret_digest text)
RETURNS TABLE(tenant_id uuid,created_by uuid,scopes jsonb) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT NULL::uuid,NULL::uuid,NULL::jsonb WHERE false
$$;
CREATE FUNCTION authenticate_integration_api_client_v2(requested_client_id uuid,requested_secret_digest text)
RETURNS TABLE(tenant_id uuid,created_by uuid,scopes jsonb,delegation jsonb)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT c.tenant_id,c.created_by,c.scopes,c.delegation FROM public.integration_api_clients c
 WHERE c.id=requested_client_id AND c.secret_digest=requested_secret_digest AND c.status='active' AND c.delegation IS NOT NULL
  AND(c.expires_at IS NULL OR c.expires_at>clock_timestamp())
$$;
REVOKE ALL ON FUNCTION authenticate_integration_api_client_v2(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authenticate_integration_api_client_v2(uuid,text) TO yummyai_app;
