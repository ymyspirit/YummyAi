import { z } from "zod";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { TenantContextSchema } from "@yummyai/contracts/tenant/tenant-context";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { AdConversionDefinitionSchema, AdMetricColumnSelectionSchema, AdMetricCandidatesSchema,
  AdCurrencyBasisSchema, AdFactMeasurementSchema, AdFileMeasurementSchema, AdConversionBasisSchema } from "@yummyai/contracts/advertising/measurement";
export * from "@yummyai/contracts/advertising/measurement";

const Day = z.iso.date();
const Minor = z.number().int().nonnegative().safe();
const Count = z.number().int().nonnegative().safe();
const Key = z.string().trim().min(1).max(250);
const Currency = z.string().regex(/^[A-Z]{3}$/);
const Checksum = z.string().regex(/^[a-f0-9]{64}$/);
const AuthorityContext = TenantContextSchema.omit({ teamId: true }).extend({
  permissions: z.array(z.string().min(1).max(128)).max(256),
}).strict();
/** The existing ERP identity fence is canonical JSON, not a source checksum. */
export const AdContextAuthoritySchema = z.string().min(1).max(128 * 1024).refine(value => {
  try {
    const parsed = AuthorityContext.safeParse(JSON.parse(value));
    return parsed.success && erpSessionAuthority(parsed.data) === value;
  } catch { return false; }
}, "广告身份版本必须采用当前 ERP 的规范格式");
const Idempotency = z.string().trim().min(8).max(200);
export const AdMarketplaceSchema = z.enum([
  "US",
  "CA",
  "MX",
  "BR",
  "UK",
  "DE",
  "FR",
  "IT",
  "ES",
  "NL",
  "SE",
  "PL",
  "BE",
  "IE",
  "JP",
  "AU",
  "IN",
  "SG",
  "AE",
  "SA",
  "TR",
  "EG",
]);
export const AdProductSchema = z.enum(["SP", "SB", "SD"]);
export const AdReportTypeSchema = z.enum([
  "campaign",
  "advertised_product",
  "targeting",
  "search_term",
  "placement",
  "converted_product",
  "audience",
  "benchmark",
  "delivery_measurement",
  "search_term_share",
  "top_of_search_share",
]);
export const AdMetricsSchema = z
  .object({
    impressions: Count.nullable(),
    clicks: Count.nullable(),
    purchases: Count.nullable(),
    spendMinor: Minor.nullable(),
    salesMinor: Minor.nullable(),
  })
  .strict();
export const AdDiagnosticSchema = z
  .object({
    code: Key,
    severity: z.enum(["info", "warning", "error"]),
    message: z.string().max(1000),
    row: Count.nullable().default(null),
    column: z.string().max(200).nullable().default(null),
  })
  .strict();
