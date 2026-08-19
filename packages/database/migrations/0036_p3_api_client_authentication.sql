CREATE FUNCTION authenticate_integration_api_client(
  requested_client_id uuid,
  requested_secret_digest text
)
RETURNS TABLE (
  tenant_id uuid,
  created_by uuid,
  scopes jsonb
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT client.tenant_id, client.created_by, client.scopes
  FROM public.integration_api_clients AS client
  WHERE client.id = requested_client_id
    AND client.secret_digest = requested_secret_digest
    AND client.status = 'active'
    AND (client.expires_at IS NULL OR client.expires_at > clock_timestamp())
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION authenticate_integration_api_client(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION authenticate_integration_api_client(uuid, text) TO yummyai_app;
