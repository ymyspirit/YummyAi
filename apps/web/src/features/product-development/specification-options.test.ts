import { describe, expect, it } from "vitest";
import {
  boundSpecificationAxes,
  expandSpecificationOptions,
  nextSpecificationCode,
  specificationAttributesKey,
  splitSpecificationValues,
} from "./specification-options";

describe("physical specification options", () => {
  it("expands sizes and shapes into distinct, single-valued physical specifications", () => {
    const rows = expandSpecificationOptions([
      {
        id: "size",
        name: "尺寸",
        values: splitSpecificationValues("50×60 英寸，60×80 英寸\n50×60 英寸"),
      },
      { id: "shape", name: "形状", values: [" 圆形 ", "心形"] },
    ]);
    expect(rows).toEqual([
      { 尺寸: "50×60 英寸", 形状: "圆形" },
      { 尺寸: "50×60 英寸", 形状: "心形" },
      { 尺寸: "60×80 英寸", 形状: "圆形" },
      { 尺寸: "60×80 英寸", 形状: "心形" },
    ]);
    expect(specificationAttributesKey(rows[0]!)).toBe(
      specificationAttributesKey({ 形状: "圆形", 尺寸: "50×60 英寸" }),
    );
  });
  it("stops ambiguous axes and oversized combination sets before allocating preview rows", () => {
    expect(() => expandSpecificationOptions([{ id: "empty", name: "尺寸", values: [] }])).toThrow(
      "至少一个",
    );
    expect(() =>
      expandSpecificationOptions([
        { id: "a", name: "尺寸", values: ["a"] },
        { id: "b", name: " 尺寸 ", values: ["b"] },
      ]),
    ).toThrow("不可重复");
    expect(() =>
      expandSpecificationOptions([
        { id: "large", name: "尺寸", values: Array.from({ length: 51 }, (_, i) => String(i)) },
      ]),
    ).toThrow("最多预览 50");
  });
  it("allocates editable codes without colliding with an existing SPU's codes", () => {
    const used = new Set(["spec-001", "spec-003"]);
    expect(nextSpecificationCode(used)).toBe("SPEC-002");
    expect(nextSpecificationCode(used)).toBe("SPEC-004");
  });
  it("keeps bound option order stable when a specification is revised and returned first", () => {
    const first = { code: "SPEC-001", attributes: { 尺寸: "50 mm", 形状: "圆形" } };
    const second = { code: "SPEC-004", attributes: { 尺寸: "254 mm", 形状: "方形" } };
    expect(boundSpecificationAxes([second, first])).toEqual(
      boundSpecificationAxes([first, second]),
    );
  });
});
