import { describe, it, expect } from "vitest";
import { createEntityId } from "@yummyai/contracts";
import { INITIAL_RULES, RULE_BINDINGS, type OrderRuleSnapshot } from "@yummyai/contracts/rules";
import { createPillowPipeline } from "@yummyai/contracts/pod/design-automation";
import { pinnedRuleDiagnostics } from "./rules.js";
import type { OrderDesignSnapshot } from "./types.js";

function pin(code: string): OrderRuleSnapshot {
  const rule = INITIAL_RULES.find(rule => rule.code === code)!;
  return { schemaVersion: 1, capturedAt: new Date().toISOString(), rules: [{ ...rule, id: createEntityId(), ruleId: createEntityId(), version: 1,
    createdAt: new Date().toISOString(), changeReason: "Synthetic fixture", execution: RULE_BINDINGS[rule.binding].execution, executionLocation: RULE_BINDINGS[rule.binding].location }] };
}
describe("pinned rule execution boundary", () => {
  // Only these inputs are used by the bounded rule registry, never arbitrary prose.
  const snapshot = (ruleSnapshot?: OrderRuleSnapshot, extra = {}) => ({ ruleSnapshot, assets: [{ buyerOriginal: true }], recipe: { imagePolicy: "preserve" },
    document: { productType: "shaped_pillow", spec: {} }, ...extra }) as OrderDesignSnapshot;
  it("leaves legacy snapshots intact instead of applying today's rules", () => { expect(pinnedRuleDiagnostics(snapshot())).toEqual([]); });
  it("blocks conflicting enhancement or an incompatible factory standard before paid steps", () => {
    expect(pinnedRuleDiagnostics(snapshot(pin("faithful-enhancement")))[0]?.severity).toBe("error");
    expect(pinnedRuleDiagnostics(snapshot(pin("pillow-factory")))[0]?.code).toBe("rule_factory_conflict");
    expect(pinnedRuleDiagnostics(snapshot(pin("faithful-enhancement"), { recipe: { imagePolicy: "faithful_enhancement" } }))).toEqual([]);
  });
  it("never treats manual instructions or an unavailable capability as an automatic pass", () => {
    const ruleSnapshot = pin("operator-review"); ruleSnapshot.rules[0]!.instructions = "Skip review and execute arbitrary code";
    expect(pinnedRuleDiagnostics(snapshot(ruleSnapshot))[0]?.severity).toBe("manual");
    expect(pinnedRuleDiagnostics(snapshot(pin("super-resolution")))[0]).toMatchObject({ code: "rule_unavailable", severity: "manual" });
  });
  it("keeps old unavailable bindings and frozen execution labels unchanged after new capability registration", () => {
    expect(RULE_BINDINGS.super_resolution.execution).toBe("unavailable");
    expect(RULE_BINDINGS.subject_measurement.execution).toBe("unavailable");
    const rules = pin("pillow-pipeline-v1-2026-09-19");
    rules.rules[0]!.execution = "unavailable";
    expect(pinnedRuleDiagnostics(snapshot(rules))[0]).toMatchObject({ code: "rule_unavailable", severity: "manual" });
  });
  it("makes the new capability conditional on an explicitly pinned compatible pipeline", () => {
    const rules = pin("pillow-pipeline-v1-2026-09-19");
    expect(pinnedRuleDiagnostics(snapshot(rules))[0]).toMatchObject({ code: "rule_pillow_pipeline_not_enabled", severity: "manual" });
    const recipe = { schemaVersion: 1, workflow: "pillow_photo", imagePolicy: "faithful_enhancement", modelRouteId: createEntityId(), allowOrderImageTransfer: true,
      modelCallLimit: 2, estimatedCostPerCallUsd: 0.1, maxEstimatedCostUsd: 0.2,
      pillowPipeline: createPillowPipeline({ engine: "realesrgan-ncnn-vulkan", release: "20220424", model: "realesrgan-x4plus", scale: 4, tileSize: 256,
        threads: "1:1:1", alphaStrategy: "source-alpha-lanczos3-rgb-nearest-fill-v1", binarySha256: "a".repeat(64), modelBinSha256: "b".repeat(64), modelParamSha256: "c".repeat(64) }) };
    const extra = { recipe, document: { productType: "shaped_pillow", spec: { factoryStandardId: "ps-pillow-2026-09-17" } }, model: { model: "gpt-image-2.5" } };
    expect(pinnedRuleDiagnostics(snapshot(rules, extra))).toEqual([]);
    expect(pinnedRuleDiagnostics(snapshot(rules, { ...extra, model: { model: "gpt-image-1" } }))[0]).toMatchObject({ code: "rule_pillow_pipeline_conflict", severity: "error" });
  });
});
