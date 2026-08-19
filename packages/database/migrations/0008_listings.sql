CREATE TABLE "listings" (
  "id" uuid PRIMARY KEY NOT NULL, "tenant_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "spu_id" uuid NOT NULL, "platform" text NOT NULL, "locale" text NOT NULL, "status" text DEFAULT 'draft' NOT NULL,
  "primary_version_id" uuid, "created_by" uuid REFERENCES "app_users"("id") ON DELETE SET NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL, "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "listings_id_uuidv7_check" CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "listings_platform_check" CHECK ("platform" IN ('amazon','etsy')),
  CONSTRAINT "listings_status_check" CHECK ("status" IN ('draft','in_review','approved','archived')),
  CONSTRAINT "listings_spu_fk" FOREIGN KEY ("tenant_id", "spu_id") REFERENCES "spus"("tenant_id", "id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "listings_tenant_id_unique" ON "listings" ("tenant_id", "id");
CREATE UNIQUE INDEX "listings_channel_unique" ON "listings" ("tenant_id", "spu_id", "platform", "locale");
CREATE INDEX "listings_status_idx" ON "listings" ("tenant_id", "status", "updated_at");
--> statement-breakpoint
CREATE TABLE "listing_versions" (
  "id" uuid PRIMARY KEY NOT NULL, "tenant_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "listing_id" uuid NOT NULL, "version_number" integer NOT NULL, "rule_version" text NOT NULL,
  "status" text DEFAULT 'draft' NOT NULL, "source" text DEFAULT 'human' NOT NULL,
  "content" jsonb NOT NULL, "validation" jsonb NOT NULL,
  "created_by" uuid REFERENCES "app_users"("id") ON DELETE SET NULL, "approved_by" uuid REFERENCES "app_users"("id") ON DELETE SET NULL,
  "approved_at" timestamptz, "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "listing_versions_id_uuidv7_check" CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "listing_versions_number_check" CHECK ("version_number" > 0),
  CONSTRAINT "listing_versions_status_check" CHECK ("status" IN ('draft','approved','superseded')),
  CONSTRAINT "listing_versions_source_check" CHECK ("source" IN ('human','ai')),
  CONSTRAINT "listing_versions_listing_fk" FOREIGN KEY ("tenant_id", "listing_id") REFERENCES "listings"("tenant_id", "id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "listing_versions_tenant_id_unique" ON "listing_versions" ("tenant_id", "id");
CREATE UNIQUE INDEX "listing_versions_number_unique" ON "listing_versions" ("tenant_id", "listing_id", "version_number");
CREATE INDEX "listing_versions_listing_idx" ON "listing_versions" ("tenant_id", "listing_id", "created_at");
--> statement-breakpoint
CREATE FUNCTION prevent_approved_listing_version_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'approved' THEN RAISE EXCEPTION 'approved listing versions are immutable' USING ERRCODE = '55000'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER listing_versions_immutable BEFORE UPDATE OR DELETE ON listing_versions FOR EACH ROW EXECUTE FUNCTION prevent_approved_listing_version_mutation();
--> statement-breakpoint
ALTER TABLE "listings" ENABLE ROW LEVEL SECURITY; ALTER TABLE "listings" FORCE ROW LEVEL SECURITY;
CREATE POLICY "listings_tenant_policy" ON "listings" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
ALTER TABLE "listing_versions" ENABLE ROW LEVEL SECURITY; ALTER TABLE "listing_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "listing_versions_tenant_policy" ON "listing_versions" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT, UPDATE, DELETE ON listings, listing_versions TO yummyai_app;
