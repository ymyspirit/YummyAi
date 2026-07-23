import type { CustomizationDefinition, OrderCustomizationValue } from "@yummyai/contracts";
import { describe, expect, it } from "vitest";

import { mapOrderCustomization } from "./order-customization-mapper.js";

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
