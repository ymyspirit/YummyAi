import type { SupplierPerformanceWorkspaceView } from "@yummyai/contracts/supplier-performance";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SupplierPerformanceWorkspace } from "./supplier-performance-workspace";

const supplierId = "019f8f26-0000-7000-8000-000000000001";
const definitionId = "019f8f26-0000-7000-8000-000000000002";
const versionId = "019f8f26-0000-7000-8000-000000000003";
const runId = "019f8f26-0000-7000-8000-000000000004";

describe("SupplierPerformanceWorkspace", () => {
  it("renders explicit empty evidence states", () => {
    const html = renderToStaticMarkup(
      <SupplierPerformanceWorkspace data={{ suppliers: [], definitions: [], scorecards: [] }} />,
    );
    expect(html).toContain("还没有供应商");
    expect(html).toContain("还没有版本化 KPI 定义");
    expect(html).toContain("尚未生成供应商评分");
  });

  it("renders the complete seven-KPI evidence matrix", () => {
    const data = {
      suppliers: [{ id: supplierId, name: "Evidence Supplier", kind: "manual", status: "active", regionCode: "US" }],
      definitions: [{
        id: definitionId,
        name: "Balanced supplier performance",
        currentVersion: 1,
        status: "active",
        version: {
          id: versionId,
          definitionId,
          versionNumber: 1,
          missingDataPolicy: "incomplete",
          metrics: metricNames.map((metric, index) => ({
            metric,
            weightBps: index === 6 ? 1_600 : 1_400,
            minimumSampleCount: 1,
            responseTargetHours: metric === "response_time" ? 24 : null,
          })),
          reasonCode: "P3_BASELINE",
          checksum: "a".repeat(64),
          createdAt: "2026-07-23T10:00:00.000Z",
        },
        createdAt: "2026-07-23T10:00:00.000Z",
        updatedAt: "2026-07-23T10:00:00.000Z",
      }],
      scorecards: [{
        id: runId,
        supplierId,
        definitionId,
        definitionVersionId: versionId,
        definitionVersion: 1,
        status: "complete",
        overallScoreBps: 9_900,
        windowStart: "2026-07-01T00:00:00.000Z",
        windowEnd: "2026-09-01T00:00:00.000Z",
        evidenceCutoffAt: "2026-09-02T00:00:00.000Z",
        diagnostics: { missingMetrics: [], insufficientSampleMetrics: [] },
        inputChecksum: "b".repeat(64),
        calculatedAt: "2026-09-02T01:00:00.000Z",
        metrics: metricNames.map((metric, index) => ({
          id: `019f8f26-0000-7000-8000-0000000001${String(index).padStart(2, "0")}`,
          metric,
          scoreBps: metric === "quality" ? 9_500 : 10_000,
          sampleCount: metric === "on_time_delivery" ? 2 : 1,
          rawNumerator: metric === "quality" ? 9_500 : 1,
          rawDenominator: 1,
          rawUnit: metric === "quality"
            ? "weighted_bps"
            : metric === "price_variance"
              ? "money_ratio"
              : metric === "capacity_adherence"
                ? "unit_ratio"
                : "sample_ratio",
          evidenceReferences: [{ sourceType: "fixture", sourceId: supplierId }],
        })),
      }],
    } satisfies SupplierPerformanceWorkspaceView;

    const html = renderToStaticMarkup(<SupplierPerformanceWorkspace data={data} />);
    expect(html).toContain("99.0%");
    expect(html).toContain("Evidence Supplier");
    expect(html).toContain("七项 KPI 样本完整");
    expect(html).toContain("产能履约");
    expect(html).toContain("价格准确值比");
  });
});

const metricNames = [
  "quality",
  "on_time_delivery",
  "price_variance",
  "response_time",
  "acceptance",
  "cancellation",
  "capacity_adherence",
] as const;