export const AdFactSchema = z
  .object({
    sourceRow: Count.positive(),
    rowKey: Checksum,
    entityKey: Checksum,
    reportType: AdReportTypeSchema,
    adProduct: AdProductSchema.nullable(),
    advertiserId: z.string().max(250).nullable(),
    currency: Currency.nullable(),
    marketplace: AdMarketplaceSchema.nullable(),
    periodStart: Day.nullable(),
    periodEnd: Day.nullable(),
    grain: z.enum(["daily", "interval", "undated"]),
    campaignId: Key.nullable(),
    campaignName: z.string().max(1000).nullable(),
    adGroupId: Key.nullable(),
    adGroupName: z.string().max(1000).nullable(),
    asin: z
      .string()
      .regex(/^[A-Z0-9]{10}$/)
      .nullable(),
    productName: z.string().max(2000).nullable(),
    term: z.string().max(1000).nullable(),
    targetId: Key.nullable(),
    matchType: z.string().max(100).nullable(),
    bidMinor: Minor.nullable(),
    status: z.string().max(100).nullable(),
    placement: z.string().max(500).nullable(),
    metrics: AdMetricsSchema,
    dimensions: z.record(z.string().max(200), z.string().max(2000)),
    sourceFields: z.record(z.string().max(200), z.string().max(4000)),
    qualityCodes: z.array(Key).max(30),
    measurement: AdFactMeasurementSchema.optional(),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.measurement?.monetaryBasis && v.measurement.monetaryBasis.currency !== v.currency)
      c.addIssue({ code: "custom", path: ["measurement", "monetaryBasis"], message: "事实金额依据必须匹配原币种" });
    if (v.measurement && !v.measurement.monetaryBasis && [v.bidMinor,v.metrics.spendMinor,v.metrics.salesMinor].some(amount=>amount!==null))
      c.addIssue({ code: "custom", path: ["measurement", "monetaryBasis"], message: "缺精度依据不能转换金额 原单元格继续保留" });
    if (v.grain === "undated") {
      if (v.periodStart !== null || v.periodEnd !== null)
        c.addIssue({ code: "custom", path: ["grain"], message: "无日期事实不能附带推测日期" });
    } else {
      if (!v.periodStart || !v.periodEnd || v.periodEnd < v.periodStart)
        c.addIssue({ code: "custom", path: ["periodEnd"], message: "报告日期缺失或顺序无效" });
      if ((v.periodStart === v.periodEnd) !== (v.grain === "daily"))
        c.addIssue({ code: "custom", path: ["grain"], message: "报告粒度与日期范围不一致" });
    }
  });
export const AdParsedFileSchema = z
  .object({
    fileName: z.string().min(1).max(200),
    checksum: Checksum,
    byteSize: Count,
    reportType: AdReportTypeSchema.nullable(),
    headers: z.array(z.string().max(200)).max(200),
    sourceRowCount: Count,
    acceptedRowCount: Count,
    rejectedRowCount: Count,
    diagnosticCount: Count,
    diagnostics: z.array(AdDiagnosticSchema).max(250),
    facts: z.array(AdFactSchema).max(50000),
    measurement: AdFileMeasurementSchema.optional(),
    metricCandidates: AdMetricCandidatesSchema.optional(),
  })
  .strict();
export const AdCsvFileInputSchema = z
  .object({
    fileName: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine(
        (v) => !/[\\/]/.test(v) && ![...v].some((c) => c.codePointAt(0)! < 32),
        "文件名不能含路径或控制字符",
      ),
    content: z
      .string()
      .min(1)
      .max(5 * 1024 * 1024),
    reportTypeHint: AdReportTypeSchema.nullable().default(null),
    adProductHint: AdProductSchema.nullable().default(null),
    metricColumns: AdMetricColumnSelectionSchema.optional(),
  })
  .strict();
export const AdImportInputSchema = z
  .object({
    accountId: EntityIdSchema,
    marketplaceByCurrency: z.record(Currency, AdMarketplaceSchema),
    timezone: z
      .string()
      .min(1)
      .max(80)
      .refine((v) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: v }).format();
          return true;
        } catch {
          return false;
        }
      }, "请选择有效的报告时区"),
    attributionWindowDays: z.number().int().min(0).max(90).nullable(),
    attributionBasis: z.enum(["click", "click_and_view", "unknown"]),
    conversionDefinition: AdConversionDefinitionSchema.optional(),
    dateOrder: z.enum(["MDY", "DMY"]).nullable().default(null),
    observedAt: z.iso.datetime({ offset: true }),
    files: z.array(AdCsvFileInputSchema).min(1).max(20),
    allowPartial: z.boolean().default(false),
    idempotencyKey: Idempotency,
  })
  .strict();
export const AdCommitImportSchema = AdImportInputSchema.extend({ previewChecksum: Checksum });
export const AdImportPreviewSchema = z
  .object({
    previewChecksum: Checksum,
    canCommit: z.boolean(),
    files: z.array(
      AdParsedFileSchema.omit({ facts: true }).extend({ sample: z.array(AdFactSchema).max(20) }),
    ),
  })
  .strict();
