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

describe("scoped photo-only pillow intake", () => {
  it("normalizes one populated crop supplement without replacing its empty original or accepting two populated choices", () => {
    const input = pillowDraft("");
    input.fields.push({ key: "crop_scope", label: "裁切范围", kind: "text", value: "Only Face" });
    const before = structuredClone(input);
    const result = checkOrderIntakeFields(pillowDefinition(), input, true, { photoOnlyPillow: true });
    expect(result.issues).toEqual([]);
    expect(result.fields.find(field => field.key === "crop_scope")).toMatchObject({ status: "mapped" });
    expect(result.normalizedDraft.fields[0]).toEqual(before.fields[0]);
    expect(result.normalizedDraft.fields[2]).toEqual({ ...before.fields[2],
      sourceKey: "crop_scope", label: "Crop scope", value: "head" });
    expect(result.normalizedDraft.images).toEqual([{ ...before.images[0]!, usage: "buyer_photo" }]);
    expect(input).toEqual(before);

    const conflicting = structuredClone(input);
    conflicting.fields[0]!.value = "Whole Body";
    const duplicate = checkOrderIntakeFields(pillowDefinition(), conflicting, true, { photoOnlyPillow: true });
    expect(duplicate.issues).toContainEqual(expect.objectContaining({ code: "duplicate_value", fieldKey: "crop_scope" }));
    expect(duplicate.normalizedDraft.fields[0]).toEqual(conflicting.fields[0]);
    expect(duplicate.normalizedDraft.fields[2]).toEqual(conflicting.fields[2]);
    expect(input).toEqual(before);
  });

  it.each([
    { crop: "Only Face", side: "Single-Sided Print", subject: "head", sides: "single_sided" },
    { crop: "Half Body", side: "Double-Sided Printing", subject: "half_body", sides: "double_sided" },
    { crop: "Whole Body", side: "Double-Sided Print — Same Photo on Back", subject: "body", sides: "double_sided" },
  ])("normalizes explicit $crop / $side without changing the selected source", ({ crop, side, subject, sides }) => {
    const input = pillowDraft(crop, side), before = structuredClone(input);
    const result = checkOrderIntakeFields(pillowDefinition(), input, true, { photoOnlyPillow: true });
    expect(result.issues).toEqual([]);
    expect(result.normalizedDraft.fields).toEqual([
      { key: "crop_scope", sourceKey: "surface-0-field-0", label: "Crop scope", kind: "choice", value: subject },
      { key: "print_sides", sourceKey: "surface-0-field-1", label: "Print sides", kind: "choice", value: sides },
    ]);
    expect(result.normalizedDraft.images).toEqual([{ ...input.images[0]!, usage: "buyer_photo" }]);
    expect(result.fields.find(field => field.key === "buyer_photo")).toMatchObject({ status: "mapped", imageCount: 1 });
    expect(input).toEqual(before);
    expect(OrderWorkDraftSchema.safeParse(result.normalizedDraft).success).toBe(true);
  });

  it("keeps aliases opt-in and reports unmatched selected images even for a manual intake", () => {
    const input = pillowDraft(), result = checkOrderIntakeFields(pillowDefinition(), input, false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "unmapped_image", action: expect.any(String) }));
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "missing_required", fieldKey: "buyer_photo" }));
    expect(result.normalizedDraft).toEqual(input);
  });

  it("preserves free image uses for a non-strict legacy template without image fields", () => {
    const definition: CustomizationDefinition = { version: 1, fields: [schema.fields[0]!] }, input = draft();
    input.images[0]!.usage = "Synthetic free reference use";
    const result = checkOrderIntakeFields(definition, input, false);
    expect(result.issues).toEqual([]);
    expect(result.normalizedDraft.images).toEqual(input.images);
    expect(checkOrderIntakeFields(definition, input, true).issues)
      .toContainEqual(expect.objectContaining({ code: "unmapped_image" }));
  });

  it("retains an upload filename marker but never treats it as a selected original", () => {
    const input = pillowDraft();
    input.fields.push({ key: "surface-0-field-2", label: "Upload One Clear Photo", kind: "image", value: "synthetic-buyer.png" });
    input.images = [];
    const result = checkOrderIntakeFields(pillowDefinition(), input, true, { photoOnlyPillow: true });
    expect(result.issues).toEqual([expect.objectContaining({ code: "missing_required", fieldKey: "buyer_photo" })]);
    expect(result.normalizedDraft.images).toEqual([]);
    expect(result.normalizedDraft.fields[2]).toMatchObject({ key: "buyer_photo", kind: "image", value: "synthetic-buyer.png" });
    expect(input.fields[2]!.key).toBe("surface-0-field-2");
  });

  it("accepts the explicit upload marker together with a separately selected original", () => {
    const input = pillowDraft();
    input.fields.push({ key: "provider-image", label: "Upload One Clear Photo", kind: "image", value: "synthetic-buyer.png" });
    const result = checkOrderIntakeFields(pillowDefinition(), input, true, { photoOnlyPillow: true });
    expect(result.issues).toEqual([]);
    expect(result.normalizedDraft.fields[2]).toMatchObject({ key: "buyer_photo", value: "synthetic-buyer.png" });
    expect(result.normalizedDraft.images).toEqual([{ origin: "report", key: "synthetic-original", usage: "buyer_photo" }]);
  });

  it("does not reinterpret a text filename as image evidence", () => {
    const input = pillowDraft();
    input.fields.push({ key: "provider-image", label: "Upload One Clear Photo", kind: "text", value: "synthetic-buyer.png" });
    input.images = [];
    const result = checkOrderIntakeFields(pillowDefinition(), input, true, { photoOnlyPillow: true });
    expect(result.issues.map(issue => issue.code)).toEqual(expect.arrayContaining(["invalid_value", "missing_required"]));
    expect(result.normalizedDraft.fields[2]).toEqual(input.fields[2]);
  });

  it("requires one selected original even when a schema permits more files", () => {
    const definition = pillowDefinition(), image = definition.fields[0]!;
    if (image.type !== "image") throw new Error("Synthetic image field expected");
    image.validation = { ...image.validation, maxFiles: 2 };
    const input = pillowDraft();
    input.images.push({ origin: "upload", key: "synthetic-second", usage: "buyer_photo" });
    const result = checkOrderIntakeFields(definition, input, true, { photoOnlyPillow: true });
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "duplicate_value", fieldKey: "buyer_photo" }));
    expect(result.normalizedDraft.images).toHaveLength(2);
  });

  it("does not guess an image target from front/back uses or multiple image fields", () => {
    const definition = pillowDefinition();
    definition.fields.push({ key: "back_photo", label: "Back photo", type: "image", required: false,
      validation: { maxFiles: 1, maxBytes: 1_000_000, allowedMediaTypes: ["image/png"] } });
    const input = pillowDraft();
    input.fields.push({ key: "provider-image", label: "Upload One Clear Photo", kind: "image", value: "synthetic.png" });
    const result = checkOrderIntakeFields(definition, input, true, { photoOnlyPillow: true });
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "unmapped_image" }));
    expect(result.normalizedDraft.images).toEqual(input.images);
    expect(result.normalizedDraft.fields[2]).toEqual(input.fields[2]);
    input.images[0]!.usage = "背面";
    expect(checkOrderIntakeFields(pillowDefinition(), input, false, { photoOnlyPillow: true }).issues)
      .toContainEqual(expect.objectContaining({ code: "unmapped_image" }));
  });

  it.each([
    { index: 1, value: "Double-Sided Print — Different Photo on Back", fieldKey: "print_sides" },
  ])("keeps unknown $fieldKey values intact with an explicit problem", ({ index, value, fieldKey }) => {
    const input = pillowDraft();
    input.fields[index]!.value = value;
    const result = checkOrderIntakeFields(pillowDefinition(), input, false, { photoOnlyPillow: true });
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "invalid_value", fieldKey }));
    expect(result.normalizedDraft.fields[index]).toEqual(input.fields[index]);
    expect(JSON.stringify(result.issues)).not.toContain(value);
  });

  it("preserves a human operator's custom crop as validated short text", () => {
    const input = pillowDraft("Keep the original hat and shoulders");
    input.designExecutor = "human";
    const result = checkOrderIntakeFields(pillowDefinition(), input, false, { photoOnlyPillow: true });
    expect(result.issues).toEqual([]);
    expect(result.normalizedDraft.fields[0]).toMatchObject({ key: "crop_scope", value: input.fields[0]!.value });
    expect(result.normalizedDraft.designExecutor).toBe("human");
    expect(input.fields[0]!.key).toBe("surface-0-field-0");
  });

  it("retains ordinary short-text validation for a custom crop", () => {
    const definition = pillowDefinition(), field = definition.fields.find(value => value.key === "crop_scope");
    if (field?.type !== "short_text") throw new Error("Synthetic crop field expected");
    field.validation = { minLength: 3, maxLength: 10, pattern: "^[A-Z ]+$" };
    for (const value of ["AB", "CUSTOM CROP WITH HAT", "crop!"]) {
      const input = pillowDraft(value);
      input.designExecutor = "human";
      const result = checkOrderIntakeFields(definition, input, false, { photoOnlyPillow: true });
      expect(result.issues).toContainEqual(expect.objectContaining({ code: "invalid_value", fieldKey: "crop_scope" }));
      expect(result.normalizedDraft.fields[0]).toEqual(input.fields[0]);
    }
  });

  it("does not collapse a provider alias and a canonical field into a winner", () => {
    const input = pillowDraft();
    input.fields.push({ key: "print_sides", label: "Print sides", kind: "choice", value: "double_sided" });
    const result = checkOrderIntakeFields(pillowDefinition(), input, true, { photoOnlyPillow: true });
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "duplicate_value", fieldKey: "print_sides" }));
    expect(result.normalizedDraft.fields[1]).toEqual(input.fields[1]);
    expect(result.normalizedDraft.fields[2]).toEqual(input.fields[2]);
  });

  it("preserves size, font, seller notes, instructions and the selected executor", () => {
    const input = pillowDraft();
    input.fields.push(
      { key: "provider-size", label: "Size", kind: "choice", value: "10 inch-Mini Keepsake" },
      { key: "provider-font", label: "Font", kind: "text", value: "Synthetic special font" },
      { key: "provider-note", label: "Order Notes for Seller", kind: "text", value: "Synthetic special placement request" },
    );
    input.instructions = "Synthetic manual review required";
    const result = checkOrderIntakeFields(pillowDefinition(), input, false, { photoOnlyPillow: true });
    expect(result.normalizedDraft.fields[2]).toEqual(input.fields[2]);
    expect(result.normalizedDraft.fields[3]).toEqual(input.fields[3]);
    expect(result.normalizedDraft.fields[4]).toMatchObject({ key: "customer_notes", value: input.fields[4]!.value });
    expect(result.normalizedDraft.designExecutor).toBe("agent");
    expect(result.normalizedDraft.instructions).toBe(input.instructions);
  });

  it("persists a uniquely mapped ordinary choice value outside pillow mode", () => {
    const definition: CustomizationDefinition = { ...schema, fields: [...schema.fields,
      { key: "thread", label: "Thread color", type: "single_choice", required: true, options: [{ value: "pink", label: "Pink" }] }] };
    const input = draft();
    input.fields.push({ key: "provider-choice", label: "Thread color", kind: "choice", value: "Pink" });
    const result = checkOrderIntakeFields(definition, input, true);
    expect(result.issues).toEqual([]);
    expect(result.normalizedDraft.fields[1]).toEqual({ key: "thread", sourceKey: "provider-choice", label: "Thread color", kind: "choice", value: "pink" });
    expect(input.fields[1]!.value).toBe("Pink");
  });
});

function pillowDefinition(): CustomizationDefinition {
  return { version: 1, fields: [
    { key: "buyer_photo", label: "Buyer photo", type: "image", required: true, validation: { maxFiles: 1, maxBytes: 1_000_000, allowedMediaTypes: ["image/png"] } },
    { key: "crop_scope", label: "Crop scope", type: "short_text", required: true },
    { key: "print_sides", label: "Print sides", type: "single_choice", required: true, options: [
      { value: "single_sided", label: "Single sided printing" }, { value: "double_sided", label: "Double sided printing" },
    ] },
    { key: "customer_notes", label: "Customer notes", type: "short_text", required: false },
  ] };
}

function pillowDraft(crop = "Only Face", side = "Single-Sided Print") {
  return OrderWorkDraftSchema.parse({ ...draft(), designExecutor: "agent", fields: [
    { key: "surface-0-field-0", label: "Pillow Shape", kind: "choice", value: crop },
    { key: "surface-0-field-1", label: "Style", kind: "choice", value: side },
  ], images: [{ origin: "report", key: "synthetic-original", usage: "正面" }] });
}
