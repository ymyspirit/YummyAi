import { z } from "zod";

import { CapturePlatformSchema } from "@yummyai/contracts/capture";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";

export const ResearchClassificationStatusSchema = z.enum([
  "unclassified",
  "suggested",
  "confirmed",
]);

export const ResearchClassificationSourceSchema = z.enum([
  "marketplace_taxonomy",
  "ehunt_category",
  "amazon_bsr",
  "manual",
]);

export const ResearchClassificationEvidenceSourceSchema = z.enum([
  "marketplace_taxonomy",
  "ehunt_category",
  "amazon_bsr",
]);

export const ResearchProductTypeSchema = z.object({
  key: z.string().min(1).max(160),
  name: z.string().min(1).max(120),
});

export const ResearchItemClassificationSchema = z.object({
  productType: ResearchProductTypeSchema.nullable(),
  status: ResearchClassificationStatusSchema,
  source: ResearchClassificationSourceSchema.nullable(),
  evidenceSource: ResearchClassificationEvidenceSourceSchema.nullable(),
  evidenceLabel: z.string().min(1).max(300).nullable(),
  updatedAt: z.iso.datetime().nullable(),
});

export const ResearchItemSummarySchema = z.object({
  id: EntityIdSchema,
  lastCapturedAt: z.iso.datetime(),
  latestStatus: z.enum(["normalizing", "complete", "partial", "failed"]),
  latestTitle: z.string().nullable(),
  marketplace: z.string().min(1),
  normalizedUrl: z.url(),
  platform: CapturePlatformSchema,
  shopName: z.string().nullable(),
  classification: ResearchItemClassificationSchema,
});

export const ResearchListResponseSchema = z.object({
  items: z.array(ResearchItemSummarySchema),
  nextCursor: z.iso.datetime().nullable(),
  total: z.int().nonnegative(),
});

export const ResearchProductTypeFacetSchema = ResearchProductTypeSchema.extend({
  confirmed: z.int().nonnegative(),
  suggested: z.int().nonnegative(),
  total: z.int().nonnegative(),
});

export const ResearchProductTypeFacetResponseSchema = z.object({
  items: z.array(ResearchProductTypeFacetSchema),
});

export const AssignResearchProductTypeInputSchema = z.object({
  itemIds: z
    .array(EntityIdSchema)
    .min(1)
    .max(100)
    .refine((ids) => new Set(ids).size === ids.length, "itemIds must be unique"),
  productTypeName: z.string().trim().min(1).max(120).nullable(),
});

export const AssignResearchProductTypeResultSchema = z.object({
  cascaded: z.int().nonnegative(),
  classification: ResearchItemClassificationSchema,
  updated: z.int().positive(),
});

export type ResearchClassificationStatus = z.infer<
  typeof ResearchClassificationStatusSchema
>;
export type ResearchClassificationSource = z.infer<
  typeof ResearchClassificationSourceSchema
>;
export type ResearchClassificationEvidenceSource = z.infer<
  typeof ResearchClassificationEvidenceSourceSchema
>;
export type ResearchProductType = z.infer<typeof ResearchProductTypeSchema>;
export type ResearchItemClassification = z.infer<
  typeof ResearchItemClassificationSchema
>;
export type ResearchItemSummary = z.infer<typeof ResearchItemSummarySchema>;
export type ResearchListResponse = z.infer<typeof ResearchListResponseSchema>;
export type ResearchProductTypeFacet = z.infer<typeof ResearchProductTypeFacetSchema>;
export type AssignResearchProductTypeInput = z.infer<
  typeof AssignResearchProductTypeInputSchema
>;
export type AssignResearchProductTypeResult = z.infer<
  typeof AssignResearchProductTypeResultSchema
>;
