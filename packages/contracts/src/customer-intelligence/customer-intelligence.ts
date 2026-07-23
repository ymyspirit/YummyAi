import { z } from "zod";

import { EntityIdSchema } from "@yummyai/contracts/common/ids";

const IdempotencyKeySchema = z.string().trim().min(8).max(200);
const CodeSchema = z.string().trim().min(1).max(100).regex(/^[A-Z0-9][A-Z0-9._-]*$/);
const CurrencySchema = z.string().regex(/^[A-Z]{3}$/);
const ChecksumSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const AdvertisingProviderSchema = z.enum(["amazon_ads", "etsy_ads", "manual"]);
export const AdvertisingEntityLevelSchema = z.enum(["campaign", "ad_group", "keyword", "search_term"]);
export const CustomerSignalSourceSchema = z.enum([
  "review",
  "return_reason",
  "support_contact",
  "quality_defect",
  "keyword",
]);
export const CustomerSignalSentimentSchema = z.enum(["negative", "neutral", "positive", "mixed"]);
export const CustomerSignalConsentSchema = z.enum([
  "public_page",
  "marketplace_authorization",
  "customer_support",
  "internal_quality",
  "advertising_authorization",
]);
export const CustomerRecommendationActionSchema = z.enum([
  "investigate_product",
  "review_listing_expectations",
  "review_campaign_terms",
  "review_service_process",
]);

export const AdvertisingMetricLineInputSchema = z.object({
  lineKey: z.string().trim().min(1).max(200),
  entityLevel: AdvertisingEntityLevelSchema,
  externalCampaignId: z.string().trim().min(1).max(200),
  externalAdGroupId: z.string().trim().min(1).max(200).nullable().default(null),
  normalizedTerm: z.string().trim().min(1).max(200).nullable().default(null),
  identityRedacted: z.literal(true),
  listingId: EntityIdSchema.nullable().default(null),
  skuId: EntityIdSchema.nullable().default(null),
  impressions: z.number().int().nonnegative().safe(),
  clicks: z.number().int().nonnegative().safe(),
  orders: z.number().int().nonnegative().safe(),
  spendMinor: z.number().int().nonnegative().safe(),
  salesMinor: z.number().int().nonnegative().safe(),
}).strict().superRefine((value, context) => {
  if (value.clicks > value.impressions) {
    context.addIssue({ code: "custom", path: ["clicks"], message: "Clicks cannot exceed impressions" });
  }
  if (value.orders > value.clicks) {
    context.addIssue({ code: "custom", path: ["orders"], message: "Orders cannot exceed clicks" });
  }
  if ((value.entityLevel === "keyword" || value.entityLevel === "search_term") !== (value.normalizedTerm !== null)) {
    context.addIssue({ code: "custom", path: ["normalizedTerm"], message: "Keyword and search-term rows require a redacted normalized term" });
  }
});

export const RecordAdvertisingReportInputSchema = z.object({
  provider: AdvertisingProviderSchema,
  accountId: EntityIdSchema.nullable().default(null),
  externalReportId: z.string().trim().min(1).max(200),
  scopeKey: z.string().trim().min(1).max(200),
  periodStart: z.iso.datetime(),
  periodEnd: z.iso.datetime(),
  attributionWindowDays: z.number().int().nonnegative().max(365),
  sourceCurrency: CurrencySchema,
  observedAt: z.iso.datetime(),
  lines: z.array(AdvertisingMetricLineInputSchema).min(1).max(20_000),
  idempotencyKey: IdempotencyKeySchema,
}).strict().superRefine((value, context) => {
  if (new Date(value.periodEnd) < new Date(value.periodStart)) {
    context.addIssue({ code: "custom", path: ["periodEnd"], message: "Report period end must not precede start" });
  }
  if (new Set(value.lines.map((line) => line.lineKey)).size !== value.lines.length) {
    context.addIssue({ code: "custom", path: ["lines"], message: "Advertising line keys must be unique" });
  }
  if (new Date(value.observedAt) < new Date(value.periodEnd)) {
    context.addIssue({ code: "custom", path: ["observedAt"], message: "Advertising evidence cannot be observed before the report period ends" });
  }
  if ((value.provider === "manual") !== (value.accountId === null)) {
    context.addIssue({ code: "custom", path: ["accountId"], message: "Authorized provider reports require an account; manual reports must not claim one" });
  }
});

