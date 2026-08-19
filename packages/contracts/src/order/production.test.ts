import { describe, expect, it } from "vitest";

import { createEntityId } from "../common/ids.js";
import { CreateProductionBatchInputSchema, CreateProductionRecoveryInputSchema, CreateQualityStandardInputSchema, RecordQualityInspectionInputSchema } from "./production.js";

describe("production and quality contracts", () => {
  it("requires quality weights to total 10000 and unique criterion codes", () => {
    const base = { name: "POD output", skuId: null, supplierId: null, minimumScoreBps: 9000 };
    expect(CreateQualityStandardInputSchema.safeParse({ ...base, criteria: [{ code: "PRINT", label: "Print", weightBps: 10_000, blocking: true }] }).success).toBe(true);
    expect(CreateQualityStandardInputSchema.safeParse({ ...base, criteria: [{ code: "PRINT", label: "Print", weightBps: 9_000, blocking: true }] }).success).toBe(false);
    expect(CreateQualityStandardInputSchema.safeParse({ ...base, criteria: [{ code: "PRINT", label: "A", weightBps: 5_000 }, { code: "PRINT", label: "B", weightBps: 5_000 }] }).success).toBe(false);
  });

  it("requires failed inspection evidence and rejects critical defects on a pass", () => {
    const base = { qualityStandardVersionId: createEntityId(), scoreBps: 9000, inspectedAt: "2026-07-22T12:00:00.000Z", evidenceAssetIds: [], idempotencyKey: "inspection-0001" };
    expect(RecordQualityInspectionInputSchema.safeParse({ ...base, result: "failed", defects: [] }).success).toBe(false);
    expect(RecordQualityInspectionInputSchema.safeParse({ ...base, result: "passed", defects: [{ code: "HOLE", severity: "critical", responsibility: "supplier", disposition: "remake", note: "Fabric hole", evidenceAssetIds: [] }] }).success).toBe(false);
  });

  it("keeps remake and compensation inputs explicit", () => {
    const base = { originalProductionOrderId: createEntityId(), defectId: null, reason: "Failed QC", idempotencyKey: "recovery-0001" };
    expect(CreateProductionRecoveryInputSchema.safeParse({ ...base, type: "remake", expectedCompletionAt: null, compensationAmountMinor: null, compensationCurrency: null }).success).toBe(false);
    expect(CreateProductionRecoveryInputSchema.safeParse({ ...base, type: "cancellation_compensation", expectedCompletionAt: null, compensationAmountMinor: 500, compensationCurrency: "USD" }).success).toBe(true);
  });

  it("rejects duplicate production work inside one batch", () => {
    const productionOrderId = createEntityId();
    expect(CreateProductionBatchInputSchema.safeParse({ supplierId: createEntityId(), productionOrderIds: [productionOrderId, productionOrderId], expectedCompletionAt: "2026-08-02T12:00:00.000Z", idempotencyKey: "batch-create-0001" }).success).toBe(false);
  });
});
