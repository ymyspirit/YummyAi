import { describe, expect, it } from "vitest";
import { createEntityId } from "../common/ids.js";
import { OrderWorkSummarySchema } from "./workspace.js";

const publicSummary = () => ({ id: createEntityId(), revision: 1, sourceVersionId: null,
  printSku: null, spu: null, specification: null, designExecutor: null, fields: [], instructions: "",
  images: [], blockers: [], error: null });
describe("original order summary availability", () => {
  it("preserves older response shape without inventing availability", () => {
    const original = publicSummary();
    expect(OrderWorkSummarySchema.parse(original)).toEqual(original);
  });
  it("requires available responses to be consistent with the original read result", () => {
    expect(OrderWorkSummarySchema.safeParse({ ...publicSummary(), availability: "available" }).success).toBe(true);
    expect(OrderWorkSummarySchema.safeParse({ ...publicSummary(), availability: "available", error: "failed" }).success).toBe(false);
  });
  it.each(["cleared", "expired", "archived", "failed"])("rejects private payload retained in %s responses", availability => {
    const value = { ...publicSummary(), availability, error: "Original source unavailable" };
    expect(OrderWorkSummarySchema.safeParse(value).success).toBe(true);
    for (const patch of [{ fields: [{ label: "Name", value: "SYNTHETIC_PRIVATE" }] },
      { instructions: "SYNTHETIC_PRIVATE" }, { images: [{ path: "/private", label: "Original", selected: true, kind: "buyer" }] },
      { sourceVersionId: createEntityId() }, { spu: "SYNTHETIC_PRIVATE" }, { specification: "Original size" },
      { designExecutor: "agent" }, { blockers: ["Original private field label"] }, { error: null }])
      expect(OrderWorkSummarySchema.safeParse({ ...value, ...patch }).success).toBe(false);
  });
  it("does not accept invented readiness or caller fields", () => {
    expect(OrderWorkSummarySchema.safeParse({ ...publicSummary(), availability: "ready_to_produce" }).success).toBe(false);
    expect(OrderWorkSummarySchema.safeParse({ ...publicSummary(), availability: "available", tenantId: createEntityId() }).success).toBe(false);
  });
});
