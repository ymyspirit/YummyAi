ALTER TABLE orders
 ADD COLUMN provider_updated_at timestamptz,
 ADD COLUMN provider_block_reason text,
 ADD COLUMN provider_hold boolean NOT NULL DEFAULT false,
 ADD CONSTRAINT orders_provider_hold_check CHECK(NOT provider_hold OR side_state IS NOT DISTINCT FROM 'on_hold'),
 ADD CONSTRAINT orders_provider_block_check CHECK(provider_block_reason IS NULL OR side_state IS NOT NULL OR workflow_state IN ('shipped','completed'));
