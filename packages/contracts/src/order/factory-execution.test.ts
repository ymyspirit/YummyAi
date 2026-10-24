import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { FactoryErpRawStatusSchema, FactoryErpStatusSchema, mapPillowFactoryErpStatus, pillowFactoryDeliveryProgress } from "./production-delivery.js";

describe("explicit factory execution vocabulary and submission default", () => {
  it.each(["submitted", "received", "accepted"] as const)("projects original %s as scheduled without requiring a later receipt", status => {
    expect(pillowFactoryDeliveryProgress(status)).toEqual({ status: "scheduled", label: "已排产", basis: "submission_default", exception: null });
  });
  it("keeps an unsubmitted package and explicit file exceptions outside scheduled progress", () => {
    expect(pillowFactoryDeliveryProgress("pending")).toEqual({ status: null, label: "待提交", basis: null, exception: null });
    expect(pillowFactoryDeliveryProgress("rejected")).toEqual({ status: null, label: "文件被拒收", basis: null, exception: "rejected" });
    expect(pillowFactoryDeliveryProgress("rework")).toEqual({ status: null, label: "返工跟进", basis: null, exception: "rework" });
  });
  it("accepts only the two confirmed factory ERP states and the three exact export statuses", () => {
    expect(FactoryErpStatusSchema.parse("scheduled")).toBe("scheduled");
    expect(FactoryErpStatusSchema.parse("shipped")).toBe("shipped");
    for (const raw of ["已审核", "已出库", "已作废"] as const)
      expect(FactoryErpRawStatusSchema.parse(raw)).toBe(raw);
    for (const unknown of ["", "unknown", "pending", "submitted", "accepted", "completed", "已生产", "已完成", "已排产", "已发货", " 已审核 ", null]) {
      expect(FactoryErpStatusSchema.safeParse(unknown).success).toBe(false);
      expect(FactoryErpRawStatusSchema.safeParse(unknown).success).toBe(false);
    }
    expect(FactoryErpStatusSchema.safeParse("已排产").success).toBe(false);
    expect(FactoryErpRawStatusSchema.safeParse("scheduled").success).toBe(false);
  });
  it("never infers actual shipment from submission, legacy acceptance or a file exception", () => {
    for (const original of ["pending", "submitted", "received", "accepted", "rejected", "rework"] as const)
      expect(pillowFactoryDeliveryProgress(original).status, original).not.toBe("shipped");
  });
  it.each([
    ["已审核", { status: "scheduled", exception: null }],
    ["已出库", { status: "shipped", exception: null }],
    ["已作废", { status: null, exception: "voided_requires_review" }],
  ] as const)("maps the confirmed factory export status %s without inventing another production state", (raw, expected) => {
    expect(mapPillowFactoryErpStatus(raw)).toEqual(expected);
  });
  it("rejects unknown factory export statuses instead of guessing scheduled or shipped", () => {
    for (const raw of ["", "unknown", "scheduled", "shipped", "已排产", "已发货", "已取消", " 已审核", "已出库 "])
      expect(() => mapPillowFactoryErpStatus(raw), raw).toThrow(ZodError);
  });
});
