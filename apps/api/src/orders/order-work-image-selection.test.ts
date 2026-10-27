import type { AmazonReportFileView, CustomizationDefinition } from "@yummyai/contracts";
import { describe, expect, it } from "vitest";
import { defaultOrderWorkImages } from "./order-work-image-selection.js";

const original: AmazonReportFileView = { key: "buyer-preview.png", originalFileKey: "buyer.png", name: "buyer.png", role: "buyer_image", mediaType: "image/png", byteSize: 12 };
const field = (key: string) => ({ key, label: key, type: "image" as const, required: true,
  validation: { allowedMediaTypes: ["image/png" as const], maxFiles: 1, maxBytes: 1024 } });
const schema = (...keys: string[]): CustomizationDefinition => ({ version: 1, fields: keys.map(field) });

describe("unsaved order original-image selection", () => {
  it("selects only an available buyer original, retaining the report selection key", () => {
    const files: AmazonReportFileView[] = [original, { ...original, role: "preview", key: "preview.png" },
      { ...original, role: "source", key: "source.png" }, { ...original, key: "unavailable", originalFileKey: undefined },
      { ...original, key: "source.json", mediaType: "application/json" }, original];
    expect(defaultOrderWorkImages(files, schema("buyer_photo"))).toEqual([{ origin: "report", key: original.key, usage: "buyer_photo" }]);
    expect(files[0]).toEqual(original);
  });

  it("leaves multiple image-field purposes explicitly unassigned", () => {
    expect(defaultOrderWorkImages([original], schema("front_photo", "back_photo"))).toEqual([
      { origin: "report", key: original.key, usage: "待选择定制字段" },
    ]);
    expect(defaultOrderWorkImages([original])[0]!.usage).toBe("待选择定制字段");
  });

  it("bounds the initial selection to thirty without mutating the original report", () => {
    const files = Array.from({ length: 31 }, (_, index) => ({ ...original, key: `buyer-${index}` }));
    expect(defaultOrderWorkImages(files, schema("buyer_photo"))).toHaveLength(30);
    expect(files).toHaveLength(31);
  });
});
