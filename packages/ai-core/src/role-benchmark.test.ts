import { describe, expect, it } from "vitest";
import { CreateAssistSchema, LegacyAssistResultSchema } from "@yummyai/contracts/ai/assist";
import { BusinessBenchmarkCaseSchema, BenchmarkItemSchema, BUSINESS_BENCHMARK_ROLES,
  benchmarkExecutionVersions, type BusinessBenchmarkCase, type BusinessBenchmarkRole } from "@yummyai/contracts/knowledge/benchmark";
import { assistTaskFingerprint } from "./assist-task-fingerprint.js";
import type { AssistContext } from "./assist.js";
import { businessBenchmarkBasisFingerprint, businessBenchmarkSourcePins, runBusinessBenchmarkBaseline } from "./business-benchmark.js";
import { runRoleBenchmarkBaseline, gradeRoleBenchmark } from "./role-benchmark.js";

const id = (n: number) => `019f0000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const roles = ["creative", "order_review", "artwork_preflight", "template_config", "sku_package", "after_sales_review"] as const;
function input(role: BusinessBenchmarkRole = "order_review"): AssistContext {
  const common = { kind: role, modelId: id(1), requestId: id(2), expectedTaskFingerprint: "a".repeat(64) };
  const fields = role === "creative" ? { scopeId: id(3), projectId: id(4), prompt: "Synthetic original geometric directions", sources: [{ researchItemId: id(5), snapshotId: id(6), studyRevisionId: null }], requirements: { mode: "fixed" } }
    : role === "order_review" ? { orderLineId: id(3), expectedRevision: 1, expectedSourceVersionId: null }
      : role === "artwork_preflight" ? { orderLineId: id(3), expectedRevision: 1, expectedEditorVersionId: id(4) }
        : role === "template_config" ? { inspectionId: id(3) }
          : role === "sku_package" ? { listingId: id(3), expectedVersionId: id(4) }
            : role === "after_sales_review" ? { caseId: id(3), locale: "en-US", expectedFingerprint: "a".repeat(64), contextNotes: "Synthetic status only" }
              : role === "procurement_review" ? { stockItemId: id(3), locationId: id(4), expectedFingerprint: "a".repeat(64) }
                : { runId: id(3), comparisonRunId: null, expectedFingerprint: "a".repeat(64) };
  return { request: CreateAssistSchema.parse({ ...common, ...fields }),
    data: { original: { text: "Synthetic original fixed fact", nullable: null, quantity: "3.000", currency: "USD" } },
    sources: [{ id: id(3), label: "Synthetic original source", href: null }], checks: [], diagnostics: [], images: [],
    allowedArtworkIds: [], allowedSpecificationIds: [], allowMatches: false,
    templateSlotKeys: role === "template_config" ? ["image.customer"] : undefined,
    listingPlatform: role === "sku_package" ? "amazon" : undefined, listingMediaIds: role === "sku_package" ? [] : undefined,
    inputAuthority: { version: "assist-input-authority-v1", capturedAt: "2026-10-21T00:00:00.000Z", fingerprint: "b".repeat(64), resources: [] },
    accessPolicy: { version: "v1", dataScope: "self", requiredPermissions: ["workflow:read"] }, expiresAt: "2026-10-22T00:00:00.000Z",
    benchmarkResources: { version: "role-benchmark-resources-v1", teamIds: [], permissionScopes: { "workflow:read": "self", "design:read": "tenant", "order:read": "tenant" },
      items: [{ kind: role === "template_config" ? "template_inspection" : role === "sku_package" ? "listing_version" : role === "creative" ? "creative_project" : role === "after_sales_review" ? "after_sales_case" : "order_line", id: id(3) }] } };
}
function fields(prepared: AssistContext, patch: Partial<BusinessBenchmarkCase> = {}): BusinessBenchmarkCase {
  const task = Object.fromEntries(Object.entries(prepared.request).filter(([key]) => key !== "modelId" && key !== "requestId"));
  return BusinessBenchmarkCaseSchema.parse({ key: "synthetic", role: prepared.request.kind, label: "Synthetic fixed original role",
    task: { ...task, expectedTaskFingerprint: assistTaskFingerprint(prepared) }, expectedFacts: [], forbiddenClaims: ["AUTOMATICALLY APPROVED FOR PRODUCTION"], expectRefusal: false, ...patch });
}
function item(prepared: AssistContext) {
  const value = fields(prepared);
  return { id: id(70), versionId: id(71), caseId: null, ordinal: 0, fields: value, caseChecksum: "a".repeat(64),
    basisFingerprint: businessBenchmarkBasisFingerprint(value, prepared), taskFingerprint: assistTaskFingerprint(prepared),
    sourcePins: businessBenchmarkSourcePins(prepared), method: null, expiresAt: prepared.expiresAt, usable: true };
}

describe("fixed six-role original native benchmark boundary", () => {
  it("retains all eight business roles and separates knowledge, original two-role and six-role execution versions", () => {
    expect(BUSINESS_BENCHMARK_ROLES).toEqual(["procurement_review", "business_review", ...roles]);
    for (const role of BUSINESS_BENCHMARK_ROLES) expect(fields(input(role)).role).toBe(role);
    expect(benchmarkExecutionVersions(["knowledge_answer"])).toEqual({ baselineVersion: "extractive-arithmetic-v1", graderVersion: "knowledge-benchmark-checks-v1" });
    expect(benchmarkExecutionVersions(["procurement_review", "business_review"])).toEqual({ baselineVersion: "business-facts-v1", graderVersion: "business-benchmark-checks-v1" });
    for (const role of roles) expect(benchmarkExecutionVersions(["procurement_review", role])).toEqual({ baselineVersion: "role-facts-v1", graderVersion: "role-benchmark-checks-v1" });
  });

  it("rejects both automatic artwork audit switches in a fixed task without changing the ordinary original schema", () => {
    const prepared = input("artwork_preflight"), original = fields(prepared);
    for (const key of ["automaticAudit", "retryAudit"] as const) {
      expect(BusinessBenchmarkCaseSchema.safeParse({ ...original, task: { ...original.task, [key]: true } }).success).toBe(false);
      expect(BusinessBenchmarkCaseSchema.safeParse({ ...original, task: { ...original.task, [key]: false } }).success).toBe(false);
    }
    expect(CreateAssistSchema.safeParse({ ...prepared.request, automaticAudit: true }).success).toBe(true);
  });

  it("preserves a complete sixty-slot template and all source pins beyond thirty-two without silent cropping", () => {
    const prepared = input("template_config");
    prepared.templateSlotKeys = Array.from({ length: 60 }, (_, i) => `image.slot_${i}`);
    prepared.sources.push(...prepared.templateSlotKeys.map(key => ({ id: key, label: `Original ${key}`, href: null })));
    prepared.data.inspection = { slots: prepared.templateSlotKeys.map(stableKey => ({ stableKey, kind: "image" })) };
    const pins = businessBenchmarkSourcePins(prepared);
    expect(pins.map(pin => pin.sourceId)).toEqual(prepared.sources.map(source => source.id)); expect(pins).toHaveLength(61);
    expect(pins[0]).toMatchObject({ resourceBindings: prepared.benchmarkResources });
    expect(BenchmarkItemSchema.parse(item(prepared)).sourcePins).toHaveLength(61);
    const baseline = runRoleBenchmarkBaseline(prepared);
    expect(baseline.findings.map(finding => finding.detail).join("")).toContain("image.slot_59");
  });

  it("enforces new two-hundred-fifty-six and original thirty-two source bounds and mandatory typed resource bindings", () => {
    const prepared = input("order_review");
    prepared.sources = Array.from({ length: 256 }, (_, i) => ({ id: `original:${i}`, label: `Synthetic ${i}`, href: null }));
    expect(BenchmarkItemSchema.parse(item(prepared)).sourcePins).toHaveLength(256);
    prepared.sources.push({ id: "original:overflow", label: "Overflow", href: null });
    expect(() => businessBenchmarkSourcePins(prepared)).toThrow();
    const legacy = input("procurement_review"); legacy.sources = prepared.sources.slice(0, 32);
    expect(businessBenchmarkSourcePins(legacy)).toHaveLength(32); legacy.sources.push(prepared.sources[32]!);
    expect(() => businessBenchmarkSourcePins(legacy)).toThrow("business_benchmark_sources_invalid");
    const missing = input("order_review"); delete missing.benchmarkResources;
    expect(() => businessBenchmarkSourcePins(missing)).toThrow();
    const parsed = item(input("order_review"));
    const pin = parsed.sourcePins[0]!;
    if (!("kind" in pin)) throw new Error("Synthetic typed role pin required");
    const unbound = Object.fromEntries(Object.entries(pin).filter(([key]) => key !== "resourceBindings"));
    expect(BenchmarkItemSchema.safeParse({ ...parsed, sourcePins: [unbound] }).success).toBe(false);
  });

  it("never fabricates creative directions to make an extractive rule baseline pass the unchanged native creative contract", () => {
    const prepared = input("creative"), baseline = runRoleBenchmarkBaseline(prepared);
    expect(baseline.directions).toEqual([]); expect(baseline.actions).toEqual([]);
    expect(gradeRoleBenchmark(fields(prepared), baseline, prepared, []).hardPass).toBe(false);
    expect(JSON.stringify(baseline)).not.toContain("已生成三个原创方向");
  });

  it("does not claim visual inspection of fixed data URLs and hard-fails evidence from an unavailable or foreign image", () => {
    const prepared = input("artwork_preflight"), image = "production-preview";
    prepared.images = [{ sourceId: image, dataUrl: "data:image/jpeg;base64,U3ludGhldGljLWZyb3plbi1pbWFnZQ==" }];
    prepared.sources.push({ id: image, label: "Synthetic fixed preview", href: null });
    const baseline = runRoleBenchmarkBaseline(prepared);
    expect(baseline.missingInformation.join(" ")).toMatch(/图|视觉|像素|image|visual/i);
    expect(baseline.findings.some(finding => finding.kind === "fact" && finding.evidence.some(e => e.sourceId === image))).toBe(false);
    const result = LegacyAssistResultSchema.parse({ summary: "Synthetic explicit image-dependent claim", directions: [], matches: [],
      findings: [{ title: "Original pixel", detail: "Synthetic image claim", kind: "fact", severity: "info", location: null,
        evidence: [{ sourceId: image, detail: "Exact supplied image" }] }], missingInformation: ["需要人工视觉核对"] });
    expect(gradeRoleBenchmark(fields(prepared), result, prepared, [image]).hardPass).toBe(true);
    expect(gradeRoleBenchmark(fields(prepared), result, prepared, []).hardPass).toBe(false);
    result.findings[0]!.evidence[0]!.sourceId = "foreign-image";
    expect(gradeRoleBenchmark(fields(prepared), result, prepared, [image]).hardPass).toBe(false);
  });

  it("binds every frozen image byte and typed object pin to the task and original business basis", () => {
    const prepared = input("order_review"); prepared.images = [{ sourceId: "buyer-image:0", dataUrl: "data:image/jpeg;base64,YQ==" }];
    const original = fields(prepared), fingerprint = businessBenchmarkBasisFingerprint(original, prepared);
    const image = structuredClone(prepared); image.images[0]!.dataUrl = "data:image/jpeg;base64,Yg==";
    expect(assistTaskFingerprint(image)).not.toBe(assistTaskFingerprint(prepared));
    expect(businessBenchmarkBasisFingerprint(original, image)).not.toBe(fingerprint);
    const resource = structuredClone(prepared); resource.benchmarkResources!.items[0]!.id = id(80);
    expect(assistTaskFingerprint(resource)).not.toBe(assistTaskFingerprint(prepared));
    expect(businessBenchmarkSourcePins(resource)).not.toEqual(businessBenchmarkSourcePins(prepared));
  });

  it("rejects foreign template slots and listing images while preserving valid original slot and available-image controls", () => {
    const template = input("template_config"), baseline = runRoleBenchmarkBaseline(template);
    const slot = { stableKey: "image.customer", name: "Original image", kind: "image", fillMode: "contain", replaceable: true,
      fieldKey: "photo", reuseLabel: null, reason: "Synthetic original parsed slot", evidence: [{ sourceId: id(3), detail: "Original parse" }] };
    const valid = LegacyAssistResultSchema.parse({ ...baseline, templateSlots: [slot] });
    expect(gradeRoleBenchmark(fields(template), valid, template, []).hardPass).toBe(true);
    valid.templateSlots[0]!.stableKey = "foreign.slot";
    expect(gradeRoleBenchmark(fields(template), valid, template, []).hardPass).toBe(false);
    const sku = input("sku_package"), imageId = id(81);
    sku.listingMediaIds = [imageId]; sku.images = [{ sourceId: imageId, dataUrl: "data:image/jpeg;base64,YQ==" }];
    sku.sources.push({ id: imageId, label: "Original approved mockup", href: null });
    const copy = LegacyAssistResultSchema.parse({ summary: "Original SKU facts", findings: [], directions: [], matches: [], missingInformation: ["视觉效果需要人工核对"],
      listingCopy: { title: "Synthetic original product", description: "Synthetic original product", bullets: [], tags: [], personalizationInstructions: "",
        imageDescriptions: [{ assetId: imageId, text: "Synthetic supplied mockup", evidence: [{ sourceId: imageId, detail: "Original approved mockup" }] }],
        evidence: [{ sourceId: id(3), detail: "Original listing" }] } });
    expect(gradeRoleBenchmark(fields(sku), copy, sku, [imageId]).hardPass).toBe(true);
    copy.listingCopy!.imageDescriptions[0]!.assetId = id(82);
    expect(gradeRoleBenchmark(fields(sku), copy, sku, [imageId]).hardPass).toBe(false);
  });

  it("preserves source gaps and explicit refusal instead of upgrading incomplete sources into approval", () => {
    const prepared = input("after_sales_review"); prepared.checks = [{ code: "case_evidence_missing", severity: "manual", message: "缺少原责任证据 不能确认责任", location: null }];
    const baseline = runRoleBenchmarkBaseline(prepared), expected = fields(prepared, { expectRefusal: true });
    expect(baseline.missingInformation.join(" ")).toContain("case_evidence_missing");
    expect(gradeRoleBenchmark(expected, baseline, prepared, []).hardPass).toBe(true);
    baseline.missingInformation = []; baseline.summary = "AUTOMATICALLY APPROVED FOR PRODUCTION";
    expect(gradeRoleBenchmark(expected, baseline, prepared, []).hardPass).toBe(false);
  });

  it("keeps complete bounded source sections and rejects oversized original packets rather than silently truncating", () => {
    const prepared = input(); prepared.data.longSection = "中文原固定证据".repeat(550) + "ORIGINAL-TAIL";
    const result = runRoleBenchmarkBaseline(prepared);
    expect(result.findings.filter(row => row.location === "longSection").map(row => row.detail).join("")).toBe(JSON.stringify(prepared.data.longSection));
    prepared.data.longSection = "x".repeat(100_001);
    expect(() => runRoleBenchmarkBaseline(prepared)).toThrow();
  });

  it("rejects grader gold in baseline data and leaves original v1 fingerprints and outputs unchanged", () => {
    for (const key of ["expectedFacts", "forbiddenClaims", "expectedValue", "expectRefusal", "evaluation", "benchmarkCalculations"]) {
      const contaminated = input(); contaminated.data[key] = "Synthetic hidden grader answer";
      expect(() => runRoleBenchmarkBaseline(contaminated)).toThrow();
    }
    const legacy = input("procurement_review"); delete legacy.benchmarkResources;
    const original = structuredClone(legacy), baseline = runBusinessBenchmarkBaseline(legacy), pins = businessBenchmarkSourcePins(legacy);
    expect(legacy).toEqual(original); expect(baseline.typedAnswers).toBeUndefined();
    expect(pins[0]).not.toHaveProperty("resourceBindings");
    const transport = structuredClone(legacy); transport.request.modelId = id(83); transport.request.requestId = id(84);
    expect(businessBenchmarkBasisFingerprint(fields(legacy), transport)).toBe(businessBenchmarkBasisFingerprint(fields(legacy), legacy));
    expect(runBusinessBenchmarkBaseline(transport)).toEqual(baseline);
  });
});
