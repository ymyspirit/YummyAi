import type { AnalysisReport } from "@yummyai/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AnalysisReportView } from "./analysis-report-view";

describe("AnalysisReportView", () => {
  it("renders claim kinds, evidence, model cost, versions, and comparison data", () => {
    const report = fixture();
    const html = renderToStaticMarkup(<AnalysisReportView report={report} versions={[{ ...report, version: 1 }, report]} />);
    expect(html).toContain("事实");
    expect(html).toContain("推断");
    expect(html).toContain("建议");
    expect(html).toContain("$0.0420");
    expect(html).toContain("analysis-v2");
    expect(html).toContain("V1 → V2");
    expect(html).toContain("多商品对比");
  });
});

function fixture(): AnalysisReport {
  const snapshot = "0198fbef-4a10-7000-8000-000000000031";
  return {
    id: "0198fbef-4a10-7000-8000-000000000032",
    reportSeriesId: "0198fbef-4a10-7000-8000-000000000033",
    version: 2,
    taskType: "AI-05",
    status: "completed",
    title: "Comparison",
    executiveSummary: "Evidence-backed comparison.",
    sections: [{ id: "section", title: "Signals", claims: [
      { id: "fact", kind: "fact", text: "Price is $29.99", evidence: [{ snapshotId: snapshot, sourceType: "field", sourcePath: "price.amount" }] },
      { id: "inference", kind: "inference", text: "Premium leaning", confidence: 0.7, evidence: [] },
      { id: "recommendation", kind: "recommendation", text: "Test a bundle", priority: "high", evidence: [] },
    ] }],
    comparison: [{ dimension: "Price", values: { [snapshot]: "$29.99" }, evidence: [] }],
    inputSnapshotIds: [snapshot],
    model: { providerId: "openai", modelKey: "analyst.default", costUsd: 0.042 },
    promptTemplateVersion: "analysis-v2",
    createdBy: "0198fbef-4a10-7000-8000-000000000034",
    createdAt: "2026-07-18T01:00:00.000Z",
  };
}
