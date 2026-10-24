-- Some local databases applied the original 0094 before this nullable field was
-- added. Preserve all production history and repair the schema additively.
ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS request_checksum text
  CHECK (request_checksum IS NULL OR request_checksum ~ '^[a-f0-9]{64}$');
