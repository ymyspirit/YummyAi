import { describe, expect, it } from "vitest";
import { CustomizationSchema } from "@yummyai/contracts";
import type { OrderWorkDetail, OrderWorkDraft } from "@yummyai/contracts/order/workspace";
import { defaultOrderImageUsage, orderDraftWithArtwork, orderImageBindingField, orderImageSelectionProblem,
  orderIntakeReceiptMatches, orderIntakeResultCurrent, orderIntakeSnapshot, orderSingleChoiceOptions } from "./order-work-input-model";

const fields = CustomizationSchema.parse({ version: 1, fields: [
  { key: "buyer_photo", label: "顾客原图", type: "image", required: true,
    validation: { allowedMediaTypes: ["image/png"], maxFiles: 1, maxBytes: 1_000_000 } },
  { key: "crop_scope", label: "裁切范围", type: "short_text", required: true },
] }).fields;
const draft = (): OrderWorkDraft => ({ artworkVersionId: "synthetic-art", printProfileVersionId: null,
  fields: [{ key: "source-shape", label: "Pillow Shape", kind: "text", value: "Only Face" },
    { key: "source-note", label: "Order Notes for Seller", kind: "text", value: "Keep the hat" }],
  images: [{ origin: "report", key: "synthetic-original", usage: "正面" }],
  instructions: "保留原始制作说明", customerApprovalRequired: true, dueAt: null,
  salesRecipeVersionId: "synthetic-recipe", salesPackageId: "synthetic-package" });
const detail = { line: { id: "synthetic-order-line", revision: 3 }, report: { versionId: "synthetic-source" } } as Pick<OrderWorkDetail, "line" | "report">;

describe("order image field binding", () => {
  it("binds a new selection to the only real image field, instead of a side label", () => {
    expect(defaultOrderImageUsage(fields)).toBe("buyer_photo");
    expect(orderImageBindingField(fields, "buyer_photo")?.key).toBe("buyer_photo");
    expect(orderImageBindingField(fields, "正面")).toBeNull();
    expect(orderImageBindingField(fields, " 顾客原图 ")?.key).toBe("buyer_photo");
  });

  it("requires a deliberate field selection when more than one image field exists", () => {
    const multiple = [...fields, { ...fields[0]!, key: "back_photo", label: "背面参考图" }];
    const usage = defaultOrderImageUsage(multiple);
    expect(usage).toBe("");
    expect(orderImageSelectionProblem(multiple, [{ origin: "upload", key: "synthetic-upload", usage }])).toContain("选择对应图片字段");
    expect(orderImageSelectionProblem(multiple, [{ origin: "upload", key: "synthetic-upload", usage: "back_photo" }])).toBeNull();
  });

  it("does not claim a duplicate label or a text field as an image binding", () => {
    const ambiguous = [...fields, { ...fields[0]!, key: "second_photo" }];
    expect(orderImageBindingField(ambiguous, "顾客原图")).toBeNull();
    expect(orderImageBindingField(ambiguous, "buyer_photo")?.key).toBe("buyer_photo");
    const collision = [{ ...fields[0]!, label: "Front" }, { key: "front", label: "Text target", type: "short_text" as const, required: false }];
    expect(orderImageBindingField(collision, "front")).toBeNull();
  });

  it("retains generic uses without an image schema and preserves existing unknown text for review", () => {
    expect(defaultOrderImageUsage([])).toBe("正面");
    expect(orderImageSelectionProblem([], [{ origin: "upload", key: "synthetic-upload", usage: "" }])).toContain("填写已选图片的制作用途");
    const value = draft(), before = structuredClone(value);
    expect(orderImageBindingField(fields, value.images[0]!.usage)).toBeNull();
    expect(orderImageSelectionProblem(fields, value.images)).toBeNull();
    expect(value).toEqual(before);
  });
});

describe("explicit artwork selection preserves buyer input", () => {
  const genericFields = CustomizationSchema.parse({ version: 1, fields: [
    { key: "pet_name", label: "Pet name", type: "short_text", required: true },
    { ...fields[0]!, key: "pet_photo", label: "Pet photo" },
  ] }).fields;

  it("provides only empty text inputs when an empty generic intake explicitly selects artwork", () => {
    const original = { ...draft(), fields: [], images: [] }, before = structuredClone(original);
    const selected = orderDraftWithArtwork(original, "synthetic-generic-art", null, genericFields);
    expect(selected.fields).toEqual([{ key: "pet_name", label: "Pet name", kind: "text", value: "" }]);
    expect(selected.images).toEqual([]);
    expect(selected.instructions).toBe(before.instructions);
    expect(original).toEqual(before);
  });

  it("does not create canonical empty fields that occupy the original field mapping target", () => {
    const original = draft(), before = structuredClone(original);
    const selected = orderDraftWithArtwork(original, "synthetic-next-art", "synthetic-art", fields);
    expect(selected.artworkVersionId).toBe("synthetic-next-art");
    expect(selected.salesRecipeVersionId).toBeNull();
    expect(selected.salesPackageId).toBeNull();
    expect(selected.fields).toEqual(before.fields);
    expect(selected.fields.some(field => field.key === "crop_scope")).toBe(false);
    expect(selected.images).toEqual(before.images);
    expect(selected.instructions).toBe(before.instructions);
    expect(selected.customerApprovalRequired).toBe(true);
    expect(original).toEqual(before);
    expect(orderDraftWithArtwork(original, "synthetic-art", "synthetic-art").salesPackageId).toBe("synthetic-package");
  });

  it("adds no placeholders when artwork is cleared or the catalog has no matching artwork", () => {
    const original = { ...draft(), fields: [] }, before = structuredClone(original);
    const cleared = orderDraftWithArtwork(original, "", null, genericFields);
    const unknown = orderDraftWithArtwork(original, "synthetic-unknown-art");
    expect(cleared.artworkVersionId).toBeNull();
    expect(cleared.fields).toEqual([]);
    expect(unknown.fields).toEqual([]);
    expect(cleared.images).toEqual(before.images);
    expect(unknown.instructions).toBe(before.instructions);
    expect(original).toEqual(before);
  });
});

