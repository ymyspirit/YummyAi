import { describe, expect, it } from "vitest";
import { createEntityId } from "../common/ids.js";
import { FactoryPortalSessionViewSchema, FactoryQuantityBasisSchema, FactoryQuantityHistoryQuerySchema,
  FactoryQuantityReportInputSchema, FactoryQuantityReportResultSchema, FactoryQuantityWorkspaceSchema } from "./factory-quantity.js";

const assignmentId = createEntityId(), otherAssignmentId = createEntityId(), reportId = createEntityId(), acceptedId = createEntityId();
const pin = "a".repeat(64), at = "2026-10-21T01:02:03.100Z";
const quantities = { unstartedQuantity: 4, inProcessQuantity: 2, completedQuantity: 3, scrappedQuantity: 1 };
const input = () => ({ idempotencyKey: "e9726631-a40e-4ac3-8e16-5e8201cc2151", fileChecksum: pin, manufacturingChecksum: pin,
  acceptedFeedbackId: acceptedId, expectedBasisFingerprint: pin, wholeProductionConfirmed: true as const,
  observedAt: at, quantities: { ...quantities }, evidenceCode: "SYNTHETIC_FACTORY_COUNT", reference: "Synthetic counted all ten pieces" });
const basis = () => ({ scope: "full_production_version" as const, quantity: 10, unit: "each" as const, versionNumber: 1,
  fileChecksum: pin, manufacturingChecksum: pin, acceptedFeedbackId: acceptedId, stoppedQuantity: 0, approvedQuantities: null,
  fingerprint: pin, blockers: [] as string[] });
const report = () => ({ reportId, assignmentId, origin: "factory" as const, scope: "full_production_version" as const, input: input(), recordedAt: at });
const workspace = () => ({ assignmentId, contextAuthority: pin, taskFingerprint: pin, access: { canRead: true as const, canReport: true },
  basis: basis(), reports: [{ ...report(), reviewedAt: null }], nextCursor: null });

describe("first-person factory quantities without internal production authority", () => {
  it("preserves all four physical buckets including zero and unknown without adding approval authority", () => {
    expect(FactoryQuantityReportInputSchema.parse(input()).quantities).toEqual(quantities);
    const unknown = { ...input(), quantities: { unstartedQuantity: 0, inProcessQuantity: null, completedQuantity: null, scrappedQuantity: 0 } };
    expect(FactoryQuantityReportInputSchema.parse(unknown).quantities).toEqual(unknown.quantities);
    expect(FactoryQuantityWorkspaceSchema.parse(workspace()).basis.approvedQuantities).toBeNull();
  });
  it.each([-1, 0.5, 100001, Number.MAX_SAFE_INTEGER + 1, "1"])("rejects non-count value %s without rounding", count => {
    expect(FactoryQuantityReportInputSchema.safeParse({ ...input(), quantities: { ...quantities, completedQuantity: count } }).success).toBe(false);
  });
  it("requires an explicit whole-version count and the accepted file, manufacturing and basis pins", () => {
    expect(FactoryQuantityReportInputSchema.safeParse({ ...input(), wholeProductionConfirmed: false }).success).toBe(false);
    for (const field of ["fileChecksum", "manufacturingChecksum", "expectedBasisFingerprint", "acceptedFeedbackId"] as const)
      expect(FactoryQuantityReportInputSchema.safeParse({ ...input(), [field]: "unverified" }).success, field).toBe(false);
  });
  it("rejects injected operator identifiers, stop deltas and audit actors in a factory input", () => {
    for (const field of ["productionOrderId", "createdBy", "reportId", "stoppedDelta", "evidenceAssetIds", "expectedProductionProjectionVersion"])
      expect(FactoryQuantityReportInputSchema.safeParse({ ...input(), [field]: createEntityId() }).success, field).toBe(false);
  });
  it("binds immutable factory receipt and history to the actually authorized assignment", () => {
    const value = { assignmentId, contextAuthority: pin, taskFingerprint: pin, access: { canRead: true, canReport: true }, report: report(), replayed: false };
    expect(FactoryQuantityReportResultSchema.safeParse(value).success).toBe(true);
    expect(FactoryQuantityReportResultSchema.safeParse({ ...value, report: { ...value.report, assignmentId: otherAssignmentId } }).success).toBe(false);
    expect(FactoryQuantityWorkspaceSchema.safeParse({ ...workspace(), reports: [{ ...report(), assignmentId: otherAssignmentId, reviewedAt: null }] }).success).toBe(false);
  });
  it.each(["acceptedFeedbackId", "manufacturingChecksum", "unit", "blockers"] as const)("does not advertise reporting with missing %s", field => {
    const value = workspace();
    expect(FactoryQuantityWorkspaceSchema.safeParse(value).success).toBe(true);
    const changed = { ...value, basis: { ...value.basis, [field]: field === "blockers" ? ["Source unavailable"] : null } };
    expect(FactoryQuantityWorkspaceSchema.safeParse(changed).success).toBe(false);
    expect(FactoryQuantityWorkspaceSchema.safeParse({ ...changed, access: { canRead: true, canReport: false } }).success).toBe(true);
  });
  it("keeps original quantity, approved physical counts and stopped quantity conserved", () => {
    expect(FactoryQuantityBasisSchema.safeParse({ ...basis(), stoppedQuantity: 2, approvedQuantities: { ...quantities, unstartedQuantity: 2 } }).success).toBe(true);
    expect(FactoryQuantityBasisSchema.safeParse({ ...basis(), stoppedQuantity: 2, approvedQuantities: quantities }).success).toBe(false);
    expect(FactoryQuantityBasisSchema.safeParse({ ...basis(), stoppedQuantity: 11 }).success).toBe(false);
  });
  it("keeps factory sessions opaque and cannot advertise Respond without Read", () => {
    expect(FactoryPortalSessionViewSchema.safeParse({ authenticated: true, contextAuthority: pin, canRead: true, canRespond: false }).success).toBe(true);
    expect(FactoryPortalSessionViewSchema.safeParse({ authenticated: true, contextAuthority: pin, canRead: false, canRespond: true }).success).toBe(false);
    expect(FactoryPortalSessionViewSchema.safeParse({ authenticated: true, contextAuthority: "{}", canRead: true, canRespond: true }).success).toBe(false);
  });
  it("accepts only a bounded explicit history cursor and no caller-selected production scope", () => {
    expect(FactoryQuantityHistoryQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(FactoryQuantityHistoryQuerySchema.parse({ before: reportId, limit: "50" })).toEqual({ before: reportId, limit: 50 });
    for (const value of [{ limit: 0 }, { limit: 51 }, { before: "unknown" }, { productionOrderId: createEntityId() }])
      expect(FactoryQuantityHistoryQuerySchema.safeParse(value).success).toBe(false);
  });
});
