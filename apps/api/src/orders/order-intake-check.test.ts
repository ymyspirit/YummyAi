import { describe, expect, it } from "vitest";
import { OrderWorkDraftSchema } from "@yummyai/contracts/order/workspace";
import type { CustomizationDefinition } from "@yummyai/contracts";
import { checkOrderIntakeFields } from "./order-intake-check.js";

const schema: CustomizationDefinition = {
  version: 1,
  fields: [
    {
      key: "name",
      label: "Name",
      type: "short_text",
      required: true,
      validation: { maxLength: 10 },
    },
    {
      key: "portrait",
      label: "Portrait",
      type: "image",
      required: true,
      validation: {
        maxFiles: 1,
        maxBytes: 5000000,
        allowedMediaTypes: ["image/png", "image/jpeg"],
      },
    },
  ],
};
const draft = () =>
  OrderWorkDraftSchema.parse({
    printProfileVersionId: null,
    fields: [{ key: "surface-0-field-0", label: "Ｎａｍｅ", kind: "text", value: "Alex" }],
    images: [{ origin: "upload", key: "synthetic", usage: "portrait" }],
    instructions: "",
    customerApprovalRequired: false,
    dueAt: null,
  });
describe("order intake fixed-field review", () => {
  it("proposes canonical unique identities while preserving buyer text and the input", () => {
    const input = draft(),
      result = checkOrderIntakeFields(schema, input, true);
    expect(result.issues).toEqual([]);
    expect(result.fields.map((f) => f.status)).toEqual(["mapped", "mapped"]);
    expect(result.normalizedDraft.fields[0]).toMatchObject({
      key: "name",
      label: "Name",
      value: "Alex",
    });
    expect(input.fields[0]!.key).toBe("surface-0-field-0");
    expect(OrderWorkDraftSchema.safeParse(result.normalizedDraft).success).toBe(true);
  });
  it("blocks missing buyer images and limits selected file count", () => {
    const input = draft();
    input.images = [];
    expect(checkOrderIntakeFields(schema, input, true).issues).toContainEqual(
      expect.objectContaining({ code: "missing_required", fieldKey: "portrait" }),
    );
    input.images = [
      { origin: "upload", key: "one", usage: "Portrait" },
      { origin: "upload", key: "two", usage: "Portrait" },
    ];
    expect(checkOrderIntakeFields(schema, input, true).issues).toContainEqual(
      expect.objectContaining({ code: "duplicate_value", fieldKey: "portrait" }),
    );
  });
  it("rejects image evidence used as text and text used as an image field", () => {
    const input = draft();
    input.fields[0]!.kind = "image";
    expect(checkOrderIntakeFields(schema, input, true).issues).toContainEqual(
      expect.objectContaining({ code: "invalid_value", fieldKey: "name" }),
    );
    input.fields = [
      ...draft().fields,
      { key: "portrait", label: "Portrait", kind: "text", value: "See preview" },
    ];
    expect(checkOrderIntakeFields(schema, input, true).issues).toContainEqual(
      expect.objectContaining({ code: "invalid_value", fieldKey: "portrait" }),
    );
    input.fields[1]!.kind = "image";
    input.images = [];
    expect(checkOrderIntakeFields(schema, input, true).issues).toContainEqual(
      expect.objectContaining({ code: "missing_required", fieldKey: "portrait" }),
    );
  });
  it("keeps duplicate and ambiguous inputs editable without collapsing their keys", () => {
    const input = draft();
    input.fields.push({ ...input.fields[0]!, key: "other", value: "Blair" });
    const duplicate = checkOrderIntakeFields(schema, input, true);
    expect(duplicate.issues.map((i) => i.code)).toContain("duplicate_value");
    expect(OrderWorkDraftSchema.safeParse(duplicate.normalizedDraft).success).toBe(true);
    const ambiguous: CustomizationDefinition = {
      ...schema,
      fields: [
        ...schema.fields,
        { key: "other_name", label: "Name", type: "short_text", required: false },
      ],
    };
    const result = checkOrderIntakeFields(ambiguous, draft(), true);
    expect(result.issues.map((i) => i.code)).toContain("ambiguous_field");
    expect(result.normalizedDraft.fields[0]!.key).toBe("surface-0-field-0");
  });
  it("blocks unknown populated fields in sealed configurations and preserves manual legacy handling", () => {
    const input = draft();
    input.fields.push({ key: "extra", label: "Gift", kind: "text", value: "Private note" });
    expect(checkOrderIntakeFields(schema, input, true).issues.map((i) => i.code)).toContain(
      "unmapped_field",
    );
    expect(checkOrderIntakeFields(schema, input, false).issues).toEqual([]);
    expect(JSON.stringify(checkOrderIntakeFields(schema, input, true).issues)).not.toContain(
      "Private note",
    );
  });
  it("applies conditional required rules without inventing a buyer choice", () => {
    const definition: CustomizationDefinition = {
      version: 1,
      fields: [
        {
          key: "side",
          label: "Side",
          type: "single_choice",
          required: true,
          options: [
            { value: "front", label: "Front" },
            { value: "both", label: "Both" },
          ],
        },
        {
          key: "back_text",
          label: "Back text",
          type: "short_text",
          required: true,
          visibleWhen: { fieldKey: "side", operator: "equals", value: "both" },
        },
      ],
    };
    const input = draft();
    input.images = [];
    input.fields = [{ key: "side", label: "Side", kind: "choice", value: "Front" }];
    expect(checkOrderIntakeFields(definition, input, true).issues).toEqual([]);
    input.fields[0]!.value = "Both";
    expect(checkOrderIntakeFields(definition, input, true).issues.map((i) => i.fieldKey)).toContain(
      "back_text",
    );
  });
});
