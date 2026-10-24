import { describe, expect, it } from "vitest";
import { evaluateFinanceCoverage, isFinanceProfitVerified, type FinanceFactView } from "./finance.js";
import { createEntityId } from "../common/ids.js";
import { buildFinanceCalculationBasis } from "./monetary.js";

const fact = (id: string, orderId: string | null, factType: FinanceFactView["factType"]) => ({
  id, orderId, orderLineId: null, skuId: orderId, listingId: null, factType,
  correctionKind: "original" as const, correctsFactId: null,
});
const required = ["sale_revenue", "production_cost"] as const;

describe("profit coverage is evaluated at its declared grain", () => {
  it("does not let one order's cost satisfy a second order's missing cost", () => {
    const facts = [fact("a", "order-a", "sale_revenue"), fact("b", "order-a", "production_cost"), fact("c", "order-b", "sale_revenue")];
    expect(evaluateFinanceCoverage(facts, [...required], "order")).toEqual({
      dimension: "order", checkedEntityCount: 2, unattributedFactIds: [],
      missingByEntity: [{ key: "order-b", missingFactTypes: ["production_cost"] }],
    });
    expect(evaluateFinanceCoverage(facts, [...required], "sku").missingByEntity).toEqual([{ key: "order-b", missingFactTypes: ["production_cost"] }]);
    expect(evaluateFinanceCoverage(facts, [...required], "aggregate").missingByEntity).toEqual([]);
  });

  it("keeps unallocated fees visible without allocating them across orders", () => {
    const facts = [fact("a", "order-a", "sale_revenue"), fact("b", null, "production_cost")];
    expect(evaluateFinanceCoverage(facts, [...required], "order")).toMatchObject({
      unattributedFactIds: ["b"], missingByEntity: [{ key: "order-a", missingFactTypes: ["production_cost"] }],
    });
  });

  it("does not count reversed costs as available evidence until replaced", () => {
    const facts = [fact("a", "order-a", "sale_revenue"), fact("b", "order-a", "production_cost"),
      { ...fact("c", "order-a", "production_cost"), correctionKind: "reversal" as const, correctsFactId: "b" }];
    expect(evaluateFinanceCoverage(facts, [...required], "order").missingByEntity).toHaveLength(1);
    expect(evaluateFinanceCoverage([...facts, { ...fact("d", "order-a", "production_cost"), correctionKind: "replacement", correctsFactId: "b" }], [...required], "order").missingByEntity).toEqual([]);
  });

  it("rejects legacy complete labels and exposes coverage gaps to every consumer", () => {
    const diagnostics = { missingFactTypes: [], missingFxPairs: [], unclassifiedFactTypes: [] };
    expect(isFinanceProfitVerified({ status: "complete", diagnostics })).toBe(false);
    expect(isFinanceProfitVerified({ status: "complete", diagnostics: { ...diagnostics,
      coverage: evaluateFinanceCoverage([fact("a", "order-a", "sale_revenue")], [...required], "order"),
    } })).toBe(false);
  });

  it("requires actual monetary context as well as complete cost coverage", () => {
    const diagnostics = { missingFactTypes: [], missingFxPairs: [], unclassifiedFactTypes: [], coverage: {
      dimension: "aggregate" as const, checkedEntityCount: 1, missingByEntity: [], unattributedFactIds: [],
    } };
    const contribution = { id: createEntityId(), factId: createEntityId(), fxRateId: createEntityId(), bucket: "cost" as const,
      sourceAmountMinor: 2000, sourceCurrency: "EUR", reportingAmountMinor: 3200, reportingCurrency: "JPY", effectSign: 1 as const,
      factType: "production_cost" as const, occurredAt: "2026-07-15T00:00:00Z", orderId: null, orderLineId: null,
      skuId: null, listingId: null, accountId: null, supplierId: null };
    const value = { status: "complete" as const, sourceIdentityVersion: 1 as const,
      diagnostics: { ...diagnostics, sourceIdentity: { schemaVersion: 1 as const, unidentifiedFactIds: [] } }, reportingCurrency: "JPY", contributions: [contribution] };
    expect(isFinanceProfitVerified({ status: "complete", diagnostics })).toBe(false);
    expect(isFinanceProfitVerified({ ...value, monetaryBasis: null })).toBe(false);
    expect(isFinanceProfitVerified({ ...value, monetaryBasis: buildFinanceCalculationBasis(["EUR", "JPY"]) })).toBe(true);
    expect(isFinanceProfitVerified({ ...value, monetaryBasis: buildFinanceCalculationBasis(["JPY"]) })).toBe(false);
    expect(isFinanceProfitVerified({ ...value, monetaryBasis: buildFinanceCalculationBasis(["EUR", "JPY"]),
      diagnostics: { ...value.diagnostics, monetary: { unknownCurrencies: [], ambiguousFxRateIds: [contribution.fxRateId] } } })).toBe(false);
    expect(isFinanceProfitVerified({ ...value, reportingCurrency: "USD", contributions: [{ ...contribution, reportingCurrency: "USD", reportingAmountMinor: 2200 }], monetaryBasis: null })).toBe(true);
  });
});
