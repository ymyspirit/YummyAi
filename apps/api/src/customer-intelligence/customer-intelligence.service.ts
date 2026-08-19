import { createHash } from "node:crypto";
import { ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  AdvertisingMetricLineViewSchema, AdvertisingReportViewSchema, CalculateVocAnalysisInputSchema,
  CustomerIntelligenceWorkspaceViewSchema, CustomerRecommendationViewSchema, CustomerSignalViewSchema,
  RecordAdvertisingReportInputSchema, RecordCustomerSignalInputSchema, ReviewCustomerRecommendationInputSchema,
  UpsertVocDefinitionInputSchema, VocAnalysisRunViewSchema, VocDefinitionViewSchema, VocDefinitionVersionViewSchema,
  VocThemeMetricViewSchema, type AdvertisingMetricLineView, type AdvertisingReportView, type CalculateVocAnalysisInput,
  type CustomerIntelligenceWorkspaceView, type CustomerRecommendationView, type CustomerSignalView, type RecordAdvertisingReportInput,
  type RecordCustomerSignalInput, type ReviewCustomerRecommendationInput, type UpsertVocDefinitionInput,
} from "@yummyai/contracts/customer-intelligence";
import {
  advertisingMetricLines, advertisingReports, afterSalesCases, customerContactRecords, customerRecommendationReviewEvents,
  customerRecommendations, customerSignalFacts, qualityDefects, vocAnalysisRuns, vocDefinitionVersions, vocDefinitions,
  vocThemeMetrics, type DatabaseConnection, type TenantTransaction, withTenant, captureSnapshots, marketplaceAccounts,
} from "@yummyai/database";
import { and, asc, desc, eq, gte, lt, lte, sql } from "drizzle-orm";
import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION } from "../platform.tokens.js";

@Injectable()
export class CustomerIntelligenceService {
  constructor(@Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection, @Inject(AuditService) private readonly audit: AuditService) {}

  async recordAdvertisingReport(context: TenantContext, raw: RecordAdvertisingReportInput): Promise<AdvertisingReportView> {
    const input = RecordAdvertisingReportInputSchema.parse(raw);
    const lines = [...input.lines].sort((a, b) => a.lineKey.localeCompare(b.lineKey));
    const checksum = hash({ ...input, lines, idempotencyKey: undefined });
    const report = await withTenant(this.database.db, context, async (tx) => {
      if (input.accountId) {
        const [account] = await tx.select({ platform: marketplaceAccounts.platform }).from(marketplaceAccounts).where(eq(marketplaceAccounts.id, input.accountId)).limit(1);
        if (!account) throw new UnprocessableEntityException("Advertising account was not found");
        if ((input.provider === "amazon_ads" && account.platform !== "amazon") || (input.provider === "etsy_ads" && account.platform !== "etsy")) throw new UnprocessableEntityException("Advertising provider does not match the marketplace account");
      }
      await lock(tx, `advertising-report:${context.tenantId}:${input.idempotencyKey}`);
      const [replayed] = await tx.select().from(advertisingReports).where(eq(advertisingReports.idempotencyKey, input.idempotencyKey)).limit(1);
      if (replayed) { if (replayed.checksum !== checksum) throw new ConflictException("Advertising report idempotency key was reused"); return replayed; }
      const [created] = await tx.insert(advertisingReports).values({ id: createEntityId(), tenantId: context.tenantId, provider: input.provider, accountId: input.accountId, externalReportId: input.externalReportId, scopeKey: input.scopeKey, periodStart: new Date(input.periodStart), periodEnd: new Date(input.periodEnd), attributionWindowDays: input.attributionWindowDays, sourceCurrency: input.sourceCurrency, observedAt: new Date(input.observedAt), checksum, idempotencyKey: input.idempotencyKey, recordedBy: context.userId }).returning();
      await tx.insert(advertisingMetricLines).values(lines.map((line) => ({ id: createEntityId(), tenantId: context.tenantId, reportId: created.id, ...line })));
      return created;
    });
    const view = await withTenant(this.database.db, context, (tx) => advertisingReportView(tx, report));
    await this.audit.record(context, { action: "customer_intelligence.advertising.record", resourceType: "advertising_report", resourceId: view.id, result: "success", metadata: { provider: view.provider, lineCount: view.lines.length } });
    return view;
  }

