import { z } from "zod";

import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { CustomizationSchema } from "@yummyai/contracts/catalog/product";

export const ProductFactSourceSchema = z.enum([
  "seller_provided",
  "competitor_reference",
  "inferred_from_research",
]);

export const ProductFactVerificationSchema = z.enum(["unverified", "confirmed", "rejected"]);

const FactProvenanceSchema = z.object({
  source: ProductFactSourceSchema,
  verificationStatus: ProductFactVerificationSchema,
  sourceUrl: z.url().optional(),
  evidencePath: z.string().min(1).max(300).optional(),
  notes: z.string().max(1_000).optional(),
});

export const SourcedTextFactSchema = FactProvenanceSchema.extend({
  value: z.string().trim().min(1).max(4_000),
});

export const SourcedPositiveIntegerFactSchema = FactProvenanceSchema.extend({
  value: z.int().positive().max(100_000),
});

export const CustomProductAssetRoleSchema = z.enum([
  "real_product",
  "finished_sample",
  "packaging",
  "print_template",
  "style_reference",
  "competitor_reference",
]);

export const CustomProductAssetAssignmentSchema = z.object({
  assetId: EntityIdSchema,
  role: CustomProductAssetRoleSchema,
});

export const AmazonCustomSurfaceSchema = FactProvenanceSchema.extend({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/),
  label: z.string().trim().min(1).max(120),
  fieldKeys: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,79}$/)).max(15),
  areaMm: z
    .object({
      width: z.number().positive().max(10_000),
      height: z.number().positive().max(10_000),
    })
    .optional(),
  process: z.string().trim().min(1).max(500).optional(),
});

export const CustomProductProfileV1Schema = z.object({
  schemaVersion: z.literal("1.0"),
  sku: SourcedTextFactSchema.optional(),
  targetMarketplace: SourcedTextFactSchema.optional(),
  productType: SourcedTextFactSchema.optional(),
  brand: SourcedTextFactSchema.optional(),
  materials: z.array(SourcedTextFactSchema).max(50).default([]),
  colors: z.array(SourcedTextFactSchema).max(100).default([]),
  sizeOptions: z.array(SourcedTextFactSchema).max(100).default([]),
  packageQuantity: SourcedPositiveIntegerFactSchema.optional(),
  packageContents: z.array(SourcedTextFactSchema).max(100).default([]),
  manufacturingProcess: SourcedTextFactSchema.optional(),
  targetAudiences: z.array(SourcedTextFactSchema).max(50).default([]),
  sellingPoints: z.array(SourcedTextFactSchema).max(50).default([]),
  surfaces: z.array(AmazonCustomSurfaceSchema).max(5).default([]),
  approvedClaims: z.array(z.string().trim().min(1).max(500)).max(100).default([]),
  prohibitedClaims: z.array(z.string().trim().min(1).max(500)).max(100).default([]),
  prohibitedElements: z.array(z.string().trim().min(1).max(500)).max(100).default([]),
  researchItemIds: z.array(EntityIdSchema).max(50).default([]),
  assetAssignments: z.array(CustomProductAssetAssignmentSchema).max(500).default([]),
  updatedAt: z.iso.datetime(),
});

export const SaveCustomProductProfileInputSchema = z.object({
  profile: CustomProductProfileV1Schema,
});

export const GenerateProvisionalCustomProductProfileInputSchema = z.object({
  researchItemId: EntityIdSchema,
  targetMarketplace: z.string().trim().min(1).max(120).default("amazon.com"),
});

export const CustomProductPackageExportModeSchema = z.enum(["draft", "release"]);

export const CustomProductPackageExportRequestSchema = z.object({
  mode: CustomProductPackageExportModeSchema.default("draft"),
});

export const CustomProductPackageIssueSchema = z.object({
  code: z.string().regex(/^[a-z0-9_]+$/),
  severity: z.enum(["warning", "blocker"]),
  path: z.string().min(1).max(300),
  message: z.string().min(1).max(1_000),
});

export const CustomProductPackageCompletenessSchema = z.object({
  status: z.enum(["ready", "partial", "blocked"]),
  score: z.number().min(0).max(100),
  issues: z.array(CustomProductPackageIssueSchema),
  confirmedFactCount: z.int().nonnegative(),
  unverifiedFactCount: z.int().nonnegative(),
  authorizedAssetCount: z.int().nonnegative(),
  referenceOnlyAssetCount: z.int().nonnegative(),
  evaluatedAt: z.iso.datetime(),
});

