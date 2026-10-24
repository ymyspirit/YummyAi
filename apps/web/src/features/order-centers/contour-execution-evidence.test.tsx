import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PILLOW_CONTOUR_GRAPH_VERSION, PillowContourEvidenceSchema } from "@yummyai/contracts/pod/design-automation";
import { ContourExecutionEvidence } from "./contour-execution-evidence";

const evidence = PillowContourEvidenceSchema.parse({
  workflowVersion: PILLOW_CONTOUR_GRAPH_VERSION, engine: "langgraph", status: "passed",
  sourceAssetId: "019f7600-0000-7000-8000-000000000001", sourceChecksum: "a".repeat(64), outputChecksum: "a".repeat(64),
  artworkUnchanged: true, manualReviewRequired: true,
  attempts: [
    { roundingPx: 20, technicalPassed: false, checks: [{ code: "pillow_independent_bounded_contour", status: "failed" }] },
    { roundingPx: 25, technicalPassed: true, checks: [{ code: "pillow_independent_bounded_contour", status: "passed" }, { code: "pillow_visual_review", status: "manual" }] },
  ],
});

describe("contour execution evidence", () => {
  it("keeps technical success separate from manual approval and shows correction history", () => {
    const html = renderToStaticMarkup(<ContourExecutionEvidence evidence={evidence} />);
    expect(html).toContain("裁线执行证据 · 技术检查通过 · 2 次检查");
    expect(html).toContain("初次检查 · 圆滑余量 20 px · 技术检查未通过");
    expect(html).toContain("第 1 次修正 · 圆滑余量 25 px · 技术检查通过");
    expect(html).toContain("独立裁线与缝边范围");
    expect(html).toContain("待人工核对");
    expect(html).toContain("技术检查不代表人工审核或生产批准");
    expect(html).toContain(evidence.sourceChecksum);
    expect(html).toContain(evidence.workflowVersion);
    expect(html).not.toContain("<details open");
  });
  it("explains exhausted corrections and never echoes unknown diagnostic code content", () => {
    const exhausted = PillowContourEvidenceSchema.parse({ ...evidence, status: "needs_attention", attempts: [20, 25, 30].map(roundingPx => ({
      roundingPx, technicalPassed: false, checks: [{ code: "future-private-diagnostic", status: "failed" }],
    })) });
    const html = renderToStaticMarkup(<ContourExecutionEvidence evidence={exhausted} />);
    expect(html).toContain("允许的修正方案已用尽");
    expect(html).toContain("其他检查项（请人工核对）");
    expect(html).not.toContain("future-private-diagnostic");
    expect(html).not.toContain("技术检查通过");
  });
});
