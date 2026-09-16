ALTER TABLE sales_recipe_versions DROP CONSTRAINT sales_recipe_versions_status_check;
--> statement-breakpoint
ALTER TABLE sales_recipe_versions ADD CONSTRAINT sales_recipe_versions_status_check
CHECK (status IN ('pending_adaptation', 'in_adaptation', 'ready_for_customization', 'approved') AND version_number > 0);
