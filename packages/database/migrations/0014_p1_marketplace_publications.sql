CREATE TABLE "marketplace_publication_requests" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL,
  "account_id" uuid NOT NULL,
  "capability_snapshot_id" uuid NOT NULL,
  "listing_id" uuid NOT NULL,
  "listing_version_id" uuid NOT NULL,
  "platform" text NOT NULL,
  "marketplace_id" text NOT NULL,
  "action" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "payload" jsonb NOT NULL,
  "payload_checksum" text NOT NULL,
  "asset_manifest" jsonb NOT NULL,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "marketplace_publication_requests_id_uuidv7_check" CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "marketplace_publication_requests_platform_check" CHECK ("platform" IN ('amazon', 'etsy')),
  CONSTRAINT "marketplace_publication_requests_action_check" CHECK ("action" IN ('amazon_validation_preview', 'etsy_create_draft')),
  CONSTRAINT "marketplace_publication_requests_platform_action_check" CHECK (("platform" = 'amazon' AND "action" = 'amazon_validation_preview') OR ("platform" = 'etsy' AND "action" = 'etsy_create_draft')),
  CONSTRAINT "marketplace_publication_requests_idempotency_check" CHECK ("idempotency_key" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "marketplace_publication_requests_payload_checksum_check" CHECK ("payload_checksum" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "marketplace_publication_requests_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "marketplace_publication_requests_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "app_users"("id") ON DELETE SET NULL,
  CONSTRAINT "marketplace_publication_requests_account_fk" FOREIGN KEY ("tenant_id", "account_id") REFERENCES "marketplace_accounts"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "marketplace_publication_requests_capability_fk" FOREIGN KEY ("tenant_id", "capability_snapshot_id") REFERENCES "marketplace_capability_snapshots"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "marketplace_publication_requests_listing_fk" FOREIGN KEY ("tenant_id", "listing_id") REFERENCES "listings"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "marketplace_publication_requests_listing_version_fk" FOREIGN KEY ("tenant_id", "listing_version_id") REFERENCES "listing_versions"("tenant_id", "id") ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_publication_requests_tenant_id_unique" ON "marketplace_publication_requests" ("tenant_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_publication_requests_tenant_idempotency_unique" ON "marketplace_publication_requests" ("tenant_id", "idempotency_key");
--> statement-breakpoint
CREATE INDEX "marketplace_publication_requests_listing_idx" ON "marketplace_publication_requests" ("tenant_id", "listing_id", "created_at");
--> statement-breakpoint
CREATE INDEX "marketplace_publication_requests_account_idx" ON "marketplace_publication_requests" ("tenant_id", "account_id", "created_at");
--> statement-breakpoint
CREATE TABLE "marketplace_publication_events" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL,
  "request_id" uuid NOT NULL,
  "sequence" integer NOT NULL,
  "status" text NOT NULL,
  "code" text,
  "message" text,
  "issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "external_listing_id" text,
  "external_submission_id" text,
  "external_state" text,
  "retryable" boolean DEFAULT false NOT NULL,
  "actor_user_id" uuid,
  "occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "marketplace_publication_events_id_uuidv7_check" CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "marketplace_publication_events_sequence_check" CHECK ("sequence" > 0),
  CONSTRAINT "marketplace_publication_events_status_check" CHECK ("status" IN ('queued', 'processing', 'validation_passed', 'validation_failed', 'draft_created', 'retry_pending', 'reconciliation_required', 'failed')),
  CONSTRAINT "marketplace_publication_events_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "marketplace_publication_events_actor_user_id_app_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "app_users"("id") ON DELETE SET NULL,
  CONSTRAINT "marketplace_publication_events_request_fk" FOREIGN KEY ("tenant_id", "request_id") REFERENCES "marketplace_publication_requests"("tenant_id", "id") ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_publication_events_tenant_id_unique" ON "marketplace_publication_events" ("tenant_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_publication_events_request_sequence_unique" ON "marketplace_publication_events" ("tenant_id", "request_id", "sequence");
--> statement-breakpoint
CREATE INDEX "marketplace_publication_events_latest_idx" ON "marketplace_publication_events" ("tenant_id", "request_id", "sequence");
--> statement-breakpoint
ALTER TABLE "marketplace_publication_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "marketplace_publication_requests" FORCE ROW LEVEL SECURITY;
CREATE POLICY "marketplace_publication_requests_tenant_policy" ON "marketplace_publication_requests" FOR ALL TO yummyai_app
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT ON marketplace_publication_requests TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "marketplace_publication_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "marketplace_publication_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "marketplace_publication_events_tenant_policy" ON "marketplace_publication_events" FOR ALL TO yummyai_app
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT ON marketplace_publication_events TO yummyai_app;