export const CustomProductPackageAssetSchema = z.object({
  id: z.string().min(1).max(300),
  fileName: z.string().min(1).max(255),
  role: CustomProductAssetRoleSchema,
  rightsStatus: z.enum(["owned", "licensed", "reference_only", "unverified"]),
  usePolicy: z.enum(["generation_allowed", "analysis_only", "export_only", "blocked"]),
  mediaType: z.string().min(1).max(120),
  sourceUrl: z.url().optional(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  byteSize: z.int().nonnegative().optional(),
  includedInPackage: z.boolean(),
});

export const CustomProductPackageProductSchema = z.object({
  planId: EntityIdSchema,
  name: z.string().min(1).max(200),
  description: z.string().max(4_000).optional(),
  profile: CustomProductProfileV1Schema,
});

export const CustomProductPackageCustomizationSchema = z.object({
  schemaVersion: z.literal("1.0"),
  definition: CustomizationSchema,
  surfaces: z.array(AmazonCustomSurfaceSchema).max(5),
});

export const CustomProductPackageCompetitorSchema = z.object({
  researchItemId: EntityIdSchema,
  snapshotId: EntityIdSchema,
  platform: z.enum(["amazon", "etsy"]),
  marketplace: z.string().min(1),
  sourceUrl: z.url(),
  title: z.string().min(1).max(1_000),
  capturedAt: z.iso.datetime(),
  captureStatus: z.enum(["complete", "partial", "failed"]),
  price: z
    .object({
      amount: z.number().nonnegative().optional(),
      currency: z.string().length(3).optional(),
      raw: z.string().min(1).optional(),
    })
    .optional(),
  rating: z.number().min(0).max(5).optional(),
  favoriteCount: z.int().nonnegative().optional(),
  tags: z.array(z.string().min(1).max(200)).max(200),
});

export const CustomProductPackageReviewInsightsSchema = z.object({
  status: z.enum(["available", "unavailable"]),
  collectedReviewCount: z.int().nonnegative(),
  reportedReviewCount: z.int().nonnegative().optional(),
  purchaseMotivations: z.array(z.string().min(1).max(500)).max(50),
  painPoints: z.array(z.string().min(1).max(500)).max(50),
  notes: z.array(z.string().min(1).max(1_000)).max(50),
});

export const CustomProductPackageBrandStyleSchema = z.object({
  status: z.enum(["provided", "missing"]),
  styleKeywords: z.array(z.string().min(1).max(120)).max(50),
  colors: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).max(50),
  prohibitedElements: z.array(z.string().min(1).max(500)).max(100),
});

export const CustomProductPackageClaimsSchema = z.object({
  verifiedClaims: z.array(z.string().min(1).max(500)).max(100),
  provisionalClaims: z.array(z.string().min(1).max(500)).max(100),
  prohibitedClaims: z.array(z.string().min(1).max(500)).max(100),
  evidenceNotes: z.array(z.string().min(1).max(1_000)).max(100),
});

export const CustomProductPackageFileSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(500)
    .refine(
      (path) =>
        !path.startsWith("/") &&
        !path.startsWith("\\") &&
        !path.includes("..") &&
        !path.includes("\\"),
      "path must remain inside the package",
    ),
  role: z.enum([
    "product",
    "customization",
    "competitors",
    "review_insights",
    "brand_style",
    "claims",
    "completeness",
    "asset_inventory",
    "asset",
  ]),
  mediaType: z.string().min(1).max(120),
  byteSize: z.int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export const CustomProductPackageManifestV1Schema = z.object({
  packageKind: z.literal("amazon-custom-product"),
  packageVersion: z.literal("1.0"),
  mode: CustomProductPackageExportModeSchema,
  planId: EntityIdSchema,
  tenantId: EntityIdSchema,
  targetMarketplace: z.string().min(1).max(120),
  files: z.array(CustomProductPackageFileSchema).max(500),
  completeness: CustomProductPackageCompletenessSchema,
  policyVersion: z.string().min(1).max(80),
  createdBy: EntityIdSchema,
  createdAt: z.iso.datetime(),
});

export const CustomProductPackageV1Schema = z.object({
  manifest: CustomProductPackageManifestV1Schema,
  product: CustomProductPackageProductSchema,
  customization: CustomProductPackageCustomizationSchema,
  competitors: z.array(CustomProductPackageCompetitorSchema).max(50),
  reviewInsights: CustomProductPackageReviewInsightsSchema,
  brandStyle: CustomProductPackageBrandStyleSchema,
  claims: CustomProductPackageClaimsSchema,
  completeness: CustomProductPackageCompletenessSchema,
  assets: z.array(CustomProductPackageAssetSchema).max(500),
});

export type ProductFactSource = z.infer<typeof ProductFactSourceSchema>;
export type ProductFactVerification = z.infer<typeof ProductFactVerificationSchema>;
export type SourcedTextFact = z.infer<typeof SourcedTextFactSchema>;
export type CustomProductAssetRole = z.infer<typeof CustomProductAssetRoleSchema>;
export type CustomProductAssetAssignment = z.infer<typeof CustomProductAssetAssignmentSchema>;
export type AmazonCustomSurface = z.infer<typeof AmazonCustomSurfaceSchema>;
export type CustomProductProfileV1 = z.infer<typeof CustomProductProfileV1Schema>;
export type SaveCustomProductProfileInput = z.infer<typeof SaveCustomProductProfileInputSchema>;
export type GenerateProvisionalCustomProductProfileInput = z.infer<
  typeof GenerateProvisionalCustomProductProfileInputSchema
>;
export type CustomProductPackageExportMode = z.infer<typeof CustomProductPackageExportModeSchema>;
export type CustomProductPackageCompleteness = z.infer<
  typeof CustomProductPackageCompletenessSchema
>;
export type CustomProductPackageAsset = z.infer<typeof CustomProductPackageAssetSchema>;
export type CustomProductPackageProduct = z.infer<typeof CustomProductPackageProductSchema>;
export type CustomProductPackageCustomization = z.infer<
  typeof CustomProductPackageCustomizationSchema
>;
export type CustomProductPackageCompetitor = z.infer<typeof CustomProductPackageCompetitorSchema>;
export type CustomProductPackageReviewInsights = z.infer<
  typeof CustomProductPackageReviewInsightsSchema
>;
export type CustomProductPackageBrandStyle = z.infer<typeof CustomProductPackageBrandStyleSchema>;
export type CustomProductPackageClaims = z.infer<typeof CustomProductPackageClaimsSchema>;
export type CustomProductPackageFile = z.infer<typeof CustomProductPackageFileSchema>;
export type CustomProductPackageManifestV1 = z.infer<typeof CustomProductPackageManifestV1Schema>;
export type CustomProductPackageV1 = z.infer<typeof CustomProductPackageV1Schema>;
