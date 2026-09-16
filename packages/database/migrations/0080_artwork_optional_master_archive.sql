ALTER TABLE artwork_masters ADD COLUMN archived_at timestamptz;
--> statement-breakpoint
ALTER TABLE artwork_master_versions ALTER COLUMN creative_version_id DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE artwork_master_versions ALTER COLUMN asset_id DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE artwork_master_versions ADD CONSTRAINT artwork_master_versions_optional_master_check CHECK ((creative_version_id IS NOT NULL AND asset_id IS NOT NULL) OR (creative_version_id IS NULL AND asset_id IS NULL AND mode <> 'fixed'));
