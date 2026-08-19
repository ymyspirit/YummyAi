import { z } from "zod";

import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { CustomizationSchema } from "@yummyai/contracts/catalog/product";
import {
  AmazonCustomSurfaceSchema,
  CustomProductPackageClaimsSchema,
} from "@yummyai/contracts/catalog/custom-product-package";

export const AmazonCustomMaterialIssueSchema = z.object({
  code: z.string().regex(/^[a-z0-9_]+$/),
  severity: z.enum(["warning", "blocker"]),
  group: z.enum([
    "product_facts",
    "sku",
    "listing_copy",
    "listing_images",
    "a_plus",
    "customizer",
    "production",
    "compliance",
  ]),
  path: z.string().min(1).max(300),
  message: z.string().min(1).max(1_000),
});

export const AmazonCustomMaterialGroupSchema = z.object({
  key: AmazonCustomMaterialIssueSchema.shape.group,
  label: z.string().min(1).max(120),
  status: z.enum(["ready", "warning", "blocked"]),
  completed: z.int().nonnegative(),
  required: z.int().positive(),
});

export const AmazonCustomListingMaterialsReadinessSchema = z.object({
  status: z.enum(["ready", "partial", "blocked"]),
  score: z.number().min(0).max(100),
  planId: EntityIdSchema,
  listingId: EntityIdSchema.optional(),
  listingVersionId: EntityIdSchema.optional(),
  groups: z.array(AmazonCustomMaterialGroupSchema).length(8),
  issues: z.array(AmazonCustomMaterialIssueSchema),
  evaluatedAt: z.iso.datetime(),
});

export const AmazonCustomListingCopySchema = z.object({
  marketplace: z.string().min(1).max(120),
  locale: z.string().min(2).max(20),
  productType: z.string().min(1).max(120),
  title: z.string().min(1).max(200),
  bulletPoints: z.array(z.string().min(1).max(500)).max(5),
  description: z.string().min(1).max(2_000),
  searchTerms: z.array(z.string().min(1).max(250)).max(100),
  attributes: z.record(z.string(), z.unknown()),
  offerAndFulfillment: z.record(z.string(), z.unknown()),
  compliance: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});

export const AmazonCustomVariantSchema = z.object({
  skuId: EntityIdSchema,
  skuCode: z.string().min(1).max(160),
  optionValues: z.record(z.string(), z.string()),
});

export const AmazonCustomMediaInventoryItemSchema = z.object({
  assetId: EntityIdSchema,
  packagePath: z.string().min(1).max(500),
  role: z.enum(["main", "secondary", "a_plus", "production"]),
  sourceFileName: z.string().min(1).max(255),
  mediaType: z.string().min(1).max(120),
  byteSize: z.int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export const AmazonCustomListingMaterialsManifestV1Schema = z.object({
  packageKind: z.literal("amazon-custom-listing-materials"),
  packageVersion: z.literal("1.0"),
  planId: EntityIdSchema,
  listingId: EntityIdSchema,
  listingVersionId: EntityIdSchema,
  tenantId: EntityIdSchema,
  skuCodes: z.array(z.string().min(1).max(160)).min(1).max(500),
  targetMarketplace: z.string().min(1).max(120),
  policyVersion: z.string().min(1).max(80),
  createdBy: EntityIdSchema,
  createdAt: z.iso.datetime(),
  readiness: AmazonCustomListingMaterialsReadinessSchema,
  media: z.array(AmazonCustomMediaInventoryItemSchema).max(500),
});

export const AmazonCustomListingMaterialsV1Schema = z.object({
  manifest: AmazonCustomListingMaterialsManifestV1Schema,
  listingCopy: AmazonCustomListingCopySchema,
  variants: z.array(AmazonCustomVariantSchema).min(1).max(500),
  customization: z.object({
    schemaVersion: z.literal("1.0"),
    definition: CustomizationSchema,
    surfaces: z.array(AmazonCustomSurfaceSchema).min(1).max(5),
  }),
  claims: CustomProductPackageClaimsSchema,
  readiness: AmazonCustomListingMaterialsReadinessSchema,
  media: z.array(AmazonCustomMediaInventoryItemSchema).max(500),
});

export type AmazonCustomMaterialIssue = z.infer<typeof AmazonCustomMaterialIssueSchema>;
export type AmazonCustomMaterialGroup = z.infer<typeof AmazonCustomMaterialGroupSchema>;
export type AmazonCustomListingMaterialsReadiness = z.infer<
  typeof AmazonCustomListingMaterialsReadinessSchema
>;
export type AmazonCustomListingCopy = z.infer<typeof AmazonCustomListingCopySchema>;
export type AmazonCustomVariant = z.infer<typeof AmazonCustomVariantSchema>;
export type AmazonCustomMediaInventoryItem = z.infer<typeof AmazonCustomMediaInventoryItemSchema>;
export type AmazonCustomListingMaterialsManifestV1 = z.infer<
  typeof AmazonCustomListingMaterialsManifestV1Schema
>;
export type AmazonCustomListingMaterialsV1 = z.infer<typeof AmazonCustomListingMaterialsV1Schema>;
