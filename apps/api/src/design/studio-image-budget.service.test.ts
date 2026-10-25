import { describe, expect, it } from "vitest";
import { studioImageBudgetCapView, studioImageBudgetJsonCap, studioImageBudgetMicros, studioImageBudgetPolicyRevision } from "./studio-image-budget.service.js";

describe("Studio organization budget fixed precision", () => {
  it("keeps every micro at both ends of the supported policy range", () => {
    expect(studioImageBudgetMicros("0.000001")).toBe(1n);
    expect(studioImageBudgetMicros("99999999.999999")).toBe(99_999_999_999_999n);
    expect(studioImageBudgetMicros("9999999999999999.999999", 16)).toBe(9_999_999_999_999_999_999_999n);
  });
  it.each(["-0.000001", "0.0000001", "1e2", "NaN", "Infinity", "01.000000", "100000000.000000"])("refuses %s without rounding", value => {
    expect(() => studioImageBudgetMicros(value)).toThrow();
  });
  it.each(["0.000001", "0.050001", "99999999.999999"])("stores JSON cap %s only after an exact inverse conversion", value => {
    const result = studioImageBudgetJsonCap(value);
    expect(studioImageBudgetMicros(String(result))).toBe(studioImageBudgetMicros(value));
  });
});

describe("Studio organization budget original revision", () => {
  const original = { policySql: '{"tenant_id":"tenant-fixture","task_caps_usd":{"studio_image":0.1,"other_task":0.030000000000000000000001},"monthly_cap_usd":10.000000,"default_task_cap_usd":1.000000}',
    updatedAtSql: "2026-10-24 01:02:03.123456" };
  it("uses null only for a missing policy", () => {
    expect(studioImageBudgetPolicyRevision(null)).toBeNull();
    expect(studioImageBudgetPolicyRevision(original)).toMatch(/^[a-f0-9]{64}$/);
  });
  it("binds microseconds that a JavaScript Date would collapse", () => {
    expect(studioImageBudgetPolicyRevision(original)).not.toBe(studioImageBudgetPolicyRevision({ ...original, updatedAtSql: "2026-10-24 01:02:03.123457" }));
  });
  it("binds every other task cap without passing its numeric precision through JSON.parse", () => {
    const changed = { ...original, policySql: original.policySql.replace("0.030000000000000000000001", "0.030000000000000000000002") };
    expect(studioImageBudgetPolicyRevision(original)).not.toBe(studioImageBudgetPolicyRevision(changed));
    expect(JSON.parse(original.policySql)).toEqual(JSON.parse(changed.policySql));
  });
});

describe("Studio image cap repair projection", () => {
  it("shows an absent override as the actual default, including zero", () => {
    expect(studioImageBudgetCapView({}, "0.000000")).toEqual({ imageTaskCapUsd: "0.000000", imageCapSource: "default" });
    expect(studioImageBudgetCapView({ another_task: 100 }, "0.100000")).toEqual({ imageTaskCapUsd: "0.100000", imageCapSource: "default" });
  });
  it.each([0, 0.000001, 0.123456])("shows the existing exact numeric override %s without inventing a positive cap", value => {
    expect(studioImageBudgetCapView({ studio_image: value }, "1.000000")).toEqual({ imageTaskCapUsd: value.toFixed(6), imageCapSource: "specific" });
  });
  it.each([null, "0.100000", -1, 0.1234567, {}, []])("exposes an unusable override %j for explicit repair rather than applying a default", value => {
    const caps = { other_task: 0.07, studio_image: value }, before = globalThis.structuredClone(caps);
    expect(studioImageBudgetCapView(caps, "1.000000")).toEqual({ imageTaskCapUsd: null, imageCapSource: "invalid" });
    expect(caps).toEqual(before);
  });
  it("does not let JSON.parse hide unusable sub-micro precision in a legacy numeric override", () => {
    const raw = "0.123456000000000000001", caps = JSON.parse(`{"studio_image":${raw}}`);
    expect(caps.studio_image).toBe(0.123456);
    expect(studioImageBudgetCapView(caps, "1.000000", raw)).toEqual({ imageTaskCapUsd: null, imageCapSource: "invalid" });
    expect(studioImageBudgetCapView({ studio_image: 0.1 }, "1.000000", "0.100000000000"))
      .toEqual({ imageTaskCapUsd: "0.100000", imageCapSource: "specific" });
  });
});
