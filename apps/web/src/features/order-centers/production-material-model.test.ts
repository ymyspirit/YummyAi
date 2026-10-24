import { describe, expect, it } from "vitest";
import type { ProductionMaterialsWorkspace } from "@yummyai/contracts/order/material-execution";
import { buildMaterialInput, emptyMaterialDraft, plannedMaterialLabel } from "./production-material-model";
const id = "019f0000-0000-7000-8000-000000000001", binding = "019f0000-0000-7000-8000-000000000002", location = "019f0000-0000-7000-8000-000000000003";
const workspace: ProductionMaterialsWorkspace = { productionOrderId: id, bindingId: binding, sourceContentChecksum: "a".repeat(64), productionRevision: 1, productionStatus: "planned", currentBinding: true, canWrite: true, contextAuthority: "synthetic", diagnostics: [], nextCursor: null, entries: [],
  lines: [{ code: "FABRIC", name: "Synthetic fabric", stockItemId: id, unit: "meter", responsibility: "merchant", plannedNumerator: "1", plannedDenominator: "3", actualNetQuantity: 0, outstandingReservedQuantity: 0, actualSource: "merchant_inventory" }] };
const stock = { dimensionKey: `${id}:${location}:-`, stockItemId: id, locationId: location, locationName: "Synthetic bin", warehouseName: "Synthetic warehouse", unit: "meter" as const, lotId: null, lotCode: null, availableQuantity: "0.2", physicalQuantity: 2, reservedQuantity: "1.8", expiresAt: null };
const draft = { ...emptyMaterialDraft(), quantity: "0.123456789", dimension: stock.dimensionKey, occurredAt: "2026-10-20T09:00", confirmed: true };
describe("material operator decisions", () => {
  it("preserves nine decimal places and keeps a non-terminating original plan as a fraction", () => {
    expect(buildMaterialInput(workspace, { kind: "consume", materialCode: "FABRIC" }, draft, [stock], [], "synthetic-key")).toMatchObject({ quantity: "0.123456789", actualConfirmed: true });
    expect(plannedMaterialLabel("1", "3", "meter")).toContain("1 / 3");
  });
  it("requires actual confirmation and cannot use someone else's reserved stock", () => {
    expect(() => buildMaterialInput(workspace, { kind: "consume", materialCode: "FABRIC" }, { ...draft, confirmed: false }, [stock], [], "synthetic-key")).toThrow("实际发生");
    expect(() => buildMaterialInput(workspace, { kind: "consume", materialCode: "FABRIC" }, { ...draft, quantity: "0.21" }, [stock], [], "synthetic-key")).toThrow("其他预留");
  });
  it("uses only the selected original reservation and its remaining quantity", () => {
    const reservation = { entryId: binding, reservationId: id, locationId: location, locationName: "Synthetic", warehouseName: "Synthetic", lotId: null, lotCode: null, remainingQuantity: "0.1", dimensionActive: true, unit: "meter" as const };
    const input = { ...draft, reservation: binding, quantity: "0.1", dimension: "" };
    expect(buildMaterialInput(workspace, { kind: "consume", materialCode: "FABRIC" }, input, [], [reservation], "synthetic-key")).toMatchObject({ reservationEntryId: binding, locationId: location });
    expect(() => buildMaterialInput(workspace, { kind: "consume", materialCode: "FABRIC" }, { ...input, quantity: "0.100000001" }, [], [reservation], "synthetic-key")).toThrow("原备料余量");
  });
  it("does not accept new reserves against a closed production or silently use a superseded BOM", () => {
    expect(() => buildMaterialInput({ ...workspace, productionStatus: "completed" }, { kind: "reserve", materialCode: "FABRIC" }, draft, [stock], [], "synthetic-key")).toThrow("不接受");
    expect(() => buildMaterialInput({ ...workspace, currentBinding: false }, { kind: "consume", materialCode: "FABRIC" }, draft, [stock], [], "synthetic-key")).toThrow("当前制造版本");
  });
});