  async recordCustomerSignal(context: TenantContext, raw: RecordCustomerSignalInput): Promise<CustomerSignalView> {
    const input = RecordCustomerSignalInputSchema.parse(raw);
    const signal = await withTenant(this.database.db, context, async (tx) => {
      await validateSignalSource(tx, input.sourceType, input.sourceId);
      await lock(tx, `customer-signal:${context.tenantId}:${input.idempotencyKey}`);
      const [replayed] = await tx.select().from(customerSignalFacts).where(eq(customerSignalFacts.idempotencyKey, input.idempotencyKey)).limit(1);
      if (replayed) { if (replayed.excerptChecksum !== input.excerptChecksum) throw new ConflictException("Customer signal idempotency key was reused"); return replayed; }
      const [created] = await tx.insert(customerSignalFacts).values({ id: createEntityId(), tenantId: context.tenantId, ...input, identityRedacted: true, occurredAt: new Date(input.occurredAt), recordedBy: context.userId }).returning();
      return created;
    });
    const view = signalView(signal);
    await this.audit.record(context, { action: "customer_intelligence.signal.record", resourceType: "customer_signal_fact", resourceId: view.id, result: "success", metadata: { sourceType: view.sourceType, consentBasis: view.consentBasis } });
    return view;
  }

  async upsertDefinition(context: TenantContext, raw: UpsertVocDefinitionInput) {
    const input = UpsertVocDefinitionInputSchema.parse(raw);
    const checksum = hash({ name: input.name, sourceWeights: input.sourceWeights, minimumOccurrences: input.minimumOccurrences, reasonCode: input.reasonCode });
    const definition = await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `voc-definition:${context.tenantId}:${input.definitionId ?? input.name}`);
      const [replayed] = await tx.select().from(vocDefinitionVersions).where(eq(vocDefinitionVersions.idempotencyKey, input.idempotencyKey)).limit(1);
      if (replayed) { if (replayed.checksum !== checksum) throw new ConflictException("VOC definition idempotency key was reused"); const [parent] = await tx.select().from(vocDefinitions).where(eq(vocDefinitions.id, replayed.definitionId)).limit(1); if (!parent) throw new NotFoundException("VOC definition not found"); return parent; }
      let parent;
      if (input.definitionId) { [parent] = await tx.select().from(vocDefinitions).where(eq(vocDefinitions.id, input.definitionId)).limit(1); if (!parent) throw new NotFoundException("VOC definition not found"); if (parent.name !== input.name) throw new UnprocessableEntityException("VOC definition name is immutable"); }
      else { [parent] = await tx.insert(vocDefinitions).values({ id: createEntityId(), tenantId: context.tenantId, name: input.name, currentVersion: 1, status: "active", createdBy: context.userId }).returning(); }
      const versionNumber = input.definitionId ? parent.currentVersion + 1 : 1;
      await tx.insert(vocDefinitionVersions).values({ id: createEntityId(), tenantId: context.tenantId, definitionId: parent.id, versionNumber, sourceWeights: input.sourceWeights, minimumOccurrences: input.minimumOccurrences, reasonCode: input.reasonCode, checksum, idempotencyKey: input.idempotencyKey, createdBy: context.userId });
      if (parent.currentVersion !== versionNumber) [parent] = await tx.update(vocDefinitions).set({ currentVersion: versionNumber, updatedAt: new Date() }).where(eq(vocDefinitions.id, parent.id)).returning();
      return parent;
    });
    const view = await withTenant(this.database.db, context, (tx) => vocDefinitionView(tx, definition));
    await this.audit.record(context, { action: "customer_intelligence.definition.version", resourceType: "voc_definition", resourceId: view.id, result: "success", metadata: { version: view.currentVersion, sourceCount: view.version.sourceWeights.length } });
    return view;
  }

  async calculateAnalysis(context: TenantContext, raw: CalculateVocAnalysisInput) {
    const input = CalculateVocAnalysisInputSchema.parse(raw);
    const run = await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `voc-analysis:${context.tenantId}:${input.idempotencyKey}`);
      const [definition] = await tx.select().from(vocDefinitions).where(eq(vocDefinitions.id, input.definitionId)).limit(1);
      if (!definition) throw new NotFoundException("VOC definition not found");
      if (definition.currentVersion !== input.expectedDefinitionVersion) throw new ConflictException("VOC definition version changed");
      const [version] = await tx.select().from(vocDefinitionVersions).where(and(eq(vocDefinitionVersions.definitionId, definition.id), eq(vocDefinitionVersions.versionNumber, input.expectedDefinitionVersion))).limit(1);
      if (!version) throw new NotFoundException("VOC definition version not found");
      const signals = await tx.select().from(customerSignalFacts).where(and(gte(customerSignalFacts.occurredAt, new Date(input.windowStart)), lt(customerSignalFacts.occurredAt, new Date(input.windowEnd)), lte(customerSignalFacts.recordedAt, new Date(input.evidenceCutoffAt)))).orderBy(asc(customerSignalFacts.occurredAt));
      const inputChecksum = hash({ definitionVersionId: version.id, windowStart: input.windowStart, windowEnd: input.windowEnd, signalIds: signals.map((s) => s.id), signals: signals.map((s) => ({ id: s.id, themeCode: s.themeCode, sourceType: s.sourceType, sentiment: s.sentiment, occurrenceCount: s.occurrenceCount })) });
      const [replayed] = await tx.select().from(vocAnalysisRuns).where(eq(vocAnalysisRuns.idempotencyKey, input.idempotencyKey)).limit(1);
      if (replayed) { if (replayed.inputChecksum !== inputChecksum) throw new ConflictException("VOC analysis idempotency key was reused"); return replayed; }
      const grouped = new Map<string, typeof signals>(); for (const signal of signals) grouped.set(signal.themeCode, [...(grouped.get(signal.themeCode) ?? []), signal]);
      const eligibleThemes = [...grouped.entries()].filter(([, rows]) => rows.reduce((sum, row) => sum + row.occurrenceCount, 0) >= version.minimumOccurrences);
      const [created] = await tx.insert(vocAnalysisRuns).values({ id: createEntityId(), tenantId: context.tenantId, definitionId: definition.id, definitionVersionId: version.id, definitionVersion: version.versionNumber, status: eligibleThemes.length ? "complete" : "incomplete", windowStart: new Date(input.windowStart), windowEnd: new Date(input.windowEnd), evidenceCutoffAt: new Date(input.evidenceCutoffAt), signalIds: signals.map((s) => s.id), inputChecksum, idempotencyKey: input.idempotencyKey, calculatedBy: context.userId }).returning();
      for (const [themeCode, rows] of eligibleThemes) {
        const total = rows.reduce((sum, row) => sum + row.occurrenceCount, 0); const negative = rows.filter((row) => row.sentiment === "negative").reduce((sum, row) => sum + row.occurrenceCount, 0);
        const sourceCounts: Record<"review" | "return_reason" | "support_contact" | "quality_defect" | "keyword", number> = { review: 0, return_reason: 0, support_contact: 0, quality_defect: 0, keyword: 0 };
        for (const row of rows) sourceCounts[row.sourceType] += row.occurrenceCount;
        const sourceWeights = new Map(version.sourceWeights.map((entry) => [entry.sourceType, entry.weightBps]));
        const weightedScore = rows.reduce((sum, row) => sum + row.occurrenceCount * sentimentWeight(row.sentiment) * (sourceWeights.get(row.sourceType) ?? 0), 0);
        await tx.insert(vocThemeMetrics).values({ id: createEntityId(), tenantId: context.tenantId, runId: created.id, themeCode, totalOccurrences: total, negativeOccurrences: negative, negativeBps: total ? Math.round((negative * 10000) / total) : null, weightedScore, sourceCounts, signalIds: rows.map((row) => row.id) });
        await tx.insert(customerRecommendations).values({ id: createEntityId(), tenantId: context.tenantId, runId: created.id, themeCode, action: recommendationAction(themeCode), status: "pending", evidenceSignalIds: rows.map((row) => row.id) });
      }
      return created;
    });
    const view = await withTenant(this.database.db, context, (tx) => analysisView(tx, run));
    await this.audit.record(context, { action: "customer_intelligence.voc.calculate", resourceType: "voc_analysis_run", resourceId: view.id, result: "success", metadata: { status: view.status, signalCount: view.signalIds.length } });
    return view;
  }

  async reviewRecommendation(context: TenantContext, recommendationId: string, raw: ReviewCustomerRecommendationInput): Promise<CustomerRecommendationView> {
    const input = ReviewCustomerRecommendationInputSchema.parse(raw);
    const result = await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `voc-recommendation:${context.tenantId}:${recommendationId}`);
      const [existingEvent] = await tx.select().from(customerRecommendationReviewEvents).where(eq(customerRecommendationReviewEvents.idempotencyKey, input.idempotencyKey)).limit(1);
      if (existingEvent) {
        if (existingEvent.recommendationId !== recommendationId || existingEvent.decision !== input.decision || existingEvent.reasonCode !== input.reasonCode) throw new ConflictException("Recommendation review idempotency key was reused");
        const [replayed] = await tx.select().from(customerRecommendations).where(eq(customerRecommendations.id, recommendationId)).limit(1);
        if (!replayed) throw new NotFoundException("Customer recommendation not found");
        return replayed;
      }
      const [recommendation] = await tx.select().from(customerRecommendations).where(eq(customerRecommendations.id, recommendationId)).limit(1);
      if (!recommendation) throw new NotFoundException("Customer recommendation not found");
      if (recommendation.status !== input.expectedStatus) throw new ConflictException("Recommendation is no longer pending");
      await tx.insert(customerRecommendationReviewEvents).values({ id: createEntityId(), tenantId: context.tenantId, recommendationId, decision: input.decision, reasonCode: input.reasonCode, idempotencyKey: input.idempotencyKey, reviewedBy: context.userId });
      const [updated] = await tx.update(customerRecommendations).set({ status: input.decision, reviewedAt: new Date() }).where(eq(customerRecommendations.id, recommendationId)).returning();
      return updated;
    });
    const view = CustomerRecommendationViewSchema.parse({ id: result.id, runId: result.runId, themeCode: result.themeCode, action: result.action, status: result.status, evidenceSignalIds: result.evidenceSignalIds, createdAt: result.createdAt.toISOString(), reviewedAt: result.reviewedAt?.toISOString() ?? null });
    await this.audit.record(context, { action: `customer_intelligence.recommendation.${input.decision}`, resourceType: "customer_recommendation", resourceId: view.id, result: "success", metadata: { reasonCode: input.reasonCode } });
    return view;
  }

  async workspace(context: TenantContext): Promise<CustomerIntelligenceWorkspaceView> {
    return withTenant(this.database.db, context, async (tx) => {
      const [reports, signals, definitions, analyses] = await Promise.all([tx.select().from(advertisingReports).orderBy(desc(advertisingReports.recordedAt)).limit(100), tx.select().from(customerSignalFacts).orderBy(desc(customerSignalFacts.occurredAt)).limit(250), tx.select().from(vocDefinitions).orderBy(asc(vocDefinitions.name)).limit(100), tx.select().from(vocAnalysisRuns).orderBy(desc(vocAnalysisRuns.calculatedAt)).limit(100)]);
      return CustomerIntelligenceWorkspaceViewSchema.parse({ advertisingReports: await Promise.all(reports.map((row) => advertisingReportView(tx, row))), signals: signals.map(signalView), definitions: await Promise.all(definitions.map((row) => vocDefinitionView(tx, row))), analyses: await Promise.all(analyses.map((row) => analysisView(tx, row))) });
    });
  }
}

