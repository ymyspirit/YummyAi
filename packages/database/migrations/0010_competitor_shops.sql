CREATE TABLE "competitor_shops" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "owner_user_id" uuid REFERENCES "app_users"("id") ON DELETE SET NULL,
  "platform" text NOT NULL,
  "marketplace" text NOT NULL,
  "external_id" text,
  "normalized_url" text NOT NULL,
  "shop_name" text NOT NULL,
  "latest_status" text DEFAULT 'partial' NOT NULL,
  "first_captured_at" timestamptz DEFAULT now() NOT NULL,
  "last_captured_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "competitor_shops_id_uuidv7_check" CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "competitor_shops_platform_check" CHECK ("platform" IN ('amazon', 'etsy')),
  CONSTRAINT "competitor_shops_status_check" CHECK ("latest_status" IN ('complete', 'partial', 'failed'))
);
CREATE UNIQUE INDEX "competitor_shops_tenant_url_unique" ON "competitor_shops" ("tenant_id", "normalized_url");
CREATE UNIQUE INDEX "competitor_shops_tenant_id_unique" ON "competitor_shops" ("tenant_id", "id");
CREATE INDEX "competitor_shops_tenant_captured_idx" ON "competitor_shops" ("tenant_id", "last_captured_at");
--> statement-breakpoint
CREATE TABLE "competitor_shop_snapshots" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "competitor_shop_id" uuid NOT NULL,
  "captured_by" uuid REFERENCES "app_users"("id") ON DELETE SET NULL,
  "source_research_item_id" uuid REFERENCES "research_items"("id") ON DELETE SET NULL,
  "source_capture_snapshot_id" uuid REFERENCES "capture_snapshots"("id") ON DELETE SET NULL,
  "source_url" text NOT NULL,
  "snapshot_kind" text NOT NULL,
  "location" text,
  "owner_name" text,
  "rating" numeric(3,2),
  "review_count" integer,
  "sales_count" integer,
  "active_listing_count" integer,
  "admirer_count" integer,
  "opened_year" integer,
  "years_on_platform" integer,
  "badges" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "announcement" text,
  "about" text,
  "policies" text,
  "members" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "production_partners" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "draft" jsonb NOT NULL,
  "captured_at" timestamptz NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "competitor_shop_snapshots_id_uuidv7_check" CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "competitor_shop_snapshots_kind_check" CHECK ("snapshot_kind" IN ('listing', 'shop')),
  CONSTRAINT "competitor_shop_snapshots_shop_fk" FOREIGN KEY ("tenant_id", "competitor_shop_id") REFERENCES "competitor_shops"("tenant_id", "id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "competitor_shop_snapshots_tenant_id_unique" ON "competitor_shop_snapshots" ("tenant_id", "id");
CREATE INDEX "competitor_shop_snapshots_shop_captured_idx" ON "competitor_shop_snapshots" ("tenant_id", "competitor_shop_id", "captured_at");
--> statement-breakpoint
ALTER TABLE "competitor_shops" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "competitor_shops" FORCE ROW LEVEL SECURITY;
CREATE POLICY "competitor_shops_tenant_policy" ON "competitor_shops" FOR ALL TO yummyai_app
  USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
ALTER TABLE "competitor_shop_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "competitor_shop_snapshots" FORCE ROW LEVEL SECURITY;
CREATE POLICY "competitor_shop_snapshots_tenant_policy" ON "competitor_shop_snapshots" FOR ALL TO yummyai_app
  USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT, UPDATE, DELETE ON competitor_shops, competitor_shop_snapshots TO yummyai_app;
