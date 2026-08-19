import { describe, expect, it } from "vitest";

import { normalizeProviderFinanceStatement } from "./finance.js";

const accountId = "019b0000-0000-7000-8000-000000000001";

describe("provider finance normalization", () => {
  it("normalizes Amazon settlement revenue, fulfillment, storage, and refunds", () => {
    const result = normalizeProviderFinanceStatement({
      accountId,
      idempotencyKey: "amazon-settlement-001",
      statement: {
        provider: "amazon",
        externalStatementId: "amazon-001",
        periodStart: "2026-07-01T00:00:00.000Z",
        periodEnd: "2026-07-31T23:59:59.000Z",
        observedAt: "2026-08-01T00:00:00.000Z",
        currency: "USD",
        transactions: [
          transaction("sale", "product_price", 10_000),
          transaction("fba", "fba_fulfillment_fee", 1_500),
          transaction("storage", "storage_fee", 300),
          transaction("refund", "refund", 2_000),
        ],
      },
    });
    expect(result.provider).toBe("amazon");
    expect(result.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ factType: "sale_revenue", direction: "credit", amountMinor: 10_000 }),
      expect.objectContaining({ factType: "fulfillment_fee", direction: "debit", amountMinor: 1_500 }),
      expect.objectContaining({ factType: "storage_fee", direction: "debit", amountMinor: 300 }),
      expect.objectContaining({ factType: "refund", direction: "debit", amountMinor: 2_000 }),
    ]));
  });

  it("normalizes Etsy fees and rejects mixed statement currencies", () => {
    const base = {
      accountId,
      idempotencyKey: "etsy-settlement-001",
      statement: {
        provider: "etsy" as const,
        externalStatementId: "etsy-001",
        periodStart: "2026-07-01T00:00:00.000Z",
        periodEnd: "2026-07-31T23:59:59.000Z",
        observedAt: "2026-08-01T00:00:00.000Z",
        currency: "USD",
        transactions: [
          transaction("sale", "sale", 8_000),
          transaction("fee", "transaction_fee", 500),
          transaction("ads", "offsite_ads_fee", 700),
        ],
      },
    };
    const result = normalizeProviderFinanceStatement(base);
    expect(result.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ factType: "marketplace_commission", amountMinor: 500 }),
      expect.objectContaining({ factType: "advertising_spend", amountMinor: 700 }),
    ]));
    expect(() => normalizeProviderFinanceStatement({
      ...base,
      statement: {
        ...base.statement,
        transactions: [
          ...base.statement.transactions,
          { ...transaction("eur-fee", "other_fee", 100), currency: "EUR" },
        ],
      },
    })).toThrow(/source currency/);
  });
});

function transaction<T extends string>(transactionId: string, type: T, amountMinor: number) {
  return {
    transactionId,
    type,
    amountMinor,
    currency: "USD",
    postedAt: "2026-07-15T00:00:00.000Z",
    externalOrderId: "ORDER-001",
  };
}
