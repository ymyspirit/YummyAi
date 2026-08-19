CREATE TABLE "research_product_type_aliases" (
	"tenant_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"evidence_source" text NOT NULL,
	"evidence_key" text NOT NULL,
	"evidence_label" text NOT NULL,
	"product_type_key" text NOT NULL,
	"product_type_name" text NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_product_type_aliases_pk" PRIMARY KEY("tenant_id","platform","evidence_source","evidence_key"),
	CONSTRAINT "research_product_type_aliases_platform_check" CHECK ("research_product_type_aliases"."platform" in ('amazon', 'etsy')),
	CONSTRAINT "research_product_type_aliases_source_check" CHECK ("research_product_type_aliases"."evidence_source" in ('marketplace_taxonomy', 'ehunt_category', 'amazon_bsr'))
);
--> statement-breakpoint
ALTER TABLE "research_items" ADD COLUMN "product_type_name" text;--> statement-breakpoint
ALTER TABLE "research_items" ADD COLUMN "product_type_key" text;--> statement-breakpoint
ALTER TABLE "research_items" ADD COLUMN "classification_status" text DEFAULT 'unclassified' NOT NULL;--> statement-breakpoint
ALTER TABLE "research_items" ADD COLUMN "classification_source" text;--> statement-breakpoint
ALTER TABLE "research_items" ADD COLUMN "classification_evidence_source" text;--> statement-breakpoint
ALTER TABLE "research_items" ADD COLUMN "classification_evidence_key" text;--> statement-breakpoint
ALTER TABLE "research_items" ADD COLUMN "classification_evidence_label" text;--> statement-breakpoint
ALTER TABLE "research_items" ADD COLUMN "classification_updated_by" uuid;--> statement-breakpoint
ALTER TABLE "research_items" ADD COLUMN "classification_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "research_product_type_aliases" ADD CONSTRAINT "research_product_type_aliases_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_product_type_aliases" ADD CONSTRAINT "research_product_type_aliases_updated_by_app_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "research_product_type_aliases_product_type_idx" ON "research_product_type_aliases" USING btree ("tenant_id","product_type_key");--> statement-breakpoint
ALTER TABLE "research_items" ADD CONSTRAINT "research_items_classification_updated_by_app_users_id_fk" FOREIGN KEY ("classification_updated_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "research_items_product_type_idx" ON "research_items" USING btree ("tenant_id","product_type_key","last_captured_at");--> statement-breakpoint
CREATE INDEX "research_items_classification_idx" ON "research_items" USING btree ("tenant_id","classification_status","last_captured_at");--> statement-breakpoint
ALTER TABLE "research_items" ADD CONSTRAINT "research_items_classification_status_check" CHECK ("research_items"."classification_status" in ('unclassified', 'suggested', 'confirmed'));--> statement-breakpoint
ALTER TABLE "research_items" ADD CONSTRAINT "research_items_classification_source_check" CHECK ("research_items"."classification_source" is null or "research_items"."classification_source" in ('marketplace_taxonomy', 'ehunt_category', 'amazon_bsr', 'manual'));--> statement-breakpoint
ALTER TABLE "research_items" ADD CONSTRAINT "research_items_classification_evidence_source_check" CHECK ("research_items"."classification_evidence_source" is null or "research_items"."classification_evidence_source" in ('marketplace_taxonomy', 'ehunt_category', 'amazon_bsr'));--> statement-breakpoint
ALTER TABLE "research_items" ADD CONSTRAINT "research_items_classification_evidence_pair_check" CHECK (("research_items"."classification_evidence_source" is null and "research_items"."classification_evidence_key" is null and "research_items"."classification_evidence_label" is null) or ("research_items"."classification_evidence_source" is not null and "research_items"."classification_evidence_key" is not null and "research_items"."classification_evidence_label" is not null));--> statement-breakpoint
ALTER TABLE "research_items" ADD CONSTRAINT "research_items_product_type_pair_check" CHECK (("research_items"."classification_status" = 'unclassified' and "research_items"."product_type_name" is null and "research_items"."product_type_key" is null) or ("research_items"."classification_status" in ('suggested', 'confirmed') and "research_items"."product_type_name" is not null and "research_items"."product_type_key" is not null));--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX "research_items_latest_title_trgm_idx" ON "research_items" USING gin ("latest_title" gin_trgm_ops);--> statement-breakpoint
WITH latest AS (
  SELECT DISTINCT ON (tenant_id, research_item_id)
    tenant_id,
    research_item_id,
    draft
  FROM capture_snapshots
  ORDER BY tenant_id, research_item_id, captured_at DESC
),
candidates AS (
  SELECT
    latest.tenant_id,
    latest.research_item_id,
    research_items.platform,
    CASE
      WHEN taxonomy.label IS NOT NULL THEN 'marketplace_taxonomy'
      WHEN ehunt.label IS NOT NULL THEN 'ehunt_category'
      WHEN bsr.label IS NOT NULL THEN 'amazon_bsr'
      ELSE NULL
    END AS evidence_source,
    COALESCE(taxonomy.label, ehunt.label, bsr.label) AS evidence_label
  FROM latest
  JOIN research_items
    ON research_items.tenant_id = latest.tenant_id
   AND research_items.id = latest.research_item_id
  LEFT JOIN LATERAL (
    SELECT NULLIF(BTRIM(jsonb_path_query_first(latest.draft, '$.taxonomy[last].label') #>> '{}'), '') AS label
  ) taxonomy ON true
  LEFT JOIN LATERAL (
    SELECT NULLIF(BTRIM(jsonb_path_query_first(latest.draft, '$.ehuntAnalysis.categoryPath[last]') #>> '{}'), '') AS label
  ) ehunt ON true
  LEFT JOIN LATERAL (
    SELECT ranks.label
    FROM (
      SELECT
        NULLIF(
          BTRIM(REGEXP_REPLACE(link.value ->> 'label', '^#[0-9,]+\s+in\s+', '', 'i')),
          ''
        ) AS label,
        0 AS source_priority,
        link.position
      FROM jsonb_array_elements(COALESCE(latest.draft -> 'productInformation', '[]'::jsonb)) section(value)
      CROSS JOIN jsonb_array_elements(COALESCE(section.value -> 'items', '[]'::jsonb)) item(value)
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(item.value -> 'links', '[]'::jsonb))
        WITH ORDINALITY AS link(value, position)
      WHERE research_items.platform = 'amazon'
        AND item.value ->> 'label' ILIKE '%Best Sellers Rank%'
      UNION ALL
      SELECT
        NULLIF(BTRIM((rank_match.parts)[1]), '') AS label,
        1 AS source_priority,
        rank_match.position
      FROM jsonb_array_elements(COALESCE(latest.draft -> 'productInformation', '[]'::jsonb)) section(value)
      CROSS JOIN jsonb_array_elements(COALESCE(section.value -> 'items', '[]'::jsonb)) item(value)
      CROSS JOIN LATERAL regexp_matches(
        item.value ->> 'value',
        '#[0-9,]+\s+in\s+([^#\n\r(]+)',
        'gi'
      ) WITH ORDINALITY AS rank_match(parts, position)
      WHERE research_items.platform = 'amazon'
        AND item.value ->> 'label' ILIKE '%Best Sellers Rank%'
    ) ranks
    WHERE ranks.label IS NOT NULL
    ORDER BY ranks.source_priority, ranks.position DESC
    LIMIT 1
  ) bsr ON true
),
normalized AS (
  SELECT
    tenant_id,
    research_item_id,
    platform,
    evidence_source,
    REGEXP_REPLACE(BTRIM(normalize(evidence_label, NFKC)), '\s+', ' ', 'g') AS evidence_label,
    LOWER(REGEXP_REPLACE(BTRIM(normalize(evidence_label, NFKC)), '\s+', ' ', 'g')) AS evidence_key
  FROM candidates
  WHERE evidence_source IS NOT NULL
    AND evidence_label IS NOT NULL
)
UPDATE research_items
SET
  product_type_name = normalized.evidence_label,
  product_type_key = normalized.evidence_key,
  classification_status = 'suggested',
  classification_source = normalized.evidence_source,
  classification_evidence_source = normalized.evidence_source,
  classification_evidence_key = normalized.evidence_key,
  classification_evidence_label = normalized.evidence_label,
  classification_updated_at = now()
FROM normalized
WHERE research_items.tenant_id = normalized.tenant_id
  AND research_items.id = normalized.research_item_id
  AND research_items.classification_status = 'unclassified';--> statement-breakpoint
INSERT INTO research_product_type_aliases (
  tenant_id,
  platform,
  evidence_source,
  evidence_key,
  evidence_label,
  product_type_key,
  product_type_name
)
SELECT DISTINCT
  tenant_id,
  platform,
  classification_evidence_source,
  classification_evidence_key,
  classification_evidence_label,
  product_type_key,
  product_type_name
FROM research_items
WHERE classification_status = 'suggested'
  AND classification_evidence_source IS NOT NULL
  AND classification_evidence_key IS NOT NULL
  AND classification_evidence_label IS NOT NULL
  AND product_type_key IS NOT NULL
  AND product_type_name IS NOT NULL
ON CONFLICT (tenant_id, platform, evidence_source, evidence_key) DO NOTHING;--> statement-breakpoint
ALTER TABLE "research_product_type_aliases" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "research_product_type_aliases" FORCE ROW LEVEL SECURITY;
CREATE POLICY "research_product_type_aliases_tenant_policy" ON "research_product_type_aliases" FOR ALL TO yummyai_app
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON research_product_type_aliases TO yummyai_app;