export const AdArchiveInputSchema = z
  .object({ reason: z.string().trim().min(3).max(1000), idempotencyKey: Idempotency })
  .strict();
export const AdGoalFieldsSchema = z
  .object({
    mode: z.enum(["rank_growth", "profit_defense"]),
    effectiveFrom: Day,
    targetAcosBps: z.number().int().min(1).max(100000).nullable(),
    unitPriceMinor: Minor.positive().nullable(),
    unitCostMinor: Minor.nullable(),
    coreKeywords: z.array(z.string().trim().min(1).max(200)).max(30),
    protectedTerms: z.array(z.string().trim().min(1).max(200)).max(50),
    trialEndDate: Day.nullable(),
    trialSpendLimitMinor: Minor.positive().nullable(),
    minimumClicks: Count.positive().max(10000).default(15),
    minimumPurchases: Count.positive().max(1000).default(3),
    minimumSpendMinor: Minor.default(1000),
    maxBidChangeBps: z.number().int().min(1).max(5000).default(1500),
    profitReserveBps: z.number().int().min(0).max(9000).default(3000),
    cooldownDays: z.number().int().min(1).max(90).default(7),
    notes: z.string().max(2000).default(""),
    monetaryBasis: AdCurrencyBasisSchema.optional(),
  })
  .strict()
  .superRefine((v, c) => {
    if (
      v.mode === "rank_growth" &&
      (!v.coreKeywords.length || !v.trialEndDate || !v.trialSpendLimitMinor)
    )
      c.addIssue({
        code: "custom",
        path: ["trialEndDate"],
        message: "推排名需要核心词、试验结束日期和花费上限",
      });
    if (v.trialEndDate && v.trialEndDate < v.effectiveFrom)
      c.addIssue({
        code: "custom",
        path: ["trialEndDate"],
        message: "试验结束日期不能早于目标生效日期",
      });
    for (const field of ["coreKeywords", "protectedTerms"] as const)
      if (new Set(v[field].map(normalizeAdTerm)).size !== v[field].length)
        c.addIssue({ code: "custom", path: [field], message: "关键词不能重复" });
  });
export const AdProductScopeSchema = z
  .object({
    accountId: EntityIdSchema,
    marketplace: AdMarketplaceSchema,
    currency: Currency,
    asin: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9]{10}$/),
  })
  .strict();
export const AdSaveGoalInputSchema = z
  .object({
    scope: AdProductScopeSchema,
    expectedRevision: Count,
    fields: AdGoalFieldsSchema,
    idempotencyKey: Idempotency,
  })
  .strict();
export const AdGoalVersionSchema = z
  .object({
    id: EntityIdSchema,
    productId: EntityIdSchema,
    revision: Count.positive(),
    scope: AdProductScopeSchema,
    fields: AdGoalFieldsSchema,
    checksum: Checksum,
    createdAt: z.iso.datetime(),
  })
  .strict();
export const AdObservationInputSchema = z
  .object({
    scope: AdProductScopeSchema,
    kind: z.enum(["organic_rank", "commerce"]),
    periodStart: Day,
    periodEnd: Day,
    source: z.string().trim().min(3).max(1000),
    keyword: z.string().trim().min(1).max(200).nullable(),
    organicRank: Count.positive().max(100000).nullable(),
    totalSalesMinor: Minor.nullable(),
    totalPurchases: Count.nullable(),
    preAdContributionMinor: z.number().int().safe().nullable(),
    adsCoverageConfirmed: z.boolean().default(false),
    monetaryBasis: AdCurrencyBasisSchema.optional(),
    observedAt: z.iso.datetime({ offset: true }),
    idempotencyKey: Idempotency,
  })
  .strict()
  .superRefine((v, c) => {
    if (v.periodEnd < v.periodStart)
      c.addIssue({ code: "custom", path: ["periodEnd"], message: "结束日期早于开始日期" });
    if (
      v.kind === "organic_rank" &&
      (!v.keyword || v.organicRank === null || v.periodStart !== v.periodEnd)
    )
      c.addIssue({
        code: "custom",
        path: ["organicRank"],
        message: "自然排名需要关键词、实际名次和单日采集日期",
      });
    if (v.kind === "commerce" && (v.totalSalesMinor === null || v.totalPurchases === null))
      c.addIssue({
        code: "custom",
        path: ["totalSalesMinor"],
        message: "经营数据需要总销售额和总购买量",
      });
    if (v.kind === "commerce" && (v.keyword !== null || v.organicRank !== null))
      c.addIssue({ code: "custom", path: ["keyword"], message: "经营数据不能混入自然排名" });
    if (
      v.kind === "organic_rank" &&
      [v.totalSalesMinor, v.totalPurchases, v.preAdContributionMinor].some((x) => x !== null)
    )
      c.addIssue({
        code: "custom",
        path: ["totalSalesMinor"],
        message: "自然排名不能混入经营数据",
      });
  });
