import { describe, expect, it } from "vitest";
import { evaluateQualityGroups, RecordQualityGroupsInputSchema, type QualityPhysicalGroupInput } from "./quality-groups.js";
const standard = { minimumScoreBps: 8000, criteria: [{ code: "APPEARANCE", label: "外观", weightBps: 10000, blocking: true }] };
const defect = (code: string) => ({ code, severity: "major" as const, responsibility: "supplier" as const, disposition: "remake" as const, note: "实际检查缺陷", evidenceAssetIds: [] });
const group = (key: string, quantity: number, codes: string[]): QualityPhysicalGroupInput => ({ key, label: "隔离框" + key, quantity,
  criterionResults: [{ code: "APPEARANCE", scoreBps: codes.length ? 9000 : 10000, passed: !codes.length, evidenceAssetIds: [] }], defects: codes.map(defect) });
describe("physical quality group quantities", () => {
  it("counts disjoint held pieces once while defects independently overlap", () => {
    const result = evaluateQualityGroups(standard, [group("A", 2, []), group("B", 2, ["COLOR"]), group("C", 1, ["COLOR", "STITCH"])], 5);
    expect(result.problems).toEqual([]); expect(result.passedQuantity).toBe(2); expect(result.heldQuantity).toBe(3);
    expect(result.defectQuantities).toEqual([{ code: "COLOR", affectedQuantity: 3 }, { code: "STITCH", affectedQuantity: 1 }]);
    expect(result.scoreBps).toBe(9400); expect(result.result).toBe("failed");
  });
  it("rejects incomplete coverage and failed groups without disposition evidence", () => {
    const unrecorded = group("B", 1, []); unrecorded.criterionResults[0]!.passed = false;
    const result = evaluateQualityGroups(standard, [group("A", 2, []), unrecorded], 4);
    expect(result.problems).toContain("分组数量之和必须完整覆盖原生产数量或所选原组数量");
    expect(result.problems.some(problem => problem.includes("必须登记"))).toBe(true); expect(result.result).toBeNull();
  });
  it("requires physical confirmation and distinct group labels and defect codes", () => {
    const id = "019c0000-0000-7000-8000-000000000001";
    const base = { formatVersion: 3, productionVersionId: id, expectedProductionProjectionVersion: 1, expectedRootInspectionId: null,
      qualityStandardVersionId: id, inspectedAt: "2026-10-19T00:00:00.000Z", segregationConfirmed: true,
      groups: [group("A", 1, []), group("B", 1, ["COLOR"])], idempotencyKey: "group-test-key" };
    expect(RecordQualityGroupsInputSchema.safeParse(base).success).toBe(true);
    expect(RecordQualityGroupsInputSchema.safeParse({ ...base, segregationConfirmed: false }).success).toBe(false);
    expect(RecordQualityGroupsInputSchema.safeParse({ ...base, groups: [group("A", 1, []), { ...group("B", 1, []), label: "隔离框Ａ" }] }).success).toBe(false);
    expect(RecordQualityGroupsInputSchema.safeParse({ ...base, groups: [{ ...group("A", 1, ["COLOR"]), defects: [defect("COLOR"), defect("COLOR")] }] }).success).toBe(false);
  });
});