describe("bound single-choice display", () => {
  const choiceFields = CustomizationSchema.parse({ version: 1, fields: [{
    key: "print_sides", label: "印刷面数", type: "single_choice", required: true,
    options: [{ value: "single_sided", label: "单面印刷" }, { value: "double_sided", label: "双面印刷" }],
  }, fields[1]!] }).fields;
  const source = { key: "print_sides", label: "印刷面数", kind: "choice" as const, value: "double_sided" };

  it("displays actual labels with canonical values after an explicit field binding", () => {
    expect(orderSingleChoiceOptions(choiceFields, source)).toEqual([
      { value: "single_sided", label: "单面印刷" }, { value: "double_sided", label: "双面印刷" },
    ]);
    expect(source.value).toBe("double_sided");
  });

  it("retains an unknown old value or empty value as a visible option without normalizing it", () => {
    const old = { ...source, value: "Double-Sided Print — Same Photo on Back" }, before = structuredClone(old);
    expect(orderSingleChoiceOptions(choiceFields, old)?.[0]).toEqual({ value: old.value, label: `原值 · ${old.value}` });
    expect(old).toEqual(before);
    expect(orderSingleChoiceOptions(choiceFields, { ...source, value: "" })?.[0]).toEqual({ value: "", label: "原值为空，请选择" });
  });

  it("leaves source aliases, short text, image markers and unavailable schema on the existing textarea path", () => {
    expect(orderSingleChoiceOptions(choiceFields, { ...source, key: "provider-style" })).toBeNull();
    expect(orderSingleChoiceOptions(choiceFields, { ...source, key: "crop_scope", value: "head" })).toBeNull();
    expect(orderSingleChoiceOptions(choiceFields, { ...source, kind: "image" })).toBeNull();
    expect(orderSingleChoiceOptions([], source)).toBeNull();
  });
});

describe("intake result belongs to one unchanged order input", () => {
  it("rejects a different order, revision or source receipt even when the body is readable", () => {
    const snapshot = orderIntakeSnapshot(detail, draft());
    const receipt = { orderLineId: snapshot.orderLineId, revision: snapshot.revision, sourceVersionId: snapshot.sourceVersionId };
    expect(orderIntakeReceiptMatches(receipt, snapshot)).toBe(true);
    expect(orderIntakeReceiptMatches({ ...receipt, orderLineId: "other-line" }, snapshot)).toBe(false);
    expect(orderIntakeReceiptMatches({ ...receipt, revision: 4 }, snapshot)).toBe(false);
    expect(orderIntakeReceiptMatches({ ...receipt, sourceVersionId: null }, snapshot)).toBe(false);
  });

  it("makes a late normalization result unusable after image, text or note edits", () => {
    const current = draft(), snapshot = orderIntakeSnapshot(detail, current);
    const result = { snapshot, check: { orderLineId: snapshot.orderLineId, revision: snapshot.revision, sourceVersionId: snapshot.sourceVersionId } };
    expect(orderIntakeResultCurrent(result, orderIntakeSnapshot(detail, structuredClone(current)))).toBe(true);
    for (const changed of [
      { ...current, images: [{ ...current.images[0]!, usage: "buyer_photo" }] },
      { ...current, fields: current.fields.map((field, index) => index ? field : { ...field, value: "Half Body" }) },
      { ...current, instructions: "Keep all original buyer notes" },
    ]) expect(orderIntakeResultCurrent(result, orderIntakeSnapshot(detail, changed))).toBe(false);
    expect(orderIntakeResultCurrent(result, { ...snapshot, orderLineId: "other-line" })).toBe(false);
    expect(orderIntakeResultCurrent(result, { ...snapshot, revision: 4 })).toBe(false);
    expect(orderIntakeResultCurrent(result, { ...snapshot, sourceVersionId: null })).toBe(false);
  });
});