export const AdObservationSchema = z
  .object(AdObservationInputSchema.shape)
  .omit({ idempotencyKey: true })
  .extend({ id: EntityIdSchema, createdAt: z.iso.datetime() })
  .strict();
export const AdActionStatusSchema = z.enum([
  "pending",
  "adopted",
  "executed",
  "observing",
  "reviewed",
  "rejected",
  "deferred",
  "stale",
]);
export const AdRecommendationSchema = z
  .object({
    key: Checksum,
    ruleId: Key,
    kind: z.enum([
      "watch",
      "negate_term",
      "lower_bid",
      "raise_bid",
      "harvest_exact",
      "review_listing",
      "budget_guard",
    ]),
    priority: z.enum(["critical", "high", "normal"]),
    productId: EntityIdSchema.nullable(),
    goalVersionId: EntityIdSchema.nullable(),
    scope: AdProductScopeSchema.nullable(),
    accountId: EntityIdSchema,
    currency: Currency.nullable(),
    marketplace: AdMarketplaceSchema.nullable(),
    campaignId: Key.nullable(),
    adGroupId: Key.nullable(),
    targetId: Key.nullable(),
    term: z.string().max(1000).nullable(),
    title: z.string().max(300),
    reason: z.string().max(2000),
    currentBidMinor: Minor.nullable(),
    proposedBidMinor: Minor.nullable(),
    changeBps: z.number().int().nullable(),
    periodStart: Day,
    periodEnd: Day,
    metrics: AdMetricsSchema,
    monetaryBasis: AdCurrencyBasisSchema.nullable().optional(),
    conversion: AdConversionBasisSchema.optional(),
    evidenceKeys: z.array(Checksum).max(50000),
    constraints: z.array(z.string().max(500)).max(30),
    reviewAfter: Day,
  })
  .strict();
export const AdActionEventInputSchema = z
  .object({
    expectedRevision: Count.positive(),
    expectedStatus: AdActionStatusSchema,
    status: AdActionStatusSchema,
    reason: z.string().trim().min(3).max(2000),
    executedAt: z.iso.datetime({ offset: true }).nullable().default(null),
    actualBeforeMinor: Minor.nullable().default(null),
    actualAfterMinor: Minor.nullable().default(null),
    executionCampaignId: Key.nullable().default(null),
    executionAdGroupId: Key.nullable().default(null),
    executionTargetId: Key.nullable().default(null),
    idempotencyKey: Idempotency,
  })
  .strict()
  .superRefine((v, c) => {
    if (v.status === "executed" && !v.executedAt)
      c.addIssue({ code: "custom", path: ["executedAt"], message: "请记录实际执行时间" });
  });