export const RecordCustomerSignalInputSchema = z.object({
  sourceType: CustomerSignalSourceSchema,
  sourceId: EntityIdSchema,
  themeCode: CodeSchema,
  sentiment: CustomerSignalSentimentSchema,
  occurrenceCount: z.number().int().positive().max(1_000_000),
  occurredAt: z.iso.datetime(),
  consentBasis: CustomerSignalConsentSchema,
  identityRedacted: z.literal(true),
  excerptChecksum: ChecksumSchema,
  idempotencyKey: IdempotencyKeySchema,
}).strict().superRefine((value, context) => {
  const allowed: Record<CustomerSignalSource, CustomerSignalConsent[]> = {
    review: ["public_page", "marketplace_authorization"],
    return_reason: ["marketplace_authorization", "customer_support"],
    support_contact: ["customer_support"],
    quality_defect: ["internal_quality"],
    keyword: ["advertising_authorization"],
  };
  if (!allowed[value.sourceType].includes(value.consentBasis)) {
    context.addIssue({ code: "custom", path: ["consentBasis"], message: "Consent basis does not match the customer signal source" });
  }
});

export const VocSourceWeightSchema = z.object({
  sourceType: CustomerSignalSourceSchema,
  weightBps: z.number().int().min(0).max(10_000),
}).strict();

export const UpsertVocDefinitionInputSchema = z.object({
  definitionId: EntityIdSchema.nullable().default(null),
  name: z.string().trim().min(1).max(160),
  sourceWeights: z.array(VocSourceWeightSchema).min(1).max(5),
  minimumOccurrences: z.number().int().positive().max(1_000_000),
  reasonCode: CodeSchema,
  idempotencyKey: IdempotencyKeySchema,
}).strict().superRefine((value, context) => {
  if (new Set(value.sourceWeights.map((entry) => entry.sourceType)).size !== value.sourceWeights.length) {
    context.addIssue({ code: "custom", path: ["sourceWeights"], message: "VOC source weights must be unique" });
  }
  if (value.sourceWeights.reduce((sum, entry) => sum + entry.weightBps, 0) !== 10_000) {
    context.addIssue({ code: "custom", path: ["sourceWeights"], message: "VOC source weights must sum to 10000 bps" });
  }
});

export const CalculateVocAnalysisInputSchema = z.object({
  definitionId: EntityIdSchema,
  expectedDefinitionVersion: z.number().int().positive(),
  windowStart: z.iso.datetime(),
  windowEnd: z.iso.datetime(),
  evidenceCutoffAt: z.iso.datetime(),
  idempotencyKey: IdempotencyKeySchema,
}).strict().superRefine((value, context) => {
  const start = new Date(value.windowStart);
  const end = new Date(value.windowEnd);
  const cutoff = new Date(value.evidenceCutoffAt);
  if (end <= start) context.addIssue({ code: "custom", path: ["windowEnd"], message: "VOC window end must follow start" });
  if (cutoff < end) context.addIssue({ code: "custom", path: ["evidenceCutoffAt"], message: "Evidence cutoff must cover the complete window" });
});

export const ReviewCustomerRecommendationInputSchema = z.object({
  expectedStatus: z.literal("pending"),
  decision: z.enum(["approved", "rejected"]),
  reasonCode: CodeSchema,
  idempotencyKey: IdempotencyKeySchema,
}).strict();

export const AdvertisingMetricLineViewSchema = z.object({
  lineKey: z.string(),
  entityLevel: AdvertisingEntityLevelSchema,
  externalCampaignId: z.string(),
  externalAdGroupId: z.string().nullable(),
  normalizedTerm: z.string().nullable(),
  listingId: EntityIdSchema.nullable(),
  skuId: EntityIdSchema.nullable(),
  impressions: z.number().int().nonnegative().safe(),
  clicks: z.number().int().nonnegative().safe(),
  orders: z.number().int().nonnegative().safe(),
  spendMinor: z.number().int().nonnegative().safe(),
  salesMinor: z.number().int().nonnegative().safe(),
  id: EntityIdSchema,
  ctrBps: z.number().int().min(0).max(10_000).nullable(),
  conversionBps: z.number().int().min(0).max(10_000).nullable(),
  roasBps: z.number().int().nonnegative().nullable(),
}).strict();

export const AdvertisingReportViewSchema = z.object({
  id: EntityIdSchema,
  provider: AdvertisingProviderSchema,
  accountId: EntityIdSchema.nullable(),
  externalReportId: z.string(),
  scopeKey: z.string(),
  periodStart: z.iso.datetime(),
  periodEnd: z.iso.datetime(),
  attributionWindowDays: z.number().int().nonnegative(),
  sourceCurrency: CurrencySchema,
  observedAt: z.iso.datetime(),
  checksum: ChecksumSchema,
  recordedAt: z.iso.datetime(),
  totals: z.object({
    impressions: z.number().int().nonnegative(),
    clicks: z.number().int().nonnegative(),
    orders: z.number().int().nonnegative(),
    spendMinor: z.number().int().nonnegative(),
    salesMinor: z.number().int().nonnegative(),
  }).strict(),
  lines: z.array(AdvertisingMetricLineViewSchema),
}).strict();

export const CustomerSignalViewSchema = z.object({
  id: EntityIdSchema,
  sourceType: CustomerSignalSourceSchema,
  sourceId: EntityIdSchema,
  themeCode: CodeSchema,
  sentiment: CustomerSignalSentimentSchema,
  occurrenceCount: z.number().int().positive().max(1_000_000),
  occurredAt: z.iso.datetime(),
  consentBasis: CustomerSignalConsentSchema,
  excerptChecksum: ChecksumSchema,
  recordedAt: z.iso.datetime(),
}).strict();

