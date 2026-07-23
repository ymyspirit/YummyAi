import { createEntityId } from "../common/ids.js";
import { describe, expect, it } from "vitest";

import {
  CalculateFinanceProfitInputSchema,
  RecordFinanceFxRateInputSchema,
  RecordFinanceStatementInputSchema,
  UpsertFinanceProfitMetricInputSchema,
} from "./finance.js";

describe("finance contracts", () => {
  it("requires explicit correction lineage and statement currency", () => {
    const base = {
      accountId: null,
      provider: "manual",
      statementKind: "operational_cost",
      externalStatementId: "OPS-2026-07",
      periodStart: "2026-07-01T00:00:00.000Z",
      periodEnd: "2026-07-31T23:59:59.000Z",
      sourceCurrency: "USD",
      observedAt: "2026-07-23T08:00:00.000Z",
      idempotencyKey: "finance-statement-0001",
      lines: [{
        lineKey: "carrier-1",
        factType: "carrier_cost",
        direction: "debit",
        amountMinor: 850,
        currency: "USD",
        occurredAt: "2026-07-20T08:00:00.000Z",
        externalReference: null,
        orderId: null,
        orderLineId: null,
        skuId: null,
        listingId: null,
        supplierId: null,
        correctionKind: "original",
        correctsFactId: null,
      }],
    } as const;
    expect(RecordFinanceStatementInputSchema.safeParse(base).success).toBe(true);
    expect(RecordFinanceStatementInputSchema.safeParse({
      ...base,
      lines: [{ ...base.lines[0], currency: "EUR" }],
    }).success).toBe(false);
    expect(RecordFinanceStatementInputSchema.safeParse({
      ...base,
      lines: [{ ...base.lines[0], correctionKind: "reversal", correctsFactId: null }],
    }).success).toBe(false);
  });

  it("uses explicit rational historical FX rates", () => {
    expect(RecordFinanceFxRateInputSchema.parse({
      source: "ECB.DAILY",
      baseCurrency: "EUR",
      quoteCurrency: "USD",
      rateNumerator: 109,
      rateDenominator: 100,
      effectiveAt: "2026-07-20T00:00:00.000Z",
      retrievedAt: "2026-07-20T16:00:00.000Z",
      idempotencyKey: "fx-rate-20260720-eur-usd",
    })).toMatchObject({ rateNumerator: 109 });
    expect(RecordFinanceFxRateInputSchema.safeParse({
      source: "ECB.DAILY",
      baseCurrency: "USD",
      quoteCurrency: "USD",
      rateNumerator: 1,
      rateDenominator: 1,
      effectiveAt: "2026-07-20T00:00:00.000Z",
      retrievedAt: "2026-07-20T16:00:00.000Z",
      idempotencyKey: "fx-rate-invalid-pair",
    }).success).toBe(false);
  });

  it("keeps profit classifications disjoint and pins all calculation inputs", () => {
    const metric = {
      metricId: null,
      name: "Contribution margin v1",
      reportingCurrency: "USD",
      revenueFactTypes: ["sale_revenue"],
      costFactTypes: ["marketplace_commission", "production_cost", "carrier_cost"],
      requiredFactTypes: ["sale_revenue", "marketplace_commission", "production_cost"],
      reasonCode: "INITIAL_METRIC",
      idempotencyKey: "profit-metric-version-0001",
    } as const;
    expect(UpsertFinanceProfitMetricInputSchema.safeParse(metric).success).toBe(true);
    expect(UpsertFinanceProfitMetricInputSchema.safeParse({
      ...metric,
      costFactTypes: ["sale_revenue"],
    }).success).toBe(false);
    const statementId = createEntityId();
    expect(CalculateFinanceProfitInputSchema.safeParse({
      metricId: createEntityId(),
      expectedMetricVersion: 1,
      statementIds: [statementId, statementId],
      fxRateIds: [],
      idempotencyKey: "profit-run-0001",
    }).success).toBe(false);
  });
});