export const AdAnalysisInputSchema = z
  .object({
    accountId: EntityIdSchema,
    periodStart: Day,
    periodEnd: Day,
    marketplace: AdMarketplaceSchema.nullable().default(null),
    currency: Currency.nullable().default(null),
    evidenceCutoffAt: z.iso.datetime({ offset: true }),
    idempotencyKey: Idempotency,
  })
  .strict()
  .superRefine((v, c) => {
    if (v.periodEnd < v.periodStart)
      c.addIssue({ code: "custom", path: ["periodEnd"], message: "分析结束日期早于开始日期" });
  });
export const AdImportViewSchema = z
  .object({
    id: EntityIdSchema,
    accountId: EntityIdSchema,
    fileName: z.string(),
    checksum: Checksum,
    periodStart: Day.nullable(),
    periodEnd: Day.nullable(),
    reportType: AdReportTypeSchema,
    timezone: z.string(),
    attributionWindowDays: Count.nullable(),
    attributionBasis: z.enum(["click", "click_and_view", "unknown"]),
    observedAt: z.iso.datetime(),
    recordedAt: z.iso.datetime(),
    sourceRowCount: Count,
    acceptedRowCount: Count,
    rejectedRowCount: Count,
    diagnostics: z.array(AdDiagnosticSchema),
    archivedAt: z.iso.datetime().nullable(),
    measurement: AdFileMeasurementSchema.optional(),
  })
  .strict();
export const AdStoredFactSchema = z
  .object({
    id: EntityIdSchema,
    importId: EntityIdSchema,
    accountId: EntityIdSchema,
    observedAt: z.iso.datetime(),
    recordedAt: z.iso.datetime(),
    timezone: z.string(),
    attributionWindowDays: Count.nullable(),
    attributionBasis: z.enum(["click", "click_and_view", "unknown"]),
    fact: AdFactSchema,
    sourceChecksum: Checksum.optional(),
    sourceArchivedAt: z.iso.datetime().nullable().optional(),
  })
  .strict();
export const AdActionViewSchema = z
  .object({
    id: EntityIdSchema,
    runId: EntityIdSchema,
    status: AdActionStatusSchema,
    revision: Count.positive(),
    recommendation: AdRecommendationSchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    executedAt: z.iso.datetime().nullable(),
    actualBeforeMinor: Minor.nullable(),
    actualAfterMinor: Minor.nullable(),
    execution: z
      .object({ campaignId: Key.nullable(), adGroupId: Key.nullable(), targetId: Key.nullable() })
      .strict()
      .nullable(),
    /** Workspace previews omit events; exact record reads retain the full sequence. */
    eventsComplete: z.boolean().optional(),
    events: z.array(
      z
        .object({
          id: EntityIdSchema,
          status: AdActionStatusSchema,
          reason: z.string(),
          at: z.iso.datetime(),
        })
        .strict(),
    ),
  })
  .strict();
export const AdRatioMetricsSchema = z
  .object({
    ctrBps: Count.nullable(),
    cvrBps: Count.nullable(),
    acosBps: Count.nullable(),
    roasBps: Count.nullable(),
    cpcMinor: Minor.nullable(),
  })
  .strict();
export const AdProductSummarySchema = z
  .object({
    key: Key,
    scope: AdProductScopeSchema,
    productName: z.string().nullable(),
    measurementScope: z.string(),
    monetaryBasis: AdCurrencyBasisSchema.nullable().optional(),
    conversion: AdConversionBasisSchema.optional(),
    productId: EntityIdSchema.nullable(),
    goal: AdGoalVersionSchema.nullable(),
    metrics: AdMetricsSchema,
    ratios: AdRatioMetricsSchema,
    periodStart: Day,
    periodEnd: Day,
    reportCount: Count,
    breakEvenAcosBps: z.number().int().nullable(),
    postAdContributionMinor: z.number().int().safe().nullable(),
    tacosBps: Count.nullable(),
    observations: z.array(AdObservationSchema),
    qualityCodes: z.array(Key),
  })
  .strict();
