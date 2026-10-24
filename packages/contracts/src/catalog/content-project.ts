import { z } from "zod";
import { EntityIdSchema as Id } from "@yummyai/contracts/common/ids";
import { CreativeRequirementsSchema } from "@yummyai/contracts/catalog/artwork";
import { CanvasResultViewSchema } from "@yummyai/contracts/pod/canvas-bridge";
import { ResearchSourceReferenceSchema } from "@yummyai/contracts/research/creative";

export const ContentProjectQuerySchema = z
  .object({
    q: z.string().trim().max(200).default(""),
    page: z.coerce.number().int().min(1).max(10000).default(1),
    pageSize: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();
export const ContentProjectSummarySchema = z.object({
  id: Id,
  name: z.string(),
  briefId: Id,
  stepName: z.string(),
  resultCount: z.int().nonnegative(),
  approvedCount: z.int().nonnegative(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const ContentProjectListSchema = z.object({
  items: z.array(ContentProjectSummarySchema),
  total: z.int().nonnegative(),
  page: z.int().positive(),
  pageSize: z.int().positive(),
});
export const ContentStageKeySchema = z.enum([
  "research",
  "design",
  "sku",
  "mockup",
  "listing",
  "delivery",
]);
export const ContentStageSchema = z.object({
  key: ContentStageKeySchema,
  label: z.string(),
  status: z.enum(["not_started", "in_progress", "complete", "blocked", "unauthorized", "optional"]),
  detail: z.string(),
});
export const ContentArtworkSchema = z.object({
  id: Id,
  versionId: Id,
  creativeVersionId: Id,
  code: z.string(),
  name: z.string(),
  version: z.int().positive(),
  current: z.boolean(),
  archived: z.boolean(),
});
export const ContentSkuSchema = z.object({
  id: Id,
  code: z.string(),
  spuName: z.string(),
  recipeId: Id,
  recipeVersion: z.int().positive(),
  artworkVersionId: Id,
  specificationVersionId: Id,
  specificationName: z.string(),
  factsConfirmed: z.boolean(),
  material: z.string(),
  dimensions: z.string(),
  packageContents: z.string(),
  status: z.enum(["pending_adaptation", "in_adaptation", "ready_for_customization", "approved"]),
  designVersionId: Id.nullable(),
  needsUpdate: z.boolean(),
  belongsToProject: z.boolean(),
});
export const ContentMockupSchema = z.object({
  itemId: Id,
  batchId: Id,
  skuId: Id,
  skuCode: z.string(),
  designVersionId: Id,
  status: z.string(),
  requiredCount: z.int().nonnegative(),
  approvedCount: z.int().nonnegative(),
  failedCount: z.int().nonnegative(),
  current: z.boolean(),
});
export const ContentListingSchema = z.object({
  id: Id,
  versionId: Id,
  version: z.int().positive(),
  title: z.string(),
  platform: z.enum(["amazon", "etsy"]),
  locale: z.string(),
  status: z.string(),
  blockers: z.array(z.string()),
  skuIds: z.array(Id),
});
export const ContentPackageSchema = z.object({
  id: Id,
  skuId: Id,
  skuCode: z.string(),
  recipeId: Id,
  listingId: Id,
  listingVersionId: Id,
  version: z.int().positive(),
  platform: z.enum(["amazon", "etsy"]),
  locale: z.string(),
  checksum: z.string(),
  current: z.boolean(),
  createdAt: z.iso.datetime(),
});
export const ContentProjectSchema = z.object({
  id: Id,
  name: z.string(),
  briefId: Id,
  prompt: z.string(),
  requirements: CreativeRequirementsSchema.nullable(),
  legacy: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  access: z.object({
    research: z.boolean(),
    catalog: z.boolean(),
    listing: z.boolean(),
    assets: z.boolean(),
  }),
  researchSources: z.array(ResearchSourceReferenceSchema),
  steps: z.array(
    z.object({
      id: Id,
      name: z.string(),
      index: z.int().nonnegative(),
      resultCount: z.int().nonnegative(),
      approvedCount: z.int().nonnegative(),
    }),
  ),
  results: z.array(CanvasResultViewSchema),
  artworks: z.array(ContentArtworkSchema),
  skus: z.array(ContentSkuSchema),
  mockups: z.array(ContentMockupSchema),
  listings: z.array(ContentListingSchema),
  packages: z.array(ContentPackageSchema),
  stages: z.array(ContentStageSchema),
  diagnostics: z.array(z.string()),
});
export type ContentProject = z.infer<typeof ContentProjectSchema>;
export type ContentProjectQuery = z.infer<typeof ContentProjectQuerySchema>;
export type ContentStage = z.infer<typeof ContentStageSchema>;
