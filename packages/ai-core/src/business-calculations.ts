import type { FinanceProfitRunView } from "@yummyai/contracts/finance";

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
    current.status === "complete" &&
    prior.status === "complete" &&
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
  physical: number;
  reserved: number;
  inTransit: number;
  openPurchaseQuantity: number;
  policy: { reorderPoint: number; safetyStock: number; minimumOrderQuantity: number } | null;
  blocked: boolean;
}) {
  const available = safe(input.physical - input.reserved);
  const position = safe(available + input.inTransit + input.openPurchaseQuantity);
  const target = input.policy ? safe(input.policy.reorderPoint + input.policy.safetyStock) : null;
  const suggestedQuantity =
    input.blocked || !input.policy
      ? null
      : position <= input.policy.reorderPoint
        ? Math.max(input.policy.minimumOrderQuantity, safe(target! - position))
        : 0;
  return { available, position, target, suggestedQuantity };
}
