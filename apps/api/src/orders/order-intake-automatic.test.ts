import type { CustomizationDefinition } from "@yummyai/contracts";
import { OrderWorkDraftSchema, type OrderWorkDraft } from "@yummyai/contracts/order/workspace";
import { describe, expect, it } from "vitest";
import { checkOrderIntakeFields } from "./order-intake-check.js";
import { orderAutomaticIntakeIssues } from "./order-intake-automatic.js";

const schema: CustomizationDefinition = { version: 1, fields: [
  { key: "buyer_photo", label: "顾客原图", type: "image", required: true,
    validation: { allowedMediaTypes: ["image/png"], maxFiles: 1, maxBytes: 1000000 } },
  { key: "crop_scope", label: "裁切范围", type: "short_text", required: true },
  { key: "print_sides", label: "印刷面数", type: "single_choice", required: true,
    options: [{ value: "single_sided", label: "单面" }, { value: "double_sided", label: "双面" }] },
  { key: "customer_notes", label: "顾客特殊要求", type: "long_text", required: false },
] };
function draft(): OrderWorkDraft {
  return OrderWorkDraftSchema.parse({ designExecutor: "agent", printProfileVersionId: null,
    fields: [{ key: "crop_scope", label: "裁切范围", kind: "text", value: "head" },
      { key: "print_sides", label: "印刷面数", kind: "choice", value: "double_sided" },
      { key: "customer_notes", label: "顾客特殊要求", kind: "text", value: "" }],
    images: [{ origin: "report", key: "synthetic-original", usage: "buyer_photo" }],
    instructions: "", customerApprovalRequired: false, dueAt: null });
}
const check = (input: OrderWorkDraft, definition = schema) =>
  checkOrderIntakeFields(definition, input, false, { photoOnlyPillow: true });
const inspect = (input: OrderWorkDraft, definition = schema) =>
  orderAutomaticIntakeIssues(definition, [], check(input, definition), "shaped_pillow", true);

