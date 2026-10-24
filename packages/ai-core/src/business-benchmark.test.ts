import { describe, expect, it } from "vitest";
import { CreateAssistSchema, LegacyAssistResultSchema } from "@yummyai/contracts/ai/assist";
import { AssistTaskInputSchema } from "@yummyai/contracts/ai/task-workspace";
import { BusinessBenchmarkCaseSchema, type BusinessBenchmarkCase } from "@yummyai/contracts/knowledge/benchmark";
import { assistTaskFingerprint } from "./assist-task-fingerprint.js";
import { type AssistContext } from "./assist.js";
import { businessBenchmarkBasisFingerprint, businessBenchmarkCaseChecksum, businessBenchmarkSourcePins,
  gradeBusinessBenchmark, runBusinessBenchmarkBaseline } from "./business-benchmark.js";

const id = (n: number) => `019f0000-0000-7000-8000-${String(n).padStart(12, "0")}`;
function prepared(kind: "procurement_review" | "business_review" = "procurement_review"): AssistContext {
  return { request: CreateAssistSchema.parse({ kind, modelId: id(1), requestId: id(2), expectedFingerprint: "a".repeat(64),
    ...(kind === "procurement_review" ? { stockItemId: id(3), locationId: id(4) } : { runId: id(3), comparisonRunId: null }) }),
    sources: [{ id: kind === "procurement_review" ? "inventory" : id(3), label: "Synthetic original owner facts", href: null }],
    data: kind === "procurement_review" ? { stock: { id: id(3), unit: "each" },
      calculations: { physical: "2", reserved: "0", available: "2", suggestedQuantity: "12" },
      quotes: [{ currency: "USD", unitCostMinor: 150 }], note: "Synthetic fixed owner fact" } :
      { current: { id: id(3), reportingCurrency: "USD", revenueMinor: 7350, costMinor: 2050, profitMinor: 5300, status: "complete" },
        comparison: null, note: "Synthetic fixed owner fact" },
    checks: [], diagnostics: [], images: [], allowedArtworkIds: [], allowedSpecificationIds: [], allowMatches: false,
    inputAuthority: { version: "assist-input-authority-v1", capturedAt: "2026-10-21T00:00:00.000Z", fingerprint: "b".repeat(64), resources: [] },
    accessPolicy: { version: "v1", dataScope: "tenant", requiredPermissions: ["workflow:read"] }, expiresAt: "2026-10-22T00:00:00.000Z" };
}
function fields(input: AssistContext, patch: Partial<BusinessBenchmarkCase> = {}): BusinessBenchmarkCase {
  const task = { ...input.request }; delete (task as Partial<typeof task>).modelId; delete (task as Partial<typeof task>).requestId;
  return BusinessBenchmarkCaseSchema.parse({ key: "original", role: input.request.kind, label: "Synthetic fixed business packet",
    task: AssistTaskInputSchema.parse({ ...task, expectedTaskFingerprint: assistTaskFingerprint(input) }),
    expectedFacts: ["Synthetic fixed owner fact"], forbiddenClaims: ["guaranteed landed profit"], expectRefusal: false, ...patch });
}

