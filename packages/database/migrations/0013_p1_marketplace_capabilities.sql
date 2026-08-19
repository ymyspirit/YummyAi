ALTER TABLE "marketplace_accounts" ADD COLUMN "last_capability_sync_at" timestamptz;
ALTER TABLE "marketplace_accounts" ADD COLUMN "capability_expires_at" timestamptz;
--> statement-breakpoint
CREATE TABLE "marketplace_capability_snapshots" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "account_id" uuid NOT NULL,
  "version" integer NOT NULL,
  "platform" text NOT NULL,
  "external_account_id" text NOT NULL,
  "marketplace_ids" jsonb NOT NULL,
  "capabilities" jsonb NOT NULL,
  "source_version" text NOT NULL,
  "source_checksum" text NOT NULL,
  "data" jsonb NOT NULL,
  "synced_at" timestamptz NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "created_by" uuid REFERENCES "app_users"("id") ON DELETE SET NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "marketplace_capability_snapshots_id_uuidv7_check" CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "marketplace_capability_snapshots_version_check" CHECK ("version" > 0),
  CONSTRAINT "marketplace_capability_snapshots_platform_check" CHECK ("platform" IN ('amazon', 'etsy')),
  CONSTRAINT "marketplace_capability_snapshots_expiry_check" CHECK ("expires_at" > "synced_at"),
  CONSTRAINT "marketplace_capability_snapshots_account_fk" FOREIGN KEY ("tenant_id", "account_id") REFERENCES "marketplace_accounts"("tenant_id", "id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "marketplace_capability_snapshots_tenant_account_version_unique" ON "marketplace_capability_snapshots" ("tenant_id", "account_id", "version");
CREATE UNIQUE INDEX "marketplace_capability_snapshots_tenant_id_unique" ON "marketplace_capability_snapshots" ("tenant_id", "id");
CREATE INDEX "marketplace_capability_snapshots_latest_idx" ON "marketplace_capability_snapshots" ("tenant_id", "account_id", "synced_at");
CREATE INDEX "marketplace_capability_snapshots_expiry_idx" ON "marketplace_capability_snapshots" ("tenant_id", "expires_at");
--> statement-breakpoint
ALTER TABLE "marketplace_capability_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "marketplace_capability_snapshots" FORCE ROW LEVEL SECURITY;
CREATE POLICY "marketplace_capability_snapshots_tenant_policy" ON "marketplace_capability_snapshots" FOR ALL TO yummyai_app
  USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON marketplace_capability_snapshots TO yummyai_app;
