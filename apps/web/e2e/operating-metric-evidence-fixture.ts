import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import {
  AdvertisingReportViewSchema,
  RecordAdvertisingReportInputSchema,
  summarizeAdvertisingReports,
} from "@yummyai/contracts/customer-intelligence";
import {
  CalculateFinanceProfitInputSchema,
  FinanceProfitMetricViewSchema,
  FinanceProfitRunViewSchema,
  FinanceStatementViewSchema,
  RecordFinanceStatementInputSchema,
  UpsertFinanceProfitMetricInputSchema,
} from "@yummyai/contracts/finance";
import { centerApi } from "./order-centers-fixture";

/** Ordinary authenticated API evidence. The disposable runner owns DB/bucket teardown. */
export async function seedOperatingMetricEvidence() {
  const databasePath = new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid").pathname;
  const token = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(databasePath)?.[1];
  const apiHost = new URL(process.env.API_BASE_URL ?? "http://invalid").hostname;
  if (process.env.E2E_ISOLATED_DAILY !== "1" || !token
    || process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${token}`
    || !["127.0.0.1", "localhost", "[::1]"].includes(apiHost)) {
    throw new Error("Operating metric fixtures require the disposable daily E2E database, bucket and loopback API");
  }

  const suffix = randomUUID().slice(0, 8);
  const scopeKey = `Synthetic metric scope ${suffix}`;
  const periodStart = "2026-07-01T00:00:00.000Z";
  const periodEnd = "2026-07-15T23:59:59.000Z";
  const observedAt = "2026-08-01T00:00:00.000Z";
  const campaign = {
    lineKey: "campaign", entityLevel: "campaign", externalCampaignId: `synthetic-campaign-${suffix}`,
    externalAdGroupId: null, normalizedTerm: null, identityRedacted: true,
    listingId: null, skuId: null, impressions: 1000, clicks: 80, orders: 8,
    spendMinor: 1200, salesMinor: 4800,
  };
  const reportBase = { provider: "manual", accountId: null, scopeKey, periodStart, periodEnd,
    attributionWindowDays: 7, sourceCurrency: "USD", observedAt };

  const mixed = AdvertisingReportViewSchema.parse(await centerApi<unknown>(
    "customer-intelligence/advertising-reports", RecordAdvertisingReportInputSchema.parse({
      ...reportBase, externalReportId: `synthetic-mixed-levels-${suffix}`, idempotencyKey: randomUUID(),
      lines: [campaign, { ...campaign, lineKey: "term", entityLevel: "search_term", normalizedTerm: "synthetic custom pillow" }],
    }),
  ));
  const overlapping = AdvertisingReportViewSchema.parse(await centerApi<unknown>(
    "customer-intelligence/advertising-reports", RecordAdvertisingReportInputSchema.parse({
      ...reportBase, externalReportId: `synthetic-overlap-${suffix}`, idempotencyKey: randomUUID(),
      periodStart: "2026-07-10T00:00:00.000Z", periodEnd: "2026-07-20T23:59:59.000Z",
      lines: [{ ...campaign, impressions: 250, clicks: 20, orders: 2, spendMinor: 300, salesMinor: 1200 }],
    }),
  ));
  const euro = AdvertisingReportViewSchema.parse(await centerApi<unknown>(
    "customer-intelligence/advertising-reports", RecordAdvertisingReportInputSchema.parse({
      ...reportBase, sourceCurrency: "EUR", externalReportId: `synthetic-eur-${suffix}`, idempotencyKey: randomUUID(),
      lines: [{ ...campaign, impressions: 600, clicks: 40, orders: 4, spendMinor: 800, salesMinor: 3200 }],
    }),
  ));
  const advertisingReports = [mixed, overlapping, euro];
  expect(mixed.totals).toBeNull();
  const groups = summarizeAdvertisingReports(advertisingReports);
  expect(groups).toHaveLength(3);
  expect(groups.find((group) => group.sourceCurrency === "USD" && group.entityLevel === "campaign"))
    .toMatchObject({ overlappingPeriods: true, totals: null });
  expect(groups.find((group) => group.sourceCurrency === "EUR"))
    .toMatchObject({ overlappingPeriods: false, totals: { spendMinor: 800 } });

  // Deliberately unallocated revenue and absent production cost: no fabricated order IDs.
  const statement = FinanceStatementViewSchema.parse(await centerApi<unknown>(
    "finance/statements", RecordFinanceStatementInputSchema.parse({
      accountId: null, provider: "manual", statementKind: "manual_adjustment",
      externalStatementId: `synthetic-unallocated-revenue-${suffix}`,
      periodStart, periodEnd, sourceCurrency: "USD", observedAt, idempotencyKey: randomUUID(),
      lines: [{ lineKey: "unallocated-sale", factType: "sale_revenue", direction: "credit",
        amountMinor: 10000, currency: "USD", occurredAt: "2026-07-12T00:00:00.000Z",
        externalReference: `synthetic-unallocated-sale-${suffix}`, orderId: null, orderLineId: null,
        skuId: null, listingId: null, supplierId: null, correctionKind: "original", correctsFactId: null }],
    }),
  ));
  const metric = FinanceProfitMetricViewSchema.parse(await centerApi<unknown>(
    "finance/profit-metrics", UpsertFinanceProfitMetricInputSchema.parse({
      metricId: null, name: `Synthetic missing-cost metric ${suffix}`, reportingCurrency: "USD",
      revenueFactTypes: ["sale_revenue"], costFactTypes: ["production_cost"],
      requiredFactTypes: ["sale_revenue", "production_cost"], reasonCode: "E2E_SYNTHETIC_EVIDENCE",
      idempotencyKey: randomUUID(),
    }),
  ));
  const run = FinanceProfitRunViewSchema.parse(await centerApi<unknown>(
    "finance/profit-runs", CalculateFinanceProfitInputSchema.parse({
      metricId: metric.id, expectedMetricVersion: metric.currentVersion, statementIds: [statement.id],
      fxRateIds: [], coverageDimension: "order", idempotencyKey: randomUUID(),
    }),
  ));
  expect(run).toMatchObject({ status: "incomplete", revenueMinor: null, costMinor: null, profitMinor: null, marginBps: null });
  expect(run.diagnostics.missingFactTypes).toContain("production_cost");
  expect(run.diagnostics.coverage).toMatchObject({ dimension: "order", checkedEntityCount: 0,
    unattributedFactIds: [statement.lines[0]!.id] });

  return { scopeKey, advertisingReports, statement, metric, run };
}
