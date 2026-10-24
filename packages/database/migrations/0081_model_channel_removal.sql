ALTER TABLE model_provider_configs DROP CONSTRAINT model_provider_configs_status_check;
--> statement-breakpoint
ALTER TABLE model_provider_configs ADD CONSTRAINT model_provider_configs_status_check CHECK (status IN ('enabled', 'disabled', 'deleted'));
--> statement-breakpoint
DROP INDEX model_provider_configs_tenant_label_unique;
--> statement-breakpoint
CREATE UNIQUE INDEX model_provider_configs_tenant_label_unique ON model_provider_configs (tenant_id, label) WHERE status <> 'deleted';
