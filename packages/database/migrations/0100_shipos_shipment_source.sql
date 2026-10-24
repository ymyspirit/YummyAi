ALTER TABLE shipos_connections ADD COLUMN IF NOT EXISTS channel_mappings jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(channel_mappings) = 'array');
--> statement-breakpoint
ALTER TABLE shipment_versions ADD COLUMN IF NOT EXISTS shipos_source jsonb CHECK (shipos_source IS NULL OR jsonb_typeof(shipos_source) = 'object');
