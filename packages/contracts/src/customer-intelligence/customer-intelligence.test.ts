import { describe, expect, it } from "vitest";

import {
  AdvertisingMetricLineInputSchema,
  RecordAdvertisingReportInputSchema,
  RecordCustomerSignalInputSchema,
  UpsertVocDefinitionInputSchema,
} from "./customer-intelligence.js";

const id = "0198fbef-4a10-7000-8000-000000000001";

describe("customer intelligence contracts", () => {
  it("requires internally consistent advertising funnels", () => {
    expect(AdvertisingMetricLineInputSchema.safeParse({
      lineKey: "term-1",
      entityLevel: "search_term",
      externalCampaignId: "campaign-1",
      externalAdGroupId: "group-1",
      normalizedTerm: "custom pillow",
      identityRedacted: true,
      listingId: id,
      skuId: null,
      impressions: 10,
      clicks: 11,
      orders: 1,
      spendMinor: 100,
      salesMinor: 500,
    }).success).toBe(false);
  });

  it("rejects duplicate advertising line identities", () => {
    const line = {
      lineKey: "term-1",
      entityLevel: "keyword" as const,
      externalCampaignId: "campaign-1",
      externalAdGroupId: null,
      normalizedTerm: "custom pillow",
      identityRedacted: true as const,
      listingId: null,
      skuId: null,
      impressions: 10,
      clicks: 2,
      orders: 1,
      spendMinor: 100,
      salesMinor: 500,
    };
    expect(RecordAdvertisingReportInputSchema.safeParse({
      provider: "manual",
      accountId: null,
      externalReportId: "report-1",
      scopeKey: "US",
      periodStart: "2026-07-01T00:00:00.000Z",
      periodEnd: "2026-07-02T00:00:00.000Z",
      attributionWindowDays: 7,
      sourceCurrency: "USD",
      observedAt: "2026-07-03T00:00:00.000Z",
      lines: [line, line],
      idempotencyKey: "advertising-report-1",
    }).success).toBe(false);
  });

  it("requires consent and source types to agree", () => {
    expect(RecordCustomerSignalInputSchema.safeParse({
      sourceType: "support_contact",
      sourceId: id,
      themeCode: "SERVICE",
      sentiment: "negative",
      occurrenceCount: 1,
      occurredAt: "2026-07-01T00:00:00.000Z",
      consentBasis: "public_page",
      identityRedacted: true,
      excerptChecksum: "a".repeat(64),
      idempotencyKey: "customer-signal-1",
    }).success).toBe(false);
  });

  it("requires unique VOC weights totaling 100 percent", () => {
    expect(UpsertVocDefinitionInputSchema.safeParse({
      definitionId: null,
      name: "VOC baseline",
      sourceWeights: [
        { sourceType: "review", weightBps: 5000 },
        { sourceType: "review", weightBps: 5000 },
      ],
      minimumOccurrences: 1,
      reasonCode: "VOC_BASELINE",
      idempotencyKey: "voc-definition-1",
    }).success).toBe(false);
  });
});
