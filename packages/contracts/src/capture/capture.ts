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
  yearsOnPlatform: z.number().nonnegative().nullable(),
  badges: z.array(z.string().min(1)),
});

export const CompetitorShopMemberSchema = z.object({
  name: z.string().min(1),
  role: z.string().min(1).nullable(),
});

export const CompetitorShopSectionSchema = z.object({
  kind: z.enum(["all", "sale", "category"]),
  externalId: z.string().min(1),
  name: z.string().min(1),
  listingCount: z.number().int().nonnegative().nullable(),
  sourceUrl: z.url().nullable(),
});

export const CaptureEhuntShopMetricSchema = z.object({
  raw: z.string().min(1),
  value: z.number().nonnegative().nullable(),
});

export const CaptureEhuntShopProductSchema = z.object({
  title: z.string().min(1),
  detailUrl: z.url().nullable(),
  imageUrl: z.url().nullable(),
  totalSales: CaptureEhuntShopMetricSchema.nullable(),
  price: CapturePriceSchema.nullable(),
});

export const CaptureEhuntShopTagSchema = z.object({
  label: z.string().min(1),
  frequency: CaptureEhuntShopMetricSchema.nullable(),
  competition: CaptureEhuntShopMetricSchema.nullable(),
  views: CaptureEhuntShopMetricSchema.nullable(),
  viewDelta: CaptureEhuntShopMetricSchema.nullable(),
  favorites: CaptureEhuntShopMetricSchema.nullable(),
  favoriteDelta: CaptureEhuntShopMetricSchema.nullable(),
  sales: CaptureEhuntShopMetricSchema.nullable(),
  salesDelta: CaptureEhuntShopMetricSchema.nullable(),
});

export const CaptureEhuntShopCategorySchema = z.object({
  path: z.array(z.string().min(1)).min(1),
  sharePercent: z.number().min(0).max(100).nullable(),
  raw: z.string().min(1),
});

export const CaptureEhuntShopTrendValueSchema = z.object({
  label: z.string().min(1),
  metric: CaptureEhuntShopMetricSchema,
});

export const CaptureEhuntShopTrendPointSchema = z.object({
  period: z.string().min(1),
  values: z.array(CaptureEhuntShopTrendValueSchema).min(1),
});

export const CaptureEhuntShopProductSectionSchema = z.object({
  kind: z.enum(["hot_products", "new_products", "delisted_products"]),
  label: z.string().min(1),
  items: z.array(CaptureEhuntShopProductSchema).min(1),
});

export const CaptureEhuntShopTagSectionSchema = z.object({
  kind: z.literal("common_tags"),
  label: z.string().min(1),
  items: z.array(CaptureEhuntShopTagSchema).min(1),
});

export const CaptureEhuntShopCategorySectionSchema = z.object({
  kind: z.literal("popular_categories"),
  label: z.string().min(1),
  items: z.array(CaptureEhuntShopCategorySchema).min(1),
});

export const CaptureEhuntShopTrendSectionSchema = z.object({
  kind: z.literal("history_trend"),
  label: z.string().min(1),
  points: z.array(CaptureEhuntShopTrendPointSchema).min(1),
});

export const CaptureEhuntShopActiveSectionSchema = z.union([
  CaptureEhuntShopProductSectionSchema,
  CaptureEhuntShopTagSectionSchema,
  CaptureEhuntShopCategorySectionSchema,
  CaptureEhuntShopTrendSectionSchema,
]);

export const CaptureEhuntShopAnalysisSchema = z.object({
  provider: z.literal("ehunt"),
  sourceSelector: z.string().min(1),
  openedAt: z.string().min(1).nullable(),
  primaryCategory: z.string().min(1).nullable(),
  country: z.string().min(1).nullable(),
  weeklySales: CaptureEhuntShopMetricSchema.nullable(),
  weeklyRevenue: CapturePriceSchema.nullable(),
  weeklyReviews: CaptureEhuntShopMetricSchema.nullable(),
  totalSales: CaptureEhuntShopMetricSchema.nullable(),
  totalRevenue: CapturePriceSchema.nullable(),
  totalReviews: CaptureEhuntShopMetricSchema.nullable(),
  weeklyFavorites: CaptureEhuntShopMetricSchema.nullable(),
  listingCount: CaptureEhuntShopMetricSchema.nullable(),
  rating: z.number().min(0).max(5).nullable(),
  totalFavorites: CaptureEhuntShopMetricSchema.nullable(),
  starSeller: z.boolean().nullable(),
  socialMedia: z.array(z.string().min(1)),
  paymentMethods: z.array(z.string().min(1)),
  activeSection: CaptureEhuntShopActiveSectionSchema.nullable(),
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
  shopSections: z.array(CompetitorShopSectionSchema).default([]),
  ehuntAnalysis: CaptureEhuntShopAnalysisSchema.optional(),
  missingFields: z.array(z.string().min(1)),
  diagnostics: z.array(CaptureDiagnosticSchema),
  captureStatus: CaptureStatusSchema,
  capturedAt: z.iso.datetime(),
});

