import type {
  SupplierKpiMetric,
  SupplierKpiMetricDefinition,
  SupplierKpiRawUnit,
} from "@yummyai/contracts/supplier-performance";
import { describe, expect, it } from "vitest";

import { calculateOverall } from "./supplier-performance.service.js";

const metricNames: SupplierKpiMetric[] = [
  "quality",
  "on_time_delivery",
  "price_variance",
  "response_time",
  "acceptance",
  "cancellation",
  "capacity_adherence",
];

const definitions: SupplierKpiMetricDefinition[] = metricNames.map((metric, index) => ({
  metric,
  weightBps: index === 6 ? 1_600 : 1_400,
  minimumSampleCount: 2,
  responseTargetHours: metric === "response_time" ? 24 : null,
}));

function metric(metric: SupplierKpiMetric, scoreBps: number | null, sampleCount = 2) {
  return {
    metric,
    scoreBps,
    sampleCount,
    rawNumerator: scoreBps ?? 0,
    rawDenominator: scoreBps === null ? 0 : 10_000,
    rawUnit: "sample_ratio" as SupplierKpiRawUnit,
    evidenceReferences: [],
  };
}

describe("supplier performance scoring", () => {
  it("reweights available KPI values under the exclude policy", () => {
    const values = metricNames.map((name) => metric(name, name === "quality" ? null : 8_000));
    expect(calculateOverall(values, definitions, "exclude")).toBe(8_000);
  });

  it("keeps an incomplete score null when a required sample is missing", () => {
    const values = metricNames.map((name) => metric(name, name === "quality" ? null : 8_000));
    expect(calculateOverall(values, definitions, "incomplete")).toBeNull();
  });

  it("applies the explicitly versioned zero policy without hiding sample gaps", () => {
    const values = metricNames.map((name) => metric(name, name === "quality" ? null : 10_000));
    expect(calculateOverall(values, definitions, "zero")).toBe(8_600);
  });

  it("treats a below-minimum sample as unavailable", () => {
    const values = metricNames.map((name) => metric(name, 10_000, name === "quality" ? 1 : 2));
    expect(calculateOverall(values, definitions, "incomplete")).toBeNull();
  });
});
