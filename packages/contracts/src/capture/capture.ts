import { z } from "zod";

export const CapturePlatformSchema = z.enum(["amazon", "etsy"]);
export const CaptureDomainSchema = z.enum(["research", "authorized"]);
export const CaptureStatusSchema = z.enum(["complete", "partial", "failed"]);

export const CaptureDiagnosticSchema = z.object({
  field: z.string().min(1),
  code: z.enum(["missing", "invalid", "selector_error"]),
  message: z.string().min(1),
  severity: z.enum(["warning", "error"]),
});

export const CaptureMediaSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["image", "video"]),
  sourceUrl: z.url(),
  alt: z.string().optional(),
  included: z.boolean().default(true),
});

export const CaptureVariantSchema = z.object({
  label: z.string().min(1),
  options: z.array(
    z.object({
      label: z.string().min(1),
      externalId: z.string().optional(),
    }),
  ),
});

export const CaptureContentBlockSchema = z.object({
  kind: z.enum(["description", "aplus", "personalization", "review"]),
  text: z.string().min(1),
  sourceSelector: z.string().min(1),
});

export const CapturePriceSchema = z.object({
  raw: z.string().min(1),
  amount: z.number().nonnegative().optional(),
  currency: z.string().length(3).optional(),
});

export const CaptureShippingSchema = z.object({
  estimatedDelivery: z.string().min(1).nullable(),
  processingTime: z.string().min(1).nullable(),
  cost: CapturePriceSchema.nullable(),
  shipsFrom: z.string().min(1).nullable(),
  destination: z.string().min(1).nullable(),
  sourceSelector: z.string().min(1),
});

export const CapturedShopSummarySchema = z.object({
  platform: CapturePlatformSchema,
  externalId: z.string().min(1).nullable(),
  name: z.string().min(1),
  sourceUrl: z.url(),
  location: z.string().min(1).nullable(),
  ownerName: z.string().min(1).nullable(),
  rating: z.number().min(0).max(5).nullable(),
  reviewCount: z.number().int().nonnegative().nullable(),
  salesCount: z.number().int().nonnegative().nullable(),
  activeListingCount: z.number().int().nonnegative().nullable(),
  admirerCount: z.number().int().nonnegative().nullable(),
  openedYear: z.number().int().min(1900).max(2200).nullable(),
  yearsOnPlatform: z.number().int().nonnegative().nullable(),
  badges: z.array(z.string().min(1)),
});

export const CompetitorShopMemberSchema = z.object({
  name: z.string().min(1),
  role: z.string().min(1).nullable(),
});

export const CompetitorShopDraftSchema = CapturedShopSummarySchema.extend({
  parserVersion: z.string().min(1),
  extensionVersion: z.string().min(1),
  marketplace: z.string().min(1),
  announcement: z.string().min(1).nullable(),
  about: z.string().min(1).nullable(),
  policies: z.string().min(1).nullable(),
  members: z.array(CompetitorShopMemberSchema),
  productionPartners: z.array(z.string().min(1)),
  missingFields: z.array(z.string().min(1)),
  diagnostics: z.array(CaptureDiagnosticSchema),
  captureStatus: CaptureStatusSchema,
  capturedAt: z.iso.datetime(),
});

export const CaptureTaxonomyNodeSchema = z.object({
  label: z.string().min(1),
  url: z.url(),
});

export const CaptureReviewTagSchema = z.object({
  label: z.string().min(1),
  category: z.string().min(1).nullable(),
});

export const CaptureReviewSummarySchema = z.object({
  label: z.string().min(1),
  tags: z.array(CaptureReviewTagSchema),
  itemAverage: z.number().min(0).max(5).nullable(),
  itemQuality: z.number().min(0).max(5).nullable(),
  shipping: z.number().min(0).max(5).nullable(),
  customerService: z.number().min(0).max(5).nullable(),
  recommendPercent: z.number().min(0).max(100).nullable(),
  reviewCount: z.number().int().nonnegative().nullable(),
  sourceSelector: z.string().min(1),
});

export const CapturedReviewSchema = z.object({
  externalId: z.string().min(1),
  rating: z.number().min(0).max(5).nullable(),
  recommends: z.boolean().nullable(),
  author: z.string().min(1).nullable(),
  publishedAt: z.string().min(1).nullable(),
  text: z.string().min(1),
  variants: z.array(z.string().min(1)),
  sourceSelector: z.string().min(1),
});

export const CaptureReviewCollectionSchema = z.object({
  collectedCount: z.number().int().nonnegative(),
  reportedTotal: z.number().int().nonnegative().nullable(),
  pageCount: z.number().int().nonnegative(),
  status: z.enum(["visible", "in_progress", "complete", "paused"]),
  updatedAt: z.iso.datetime(),
});

export const CaptureDraftSchema = z.object({
  platform: CapturePlatformSchema,
  parserVersion: z.string().min(1),
  extensionVersion: z.string().min(1),
  marketplace: z.string().min(1),
  sourceUrl: z.url(),
  externalId: z.string().min(1).nullable(),
  title: z.string().min(1).nullable(),
  domain: CaptureDomainSchema.default("research"),
  price: CapturePriceSchema.nullable(),
  rating: z.number().min(0).max(5).nullable(),
  reviewCount: z.number().int().nonnegative().nullable(),
  taxonomy: z.array(CaptureTaxonomyNodeSchema),
  listingPublishedAt: z.string().min(1).nullable(),
  favoriteCount: z.number().int().nonnegative().nullable(),
  shipping: CaptureShippingSchema.nullable(),
  shop: CapturedShopSummarySchema.nullable(),
  reviewSummary: CaptureReviewSummarySchema.nullable(),
  reviews: z.array(CapturedReviewSchema),
  reviewCollection: CaptureReviewCollectionSchema,
  bullets: z.array(z.string().min(1)),
  media: z.array(CaptureMediaSchema),
  variants: z.array(CaptureVariantSchema),
  contentBlocks: z.array(CaptureContentBlockSchema),
  missingFields: z.array(z.string().min(1)),
  diagnostics: z.array(CaptureDiagnosticSchema),
  captureStatus: CaptureStatusSchema,
  capturedAt: z.iso.datetime(),
});

export type CaptureDraft = z.infer<typeof CaptureDraftSchema>;
export type AmazonCaptureDraft = CaptureDraft & { platform: "amazon" };
export type EtsyCaptureDraft = CaptureDraft & { platform: "etsy" };
export type CaptureDomain = z.infer<typeof CaptureDomainSchema>;
export type CaptureStatus = z.infer<typeof CaptureStatusSchema>;
export type CaptureShipping = z.infer<typeof CaptureShippingSchema>;
export type CapturedShopSummary = z.infer<typeof CapturedShopSummarySchema>;
export type CompetitorShopDraft = z.infer<typeof CompetitorShopDraftSchema>;
export type CompetitorShopMember = z.infer<typeof CompetitorShopMemberSchema>;
export type CaptureTaxonomyNode = z.infer<typeof CaptureTaxonomyNodeSchema>;
export type CaptureReviewSummary = z.infer<typeof CaptureReviewSummarySchema>;
export type CapturedReview = z.infer<typeof CapturedReviewSchema>;
export type CaptureReviewCollection = z.infer<typeof CaptureReviewCollectionSchema>;
