CREATE TABLE "canvas_print_spec_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"spec_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"name" text NOT NULL,
	"aspect_width" integer NOT NULL,
	"aspect_height" integer NOT NULL,
	"target_dpi" integer NOT NULL,
	"bleed_mm" numeric(10, 3) NOT NULL,
	"safe_zone_mm" numeric(10, 3) NOT NULL,
	"wrap_mode" text NOT NULL,
	"physical_sizes" jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"rejection_reason" text,
	"created_by" uuid,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "canvas_print_spec_versions_id_uuidv7_check" CHECK (substring("canvas_print_spec_versions"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "canvas_print_spec_versions_spec_uuidv7_check" CHECK (substring("canvas_print_spec_versions"."spec_id"::text from 15 for 1) = '7'),
	CONSTRAINT "canvas_print_spec_versions_number_check" CHECK ("canvas_print_spec_versions"."version_number" > 0),
	CONSTRAINT "canvas_print_spec_versions_aspect_check" CHECK ("canvas_print_spec_versions"."aspect_width" between 1 and 100 and "canvas_print_spec_versions"."aspect_height" between 1 and 100),
	CONSTRAINT "canvas_print_spec_versions_dpi_check" CHECK ("canvas_print_spec_versions"."target_dpi" between 72 and 2400),
	CONSTRAINT "canvas_print_spec_versions_wrap_check" CHECK ("canvas_print_spec_versions"."wrap_mode" in ('none','mirror','extend','solid')),
	CONSTRAINT "canvas_print_spec_versions_status_check" CHECK ("canvas_print_spec_versions"."status" in ('draft','approved','rejected','archived')),
	CONSTRAINT "canvas_print_spec_versions_rejection_check" CHECK ("canvas_print_spec_versions"."status" <> 'rejected' or length("canvas_print_spec_versions"."rejection_reason") > 0)
);
--> statement-breakpoint
CREATE TABLE "creative_design_batch_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"row_key" text NOT NULL,
	"name" text NOT NULL,
	"prompt" text NOT NULL,
	"negative_prompt" text,
	"reference_snapshot" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"candidate_count" integer NOT NULL,
	"print_spec_version_ids" jsonb NOT NULL,
	"focal_point" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "creative_design_batch_items_id_uuidv7_check" CHECK (substring("creative_design_batch_items"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "creative_design_batch_items_ordinal_check" CHECK ("creative_design_batch_items"."ordinal" between 0 and 49),
	CONSTRAINT "creative_design_batch_items_candidate_check" CHECK ("creative_design_batch_items"."candidate_count" between 1 and 4),
	CONSTRAINT "creative_design_batch_items_status_check" CHECK ("creative_design_batch_items"."status" in ('queued','running','awaiting_review','partially_succeeded','completed','failed','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "creative_design_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"recipe_version_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"item_count" integer NOT NULL,
	"generated_count" integer DEFAULT 0 NOT NULL,
	"approved_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"request_checksum" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "creative_design_batches_id_uuidv7_check" CHECK (substring("creative_design_batches"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "creative_design_batches_status_check" CHECK ("creative_design_batches"."status" in ('queued','running','awaiting_review','partially_succeeded','completed','failed','cancelled')),
	CONSTRAINT "creative_design_batches_count_check" CHECK ("creative_design_batches"."item_count" between 1 and 50 and "creative_design_batches"."generated_count" between 0 and 200 and "creative_design_batches"."approved_count" between 0 and 200 and "creative_design_batches"."failed_count" between 0 and "creative_design_batches"."item_count"),
	CONSTRAINT "creative_design_batches_checksum_check" CHECK ("creative_design_batches"."request_checksum" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "creative_design_candidates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"asset_id" uuid,
	"asset_version" integer,
	"checksum_sha256" text,
	"model_key" text,
	"model_version" text,
	"prompt_template_version" text,
	"seed" text,
	"cost_usd" numeric(12, 6),
	"quality_snapshot" jsonb,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "creative_design_candidates_id_uuidv7_check" CHECK (substring("creative_design_candidates"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "creative_design_candidates_ordinal_check" CHECK ("creative_design_candidates"."ordinal" between 0 and 3),
	CONSTRAINT "creative_design_candidates_status_check" CHECK ("creative_design_candidates"."status" in ('queued','running','generated','selected','failed','cancelled')),
	CONSTRAINT "creative_design_candidates_asset_version_check" CHECK ("creative_design_candidates"."asset_version" is null or "creative_design_candidates"."asset_version" > 0),
	CONSTRAINT "creative_design_candidates_checksum_check" CHECK ("creative_design_candidates"."checksum_sha256" is null or "creative_design_candidates"."checksum_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "creative_design_candidates_result_check" CHECK ("creative_design_candidates"."status" not in ('generated','selected') or ("creative_design_candidates"."asset_id" is not null and "creative_design_candidates"."asset_version" is not null and "creative_design_candidates"."checksum_sha256" is not null and "creative_design_candidates"."completed_at" is not null)),
	CONSTRAINT "creative_design_candidates_failure_check" CHECK ("creative_design_candidates"."status" <> 'failed' or ("creative_design_candidates"."error_code" is not null and "creative_design_candidates"."error_message" is not null and "creative_design_candidates"."completed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "creative_design_sku_bindings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"creative_design_version_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"print_spec_version_id" uuid NOT NULL,
	"design_task_id" uuid NOT NULL,
	"design_version_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "creative_design_sku_bindings_id_uuidv7_check" CHECK (substring("creative_design_sku_bindings"."id"::text from 15 for 1) = '7')
);
--> statement-breakpoint
CREATE TABLE "creative_design_version_assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"creative_design_version_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"asset_version" integer NOT NULL,
	"role" text NOT NULL,
	"print_spec_version_id" uuid,
	"adaptation_mode" text NOT NULL,
	"generated_regions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"quality_snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "creative_design_version_assets_id_uuidv7_check" CHECK (substring("creative_design_version_assets"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "creative_design_version_assets_version_check" CHECK ("creative_design_version_assets"."asset_version" > 0),
	CONSTRAINT "creative_design_version_assets_role_check" CHECK ("creative_design_version_assets"."role" in ('master','aspect_variant')),
	CONSTRAINT "creative_design_version_assets_mode_check" CHECK ("creative_design_version_assets"."adaptation_mode" in ('original','crop','ai_outpaint')),
	CONSTRAINT "creative_design_version_assets_spec_check" CHECK (("creative_design_version_assets"."role" = 'master' and "creative_design_version_assets"."print_spec_version_id" is null and "creative_design_version_assets"."adaptation_mode" = 'original') or ("creative_design_version_assets"."role" = 'aspect_variant' and "creative_design_version_assets"."print_spec_version_id" is not null and "creative_design_version_assets"."adaptation_mode" in ('crop','ai_outpaint')))
);
--> statement-breakpoint
CREATE TABLE "creative_design_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"family_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"source_candidate_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'adapting' NOT NULL,
	"rejection_reason" text,
	"created_by" uuid,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "creative_design_versions_id_uuidv7_check" CHECK (substring("creative_design_versions"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "creative_design_versions_family_uuidv7_check" CHECK (substring("creative_design_versions"."family_id"::text from 15 for 1) = '7'),
	CONSTRAINT "creative_design_versions_number_check" CHECK ("creative_design_versions"."version_number" > 0),
	CONSTRAINT "creative_design_versions_status_check" CHECK ("creative_design_versions"."status" in ('adapting','pending_review','approved','rejected')),
	CONSTRAINT "creative_design_versions_rejection_check" CHECK ("creative_design_versions"."status" <> 'rejected' or length("creative_design_versions"."rejection_reason") > 0)
);
--> statement-breakpoint
CREATE TABLE "mockup_batch_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"design_version_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"rejection_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mockup_batch_items_id_uuidv7_check" CHECK (substring("mockup_batch_items"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "mockup_batch_items_ordinal_check" CHECK ("mockup_batch_items"."ordinal" between 0 and 49),
	CONSTRAINT "mockup_batch_items_status_check" CHECK ("mockup_batch_items"."status" in ('queued','running','awaiting_review','partially_succeeded','completed','failed','cancelled')),
	CONSTRAINT "mockup_batch_items_rejection_check" CHECK ("mockup_batch_items"."rejection_reason" is null or length("mockup_batch_items"."rejection_reason") > 0)
);
--> statement-breakpoint
CREATE TABLE "mockup_batch_outputs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"template_slot_id" uuid NOT NULL,
	"slot_key" text NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"asset_id" uuid,
	"asset_version" integer,
	"checksum_sha256" text,
	"width" integer,
	"height" integer,
	"quality_snapshot" jsonb,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "mockup_batch_outputs_id_uuidv7_check" CHECK (substring("mockup_batch_outputs"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "mockup_batch_outputs_slot_check" CHECK ("mockup_batch_outputs"."slot_key" ~ '^[a-z][a-z0-9_.-]{0,79}$'),
	CONSTRAINT "mockup_batch_outputs_attempt_check" CHECK ("mockup_batch_outputs"."attempt" between 0 and 20),
	CONSTRAINT "mockup_batch_outputs_status_check" CHECK ("mockup_batch_outputs"."status" in ('queued','running','succeeded','failed','approved','rejected')),
	CONSTRAINT "mockup_batch_outputs_version_check" CHECK ("mockup_batch_outputs"."asset_version" is null or "mockup_batch_outputs"."asset_version" > 0),
	CONSTRAINT "mockup_batch_outputs_checksum_check" CHECK ("mockup_batch_outputs"."checksum_sha256" is null or "mockup_batch_outputs"."checksum_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "mockup_batch_outputs_success_check" CHECK ("mockup_batch_outputs"."status" not in ('succeeded','approved','rejected') or ("mockup_batch_outputs"."asset_id" is not null and "mockup_batch_outputs"."asset_version" is not null and "mockup_batch_outputs"."checksum_sha256" is not null and "mockup_batch_outputs"."width" > 0 and "mockup_batch_outputs"."height" > 0 and "mockup_batch_outputs"."completed_at" is not null)),
	CONSTRAINT "mockup_batch_outputs_failure_check" CHECK ("mockup_batch_outputs"."status" <> 'failed' or ("mockup_batch_outputs"."error_code" is not null and "mockup_batch_outputs"."error_message" is not null and "mockup_batch_outputs"."completed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "mockup_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"template_pack_version_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"locale" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"item_count" integer NOT NULL,
	"completed_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"request_checksum" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mockup_batches_id_uuidv7_check" CHECK (substring("mockup_batches"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "mockup_batches_status_check" CHECK ("mockup_batches"."status" in ('queued','running','awaiting_review','partially_succeeded','completed','failed','cancelled')),
	CONSTRAINT "mockup_batches_platform_check" CHECK ("mockup_batches"."platform" in ('amazon','etsy')),
	CONSTRAINT "mockup_batches_locale_check" CHECK ("mockup_batches"."locale" ~ '^[a-z]{2}-[A-Z]{2}$'),
	CONSTRAINT "mockup_batches_count_check" CHECK ("mockup_batches"."item_count" between 1 and 50 and "mockup_batches"."completed_count" between 0 and "mockup_batches"."item_count" and "mockup_batches"."failed_count" between 0 and "mockup_batches"."item_count"),
	CONSTRAINT "mockup_batches_checksum_check" CHECK ("mockup_batches"."request_checksum" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "mockup_template_pack_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"pack_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"name" text NOT NULL,
	"platform" text NOT NULL,
	"locale" text NOT NULL,
	"product_category" text DEFAULT 'canvas_art' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"rejection_reason" text,
	"created_by" uuid,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mockup_template_pack_versions_id_uuidv7_check" CHECK (substring("mockup_template_pack_versions"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "mockup_template_pack_versions_pack_uuidv7_check" CHECK (substring("mockup_template_pack_versions"."pack_id"::text from 15 for 1) = '7'),
	CONSTRAINT "mockup_template_pack_versions_number_check" CHECK ("mockup_template_pack_versions"."version_number" > 0),
	CONSTRAINT "mockup_template_pack_versions_platform_check" CHECK ("mockup_template_pack_versions"."platform" in ('amazon','etsy')),
	CONSTRAINT "mockup_template_pack_versions_locale_check" CHECK ("mockup_template_pack_versions"."locale" ~ '^[a-z]{2}-[A-Z]{2}$'),
	CONSTRAINT "mockup_template_pack_versions_category_check" CHECK ("mockup_template_pack_versions"."product_category" = 'canvas_art'),
	CONSTRAINT "mockup_template_pack_versions_status_check" CHECK ("mockup_template_pack_versions"."status" in ('draft','approved','rejected','archived')),
	CONSTRAINT "mockup_template_pack_versions_rejection_check" CHECK ("mockup_template_pack_versions"."status" <> 'rejected' or length("mockup_template_pack_versions"."rejection_reason") > 0)
);
--> statement-breakpoint
CREATE TABLE "mockup_template_slots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"template_pack_version_id" uuid NOT NULL,
	"inspection_id" uuid NOT NULL,
	"slot_key" text NOT NULL,
	"label" text NOT NULL,
	"ordinal" integer NOT NULL,
	"required" boolean NOT NULL,
	"accepted_print_spec_version_ids" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mockup_template_slots_id_uuidv7_check" CHECK (substring("mockup_template_slots"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "mockup_template_slots_key_check" CHECK ("mockup_template_slots"."slot_key" ~ '^[a-z][a-z0-9_.-]{0,79}$'),
	CONSTRAINT "mockup_template_slots_ordinal_check" CHECK ("mockup_template_slots"."ordinal" between 0 and 15)
);
--> statement-breakpoint
CREATE TABLE "mockup_template_source_inspections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source_asset_id" uuid NOT NULL,
	"source_asset_version" integer NOT NULL,
	"checksum_sha256" text NOT NULL,
	"slot_key" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"compiler_version" text NOT NULL,
	"compilation" jsonb,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error_code" text,
	"error_message" text,
	"requested_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "mockup_template_source_inspections_id_uuidv7_check" CHECK (substring("mockup_template_source_inspections"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "mockup_template_source_inspections_version_check" CHECK ("mockup_template_source_inspections"."source_asset_version" > 0),
	CONSTRAINT "mockup_template_source_inspections_checksum_check" CHECK ("mockup_template_source_inspections"."checksum_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "mockup_template_source_inspections_slot_check" CHECK ("mockup_template_source_inspections"."slot_key" ~ '^[a-z][a-z0-9_.-]{0,79}$'),
	CONSTRAINT "mockup_template_source_inspections_status_check" CHECK ("mockup_template_source_inspections"."status" in ('queued','running','completed','failed')),
	CONSTRAINT "mockup_template_source_inspections_complete_check" CHECK ("mockup_template_source_inspections"."status" <> 'completed' or ("mockup_template_source_inspections"."compilation" is not null and "mockup_template_source_inspections"."completed_at" is not null)),
	CONSTRAINT "mockup_template_source_inspections_failure_check" CHECK ("mockup_template_source_inspections"."status" <> 'failed' or ("mockup_template_source_inspections"."error_code" is not null and "mockup_template_source_inspections"."error_message" is not null and "mockup_template_source_inspections"."completed_at" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "canvas_print_spec_versions_tenant_id_unique" ON "canvas_print_spec_versions" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "canvas_print_spec_versions_number_unique" ON "canvas_print_spec_versions" USING btree ("tenant_id","spec_id","version_number");--> statement-breakpoint
CREATE INDEX "canvas_print_spec_versions_status_idx" ON "canvas_print_spec_versions" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "creative_design_batch_items_tenant_id_unique" ON "creative_design_batch_items" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "creative_design_batch_items_row_unique" ON "creative_design_batch_items" USING btree ("tenant_id","batch_id","row_key");--> statement-breakpoint
CREATE UNIQUE INDEX "creative_design_batch_items_ordinal_unique" ON "creative_design_batch_items" USING btree ("tenant_id","batch_id","ordinal");--> statement-breakpoint
CREATE INDEX "creative_design_batch_items_status_idx" ON "creative_design_batch_items" USING btree ("tenant_id","batch_id","status","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "creative_design_batches_tenant_id_unique" ON "creative_design_batches" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "creative_design_batches_checksum_unique" ON "creative_design_batches" USING btree ("tenant_id","request_checksum");--> statement-breakpoint
CREATE INDEX "creative_design_batches_status_idx" ON "creative_design_batches" USING btree ("tenant_id","status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "creative_design_candidates_tenant_id_unique" ON "creative_design_candidates" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "creative_design_candidates_ordinal_unique" ON "creative_design_candidates" USING btree ("tenant_id","item_id","ordinal");--> statement-breakpoint
CREATE INDEX "creative_design_candidates_status_idx" ON "creative_design_candidates" USING btree ("tenant_id","item_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "creative_design_sku_bindings_tenant_id_unique" ON "creative_design_sku_bindings" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "creative_design_sku_bindings_pair_unique" ON "creative_design_sku_bindings" USING btree ("tenant_id","creative_design_version_id","sku_id","print_spec_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "creative_design_sku_bindings_design_version_unique" ON "creative_design_sku_bindings" USING btree ("tenant_id","design_version_id");--> statement-breakpoint
CREATE INDEX "creative_design_sku_bindings_sku_idx" ON "creative_design_sku_bindings" USING btree ("tenant_id","sku_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "creative_design_version_assets_tenant_id_unique" ON "creative_design_version_assets" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "creative_design_version_assets_pair_unique" ON "creative_design_version_assets" USING btree ("tenant_id","creative_design_version_id","asset_id","asset_version");--> statement-breakpoint
CREATE UNIQUE INDEX "creative_design_version_assets_spec_unique" ON "creative_design_version_assets" USING btree ("tenant_id","creative_design_version_id","print_spec_version_id");--> statement-breakpoint
CREATE INDEX "creative_design_version_assets_version_idx" ON "creative_design_version_assets" USING btree ("tenant_id","creative_design_version_id","role");--> statement-breakpoint
CREATE UNIQUE INDEX "creative_design_versions_tenant_id_unique" ON "creative_design_versions" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "creative_design_versions_number_unique" ON "creative_design_versions" USING btree ("tenant_id","family_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "creative_design_versions_candidate_unique" ON "creative_design_versions" USING btree ("tenant_id","source_candidate_id");--> statement-breakpoint
CREATE INDEX "creative_design_versions_status_idx" ON "creative_design_versions" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mockup_batch_items_tenant_id_unique" ON "mockup_batch_items" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "mockup_batch_items_ordinal_unique" ON "mockup_batch_items" USING btree ("tenant_id","batch_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "mockup_batch_items_pair_unique" ON "mockup_batch_items" USING btree ("tenant_id","batch_id","design_version_id","sku_id");--> statement-breakpoint
CREATE INDEX "mockup_batch_items_status_idx" ON "mockup_batch_items" USING btree ("tenant_id","batch_id","status","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "mockup_batch_outputs_tenant_id_unique" ON "mockup_batch_outputs" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "mockup_batch_outputs_attempt_unique" ON "mockup_batch_outputs" USING btree ("tenant_id","item_id","slot_key","attempt");--> statement-breakpoint
CREATE INDEX "mockup_batch_outputs_status_idx" ON "mockup_batch_outputs" USING btree ("tenant_id","item_id","status","slot_key");--> statement-breakpoint
CREATE UNIQUE INDEX "mockup_batches_tenant_id_unique" ON "mockup_batches" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "mockup_batches_checksum_unique" ON "mockup_batches" USING btree ("tenant_id","request_checksum");--> statement-breakpoint
CREATE INDEX "mockup_batches_status_idx" ON "mockup_batches" USING btree ("tenant_id","status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mockup_template_pack_versions_tenant_id_unique" ON "mockup_template_pack_versions" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "mockup_template_pack_versions_number_unique" ON "mockup_template_pack_versions" USING btree ("tenant_id","pack_id","version_number");--> statement-breakpoint
CREATE INDEX "mockup_template_pack_versions_status_idx" ON "mockup_template_pack_versions" USING btree ("tenant_id","status","platform","locale");--> statement-breakpoint
CREATE UNIQUE INDEX "mockup_template_slots_tenant_id_unique" ON "mockup_template_slots" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "mockup_template_slots_key_unique" ON "mockup_template_slots" USING btree ("tenant_id","template_pack_version_id","slot_key");--> statement-breakpoint
CREATE UNIQUE INDEX "mockup_template_slots_ordinal_unique" ON "mockup_template_slots" USING btree ("tenant_id","template_pack_version_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "mockup_template_source_inspections_tenant_id_unique" ON "mockup_template_source_inspections" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "mockup_template_source_inspections_source_unique" ON "mockup_template_source_inspections" USING btree ("tenant_id","source_asset_id","source_asset_version","slot_key","compiler_version");--> statement-breakpoint
CREATE INDEX "mockup_template_source_inspections_status_idx" ON "mockup_template_source_inspections" USING btree ("tenant_id","status","created_at");
--> statement-breakpoint
ALTER TABLE "canvas_print_spec_versions" ADD CONSTRAINT "canvas_print_spec_versions_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvas_print_spec_versions" ADD CONSTRAINT "canvas_print_spec_versions_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvas_print_spec_versions" ADD CONSTRAINT "canvas_print_spec_versions_reviewed_by_app_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_design_batch_items" ADD CONSTRAINT "creative_design_batch_items_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_design_batch_items" ADD CONSTRAINT "creative_design_batch_items_batch_fk" FOREIGN KEY ("tenant_id","batch_id") REFERENCES "public"."creative_design_batches"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_design_batches" ADD CONSTRAINT "creative_design_batches_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_design_batches" ADD CONSTRAINT "creative_design_batches_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_design_batches" ADD CONSTRAINT "creative_design_batches_recipe_fk" FOREIGN KEY ("tenant_id","recipe_version_id") REFERENCES "public"."design_recipe_versions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_design_candidates" ADD CONSTRAINT "creative_design_candidates_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_design_candidates" ADD CONSTRAINT "creative_design_candidates_item_fk" FOREIGN KEY ("tenant_id","item_id") REFERENCES "public"."creative_design_batch_items"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_design_candidates" ADD CONSTRAINT "creative_design_candidates_asset_fk" FOREIGN KEY ("tenant_id","asset_id") REFERENCES "public"."asset_files"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_design_sku_bindings" ADD CONSTRAINT "creative_design_sku_bindings_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_design_sku_bindings" ADD CONSTRAINT "creative_design_sku_bindings_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_design_sku_bindings" ADD CONSTRAINT "creative_design_sku_bindings_creative_fk" FOREIGN KEY ("tenant_id","creative_design_version_id") REFERENCES "public"."creative_design_versions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_design_sku_bindings" ADD CONSTRAINT "creative_design_sku_bindings_sku_fk" FOREIGN KEY ("tenant_id","sku_id") REFERENCES "public"."skus"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_design_sku_bindings" ADD CONSTRAINT "creative_design_sku_bindings_spec_fk" FOREIGN KEY ("tenant_id","print_spec_version_id") REFERENCES "public"."canvas_print_spec_versions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_design_sku_bindings" ADD CONSTRAINT "creative_design_sku_bindings_task_fk" FOREIGN KEY ("tenant_id","design_task_id") REFERENCES "public"."design_tasks"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_design_sku_bindings" ADD CONSTRAINT "creative_design_sku_bindings_version_fk" FOREIGN KEY ("tenant_id","design_version_id") REFERENCES "public"."design_versions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_design_version_assets" ADD CONSTRAINT "creative_design_version_assets_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_design_version_assets" ADD CONSTRAINT "creative_design_version_assets_version_fk" FOREIGN KEY ("tenant_id","creative_design_version_id") REFERENCES "public"."creative_design_versions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_design_version_assets" ADD CONSTRAINT "creative_design_version_assets_asset_fk" FOREIGN KEY ("tenant_id","asset_id") REFERENCES "public"."asset_files"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_design_version_assets" ADD CONSTRAINT "creative_design_version_assets_spec_fk" FOREIGN KEY ("tenant_id","print_spec_version_id") REFERENCES "public"."canvas_print_spec_versions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_design_versions" ADD CONSTRAINT "creative_design_versions_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_design_versions" ADD CONSTRAINT "creative_design_versions_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_design_versions" ADD CONSTRAINT "creative_design_versions_reviewed_by_app_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_design_versions" ADD CONSTRAINT "creative_design_versions_candidate_fk" FOREIGN KEY ("tenant_id","source_candidate_id") REFERENCES "public"."creative_design_candidates"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mockup_batch_items" ADD CONSTRAINT "mockup_batch_items_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mockup_batch_items" ADD CONSTRAINT "mockup_batch_items_reviewed_by_app_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mockup_batch_items" ADD CONSTRAINT "mockup_batch_items_batch_fk" FOREIGN KEY ("tenant_id","batch_id") REFERENCES "public"."mockup_batches"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mockup_batch_items" ADD CONSTRAINT "mockup_batch_items_design_version_fk" FOREIGN KEY ("tenant_id","design_version_id") REFERENCES "public"."design_versions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mockup_batch_items" ADD CONSTRAINT "mockup_batch_items_sku_fk" FOREIGN KEY ("tenant_id","sku_id") REFERENCES "public"."skus"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mockup_batch_outputs" ADD CONSTRAINT "mockup_batch_outputs_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mockup_batch_outputs" ADD CONSTRAINT "mockup_batch_outputs_item_fk" FOREIGN KEY ("tenant_id","item_id") REFERENCES "public"."mockup_batch_items"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mockup_batch_outputs" ADD CONSTRAINT "mockup_batch_outputs_slot_fk" FOREIGN KEY ("tenant_id","template_slot_id") REFERENCES "public"."mockup_template_slots"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mockup_batch_outputs" ADD CONSTRAINT "mockup_batch_outputs_asset_fk" FOREIGN KEY ("tenant_id","asset_id") REFERENCES "public"."asset_files"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mockup_batches" ADD CONSTRAINT "mockup_batches_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mockup_batches" ADD CONSTRAINT "mockup_batches_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mockup_batches" ADD CONSTRAINT "mockup_batches_pack_fk" FOREIGN KEY ("tenant_id","template_pack_version_id") REFERENCES "public"."mockup_template_pack_versions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mockup_template_pack_versions" ADD CONSTRAINT "mockup_template_pack_versions_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mockup_template_pack_versions" ADD CONSTRAINT "mockup_template_pack_versions_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mockup_template_pack_versions" ADD CONSTRAINT "mockup_template_pack_versions_reviewed_by_app_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mockup_template_slots" ADD CONSTRAINT "mockup_template_slots_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mockup_template_slots" ADD CONSTRAINT "mockup_template_slots_pack_fk" FOREIGN KEY ("tenant_id","template_pack_version_id") REFERENCES "public"."mockup_template_pack_versions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mockup_template_slots" ADD CONSTRAINT "mockup_template_slots_inspection_fk" FOREIGN KEY ("tenant_id","inspection_id") REFERENCES "public"."mockup_template_source_inspections"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mockup_template_source_inspections" ADD CONSTRAINT "mockup_template_source_inspections_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mockup_template_source_inspections" ADD CONSTRAINT "mockup_template_source_inspections_requested_by_app_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mockup_template_source_inspections" ADD CONSTRAINT "mockup_template_source_inspections_asset_fk" FOREIGN KEY ("tenant_id","source_asset_id") REFERENCES "public"."asset_files"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'canvas_print_spec_versions',
    'creative_design_batches',
    'creative_design_batch_items',
    'creative_design_candidates',
    'creative_design_versions',
    'creative_design_version_assets',
    'creative_design_sku_bindings',
    'mockup_template_source_inspections',
    'mockup_template_pack_versions',
    'mockup_template_slots',
    'mockup_batches',
    'mockup_batch_items',
    'mockup_batch_outputs'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO yummyai_app USING (tenant_id = (SELECT nullif(current_setting(''app.tenant_id'', true), '''')::uuid)) WITH CHECK (tenant_id = (SELECT nullif(current_setting(''app.tenant_id'', true), '''')::uuid))',
      table_name || '_tenant_policy',
      table_name
    );
  END LOOP;
END $$;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON canvas_print_spec_versions TO yummyai_app;
GRANT SELECT, INSERT, UPDATE ON creative_design_batches TO yummyai_app;
GRANT SELECT, INSERT, UPDATE ON creative_design_batch_items TO yummyai_app;
GRANT SELECT, INSERT, UPDATE ON creative_design_candidates TO yummyai_app;
GRANT SELECT, INSERT, UPDATE ON creative_design_versions TO yummyai_app;
GRANT SELECT, INSERT ON creative_design_version_assets TO yummyai_app;
GRANT SELECT, INSERT ON creative_design_sku_bindings TO yummyai_app;
GRANT SELECT, INSERT, UPDATE ON mockup_template_source_inspections TO yummyai_app;
GRANT SELECT, INSERT, UPDATE ON mockup_template_pack_versions TO yummyai_app;
GRANT SELECT, INSERT ON mockup_template_slots TO yummyai_app;
GRANT SELECT, INSERT, UPDATE ON mockup_batches TO yummyai_app;
GRANT SELECT, INSERT, UPDATE ON mockup_batch_items TO yummyai_app;
GRANT SELECT, INSERT, UPDATE ON mockup_batch_outputs TO yummyai_app;
--> statement-breakpoint
CREATE FUNCTION yummyai_preserve_creative_design_batch_input() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.tenant_id, NEW.name, NEW.recipe_version_id, NEW.item_count, NEW.request_checksum, NEW.created_by, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.tenant_id, OLD.name, OLD.recipe_version_id, OLD.item_count, OLD.request_checksum, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'creative design batch input is immutable';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER creative_design_batches_input_immutable
BEFORE UPDATE ON creative_design_batches
FOR EACH ROW EXECUTE FUNCTION yummyai_preserve_creative_design_batch_input();
--> statement-breakpoint
CREATE FUNCTION yummyai_preserve_creative_design_item_input() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.tenant_id, NEW.batch_id, NEW.ordinal, NEW.row_key, NEW.name, NEW.prompt, NEW.negative_prompt, NEW.reference_snapshot, NEW.candidate_count, NEW.print_spec_version_ids, NEW.focal_point, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.tenant_id, OLD.batch_id, OLD.ordinal, OLD.row_key, OLD.name, OLD.prompt, OLD.negative_prompt, OLD.reference_snapshot, OLD.candidate_count, OLD.print_spec_version_ids, OLD.focal_point, OLD.created_at) THEN
    RAISE EXCEPTION 'creative design batch item input is immutable';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER creative_design_batch_items_input_immutable
BEFORE UPDATE ON creative_design_batch_items
FOR EACH ROW EXECUTE FUNCTION yummyai_preserve_creative_design_item_input();
--> statement-breakpoint
CREATE FUNCTION yummyai_preserve_mockup_batch_input() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.tenant_id, NEW.name, NEW.template_pack_version_id, NEW.platform, NEW.locale, NEW.item_count, NEW.request_checksum, NEW.created_by, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.tenant_id, OLD.name, OLD.template_pack_version_id, OLD.platform, OLD.locale, OLD.item_count, OLD.request_checksum, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'mockup batch input is immutable';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER mockup_batches_input_immutable
BEFORE UPDATE ON mockup_batches
FOR EACH ROW EXECUTE FUNCTION yummyai_preserve_mockup_batch_input();
--> statement-breakpoint
CREATE FUNCTION yummyai_preserve_mockup_item_input() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.tenant_id, NEW.batch_id, NEW.ordinal, NEW.design_version_id, NEW.sku_id, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.tenant_id, OLD.batch_id, OLD.ordinal, OLD.design_version_id, OLD.sku_id, OLD.created_at) THEN
    RAISE EXCEPTION 'mockup batch item input is immutable';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER mockup_batch_items_input_immutable
BEFORE UPDATE ON mockup_batch_items
FOR EACH ROW EXECUTE FUNCTION yummyai_preserve_mockup_item_input();
--> statement-breakpoint
CREATE FUNCTION yummyai_preserve_versioned_definition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'reviewed versioned definitions are immutable';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER canvas_print_spec_versions_reviewed_immutable
BEFORE UPDATE ON canvas_print_spec_versions
FOR EACH ROW EXECUTE FUNCTION yummyai_preserve_versioned_definition();
--> statement-breakpoint
CREATE TRIGGER mockup_template_pack_versions_reviewed_immutable
BEFORE UPDATE ON mockup_template_pack_versions
FOR EACH ROW EXECUTE FUNCTION yummyai_preserve_versioned_definition();
--> statement-breakpoint
