import type { ArtworkMode, SpecificationFacts } from "@yummyai/contracts/catalog/development";
import type { ArtworkMaterial, ArtworkLayout } from "@yummyai/contracts/catalog/artwork";
import type { CustomizationDefinition } from "@yummyai/contracts";
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { organizations, users } from "./identity.js";
import { spus, skus } from "./catalog.js";
import { assetFiles } from "./assets.js";
import { creativeDesignVersions, canvasPrintSpecVersions } from "./pod-batches.js";
import { printProfileVersions } from "./order-workspace.js";
import { inventoryStockItems } from "./inventory.js";
import {
  productionEditorProjects,
  productionEditorVersions,
  productionEditorRenders,
} from "./production-editor.js";
import { designVersions } from "./design.js";
import { listings, listingVersions } from "./listing.js";
import { marketplaceAccounts } from "./marketplace.js";

const scope = () => ({
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => organizations.id),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
});
const indexes = (t: { id: AnyPgColumn; tenantId: AnyPgColumn }, name: string) => [
  uniqueIndex(`${name}_tenant_id_unique`).on(t.tenantId, t.id),
  check(`${name}_id_uuidv7_check`, sql`substring(${t.id}::text from 15 for 1) = '7'`),
];

export const artworkMasters = pgTable(
  "artwork_masters",
  {
    ...scope(),
    code: text("code").notNull(),
    versionNumber: integer("version_number").notNull().default(1),
    archivedAt: timestamp("archived_at", { mode: "date", withTimezone: true }),
  },
  (t) => [
    ...indexes(t, "artwork_masters"),
    uniqueIndex("artwork_masters_code_unique").on(t.tenantId, sql`lower(${t.code})`),
  ],
);
export const artworkMasterVersions = pgTable(
  "artwork_master_versions",
  {
    ...scope(),
    artworkId: uuid("artwork_id").notNull(),
    versionNumber: integer("version_number").notNull(),
    name: text("name").notNull(),
    mode: text("mode").$type<ArtworkMode>().notNull(),
    creativeVersionId: uuid("creative_version_id"),
    assetId: uuid("asset_id"),
    tags: jsonb("tags").$type<string[]>().notNull(),
    researchItemIds: jsonb("research_item_ids").$type<string[]>().notNull(),
    customization: jsonb("customization").$type<CustomizationDefinition>().notNull(),
    instructions: text("instructions").notNull(),
    materials: jsonb("materials").$type<ArtworkMaterial[]>().notNull().default([]),
    layout: jsonb("layout").$type<ArtworkLayout>().notNull().default([]),
  },
  (t) => [
    ...indexes(t, "artwork_master_versions"),
    check("artwork_master_versions_optional_master_check", sql`(${t.creativeVersionId} is not null and ${t.assetId} is not null) or (${t.creativeVersionId} is null and ${t.assetId} is null and ${t.mode} <> 'fixed')`),
    uniqueIndex("artwork_master_versions_number_unique").on(
      t.tenantId,
      t.artworkId,
      t.versionNumber,
    ),
    uniqueIndex("artwork_master_versions_scope_unique").on(t.tenantId, t.artworkId, t.id),
    foreignKey({
      columns: [t.tenantId, t.artworkId],
      foreignColumns: [artworkMasters.tenantId, artworkMasters.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.creativeVersionId],
      foreignColumns: [creativeDesignVersions.tenantId, creativeDesignVersions.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.assetId],
      foreignColumns: [assetFiles.tenantId, assetFiles.id],
    }),
    check(
      "artwork_master_versions_mode_check",
      sql`${t.mode} in ('fixed','personalized_text','customer_image','mixed') and ${t.versionNumber} > 0`,
    ),
  ],
);
export const productSpecifications = pgTable(
  "product_specifications",
  {
    ...scope(),
    spuId: uuid("spu_id").notNull(),
    code: text("code").notNull(),
    versionNumber: integer("version_number").notNull().default(1),
  },
  (t) => [
    ...indexes(t, "product_specifications"),
    uniqueIndex("product_specifications_code_unique").on(
      t.tenantId,
      t.spuId,
      sql`lower(${t.code})`,
    ),
    uniqueIndex("product_specifications_spu_scope_unique").on(t.tenantId, t.spuId, t.id),
    foreignKey({ columns: [t.tenantId, t.spuId], foreignColumns: [spus.tenantId, spus.id] }),
  ],
);
export const productSpecificationVersions = pgTable(
  "product_specification_versions",
  {
    ...scope(),
    specificationId: uuid("specification_id").notNull(),
    versionNumber: integer("version_number").notNull(),
    name: text("name").notNull(),
    attributes: jsonb("attributes").$type<Record<string, string>>().notNull(),
    facts: jsonb("facts").$type<SpecificationFacts>().notNull(),
    processProfileVersionId: uuid("process_profile_version_id"),
    canvasPrintSpecVersionId: uuid("canvas_print_spec_version_id"),
    stockItemId: uuid("stock_item_id"),
  },
  (t) => [
    ...indexes(t, "product_specification_versions"),
    check("product_specification_versions_draft_process_check", sql`${t.processProfileVersionId} is not null or ${t.facts}->>'factsConfirmed' = 'false'`),
    uniqueIndex("product_specification_versions_number_unique").on(
      t.tenantId,
      t.specificationId,
      t.versionNumber,
    ),
    uniqueIndex("product_specification_versions_scope_unique").on(
      t.tenantId,
      t.specificationId,
      t.id,
    ),
    foreignKey({
      columns: [t.tenantId, t.specificationId],
      foreignColumns: [productSpecifications.tenantId, productSpecifications.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.processProfileVersionId],
      foreignColumns: [printProfileVersions.tenantId, printProfileVersions.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.canvasPrintSpecVersionId],
      foreignColumns: [canvasPrintSpecVersions.tenantId, canvasPrintSpecVersions.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.stockItemId],
      foreignColumns: [inventoryStockItems.tenantId, inventoryStockItems.id],
    }),
  ],
);
export const productStyles = pgTable(
  "product_styles",
  {
    ...scope(),
    artworkId: uuid("artwork_id").notNull(),
    spuId: uuid("spu_id").notNull(),
  },
  (t) => [
    ...indexes(t, "product_styles"),
    uniqueIndex("product_styles_pair_unique").on(t.tenantId, t.artworkId, t.spuId),
    uniqueIndex("product_styles_spu_scope_unique").on(t.tenantId, t.spuId, t.id),
    foreignKey({
      columns: [t.tenantId, t.artworkId],
      foreignColumns: [artworkMasters.tenantId, artworkMasters.id],
    }),
    foreignKey({ columns: [t.tenantId, t.spuId], foreignColumns: [spus.tenantId, spus.id] }),
  ],
);
export const salesSkuDefinitions = pgTable(
  "sales_sku_definitions",
  {
    ...scope(),
    skuId: uuid("sku_id").notNull(),
    styleId: uuid("style_id").notNull(),
    spuId: uuid("spu_id").notNull(),
    specificationId: uuid("specification_id").notNull(),
    versionNumber: integer("version_number").notNull().default(1),
  },
  (t) => [
    ...indexes(t, "sales_sku_definitions"),
    uniqueIndex("sales_sku_definitions_sku_unique").on(t.tenantId, t.skuId),
    uniqueIndex("sales_sku_definitions_pair_unique").on(t.tenantId, t.styleId, t.specificationId),
    foreignKey({ columns: [t.tenantId, t.skuId], foreignColumns: [skus.tenantId, skus.id] }),
    foreignKey({
      columns: [t.tenantId, t.spuId, t.styleId],
      foreignColumns: [productStyles.tenantId, productStyles.spuId, productStyles.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.spuId, t.specificationId],
      foreignColumns: [
        productSpecifications.tenantId,
        productSpecifications.spuId,
        productSpecifications.id,
      ],
    }),
  ],
);
export const salesRecipeVersions = pgTable(
  "sales_recipe_versions",
  {
    ...scope(),
    skuId: uuid("sku_id").notNull(),
    versionNumber: integer("version_number").notNull(),
    artworkVersionId: uuid("artwork_version_id").notNull(),
    specificationVersionId: uuid("specification_version_id").notNull(),
    status: text("status").notNull().default("pending_adaptation"),
    editorProjectId: uuid("editor_project_id"),
    editorVersionId: uuid("editor_version_id"),
    renderId: uuid("render_id"),
    designVersionId: uuid("design_version_id"),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    ...indexes(t, "sales_recipe_versions"),
    uniqueIndex("sales_recipe_versions_number_unique").on(t.tenantId, t.skuId, t.versionNumber),
    uniqueIndex("sales_recipe_versions_scope_unique").on(t.tenantId, t.skuId, t.id),
    foreignKey({
      columns: [t.tenantId, t.skuId],
      foreignColumns: [salesSkuDefinitions.tenantId, salesSkuDefinitions.skuId],
    }),
    foreignKey({
      columns: [t.tenantId, t.artworkVersionId],
      foreignColumns: [artworkMasterVersions.tenantId, artworkMasterVersions.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.specificationVersionId],
      foreignColumns: [productSpecificationVersions.tenantId, productSpecificationVersions.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.editorProjectId],
      foreignColumns: [productionEditorProjects.tenantId, productionEditorProjects.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.editorProjectId, t.editorVersionId],
      foreignColumns: [
        productionEditorVersions.tenantId,
        productionEditorVersions.projectId,
        productionEditorVersions.id,
      ],
    }),
    foreignKey({
      columns: [t.tenantId, t.renderId],
      foreignColumns: [productionEditorRenders.tenantId, productionEditorRenders.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.designVersionId],
      foreignColumns: [designVersions.tenantId, designVersions.id],
    }),
    check(
      "sales_recipe_versions_status_check",
      sql`${t.status} in ('pending_adaptation','in_adaptation','ready_for_customization','approved') and ${t.versionNumber} > 0`,
    ),
  ],
);
export const salesPackageVersions = pgTable(
  "sales_package_versions",
  {
    ...scope(),
    skuId: uuid("sku_id").notNull(),
    recipeId: uuid("recipe_id").notNull(),
    versionNumber: integer("version_number").notNull(),
    listingId: uuid("listing_id").notNull(),
    listingVersionId: uuid("listing_version_id").notNull(),
    platform: text("platform").notNull(),
    marketplaceId: text("marketplace_id").notNull(),
    locale: text("locale").notNull(),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    checksum: text("checksum").notNull(),
  },
  (t) => [
    ...indexes(t, "sales_package_versions"),
    uniqueIndex("sales_package_versions_number_unique").on(
      t.tenantId,
      t.skuId,
      t.platform,
      t.marketplaceId,
      t.locale,
      t.versionNumber,
    ),
    foreignKey({
      columns: [t.tenantId, t.skuId, t.recipeId],
      foreignColumns: [
        salesRecipeVersions.tenantId,
        salesRecipeVersions.skuId,
        salesRecipeVersions.id,
      ],
    }),
    foreignKey({
      columns: [t.tenantId, t.listingId],
      foreignColumns: [listings.tenantId, listings.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.listingVersionId],
      foreignColumns: [listingVersions.tenantId, listingVersions.id],
    }),
    check(
      "sales_package_versions_platform_check",
      sql`${t.platform} in ('amazon','etsy') and ${t.versionNumber} > 0`,
    ),
  ],
);
export const salesChannelBindings = pgTable(
  "sales_channel_bindings",
  {
    ...scope(),
    packageId: uuid("package_id").notNull(),
    accountId: uuid("account_id").notNull(),
    externalSku: text("external_sku").notNull(),
    externalListingId: text("external_listing_id").notNull(),
    marketplaceId: text("marketplace_id").notNull(),
    effectiveFrom: timestamp("effective_from", { mode: "date", withTimezone: true }).notNull(),
    evidence: text("evidence").notNull(),
  },
  (t) => [
    ...indexes(t, "sales_channel_bindings"),
    uniqueIndex("sales_channel_bindings_effective_unique").on(
      t.tenantId,
      t.accountId,
      t.marketplaceId,
      t.externalSku,
      t.externalListingId,
      t.effectiveFrom,
    ),
    index("sales_channel_bindings_lookup_idx").on(
      t.tenantId,
      t.accountId,
      t.externalSku,
      t.effectiveFrom,
    ),
    foreignKey({
      columns: [t.tenantId, t.packageId],
      foreignColumns: [salesPackageVersions.tenantId, salesPackageVersions.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.accountId],
      foreignColumns: [marketplaceAccounts.tenantId, marketplaceAccounts.id],
    }),
  ],
);
export const developmentEvents = pgTable(
  "development_events",
  {
    ...scope(),
    resourceId: uuid("resource_id").notNull(),
    action: text("action").notNull(),
    reason: text("reason").notNull(),
    idempotencyKey: uuid("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    result: jsonb("result").$type<Record<string, unknown>>().notNull(),
  },
  (t) => [
    ...indexes(t, "development_events"),
    uniqueIndex("development_events_request_unique").on(t.tenantId, t.idempotencyKey),
    index("development_events_resource_idx").on(t.tenantId, t.resourceId, t.createdAt),
  ],
);
