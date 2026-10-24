import { describe, expect, it } from "vitest";
import { QualityAssessmentSchema, evaluateQualityAssessment } from "./quality-assessment.js";

const standard = {
  minimumScoreBps: 8000,
  criteria: [
    { code: "GEOMETRY", label: "尺寸与工艺", weightBps: 1000, blocking: true },
    { code: "APPEARANCE", label: "外观", weightBps: 9000, blocking: false },
  ],
};
const checks = (blocking = true) => [
  { code: "GEOMETRY", scoreBps: 9000, passed: blocking },
  { code: "APPEARANCE", scoreBps: 9500, passed: true },
];
describe("versioned criterion-level quality evidence", () => {
  it("computes the weighted score and refuses an offset failed blocking check", () => {
    expect(evaluateQualityAssessment(standard, checks())).toMatchObject({ scoreBps: 9450, result: "passed", problems: [] });
    expect(evaluateQualityAssessment(standard, checks(false))).toMatchObject({ scoreBps: 9450, result: "failed", failedBlockingCodes: ["GEOMETRY"] });
  });
  it("requires an exact complete project set without inventing unknown outcomes", () => {
    expect(evaluateQualityAssessment(standard, checks().slice(1)).problems).toContain("尚未核验：尺寸与工艺");
    expect(evaluateQualityAssessment(standard, [...checks(), { code: "FOREIGN", scoreBps: 10_000, passed: true }]).problems).toContain("项目不属于所选标准：FOREIGN");
    expect(QualityAssessmentSchema.safeParse({ formatVersion: 2, criterionResults: [{ code: "GEOMETRY", scoreBps: 10_000 }] }).success).toBe(false);
    expect(evaluateQualityAssessment(standard, [checks()[0], checks()[0]]).problems).not.toHaveLength(0);
  });
  it("holds unresolved dispositions and critical defects while allowing an explicitly accepted minor issue", () => {
    expect(evaluateQualityAssessment(standard, checks(), [{ severity: "major", disposition: "remake" }]).result).toBe("failed");
    expect(evaluateQualityAssessment(standard, checks(), [{ severity: "critical", disposition: "accept" }]).result).toBe("failed");
    expect(evaluateQualityAssessment(standard, checks(), [{ severity: "minor", disposition: "accept" }]).result).toBe("passed");
  });
  it("uses bounded basis-point rounding and rejects malformed pinned weights", () => {
    const equal = { minimumScoreBps: 5001, criteria: standard.criteria.map(criterion => ({ ...criterion, weightBps: 5000 })) };
    expect(evaluateQualityAssessment(equal, [{ code: "GEOMETRY", scoreBps: 5000, passed: true }, { code: "APPEARANCE", scoreBps: 5001, passed: true }])).toMatchObject({ scoreBps: 5001, result: "passed" });
    expect(evaluateQualityAssessment({ ...standard, criteria: [] }, checks()).problems).not.toHaveLength(0);
  });
});