export const VocDefinitionVersionViewSchema = z.object({
  id: EntityIdSchema,
  definitionId: EntityIdSchema,
  versionNumber: z.number().int().positive(),
  sourceWeights: z.array(VocSourceWeightSchema),
  minimumOccurrences: z.number().int().positive(),
  reasonCode: z.string(),
  checksum: ChecksumSchema,
  createdAt: z.iso.datetime(),
}).strict();

export const VocDefinitionViewSchema = z.object({
  id: EntityIdSchema,
  name: z.string(),
  currentVersion: z.number().int().positive(),
  status: z.enum(["active", "inactive"]),
  version: VocDefinitionVersionViewSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).strict();

export const VocThemeMetricViewSchema = z.object({
  id: EntityIdSchema,
  themeCode: z.string(),
  totalOccurrences: z.number().int().nonnegative(),
  negativeOccurrences: z.number().int().nonnegative(),
  negativeBps: z.number().int().min(0).max(10_000).nullable(),
  weightedScore: z.number().int().nonnegative(),
  sourceCounts: z.record(CustomerSignalSourceSchema, z.number().int().nonnegative()),
  signalIds: z.array(EntityIdSchema),
}).strict();

export const CustomerRecommendationViewSchema = z.object({
  id: EntityIdSchema,
  runId: EntityIdSchema,
  themeCode: z.string(),
  action: CustomerRecommendationActionSchema,
  status: z.enum(["pending", "approved", "rejected"]),
  evidenceSignalIds: z.array(EntityIdSchema),
  createdAt: z.iso.datetime(),
  reviewedAt: z.iso.datetime().nullable(),
}).strict();

export const VocAnalysisRunViewSchema = z.object({
  id: EntityIdSchema,
  definitionId: EntityIdSchema,
  definitionVersionId: EntityIdSchema,
  definitionVersion: z.number().int().positive(),
  status: z.enum(["complete", "incomplete"]),
  windowStart: z.iso.datetime(),
  windowEnd: z.iso.datetime(),
  evidenceCutoffAt: z.iso.datetime(),
  signalIds: z.array(EntityIdSchema),
  inputChecksum: ChecksumSchema,
  calculatedAt: z.iso.datetime(),
  themes: z.array(VocThemeMetricViewSchema),
  recommendations: z.array(CustomerRecommendationViewSchema),
}).strict();

export const CustomerIntelligenceWorkspaceViewSchema = z.object({
  advertisingReports: z.array(AdvertisingReportViewSchema),
  signals: z.array(CustomerSignalViewSchema),
  definitions: z.array(VocDefinitionViewSchema),
  analyses: z.array(VocAnalysisRunViewSchema),
}).strict();

export type AdvertisingProvider = z.infer<typeof AdvertisingProviderSchema>;
export type AdvertisingEntityLevel = z.infer<typeof AdvertisingEntityLevelSchema>;
export type AdvertisingMetricLineInput = z.infer<typeof AdvertisingMetricLineInputSchema>;
export type RecordAdvertisingReportInput = z.infer<typeof RecordAdvertisingReportInputSchema>;
export type CustomerSignalSource = z.infer<typeof CustomerSignalSourceSchema>;
export type CustomerSignalSentiment = z.infer<typeof CustomerSignalSentimentSchema>;
export type CustomerSignalConsent = z.infer<typeof CustomerSignalConsentSchema>;
export type CustomerRecommendationAction = z.infer<typeof CustomerRecommendationActionSchema>;
export type RecordCustomerSignalInput = z.infer<typeof RecordCustomerSignalInputSchema>;
export type VocSourceWeight = z.infer<typeof VocSourceWeightSchema>;
export type UpsertVocDefinitionInput = z.infer<typeof UpsertVocDefinitionInputSchema>;
export type CalculateVocAnalysisInput = z.infer<typeof CalculateVocAnalysisInputSchema>;
export type ReviewCustomerRecommendationInput = z.infer<typeof ReviewCustomerRecommendationInputSchema>;
export type AdvertisingMetricLineView = z.infer<typeof AdvertisingMetricLineViewSchema>;
export type AdvertisingReportView = z.infer<typeof AdvertisingReportViewSchema>;
export type CustomerSignalView = z.infer<typeof CustomerSignalViewSchema>;
export type VocDefinitionView = z.infer<typeof VocDefinitionViewSchema>;
export type VocAnalysisRunView = z.infer<typeof VocAnalysisRunViewSchema>;
export type CustomerRecommendationView = z.infer<typeof CustomerRecommendationViewSchema>;
export type CustomerIntelligenceWorkspaceView = z.infer<typeof CustomerIntelligenceWorkspaceViewSchema>;
