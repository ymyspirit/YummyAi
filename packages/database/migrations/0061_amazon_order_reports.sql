CREATE TABLE "amazon_order_report_batch_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"order_id" uuid,
	"external_order_id" text NOT NULL,
	"status" text NOT NULL,
	"error_code" text,
	CONSTRAINT "amazon_order_report_batch_items_id_uuidv7_check" CHECK (substring("amazon_order_report_batch_items"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "amazon_order_report_batch_items_status_check" CHECK ("amazon_order_report_batch_items"."status" in ('imported','duplicate','failed'))
);
--> statement-breakpoint
CREATE TABLE "amazon_order_report_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"marketplace_id" text NOT NULL,
	"file_name" text NOT NULL,
	"report_checksum" text NOT NULL,
	"encrypted_report" text,
	"row_count" integer NOT NULL,
	"order_count" integer NOT NULL,
	"new_order_count" integer DEFAULT 0 NOT NULL,
	"duplicate_order_count" integer DEFAULT 0 NOT NULL,
	"failed_order_count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'importing' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "amazon_order_report_batches_id_uuidv7_check" CHECK (substring("amazon_order_report_batches"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "amazon_order_report_batches_checksum_check" CHECK ("amazon_order_report_batches"."report_checksum" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "amazon_order_report_batches_status_check" CHECK ("amazon_order_report_batches"."status" in ('importing','completed','partial','failed')),
	CONSTRAINT "amazon_order_report_batches_counts_check" CHECK ("amazon_order_report_batches"."row_count" >= 0 and "amazon_order_report_batches"."order_count" >= 0 and "amazon_order_report_batches"."order_count" <= "amazon_order_report_batches"."row_count" and "amazon_order_report_batches"."new_order_count" >= 0 and "amazon_order_report_batches"."duplicate_order_count" >= 0 and "amazon_order_report_batches"."failed_order_count" >= 0 and "amazon_order_report_batches"."new_order_count" + "amazon_order_report_batches"."duplicate_order_count" + "amazon_order_report_batches"."failed_order_count" <= "amazon_order_report_batches"."order_count")
);
--> statement-breakpoint
CREATE TABLE "amazon_order_report_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"order_line_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"source_checksum" text NOT NULL,
	"encrypted_source" text,
	"item_total_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"last_error_code" text,
	"processing_token" uuid,
	"processing_started_at" timestamp with time zone,
	"current_version_id" uuid,
	"version_number" integer DEFAULT 0 NOT NULL,
	"reviewed_version_id" uuid,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "amazon_order_report_lines_id_uuidv7_check" CHECK (substring("amazon_order_report_lines"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "amazon_order_report_lines_checksum_check" CHECK ("amazon_order_report_lines"."source_checksum" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "amazon_order_report_lines_currency_check" CHECK ("amazon_order_report_lines"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "amazon_order_report_lines_state_check" CHECK ("amazon_order_report_lines"."state" in ('none','pending','processing','ready','partial','failed','expired')),
	CONSTRAINT "amazon_order_report_lines_version_check" CHECK ("amazon_order_report_lines"."version_number" >= 0),
	CONSTRAINT "amazon_order_report_lines_claim_check" CHECK (("amazon_order_report_lines"."processing_token" is null and "amazon_order_report_lines"."processing_started_at" is null) or ("amazon_order_report_lines"."processing_token" is not null and "amazon_order_report_lines"."processing_started_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "amazon_order_report_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"report_line_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"checksum" text NOT NULL,
	"encrypted_document" text,
	"encrypted_archive" text,
	"scan_engine" text NOT NULL,
	"scan_signature" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "amazon_order_report_versions_id_uuidv7_check" CHECK (substring("amazon_order_report_versions"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "amazon_order_report_versions_checksum_check" CHECK ("amazon_order_report_versions"."checksum" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "amazon_order_report_versions_number_check" CHECK ("amazon_order_report_versions"."version_number" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "amazon_order_report_batch_items_tenant_id_unique" ON "amazon_order_report_batch_items" USING btree ("tenant_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "amazon_order_report_batch_items_order_unique" ON "amazon_order_report_batch_items" USING btree ("tenant_id","batch_id","external_order_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "amazon_order_report_batches_tenant_id_unique" ON "amazon_order_report_batches" USING btree ("tenant_id","id");
--> statement-breakpoint
CREATE INDEX "amazon_order_report_batches_account_idx" ON "amazon_order_report_batches" USING btree ("tenant_id","account_id","created_at");
--> statement-breakpoint
CREATE INDEX "amazon_order_report_batches_retention_idx" ON "amazon_order_report_batches" USING btree ("tenant_id","expires_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "amazon_order_report_lines_tenant_id_unique" ON "amazon_order_report_lines" USING btree ("tenant_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "amazon_order_report_lines_line_unique" ON "amazon_order_report_lines" USING btree ("tenant_id","order_line_id");
--> statement-breakpoint
CREATE INDEX "amazon_order_report_lines_state_idx" ON "amazon_order_report_lines" USING btree ("tenant_id","state","updated_at");
--> statement-breakpoint
CREATE INDEX "amazon_order_report_lines_retention_idx" ON "amazon_order_report_lines" USING btree ("tenant_id","expires_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "amazon_order_report_versions_tenant_id_unique" ON "amazon_order_report_versions" USING btree ("tenant_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "amazon_order_report_versions_line_id_unique" ON "amazon_order_report_versions" USING btree ("tenant_id","report_line_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "amazon_order_report_versions_number_unique" ON "amazon_order_report_versions" USING btree ("tenant_id","report_line_id","version_number");
--> statement-breakpoint
CREATE INDEX "amazon_order_report_versions_retention_idx" ON "amazon_order_report_versions" USING btree ("tenant_id","expires_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "order_lines_tenant_order_id_unique" ON "order_lines" USING btree ("tenant_id","order_id","id");
--> statement-breakpoint
ALTER TABLE "amazon_order_report_batch_items" ADD CONSTRAINT "amazon_order_report_batch_items_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "amazon_order_report_batch_items" ADD CONSTRAINT "amazon_order_report_batch_items_batch_fk" FOREIGN KEY ("tenant_id","batch_id") REFERENCES "public"."amazon_order_report_batches"("tenant_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "amazon_order_report_batch_items" ADD CONSTRAINT "amazon_order_report_batch_items_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "amazon_order_report_batches" ADD CONSTRAINT "amazon_order_report_batches_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "amazon_order_report_batches" ADD CONSTRAINT "amazon_order_report_batches_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "amazon_order_report_batches" ADD CONSTRAINT "amazon_order_report_batches_account_fk" FOREIGN KEY ("tenant_id","account_id") REFERENCES "public"."marketplace_accounts"("tenant_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "amazon_order_report_lines" ADD CONSTRAINT "amazon_order_report_lines_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "amazon_order_report_lines" ADD CONSTRAINT "amazon_order_report_lines_reviewed_by_app_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "amazon_order_report_lines" ADD CONSTRAINT "amazon_order_report_lines_order_line_fk" FOREIGN KEY ("tenant_id","order_id","order_line_id") REFERENCES "public"."order_lines"("tenant_id","order_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "amazon_order_report_lines" ADD CONSTRAINT "amazon_order_report_lines_batch_fk" FOREIGN KEY ("tenant_id","batch_id") REFERENCES "public"."amazon_order_report_batches"("tenant_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "amazon_order_report_versions" ADD CONSTRAINT "amazon_order_report_versions_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "amazon_order_report_versions" ADD CONSTRAINT "amazon_order_report_versions_line_fk" FOREIGN KEY ("tenant_id","report_line_id") REFERENCES "public"."amazon_order_report_lines"("tenant_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "amazon_order_report_lines" ADD CONSTRAINT "amazon_order_report_lines_current_version_fk" FOREIGN KEY ("tenant_id","id","current_version_id") REFERENCES "public"."amazon_order_report_versions"("tenant_id","report_line_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "amazon_order_report_lines" ADD CONSTRAINT "amazon_order_report_lines_reviewed_version_fk" FOREIGN KEY ("tenant_id","id","reviewed_version_id") REFERENCES "public"."amazon_order_report_versions"("tenant_id","report_line_id","id") ON DELETE restrict ON UPDATE no action;
