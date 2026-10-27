import { OrderArtworkLayoutError as ConflictException } from "./layout-error.js";
import type { ArtworkLayout } from "@yummyai/contracts/catalog/artwork";
import type { CustomizationDefinition } from "@yummyai/contracts";
import type { OrderWorkDraft } from "@yummyai/contracts/order/workspace";
import type {
  ProductionEditorDocument,
  ProductionEditorImageLayer,
  ProductionEditorTextLayer,
} from "@yummyai/contracts/pod/production-editor";
import {
  getBuiltinFont,
  parseProductionFont,
  productionTextMetrics,
} from "@yummyai/production-editor";
import { orderPillowPhotoPlan } from "./order-pillow-plan.js";
import type { OrderRequirementInterpretation } from "@yummyai/contracts/order/requirement-interpretation";

export function assertAutomaticArtwork(
  customization: CustomizationDefinition,
  layout: ArtworkLayout,
  draft: OrderWorkDraft,
  productType?: ProductionEditorDocument["productType"],
  photoOnlyPillow = false,
  requirements?: OrderRequirementInterpretation,
) {
  if (photoOnlyPillow && orderPillowPhotoPlan(productType, customization, layout, draft, requirements)) return;
  if (draft.instructions.trim()) throw new ConflictException("自由文字制作说明需要美工核对，或先配置为明确的定制字段和区域");
  const matches = (key: string) =>
    customization.fields.some((f) => f.key === key || f.label === key);
  if (
    draft.fields.some((f) => f.value.trim() && !matches(f.key) && !matches(f.label)) ||
    draft.images.some((i) => !matches(i.usage))
  )
    throw new ConflictException("存在未绑定印花字段的定制内容，请完成匹配或选择美工制作");
  for (const field of customization.fields) {
    if (field.visibleWhen || !["short_text", "long_text", "image"].includes(field.type))
      throw new ConflictException(`该定制规则需要美工处理：${field.label}`);
    if ((field.type === "short_text" || field.type === "long_text") && field.validation?.pattern)
      throw new ConflictException(`特殊文字校验需要美工处理：${field.label}`);
    const values = draft.fields.filter((f) => f.key === field.key || f.label === field.label);
    const images = draft.images.filter((i) => i.usage === field.key || i.usage === field.label);
    if (values.length > 1 || images.length > 1)
      throw new ConflictException(`定制内容匹配不唯一：${field.label}`);
    const value = values[0]?.value;
    const populated = field.type === "image" ? images.length > 0 : !!value?.trim();
    if (!populated && field.required)
      throw new ConflictException(`缺少必填定制内容：${field.label}`);
    if (!populated) continue;
    if (!layout.some((p) => p.fieldKey === field.key))
      throw new ConflictException(`请在印花版本中配置定制区域：${field.label}`);
    if (field.type === "image") continue;
    if (value && (value.length > 500 || /[\r\n]/.test(value)))
      throw new ConflictException(`文字需要人工排版：${field.label}`);
    if (values[0]?.font || values[0]?.color)
      throw new ConflictException(`指定字体或颜色需美工核对：${field.label}`);
    if (
      (field.type === "short_text" || field.type === "long_text") &&
      value &&
      ((field.validation?.maxLength !== undefined && value.length > field.validation.maxLength) ||
        (field.validation?.minLength !== undefined && value.length < field.validation.minLength))
    )
      throw new ConflictException(`文字长度不符合要求：${field.label}`);
  }
}

