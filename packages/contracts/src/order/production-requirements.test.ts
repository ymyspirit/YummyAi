import { describe, expect, it } from "vitest";
import type { AmazonReportDetailView, AmazonReportFieldView } from "./report.js";
import { orderProductionRequirements } from "./production-requirements.js";

type Field = Pick<AmazonReportFieldView, "label" | "value"> & Partial<Pick<AmazonReportFieldView, "kind">>;
function report(fields: Field[]): Pick<AmazonReportDetailView, "surfaces"> {
  return { surfaces: [{ key: "front", label: "Synthetic front", previewFileKey: null, buyerFileKeys: [],
    fields: fields.map((field, index) => ({ key: `synthetic-${index}`, kind: "choice", ...field })) }] };
}
const size = (value: string) => ({ label: "Pillow Size", value });

describe("explicit order production requirements", () => {
  it.each([10, 12, 14, 16, 18, 20, 22, 24])("recognizes the explicit %s inch size without reading product-title numbers", inches => {
    expect(orderProductionRequirements(report([size(`${inches} inches`),
      { label: "Product title", value: "Custom photo shaped pillow 10–24 inches" }])).sizeInches).toBe(inches);
  });

  it.each(["16 inch", "16in", "16 INCHES", "16 英寸"])("normalizes an explicit supported unit: %s", value => {
    expect(orderProductionRequirements(report([size(value)])).sizeInches).toBe(16);
  });

  it.each(["10-24 inches", "10–24 inches", "10 to 24 inches", "10/24 inches", "16 inch / 18 inch"])("does not choose the last number of a range or multi-value option: %s", value => {
    const actual = orderProductionRequirements(report([size(value)]));
    expect(actual.sizeInches).toBeNull();
    expect(actual.warnings.length).toBeGreaterThan(0);
  });

  it("does not let another valid field hide an ambiguous size declaration", () => {
    const actual = orderProductionRequirements(report([size("10–24 inches"), { label: "尺寸", value: "16 inches" }]));
    expect(actual.sizeInches).toBeNull();
    expect(actual.warnings.length).toBeGreaterThan(0);
  });

  it("does not let another valid field hide two explicitly different sizes in one option", () => {
    const actual = orderProductionRequirements(report([size("16 inch / 18 inch"), { label: "Size", value: "16 inch" }]));
    expect(actual.sizeInches).toBeNull();
    expect(actual.warnings.length).toBeGreaterThan(0);
  });

  it("treats conflicting source sizes independently of valid print side and subject", () => {
    const actual = orderProductionRequirements(report([size("16 inches"), { label: "尺寸", value: "18 inches" },
      { label: "Printing", value: "Double Sided Printing" }, { label: "Pillow Style", value: "Half Body" }]));
    expect(actual).toMatchObject({ sizeInches: null, sideMode: "double", subject: "half_body" });
    expect(actual.warnings.length).toBeGreaterThan(0);
  });

  it("accepts duplicate consistent source sizes without creating a different size", () => {
    expect(orderProductionRequirements(report([size("16 inches"), { label: "尺寸", value: "16 英寸" }])).sizeInches).toBe(16);
  });

  it("accepts the existing descriptive size suffix but rejects a numeric choice hidden in that suffix", () => {
    expect(orderProductionRequirements(report([{ label: "Size 10 / 12 / 14 / 16", value: "10 inch-Very Small" }]))).toMatchObject({ sizeInches: 10, warnings: [] });
    for (const value of ["10 inch-12 inches", "10 inch-10 to 24", "10 inch-Very Small 24", "10 inch-16 Large"])
      expect(orderProductionRequirements(report([size(value)])).sizeInches, value).toBeNull();
  });

  it("keeps size missing when only a title, surface label or image contains size text", () => {
    const source = report([{ label: "Product title", value: "Custom shaped pillow 16 inches" },
      { label: "Upload image", kind: "image", value: "16 inches" }]);
    source.surfaces[0]!.label = "Custom pillow 24 inches";
    expect(orderProductionRequirements(source).sizeInches).toBeNull();
  });

  it.each(["", "17 inches", "large", "40.64 cm", "16 inches or another size"])("does not invent a supported size for incomplete or unsupported input: %s", value => {
    expect(orderProductionRequirements(report([size(value)])).sizeInches).toBeNull();
  });

  it("does not lose valid size or subject because print-side declarations conflict", () => {
    const actual = orderProductionRequirements(report([size("16 inches"), { label: "Printing", value: "Single Sided Printing" },
      { label: "印刷", value: "双面印刷" }, { label: "Pillow Style", value: "Only Face" }]));
    expect(actual).toMatchObject({ sizeInches: 16, sideMode: null, subject: "head" });
    expect(actual.warnings.length).toBeGreaterThan(0);
  });

  it("does not lose valid size or print side because subjects conflict", () => {
    const actual = orderProductionRequirements(report([size("16 inches"), { label: "Printing", value: "Double Sided Printing" },
      { label: "Pillow Style", value: "Only Face" }, { label: "范围", value: "Whole Body" }]));
    expect(actual).toMatchObject({ sizeInches: 16, sideMode: "double", subject: null });
    expect(actual.warnings.length).toBeGreaterThan(0);
  });

  it("retains original source text and leaves the input untouched", () => {
    const source = report([size(" 16 inches "), { label: "Instructions", value: "Synthetic customer request; do not approve production" }]);
    const before = JSON.stringify(source), actual = orderProductionRequirements(source);
    expect(JSON.stringify(source)).toBe(before);
    expect(actual.fields).toEqual([{ label: "Pillow Size", value: " 16 inches ", surface: "Synthetic front" },
      { label: "Instructions", value: "Synthetic customer request; do not approve production", surface: "Synthetic front" }]);
    expect(actual.sizeInches).toBe(16);
  });
});
