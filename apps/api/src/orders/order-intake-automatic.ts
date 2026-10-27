import { ConflictException } from "@nestjs/common";
import type { CustomizationDefinition } from "@yummyai/contracts";
import type { ArtworkLayout } from "@yummyai/contracts/catalog/artwork";
import { orderDesignExecutor, type OrderIntakeCheck } from "@yummyai/contracts/order/workspace";
import { pillowCropSubject } from "@yummyai/contracts/order/production-requirements";
import type { ProductionEditorDocument } from "@yummyai/contracts/pod/production-editor";
import { assertAutomaticArtwork } from "../design/order-artwork-layout.js";
import type { OrderRequirementInterpretation } from "@yummyai/contracts/order/requirement-interpretation";

type FieldCheck = Pick<OrderIntakeCheck, "fields" | "issues" | "normalizedDraft">;

/** Explain known independent requirements; the original executor remains the authority. */
export function orderAutomaticIntakeIssues(
  customization: CustomizationDefinition,
  layout: ArtworkLayout,
  check: FieldCheck,
  productType?: ProductionEditorDocument["productType"],
  photoOnlyPillow = false,
  requirements?: OrderRequirementInterpretation,
): OrderIntakeCheck["issues"] {
  const draft = check.normalizedDraft;
  if (orderDesignExecutor(draft) !== "agent") return [];
  let failure: ConflictException;
  try {
    assertAutomaticArtwork(customization, layout, draft, productType, photoOnlyPillow, requirements);
    return [];
  } catch (error) {
    if (!(error instanceof ConflictException)) throw error;
    failure = error;
  }

  const issues: OrderIntakeCheck["issues"] = [];
  const blocked = (key: string) => check.issues.some(issue => issue.fieldKey === key) ||
    check.fields.some(field => field.key === key && ["missing", "conflict", "inactive"].includes(field.status));
  const label = (key: string) => customization.fields.find(field => field.key === key)?.label ?? key;
  const add = (fieldKey: string | null, message: string, action: string) => {
    if (!issues.some(issue => issue.fieldKey === fieldKey && issue.message === message))
      issues.push({ code: "automatic_artwork_not_ready", fieldKey, message, action });
  };
  const preparationAction = "保留顾客原文，先核对需求解释与本单制作参数；无人设计出稿后由运营审核，需要修改时再打回美工。";

  if (requirements) {
    const pending = requirements.unresolved[0];
    const target = pending && requirements.coverage.find(item => pending.sourceFieldKeys.includes(item.sourceFieldKey) && item.targetFieldKey)?.targetFieldKey;
    return [{ code: "automatic_artwork_not_ready", fieldKey: target ?? null,
      message: pending?.message ?? failure.message, action: preparationAction }];
  }

  if (draft.instructions.trim()) add("instructions", "制作说明尚未固定到无人设计需求解释中，请先核对完整要求。", preparationAction);

  // Only identify the same photo-only branch as the original planner. This is
  // diagnostic selection, not a second accepting implementation of its rules.
  const pillow = photoOnlyPillow && productType === "shaped_pillow" && !layout.length &&
    customization.fields.some(field => field.key === "buyer_photo" && field.type === "image") &&
    customization.fields.some(field => field.key === "crop_scope" && field.type === "short_text") &&
    customization.fields.some(field => field.key === "print_sides" && field.type === "single_choice");
  if (pillow) {
    const notes = draft.fields.filter(field => field.key === "customer_notes" && field.value.trim());
    if (notes.length === 1 && !blocked("customer_notes"))
      add("customer_notes", `“${label("customer_notes")}”已填写，需先固定原文与本次无人设计需求解释。`, preparationAction);
    const crops = draft.fields.filter(field => field.key === "crop_scope" && field.value.trim());
    if (crops.length === 1 && !blocked("crop_scope") && !pillowCropSubject(crops[0]!.value))
      add("crop_scope", `“${label("crop_scope")}”包含非标准裁切要求，需明确本次制作参数。`, preparationAction);
    const sides = draft.fields.filter(field => field.key === "print_sides" && field.value.trim());
    if (sides.length === 1 && !blocked("print_sides") && !["single_sided", "double_sided"].includes(sides[0]!.value.trim()))
      add("print_sides", `“${label("print_sides")}”的固定选项尚未接入当前自动制图规则。`, preparationAction);
  }
  for (const field of draft.fields) {
    // Font/Font Color selector values are metadata, not printable words. Only
    // an actual fixed text field with its own print placement establishes that role.
    const printable = customization.fields.find(target => target.key === field.key &&
      ["short_text", "long_text"].includes(target.type) && layout.some(placement => placement.fieldKey === target.key));
    if (!printable || field.kind === "image" || !field.value.trim() || !(field.font || field.color) || blocked(field.key)) continue;
    add(field.key, `“${printable.label}”的已填内容带有指定字体或颜色，需核对真实字体素材与色值。`, preparationAction);
  }
  if (issues.length) return issues;

  // Missing/invalid intake data already has its own precise issue. The original
  // planner stops at its first error, so an unlocated error at this point cannot
  // establish another independent automatic-capability problem.
  const matches = customization.fields.filter(field => failure.message.endsWith(`：${field.label}`) ||
    failure.message.endsWith(`: ${field.label}`));
  const fieldKey = matches.length === 1 ? matches[0]!.key : null;
  if (check.issues.length && (!fieldKey || blocked(fieldKey))) return [];
  return [{ code: "automatic_artwork_not_ready", fieldKey, message: failure.message,
    action: failure.message.includes("定制区域")
      ? "在本单固定印花版本中配置并审核对应定制区域，保留顾客全部内容后重新核对。"
      : preparationAction }];
}