describe("automatic intake guidance uses the original executor gate", () => {
  it("locates the mapped customer note and gives a preserving manual action without inventing font requirements", () => {
    const input = draft();
    const privateNote = "Synthetic request to preserve a particular head outline";
    input.fields[2] = { key: "source-notes", label: "Order Notes for Seller", kind: "text", value: privateNote };
    input.fields.push({ key: "empty-text", label: "Custom your text", kind: "text", value: "", font: "Synthetic default font", color: "Synthetic default color" });
    const before = structuredClone(input), result = inspect(input);
    expect(result).toEqual([expect.objectContaining({ code: "automatic_artwork_not_ready", fieldKey: "customer_notes",
      message: expect.stringContaining("顾客特殊要求"), action: expect.stringContaining("改由美工制作") })]);
    expect(result[0]!.message).toContain("无法按这条特殊备注执行");
    expect(result[0]!.action).toContain("保留顾客原文");
    expect(JSON.stringify(result)).not.toContain(privateNote);
    expect(JSON.stringify(result)).not.toContain("Synthetic default font");
    expect(input).toEqual(before);
  });

  it("shows the independent filled note while the original-image requirement is still missing", () => {
    const input = draft(); input.images = []; input.fields[2]!.value = "Synthetic extra customer requirement";
    const fields = check(input), automatic = orderAutomaticIntakeIssues(schema, [], fields, "shaped_pillow", true);
    expect(fields.issues).toEqual([expect.objectContaining({ code: "missing_required", fieldKey: "buyer_photo" })]);
    expect(automatic).toEqual([expect.objectContaining({ code: "automatic_artwork_not_ready", fieldKey: "customer_notes" })]);
    expect([...fields.issues, ...automatic].filter(issue => issue.fieldKey === "buyer_photo")).toHaveLength(1);
  });

  it.each(["buyer_photo", "crop_scope", "print_sides"])("does not duplicate a missing or invalid %s as another automatic problem", fieldKey => {
    const input = draft();
    if (fieldKey === "buyer_photo") input.images = [];
    else input.fields.find(field => field.key === fieldKey)!.value = fieldKey === "crop_scope" ? "" : "unsupported-side";
    expect(check(input).issues.some(issue => issue.fieldKey === fieldKey)).toBe(true);
    expect(inspect(input)).toEqual([]);
  });

  it("presents known notes and nonstandard crop without inventing a printable role for an unplaced field", () => {
    const definition = structuredClone(schema);
    definition.fields.push({ key: "inscription", label: "顾客文字", type: "short_text", required: false });
    const input = draft();
    input.fields[0]!.value = "Synthetic custom crop with more shoulders";
    input.fields[2]!.value = "Synthetic additional placement requirement";
    input.fields.push({ key: "inscription", label: "顾客文字", kind: "text", value: "Synthetic text", font: "Synthetic chosen font" });
    const before = structuredClone(input), result = inspect(input, definition);
    expect(result.map(issue => issue.fieldKey)).toEqual(["customer_notes", "crop_scope"]);
    expect(result.find(issue => issue.fieldKey === "crop_scope")!.message).toContain("头部、全身或半身");
    expect(input).toEqual(before);
  });

  it("preserves raw Font selectors and empty Custom text while returning only the actual customer-note issue", () => {
    const input = draft(); input.fields[2]!.value = "Synthetic request for the whole head";
    input.fields.push(
      { key: "source-font", label: "Font", kind: "choice", value: "Luckiest Guy", font: "Luckiest Guy", color: "#000000" },
      { key: "source-font-color", label: "Font Color", kind: "choice", value: "CustomColor", font: "Luckiest Guy", color: "#000000" },
      { key: "source-text", label: "Custom your text", kind: "text", value: "", font: "Luckiest Guy", color: "#000000" },
    );
    const before = structuredClone(input), fields = check(input), result = inspect(input);
    expect(fields.issues).toEqual([]);
    expect(result).toEqual([expect.objectContaining({ code: "automatic_artwork_not_ready", fieldKey: "customer_notes",
      message: expect.stringContaining("特殊备注"), action: expect.stringContaining("保留顾客原文") })]);
    expect(result.some(issue => issue.message.includes("指定字体或颜色"))).toBe(false);
    expect(fields.normalizedDraft.fields.slice(-3)).toEqual(before.fields.slice(-3));
    expect(input).toEqual(before);
  });

  it("still diagnoses a font or color requirement on actual printable text", () => {
    const definition: CustomizationDefinition = { version: 1, fields: [{ key: "name", label: "刻字内容", type: "short_text", required: true }] };
    const input = draft(); input.fields = [{ key: "name", label: "刻字内容", kind: "text", value: "Synthetic inscription", font: "Selected font", color: "#000000" }]; input.images = [];
    const fields = checkOrderIntakeFields(definition, input, false), before = structuredClone(input);
    const layout = [{ fieldKey: "name", xPercent: 0, yPercent: 0, widthPercent: 100, heightPercent: 100, color: "#000000" }];
    expect(orderAutomaticIntakeIssues(definition, layout, fields, "tire_cover")).toEqual([expect.objectContaining({
      code: "automatic_artwork_not_ready", fieldKey: "name", message: expect.stringContaining("指定字体或颜色"),
      action: expect.stringContaining("改由美工制作"),
    })]);
    expect(input).toEqual(before);
  });

  it("keeps a complete manual requirement intact and leaves every ordinary intake rule active", () => {
    const input = draft(); input.designExecutor = "human";
    input.fields[0]!.value = "Synthetic custom crop with the original hat";
    input.fields[2]!.value = "Synthetic customer-specific placement";
    input.instructions = "Synthetic private production instructions";
    const before = structuredClone(input), fields = check(input);
    expect(fields.issues).toEqual([]);
    expect(orderAutomaticIntakeIssues(schema, [], fields, "shaped_pillow", true)).toEqual([]);
    expect(fields.normalizedDraft).toEqual(before);
    expect(input).toEqual(before);
    input.images = [];
    expect(check(input).issues).toContainEqual(expect.objectContaining({ code: "missing_required", fieldKey: "buyer_photo" }));
  });

  it("does not produce capability warnings for the supported standard photo-only input", () => {
    const input = draft(), before = structuredClone(input);
    expect(inspect(input)).toEqual([]);
    expect(input).toEqual(before);
  });

  it("locates a non-pillow native layout error without replacing its production rule", () => {
    const definition: CustomizationDefinition = { version: 1, fields: [{ key: "name", label: "刻字内容", type: "short_text", required: true }] };
    const input = draft(); input.fields = [{ key: "name", label: "刻字内容", kind: "text", value: "Synthetic name" }]; input.images = [];
    const fields = checkOrderIntakeFields(definition, input, false);
    expect(orderAutomaticIntakeIssues(definition, [], fields, "tire_cover")).toEqual([expect.objectContaining({
      code: "automatic_artwork_not_ready", fieldKey: "name", message: "请在印花版本中配置定制区域：刻字内容",
      action: expect.stringContaining("配置并审核对应定制区域"),
    })]);
  });

  it("locates free instructions without changing the selected executor or hiding customer text", () => {
    const input = draft(); input.instructions = "Synthetic special production instruction";
    const result = inspect(input);
    expect(result).toEqual([expect.objectContaining({ fieldKey: "instructions", action: expect.stringContaining("保留顾客原文") })]);
    expect(input.designExecutor).toBe("agent");
    expect(input.instructions).toBe("Synthetic special production instruction");
  });
});
