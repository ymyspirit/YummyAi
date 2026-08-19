import { describe, expect, it } from "vitest";

import {
  CalculateSupplierScorecardInputSchema,
  UpsertSupplierKpiDefinitionInputSchema,
  type SupplierKpiMetric,
} from "./supplier-performance.js";

const metrics: SupplierKpiMetric[] = [
  "quality",
  "on_time_delivery",
  "price_variance",
  "response_time",
  "acceptance",
  "cancellation",
  "capacity_adherence",
];

describe("supplier performance contracts", () => {
  it("requires all seven unique KPIs with weights totaling 10000 bps", () => {
    const parsed = UpsertSupplierKpiDefinitionInputSchema.parse({
      definitionId: null,
      name: "Balanced supplier score",
      missingDataPolicy: "incomplete",
      metrics: metrics.map((metric, index) => ({
        metric,
        weightBps: index === 6 ? 1_600 : 1_400,
        minimumSampleCount: 2,
        responseTargetHours: metric === "response_time" ? 24 : null,
      })),
      reasonCode: "INITIAL",
      idempotencyKey: "supplier-definition-001",
    });

    expect(parsed.metrics).toHaveLength(7);
    expect(parsed.metrics.reduce((sum, metric) => sum + metric.weightBps, 0)).toBe(10_000);
  });

  it("rejects a response target on a non-response KPI", () => {
    expect(() => UpsertSupplierKpiDefinitionInputSchema.parse({
      definitionId: null,
      name: "Invalid",
      missingDataPolicy: "exclude",
      metrics: metrics.map((metric, index) => ({
        metric,
        weightBps: index === 6 ? 1_600 : 1_400,
        minimumSampleCount: 1,
        responseTargetHours: metric === "quality" ? 12 : metric === "response_time" ? 24 : null,
      })),
      reasonCode: "INVALID",
      idempotencyKey: "supplier-definition-invalid",
    })).toThrow(/response-time/i);
  });

  it("requires the evidence cutoff to cover the complete evaluation window", () => {
    expect(() => CalculateSupplierScorecardInputSchema.parse({
      definitionId: "0197d335-5f28-7000-8000-000000000001",
      expectedDefinitionVersion: 1,
      supplierId: "0197d335-5f28-7000-8000-000000000002",
      windowStart: "2026-06-01T00:00:00.000Z",
      windowEnd: "2026-07-01T00:00:00.000Z",
      evidenceCutoffAt: "2026-06-30T23:59:59.000Z",
      idempotencyKey: "supplier-run-invalid",
    })).toThrow(/cutoff/i);
  });
});
