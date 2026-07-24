import { createEntityId } from "../common/ids.js";
import { CreateForecastRunInputSchema, RecordOperatingMetricSnapshotInputSchema } from "./planning.js";
import { describe, expect, it } from "vitest";

describe("planning contracts", () => {
  it("accepts pinned forecast inputs and rejects mismatched evidence", () => {
    const input = forecastInput();
    expect(CreateForecastRunInputSchema.parse(input).quantilesBps).toEqual([1000, 5000, 9000]);
    expect(() => CreateForecastRunInputSchema.parse({
      ...input,
      inputPoints: input.inputPoints.map((point) => ({ ...point, evidenceRefs: [{ sourceType: "profit_run", sourceId: createEntityId() }] })),
    })).toThrow(/evidence type/i);
  });

  it("requires ascending quantiles and evidence for available operating metrics", () => {
    expect(() => CreateForecastRunInputSchema.parse({ ...forecastInput(), quantilesBps: [5000, 1000, 9000] })).toThrow(/ascending/i);
    expect(() => RecordOperatingMetricSnapshotInputSchema.parse({
      definitionId: createEntityId(), expectedDefinitionVersion: 1, value: 12, observedAt: "2026-07-23T00:00:00.000Z",
      completenessBps: 10_000, sourceRefs: [], drillThroughHref: "/inventory", idempotencyKey: "metric-snapshot-1",
    })).toThrow(/source evidence/i);
  });
});

function forecastInput() {
  return {
    metric: "sales_units" as const,
    scopeType: "tenant" as const,
    scopeKey: "tenant",
    grain: "day" as const,
    model: "moving_average_v1" as const,
    modelVersion: "2026.07.1",
    inputWindowStart: "2026-07-01T00:00:00.000Z",
    inputWindowEnd: "2026-07-03T00:00:00.000Z",
    evidenceCutoffAt: "2026-07-03T01:00:00.000Z",
    horizonStart: "2026-07-03T00:00:00.000Z",
    horizonEnd: "2026-07-05T00:00:00.000Z",
    quantilesBps: [1000, 5000, 9000],
    inputPoints: [
      { periodStart: "2026-07-01T00:00:00.000Z", value: 10, evidenceRefs: [{ sourceType: "order_event" as const, sourceId: createEntityId() }] },
      { periodStart: "2026-07-02T00:00:00.000Z", value: 12, evidenceRefs: [{ sourceType: "order_event" as const, sourceId: createEntityId() }] },
    ],
    idempotencyKey: "forecast-run-1",
  };
}
