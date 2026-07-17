DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'yummyai_app') THEN
    CREATE ROLE yummyai_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;
--> statement-breakpoint
DO $$
BEGIN
  EXECUTE format('GRANT yummyai_app TO %I', current_user);
END
$$;
--> statement-breakpoint
CREATE TABLE "organizations" (
  "id" uuid PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "slug" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "organizations_id_uuidv7_check" CHECK (substring("id"::text from 15 for 1) = '7')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_slug_unique" ON "organizations" ("slug");
--> statement-breakpoint
CREATE TABLE "app_users" (
  "id" uuid PRIMARY KEY NOT NULL,
  "oidc_subject" text NOT NULL,
  "email" text NOT NULL,
  "display_name" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "app_users_id_uuidv7_check" CHECK (substring("id"::text from 15 for 1) = '7')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "app_users_oidc_subject_unique" ON "app_users" ("oidc_subject");
--> statement-breakpoint
CREATE UNIQUE INDEX "app_users_email_unique" ON "app_users" ("email");
--> statement-breakpoint
CREATE TABLE "memberships" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "app_users"("id") ON DELETE CASCADE,
  "status" text DEFAULT 'active' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "memberships_id_uuidv7_check" CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "memberships_status_check" CHECK ("status" IN ('invited', 'active', 'disabled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_tenant_user_unique" ON "memberships" ("tenant_id", "user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_tenant_id_unique" ON "memberships" ("tenant_id", "id");
--> statement-breakpoint
CREATE INDEX "memberships_user_id_idx" ON "memberships" ("user_id");
--> statement-breakpoint
CREATE TABLE "roles" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "data_scope" text DEFAULT 'self' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "roles_id_uuidv7_check" CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "roles_data_scope_check" CHECK ("data_scope" IN ('self', 'team', 'tenant'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "roles_tenant_name_unique" ON "roles" ("tenant_id", "name");
--> statement-breakpoint
CREATE UNIQUE INDEX "roles_tenant_id_unique" ON "roles" ("tenant_id", "id");
--> statement-breakpoint
CREATE TABLE "membership_roles" (
  "tenant_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "membership_id" uuid NOT NULL,
  "role_id" uuid NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "membership_roles_pk" PRIMARY KEY ("membership_id", "role_id"),
  CONSTRAINT "membership_roles_membership_fk" FOREIGN KEY ("tenant_id", "membership_id") REFERENCES "memberships"("tenant_id", "id") ON DELETE CASCADE,
  CONSTRAINT "membership_roles_role_fk" FOREIGN KEY ("tenant_id", "role_id") REFERENCES "roles"("tenant_id", "id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX "membership_roles_tenant_id_idx" ON "membership_roles" ("tenant_id");
--> statement-breakpoint
CREATE INDEX "membership_roles_role_id_idx" ON "membership_roles" ("role_id");
--> statement-breakpoint
CREATE TABLE "audit_events" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "actor_user_id" uuid REFERENCES "app_users"("id") ON DELETE SET NULL,
  "action" text NOT NULL,
  "entity_type" text NOT NULL,
  "entity_id" uuid,
  "trace_id" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "occurred_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "audit_events_id_uuidv7_check" CHECK (substring("id"::text from 15 for 1) = '7')
);
--> statement-breakpoint
CREATE INDEX "audit_events_tenant_occurred_at_idx" ON "audit_events" ("tenant_id", "occurred_at");
--> statement-breakpoint
CREATE INDEX "audit_events_actor_user_id_idx" ON "audit_events" ("actor_user_id");
--> statement-breakpoint
CREATE INDEX "audit_events_entity_idx" ON "audit_events" ("tenant_id", "entity_type", "entity_id");
--> statement-breakpoint
CREATE TABLE "asset_files" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "owner_user_id" uuid REFERENCES "app_users"("id") ON DELETE SET NULL,
  "object_key" text NOT NULL,
  "asset_domain" text NOT NULL,
  "file_name" text NOT NULL,
  "media_type" text NOT NULL,
  "byte_size" bigint NOT NULL,
  "checksum_sha256" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "deleted_at" timestamptz,
  CONSTRAINT "asset_files_id_uuidv7_check" CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "asset_files_domain_check" CHECK ("asset_domain" IN ('research', 'authorized')),
  CONSTRAINT "asset_files_byte_size_check" CHECK ("byte_size" >= 0),
  CONSTRAINT "asset_files_checksum_check" CHECK ("checksum_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "asset_files_tenant_object_key_unique" ON "asset_files" ("tenant_id", "object_key");
--> statement-breakpoint
CREATE INDEX "asset_files_tenant_created_at_idx" ON "asset_files" ("tenant_id", "created_at");
--> statement-breakpoint
CREATE INDEX "asset_files_owner_user_id_idx" ON "asset_files" ("owner_user_id");
--> statement-breakpoint
ALTER TABLE "organizations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "organizations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "organizations_tenant_policy" ON "organizations" FOR ALL TO yummyai_app
  USING ("id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK ("id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
--> statement-breakpoint
ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "memberships" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "memberships_tenant_policy" ON "memberships" FOR ALL TO yummyai_app
  USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
--> statement-breakpoint
ALTER TABLE "roles" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "roles" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "roles_tenant_policy" ON "roles" FOR ALL TO yummyai_app
  USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
--> statement-breakpoint
ALTER TABLE "membership_roles" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "membership_roles" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "membership_roles_tenant_policy" ON "membership_roles" FOR ALL TO yummyai_app
  USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
--> statement-breakpoint
ALTER TABLE "app_users" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app_users" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "app_users_tenant_policy" ON "app_users" FOR SELECT TO yummyai_app
  USING (EXISTS (
    SELECT 1 FROM "memberships"
    WHERE "memberships"."tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
      AND "memberships"."user_id" = "app_users"."id"
  ));
--> statement-breakpoint
ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "audit_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "audit_events_tenant_policy" ON "audit_events" FOR ALL TO yummyai_app
  USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
--> statement-breakpoint
ALTER TABLE "asset_files" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "asset_files" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "asset_files_tenant_policy" ON "asset_files" FOR ALL TO yummyai_app
  USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO yummyai_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON organizations, memberships, roles, membership_roles, asset_files TO yummyai_app;
--> statement-breakpoint
GRANT SELECT ON app_users TO yummyai_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON audit_events TO yummyai_app;
