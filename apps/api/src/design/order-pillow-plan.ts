import { ConflictException } from "@nestjs/common";
import type { CustomizationDefinition } from "@yummyai/contracts";
import type { ArtworkLayout } from "@yummyai/contracts/catalog/artwork";
import type { OrderWorkDraft } from "@yummyai/contracts/order/workspace";

export function isPhotoOnlyPillowArtwork(artwork: { mode: string; assetId: string | null; materials: Array<{ role: string }> }) {
  return artwork.mode === "customer_image" && !artwork.assetId && artwork.materials.every((m) => m.role === "reference");
}

/** The photo-only pillow recipe has manufacturing controls, not printable text slots. */
export function orderPillowPhotoPlan(
  productType: string | undefined,
  customization: CustomizationDefinition,
  layout: ArtworkLayout,
  draft: OrderWorkDraft,
) {
  const fields = customization.fields;
  if (
    productType !== "shaped_pillow" || layout.length ||
    !fields.some((f) => f.key === "buyer_photo" && f.type === "image") ||
    !fields.some((f) => f.key === "crop_scope" && f.type === "short_text") ||
    !fields.some((f) => f.key === "print_sides" && f.type === "single_choice")
  ) return null;

  if (draft.instructions.trim()) throw new ConflictException("自由文字制作说明需要美工核对，或先配置为明确的定制字段和区域");
  const keys = new Set(["buyer_photo", "crop_scope", "print_sides", "customer_notes"]);
  if (fields.some((f) => !keys.has(f.key) || f.visibleWhen) ||
      draft.fields.some((f) => !keys.has(f.key) || f.font || f.color) ||
      draft.images.length !== 1 || draft.images[0]?.usage !== "buyer_photo")
    throw new ConflictException("来图抱枕 Agent 需要一张明确绑定的顾客原图和标准裁切、印刷面数参数");
  for (const field of fields) {
    if (field.key === "buyer_photo") continue;
    const values = draft.fields.filter((f) => f.key === field.key);
    if (values.length > 1) throw new ConflictException(`定制内容匹配不唯一：${field.label}`);
    if (field.required && !values[0]?.value.trim()) throw new ConflictException(`缺少必填定制内容：${field.label}`);
  }
  const value = (key: string) => draft.fields.find((f) => f.key === key)?.value.trim() ?? "";
  if (value("customer_notes")) throw new ConflictException("顾客特殊要求需要核对后才能自动制图");
  const crop = value("crop_scope");
  const subject = /^(head|only face|仅头部)$/i.test(crop) ? "head" : /^(body|whole body|全身)$/i.test(crop) ? "body" : null;
  const side = value("print_sides");
  const sideMode = side === "single_sided" ? "single" : side === "double_sided" ? "double" : null;
  const sideField = fields.find((f) => f.key === "print_sides");
  if (!subject || !sideMode || sideField?.type !== "single_choice" || !sideField.options.some((o) => o.value === side))
    throw new ConflictException("来图抱枕的裁切范围或印刷面数无法唯一识别，请核对原始选项");
  return { subject, sideMode } as const;
}
