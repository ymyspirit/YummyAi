import type { CustomerIntelligenceWorkspaceView } from "@yummyai/contracts/customer-intelligence";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CustomerIntelligenceWorkspace } from "./customer-intelligence-workspace";

describe("CustomerIntelligenceWorkspace", () => {
  it("renders an explicit empty state", () => {
    const html = renderToStaticMarkup(<CustomerIntelligenceWorkspace data={{ advertisingReports: [], signals: [], definitions: [], analyses: [] }} />);
    expect(html).toContain("还没有广告或客户信号证据");
  });

  it("shows source currency, attribution, redaction, and review-only boundaries", () => {
    const data: CustomerIntelligenceWorkspaceView = {
      advertisingReports: [{ id: id(1), provider: "manual", accountId: null, externalReportId: "report-1", scopeKey: "scope", periodStart: "2026-07-01T00:00:00.000Z", periodEnd: "2026-07-31T00:00:00.000Z", attributionWindowDays: 7, sourceCurrency: "USD", observedAt: "2026-08-01T00:00:00.000Z", checksum: "a".repeat(64), recordedAt: "2026-08-01T00:00:00.000Z", totals: { impressions: 100, clicks: 10, orders: 2, spendMinor: 1000, salesMinor: 4000 }, lines: [] }],
      signals: [{ id: id(2), sourceType: "keyword", sourceId: id(3), themeCode: "SEARCH_TERM", sentiment: "negative", occurrenceCount: 3, occurredAt: "2026-07-12T00:00:00.000Z", consentBasis: "advertising_authorization", excerptChecksum: "b".repeat(64), recordedAt: "2026-07-12T00:00:00.000Z" }],
      definitions: [{ id: id(4), name: "VOC baseline", currentVersion: 1, status: "active", version: { id: id(5), definitionId: id(4), versionNumber: 1, sourceWeights: [{ sourceType: "keyword", weightBps: 10000 }], minimumOccurrences: 1, reasonCode: "BASELINE", checksum: "c".repeat(64), createdAt: "2026-08-01T00:00:00.000Z" }, createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z" }],
      analyses: [{ id: id(6), definitionId: id(4), definitionVersionId: id(5), definitionVersion: 1, status: "complete", windowStart: "2026-07-01T00:00:00.000Z", windowEnd: "2026-08-01T00:00:00.000Z", evidenceCutoffAt: "2026-08-02T00:00:00.000Z", signalIds: [id(2)], inputChecksum: "d".repeat(64), calculatedAt: "2026-08-02T00:00:00.000Z", themes: [{ id: id(7), themeCode: "SEARCH_TERM", totalOccurrences: 3, negativeOccurrences: 3, negativeBps: 10000, weightedScore: 90000, sourceCounts: { review: 0, return_reason: 0, support_contact: 0, quality_defect: 0, keyword: 3 }, signalIds: [id(2)] }], recommendations: [{ id: id(8), runId: id(6), themeCode: "SEARCH_TERM", action: "review_campaign_terms", status: "pending", evidenceSignalIds: [id(2)], createdAt: "2026-08-02T00:00:00.000Z", reviewedAt: null }] }],
    };
    const html = renderToStaticMarkup(<CustomerIntelligenceWorkspace data={data} />);
    expect(html).toContain("7 天归因");
    expect(html).toContain("脱敏客户信号");
    expect(html).toContain("只供审阅，不自动写 Listing / 广告");
    expect(html).toContain("复核广告词");
  });
});

function id(last: number) { return `019c0000-0000-7000-8000-${last.toString().padStart(12, "0")}`; }
