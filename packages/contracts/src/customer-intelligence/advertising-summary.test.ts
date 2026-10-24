import { describe, expect, it } from "vitest";
import {
  summarizeAdvertisingReports,
  sumAdvertisingMetrics,
  type AdvertisingReportView,
  type AdvertisingEntityLevel,
} from "./customer-intelligence.js";

const line = (entityLevel: AdvertisingEntityLevel) => ({
  id: "line",
  lineKey: entityLevel,
  entityLevel,
  externalCampaignId: "campaign",
  externalAdGroupId: null,
  normalizedTerm: entityLevel === "keyword" || entityLevel === "search_term" ? "pillow" : null,
  listingId: null,
  skuId: null,
  impressions: 1000,
  clicks: 10,
  orders: 1,
  spendMinor: 1000,
  salesMinor: 5000,
  ctrBps: 100,
  conversionBps: 1000,
  roasBps: 50000,
});
const report = (overrides: Partial<AdvertisingReportView> = {}): AdvertisingReportView => ({
  id: "report-a",
  provider: "manual",
  accountId: null,
  externalReportId: "report-a",
  scopeKey: "shop-a",
  periodStart: "2026-07-01T00:00:00.000Z",
  periodEnd: "2026-07-07T23:59:59.000Z",
  attributionWindowDays: 7,
  sourceCurrency: "USD",
  observedAt: "2026-08-01T00:00:00.000Z",
  recordedAt: "2026-08-01T00:00:00.000Z",
  checksum: "a".repeat(64),
  totals: null,
  lines: [line("campaign")],
  ...overrides,
});

describe("advertising report aggregation", () => {
  it("isolates currency, scope, account, attribution window and entity level", () => {
    const groups = summarizeAdvertisingReports([
      report({ lines: [line("campaign"), line("search_term")] }),
      report({ sourceCurrency: "EUR" }),
      report({ scopeKey: "shop-b" }),
      report({ accountId: "account-b" }),
      report({ attributionWindowDays: 14 }),
    ]);
    expect(groups).toHaveLength(6);
    expect(groups.every((group) => group.totals?.spendMinor === 1000)).toBe(true);
  });

  it("withholds totals for duplicate, nested and partially overlapping intervals", () => {
    for (const period of [
      {},
      { periodStart: "2026-07-02T00:00:00.000Z", periodEnd: "2026-07-03T00:00:00.000Z" },
      { periodStart: "2026-07-06T00:00:00.000Z", periodEnd: "2026-07-10T00:00:00.000Z" },
    ]) {
      const [group] = summarizeAdvertisingReports([
        report(),
        report({ id: "report-b", ...period }),
      ]);
      expect(group).toMatchObject({ overlappingPeriods: true, totals: null });
      expect(group!.entries).toHaveLength(2);
    }
  });

  it("sums only non-overlapping periods within one scope and refuses unsafe integers", () => {
    const [group] = summarizeAdvertisingReports([
      report(),
      report({
        id: "report-b",
        periodStart: "2026-07-08T00:00:00.000Z",
        periodEnd: "2026-07-14T23:59:59.000Z",
      }),
    ]);
    expect(group).toMatchObject({
      overlappingPeriods: false,
      totals: { spendMinor: 2000, salesMinor: 10000 },
    });
    expect(
      sumAdvertisingMetrics([
        { ...line("campaign"), spendMinor: Number.MAX_SAFE_INTEGER },
        line("campaign"),
      ]),
    ).toBeNull();
    expect(
      summarizeAdvertisingReports([
        report({
          lines: [],
          totals: { impressions: 1, clicks: 1, orders: 1, spendMinor: 99999, salesMinor: 99999 },
        }),
      ]),
    ).toEqual([]);
  });
});
