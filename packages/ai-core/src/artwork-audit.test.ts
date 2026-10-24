import { describe, expect, it } from "vitest";
import { ARTWORK_AUDIT_POLICY, ArtworkAuditCodeSchema, applyArtworkAudit, type ArtworkAuditBasis } from "@yummyai/contracts/ai/artwork-audit";
import { AssistResultSchema } from "@yummyai/contracts/ai/assist";
import { artworkAuditReport } from "./artwork-audit.js";
import { validateAssistResult, type AssistContext } from "./assist.js";
const id = (n: number) => `019f0000-0000-7000-8000-${n.toString().padStart(12, "0")}`;
function fixture() {
  const basis: ArtworkAuditBasis = {policy: ARTWORK_AUDIT_POLICY, orderLineId: id(1), revision: 1, projectId: id(2), versionId: id(3), versionNumber: 1, documentHash: "a".repeat(64), sourceVersionId: id(4), factoryStandardId: "ps-pillow-2026-09-17", ruleBasis: "Fixture",
    checks: ArtworkAuditCodeSchema.options.map(code => ({code, title: code, status: code === "visualReview" || code === "backText" ? "needs_review" : "passed", method: code === "visualReview" || code === "backText" ? "vision" : "measurement", detail: "Synthetic evidence", action: "", evidence: [], marks: []}))};
  const imageIds = ["production-preview", "buyer-image:0"];
  const input: AssistContext = {request: {kind: "artwork_preflight", automaticAudit: true, orderLineId: id(1), expectedRevision: 1, expectedEditorVersionId: id(3), modelId: id(5), requestId: id(6)}, data: {}, sources: imageIds.map(id => ({id, label: id, href: null})), checks: [], diagnostics: [], images: imageIds.map(sourceId => ({sourceId, dataUrl: "fixture"})), allowedArtworkIds: [], allowedSpecificationIds: [], allowMatches: false, artworkAudit: basis};
  const result = AssistResultSchema.parse({summary: "Synthetic", findings: [], directions: [], matches: [], missingInformation: [], artworkChecks: ["visualReview","backText","narrowParts"].map(code => ({code, status: "passed", detail: "已对照合成图片", action: "", evidence: imageIds.map(sourceId => ({sourceId, detail: "Synthetic observation"})), marks: []}))});
  return {input, result, imageIds};
}
describe("evidence-backed artwork review", () => {
  it("clears exactly the six manual gates while preserving hard errors", () => {
    const {input, result, imageIds} = fixture();
    const report = artworkAuditReport(input, validateAssistResult(result, input, imageIds), imageIds, true)!;
    expect(report.checks.every(c => c.status === "passed")).toBe(true);
    const manual = ["physical_size_unconfirmed", "visual_review_required", "narrow_parts_unconfirmed", "white_border_unconfirmed", "barcode_rule_unconfirmed", "back_text_unconfirmed"].map(code => ({code, severity: "manual" as const, message: "Unconfirmed"}));
    expect(applyArtworkAudit({productionReady: false, widthPx: 1, heightPx: 1, issues: manual}, report).productionReady).toBe(true);
    const bad = applyArtworkAudit({productionReady: false, widthPx: 1, heightPx: 1, issues: [...manual, {code: "insufficient_image_resolution", severity: "error", message: "Too small"}]}, report);
    expect(bad.productionReady).toBe(false); expect(bad.issues.map(i => i.code)).toEqual(["insufficient_image_resolution"]);
  });
  it("cannot override a measured failure or missing factory/customer facts", () => {
    const {input, result, imageIds} = fixture();
    Object.assign(input.artworkAudit!.checks.find(c => c.code === "narrowParts")!, {status: "failed"});
    Object.assign(input.artworkAudit!.checks.find(c => c.code === "backText")!, {method: "factory"});
    const checks = artworkAuditReport(input, result, imageIds, true)!.checks;
    expect(checks.find(c => c.code === "narrowParts")?.status).toBe("failed");
    expect(checks.find(c => c.code === "backText")?.status).toBe("needs_review");
  });
  it.each(["missing", "partial", "duplicate", "contradiction"])("fails closed for %s evidence", reason => {
    const {input, result, imageIds} = fixture();
    if (reason === "missing") imageIds.pop();
    if (reason === "partial") input.diagnostics.push("One buyer image could not be read");
    if (reason === "duplicate") result.artworkChecks[1] = result.artworkChecks[0]!;
    if (reason === "contradiction") result.findings.push({title: "Back text unreadable", detail: "Must be checked", severity: "error", kind: "fact", evidence: [], location: null});
    expect(artworkAuditReport(input, result, imageIds, true)!.checks.every(c => c.status === "passed")).toBe(false);
  });
  it("does not treat a running or failed attempt as permission to submit", () => {
    const {input} = fixture();
    const report = artworkAuditReport(input, null, [], false)!;
    expect(applyArtworkAudit({productionReady: true, widthPx: 1, heightPx: 1, issues: []}, report).productionReady).toBe(false);
  });
  it("keeps physical-sample limitations separate from evidenced digital-file checks", () => {
    const {input, result, imageIds} = fixture();
    result.missingInformation.push("No sewn physical sample was supplied");
    expect(artworkAuditReport(input, result, imageIds, true)!.checks.every(c => c.status === "passed")).toBe(true);
  });
  it("rejects nonexistent image annotations and missing visual checks", () => {
    const {input, result, imageIds} = fixture();
    result.artworkChecks[0]!.marks.push({sourceId: "invented", label: "bad", x: 0, y: 0, width: .1, height: .1});
    expect(() => validateAssistResult(result, input, imageIds)).toThrow("assist_invalid_evidence");
    result.artworkChecks = [];
    expect(() => validateAssistResult(result, input, imageIds)).toThrow("assist_invalid_artwork_checks");
  });
});
