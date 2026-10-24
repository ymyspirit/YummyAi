import { isFinanceProfitVerified, type FinanceProfitRunView } from "@yummyai/contracts/finance";
import { ceilStockQuantity, compareStockQuantity, subtractStockQuantity, sumStockQuantities,
  type StockQuantity } from "@yummyai/contracts/inventory/quantity";

function safe(value: number) {
  if (!Number.isSafeInteger(value)) throw new Error("analysis_unsafe_integer");
  return value;
}

/** A difference between two pinned calculations is not automatically period growth. */
export function compareProfitRuns(
  current: FinanceProfitRunView,
  prior: FinanceProfitRunView | null,
) {
  const comparable =
    !!prior &&
    current.id !== prior.id &&
    isFinanceProfitVerified(current) &&
    isFinanceProfitVerified(prior) &&
    current.diagnostics.coverage!.dimension === prior.diagnostics.coverage!.dimension &&
    current.metricVersionId === prior.metricVersionId &&
    current.reportingCurrency === prior.reportingCurrency &&
    [
      current.revenueMinor,
      current.costMinor,
      current.profitMinor,
      prior.revenueMinor,
      prior.costMinor,
      prior.profitMinor,
    ].every((n) => n !== null);
  return {
    comparable,
    revenueDeltaMinor: comparable ? safe(current.revenueMinor! - prior!.revenueMinor!) : null,
    costDeltaMinor: comparable ? safe(current.costMinor! - prior!.costMinor!) : null,
    profitDeltaMinor: comparable ? safe(current.profitMinor! - prior!.profitMinor!) : null,
    marginDeltaBps:
      comparable && current.marginBps !== null && prior!.marginBps !== null
        ? safe(current.marginBps - prior!.marginBps)
        : null,
  };
}

export function replenishmentAnalysis(input: {
  physical: StockQuantity;
  reserved: StockQuantity;
  inTransit: StockQuantity;
  openPurchaseQuantity: StockQuantity;
  policy: { reorderPoint: StockQuantity; safetyStock: StockQuantity; minimumOrderQuantity: StockQuantity } | null;
  unit?: string;
  blocked: boolean;
}) {
  const available = subtractStockQuantity(input.physical, input.reserved);
  const position = sumStockQuantities([available, input.inTransit, input.openPurchaseQuantity]);
  if ([available, position].some(value => compareStockQuantity(value, Number.MAX_SAFE_INTEGER) > 0 || compareStockQuantity(value, -Number.MAX_SAFE_INTEGER) < 0)) {
    throw new Error("analysis_unsafe_integer");
  }
  const target = input.policy ? sumStockQuantities([input.policy.reorderPoint, input.policy.safetyStock]) : null;
  const missing = target === null ? 0 : subtractStockQuantity(target, position);
  const coverage = input.policy && compareStockQuantity(missing, input.policy.minimumOrderQuantity) < 0 ? input.policy.minimumOrderQuantity : missing;
  const suggestedQuantity =
    input.blocked || !input.policy
      ? null
      : compareStockQuantity(position, input.policy.reorderPoint) <= 0
        ? input.unit && !["each", "pair", "set"].includes(input.unit) ? coverage : ceilStockQuantity(coverage)
        : 0;
  if (suggestedQuantity !== null && compareStockQuantity(suggestedQuantity, Number.MAX_SAFE_INTEGER) > 0) throw new Error("analysis_unsafe_integer");
  return { available, position, target, suggestedQuantity };
}