/** Deterministic template executor. Buyer data is handled inside the private order editor. */
export async function composeOrderArtwork(
  document: ProductionEditorDocument,
  layout: ArtworkLayout,
  customization: CustomizationDefinition,
  draft: OrderWorkDraft,
  images: Array<{ usage: string; id: string; version: number; width: number; height: number }>,
  photoOnlyPillow = false,
  requirements?: OrderRequirementInterpretation,
) {
  assertAutomaticArtwork(customization, layout, draft, document.productType, photoOnlyPillow, requirements);
  const pillow = photoOnlyPillow ? orderPillowPhotoPlan(document.productType, customization, layout, draft, requirements) : null;
  if (pillow && document.productType === "shaped_pillow") {
    if (images.length !== 1 || images[0]?.usage !== "buyer_photo")
      throw new ConflictException("来图抱枕缺少唯一的已绑定原图");
    const source = images[0];
    const result = structuredClone(document);
    const scale = result.spec.declaredLongestMm! / Math.max(source.width, source.height);
    if (!Number.isFinite(scale) || scale <= 0) throw new ConflictException("来图抱枕缺少确认的成品最长边");
    result.spec.sideMode = pillow.sideMode;
    result.spec.artworkClipMode = "none";
    result.exportBackground = "white";
    result.layers = [{ id: "custom_buyer_photo", name: pillow.subject === "head" ? "顾客图片 · 待头部抠图" : pillow.subject === "half_body" ? "顾客图片 · 待半身抠图" : "顾客图片 · 待全身抠图", kind: "image", assetId: source.id, assetVersion: source.version, widthMm: source.width * scale, heightMm: source.height * scale, xMm: result.spec.whiteBorderMm, yMm: result.spec.whiteBorderMm, rotationDeg: 0, opacity: 1, visible: true, locked: false, flipX: false, flipY: false }];
    result.confirmations = { ...result.confirmations, physicalSize: false, narrowParts: false, backText: false, visualReview: false };
    return result;
  }
  const width =
    document.productType === "tire_cover" ? document.spec.diameterMm : document.spec.widthMm;
  const height =
    document.productType === "tire_cover" ? document.spec.diameterMm : document.spec.heightMm;
  const result = structuredClone(document);
  const font = parseProductionFont((await getBuiltinFont("geist_regular")).bytes);
  for (const field of customization.fields) {
    const placement = layout.find((p) => p.fieldKey === field.key);
    const values = draft.fields.filter((f) => f.key === field.key || f.label === field.label);
    if (values.length > 1) throw new ConflictException(`定制字段匹配不唯一：${field.label}`);
    const value = values[0]?.value;
    const selected = images.filter((i) => i.usage === field.key || i.usage === field.label);
    if (field.type === "image" && selected.length > 1)
      throw new ConflictException(`自动排版每个图片区域只支持一张原图：${field.label}`);
    if (field.type === "image" ? !selected.length : !value?.trim()) {
      if (field.required) throw new ConflictException(`缺少必填定制内容：${field.label}`);
      continue;
    }
    if (!placement) throw new ConflictException(`请在印花版本中配置定制区域：${field.label}`);
    if (placement.surface === "back" && (document.productType !== "shaped_pillow" || document.spec.sideMode !== "double")) throw new ConflictException("反面定制区域需要供应商双面工艺模板");
    const xMm = (placement.xPercent * width) / 100,
      yMm = (placement.yPercent * height) / 100;
    const boxWidth = (placement.widthPercent * width) / 100,
      boxHeight = (placement.heightPercent * height) / 100;
    const base = {
      ...(placement.surface ? { surface: placement.surface } : {}),
      id: `custom_${field.key}`,
      name: field.label,
      xMm,
      yMm,
      rotationDeg: 0,
      opacity: 1,
      visible: true,
      locked: false,
    };
    result.layers = result.layers.filter((l) => l.id !== base.id);
    if (field.type === "image") {
      const source = selected[0]!,
        scale = Math.min(boxWidth / source.width, boxHeight / source.height);
      const layer: ProductionEditorImageLayer = {
        ...base,
        kind: "image",
        assetId: source.id,
        assetVersion: source.version,
        widthMm: source.width * scale,
        heightMm: source.height * scale,
        xMm: xMm + (boxWidth - source.width * scale) / 2,
        yMm: yMm + (boxHeight - source.height * scale) / 2,
        flipX: false,
        flipY: false,
      };
      result.layers.push(layer);
    } else {
      if (!value || value.length > 500 || value.includes("\n"))
        throw new ConflictException(`文字需要人工排版：${field.label}`);
      if (
        (field.type === "short_text" || field.type === "long_text") &&
        ((field.validation?.maxLength && value.length > field.validation.maxLength) ||
          (field.validation?.minLength && value.length < field.validation.minLength))
      )
        throw new ConflictException(`文字长度不符合要求：${field.label}`);
      if (values[0]?.font) throw new ConflictException(`指定字体需美工核对：${field.label}`);
      const textLayer: ProductionEditorTextLayer = {
        ...base,
        kind: "text",
        text: value,
        fontId: "geist_regular",
        fontSizeMm: 1,
        letterSpacingMm: 0,
        color: placement.color,
        arc: null,
      };
      const metrics = productionTextMetrics(font, textLayer);
      if (metrics.glyphs.some((glyph) => glyph.index === 0))
        throw new ConflictException(`默认字体不支持部分字符，请交给美工选择字体：${field.label}`);
      const unitWidth = metrics.advances.reduce((sum, n) => sum + n, 0);
      const boxes = metrics.glyphs.map((glyph) => glyph.getBoundingBox());
      const top = Math.max(...boxes.map((box) => box.y2)) / font.unitsPerEm;
      const bottom = Math.min(...boxes.map((box) => box.y1)) / font.unitsPerEm;
      const fontSizeMm = Math.min(boxHeight * 0.75, boxWidth / Math.max(unitWidth, 0.001));
      textLayer.fontSizeMm = fontSizeMm;
      textLayer.xMm = xMm + (boxWidth - unitWidth * fontSizeMm) / 2;
      textLayer.yMm = yMm + (boxHeight - (top - bottom) * fontSizeMm) / 2 + top * fontSizeMm;
      result.layers.push(textLayer);
    }
  }
  result.confirmations.visualReview = false;
  return result;
}

