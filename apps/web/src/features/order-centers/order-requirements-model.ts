import { orderRequirementDraftInput, type OrderRequirementInterpretation, type OrderRequirementSource } from "@yummyai/contracts/order/requirement-interpretation";
import type { OrderWorkDetail, OrderWorkDraft } from "@yummyai/contracts/order/workspace";
import { orderReviewCheckCurrent, type OrderReviewCheckState } from "./order-review-model";

export function orderRequirementContextCurrent(value: OrderRequirementInterpretation, detail: OrderWorkDetail, draft: OrderWorkDraft) {
  const basis = value.basis;
  // Other recipe/editor pins are server-owned; only compare a template source that this DTO actually exposes.
  const template = !draft.salesRecipeVersionId && detail.profile?.versionId === draft.printProfileVersionId
    ? detail.profile.sourceVersionId : undefined;
  return basis.orderLineId === detail.line.id && basis.revision === detail.line.revision &&
    basis.projectionVersion === detail.line.projectionVersion && basis.sourceVersionId === (detail.report?.versionId ?? null) &&
    basis.artworkVersionId === (draft.artworkVersionId ?? null) && basis.specificationVersionId === (draft.specificationVersionId ?? null) &&
    basis.printProfileVersionId === draft.printProfileVersionId && (template === undefined || basis.templateVersionId === template);
}

export function orderRequirementField(draft: OrderWorkDraft, sourceKey: string) {
  const fields = draft.fields.filter(field => (field.sourceKey ?? field.key) === sourceKey);
  return fields.length === 1 ? fields[0]! : null;
}

/** The request check can include unsaved operator sources that the immutable report cannot contain. */
export async function orderRequirementAdoptionSources(detail: OrderWorkDetail, draft: OrderWorkDraft,
  state: OrderReviewCheckState | null, sourceKeys: readonly string[]) {
  const requirements = state && orderReviewCheckCurrent(state, detail, draft) ? state.check?.requirements : null;
  if (requirements) {
    if (!orderRequirementContextCurrent(requirements, detail, draft)) throw new Error("当前字段核对依据已变化 请重新核对后采用建议");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(orderRequirementDraftInput(draft)));
    const hash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
    if (hash !== requirements.basis.draftChecksum) throw new Error("当前字段核对摘要不一致 原始填写未改变 请重新核对");
    if (sourceKeys.every(key => requirements.sources.some(source => source.sourceFieldKey === key))) return requirements.sources;
    throw new Error("本次建议包含尚未核对来源的字段 当前填写仍保留");
  }
  const original = detail.requirementSources ?? [];
  if (sourceKeys.every(key => original.some(source => source.sourceFieldKey === key))) return original;
  throw new Error("当前新增字段尚未完成来源核对 请等待核对完成后采用原建议 不必重新调用模型");
}

/** Only source-backed text groups and explicit operator overrides can supply styles. */
export function orderRequirementTextGroups(sources: readonly OrderRequirementSource[], draft: OrderWorkDraft) {
  return sources.filter(source => source.role === "text").map(source => {
    const field = orderRequirementField(draft, source.sourceFieldKey);
    const fonts = sources.filter(row => row.role === "font" && row.groupKey === source.groupKey && row.targetTextKey === source.sourceFieldKey);
    const colors = sources.filter(row => row.role === "color" && row.groupKey === source.groupKey && row.targetTextKey === source.sourceFieldKey);
    const font = source.requestedFont !== null ? source : fonts.length === 1 ? fonts[0]! : null;
    const color = source.colorHex !== null || source.colorLabel !== null ? source : colors.length === 1 ? colors[0]! : null;
    const text = field?.value ?? source.value;
    const requestedFont = field?.styleOverride?.font ?? font?.requestedFont ?? null;
    const requestedColor = field?.styleOverride?.colorHex ?? color?.colorHex ?? null;
    return { source, field, text, included: !!field, needsPrinting: !!text.trim(),
      font: requestedFont,
      colorLabel: field?.styleOverride?.colorHex ?? color?.colorLabel ?? null,
      colorHex: requestedColor,
      // An old field value is evidence to check, not an operator style confirmation.
      legacyFont: source.origin !== "amazon_raw" && !requestedFont && field?.styleOverride?.font === undefined && field?.font?.trim() ? field.font : null,
      legacyColor: source.origin !== "amazon_raw" && !requestedColor && field?.styleOverride?.colorHex === undefined && field?.color?.trim() ? field.color : null };
  });
}

export function orderRequirementWithText(draft: OrderWorkDraft, source: OrderRequirementSource, text: string): OrderWorkDraft {
  const field = orderRequirementField(draft, source.sourceFieldKey);
  if (!field) return draft;
  return { ...draft, fields: draft.fields.map(row => row === field ? { ...row, sourceKey: row.sourceKey ?? source.sourceFieldKey, value: text } : row) };
}

export function orderRequirementWithStyle(draft: OrderWorkDraft, sourceKey: string, font: string, colorHex: string): OrderWorkDraft {
  const field = orderRequirementField(draft, sourceKey), cleanFont = font.trim(), cleanColor = colorHex.trim();
  if (!field || !field.value.trim()) throw new Error("请先填写本组需要印刷的文字");
  if (cleanFont.length > 500 || cleanColor && !/^#[a-fA-F0-9]{6}$/.test(cleanColor)) throw new Error("请填写真实的 #RRGGBB 色值 字体最多 500 字");
  if (!cleanFont && !cleanColor) return draft;
  return { ...draft, fields: draft.fields.map(row => row === field ? { ...row, sourceKey: row.sourceKey ?? sourceKey,
    ...(cleanFont ? { font: cleanFont } : {}), ...(cleanColor ? { color: cleanColor } : {}),
    styleOverride: { ...row.styleOverride, source: "operator", ...(cleanFont ? { font: cleanFont } : {}), ...(cleanColor ? { colorHex: cleanColor } : {}) } } : row) };
}
