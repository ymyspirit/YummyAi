-- A new generation fences future operations. It does not certify historic sessions or snapshots.
ALTER TABLE marketplace_accounts
 ADD COLUMN authorization_generation uuid NOT NULL DEFAULT gen_random_uuid(),
 ADD COLUMN credential_use_id uuid,
 ADD COLUMN credential_use_started_at timestamptz,
 ADD COLUMN credential_refresh_state text NOT NULL DEFAULT 'known',
 ADD CONSTRAINT marketplace_accounts_refresh_state_check CHECK (credential_refresh_state IN ('known','pending','unknown')),
 ADD CONSTRAINT marketplace_accounts_credential_use_check CHECK (
   (credential_use_id IS NULL) = (credential_use_started_at IS NULL)
   AND (credential_refresh_state <> 'pending' OR credential_use_id IS NOT NULL));
--> statement-breakpoint
ALTER TABLE marketplace_authorization_sessions
 ADD COLUMN authorization_generation uuid,
 ADD COLUMN authority_ceiling jsonb;
--> statement-breakpoint
ALTER TABLE marketplace_capability_snapshots ADD COLUMN authorization_generation uuid;
