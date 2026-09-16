ALTER TABLE product_specification_versions ALTER COLUMN process_profile_version_id DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE product_specification_versions ADD CONSTRAINT product_specification_versions_draft_process_check CHECK (process_profile_version_id IS NOT NULL OR facts->>'factsConfirmed' = 'false');
