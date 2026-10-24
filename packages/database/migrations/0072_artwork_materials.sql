ALTER TABLE "artwork_master_versions" DROP CONSTRAINT "artwork_master_versions_mode_check";--> statement-breakpoint
ALTER TABLE "artwork_master_versions" ADD COLUMN "materials" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "artwork_master_versions" ADD COLUMN "layout" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "artwork_master_versions" ADD CONSTRAINT "artwork_master_versions_mode_check" CHECK ("artwork_master_versions"."mode" in ('fixed','personalized_text','customer_image','mixed') and "artwork_master_versions"."version_number" > 0);