export const CaptureTaxonomyNodeSchema = z.object({
  label: z.string().min(1),
  url: z.url(),
});

export const CaptureProductInformationLinkSchema = z.object({
  label: z.string().min(1),
  url: z.url(),
});

export const CaptureProductInformationItemSchema = z.object({
  label: z.string().min(1),
  value: z.string().min(1),
  links: z.array(CaptureProductInformationLinkSchema),
});

export const CaptureProductInformationSectionSchema = z.object({
  name: z.string().min(1),
  items: z.array(CaptureProductInformationItemSchema).min(1),
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

export const CaptureEhuntTagSchema = z.object({
  label: z.string().min(1),
  metricRaw: z.string().min(1).nullable(),
  metricValue: z.number().nonnegative().nullable(),
});

export const CaptureEhuntAnalysisSchema = z.object({
  provider: z.literal("ehunt"),
  sourceSelector: z.string().min(1),
  listingPublishedAt: z.string().min(1).nullable(),
  totalSales: z.number().int().nonnegative().nullable(),
  salesDelta: z.number().nonnegative().nullable(),
  totalRevenue: CapturePriceSchema.nullable(),
  revenueDelta: CapturePriceSchema.nullable(),
  viewCount: z.number().int().nonnegative().nullable(),
  reviewCount: z.number().int().nonnegative().nullable(),
  reviewDelta: z.number().nonnegative().nullable(),
  favoriteCount: z.number().int().nonnegative().nullable(),
  favoriteDelta: z.number().nonnegative().nullable(),
  conversionRatePercent: z.number().min(0).nullable(),
  reviewRatePercent: z.number().min(0).nullable(),
  price: CapturePriceSchema.nullable(),
  productTypes: z.array(z.string().min(1)),
  shipsFrom: z.string().min(1).nullable(),
  badges: z.array(z.string().min(1)),
  inventoryCount: z.number().int().nonnegative().nullable(),
  categoryPath: z.array(z.string().min(1)),
  tags: z.array(CaptureEhuntTagSchema),
  annualTrendUrl: z.url().nullable(),
  shopName: z.string().min(1).nullable(),
  shopRating: z.number().min(0).max(5).nullable(),
  shopSalesCount: z.number().int().nonnegative().nullable(),
  shopSalesDelta: z.number().nonnegative().nullable(),
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
  ehuntAnalysis: CaptureEhuntAnalysisSchema.optional(),
  bullets: z.array(z.string().min(1)),
  media: z.array(CaptureMediaSchema),
  variants: z.array(CaptureVariantSchema),
  productInformation: z.array(CaptureProductInformationSectionSchema).default([]),
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
export type CompetitorShopSection = z.infer<typeof CompetitorShopSectionSchema>;
export type CaptureEhuntShopMetric = z.infer<typeof CaptureEhuntShopMetricSchema>;
export type CaptureEhuntShopProduct = z.infer<typeof CaptureEhuntShopProductSchema>;
export type CaptureEhuntShopTag = z.infer<typeof CaptureEhuntShopTagSchema>;
export type CaptureEhuntShopCategory = z.infer<typeof CaptureEhuntShopCategorySchema>;
export type CaptureEhuntShopTrendPoint = z.infer<typeof CaptureEhuntShopTrendPointSchema>;
export type CaptureEhuntShopActiveSection = z.infer<
  typeof CaptureEhuntShopActiveSectionSchema
>;
export type CaptureEhuntShopAnalysis = z.infer<typeof CaptureEhuntShopAnalysisSchema>;
export type CaptureTaxonomyNode = z.infer<typeof CaptureTaxonomyNodeSchema>;
export type CaptureProductInformationLink = z.infer<
  typeof CaptureProductInformationLinkSchema
>;
export type CaptureProductInformationItem = z.infer<
  typeof CaptureProductInformationItemSchema
>;
export type CaptureProductInformationSection = z.infer<
  typeof CaptureProductInformationSectionSchema
>;
export type CaptureReviewSummary = z.infer<typeof CaptureReviewSummarySchema>;
export type CapturedReview = z.infer<typeof CapturedReviewSchema>;
export type CaptureReviewCollection = z.infer<typeof CaptureReviewCollectionSchema>;
export type CaptureEhuntTag = z.infer<typeof CaptureEhuntTagSchema>;
export type CaptureEhuntAnalysis = z.infer<typeof CaptureEhuntAnalysisSchema>;
