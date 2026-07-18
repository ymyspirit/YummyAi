import { describe, expect, it } from "vitest";

import { CustomizationSchema, MoneySchema } from "./product.js";

describe("catalog contracts", () => {
  it("accepts all supported customization field families and conditional visibility", () => {
    const result = CustomizationSchema.parse({
      version: 1,
      fields: [
        { key: "gift", label: "Gift", type: "single_choice", options: [{ value: "yes", label: "Yes" }] },
        { key: "message", label: "Message", type: "long_text", visibleWhen: { fieldKey: "gift", operator: "equals", value: "yes" } },
        { key: "artwork", label: "Artwork", type: "image", validation: { allowedMediaTypes: ["image/png"], maxBytes: 5_000_000 } },
        { key: "delivery", label: "Delivery", type: "date" },
        { key: "color", label: "Color", type: "color", palette: ["#112233"] },
        { key: "extras", label: "Extras", type: "multiple_choice", options: [{ value: "box", label: "Box" }] },
      ],
    });
    expect(result.fields).toHaveLength(6);
  });

  it("rejects conditional visibility that references a missing field", () => {
    expect(CustomizationSchema.safeParse({
      version: 1,
      fields: [{ key: "message", label: "Message", type: "short_text", visibleWhen: { fieldKey: "missing", operator: "not_empty" } }],
    }).success).toBe(false);
  });

  it("requires an ISO-style uppercase currency code", () => {
    expect(MoneySchema.safeParse({ amount: 10, currency: "usd" }).success).toBe(false);
    expect(MoneySchema.parse({ amount: 10, currency: "USD" })).toEqual({ amount: 10, currency: "USD" });
  });
});
