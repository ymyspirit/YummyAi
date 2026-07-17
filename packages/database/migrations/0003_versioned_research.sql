CREATE TABLE "research_items" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "owner_user_id" uuid REFERENCES "app_users"("id") ON DELETE SET NULL,
  "platform" text NOT NULL,
  "marketplace" text NOT NULL,
  "normalized_url" text NOT NULL,
  "latest_title" text,
  "latest_status" text DEFAULT 'normalizing' NOT NULL,
  "tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "project_id" uuid,
  "first_captured_at" timestamptz DEFAULT now() NOT NULL,
  "last_captured_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "research_items_id_uuidv7_check" CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "research_items_platform_check" CHECK ("platform" IN ('amazon', 'etsy')),
  CONSTRAINT "research_items_status_check" CHECK ("latest_status" IN ('normalizing', 'complete', 'partial', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "research_items_tenant_url_unique" ON "research_items" ("tenant_id", "normalized_url");
CREATE UNIQUE INDEX "research_items_tenant_id_unique" ON "research_items" ("tenant_id", "id");
CREATE INDEX "research_items_tenant_last_captured_idx" ON "research_items" ("tenant_id", "last_captured_at");
CREATE INDEX "research_items_filter_idx" ON "research_items" ("tenant_id", "platform", "marketplace", "latest_status");
--> statement-breakpoint
CREATE TABLE "capture_snapshots" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "research_item_id" uuid NOT NULL,
  "captured_by" uuid REFERENCES "app_users"("id") ON DELETE SET NULL,
  "source_url" text NOT NULL,
  "title" text,
  "price_amount" numeric(14,2),
  "price_currency" text,
  "rating" numeric(3,2),
  "status" text DEFAULT 'normalizing' NOT NULL,
  "domain" text NOT NULL,
  "draft" jsonb NOT NULL,
  "captured_at" timestamptz NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "capture_snapshots_id_uuidv7_check" CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "capture_snapshots_status_check" CHECK ("status" IN ('normalizing', 'complete', 'partial', 'failed')),
  CONSTRAINT "capture_snapshots_domain_check" CHECK ("domain" IN ('research', 'authorized')),
  CONSTRAINT "capture_snapshots_research_item_fk" FOREIGN KEY ("tenant_id", "research_item_id") REFERENCES "research_items"("tenant_id", "id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX "capture_snapshots_tenant_id_unique" ON "capture_snapshots" ("tenant_id", "id");
CREATE INDEX "capture_snapshots_item_captured_idx" ON "capture_snapshots" ("tenant_id", "research_item_id", "captured_at");
--> statement-breakpoint
CREATE TABLE "capture_media" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "snapshot_id" uuid NOT NULL,
  "source_url" text NOT NULL,
  "kind" text NOT NULL,
  "status" text NOT NULL,
  "failure_reason" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "capture_media_id_uuidv7_check" CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "capture_media_kind_check" CHECK ("kind" IN ('image', 'video')),
  CONSTRAINT "capture_media_status_check" CHECK ("status" IN ('queued', 'excluded', 'failed')),
  CONSTRAINT "capture_media_snapshot_fk" FOREIGN KEY ("tenant_id", "snapshot_id") REFERENCES "capture_snapshots"("tenant_id", "id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX "capture_media_snapshot_idx" ON "capture_media" ("tenant_id", "snapshot_id");
--> statement-breakpoint
ALTER TABLE "research_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "research_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY "research_items_tenant_policy" ON "research_items" FOR ALL TO yummyai_app
  USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
ALTER TABLE "capture_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "capture_snapshots" FORCE ROW LEVEL SECURITY;
CREATE POLICY "capture_snapshots_tenant_policy" ON "capture_snapshots" FOR ALL TO yummyai_app
  USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
ALTER TABLE "capture_media" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "capture_media" FORCE ROW LEVEL SECURITY;
CREATE POLICY "capture_media_tenant_policy" ON "capture_media" FOR ALL TO yummyai_app
  USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON research_items, capture_snapshots, capture_media TO yummyai_app;
