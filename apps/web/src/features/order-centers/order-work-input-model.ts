import type { CustomizationField } from "@yummyai/contracts";
import type { OrderIntakeCheck, OrderWorkDetail, OrderWorkDraft } from "@yummyai/contracts/order/workspace";

export function defaultOrderImageUsage(fields: readonly CustomizationField[]) {
  const images = fields.filter(field => field.type === "image");
  return images.length === 1 ? images[0]!.key : images.length ? "" : "正面";
}

/** A display match only; saving and intake still validate the current fixed schema on the server. */
export function orderImageBindingField(fields: readonly CustomizationField[], usage: string) {
  const exact = fields.find(field => field.key === usage);
  if (exact) return exact.type === "image" ? exact : null;
  const identity = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const name = identity(usage);
  if (!name) return null;
  const matches = fields.filter(field => identity(field.key) === name || identity(field.label) === name);
  return matches.length === 1 && matches[0]!.type === "image" ? matches[0]! : null;
}

export function orderImageSelectionProblem(fields: readonly CustomizationField[], images: OrderWorkDraft["images"]) {
  if (!images.some(image => !image.usage.trim())) return null;
  return fields.some(field => field.type === "image")
    ? "请为已选图片选择对应图片字段，再核对或保存；暂不使用的图片可取消勾选。"
    : "请填写已选图片的制作用途，再核对或保存；暂不使用的图片可取消勾选。";
}

/** Only an explicit canonical field binding changes the editor; aliases stay editable until intake confirms them. */
export function orderSingleChoiceOptions(fields: readonly CustomizationField[], source: OrderWorkDraft["fields"][number]) {
  if (source.kind === "image") return null;
  const matches = fields.filter(field => field.key === source.key);
  if (matches.length !== 1 || matches[0]!.type !== "single_choice") return null;
  const options = matches[0]!.options;
  return options.some(option => option.value === source.value) ? options : [
    { value: source.value, label: source.value ? `原值 · ${source.value}` : "原值为空，请选择" }, ...options,
  ];
}

export function orderDraftWithArtwork(draft: OrderWorkDraft, id: string, recipeArtworkId?: string | null): OrderWorkDraft {
  // Adding empty canonical rows here used to occupy the mapping target of the original buyer fields.
  return { ...draft, artworkVersionId: id || null,
    ...(id !== recipeArtworkId ? { salesRecipeVersionId: null, salesPackageId: null } : {}) };
}

export function orderIntakeSnapshot(detail: Pick<OrderWorkDetail, "line" | "report">, draft: OrderWorkDraft) {
  return {
    orderLineId: detail.line.id,
    revision: detail.line.revision,
    sourceVersionId: detail.report?.versionId ?? null,
    input: JSON.stringify({ expectedRevision: detail.line.revision,
      expectedSourceVersionId: detail.report?.versionId ?? null, draft }),
  };
}

export type OrderIntakeSnapshot = ReturnType<typeof orderIntakeSnapshot>;
type IntakeIdentity = Pick<OrderIntakeCheck, "orderLineId" | "revision" | "sourceVersionId">;
export function orderIntakeReceiptMatches(check: IntakeIdentity, snapshot: OrderIntakeSnapshot) {
  return check.orderLineId === snapshot.orderLineId && check.revision === snapshot.revision &&
    check.sourceVersionId === snapshot.sourceVersionId;
}

export function orderIntakeResultCurrent(result: { check: IntakeIdentity; snapshot: OrderIntakeSnapshot }, current: OrderIntakeSnapshot) {
  return orderIntakeReceiptMatches(result.check, result.snapshot) &&
    result.snapshot.orderLineId === current.orderLineId && result.snapshot.revision === current.revision &&
    result.snapshot.sourceVersionId === current.sourceVersionId && result.snapshot.input === current.input;
}
