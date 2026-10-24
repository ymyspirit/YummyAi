-- A separate immutable protocol identity keeps Agent preparation outside the
-- legacy native recovery execution path. All original actor, source, input,
-- generation, lease and retention constraints remain unchanged.
CREATE OR REPLACE FUNCTION guard_order_fulfillment_command() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.created_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid
   OR NEW.authority_snapshot->>'tenantId' IS DISTINCT FROM NEW.tenant_id::text
   OR NEW.authority_snapshot->>'userId' IS DISTINCT FROM NEW.created_by::text
   OR NEW.contract_version NOT IN ('fulfillment-command-v1','erp-agent-fulfillment-command-v1') OR NEW.status<>'prepared' OR NEW.generation<>0
   OR NEW.lease_token IS NOT NULL OR NEW.encrypted_input IS NULL OR NEW.acknowledged_at IS NOT NULL
   OR NEW.redacted_at IS NOT NULL OR NOT order_fulfillment_command_source_available(NEW)
   OR (SELECT count(DISTINCT id) FROM jsonb_array_elements_text(NEW.line_ids) ids(id))<>jsonb_array_length(NEW.line_ids) THEN
   RAISE EXCEPTION 'fulfillment intent must bind original actor, retained source and immutable identity' USING ERRCODE='23514';
  END IF;
 ELSE
  IF (to_jsonb(OLD)-ARRAY['status','generation','lease_token','lease_expires_at','error_code','acknowledged_at','redacted_at','encrypted_input'])
   IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['status','generation','lease_token','lease_expires_at','error_code','acknowledged_at','redacted_at','encrypted_input'])
   OR (OLD.encrypted_input IS DISTINCT FROM NEW.encrypted_input AND NOT(OLD.encrypted_input IS NOT NULL AND NEW.encrypted_input IS NULL
    AND (NEW.acknowledged_at IS NOT NULL OR NEW.expires_at<=clock_timestamp() OR NOT order_fulfillment_command_source_available(NEW)
     OR (NEW.created_by=nullif(current_setting('app.user_id',true),'')::uuid AND NEW.status='expired' AND NEW.error_code='source_unavailable'))))
   OR NEW.generation<OLD.generation OR NEW.generation>OLD.generation+1
   OR (OLD.acknowledged_at IS NOT NULL AND NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at)
   OR (OLD.redacted_at IS NOT NULL AND NEW.redacted_at IS DISTINCT FROM OLD.redacted_at)
   OR (OLD.status IN ('cancelled','expired') AND NEW.status<>OLD.status) THEN
   RAISE EXCEPTION 'fulfillment original input and identity are immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.created_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid AND NOT(
   NEW.encrypted_input IS NULL AND NOT order_fulfillment_command_source_available(NEW)
   AND NEW.status IN ('uncertain','rejected','cancelled','expired') AND NEW.lease_token IS NULL
   AND NEW.acknowledged_at IS NOT DISTINCT FROM OLD.acknowledged_at) THEN
   RAISE EXCEPTION 'only original actor may recover fulfillment intent' USING ERRCODE='23514';
  END IF;
 END IF;
 IF NEW.status='executing' AND (NEW.encrypted_input IS NULL OR NEW.lease_token IS NULL OR NEW.generation<1
   OR NEW.acknowledged_at IS NOT NULL OR NEW.expires_at<=clock_timestamp() OR NOT order_fulfillment_command_source_available(NEW)) THEN
  RAISE EXCEPTION 'fulfillment execution requires retained original input and source' USING ERRCODE='23514';
 END IF;
 IF (NEW.status<>'executing' AND NEW.lease_token IS NOT NULL)
  OR (NEW.acknowledged_at IS NOT NULL AND NEW.encrypted_input IS NOT NULL) THEN
  RAISE EXCEPTION 'fulfillment lease and private-input lifecycle mismatch' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
