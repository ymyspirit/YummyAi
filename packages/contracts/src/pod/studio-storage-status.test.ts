import { describe, expect, it } from "vitest";
import { StudioStorageStatusSchema } from "./studio-personal.js";

describe("Studio local input and transport status", () => {
  it("retains an unsaved local document even after all network work is finished", () => {
    expect(StudioStorageStatusSchema.parse({ pending: 0, dirty: 1, error: null }))
      .toEqual({ pending: 0, dirty: 1, error: null });
  });
  it("accepts the previous runtime status without claiming a new local producer count", () => {
    expect(StudioStorageStatusSchema.parse({ pending: 2, error: null }))
      .toEqual({ pending: 2, dirty: 0, error: null });
  });
  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])("rejects invalid dirty or pending counts instead of turning %s into saved state", value => {
      expect(StudioStorageStatusSchema.safeParse({ pending: value, dirty: 0, error: null }).success).toBe(false);
      expect(StudioStorageStatusSchema.safeParse({ pending: 0, dirty: value, error: null }).success).toBe(false);
  });
  it("rejects an incomplete or unrelated status notification", () => {
    expect(StudioStorageStatusSchema.safeParse({ pending: 0, dirty: 0 }).success).toBe(false);
    expect(StudioStorageStatusSchema.safeParse({ pending: 0, dirty: 0, error: null, saved: true }).success).toBe(false);
  });
});
