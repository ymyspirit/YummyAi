import { describe, expect, it } from "vitest";
import { createEntityId } from "../common/ids.js";
import { erpSessionAuthority } from "../auth/session.js";
import { ShipmentCreateWorkspaceSchema, type ShipmentCreateWorkspace } from "./shipment.js";

function originalBasis(): ShipmentCreateWorkspace {
  const lineId = createEntityId();
  return { orderId: createEntityId(), orderNumber: "SYNTHETIC-CONTRACT-ONLY", orderSequence: 7,
    contextAuthority: erpSessionAuthority({ tenantId: createEntityId(), userId: createEntityId(), permissions: [], dataScope: "tenant" }),
    lines: [{ lineId, title: "Synthetic original line", quantity: 5 }],
    sources: [{ orderLineId: lineId, productionOrderId: createEntityId(), productionVersionId: createEntityId(),
      versionNumber: 1, projectionVersion: 6, source: "initial", status: "completed", quantity: 3,
      qualityInspectionId: createEntityId(), qualityGroupId: createEntityId(), groupLabel: "Original passed group",
      inspectedAt: "2026-10-23T00:00:00.000Z", allocatedQuantity: 0, availableQuantity: 3, blockers: [] }],
    canCreate: true, blockers: [] };
}

describe("complete original partial shipment workspace contract", () => {
  it("accepts a partial qualified group without asserting all ordered quantity is ready", () => {
    const basis = originalBasis(), actual = ShipmentCreateWorkspaceSchema.parse(basis);
    expect(actual.lines[0]?.quantity).toBe(5); expect(actual.sources[0]?.availableQuantity).toBe(3);
    expect(actual.canCreate).toBe(true); expect(actual.sources[0]?.projectionVersion).toBe(6);
  });
  it("rejects foreign lines duplicate lines and duplicate physical sources", () => {
    const basis = originalBasis(), source = basis.sources[0]; if (!source) throw new Error("synthetic_source_missing");
    for (const invalid of [{ ...basis, sources: [{ ...source, orderLineId: createEntityId() }] },
      { ...basis, lines: [...basis.lines, ...basis.lines] }, { ...basis, sources: [source, { ...source }] }])
      expect(ShipmentCreateWorkspaceSchema.safeParse(invalid).success).toBe(false);
  });
  it("bounds the complete transport at 100 lines and 1000 unique sources without silently truncating", () => {
    const basis = originalBasis(), source = basis.sources[0]; if (!source) throw new Error("synthetic_source_missing");
    const lines = Array.from({ length: 100 }, (_, index) => ({ lineId: index ? createEntityId() : source.orderLineId, title: `Synthetic ${index}`, quantity: 5 }));
    const sources = Array.from({ length: 1000 }, () => ({ ...source, qualityGroupId: createEntityId() }));
    expect(ShipmentCreateWorkspaceSchema.safeParse({ ...basis, lines, sources }).success).toBe(true);
    expect(ShipmentCreateWorkspaceSchema.safeParse({ ...basis, lines: [...lines, { lineId: createEntityId(), title: "Extra", quantity: 1 }], sources }).success).toBe(false);
    expect(ShipmentCreateWorkspaceSchema.safeParse({ ...basis, lines, sources: [...sources, { ...source, qualityGroupId: createEntityId() }] }).success).toBe(false);
    expect(ShipmentCreateWorkspaceSchema.safeParse({ ...basis, lines: [] }).success).toBe(false);
  });
  it("rejects unknown fields malformed authority and a positive create flag with blockers", () => {
    const basis = originalBasis();
    for (const invalid of [{ ...basis, readiness: true }, { ...basis, contextAuthority: "synthetic-invalid-authority" },
      { ...basis, blockers: ["Original source unavailable"] }, { ...basis, lines: [{ ...basis.lines[0], privateKey: "synthetic-extra" }] }])
      expect(ShipmentCreateWorkspaceSchema.safeParse(invalid).success).toBe(false);
    expect(ShipmentCreateWorkspaceSchema.safeParse({ ...basis, canCreate: false, sources: [], blockers: ["No source"] }).success).toBe(true);
  });
});