export const AdMeasurementPinSchema = z.object({
  importId: EntityIdSchema, currency: Currency.nullable(), sourceChecksum: Checksum.nullable(), observedAt: z.iso.datetime(),
  timezone: z.string().max(80), declaredWindowDays: Count.nullable(),
  declaredBasis: z.enum(["click", "click_and_view", "unknown"]),
  sourceArchivedAt: z.iso.datetime().nullable(), measurement: AdFactMeasurementSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.measurement?.monetaryBasis && value.measurement.monetaryBasis.currency !== value.currency)
    context.addIssue({ code: "custom", path: ["currency"], message: "来源测量与币种依据不一致" });
});
export const AdAnalysisResultSchema = z
  .object({
    measurementVersion: z.literal(1).optional(),
    measurementPins: z.array(AdMeasurementPinSchema).max(100000).optional(),
    controlType: AdReportTypeSchema.nullable(),
    totals: z.array(
      z
        .object({
          currency: Currency,
          marketplace: AdMarketplaceSchema.nullable(),
          advertiserId: Key.nullable(),
          adProduct: AdProductSchema.nullable(),
          measurementScope: z.string(),
          monetaryBasis: AdCurrencyBasisSchema.nullable().optional(),
          conversion: AdConversionBasisSchema.optional(),
          metrics: AdMetricsSchema,
          ratios: AdRatioMetricsSchema,
        })
        .strict(),
    ),
    products: z.array(AdProductSummarySchema),
    recommendations: z.array(AdRecommendationSchema),
    diagnostics: z.array(AdDiagnosticSchema),
    evidenceImportIds: z.array(EntityIdSchema),
    goalVersionIds: z.array(EntityIdSchema),
    selectedFactCount: Count,
    supersededFactCount: Count,
    dailyTrend: z.array(
      z
        .object({
          date: Day,
          currency: Currency,
          marketplace: AdMarketplaceSchema.nullable(),
          measurementScope: z.string(),
          monetaryBasis: AdCurrencyBasisSchema.nullable().optional(),
          conversion: AdConversionBasisSchema.optional(),
          metrics: AdMetricsSchema,
        })
        .strict(),
    ),
  })
  .strict().superRefine((value, context) => {
    if (value.measurementVersion !== 1) {
      if (value.measurementPins !== undefined) context.addIssue({ code: "custom", path: ["measurementVersion"], message: "结构化测量依据必须有明确版本" });
      return;
    }
    const pins = value.measurementPins;
    if (!pins || new Set(pins.map(pin => `${pin.importId}:${pin.currency}`)).size !== pins.length)
      context.addIssue({ code: "custom", path: ["measurementPins"], message: "新分析必须固定逐来源币种且不重复的测量依据" });
    const ids = new Set(pins?.map(pin => pin.importId));
    if (ids.size !== value.evidenceImportIds.length || value.evidenceImportIds.some(id => !ids.has(id)))
      context.addIssue({ code: "custom", path: ["measurementPins"], message: "测量依据必须完整覆盖实际采用的来源" });
  });
export const AdAnalysisRunSchema = z
  .object({
    id: EntityIdSchema,
    accountId: EntityIdSchema,
    periodStart: Day,
    periodEnd: Day,
    marketplace: AdMarketplaceSchema.nullable(),
    currency: Currency.nullable(),
    evidenceCutoffAt: z.iso.datetime(),
    status: z.enum(["complete", "partial"]),
    inputChecksum: Checksum,
    createdAt: z.iso.datetime(),
    result: AdAnalysisResultSchema,
  })
  .strict().superRefine((value, context) => {
    if (value.result.measurementPins?.some(pin => Date.parse(pin.observedAt) > Date.parse(value.evidenceCutoffAt)))
      context.addIssue({ code: "custom", path: ["result", "measurementPins"], message: "分析不能采用截止后才采集的来源" });
  });
