import { describe, expect, it } from "vitest";

import { AnalysisContentSchema, AnalysisReportSchema } from "./report.js";

const snapshotId = "0198fbef-4a10-7000-8000-000000000001";

describe("AnalysisReportSchema", () => {
  it("rejects a fact without at least one evidence reference", () => {
    const result = AnalysisContentSchema.safeParse({
      title: "Pricing review",
      executiveSummary: "The price position is documented below.",
      sections: [{ id: "pricing", title: "Pricing", claims: [{ id: "price", kind: "fact", text: "$29.99", evidence: [] }] }],
    });
    expect(result.success).toBe(false);
  });

  it("keeps facts, inferences, and recommendations explicitly discriminated", () => {
    const result = AnalysisReportSchema.parse({
      id: "0198fbef-4a10-7000-8000-000000000002",
      reportSeriesId: "0198fbef-4a10-7000-8000-000000000003",
      version: 1,
      taskType: "AI-01",
      status: "completed",
      title: "Market position",
      executiveSummary: "Evidence-backed summary.",
      sections: [{
        id: "position",
        title: "Position",
        claims: [
          { id: "fact", kind: "fact", text: "Public price is $29.99", evidence: [{ snapshotId, sourceType: "field", sourcePath: "price.amount" }] },
          { id: "inference", kind: "inference", text: "Premium leaning", confidence: 0.72, evidence: [] },
          { id: "next", kind: "recommendation", text: "Test a bundle", priority: "medium", evidence: [] },
        ],
      }],
      inputSnapshotIds: [snapshotId],
      model: { providerId: "openai", modelKey: "analyst.default", costUsd: 0.03 },
      promptTemplateVersion: "analysis-v1",
      createdBy: "0198fbef-4a10-7000-8000-000000000004",
      createdAt: "2026-07-18T01:00:00.000Z",
    });
    expect(result.sections[0]?.claims.map((claim) => claim.kind)).toEqual(["fact", "inference", "recommendation"]);
  });
});
