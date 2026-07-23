CREATE TABLE "marketplace_accounts" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "platform" text NOT NULL,
  "display_name" text NOT NULL,
  "external_account_id" text,
  "region" text NOT NULL,
  "marketplace_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "authorization_mode" text NOT NULL,
  "status" text DEFAULT 'pending_authorization' NOT NULL,
  "requested_scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "granted_scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "credential_status" text DEFAULT 'missing' NOT NULL,
  "health_status" text DEFAULT 'not_checked' NOT NULL,
  "last_health_at" timestamptz,
  "last_error_code" text,
  "created_by" uuid REFERENCES "app_users"("id") ON DELETE SET NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "marketplace_accounts_id_uuidv7_check" CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "marketplace_accounts_platform_check" CHECK ("platform" IN ('amazon', 'etsy')),
  CONSTRAINT "marketplace_accounts_region_check" CHECK ("region" IN ('NA', 'EU', 'FE', 'GLOBAL')),
  CONSTRAINT "marketplace_accounts_status_check" CHECK ("status" IN ('pending_authorization', 'active', 'degraded', 'revoked', 'disabled')),
  CONSTRAINT "marketplace_accounts_credential_check" CHECK ("credential_status" IN ('missing', 'valid', 'expiring', 'revoked')),
  CONSTRAINT "marketplace_accounts_health_check" CHECK ("health_status" IN ('not_checked', 'healthy', 'degraded', 'unauthorized', 'unavailable')),
  CONSTRAINT "marketplace_accounts_auth_mode_check" CHECK (("platform" = 'amazon' AND "authorization_mode" IN ('amazon_private', 'amazon_public')) OR ("platform" = 'etsy' AND "authorization_mode" = 'etsy_oauth'))
);
CREATE UNIQUE INDEX "marketplace_accounts_tenant_id_unique" ON "marketplace_accounts" ("tenant_id", "id");
CREATE UNIQUE INDEX "marketplace_accounts_tenant_name_unique" ON "marketplace_accounts" ("tenant_id", "platform", "display_name");
CREATE UNIQUE INDEX "marketplace_accounts_tenant_external_unique" ON "marketplace_accounts" ("tenant_id", "platform", "external_account_id", "region");
CREATE INDEX "marketplace_accounts_tenant_status_idx" ON "marketplace_accounts" ("tenant_id", "status", "updated_at");
--> statement-breakpoint
ALTER TABLE "marketplace_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "marketplace_accounts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "marketplace_accounts_tenant_policy" ON "marketplace_accounts" FOR ALL TO yummyai_app
  USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT, UPDATE, DELETE ON marketplace_accounts TO yummyai_app;
