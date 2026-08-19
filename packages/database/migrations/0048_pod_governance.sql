ALTER TABLE "pod_artwork_tasks" DROP CONSTRAINT "pod_artwork_tasks_tool_check";
ALTER TABLE "pod_artwork_tasks" ADD CONSTRAINT "pod_artwork_tasks_tool_check" CHECK ("pod_artwork_tasks"."tool_key" in ('pattern_crop','print_extract','background_remove','super_resolution','outpaint','crop_compress','vectorize','authorized_watermark_remove','rights_risk_scan','design_variation','product_print_variation','instruction_edit','text_to_image','element_fusion','licensed_brand_fusion','series_design','style_reference','style_transfer','canvas_extend','seamless_pattern','seamless_stitch','print_composite','meme_print','product_suite','title_draft','virtual_try_on','background_replace','product_video','piece_extract','piece_compose','uv_layers'));
--> statement-breakpoint
CREATE TABLE "design_recipe_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"recipe_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"tool_key" text NOT NULL,
	"parameter_snapshot" jsonb NOT NULL,
	"model_policy" jsonb NOT NULL,
	"prompt_template_version" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "design_recipe_versions_id_uuidv7_check" CHECK (substring("design_recipe_versions"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "design_recipe_versions_recipe_uuidv7_check" CHECK (substring("design_recipe_versions"."recipe_id"::text from 15 for 1) = '7'),
	CONSTRAINT "design_recipe_versions_number_check" CHECK ("design_recipe_versions"."version_number" > 0)
);
--> statement-breakpoint
CREATE TABLE "artifact_relations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"from_asset_id" uuid NOT NULL,
	"from_asset_version" integer NOT NULL,
	"to_asset_id" uuid NOT NULL,
	"to_asset_version" integer NOT NULL,
	"relation_type" text NOT NULL,
	"task_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_relations_id_uuidv7_check" CHECK (substring("artifact_relations"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "artifact_relations_version_check" CHECK ("artifact_relations"."from_asset_version" > 0 and "artifact_relations"."to_asset_version" > 0),
	CONSTRAINT "artifact_relations_type_check" CHECK ("artifact_relations"."relation_type" in ('source_to_result','result_to_derivative','result_to_listing','result_to_template','result_to_production')),
	CONSTRAINT "artifact_relations_distinct_check" CHECK ("artifact_relations"."from_asset_id" <> "artifact_relations"."to_asset_id" or "artifact_relations"."from_asset_version" <> "artifact_relations"."to_asset_version")
);
--> statement-breakpoint
CREATE TABLE "rights_assessments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"asset_version" integer NOT NULL,
	"task_id" uuid,
	"supersedes_assessment_id" uuid,
	"rights_source" jsonb,
	"scope_snapshot" jsonb NOT NULL,
	"status" text NOT NULL,
	"legal_risk" text NOT NULL,
	"visual_similarity_permille" integer,
	"evidence_snapshot" jsonb NOT NULL,
	"model_key" text,
	"model_version" text,
	"decision_reason" text,
	"assessed_by" uuid,
	"assessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rights_assessments_id_uuidv7_check" CHECK (substring("rights_assessments"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "rights_assessments_version_check" CHECK ("rights_assessments"."asset_version" > 0),
	CONSTRAINT "rights_assessments_status_check" CHECK ("rights_assessments"."status" in ('pending','review_required','approved','blocked','rejected')),
	CONSTRAINT "rights_assessments_legal_risk_check" CHECK ("rights_assessments"."legal_risk" in ('unknown','low','medium','high')),
	CONSTRAINT "rights_assessments_visual_score_check" CHECK ("rights_assessments"."visual_similarity_permille" is null or "rights_assessments"."visual_similarity_permille" between 0 and 1000),
	CONSTRAINT "rights_assessments_high_risk_check" CHECK ("rights_assessments"."legal_risk" <> 'high' or "rights_assessments"."status" in ('blocked','rejected')),
	CONSTRAINT "rights_assessments_approval_check" CHECK ("rights_assessments"."status" <> 'approved' or "rights_assessments"."legal_risk" = 'low')
);
--> statement-breakpoint
CREATE TABLE "visual_fingerprints" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"asset_version" integer NOT NULL,
	"checksum_sha256" text NOT NULL,
	"perceptual_hash" text,
	"fingerprint_algorithm" text NOT NULL,
	"fingerprint_version" text NOT NULL,
	"index_status" text NOT NULL,
	"vector_index_reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "visual_fingerprints_id_uuidv7_check" CHECK (substring("visual_fingerprints"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "visual_fingerprints_version_check" CHECK ("visual_fingerprints"."asset_version" > 0),
	CONSTRAINT "visual_fingerprints_checksum_check" CHECK ("visual_fingerprints"."checksum_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "visual_fingerprints_phash_check" CHECK ("visual_fingerprints"."perceptual_hash" is null or "visual_fingerprints"."perceptual_hash" ~ '^[0-9a-f]{16,128}$'),
	CONSTRAINT "visual_fingerprints_status_check" CHECK ("visual_fingerprints"."index_status" in ('pending','indexed','failed','removed'))
);
--> statement-breakpoint
CREATE TABLE "personalization_template_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"name" text NOT NULL,
	"source" text NOT NULL,
	"source_asset_id" uuid,
	"source_asset_version" integer,
	"canvas" jsonb NOT NULL,
	"preview_asset_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personalization_template_versions_id_uuidv7_check" CHECK (substring("personalization_template_versions"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "personalization_template_versions_template_uuidv7_check" CHECK (substring("personalization_template_versions"."template_id"::text from 15 for 1) = '7'),
	CONSTRAINT "personalization_template_versions_number_check" CHECK ("personalization_template_versions"."version_number" > 0),
	CONSTRAINT "personalization_template_versions_source_check" CHECK ("personalization_template_versions"."source" in ('blank','png','psd','popular_template')),
	CONSTRAINT "personalization_template_versions_status_check" CHECK ("personalization_template_versions"."status" in ('draft','pending_review','approved','rejected','archived')),
	CONSTRAINT "personalization_template_versions_source_asset_check" CHECK ("personalization_template_versions"."source" not in ('png','psd') or ("personalization_template_versions"."source_asset_id" is not null and "personalization_template_versions"."source_asset_version" > 0))
);
--> statement-breakpoint
CREATE TABLE "template_slots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"template_version_id" uuid NOT NULL,
	"stable_key" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"psd_group" text,
	"geometry" jsonb NOT NULL,
	"fill_mode" text NOT NULL,
	"validation_snapshot" jsonb NOT NULL,
	"replaceable" boolean NOT NULL,
	"reuse_label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "template_slots_id_uuidv7_check" CHECK (substring("template_slots"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "template_slots_kind_check" CHECK ("template_slots"."kind" in ('image','text','decoration','background')),
	CONSTRAINT "template_slots_psd_group_check" CHECK ("template_slots"."psd_group" is null or "template_slots"."psd_group" in ('image','text','decoration','background')),
	CONSTRAINT "template_slots_fill_mode_check" CHECK ("template_slots"."fill_mode" in ('contain','cover','stretch','tile','none'))
);
--> statement-breakpoint
CREATE TABLE "sku_template_bindings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"template_version_id" uuid NOT NULL,
	"size_label" text NOT NULL,
	"mapping_snapshot" jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sku_template_bindings_id_uuidv7_check" CHECK (substring("sku_template_bindings"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "sku_template_bindings_status_check" CHECK ("sku_template_bindings"."status" in ('active','inactive')),
	CONSTRAINT "sku_template_bindings_effective_check" CHECK ("sku_template_bindings"."effective_to" is null or "sku_template_bindings"."effective_to" > "sku_template_bindings"."effective_from")
);
--> statement-breakpoint
CREATE TABLE "listing_artifact_bindings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"listing_version_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"asset_version" integer NOT NULL,
	"content_kind" text NOT NULL,
	"slot_key" text NOT NULL,
	"status" text DEFAULT 'candidate' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "listing_artifact_bindings_id_uuidv7_check" CHECK (substring("listing_artifact_bindings"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "listing_artifact_bindings_version_check" CHECK ("listing_artifact_bindings"."asset_version" > 0),
	CONSTRAINT "listing_artifact_bindings_kind_check" CHECK ("listing_artifact_bindings"."content_kind" in ('image','title')),
	CONSTRAINT "listing_artifact_bindings_status_check" CHECK ("listing_artifact_bindings"."status" in ('candidate','approved','rejected'))
);
--> statement-breakpoint
CREATE TABLE "pod_export_packages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"design_version_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"object_key" text,
	"checksum_sha256" text,
	"byte_size" bigint,
	"manifest" jsonb,
	"error_code" text,
	"error_message" text,
	"requested_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "pod_export_packages_id_uuidv7_check" CHECK (substring("pod_export_packages"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "pod_export_packages_idempotency_uuidv7_check" CHECK (substring("pod_export_packages"."idempotency_key"::text from 15 for 1) = '7'),
	CONSTRAINT "pod_export_packages_status_check" CHECK ("pod_export_packages"."status" in ('queued','running','completed','failed')),
	CONSTRAINT "pod_export_packages_checksum_check" CHECK ("pod_export_packages"."checksum_sha256" is null or "pod_export_packages"."checksum_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "pod_export_packages_byte_size_check" CHECK ("pod_export_packages"."byte_size" is null or "pod_export_packages"."byte_size" >= 0),
	CONSTRAINT "pod_export_packages_complete_check" CHECK ("pod_export_packages"."status" <> 'completed' or ("pod_export_packages"."object_key" is not null and "pod_export_packages"."checksum_sha256" is not null and "pod_export_packages"."byte_size" is not null and "pod_export_packages"."manifest" is not null and "pod_export_packages"."completed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "production_manifests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_line_id" uuid,
	"design_version_id" uuid,
	"template_version_id" uuid,
	"input_snapshot" jsonb NOT NULL,
	"file_snapshot" jsonb NOT NULL,
	"quality_check_snapshot" jsonb NOT NULL,
	"status" text DEFAULT 'pending_review' NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"rejection_reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "production_manifests_id_uuidv7_check" CHECK (substring("production_manifests"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "production_manifests_source_check" CHECK ("production_manifests"."order_line_id" is not null or "production_manifests"."design_version_id" is not null),
	CONSTRAINT "production_manifests_status_check" CHECK ("production_manifests"."status" in ('pending_review','approved','rejected')),
	CONSTRAINT "production_manifests_rejection_check" CHECK ("production_manifests"."status" <> 'rejected' or length("production_manifests"."rejection_reason") > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "personalization_template_versions_tenant_id_unique" ON "personalization_template_versions" ("tenant_id","id");
--> statement-breakpoint
ALTER TABLE "design_recipe_versions" ADD CONSTRAINT "design_recipe_versions_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "design_recipe_versions" ADD CONSTRAINT "design_recipe_versions_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "artifact_relations" ADD CONSTRAINT "artifact_relations_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "artifact_relations" ADD CONSTRAINT "artifact_relations_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "artifact_relations" ADD CONSTRAINT "artifact_relations_from_asset_fk" FOREIGN KEY ("tenant_id","from_asset_id") REFERENCES "public"."asset_files"("tenant_id","id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "artifact_relations" ADD CONSTRAINT "artifact_relations_to_asset_fk" FOREIGN KEY ("tenant_id","to_asset_id") REFERENCES "public"."asset_files"("tenant_id","id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "artifact_relations" ADD CONSTRAINT "artifact_relations_task_fk" FOREIGN KEY ("tenant_id","task_id") REFERENCES "public"."pod_artwork_tasks"("tenant_id","id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "rights_assessments" ADD CONSTRAINT "rights_assessments_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "rights_assessments" ADD CONSTRAINT "rights_assessments_asset_fk" FOREIGN KEY ("tenant_id","asset_id") REFERENCES "public"."asset_files"("tenant_id","id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "rights_assessments" ADD CONSTRAINT "rights_assessments_task_fk" FOREIGN KEY ("tenant_id","task_id") REFERENCES "public"."pod_artwork_tasks"("tenant_id","id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "rights_assessments" ADD CONSTRAINT "rights_assessments_assessed_by_app_users_id_fk" FOREIGN KEY ("assessed_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "visual_fingerprints" ADD CONSTRAINT "visual_fingerprints_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "visual_fingerprints" ADD CONSTRAINT "visual_fingerprints_asset_fk" FOREIGN KEY ("tenant_id","asset_id") REFERENCES "public"."asset_files"("tenant_id","id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "personalization_template_versions" ADD CONSTRAINT "personalization_template_versions_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "personalization_template_versions" ADD CONSTRAINT "personalization_template_versions_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "personalization_template_versions" ADD CONSTRAINT "personalization_template_versions_source_asset_fk" FOREIGN KEY ("tenant_id","source_asset_id") REFERENCES "public"."asset_files"("tenant_id","id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "personalization_template_versions" ADD CONSTRAINT "personalization_template_versions_preview_asset_fk" FOREIGN KEY ("tenant_id","preview_asset_id") REFERENCES "public"."asset_files"("tenant_id","id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "template_slots" ADD CONSTRAINT "template_slots_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "template_slots" ADD CONSTRAINT "template_slots_template_fk" FOREIGN KEY ("tenant_id","template_version_id") REFERENCES "public"."personalization_template_versions"("tenant_id","id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "sku_template_bindings" ADD CONSTRAINT "sku_template_bindings_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "sku_template_bindings" ADD CONSTRAINT "sku_template_bindings_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "sku_template_bindings" ADD CONSTRAINT "sku_template_bindings_sku_fk" FOREIGN KEY ("tenant_id","sku_id") REFERENCES "public"."skus"("tenant_id","id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "sku_template_bindings" ADD CONSTRAINT "sku_template_bindings_template_fk" FOREIGN KEY ("tenant_id","template_version_id") REFERENCES "public"."personalization_template_versions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "listing_artifact_bindings" ADD CONSTRAINT "listing_artifact_bindings_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "listing_artifact_bindings" ADD CONSTRAINT "listing_artifact_bindings_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "listing_artifact_bindings" ADD CONSTRAINT "listing_artifact_bindings_listing_version_fk" FOREIGN KEY ("tenant_id","listing_version_id") REFERENCES "public"."listing_versions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "listing_artifact_bindings" ADD CONSTRAINT "listing_artifact_bindings_asset_fk" FOREIGN KEY ("tenant_id","asset_id") REFERENCES "public"."asset_files"("tenant_id","id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "pod_export_packages" ADD CONSTRAINT "pod_export_packages_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "pod_export_packages" ADD CONSTRAINT "pod_export_packages_requested_by_app_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "pod_export_packages" ADD CONSTRAINT "pod_export_packages_task_fk" FOREIGN KEY ("tenant_id","task_id") REFERENCES "public"."pod_artwork_tasks"("tenant_id","id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "pod_export_packages" ADD CONSTRAINT "pod_export_packages_design_version_fk" FOREIGN KEY ("tenant_id","design_version_id") REFERENCES "public"."design_versions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "production_manifests" ADD CONSTRAINT "production_manifests_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "production_manifests" ADD CONSTRAINT "production_manifests_reviewed_by_app_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "production_manifests" ADD CONSTRAINT "production_manifests_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "production_manifests" ADD CONSTRAINT "production_manifests_order_line_fk" FOREIGN KEY ("tenant_id","order_line_id") REFERENCES "public"."order_lines"("tenant_id","id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "production_manifests" ADD CONSTRAINT "production_manifests_design_version_fk" FOREIGN KEY ("tenant_id","design_version_id") REFERENCES "public"."design_versions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "production_manifests" ADD CONSTRAINT "production_manifests_template_version_fk" FOREIGN KEY ("tenant_id","template_version_id") REFERENCES "public"."personalization_template_versions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "design_recipe_versions_tenant_id_unique" ON "design_recipe_versions" ("tenant_id","id");
CREATE UNIQUE INDEX "design_recipe_versions_number_unique" ON "design_recipe_versions" ("tenant_id","recipe_id","version_number");
CREATE INDEX "design_recipe_versions_tool_idx" ON "design_recipe_versions" ("tenant_id","tool_key","created_at");
CREATE UNIQUE INDEX "artifact_relations_tenant_id_unique" ON "artifact_relations" ("tenant_id","id");
CREATE UNIQUE INDEX "artifact_relations_edge_unique" ON "artifact_relations" ("tenant_id","from_asset_id","from_asset_version","to_asset_id","to_asset_version","relation_type");
CREATE INDEX "artifact_relations_from_idx" ON "artifact_relations" ("tenant_id","from_asset_id","from_asset_version");
CREATE INDEX "artifact_relations_to_idx" ON "artifact_relations" ("tenant_id","to_asset_id","to_asset_version");
CREATE UNIQUE INDEX "rights_assessments_tenant_id_unique" ON "rights_assessments" ("tenant_id","id");
CREATE INDEX "rights_assessments_asset_idx" ON "rights_assessments" ("tenant_id","asset_id","asset_version","assessed_at");
CREATE INDEX "rights_assessments_status_idx" ON "rights_assessments" ("tenant_id","status","legal_risk","assessed_at");
CREATE UNIQUE INDEX "visual_fingerprints_tenant_id_unique" ON "visual_fingerprints" ("tenant_id","id");
CREATE UNIQUE INDEX "visual_fingerprints_asset_algorithm_unique" ON "visual_fingerprints" ("tenant_id","asset_id","asset_version","fingerprint_algorithm","fingerprint_version");
CREATE INDEX "visual_fingerprints_checksum_idx" ON "visual_fingerprints" ("tenant_id","checksum_sha256");
CREATE INDEX "visual_fingerprints_status_idx" ON "visual_fingerprints" ("tenant_id","index_status","created_at");
CREATE UNIQUE INDEX "personalization_template_versions_number_unique" ON "personalization_template_versions" ("tenant_id","template_id","version_number");
CREATE INDEX "personalization_template_versions_status_idx" ON "personalization_template_versions" ("tenant_id","status","created_at");
CREATE UNIQUE INDEX "template_slots_tenant_id_unique" ON "template_slots" ("tenant_id","id");
CREATE UNIQUE INDEX "template_slots_stable_key_unique" ON "template_slots" ("tenant_id","template_version_id","stable_key");
CREATE INDEX "template_slots_reuse_idx" ON "template_slots" ("tenant_id","template_version_id","reuse_label");
CREATE UNIQUE INDEX "sku_template_bindings_tenant_id_unique" ON "sku_template_bindings" ("tenant_id","id");
CREATE UNIQUE INDEX "sku_template_bindings_version_size_unique" ON "sku_template_bindings" ("tenant_id","sku_id","template_version_id","size_label");
CREATE INDEX "sku_template_bindings_lookup_idx" ON "sku_template_bindings" ("tenant_id","sku_id","status","effective_from");
CREATE UNIQUE INDEX "listing_artifact_bindings_tenant_id_unique" ON "listing_artifact_bindings" ("tenant_id","id");
CREATE UNIQUE INDEX "listing_artifact_bindings_slot_unique" ON "listing_artifact_bindings" ("tenant_id","listing_version_id","content_kind","slot_key");
CREATE INDEX "listing_artifact_bindings_asset_idx" ON "listing_artifact_bindings" ("tenant_id","asset_id","asset_version");
CREATE UNIQUE INDEX "pod_export_packages_tenant_id_unique" ON "pod_export_packages" ("tenant_id","id");
CREATE UNIQUE INDEX "pod_export_packages_idempotency_unique" ON "pod_export_packages" ("tenant_id","idempotency_key");
CREATE INDEX "pod_export_packages_task_idx" ON "pod_export_packages" ("tenant_id","task_id","created_at");
CREATE UNIQUE INDEX "production_manifests_tenant_id_unique" ON "production_manifests" ("tenant_id","id");
CREATE INDEX "production_manifests_status_idx" ON "production_manifests" ("tenant_id","status","created_at");
CREATE INDEX "production_manifests_order_line_idx" ON "production_manifests" ("tenant_id","order_line_id","created_at");
--> statement-breakpoint
CREATE FUNCTION prevent_pod_governance_snapshot_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'POD governance snapshots are immutable' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER design_recipe_versions_immutable BEFORE UPDATE OR DELETE ON design_recipe_versions FOR EACH ROW EXECUTE FUNCTION prevent_pod_governance_snapshot_mutation();
CREATE TRIGGER artifact_relations_immutable BEFORE UPDATE OR DELETE ON artifact_relations FOR EACH ROW EXECUTE FUNCTION prevent_pod_governance_snapshot_mutation();
CREATE TRIGGER rights_assessments_immutable BEFORE UPDATE OR DELETE ON rights_assessments FOR EACH ROW EXECUTE FUNCTION prevent_pod_governance_snapshot_mutation();
CREATE TRIGGER template_slots_immutable BEFORE UPDATE OR DELETE ON template_slots FOR EACH ROW EXECUTE FUNCTION prevent_pod_governance_snapshot_mutation();
CREATE TRIGGER listing_artifact_bindings_immutable BEFORE UPDATE OR DELETE ON listing_artifact_bindings FOR EACH ROW EXECUTE FUNCTION prevent_pod_governance_snapshot_mutation();
--> statement-breakpoint
CREATE FUNCTION prevent_pod_export_source_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id OR OLD.task_id IS DISTINCT FROM NEW.task_id
     OR OLD.design_version_id IS DISTINCT FROM NEW.design_version_id OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key
     OR OLD.requested_by IS DISTINCT FROM NEW.requested_by OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'POD export source snapshot is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'completed' AND ROW(OLD.object_key, OLD.checksum_sha256, OLD.byte_size, OLD.manifest, OLD.completed_at)
     IS DISTINCT FROM ROW(NEW.object_key, NEW.checksum_sha256, NEW.byte_size, NEW.manifest, NEW.completed_at) THEN
    RAISE EXCEPTION 'completed POD export package is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER pod_export_packages_source_immutable BEFORE UPDATE ON pod_export_packages FOR EACH ROW EXECUTE FUNCTION prevent_pod_export_source_mutation();
--> statement-breakpoint
CREATE FUNCTION prevent_visual_fingerprint_identity_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id OR OLD.asset_id IS DISTINCT FROM NEW.asset_id
     OR OLD.asset_version IS DISTINCT FROM NEW.asset_version OR OLD.checksum_sha256 IS DISTINCT FROM NEW.checksum_sha256
     OR OLD.perceptual_hash IS DISTINCT FROM NEW.perceptual_hash OR OLD.fingerprint_algorithm IS DISTINCT FROM NEW.fingerprint_algorithm
     OR OLD.fingerprint_version IS DISTINCT FROM NEW.fingerprint_version OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'visual fingerprint identity is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER visual_fingerprints_identity_immutable BEFORE UPDATE ON visual_fingerprints FOR EACH ROW EXECUTE FUNCTION prevent_visual_fingerprint_identity_mutation();
--> statement-breakpoint
CREATE FUNCTION prevent_personalization_template_content_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id OR OLD.template_id IS DISTINCT FROM NEW.template_id
     OR OLD.version_number IS DISTINCT FROM NEW.version_number OR OLD.name IS DISTINCT FROM NEW.name
     OR OLD.source IS DISTINCT FROM NEW.source OR OLD.source_asset_id IS DISTINCT FROM NEW.source_asset_id
     OR OLD.source_asset_version IS DISTINCT FROM NEW.source_asset_version OR OLD.canvas IS DISTINCT FROM NEW.canvas
     OR OLD.preview_asset_id IS DISTINCT FROM NEW.preview_asset_id OR OLD.created_by IS DISTINCT FROM NEW.created_by
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'personalization template version content is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER personalization_template_content_immutable BEFORE UPDATE ON personalization_template_versions FOR EACH ROW EXECUTE FUNCTION prevent_personalization_template_content_mutation();
--> statement-breakpoint
CREATE FUNCTION prevent_sku_template_binding_identity_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id OR OLD.sku_id IS DISTINCT FROM NEW.sku_id
     OR OLD.template_version_id IS DISTINCT FROM NEW.template_version_id OR OLD.size_label IS DISTINCT FROM NEW.size_label
     OR OLD.mapping_snapshot IS DISTINCT FROM NEW.mapping_snapshot OR OLD.effective_from IS DISTINCT FROM NEW.effective_from
     OR OLD.created_by IS DISTINCT FROM NEW.created_by OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'SKU template binding identity is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sku_template_bindings_identity_immutable BEFORE UPDATE ON sku_template_bindings FOR EACH ROW EXECUTE FUNCTION prevent_sku_template_binding_identity_mutation();
--> statement-breakpoint
CREATE FUNCTION prevent_production_manifest_content_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id OR OLD.order_line_id IS DISTINCT FROM NEW.order_line_id
     OR OLD.design_version_id IS DISTINCT FROM NEW.design_version_id OR OLD.template_version_id IS DISTINCT FROM NEW.template_version_id
     OR OLD.input_snapshot IS DISTINCT FROM NEW.input_snapshot OR OLD.file_snapshot IS DISTINCT FROM NEW.file_snapshot
     OR OLD.quality_check_snapshot IS DISTINCT FROM NEW.quality_check_snapshot OR OLD.created_by IS DISTINCT FROM NEW.created_by
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'production manifest content is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER production_manifests_content_immutable BEFORE UPDATE ON production_manifests FOR EACH ROW EXECUTE FUNCTION prevent_production_manifest_content_mutation();
--> statement-breakpoint
CREATE FUNCTION sync_pod_artwork_task_review() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status AND NEW.status IN ('approved','rejected') THEN
    UPDATE pod_artwork_tasks
       SET status = NEW.status,
           review_snapshot = jsonb_build_object(
             'designVersionId', NEW.id,
             'decision', NEW.status,
             'reviewedBy', NEW.reviewed_by,
             'reviewedAt', NEW.reviewed_at,
             'rejectionReason', NEW.rejection_reason
           ),
           updated_at = now()
     WHERE tenant_id = NEW.tenant_id
       AND result_version_id = NEW.id
       AND status IN ('awaiting_review','partially_succeeded');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER design_versions_sync_pod_review AFTER UPDATE OF status ON design_versions FOR EACH ROW EXECUTE FUNCTION sync_pod_artwork_task_review();
--> statement-breakpoint
ALTER TABLE "design_recipe_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "design_recipe_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "design_recipe_versions_tenant_policy" ON "design_recipe_versions" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
ALTER TABLE "artifact_relations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "artifact_relations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "artifact_relations_tenant_policy" ON "artifact_relations" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
ALTER TABLE "rights_assessments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "rights_assessments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "rights_assessments_tenant_policy" ON "rights_assessments" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
ALTER TABLE "visual_fingerprints" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "visual_fingerprints" FORCE ROW LEVEL SECURITY;
CREATE POLICY "visual_fingerprints_tenant_policy" ON "visual_fingerprints" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
ALTER TABLE "personalization_template_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "personalization_template_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "personalization_template_versions_tenant_policy" ON "personalization_template_versions" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
ALTER TABLE "template_slots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "template_slots" FORCE ROW LEVEL SECURITY;
CREATE POLICY "template_slots_tenant_policy" ON "template_slots" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
ALTER TABLE "sku_template_bindings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sku_template_bindings" FORCE ROW LEVEL SECURITY;
CREATE POLICY "sku_template_bindings_tenant_policy" ON "sku_template_bindings" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
ALTER TABLE "listing_artifact_bindings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "listing_artifact_bindings" FORCE ROW LEVEL SECURITY;
CREATE POLICY "listing_artifact_bindings_tenant_policy" ON "listing_artifact_bindings" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
ALTER TABLE "pod_export_packages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pod_export_packages" FORCE ROW LEVEL SECURITY;
CREATE POLICY "pod_export_packages_tenant_policy" ON "pod_export_packages" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
ALTER TABLE "production_manifests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "production_manifests" FORCE ROW LEVEL SECURITY;
CREATE POLICY "production_manifests_tenant_policy" ON "production_manifests" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON design_recipe_versions, artifact_relations, rights_assessments, template_slots, listing_artifact_bindings TO yummyai_app;
GRANT SELECT, INSERT, UPDATE ON visual_fingerprints, personalization_template_versions, sku_template_bindings, pod_export_packages, production_manifests TO yummyai_app;
