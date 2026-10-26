import { describe, expect, it } from "vitest";
import { assertStudioImageBudgetSnapshot, studioImageAdmission, studioImageHash, studioImageWireSize,
  type StudioImageBudgetSnapshot } from "./studio-image-billing.js";

const tenant = "019a1030-0000-7000-8000-000000000001", other = "019a1030-0000-7000-8000-000000000002";
const pricing = { estimatedUsd: "0.03000000", reservationUsd: "0.050000", reference: "Operator estimate for one image" };
const snapshot = (): StudioImageBudgetSnapshot => ({ policy: { monthlyCapUsd: "1.000000", defaultTaskCapUsd: "0.100000", taskCapsUsd: {} },
  occupiedUsd: "0.950000", priorOverrun: false });

describe("Studio paid image operator admission", () => {
  it("requires both an exact opt-in and the explicit tenant", () => {
    expect(studioImageAdmission(tenant, {})).toEqual({ version: 1, enabled: false, code: "operator_paused" });
    expect(studioImageAdmission(tenant, { STUDIO_PAID_IMAGE_ENABLED: "1", STUDIO_PAID_IMAGE_TENANT_IDS: tenant })).toEqual({ version: 1, enabled: true, code: "ready" });
    expect(studioImageAdmission(other, { STUDIO_PAID_IMAGE_ENABLED: "1", STUDIO_PAID_IMAGE_TENANT_IDS: tenant }).enabled).toBe(false);
  });
  it.each(["true", "yes", " 1", "0", ""])("does not treat %j as opt-in", value => {
    expect(studioImageAdmission(tenant, { STUDIO_PAID_IMAGE_ENABLED: value, STUDIO_PAID_IMAGE_TENANT_IDS: tenant }).enabled).toBe(false);
  });
  it.each(["*", `${tenant},`, `${tenant},invalid`, "", "all"])("rejects an invalid or wildcard allowlist %j", value => {
    expect(studioImageAdmission(tenant, { STUDIO_PAID_IMAGE_ENABLED: "1", STUDIO_PAID_IMAGE_TENANT_IDS: value }).enabled).toBe(false);
  });
  it("accepts whitespace around explicit IDs and reads a changed environment on each call", () => {
    const environment = { STUDIO_PAID_IMAGE_ENABLED: "1", STUDIO_PAID_IMAGE_TENANT_IDS: ` ${other}, ${tenant.toUpperCase()} ` };
    expect(studioImageAdmission(tenant, environment).enabled).toBe(true);
    environment.STUDIO_PAID_IMAGE_ENABLED = "0";
    expect(studioImageAdmission(tenant, environment).enabled).toBe(false);
  });
});

describe("Studio image quote identity", () => {
  it("hashes nested object keys canonically while preserving array and primitive identity", () => {
    expect(studioImageHash({ b: [{ z: 2, a: 1 }], a: "1" })).toBe(studioImageHash({ a: "1", b: [{ a: 1, z: 2 }] }));
    expect(studioImageHash({ values: [1, 2] })).not.toBe(studioImageHash({ values: [2, 1] }));
    expect(studioImageHash({ value: 1 })).not.toBe(studioImageHash({ value: "1" }));
  });
  it.each([["auto", "auto"], ["4096x2048", "4096x2048"], ["1:1", "1024x1024"],
    ["16:9", "1536x1024"], ["9:16", "1024x1536"]])("quotes actual wire size for %s", (input, expected) => {
    expect(studioImageWireSize(input)).toBe(expected);
  });
});

