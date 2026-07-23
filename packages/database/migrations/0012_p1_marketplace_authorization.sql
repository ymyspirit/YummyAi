CREATE TABLE "marketplace_credentials" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "account_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "encrypted_envelope" text NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "expires_at" timestamptz,
  "rotated_at" timestamptz,
  "created_by" uuid REFERENCES "app_users"("id") ON DELETE SET NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "marketplace_credentials_id_uuidv7_check" CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "marketplace_credentials_kind_check" CHECK ("kind" IN ('amazon_private', 'amazon_public', 'etsy_oauth')),
  CONSTRAINT "marketplace_credentials_version_check" CHECK ("version" > 0),
  CONSTRAINT "marketplace_credentials_account_fk" FOREIGN KEY ("tenant_id", "account_id") REFERENCES "marketplace_accounts"("tenant_id", "id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "marketplace_credentials_tenant_account_unique" ON "marketplace_credentials" ("tenant_id", "account_id");
CREATE UNIQUE INDEX "marketplace_credentials_tenant_id_unique" ON "marketplace_credentials" ("tenant_id", "id");
--> statement-breakpoint
CREATE TABLE "marketplace_authorization_sessions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "account_id" uuid NOT NULL,
  "authorization_mode" text NOT NULL,
  "state_digest" text NOT NULL,
  "encrypted_pkce_verifier" text,
  "redirect_uri" text NOT NULL,
  "requested_scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "consumed_at" timestamptz,
  "failure_code" text,
  "created_by" uuid REFERENCES "app_users"("id") ON DELETE SET NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "marketplace_authorization_sessions_id_uuidv7_check" CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "marketplace_authorization_sessions_mode_check" CHECK ("authorization_mode" IN ('amazon_public', 'etsy_oauth')),
  CONSTRAINT "marketplace_authorization_sessions_account_fk" FOREIGN KEY ("tenant_id", "account_id") REFERENCES "marketplace_accounts"("tenant_id", "id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "marketplace_authorization_sessions_state_unique" ON "marketplace_authorization_sessions" ("state_digest");
CREATE UNIQUE INDEX "marketplace_authorization_sessions_tenant_id_unique" ON "marketplace_authorization_sessions" ("tenant_id", "id");
CREATE INDEX "marketplace_authorization_sessions_expiry_idx" ON "marketplace_authorization_sessions" ("tenant_id", "account_id", "expires_at");
--> statement-breakpoint
ALTER TABLE "marketplace_credentials" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "marketplace_credentials" FORCE ROW LEVEL SECURITY;
CREATE POLICY "marketplace_credentials_tenant_policy" ON "marketplace_credentials" FOR ALL TO yummyai_app
  USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT, UPDATE, DELETE ON marketplace_credentials TO yummyai_app;
ALTER TABLE "marketplace_authorization_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "marketplace_authorization_sessions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "marketplace_authorization_sessions_tenant_policy" ON "marketplace_authorization_sessions" FOR ALL TO yummyai_app
  USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT, UPDATE, DELETE ON marketplace_authorization_sessions TO yummyai_app;