/** Capabilities are recalculated from current membership for each account. */
export const AdAccessSchema = z.object({
  canRead: z.boolean(),
  canWrite: z.boolean(),
  canReview: z.boolean(),
}).strict();
export const AdCommitImportResultSchema = z.object({
  imports: z.array(AdImportViewSchema).min(1).max(20),
  replayed: z.boolean(),
}).strict();
export const AdvertisingWorkspaceSchema = z
  .object({
    accountId: EntityIdSchema.nullable(),
    contextAuthority: AdContextAuthoritySchema,
    access: AdAccessSchema,
    accounts: z.array(
      z
        .object({
          id: EntityIdSchema,
          name: z.string(),
          marketplaceIds: z.array(z.string()),
          status: z.string(),
          access: AdAccessSchema,
        })
        .strict(),
    ),
    imports: z.array(AdImportViewSchema),
    goals: z.array(AdGoalVersionSchema),
    observations: z.array(AdObservationSchema),
    actions: z.array(AdActionViewSchema),
    analyses: z.array(AdAnalysisRunSchema),
    historyWindow: z.object({schemaVersion:z.literal(1),
      imports:z.object({loaded:Count,limit:Count.positive(),hasMore:z.boolean()}).strict(),
      goals:z.object({loaded:Count,limit:Count.positive(),hasMore:z.boolean()}).strict(),
      observations:z.object({loaded:Count,limit:Count.positive(),hasMore:z.boolean()}).strict(),
      actions:z.object({loaded:Count,limit:Count.positive(),hasMore:z.boolean()}).strict(),
      analyses:z.object({loaded:Count,limit:Count.positive(),hasMore:z.boolean()}).strict(),
    }).strict().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const accounts = new Map(value.accounts.map(account => [account.id, account]));
    if (accounts.size !== value.accounts.length)
      context.addIssue({ code: "custom", path: ["accounts"], message: "广告账户不能重复" });
    if (value.accountId && !accounts.has(value.accountId))
      context.addIssue({ code: "custom", path: ["accountId"], message: "广告账户与工作区范围不一致" });
    for (const account of value.accounts) {
      for (const permission of ["canRead", "canWrite", "canReview"] as const)
        if (account.access[permission] && !value.access[permission])
          context.addIssue({ code: "custom", path: ["accounts"], message: "账户权限不能超出当前成员权限" });
    }
    const check = (accountId: string, path: string) => {
      if (!accounts.get(accountId)?.access.canRead || value.accountId && accountId !== value.accountId)
        context.addIssue({ code: "custom", path: [path], message: "广告资料超出本次可读账户范围" });
    };
    value.imports.forEach(item => check(item.accountId, "imports"));
    value.goals.forEach(item => check(item.scope.accountId, "goals"));
    value.observations.forEach(item => check(item.scope.accountId, "observations"));
    value.actions.forEach(item => check(item.recommendation.accountId, "actions"));
    value.analyses.forEach(item => check(item.accountId, "analyses"));
    if(value.historyWindow)for(const kind of["imports","goals","observations","actions","analyses"] as const){
      const window=value.historyWindow[kind];
      if(window.loaded!==value[kind].length||window.loaded>window.limit||window.hasMore&&window.loaded!==window.limit)
        context.addIssue({code:"custom",path:["historyWindow",kind],message:"近期工作区必须明确已载数量和剩余历史"});
    }
  });
