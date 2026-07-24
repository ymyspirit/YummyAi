CREATE TABLE "forecast_accuracy_evaluations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"evaluation_window_start" timestamp with time zone NOT NULL,
	"evaluation_window_end" timestamp with time zone NOT NULL,
	"actual_evidence_refs" jsonb NOT NULL,
	"mean_absolute_error" bigint NOT NULL,
	"weighted_absolute_percentage_error_bps" integer,
	"bias_bps" integer,
	"input_checksum" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"evaluated_by" uuid,
	"evaluated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "forecast_accuracy_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "forecast_accuracy_id_check" CHECK (substring("forecast_accuracy_evaluations"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "forecast_accuracy_window_check" CHECK ("forecast_accuracy_evaluations"."evaluation_window_end" > "forecast_accuracy_evaluations"."evaluation_window_start"),
	CONSTRAINT "forecast_accuracy_values_check" CHECK ("forecast_accuracy_evaluations"."mean_absolute_error" >= 0 and ("forecast_accuracy_evaluations"."weighted_absolute_percentage_error_bps" is null or "forecast_accuracy_evaluations"."weighted_absolute_percentage_error_bps" >= 0)),
	CONSTRAINT "forecast_accuracy_checksum_check" CHECK ("forecast_accuracy_evaluations"."input_checksum" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "forecast_override_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"reason_code" text NOT NULL,
	"points" jsonb NOT NULL,
	"checksum" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "forecast_overrides_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "forecast_overrides_id_check" CHECK (substring("forecast_override_versions"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "forecast_overrides_version_check" CHECK ("forecast_override_versions"."version_number" > 0),
	CONSTRAINT "forecast_overrides_checksum_check" CHECK ("forecast_override_versions"."checksum" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "forecast_points" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"values" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "forecast_points_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "forecast_points_id_check" CHECK (substring("forecast_points"."id"::text from 15 for 1) = '7')
);
--> statement-breakpoint
CREATE TABLE "forecast_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"metric" text NOT NULL,
	"scope_type" text NOT NULL,
	"scope_key" text NOT NULL,
	"grain" text NOT NULL,
	"model" text NOT NULL,
	"model_version" text NOT NULL,
	"input_window_start" timestamp with time zone NOT NULL,
	"input_window_end" timestamp with time zone NOT NULL,
	"evidence_cutoff_at" timestamp with time zone NOT NULL,
	"horizon_start" timestamp with time zone NOT NULL,
	"horizon_end" timestamp with time zone NOT NULL,
	"quantiles_bps" jsonb NOT NULL,
	"input_points" jsonb NOT NULL,
	"input_checksum" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"generated_by" uuid,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "forecast_runs_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "forecast_runs_id_check" CHECK (substring("forecast_runs"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "forecast_runs_metric_check" CHECK ("forecast_runs"."metric" in ('sales_units','inventory_available','profit_minor')),
	CONSTRAINT "forecast_runs_scope_check" CHECK ("forecast_runs"."scope_type" in ('tenant','platform','store','listing','sku')),
	CONSTRAINT "forecast_runs_grain_check" CHECK ("forecast_runs"."grain" in ('day','week','month')),
	CONSTRAINT "forecast_runs_model_check" CHECK ("forecast_runs"."model" in ('seasonal_naive_v1','moving_average_v1')),
	CONSTRAINT "forecast_runs_window_check" CHECK ("forecast_runs"."input_window_end" > "forecast_runs"."input_window_start" and "forecast_runs"."evidence_cutoff_at" >= "forecast_runs"."input_window_end" and "forecast_runs"."horizon_start" >= "forecast_runs"."input_window_end" and "forecast_runs"."horizon_end" > "forecast_runs"."horizon_start"),
	CONSTRAINT "forecast_runs_checksum_check" CHECK ("forecast_runs"."input_checksum" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "operating_metric_definition_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"definition_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"unit" text NOT NULL,
	"source" text NOT NULL,
	"maximum_age_seconds" integer NOT NULL,
	"minimum_completeness_bps" integer NOT NULL,
	"reason_code" text NOT NULL,
	"checksum" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operating_metric_versions_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "operating_metric_versions_id_check" CHECK (substring("operating_metric_definition_versions"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "operating_metric_versions_number_check" CHECK ("operating_metric_definition_versions"."version_number" > 0),
	CONSTRAINT "operating_metric_versions_unit_check" CHECK ("operating_metric_definition_versions"."unit" in ('count','minor','basis_points','seconds')),
	CONSTRAINT "operating_metric_versions_source_check" CHECK ("operating_metric_definition_versions"."source" in ('forecast','inventory','finance','webhook','system')),
	CONSTRAINT "operating_metric_versions_threshold_check" CHECK ("operating_metric_definition_versions"."maximum_age_seconds" > 0 and "operating_metric_definition_versions"."minimum_completeness_bps" between 0 and 10000),
	CONSTRAINT "operating_metric_versions_checksum_check" CHECK ("operating_metric_definition_versions"."checksum" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "operating_metric_definitions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operating_metric_definitions_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "operating_metric_definitions_id_check" CHECK (substring("operating_metric_definitions"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "operating_metric_definitions_version_check" CHECK ("operating_metric_definitions"."current_version" > 0),
	CONSTRAINT "operating_metric_definitions_status_check" CHECK ("operating_metric_definitions"."status" in ('active','inactive'))
);
--> statement-breakpoint
CREATE TABLE "operating_metric_projections" (
	"tenant_id" uuid NOT NULL,
	"definition_id" uuid NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operating_metric_projections_pk" PRIMARY KEY("tenant_id","definition_id")
);
--> statement-breakpoint
CREATE TABLE "operating_metric_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"definition_id" uuid NOT NULL,
	"definition_version_id" uuid NOT NULL,
	"definition_version" integer NOT NULL,
	"value" bigint,
	"observed_at" timestamp with time zone NOT NULL,
	"completeness_bps" integer NOT NULL,
	"source_refs" jsonb NOT NULL,
	"drill_through_href" text NOT NULL,
	"checksum" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"recorded_by" uuid,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operating_metric_snapshots_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "operating_metric_snapshots_id_check" CHECK (substring("operating_metric_snapshots"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "operating_metric_snapshots_completeness_check" CHECK ("operating_metric_snapshots"."completeness_bps" between 0 and 10000),
	CONSTRAINT "operating_metric_snapshots_href_check" CHECK ("operating_metric_snapshots"."drill_through_href" like '/%'),
	CONSTRAINT "operating_metric_snapshots_checksum_check" CHECK ("operating_metric_snapshots"."checksum" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "operating_projection_rebuilds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source_snapshot_count" integer NOT NULL,
	"projection_count" integer NOT NULL,
	"before_checksum" text NOT NULL,
	"after_checksum" text NOT NULL,
	"equivalent" boolean NOT NULL,
	"idempotency_key" text NOT NULL,
	"rebuilt_by" uuid,
	"rebuilt_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operating_projection_rebuilds_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "operating_projection_rebuilds_id_check" CHECK (substring("operating_projection_rebuilds"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "operating_projection_rebuilds_counts_check" CHECK ("operating_projection_rebuilds"."source_snapshot_count" >= 0 and "operating_projection_rebuilds"."projection_count" >= 0),
	CONSTRAINT "operating_projection_rebuilds_checksums_check" CHECK ("operating_projection_rebuilds"."before_checksum" ~ '^[0-9a-f]{64}$' and "operating_projection_rebuilds"."after_checksum" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "operating_reconciliation_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"reconciliation_id" uuid NOT NULL,
	"action" text NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"reason_code" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"actor_user_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operating_reconciliation_events_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "operating_reconciliation_events_id_check" CHECK (substring("operating_reconciliation_events"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "operating_reconciliation_events_action_check" CHECK ("operating_reconciliation_events"."action" in ('opened','resolved','dismissed'))
);
--> statement-breakpoint
CREATE TABLE "operating_reconciliations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"category" text NOT NULL,
	"code" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"metric_snapshot_id" uuid,
	"source_ref" jsonb,
	"detail_checksum" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"opened_by" uuid,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "operating_reconciliations_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "operating_reconciliations_id_check" CHECK (substring("operating_reconciliations"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "operating_reconciliations_category_check" CHECK ("operating_reconciliations"."category" in ('freshness','completeness','projection','provider','webhook')),
	CONSTRAINT "operating_reconciliations_status_check" CHECK ("operating_reconciliations"."status" in ('open','resolved','dismissed')),
	CONSTRAINT "operating_reconciliations_checksum_check" CHECK ("operating_reconciliations"."detail_checksum" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "integration_api_client_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"action" text NOT NULL,
	"reason_code" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"actor_user_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_api_client_events_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "integration_api_client_events_id_check" CHECK (substring("integration_api_client_events"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "integration_api_client_events_action_check" CHECK ("integration_api_client_events"."action" in ('created','revoked'))
);
--> statement-breakpoint
CREATE TABLE "integration_api_clients" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"label" text NOT NULL,
	"key_prefix" text NOT NULL,
	"secret_digest" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone,
	"idempotency_key" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "integration_api_clients_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "integration_api_clients_id_check" CHECK (substring("integration_api_clients"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "integration_api_clients_status_check" CHECK ("integration_api_clients"."status" in ('active','revoked')),
	CONSTRAINT "integration_api_clients_digest_check" CHECK ("integration_api_clients"."secret_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "integration_retention_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"payloads_before" timestamp with time zone NOT NULL,
	"redacted_event_count" integer NOT NULL,
	"checksum" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"completed_by" uuid,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_retention_runs_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "integration_retention_runs_id_check" CHECK (substring("integration_retention_runs"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "integration_retention_runs_count_check" CHECK ("integration_retention_runs"."redacted_event_count" >= 0),
	CONSTRAINT "integration_retention_runs_checksum_check" CHECK ("integration_retention_runs"."checksum" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"replay_of_delivery_id" uuid,
	"idempotency_key" text NOT NULL,
	"requested_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "webhook_deliveries_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "webhook_deliveries_id_check" CHECK (substring("webhook_deliveries"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "webhook_deliveries_status_check" CHECK ("webhook_deliveries"."status" in ('pending','delivering','retry_scheduled','succeeded','dead_letter')),
	CONSTRAINT "webhook_deliveries_attempts_check" CHECK ("webhook_deliveries"."attempt_count" >= 0 and "webhook_deliveries"."max_attempts" between 1 and 10 and "webhook_deliveries"."attempt_count" <= "webhook_deliveries"."max_attempts")
);
--> statement-breakpoint
CREATE TABLE "webhook_delivery_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"delivery_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"request_timestamp" timestamp with time zone NOT NULL,
	"signature_version" text NOT NULL,
	"response_status" integer,
	"outcome" text NOT NULL,
	"failure_code" text,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_delivery_attempts_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "webhook_delivery_attempts_id_check" CHECK (substring("webhook_delivery_attempts"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "webhook_delivery_attempts_number_check" CHECK ("webhook_delivery_attempts"."attempt_number" > 0),
	CONSTRAINT "webhook_delivery_attempts_signature_check" CHECK ("webhook_delivery_attempts"."signature_version" = 'v1'),
	CONSTRAINT "webhook_delivery_attempts_status_check" CHECK ("webhook_delivery_attempts"."response_status" is null or "webhook_delivery_attempts"."response_status" between 100 and 599),
	CONSTRAINT "webhook_delivery_attempts_outcome_check" CHECK ("webhook_delivery_attempts"."outcome" in ('succeeded','retryable_failure','terminal_failure'))
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoint_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"action" text NOT NULL,
	"reason_code" text NOT NULL,
	"configuration_checksum" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"actor_user_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_endpoint_events_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "webhook_endpoint_events_id_check" CHECK (substring("webhook_endpoint_events"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "webhook_endpoint_events_version_check" CHECK ("webhook_endpoint_events"."version" > 0),
	CONSTRAINT "webhook_endpoint_events_action_check" CHECK ("webhook_endpoint_events"."action" in ('created','updated','secret_rotated')),
	CONSTRAINT "webhook_endpoint_events_checksum_check" CHECK ("webhook_endpoint_events"."configuration_checksum" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"label" text NOT NULL,
	"url" text NOT NULL,
	"event_types" jsonb NOT NULL,
	"max_attempts" integer NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"encrypted_signing_secret" text NOT NULL,
	"signing_key_prefix" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_endpoints_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "webhook_endpoints_id_check" CHECK (substring("webhook_endpoints"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "webhook_endpoints_attempts_check" CHECK ("webhook_endpoints"."max_attempts" between 1 and 10),
	CONSTRAINT "webhook_endpoints_status_check" CHECK ("webhook_endpoints"."status" in ('active','disabled')),
	CONSTRAINT "webhook_endpoints_version_check" CHECK ("webhook_endpoints"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" uuid NOT NULL,
	"payload" jsonb,
	"payload_checksum" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"idempotency_key" text NOT NULL,
	"recorded_by" uuid,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload_redacted_at" timestamp with time zone,
	CONSTRAINT "webhook_events_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "webhook_events_id_check" CHECK (substring("webhook_events"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "webhook_events_type_check" CHECK ("webhook_events"."event_type" in ('forecast.completed','forecast.overridden','operating.reconciliation.opened','operating.reconciliation.resolved','webhook.test')),
	CONSTRAINT "webhook_events_checksum_check" CHECK ("webhook_events"."payload_checksum" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "forecast_accuracy_evaluations" ADD CONSTRAINT "forecast_accuracy_evaluations_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forecast_accuracy_evaluations" ADD CONSTRAINT "forecast_accuracy_evaluations_evaluated_by_app_users_id_fk" FOREIGN KEY ("evaluated_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forecast_accuracy_evaluations" ADD CONSTRAINT "forecast_accuracy_run_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."forecast_runs"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forecast_override_versions" ADD CONSTRAINT "forecast_override_versions_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forecast_override_versions" ADD CONSTRAINT "forecast_override_versions_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forecast_override_versions" ADD CONSTRAINT "forecast_overrides_run_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."forecast_runs"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forecast_points" ADD CONSTRAINT "forecast_points_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forecast_points" ADD CONSTRAINT "forecast_points_run_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."forecast_runs"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forecast_runs" ADD CONSTRAINT "forecast_runs_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forecast_runs" ADD CONSTRAINT "forecast_runs_generated_by_app_users_id_fk" FOREIGN KEY ("generated_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operating_metric_definition_versions" ADD CONSTRAINT "operating_metric_definition_versions_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operating_metric_definition_versions" ADD CONSTRAINT "operating_metric_definition_versions_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operating_metric_definition_versions" ADD CONSTRAINT "operating_metric_versions_definition_fk" FOREIGN KEY ("tenant_id","definition_id") REFERENCES "public"."operating_metric_definitions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operating_metric_definitions" ADD CONSTRAINT "operating_metric_definitions_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operating_metric_definitions" ADD CONSTRAINT "operating_metric_definitions_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operating_metric_projections" ADD CONSTRAINT "operating_metric_projections_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operating_metric_projections" ADD CONSTRAINT "operating_metric_projections_definition_fk" FOREIGN KEY ("tenant_id","definition_id") REFERENCES "public"."operating_metric_definitions"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operating_metric_projections" ADD CONSTRAINT "operating_metric_projections_snapshot_fk" FOREIGN KEY ("tenant_id","snapshot_id") REFERENCES "public"."operating_metric_snapshots"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operating_metric_snapshots" ADD CONSTRAINT "operating_metric_snapshots_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operating_metric_snapshots" ADD CONSTRAINT "operating_metric_snapshots_recorded_by_app_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operating_metric_snapshots" ADD CONSTRAINT "operating_metric_snapshots_definition_fk" FOREIGN KEY ("tenant_id","definition_id") REFERENCES "public"."operating_metric_definitions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operating_metric_snapshots" ADD CONSTRAINT "operating_metric_snapshots_version_fk" FOREIGN KEY ("tenant_id","definition_version_id") REFERENCES "public"."operating_metric_definition_versions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operating_projection_rebuilds" ADD CONSTRAINT "operating_projection_rebuilds_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operating_projection_rebuilds" ADD CONSTRAINT "operating_projection_rebuilds_rebuilt_by_app_users_id_fk" FOREIGN KEY ("rebuilt_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operating_reconciliation_events" ADD CONSTRAINT "operating_reconciliation_events_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operating_reconciliation_events" ADD CONSTRAINT "operating_reconciliation_events_actor_user_id_app_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operating_reconciliation_events" ADD CONSTRAINT "operating_reconciliation_events_reconciliation_fk" FOREIGN KEY ("tenant_id","reconciliation_id") REFERENCES "public"."operating_reconciliations"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operating_reconciliations" ADD CONSTRAINT "operating_reconciliations_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operating_reconciliations" ADD CONSTRAINT "operating_reconciliations_opened_by_app_users_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operating_reconciliations" ADD CONSTRAINT "operating_reconciliations_snapshot_fk" FOREIGN KEY ("tenant_id","metric_snapshot_id") REFERENCES "public"."operating_metric_snapshots"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_api_client_events" ADD CONSTRAINT "integration_api_client_events_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_api_client_events" ADD CONSTRAINT "integration_api_client_events_actor_user_id_app_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_api_client_events" ADD CONSTRAINT "integration_api_client_events_client_fk" FOREIGN KEY ("tenant_id","client_id") REFERENCES "public"."integration_api_clients"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_api_clients" ADD CONSTRAINT "integration_api_clients_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_api_clients" ADD CONSTRAINT "integration_api_clients_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_retention_runs" ADD CONSTRAINT "integration_retention_runs_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_retention_runs" ADD CONSTRAINT "integration_retention_runs_completed_by_app_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_requested_by_app_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_event_fk" FOREIGN KEY ("tenant_id","event_id") REFERENCES "public"."webhook_events"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_fk" FOREIGN KEY ("tenant_id","endpoint_id") REFERENCES "public"."webhook_endpoints"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_delivery_attempts" ADD CONSTRAINT "webhook_delivery_attempts_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_delivery_attempts" ADD CONSTRAINT "webhook_delivery_attempts_delivery_fk" FOREIGN KEY ("tenant_id","delivery_id") REFERENCES "public"."webhook_deliveries"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoint_events" ADD CONSTRAINT "webhook_endpoint_events_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoint_events" ADD CONSTRAINT "webhook_endpoint_events_actor_user_id_app_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoint_events" ADD CONSTRAINT "webhook_endpoint_events_endpoint_fk" FOREIGN KEY ("tenant_id","endpoint_id") REFERENCES "public"."webhook_endpoints"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_recorded_by_app_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "forecast_accuracy_idempotency_unique" ON "forecast_accuracy_evaluations" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "forecast_overrides_version_unique" ON "forecast_override_versions" USING btree ("tenant_id","run_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "forecast_overrides_idempotency_unique" ON "forecast_override_versions" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "forecast_points_period_unique" ON "forecast_points" USING btree ("tenant_id","run_id","period_start");--> statement-breakpoint
CREATE UNIQUE INDEX "forecast_runs_idempotency_unique" ON "forecast_runs" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "forecast_runs_scope_idx" ON "forecast_runs" USING btree ("tenant_id","metric","scope_type","scope_key","generated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "operating_metric_versions_number_unique" ON "operating_metric_definition_versions" USING btree ("tenant_id","definition_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "operating_metric_versions_idempotency_unique" ON "operating_metric_definition_versions" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "operating_metric_definitions_key_unique" ON "operating_metric_definitions" USING btree ("tenant_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "operating_metric_snapshots_idempotency_unique" ON "operating_metric_snapshots" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "operating_metric_snapshots_observed_idx" ON "operating_metric_snapshots" USING btree ("tenant_id","definition_id","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "operating_projection_rebuilds_idempotency_unique" ON "operating_projection_rebuilds" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "operating_reconciliation_events_idempotency_unique" ON "operating_reconciliation_events" USING btree ("tenant_id","reconciliation_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "operating_reconciliations_idempotency_unique" ON "operating_reconciliations" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "operating_reconciliations_status_idx" ON "operating_reconciliations" USING btree ("tenant_id","status","opened_at");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_api_client_events_idempotency_unique" ON "integration_api_client_events" USING btree ("tenant_id","client_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_api_clients_prefix_unique" ON "integration_api_clients" USING btree ("key_prefix");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_api_clients_idempotency_unique" ON "integration_api_clients" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "integration_api_clients_status_idx" ON "integration_api_clients" USING btree ("tenant_id","status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_retention_runs_idempotency_unique" ON "integration_retention_runs" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_idempotency_unique" ON "webhook_deliveries" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_status_idx" ON "webhook_deliveries" USING btree ("tenant_id","status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_delivery_attempts_number_unique" ON "webhook_delivery_attempts" USING btree ("tenant_id","delivery_id","attempt_number");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_endpoint_events_version_unique" ON "webhook_endpoint_events" USING btree ("tenant_id","endpoint_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_endpoint_events_idempotency_unique" ON "webhook_endpoint_events" USING btree ("tenant_id","endpoint_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_endpoints_idempotency_unique" ON "webhook_endpoints" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "webhook_endpoints_status_idx" ON "webhook_endpoints" USING btree ("tenant_id","status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_idempotency_unique" ON "webhook_events" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "webhook_events_recorded_idx" ON "webhook_events" USING btree ("tenant_id","event_type","recorded_at");
--> statement-breakpoint
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'forecast_runs', 'forecast_points', 'forecast_accuracy_evaluations', 'forecast_override_versions',
    'operating_metric_definitions', 'operating_metric_definition_versions', 'operating_metric_snapshots',
    'operating_metric_projections', 'operating_reconciliations', 'operating_reconciliation_events',
    'operating_projection_rebuilds', 'integration_api_clients', 'integration_api_client_events',
    'webhook_endpoints', 'webhook_endpoint_events', 'webhook_events', 'webhook_deliveries',
    'webhook_delivery_attempts', 'integration_retention_runs'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO yummyai_app USING (tenant_id = (SELECT nullif(current_setting(''app.tenant_id'', true), '''')::uuid)) WITH CHECK (tenant_id = (SELECT nullif(current_setting(''app.tenant_id'', true), '''')::uuid))',
      table_name || '_tenant_policy', table_name
    );
  END LOOP;
END $$;
--> statement-breakpoint
GRANT SELECT, INSERT ON "forecast_runs", "forecast_points", "forecast_accuracy_evaluations", "forecast_override_versions" TO yummyai_app;
GRANT SELECT, INSERT, UPDATE ON "operating_metric_definitions" TO yummyai_app;
GRANT SELECT, INSERT ON "operating_metric_definition_versions", "operating_metric_snapshots", "operating_reconciliation_events", "operating_projection_rebuilds" TO yummyai_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "operating_metric_projections" TO yummyai_app;
GRANT SELECT, INSERT, UPDATE ON "operating_reconciliations" TO yummyai_app;
GRANT SELECT, INSERT, UPDATE ON "integration_api_clients", "webhook_endpoints", "webhook_deliveries" TO yummyai_app;
GRANT SELECT, INSERT ON "integration_api_client_events", "webhook_endpoint_events", "webhook_delivery_attempts", "integration_retention_runs" TO yummyai_app;
GRANT SELECT, INSERT ON "webhook_events" TO yummyai_app;
GRANT UPDATE ("payload", "payload_redacted_at") ON "webhook_events" TO yummyai_app;
