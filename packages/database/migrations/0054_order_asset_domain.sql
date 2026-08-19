ALTER TABLE "asset_files" DROP CONSTRAINT IF EXISTS "asset_files_domain_check";
--> statement-breakpoint
ALTER TABLE "asset_files" ADD CONSTRAINT "asset_files_domain_check" CHECK ("asset_domain" in ('research', 'authorized', 'order'));