export const AdFactQuerySchema = z
  .object({
    accountId: EntityIdSchema,
    reportType: AdReportTypeSchema.optional(),
    search: z.string().trim().max(200).default(""),
    page: z.coerce.number().int().min(1).max(10000).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export const AdFactPageSchema = z
  .object({
    accountId: EntityIdSchema,
    contextAuthority: AdContextAuthoritySchema,
    rows: z.array(AdStoredFactSchema).max(200),
    count: Count,
    page: Count.positive().max(10000),
    pageSize: Count.positive().max(200),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.rows.length > value.pageSize || value.rows.length > value.count ||
      new Set(value.rows.map(item => item.id)).size !== value.rows.length ||
      value.rows.some(item => item.accountId !== value.accountId))
      context.addIssue({ code: "custom", path: ["rows"], message: "广告明细与账户或分页范围不一致" });
  });
export const AdWorkspaceQuerySchema = z.object({ accountId: EntityIdSchema.optional() }).strict();
export const AdEmptyQuerySchema = z.object({}).strict();
export const AdExportInputSchema = z
  .object({
    runId: EntityIdSchema,
    actionIds: z.array(EntityIdSchema).min(1).max(500),
    reviewReason: z.string().trim().min(3).max(2000),
    idempotencyKey: Idempotency,
  })
  .strict()
  .refine((v) => new Set(v.actionIds).size === v.actionIds.length, "不能重复选择调整记录");
export const AdExportViewSchema = z
  .object({
    id: EntityIdSchema,
    runId: EntityIdSchema,
    checksum: Checksum,
    createdAt: z.iso.datetime(),
    reviewReason: z.string(),
    payload: z
      .object({
        schemaVersion: z.literal(1),
        csvFormatVersion: z.literal(2).optional(),
        run: AdAnalysisRunSchema,
        actions: z.array(
          AdActionViewSchema.extend({ execution: AdActionViewSchema.shape.execution.optional() }),
        ),
        sourcePins: z.array(AdImportViewSchema).optional(),
        reviewedBy: EntityIdSchema,
        marketplaceExecution: z.literal("manual"),
      })
      .strict(),
  })
  .strict();

export function normalizeAdTerm(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}
export type AdReportType = z.infer<typeof AdReportTypeSchema>;
export type AdMarketplace = z.infer<typeof AdMarketplaceSchema>;
export type AdProduct = z.infer<typeof AdProductSchema>;
export type AdMetrics = z.infer<typeof AdMetricsSchema>;
export type AdFact = z.infer<typeof AdFactSchema>;
export type AdParsedFile = z.infer<typeof AdParsedFileSchema>;
export type AdDiagnostic = z.infer<typeof AdDiagnosticSchema>;
export type AdImportInput = z.infer<typeof AdImportInputSchema>;
export type AdGoalFields = z.infer<typeof AdGoalFieldsSchema>;
export type AdGoalVersion = z.infer<typeof AdGoalVersionSchema>;
export type AdProductScope = z.infer<typeof AdProductScopeSchema>;
export type AdSaveGoalInput = z.infer<typeof AdSaveGoalInputSchema>;
export type AdObservationInput = z.infer<typeof AdObservationInputSchema>;
export type AdObservation = z.infer<typeof AdObservationSchema>;
export type AdRecommendation = z.infer<typeof AdRecommendationSchema>;
export type AdActionStatus = z.infer<typeof AdActionStatusSchema>;
export type AdActionEventInput = z.infer<typeof AdActionEventInputSchema>;
export type AdActionView = z.infer<typeof AdActionViewSchema>;
export type AdAnalysisInput = z.infer<typeof AdAnalysisInputSchema>;
export type AdAnalysisResult = z.infer<typeof AdAnalysisResultSchema>;
export type AdStoredFact = z.infer<typeof AdStoredFactSchema>;
export type AdMeasurementPin = z.infer<typeof AdMeasurementPinSchema>;
export type AdImportView = z.infer<typeof AdImportViewSchema>;
export type AdAnalysisRun = z.infer<typeof AdAnalysisRunSchema>;
export type AdProductSummary = z.infer<typeof AdProductSummarySchema>;
export type AdvertisingWorkspace = z.infer<typeof AdvertisingWorkspaceSchema>;
export type AdAccess = z.infer<typeof AdAccessSchema>;
export type AdImportPreview = z.infer<typeof AdImportPreviewSchema>;
export type AdCommitImport = z.infer<typeof AdCommitImportSchema>;
export type AdFactQuery = z.infer<typeof AdFactQuerySchema>;
export type AdFactPage = z.infer<typeof AdFactPageSchema>;
export type AdExportInput = z.infer<typeof AdExportInputSchema>;
export type AdExportView = z.infer<typeof AdExportViewSchema>;
