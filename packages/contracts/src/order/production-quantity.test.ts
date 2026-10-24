import { describe, expect, it } from "vitest";
import { createEntityId } from "../common/ids.js";
import { ProductionPhysicalQuantitiesSchema, ProductionQuantityReportInputSchema, ProductionQuantityReviewInputSchema, ProductionQuantityBasisSchema } from "./production-quantity.js";

const report = () => ({ idempotencyKey: "stop-report-original-key", productionVersionId: createEntityId(), expectedProductionProjectionVersion: 2,
  expectedReviewId: null, expectedBasisFingerprint: "a".repeat(64), observedAt: "2026-10-21T04:30:00.123Z",
  quantities: { unstartedQuantity: null, inProcessQuantity: 0, completedQuantity: 2, scrappedQuantity: null },
  evidenceCode: "ACTUAL_FACTORY_COUNT", evidenceAssetIds: [] });
const review = () => ({ idempotencyKey: "stop-review-original-key", reportId: createEntityId(), expectedProductionProjectionVersion: 2,
  expectedReviewId: null, expectedBasisFingerprint: "a".repeat(64), stoppedDelta: 0, unstartedAcrossAllPoolsConfirmed: false,
  evidenceCode: "OPERATOR_RECONCILED", occurredAt: "2026-10-21T04:30:10.456Z" });

describe("physical quantity evidence boundary", () => {
  it("preserves unknown separately from an explicitly counted zero", () => {
    expect(ProductionQuantityReportInputSchema.parse(report()).quantities).toEqual(report().quantities);
  });
  it("keeps a larger unreserved historical lot readable without widening new count or stop inputs", () => {
    const id = createEntityId();
    expect(ProductionQuantityBasisSchema.safeParse({ productionOrderId: id, orderId: id, orderLineId: id, productionVersionId: id,
      projectionVersion: 1, status: "cancelled", quantity: 200000, factoryId: null, manufacturingBindingId: null, manufacturingVersionId: null, unit: null,
      reviewId: null, cumulativeStoppedQuantity: 0, currentQuantities: null, groupedQuantity: 150000, groupedPassedQuantity: 0,
      allocatedQuantity: 120000, shippedQuantity: 120000, completedLowerBound: 120000, unknownShipmentSource: true,
      capacityStatus: "legacy_unreserved", reservations: [], blockers: ["原实物与资源依据未知"], fingerprint: "a".repeat(64) }).success).toBe(true);
    expect(ProductionPhysicalQuantitiesSchema.safeParse({ ...report().quantities, unstartedQuantity: 200000 }).success).toBe(false);
  });
  it.each([-1, 0.5, 100001, "2"])("rejects invalid physical count %s", value => {
    expect(ProductionPhysicalQuantitiesSchema.safeParse({ ...report().quantities, completedQuantity: value }).success).toBe(false);
  });
  it("rejects a missing count instead of defaulting it to zero", () => {
    expect(ProductionPhysicalQuantitiesSchema.safeParse({ inProcessQuantity: 0, completedQuantity: 2, scrappedQuantity: null }).success).toBe(false);
  });
  it("rejects caller supplied capacity and refund amounts", () => {
    expect(ProductionQuantityReportInputSchema.safeParse({ ...report(), releasedUnits: 200 }).success).toBe(false);
    expect(ProductionQuantityReviewInputSchema.safeParse({ ...review(), refundAmount: 200 }).success).toBe(false);
  });
  it("requires explicit all-resource non-use for a positive stop", () => {
    expect(ProductionQuantityReviewInputSchema.safeParse({ ...review(), stoppedDelta: 2 }).success).toBe(false);
    expect(ProductionQuantityReviewInputSchema.safeParse({ ...review(), stoppedDelta: 2, unstartedAcrossAllPoolsConfirmed: true }).success).toBe(true);
  });
  it("allows a zero-delta physical reconciliation without manufacturing a capacity refund", () => {
    expect(ProductionQuantityReviewInputSchema.parse(review()).stoppedDelta).toBe(0);
  });
  it("rejects duplicate evidence assets and extra physical categories", () => {
    const asset = createEntityId();
    expect(ProductionQuantityReportInputSchema.safeParse({ ...report(), evidenceAssetIds: [asset, asset] }).success).toBe(false);
    expect(ProductionPhysicalQuantitiesSchema.safeParse({ ...report().quantities, shippedQuantity: 2 }).success).toBe(false);
  });
});