describe("fixed original procurement and finance benchmark facts", () => {
  it("extracts original decimal stock and quote values with their units without gold, purchase commands or typed numeric output", () => {
    const input = prepared(), before = structuredClone(input), result = runBusinessBenchmarkBaseline(input);
    expect(JSON.stringify(input)).toBe(JSON.stringify(before)); expect(Object.hasOwn(result, "typedAnswers")).toBe(false);
    expect(result.findings.filter(row => row.location === "calculations").map(row => row.detail).join("")).toBe(JSON.stringify(input.data.calculations));
    expect(result.findings.filter(row => row.location === "quotes").map(row => row.detail).join("")).toBe(JSON.stringify(input.data.quotes));
    expect(result.actions).toEqual([]); expect(result.replyDraft).toBeNull(); expect(result.listingCopy).toBeNull();
    expect(gradeBusinessBenchmark(fields(input), result, input).hardPass).toBe(true);
  });
  it("preserves saved finance minor units, currency and unknown amounts instead of recalculating them or treating null as zero", () => {
    const input = prepared("business_review"); Object.assign(input.data.current as object, { costMinor: null, profitMinor: null, status: "incomplete" });
    input.checks = [{ code: "finance_incomplete", message: "缺少原生产成本 不能推断利润", severity: "manual", location: null }];
    const result = runBusinessBenchmarkBaseline(input), current = result.findings.filter(row => row.location === "current").map(row => row.detail).join("");
    expect(JSON.parse(current)).toEqual(input.data.current); expect(result.missingInformation).toContain("finance_incomplete: 缺少原生产成本 不能推断利润");
    expect(gradeBusinessBenchmark(fields(input, { expectRefusal: true }), result, input).hardPass).toBe(true);
  });
  it("retains every bounded source section across display chunks and rejects oversized packets rather than silently clipping facts", () => {
    const input = prepared(); input.data.note = "中文原始证据".repeat(650) + "ORIGINAL-END";
    const result = runBusinessBenchmarkBaseline(input);
    expect(result.findings.filter(row => row.location === "note").map(row => row.detail).join("")).toBe(JSON.stringify(input.data.note));
    input.data.note = "x".repeat(8001); expect(() => runBusinessBenchmarkBaseline(input)).toThrow("business_benchmark_rule_input_too_large");
  });
  it("reports missing original business evidence and never upgrades absent knowledge guidance into a business fact", () => {
    const input = prepared(); input.sources = []; input.data = { operatingKnowledge: { gold: "Not a business source" }, retrieval: {}, conversation: [] };
    const result = runBusinessBenchmarkBaseline(input); expect(result.findings).toEqual([]); expect(result.missingInformation.join(" ")).toContain("缺少可引用业务来源");
    expect(JSON.stringify(result)).not.toContain("Not a business source");
    for (const gold of ["expectedFacts", "forbiddenClaims", "expectedValue"]) {
      const contaminated = prepared(); contaminated.data[gold] = ["Synthetic hidden grader gold"];
      expect(() => runBusinessBenchmarkBaseline(contaminated)).toThrow("business_benchmark_ground_truth_in_input");
    }
    input.request = CreateAssistSchema.parse({ kind: "knowledge_answer", purpose: "dialogue", scopeId: id(5), modelId: id(1), requestId: id(2),
      search: { query: "Synthetic source", topic: "all", platform: "all", market: "ALL", spuIds: [] } });
    expect(() => runBusinessBenchmarkBaseline(input)).toThrow("business_benchmark_role_invalid");
  });
  it("hard fails forged evidence, forbidden claims and missing declared facts even when other phrase checks pass", () => {
    const input = prepared(), original = runBusinessBenchmarkBaseline(input), expected = fields(input);
    expect(gradeBusinessBenchmark(expected, original, input).checks.map(row => row.key)).toEqual([
      "business_role", "business_schema", "business_evidence", "expected_facts", "forbidden_claims", "refusal", "original_gaps", "task_identity"]);
    const forged = structuredClone(original); forged.findings[0]!.evidence[0]!.sourceId = "foreign-source";
    expect(gradeBusinessBenchmark(expected, forged, input).checks.find(row => row.key === "business_evidence")?.status).toBe("fail");
    const forbidden = structuredClone(original); forbidden.summary += " guaranteed landed profit";
    expect(gradeBusinessBenchmark(expected, forbidden, input).hardPass).toBe(false);
    const absent = fields(input, { expectedFacts: ["Independent requirement absent from the original result"] });
    expect(gradeBusinessBenchmark(absent, original, input).checks.find(row => row.key === "expected_facts")?.status).toBe("fail");
  });
  it("requires original gap warnings and explicit refusal instead of a confident answer to an incomplete case", () => {
    const input = prepared(); input.checks = [{ code: "quotes_missing", message: "没有有效报价 请先核实", severity: "manual", location: null }];
    const original = runBusinessBenchmarkBaseline(input), expected = fields(input, { expectRefusal: true });
    expect(gradeBusinessBenchmark(expected, original, input).hardPass).toBe(true);
    original.missingInformation = []; original.summary = "Everything is complete";
    const grade = gradeBusinessBenchmark(expected, original, input); expect(grade.hardPass).toBe(false);
    expect(grade.checks.filter(row => ["refusal", "original_gaps"].includes(row.key)).map(row => row.status)).toEqual(["fail", "fail"]);
  });
  it("preserves the original production schema and rejects evaluation-only typed answers or a mismatched original role and task", () => {
    const input = prepared(), expected = fields(input), original = runBusinessBenchmarkBaseline(input);
    expect(LegacyAssistResultSchema.parse(original)).toEqual(original);
    const typed = { ...original, typedAnswers: [{ key: "profit", value: "999", unit: "money", currency: "USD", evidence: [] }] };
    expect(gradeBusinessBenchmark(expected, typed, input).checks.find(row => row.key === "business_schema")?.status).toBe("fail");
    const foreignRole = prepared("business_review");
    expect(gradeBusinessBenchmark(expected, original, foreignRole).checks.find(row => row.key === "business_role")?.status).toBe("fail");
    expected.task.expectedTaskFingerprint = "c".repeat(64);
    expect(gradeBusinessBenchmark(expected, original, input).checks.find(row => row.key === "task_identity")?.status).toBe("fail");
  });
  it("pins complete source identity, authority, original method and expiry separately from mutable transport IDs", () => {
    const input = prepared(), expected = fields(input), original = businessBenchmarkBasisFingerprint(expected, input), pins = businessBenchmarkSourcePins(input);
    expect(pins).toHaveLength(input.sources.length); expect(pins[0]).toMatchObject({ kind: "business", sourceId: "inventory", resourceId: `procurement:${id(3)}:${id(4)}` });
    const transport = structuredClone(input); transport.request.modelId = id(50); transport.request.requestId = id(51);
    expect(businessBenchmarkBasisFingerprint(expected, transport)).toBe(original);
    const authority = structuredClone(input); authority.inputAuthority!.fingerprint = "d".repeat(64);
    expect(businessBenchmarkBasisFingerprint(expected, authority)).not.toBe(original); expect(businessBenchmarkSourcePins(authority)).not.toEqual(pins);
    const expires = structuredClone(input); expires.expiresAt = "2026-10-23T00:00:00.000Z";
    expect(businessBenchmarkBasisFingerprint(expected, expires)).not.toBe(original);
    expect(businessBenchmarkCaseChecksum({ ...expected, expectedFacts: ["Different independent fact requirement"] })).not.toBe(businessBenchmarkCaseChecksum(expected));
    expect(() => businessBenchmarkSourcePins({ ...input, inputAuthority: undefined })).toThrow("business_benchmark_sources_invalid");
  });
});
