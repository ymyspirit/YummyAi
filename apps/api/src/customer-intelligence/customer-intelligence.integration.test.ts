import { UnprocessableEntityException } from "@nestjs/common";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  connectDatabase, customerSignalFacts, migrateDatabase, withTenant,
} from "@yummyai/database";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuditService } from "../audit/audit.service.js";
import { CustomerIntelligenceService } from "./customer-intelligence.service.js";

describe.sequential("customer intelligence", () => {
  const database = connectDatabase();
  const tenantA = createEntityId(); const tenantB = createEntityId();
  const userA = createEntityId(); const userB = createEntityId();
  const contextA = context(tenantA, userA); const contextB = context(tenantB, userB);
  const service = new CustomerIntelligenceService(database, new AuditService(database));
  let lineId = ""; let recommendationId = "";

  beforeAll(async () => {
    await migrateDatabase(database);
    await database.client.unsafe("insert into organizations (id,name,slug) values ($1,$2,$3),($4,$5,$6)", [tenantA, "CI A", `ci-a-${tenantA}`, tenantB, "CI B", `ci-b-${tenantB}`]);
    await database.client.unsafe("insert into app_users (id,oidc_subject,email,display_name) values ($1,$2,$3,$4),($5,$6,$7,$8)", [userA, `ci-a-${userA}`, `ci-a-${userA}@example.test`, "CI A", userB, `ci-b-${userB}`, `ci-b-${userB}@example.test`, "CI B"]);
  });
  afterAll(async () => database.client.end());

  it("records advertising evidence, validates sources, and replays idempotently", async () => {
    const report = await service.recordAdvertisingReport(contextA, {
      provider: "manual", accountId: null, externalReportId: `ci-report-${tenantA}`, scopeKey: "shop-a",
      periodStart: "2026-07-01T00:00:00.000Z", periodEnd: "2026-07-31T23:59:59.000Z", attributionWindowDays: 7, sourceCurrency: "USD", observedAt: "2026-08-01T00:00:00.000Z",
      lines: [{ lineKey: "term-1", entityLevel: "search_term", externalCampaignId: "campaign-1", externalAdGroupId: null, normalizedTerm: "custom pillow", identityRedacted: true, listingId: null, skuId: null, impressions: 1000, clicks: 80, orders: 8, spendMinor: 1200, salesMinor: 4800 }],
      idempotencyKey: `ci-report-key-${tenantA}`,
    });
    lineId = report.lines[0]!.id;
    expect(report.totals).toEqual({ impressions: 1000, clicks: 80, orders: 8, spendMinor: 1200, salesMinor: 4800 });
    expect((await service.recordAdvertisingReport(contextA, {
      provider: "manual", accountId: null, externalReportId: `ci-report-${tenantA}`, scopeKey: "shop-a", periodStart: "2026-07-01T00:00:00.000Z", periodEnd: "2026-07-31T23:59:59.000Z", attributionWindowDays: 7, sourceCurrency: "USD", observedAt: "2026-08-01T00:00:00.000Z", lines: [{ lineKey: "term-1", entityLevel: "search_term", externalCampaignId: "campaign-1", externalAdGroupId: null, normalizedTerm: "custom pillow", identityRedacted: true, listingId: null, skuId: null, impressions: 1000, clicks: 80, orders: 8, spendMinor: 1200, salesMinor: 4800 }], idempotencyKey: `ci-report-key-${tenantA}`,
    })).id).toBe(report.id);
    await expect(service.recordCustomerSignal(contextA, { sourceType: "keyword", sourceId: createEntityId(), themeCode: "SEARCH_TERM", sentiment: "negative", occurrenceCount: 1, occurredAt: "2026-07-12T00:00:00.000Z", consentBasis: "advertising_authorization", identityRedacted: true, excerptChecksum: "a".repeat(64), idempotencyKey: `ci-bad-signal-${tenantA}` })).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it("pins VOC versions, isolates tenants, and keeps recommendations reviewable", async () => {
    const signal = await service.recordCustomerSignal(contextA, { sourceType: "keyword", sourceId: lineId, themeCode: "SEARCH_TERM", sentiment: "negative", occurrenceCount: 3, occurredAt: "2026-07-12T00:00:00.000Z", consentBasis: "advertising_authorization", identityRedacted: true, excerptChecksum: "b".repeat(64), idempotencyKey: `ci-signal-key-${tenantA}` });
    expect(signal).not.toHaveProperty("tenantId");
    const definition = await service.upsertDefinition(contextA, { definitionId: null, name: "VOC baseline", sourceWeights: [{ sourceType: "keyword", weightBps: 10000 }], minimumOccurrences: 1, reasonCode: "P3_VOC", idempotencyKey: `ci-definition-key-${tenantA}` });
    const analysis = await service.calculateAnalysis(contextA, { definitionId: definition.id, expectedDefinitionVersion: 1, windowStart: "2026-07-01T00:00:00.000Z", windowEnd: "2026-08-01T00:00:00.000Z", evidenceCutoffAt: "2099-08-02T00:00:00.000Z", idempotencyKey: `ci-analysis-key-${tenantA}` });
    expect(analysis.signalIds).toContain(signal.id); expect(analysis.recommendations).toHaveLength(1); recommendationId = analysis.recommendations[0]!.id;
    expect((await service.workspace(contextB)).signals).toHaveLength(0);
    await expect(service.calculateAnalysis(contextB, { definitionId: definition.id, expectedDefinitionVersion: 1, windowStart: "2026-07-01T00:00:00.000Z", windowEnd: "2026-08-01T00:00:00.000Z", evidenceCutoffAt: "2099-08-02T00:00:00.000Z", idempotencyKey: `ci-cross-tenant-${tenantB}` })).rejects.toBeInstanceOf(Error);
    const reviewed = await service.reviewRecommendation(contextA, recommendationId, { expectedStatus: "pending", decision: "approved", reasonCode: "HUMAN_REVIEW", idempotencyKey: `ci-review-key-${tenantA}` });
    expect(reviewed.status).toBe("approved"); expect((await service.reviewRecommendation(contextA, recommendationId, { expectedStatus: "pending", decision: "approved", reasonCode: "HUMAN_REVIEW", idempotencyKey: `ci-review-key-${tenantA}` })).status).toBe("approved");
    const privileges = await withTenant(database.db, contextA, async (tx) => (await tx.execute(sql`select has_table_privilege(current_user, 'customer_signal_facts', 'UPDATE') as signal_update, has_table_privilege(current_user, 'voc_definition_versions', 'DELETE') as version_delete, has_table_privilege(current_user, 'customer_recommendation_review_events', 'UPDATE') as event_update`))[0] as Record<string, boolean>);
    expect(privileges).toEqual({ signal_update: false, version_delete: false, event_update: false });
    await expect(withTenant(database.db, contextA, (tx) => tx.update(customerSignalFacts).set({ themeCode: "MUTATED" }).where(eq(customerSignalFacts.id, signal.id)))).rejects.toThrow();
  });
});

function context(tenantId: string, userId: string): TenantContext { return { tenantId, userId, permissions: ["customer_intelligence:read", "customer_intelligence:write", "customer_intelligence:review"], dataScope: "tenant" }; }
