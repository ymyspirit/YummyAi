CREATE TABLE "product_plans" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "description" text,
  "status" text DEFAULT 'researching' NOT NULL,
  "source_report_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "target_cost_amount" numeric(14,2),
  "target_cost_currency" text,
  "customization" jsonb NOT NULL,
  "approved_by" uuid REFERENCES "app_users"("id") ON DELETE SET NULL,
  "approved_at" timestamptz,
  "created_by" uuid REFERENCES "app_users"("id") ON DELETE SET NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "product_plans_id_uuidv7_check" CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "product_plans_status_check" CHECK ("status" IN ('researching','pending_approval','approved','developing','listing','ready','archived')),
  CONSTRAINT "product_plans_cost_check" CHECK (("target_cost_amount" IS NULL AND "target_cost_currency" IS NULL) OR ("target_cost_amount" >= 0 AND "target_cost_currency" ~ '^[A-Z]{3}$'))
);
CREATE UNIQUE INDEX "product_plans_tenant_id_unique" ON "product_plans" ("tenant_id", "id");
CREATE INDEX "product_plans_status_idx" ON "product_plans" ("tenant_id", "status", "updated_at");
--> statement-breakpoint
CREATE TABLE "spus" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "product_plan_id" uuid NOT NULL,
  "code" text NOT NULL,
  "name" text NOT NULL,
  "status" text DEFAULT 'developing' NOT NULL,
  "customization" jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "spus_id_uuidv7_check" CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "spus_status_check" CHECK ("status" IN ('developing','listing','ready','archived')),
  CONSTRAINT "spus_product_plan_fk" FOREIGN KEY ("tenant_id", "product_plan_id") REFERENCES "product_plans"("tenant_id", "id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "spus_tenant_id_unique" ON "spus" ("tenant_id", "id");
CREATE UNIQUE INDEX "spus_tenant_code_unique" ON "spus" ("tenant_id", "code");
CREATE UNIQUE INDEX "spus_tenant_plan_unique" ON "spus" ("tenant_id", "product_plan_id");
CREATE INDEX "spus_plan_idx" ON "spus" ("tenant_id", "product_plan_id");
--> statement-breakpoint
CREATE TABLE "skus" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "spu_id" uuid NOT NULL,
  "code" text NOT NULL,
  "attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "unit_cost_amount" numeric(14,2),
  "unit_cost_currency" text,
  "status" text DEFAULT 'draft' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "skus_id_uuidv7_check" CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "skus_status_check" CHECK ("status" IN ('draft','active','archived')),
  CONSTRAINT "skus_cost_check" CHECK (("unit_cost_amount" IS NULL AND "unit_cost_currency" IS NULL) OR ("unit_cost_amount" >= 0 AND "unit_cost_currency" ~ '^[A-Z]{3}$')),
  CONSTRAINT "skus_spu_fk" FOREIGN KEY ("tenant_id", "spu_id") REFERENCES "spus"("tenant_id", "id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "skus_tenant_id_unique" ON "skus" ("tenant_id", "id");
CREATE UNIQUE INDEX "skus_tenant_code_unique" ON "skus" ("tenant_id", "code");
CREATE INDEX "skus_spu_idx" ON "skus" ("tenant_id", "spu_id");
--> statement-breakpoint
CREATE TABLE "supplier_candidates" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "product_plan_id" uuid NOT NULL,
  "name" text NOT NULL,
  "priority" integer NOT NULL,
  "status" text DEFAULT 'candidate' NOT NULL,
  "quoted_cost_amount" numeric(14,2),
  "quoted_cost_currency" text,
  "minimum_order_quantity" integer,
  "lead_time_days" integer,
  "notes" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "supplier_candidates_id_uuidv7_check" CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "supplier_candidates_priority_check" CHECK ("priority" BETWEEN 1 AND 5),
  CONSTRAINT "supplier_candidates_status_check" CHECK ("status" IN ('candidate','contacted','approved','rejected')),
  CONSTRAINT "supplier_candidates_cost_check" CHECK (("quoted_cost_amount" IS NULL AND "quoted_cost_currency" IS NULL) OR ("quoted_cost_amount" >= 0 AND "quoted_cost_currency" ~ '^[A-Z]{3}$')),
  CONSTRAINT "supplier_candidates_moq_check" CHECK ("minimum_order_quantity" IS NULL OR "minimum_order_quantity" > 0),
  CONSTRAINT "supplier_candidates_lead_time_check" CHECK ("lead_time_days" IS NULL OR "lead_time_days" >= 0),
  CONSTRAINT "supplier_candidates_product_plan_fk" FOREIGN KEY ("tenant_id", "product_plan_id") REFERENCES "product_plans"("tenant_id", "id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "supplier_candidates_tenant_id_unique" ON "supplier_candidates" ("tenant_id", "id");
CREATE INDEX "supplier_candidates_priority_idx" ON "supplier_candidates" ("tenant_id", "product_plan_id", "priority");
--> statement-breakpoint
ALTER TABLE "product_plans" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "product_plans" FORCE ROW LEVEL SECURITY;
CREATE POLICY "product_plans_tenant_policy" ON "product_plans" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
ALTER TABLE "spus" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "spus" FORCE ROW LEVEL SECURITY;
CREATE POLICY "spus_tenant_policy" ON "spus" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
ALTER TABLE "skus" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "skus" FORCE ROW LEVEL SECURITY;
CREATE POLICY "skus_tenant_policy" ON "skus" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
ALTER TABLE "supplier_candidates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "supplier_candidates" FORCE ROW LEVEL SECURITY;
CREATE POLICY "supplier_candidates_tenant_policy" ON "supplier_candidates" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT, UPDATE ON product_plans, spus, skus, supplier_candidates TO yummyai_app;