describe("Studio image fixed precision budget", () => {
  it("allows the exact last reserved micro and does not mutate the snapshot", () => {
    const value = snapshot(), before = globalThis.structuredClone(value);
    expect(assertStudioImageBudgetSnapshot(value, pricing)).toBe("0.050000");
    expect(value).toEqual(before);
    value.occupiedUsd = "0.950001";
    expect(() => assertStudioImageBudgetSnapshot(value, pricing)).toThrow("组织图片任务与月度预算");
  });
  it("counts a replayed hold once, while still applying the current monthly cap", () => {
    const value = snapshot(); value.occupiedUsd = "1.000000";
    expect(assertStudioImageBudgetSnapshot(value, pricing, true)).toBe("0.050000");
    value.policy!.monthlyCapUsd = "0.999999";
    expect(() => assertStudioImageBudgetSnapshot(value, pricing, true)).toThrow();
  });
  it("uses the explicit image cap rather than text or an unlimited marker", () => {
    const value = snapshot(); value.policy!.taskCapsUsd = { studio_image: 0.049999, studio_text: 100 };
    expect(() => assertStudioImageBudgetSnapshot(value, pricing)).toThrow();
  });
  it("rejects raw submicro precision even when JSON parsing rounds it to a usable cap", () => {
    const value = snapshot(); value.policy!.taskCapsUsd = { studio_image: 0.123456 };
    value.imageCapSql = { containerType: "object", hasKey: true, valueType: "number", text: "0.123456000000000000001" };
    const before = globalThis.structuredClone(value);
    expect(Number(value.imageCapSql.text)).toBe(0.123456);
    expect(() => assertStudioImageBudgetSnapshot(value, pricing)).toThrow("组织图片任务与月度预算");
    expect(value).toEqual(before);
  });
  it("refuses malformed SQL JSON types rather than falling back to a valid default", () => {
    const value = snapshot(); value.policy!.taskCapsUsd = { studio_image: 0.1 };
    const invalid: NonNullable<StudioImageBudgetSnapshot["imageCapSql"]>[] = [
      { containerType: "array", hasKey: false, valueType: null, text: null },
      { containerType: "null", hasKey: false, valueType: null, text: null },
      ...["null", "array", "object", "string"].map(valueType => ({ containerType: "object", hasKey: true, valueType, text: "0.100000" })),
      { containerType: "object", hasKey: true, valueType: "number", text: null },
    ];
    for (const imageCapSql of invalid) {
      expect(() => assertStudioImageBudgetSnapshot({ ...value, imageCapSql }, pricing)).toThrow("组织图片任务与月度预算");
    }
  });
  it("strips only insignificant raw fractional zeros and preserves the one-micro cap boundary", () => {
    const value = snapshot(); value.policy!.taskCapsUsd = { studio_image: 0.05 };
    value.imageCapSql = { containerType: "object", hasKey: true, valueType: "number", text: "0.050000000000000000000" };
    expect(assertStudioImageBudgetSnapshot(value, pricing)).toBe("0.050000");
    value.imageCapSql.text = "0.049999000000000000000";
    expect(() => assertStudioImageBudgetSnapshot(value, pricing)).toThrow();
    value.imageCapSql.text = "0.050000000000000000001";
    expect(() => assertStudioImageBudgetSnapshot(value, pricing)).toThrow();
  });
  it("uses the exact default cap only when SQL proves the image override is absent", () => {
    const value = snapshot(); value.policy!.defaultTaskCapUsd = "0.050000";
    value.imageCapSql = { containerType: "object", hasKey: false, valueType: null, text: null };
    expect(assertStudioImageBudgetSnapshot(value, pricing)).toBe("0.050000");
    value.policy!.defaultTaskCapUsd = "0.049999";
    expect(() => assertStudioImageBudgetSnapshot(value, pricing)).toThrow();
  });
  it("requires a real policy and stops the same model/provider after a confirmed overrun", () => {
    expect(() => assertStudioImageBudgetSnapshot({ ...snapshot(), policy: null }, pricing)).toThrow();
    expect(() => assertStudioImageBudgetSnapshot({ ...snapshot(), priorOverrun: true }, pricing)).toThrow();
  });
  it.each(["0.000000", "-1.000000", "NaN", "1e2", "0.0500001"])("rejects unusable task capacity %s without rounding", cap => {
    const value = snapshot(); value.policy!.defaultTaskCapUsd = cap;
    expect(() => assertStudioImageBudgetSnapshot(value, pricing)).toThrow();
  });
  it("retains one-micro precision near the maximum supported budget", () => {
    const value = snapshot(); value.policy!.monthlyCapUsd = "99999999.999999"; value.policy!.defaultTaskCapUsd = "1.000000";
    value.occupiedUsd = "99999999.999998";
    const micro = { ...pricing, estimatedUsd: "0.00000001", reservationUsd: "0.000001" };
    expect(assertStudioImageBudgetSnapshot(value, micro)).toBe("0.000001");
    expect(() => assertStudioImageBudgetSnapshot(value, { ...micro, reservationUsd: "0.000002" })).toThrow();
  });
  it("refuses an estimate above the reservation or a zero hold", () => {
    expect(() => assertStudioImageBudgetSnapshot(snapshot(), { ...pricing, estimatedUsd: "0.05000001" })).toThrow("每张预估费用");
    expect(() => assertStudioImageBudgetSnapshot(snapshot(), { ...pricing, estimatedUsd: "0.00000000", reservationUsd: "0.000000" })).toThrow("每张预估费用");
  });
});
