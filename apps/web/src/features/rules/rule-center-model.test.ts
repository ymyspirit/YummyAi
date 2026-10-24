import { describe, expect, it } from "vitest";
import { INITIAL_RULES, canEditRuleText, type RuleRow, type RuleWorkspace } from "@yummyai/contracts/rules";
import { newRuleForView, ruleInView } from "./rule-center-model";

function rule(code: string, patch = {}): RuleRow {
  const definition = INITIAL_RULES.find(item => item.code === code)!;
  const version = { ...definition, ...patch, id: "v1", ruleId: code, version: 1, createdAt: "", changeReason: "", execution: "manual", executionLocation: "" } as RuleRow["latest"];
  return { id: code, code: "system:" + code, revision: 1, latestVersion: 1, activeVersion: 1, builtIn: true, updatedAt: "", latest: version, active: version };
}
const workspace = { spus: [
  { id: "pillow-spu", name: "Pillow", code: "P", productTypes: ["shaped_pillow"] },
  { id: "tire-spu", name: "Tire", code: "T", productTypes: ["tire_cover"] },
  { id: "new-spu", name: "New product", code: "N", productTypes: [] },
] } as RuleWorkspace;
describe("business rule directories", () => {
  it("inherits only matching type and global production requirements, keeping daily tasks separate", () => {
    const factory = rule("pillow-factory"), original = rule("original-assets"), cleanup = rule("test-cleanup");
    expect(ruleInView(factory, "spu:pillow-spu", workspace)).toBe(true);
    expect(ruleInView(factory, "spu:tire-spu", workspace)).toBe(false);
    expect(ruleInView(factory, "spu:new-spu", workspace)).toBe(false);
    expect(ruleInView(original, "spu:new-spu", workspace)).toBe(true);
    expect(ruleInView(cleanup, "shaped_pillow", workspace)).toBe(false);
    expect(ruleInView(cleanup, "operations", workspace)).toBe(true);
    const custom = rule("pillow-contour", { scopeKind: "spu", productType: null, spuId: "new-spu" });
    expect(ruleInView(custom, "spu:new-spu", workspace)).toBe(true);
    expect(ruleInView(custom, "spu:pillow-spu", workspace)).toBe(false);
  });
  it("keeps an active rule discoverable while a draft moves to a different scope", () => {
    const row = rule("pillow-contour");
    row.latest = { ...row.latest, scopeKind: "spu", productType: null, spuId: "new-spu", version: 2 };
    expect(ruleInView(row, "shaped_pillow", workspace)).toBe(true);
    expect(ruleInView(row, "spu:new-spu", workspace)).toBe(true);
    expect(ruleInView(row, "spu:tire-spu", workspace)).toBe(false);
  });
  it("prefills a new product's scope without assigning pillow requirements", () => {
    expect(newRuleForView("spu:new-spu")).toMatchObject({ scopeKind: "spu", spuId: "new-spu", productType: null });
    expect(newRuleForView("operations")).toMatchObject({ appliesTo: "operations", scopeKind: "all" });
    expect(canEditRuleText(rule("pillow-contour"))).toBe(true);
    expect(canEditRuleText(rule("pillow-factory"))).toBe(false);
    expect(canEditRuleText(rule("super-resolution"))).toBe(false);
  });
});
