import { describe, expect, it } from "vitest";
import { AssistResultSchema, CreateAssistSchema, type AssistResult } from "@yummyai/contracts/ai/assist";
import { KnowledgeReferenceSchema } from "@yummyai/contracts/knowledge";
import { KnowledgeBenchmarkCaseSchema as BenchmarkCaseSchema, type BenchmarkCalculation, type BenchmarkExpense } from "@yummyai/contracts/knowledge/benchmark";
import { assistFingerprint, type AssistContext } from "./assist.js";
import { assistTaskFingerprint } from "./assist-task-fingerprint.js";
import { SecretVault } from "./secrets.js";
import { calculateBenchmarkValue, gradeBenchmark, openBenchmarkValue, runBenchmarkBaseline, sealBenchmarkValue, summarizeBenchmarkArmCost, type BenchmarkCostInput } from "./knowledge-benchmark.js";

const id = (n: number) => `019f0000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const fingerprint = "a".repeat(64);
const reference = () => KnowledgeReferenceSchema.parse({ sourceId: "knowledge:original-v1", entryId: id(1), versionId: id(2), version: 1,
  title: "Original approved quantity", excerpt: "Synthetic fixed fact Quantity 3 Unit price 12.34 USD", sourceLabel: "Synthetic approved source", sourceUrl: "",
  verifiedOn: "2026-10-20", reviewDueOn: "2026-12-31", checksum: "b".repeat(64), href: `/knowledge?id=${id(1)}`, score: 1 });
const calculation = (patch: Partial<Omit<BenchmarkCalculation, "expectedValue">> = {}): Omit<BenchmarkCalculation, "expectedValue"> => ({
  key: "total", operator: "product", operands: ["3", "12.34"], scale: 2, unit: "money", currency: "USD", ...patch });
const fields = () => BenchmarkCaseSchema.parse({ key: "original", role: "knowledge_answer", evaluation: { label: "Synthetic arithmetic and evidence",
  search: { query: "Original approved quantity", topic: "operations", platform: "amazon", market: "US", spuIds: [] },
  expectedFacts: ["Synthetic fixed fact"], forbiddenClaims: ["unsupported guarantee"], requiredEntryIds: [id(1)], expectRefusal: false },
  calculations: [{ ...calculation(), expectedValue: "37.02" }] });
const prepared = (): AssistContext => ({ request: CreateAssistSchema.parse({ kind: "knowledge_answer", purpose: "evaluation", scopeId: id(3), modelId: id(4), requestId: id(5),
  search: fields().evaluation.search, evidenceStoreId: null, previousRunId: null }), accessPolicy: { version: "v1", dataScope: "self", requiredPermissions: ["workflow:read", "workflow:manage", "workflow:run"] },
  data: { benchmarkCalculations: [calculation()] }, sources: [], checks: [], diagnostics: [], images: [], allowedArtworkIds: [], allowedSpecificationIds: [], allowMatches: false, knowledge: [reference()] });
const answer = (): AssistResult => AssistResultSchema.parse({ summary: "Synthetic fixed fact Correct total 37.02 USD", findings: [{ title: "Synthetic fixed fact", detail: "Synthetic fixed fact",
  kind: "fact", severity: "info", location: null, evidence: [{ sourceId: reference().sourceId, detail: "Original source version" }] }], directions: [], matches: [], missingInformation: [],
  typedAnswers: [{ key: "total", value: "37.02", unit: "money", currency: "USD", evidence: [{ sourceId: "benchmark-input:total", detail: "Original three units at 12.34 USD" }] }] });
const expense = (patch: Partial<BenchmarkExpense> = {}): BenchmarkExpense => ({ id: id(10), experimentId: id(11), arm: "candidate", previousId: null, sequence: 1,
  storageUsd: "0.01000000", maintenanceUsd: "0.25000000", activityFingerprint: fingerprint,
  periodStart: "2026-10-01T00:00:00.000Z", periodEnd: "2026-10-21T00:00:00.000Z", allocationBasis: "Synthetic cumulative actual expense allocation", createdAt: "2026-10-21T00:00:00.000Z", ...patch });
const costInput = (): BenchmarkCostInput => ({ arm: "candidate", totalItems: 2, activityFingerprint: fingerprint,
  outcomes: [1, 2].map(() => ({ state: "completed", hardPass: true, reviewDecision: "pass" })),
  attempts: [{ id: id(20), modelCost: { amountUsd: "1.00000010", source: "billing_acknowledged", billingReceiptId: id(21), localProcessingAttempts: 3, confirmedProviderCalls: 1, possibleProviderCalls: 0 } }],
  reviews: [{ id: id(22), minutes: "1.500", hourlyUsd: "120.00000000" }], expense: expense() });

describe("fixed knowledge benchmark execution and full cost", () => {
  it("calculates decimal arithmetic exactly and rounds both signs halfway away from zero", () => {
    expect(calculateBenchmarkValue(calculation())).toBe("37.02");
    expect(calculateBenchmarkValue(calculation({ operator: "sum", operands: ["0.1", "0.2"], scale: 8 }))).toBe("0.30000000");
    expect(calculateBenchmarkValue(calculation({ operator: "difference", operands: ["3", "1", "0.25"], scale: 2 }))).toBe("1.75");
    expect(calculateBenchmarkValue(calculation({ operator: "quotient", operands: ["1", "8"], scale: 2 }))).toBe("0.13");
    expect(calculateBenchmarkValue(calculation({ operator: "quotient", operands: ["-1", "8"], scale: 2 }))).toBe("-0.13");
    expect(calculateBenchmarkValue(calculation({ operator: "sum", operands: ["999999999999.000000001", "0.000000009"], scale: 8 }))).toBe("999999999999.00000001");
  });

  it("rejects zero division and results outside the registered decimal range without coercing operands", () => {
    expect(() => calculateBenchmarkValue(calculation({ operator: "quotient", operands: ["1", "0"] }))).toThrow("benchmark_division_by_zero");
    expect(() => calculateBenchmarkValue(calculation({ operands: ["999999999999", "2"] }))).toThrow("benchmark_calculation_out_of_range");
    expect(() => calculateBenchmarkValue(calculation({ operands: ["1e3", "2"] }))).toThrow("benchmark_decimal_invalid");
    expect(() => calculateBenchmarkValue(calculation({ operator: "quotient", operands: ["1", "2", "3"] }))).toThrow("benchmark_calculation_invalid");
  });

  it("runs the rule baseline from original operands and knowledge without receiving or copying gold answers", () => {
    const input = prepared(), before = structuredClone(input), actual = runBenchmarkBaseline(input), independent = fields();
    expect(actual.typedAnswers).toEqual([{ key: "total", value: "37.02", unit: "money", currency: "USD", evidence: [{ sourceId: "benchmark-input:total", detail: expect.any(String) }] }]);
    expect(actual.findings[0]?.detail).toBe(reference().excerpt); expect(input).toEqual(before);
    expect(gradeBenchmark(independent, actual, [reference()]).hardPass).toBe(true);
    independent.calculations[0]!.expectedValue = "999";
    independent.evaluation.expectedFacts = ["Never present private gold phrase"];
    expect(JSON.stringify(actual)).not.toContain("Never present private gold phrase"); expect(JSON.stringify(actual)).not.toContain("999");
    expect(gradeBenchmark(independent, actual, [reference()]).hardPass).toBe(false);
    input.data.benchmarkCalculations = [{ ...calculation(), expectedValue: "37.02" }];
    expect(() => runBenchmarkBaseline(input)).toThrow("benchmark_ground_truth_in_execution_input");
  });

  it("keeps correct phrase assertions separate from missing or incorrect structured arithmetic", () => {
    const original = answer(), current = fields();
    expect(gradeBenchmark(current, original, [reference()]).hardPass).toBe(true);
    for (const invalid of ["37.01", "37.0201"]) {
      const changed = structuredClone(original); changed.typedAnswers![0]!.value = invalid;
      const grade = gradeBenchmark(current, changed, [reference()]);
      expect(grade.checks.find(row => row.key === "expected_facts")?.status).toBe("pass");
      expect(grade.checks.find(row => row.key === "numeric:total")?.status).toBe("fail"); expect(grade.hardPass).toBe(false);
    }
    const missing = structuredClone(original); delete missing.typedAnswers;
    expect(gradeBenchmark(current, missing, [reference()]).checks.find(row => row.key === "numeric:total")?.status).toBe("fail");
  });

  it("hard fails duplicate keys, wrong units, currencies, original references and invalid arithmetic even when the stated value matches", () => {
    const current = fields(), original = answer();
    const duplicate = structuredClone(original); duplicate.typedAnswers!.push(structuredClone(duplicate.typedAnswers![0]!));
    expect(gradeBenchmark(current, duplicate, [reference()]).checks.find(row => row.key === "numeric_shape")?.status).toBe("fail");
    for (const patch of [{ unit: "each" }, { currency: "EUR" }, { evidence: [{ sourceId: "unpublished-source", detail: "Unrelated source" }] }]) {
      const changed = structuredClone(original); Object.assign(changed.typedAnswers![0]!, patch);
      expect(gradeBenchmark(current, changed, [reference()]).hardPass).toBe(false);
    }
    current.calculations[0] = { ...current.calculations[0]!, operator: "quotient", operands: ["37.02", "0"] };
    expect(gradeBenchmark(current, original, [reference()]).checks.find(row => row.key === "numeric:total")?.detail).toContain("无法");
  });

  it("preserves the original result checksum shape when no typed answers were recorded", () => {
    const original = answer(); delete original.typedAnswers;
    const checksum = assistFingerprint(original), parsed = AssistResultSchema.parse(original);
    expect(Object.hasOwn(parsed, "typedAnswers")).toBe(false); expect(assistFingerprint(parsed)).toBe(checksum);
    const input = prepared(); delete input.data.benchmarkCalculations;
    expect(Object.hasOwn(runBenchmarkBaseline(input), "typedAnswers")).toBe(false);
  });

  it("counts every paid and local attempt plus all human minutes while qualifying only the latest fixed outcomes", () => {
    const input = costInput(), complete = summarizeBenchmarkArmCost(input);
    expect(complete).toMatchObject({ state: "complete", totalItems: 2, qualifiedItems: 2, allAttempts: 1, localProcessingAttempts: 3,
      modelKnownUsd: "1.00000010", humanKnownUsd: "3.00000000", knownSubtotalUsd: "4.26000010", totalUsd: "4.26000010", unitQualifiedCostUsd: "2.13000005" });
    input.attempts.push({ id: id(23), modelCost: { amountUsd: "0.40000000", source: "billing_acknowledged", billingReceiptId: id(24), localProcessingAttempts: 1, confirmedProviderCalls: 1, possibleProviderCalls: 0 } });
    input.reviews.push({ id: id(25), minutes: "0.500", hourlyUsd: "120.00000000" });
    input.outcomes[0] = { state: "failed", hardPass: false, reviewDecision: "pass" };
    const failed = summarizeBenchmarkArmCost(input);
    expect(failed).toMatchObject({ allAttempts: 2, qualifiedItems: 1, hardFailedItems: 1, modelKnownUsd: "1.40000010", humanKnownUsd: "4.00000000", totalUsd: "5.66000010", unitQualifiedCostUsd: "5.66000010" });
    input.outcomes[0] = { state: "queued", hardPass: null, reviewDecision: null };
    expect(summarizeBenchmarkArmCost(input)).toMatchObject({ state: "incomplete", qualifiedItems: 1, knownSubtotalUsd: "5.66000010", totalUsd: null, unitQualifiedCostUsd: null });
  });

  it("never turns unknown fees, unresolved submission or unfinished human review into a free qualified result", () => {
    const pending = costInput(); pending.outcomes[0]!.reviewDecision = "needs_review";
    expect(summarizeBenchmarkArmCost(pending)).toMatchObject({ state: "incomplete", qualifiedItems: 1, pendingReviewItems: 1,
      knownSubtotalUsd: "4.26000010", totalUsd: null, unitQualifiedCostUsd: null, estimatedUnitQualifiedCostUsd: null });
    const input = costInput(); input.attempts.push({ id: id(30), modelCost: { amountUsd: null, source: "unknown", billingReceiptId: null, localProcessingAttempts: 2, confirmedProviderCalls: 0, possibleProviderCalls: 1 } });
    input.reviews.push({ id: id(31), minutes: "2", hourlyUsd: null }); input.outcomes[0]!.reviewDecision = "needs_review";
    const unknown = summarizeBenchmarkArmCost(input);
    expect(unknown).toMatchObject({ state: "incomplete", pendingReviewItems: 1, qualifiedItems: 1, modelKnownUsd: "1.00000010", reviewMinutes: "3.500", totalUsd: null, unitQualifiedCostUsd: null });
    expect(unknown.missing.join(" ")).toContain("模型费用未知"); expect(unknown.missing.join(" ")).toContain("人工费率未知");
    input.attempts = []; input.reviews = []; input.outcomes.forEach(row => { row.hardPass = false; row.reviewDecision = "pass"; });
    expect(summarizeBenchmarkArmCost(input)).toMatchObject({ state: "complete", qualifiedItems: 0, totalUsd: "0.26000000", unitQualifiedCostUsd: null });
  });

  it("labels usage estimates distinctly and uses one cumulative expense version only when it covers current activity", () => {
    const input = costInput(); input.attempts[0]!.modelCost.source = "usage_estimate"; input.attempts[0]!.modelCost.billingReceiptId = null;
    expect(summarizeBenchmarkArmCost(input)).toMatchObject({ state: "estimated", unitQualifiedCostUsd: null, estimatedUnitQualifiedCostUsd: "2.13000005" });
    input.expense = expense({ id: id(40), previousId: id(10), sequence: 2, storageUsd: "0.10000000", maintenanceUsd: "0.50000000" });
    expect(summarizeBenchmarkArmCost(input).knownSubtotalUsd).toBe("4.60000010");
    input.expense.activityFingerprint = "c".repeat(64);
    expect(summarizeBenchmarkArmCost(input)).toMatchObject({ state: "incomplete", knownSubtotalUsd: "4.60000010", totalUsd: null, estimatedUnitQualifiedCostUsd: null });
    input.totalItems = 3;
    expect(() => summarizeBenchmarkArmCost(input)).toThrow("benchmark_fixed_denominator_invalid");
  });

  it("rounds human microcosts exactly rather than losing a paid fraction through binary floats", () => {
    const input = costInput(); input.attempts = []; input.expense = expense({ storageUsd: "0.00000000", maintenanceUsd: "0.00000000" });
    input.reviews = [{ id: id(50), minutes: "0.001", hourlyUsd: "0.00030000" }];
    expect(summarizeBenchmarkArmCost(input)).toMatchObject({ humanKnownUsd: "0.00000001", totalUsd: "0.00000001", unitQualifiedCostUsd: "0.00000001" });
  });

  it("authenticates the sealed domain and payload and refuses wrong keys or corrupted envelopes", () => {
    const vault = new SecretVault(Buffer.alloc(32, 77)), value = { tenantId: id(60), itemId: id(61), original: ["中文", null, "37.02"] };
    const sealed = sealBenchmarkValue(vault, "basis", value);
    expect(openBenchmarkValue(vault, "basis", sealed)).toEqual(value);
    const input = prepared(); input.data = { zOriginal: "Original key order", ...input.data, aOriginal: "Last original key" };
    const reopened = openBenchmarkValue<AssistContext>(vault, "basis", sealBenchmarkValue(vault, "basis", input));
    expect(assistFingerprint(reopened)).toBe(assistFingerprint(input));
    expect(assistTaskFingerprint(reopened)).toBe(assistTaskFingerprint(input));
    expect(() => openBenchmarkValue(vault, "assessment", sealed)).toThrow("knowledge_benchmark_proof_invalid");
    expect(() => openBenchmarkValue(new SecretVault(Buffer.alloc(32, 78)), "basis", sealed)).toThrow("knowledge_benchmark_proof_invalid");
    const parts = sealed.split("."); const bytes = Buffer.from(parts[3]!, "base64url"); bytes[0] = bytes[0]! ^ 1; parts[3] = bytes.toString("base64url");
    expect(() => openBenchmarkValue(vault, "basis", parts.join("."))).toThrow("knowledge_benchmark_proof_invalid");
    expect(() => openBenchmarkValue(vault, "basis", vault.encrypt(JSON.stringify({ version: 1, domain: "knowledge-benchmark-basis", value, extra: true })))).toThrow("knowledge_benchmark_proof_invalid");
  });
});
