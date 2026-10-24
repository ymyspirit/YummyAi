ALTER TABLE marketplace_accounts ADD COLUMN deleted_at timestamptz;
ALTER TABLE marketplace_accounts ADD CONSTRAINT marketplace_accounts_deleted_disabled_check
  CHECK (deleted_at IS NULL OR status = 'disabled');
CREATE INDEX marketplace_accounts_live_idx
  ON marketplace_accounts (tenant_id, updated_at) WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE FUNCTION guard_removed_marketplace_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.deleted_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Removed marketplace account cannot be changed' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER marketplace_accounts_removed_guard
  BEFORE UPDATE ON marketplace_accounts
  FOR EACH ROW EXECUTE FUNCTION guard_removed_marketplace_account();