function hash(value: unknown) { return createHash("sha256").update(stableStringify(value)).digest("hex"); }
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
  return JSON.stringify(value);
}
async function lock(tx: TenantTransaction, key: string) { await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`); }
async function validateSignalSource(tx: TenantTransaction, sourceType: RecordCustomerSignalInput["sourceType"], sourceId: string) {
  let row: { id: string } | undefined;
  if (sourceType === "review") {
    const [snapshot] = await tx.select({ id: captureSnapshots.id, draft: captureSnapshots.draft }).from(captureSnapshots).where(eq(captureSnapshots.id, sourceId)).limit(1);
    if (snapshot?.draft.reviews.length) row = { id: snapshot.id };
  }
  else if (sourceType === "support_contact") [row] = await tx.select({ id: customerContactRecords.id }).from(customerContactRecords).where(eq(customerContactRecords.id, sourceId)).limit(1);
  else if (sourceType === "return_reason") [row] = await tx.select({ id: afterSalesCases.id }).from(afterSalesCases).where(eq(afterSalesCases.id, sourceId)).limit(1);
  else if (sourceType === "quality_defect") [row] = await tx.select({ id: qualityDefects.id }).from(qualityDefects).where(eq(qualityDefects.id, sourceId)).limit(1);
  else {
    const [line] = await tx.select({ id: advertisingMetricLines.id, entityLevel: advertisingMetricLines.entityLevel }).from(advertisingMetricLines).where(eq(advertisingMetricLines.id, sourceId)).limit(1);
    if (line && (line.entityLevel === "keyword" || line.entityLevel === "search_term")) row = { id: line.id };
  }
  if (!row) throw new UnprocessableEntityException("Customer signal source evidence was not found");
}
function signalView(row: typeof customerSignalFacts.$inferSelect): CustomerSignalView { return CustomerSignalViewSchema.parse({ id: row.id, sourceType: row.sourceType, sourceId: row.sourceId, themeCode: row.themeCode, sentiment: row.sentiment, occurrenceCount: row.occurrenceCount, occurredAt: row.occurredAt.toISOString(), consentBasis: row.consentBasis, excerptChecksum: row.excerptChecksum, recordedAt: row.recordedAt.toISOString() }); }
async function advertisingReportView(tx: TenantTransaction, row: typeof advertisingReports.$inferSelect): Promise<AdvertisingReportView> {
  const lines = await tx.select().from(advertisingMetricLines).where(eq(advertisingMetricLines.reportId, row.id));
  const views: AdvertisingMetricLineView[] = lines.map((line) => AdvertisingMetricLineViewSchema.parse({ id: line.id, lineKey: line.lineKey, entityLevel: line.entityLevel, externalCampaignId: line.externalCampaignId, externalAdGroupId: line.externalAdGroupId, normalizedTerm: line.normalizedTerm, listingId: line.listingId, skuId: line.skuId, impressions: line.impressions, clicks: line.clicks, orders: line.orders, spendMinor: line.spendMinor, salesMinor: line.salesMinor, ctrBps: line.impressions ? Math.round((line.clicks * 10000) / line.impressions) : null, conversionBps: line.clicks ? Math.round((line.orders * 10000) / line.clicks) : null, roasBps: line.spendMinor ? Math.round((line.salesMinor * 10000) / line.spendMinor) : null }));
  const totals = views.reduce((sum, line) => ({ impressions: sum.impressions + line.impressions, clicks: sum.clicks + line.clicks, orders: sum.orders + line.orders, spendMinor: sum.spendMinor + line.spendMinor, salesMinor: sum.salesMinor + line.salesMinor }), { impressions: 0, clicks: 0, orders: 0, spendMinor: 0, salesMinor: 0 });
  return AdvertisingReportViewSchema.parse({ id: row.id, provider: row.provider, accountId: row.accountId, externalReportId: row.externalReportId, scopeKey: row.scopeKey, periodStart: row.periodStart.toISOString(), periodEnd: row.periodEnd.toISOString(), attributionWindowDays: row.attributionWindowDays, sourceCurrency: row.sourceCurrency, observedAt: row.observedAt.toISOString(), checksum: row.checksum, recordedAt: row.recordedAt.toISOString(), totals, lines: views });
}
async function vocDefinitionView(tx: TenantTransaction, row: typeof vocDefinitions.$inferSelect) { const [version] = await tx.select().from(vocDefinitionVersions).where(and(eq(vocDefinitionVersions.definitionId, row.id), eq(vocDefinitionVersions.versionNumber, row.currentVersion))).limit(1); if (!version) throw new NotFoundException("VOC definition version not found"); return VocDefinitionViewSchema.parse({ id: row.id, name: row.name, currentVersion: row.currentVersion, status: row.status, version: VocDefinitionVersionViewSchema.parse({ id: version.id, definitionId: version.definitionId, versionNumber: version.versionNumber, sourceWeights: version.sourceWeights, minimumOccurrences: version.minimumOccurrences, reasonCode: version.reasonCode, checksum: version.checksum, createdAt: version.createdAt.toISOString() }), createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }); }
async function analysisView(tx: TenantTransaction, row: typeof vocAnalysisRuns.$inferSelect) { const [themes, recommendations] = await Promise.all([tx.select().from(vocThemeMetrics).where(eq(vocThemeMetrics.runId, row.id)), tx.select().from(customerRecommendations).where(eq(customerRecommendations.runId, row.id))]); return VocAnalysisRunViewSchema.parse({ id: row.id, definitionId: row.definitionId, definitionVersionId: row.definitionVersionId, definitionVersion: row.definitionVersion, status: row.status, windowStart: row.windowStart.toISOString(), windowEnd: row.windowEnd.toISOString(), evidenceCutoffAt: row.evidenceCutoffAt.toISOString(), signalIds: row.signalIds, inputChecksum: row.inputChecksum, calculatedAt: row.calculatedAt.toISOString(), themes: themes.map((theme) => VocThemeMetricViewSchema.parse({ id: theme.id, themeCode: theme.themeCode, totalOccurrences: theme.totalOccurrences, negativeOccurrences: theme.negativeOccurrences, negativeBps: theme.negativeBps, weightedScore: theme.weightedScore, sourceCounts: theme.sourceCounts, signalIds: theme.signalIds })), recommendations: recommendations.map((recommendation) => CustomerRecommendationViewSchema.parse({ id: recommendation.id, runId: recommendation.runId, themeCode: recommendation.themeCode, action: recommendation.action, status: recommendation.status, evidenceSignalIds: recommendation.evidenceSignalIds, createdAt: recommendation.createdAt.toISOString(), reviewedAt: recommendation.reviewedAt?.toISOString() ?? null })) }); }
function sentimentWeight(sentiment: string) { return sentiment === "negative" ? 3 : sentiment === "mixed" ? 2 : sentiment === "neutral" ? 1 : 0; }
function recommendationAction(themeCode: string): "investigate_product" | "review_listing_expectations" | "review_campaign_terms" | "review_service_process" { if (/SHIP|DELIVERY|SERVICE/.test(themeCode)) return "review_service_process"; if (/KEYWORD|SEARCH|TERM/.test(themeCode)) return "review_campaign_terms"; if (/EXPECT|DESCRIPTION|FIT/.test(themeCode)) return "review_listing_expectations"; return "investigate_product"; }
