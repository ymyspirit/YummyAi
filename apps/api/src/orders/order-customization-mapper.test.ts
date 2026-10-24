import type { CustomizationDefinition, OrderCustomizationValue } from "@yummyai/contracts";
import { describe, expect, it } from "vitest";

import { customizationFieldCandidates, mapOrderCustomization } from "./order-customization-mapper.js";

describe("order customization mapper", () => {
  it("maps provider labels to pinned schema fields and keeps file references separate", () => {
    const result = mapOrderCustomization(schema(), [
      { key: "etsy:variation:0", label: "Thread color", type: "text", value: "Pink" },
      { key: "etsy:buyer-message", label: "Name", type: "text", value: "Alex" },
      { key: "upload", label: "Portrait", type: "file_reference", externalReference: "provider-file-1" },
    ]);
    expect(result).toMatchObject({ completeness: 100, mappedFieldKeys: ["name", "portrait", "thread_color"], missingFieldKeys: [] });
    expect(result.values).toEqual({ name: "Alex", thread_color: "pink" });
    expect(result.fileReferences).toEqual([{ fieldKey: "portrait", externalReference: "provider-file-1" }]);
  });

  it("reports missing, invalid, duplicate, and unmapped values without echoing customer text", () => {
    const source: OrderCustomizationValue[] = [
      { key: "name", label: "Name", type: "text", value: "A".repeat(501) },
      { key: "thread_color", label: "Thread color", type: "text", value: "purple" },
      { key: "unknown", label: "Gift message", type: "text", value: "private message" },
    ];
    const result = mapOrderCustomization(schema(), source);
    expect(result.missingFieldKeys).toEqual(["name", "thread_color"]);
    expect(new Set(result.diagnostics.map((entry) => entry.code))).toEqual(new Set(["invalid_value", "unmapped_value"]));
    expect(JSON.stringify(result.diagnostics)).not.toMatch(/private message|purple/);
  });
  it("does not pick the first field when provider labels collide", () => {
    const fields = [{ key: "front_name", label: "Name", type: "short_text" as const, required: true },
      { key: "back_name", label: "Name", type: "short_text" as const, required: true }];
    const result = mapOrderCustomization({ version: 1, fields }, [{ key: "provider:0", label: "Name", type: "text", value: "Private buyer text" }]);
    expect(result.values).toEqual({});
    expect(result.diagnostics).toEqual([{ code: "ambiguous_field", fieldKey: null }]);
    expect(result.missingFieldKeys).toEqual(["front_name", "back_name"]);
    expect(customizationFieldCandidates(fields, "front_name", "Name").map(f => f.key)).toEqual(["front_name"]);
    expect(JSON.stringify(result.diagnostics)).not.toContain("Private buyer text");
  });
  it("rejects contradictory key/label and duplicate values instead of retaining a winner", () => {
    expect(customizationFieldCandidates(schema().fields, "name", "Thread color")).toHaveLength(2);
    const result = mapOrderCustomization(schema(), [
      { key: "one", label: "Name", type: "text", value: "First" },
      { key: "two", label: "Name", type: "text", value: "Second" },
    ]);
    expect(result.values).toEqual({});
    expect(result.mappedFieldKeys).not.toContain("name");
    expect(result.missingFieldKeys).toContain("name");
    expect(result.diagnostics).toContainEqual({ code: "duplicate_value", fieldKey: "name" });
  });
  it("rejects multi-value single choices and ambiguous option labels", () => {
    expect(mapOrderCustomization(schema(), [{ key: "thread_color", label: "Thread color", type: "choice", values: ["Pink", "Blue"] }]).values).toEqual({});
    const definition = schema();
    const choice = definition.fields[1];
    if (choice?.type !== "single_choice") throw new Error("Fixture choice missing");
    choice.options[1]!.label = "Pink";
    expect(mapOrderCustomization(definition, [{ key: "thread_color", label: "Thread color", type: "text", value: "Pink" }]).values).toEqual({});
  });
  it("validates calendar dates and whitespace-only required text", () => {
    const dates: CustomizationDefinition = { version: 1, fields: [{ key: "date", label: "Date", type: "date", required: true }] };
    expect(mapOrderCustomization(dates, [{ key: "date", label: "Date", type: "text", value: "2026-02-30" }]).completeness).toBe(0);
    expect(mapOrderCustomization(dates, [{ key: "date", label: "Date", type: "text", value: "2028-02-29" }]).completeness).toBe(100);
    expect(mapOrderCustomization(schema(), [{ key: "name", label: "Name", type: "text", value: "   " }]).values).toEqual({});
  });
});

function schema(): CustomizationDefinition {
  return {
    version: 3,
    fields: [
      { key: "name", label: "Name", type: "short_text", required: true, validation: { maxLength: 500 } },
      { key: "thread_color", label: "Thread color", type: "single_choice", required: true, options: [{ value: "pink", label: "Pink" }, { value: "blue", label: "Blue" }] },
      { key: "portrait", label: "Portrait", type: "image", required: false, validation: { allowedMediaTypes: ["image/png", "image/jpeg"], maxFiles: 1, maxBytes: 5_000_000 } },
    ],
  };
}
