import type { CustomizationField } from "@yummyai/contracts";
import { ORDER_WORK_IMAGE_PENDING_USAGE, type OrderIntakeCheck, type OrderWorkDetail, type OrderWorkDraft } from "@yummyai/contracts/order/workspace";

export function defaultOrderImageUsage(fields: readonly CustomizationField[]) {
  const images = fields.filter(field => field.type === "image");
  return images.length === 1 ? images[0]!.key : images.length ? "" : "正面";
}

export const ORDER_IMAGE_LIMIT = 30;

export function orderImageUploadProblem(_detail: Pick<OrderWorkDetail, "assets">, draft: OrderWorkDraft, bytes: number) {
  if (bytes > 32 * 1024 * 1024) return "图片最大 32 MiB。";
  if (draft.images.length >= ORDER_IMAGE_LIMIT) return "最多选择 30 张图片，请先取消暂不使用的图片；当前填写仍保留。";
  return null;
}

export function orderImageUploadBasis(detail: OrderWorkDetail) {
  return { orderLineId: detail.line.id, revision: detail.line.revision,
    projectionVersion: detail.line.projectionVersion, reportVersionId: detail.report?.versionId ?? null,
    sourceVersionId: detail.sourceVersionId ?? null, sourceReportVersionId: detail.sourceReport?.versionId ?? null,
    sourceChanged: detail.line.sourceChanged, held: detail.line.held, archivedAt: detail.line.archivedAt ?? null,
    assetIds: detail.assets.map(asset => asset.id) };
}

export type OrderImageUploadBasis = ReturnType<typeof orderImageUploadBasis>;

/** Upload may initialize only the rev-0 attachment container, never rebase a requirement or source. */
export function orderImageUploadBasisMatches(expected: OrderImageUploadBasis, detail: OrderWorkDetail, allowContainer = false) {
  const actual = orderImageUploadBasis(detail);
  return actual.orderLineId === expected.orderLineId && actual.revision === expected.revision &&
    actual.reportVersionId === expected.reportVersionId && actual.sourceVersionId === expected.sourceVersionId &&
    actual.sourceReportVersionId === expected.sourceReportVersionId && actual.sourceChanged === expected.sourceChanged &&
    actual.held === expected.held && actual.archivedAt === expected.archivedAt &&
    (actual.projectionVersion === expected.projectionVersion || allowContainer && expected.revision === 0 &&
      actual.revision === 0 && expected.projectionVersion === 0 && actual.projectionVersion === 1);
}

/** Keep the saved baseline and every current local edit; only this upload's unique new asset is selected. */
export function mergeOrderImageUpload(expected: OrderImageUploadBasis, current: OrderWorkDetail,
  draft: OrderWorkDraft, response: OrderWorkDetail) {
  if (!orderImageUploadBasisMatches(expected, current, true) || !orderImageUploadBasisMatches(expected, response, true) ||
    response.line.projectionVersion < current.line.projectionVersion) {
    return { ok: false as const, message: "上传返回的订单版本或来源已变化，当前填写仍保留；请核对原上传结果，不重复上传或自动覆盖草稿。" };
  }
  const assets = [...new Map([...current.assets, ...response.assets].map(asset => [asset.id, asset])).values()];
  const detail = { ...current, assets, line: { ...current.line, projectionVersion: response.line.projectionVersion } };
  const added = response.assets.filter(asset => !expected.assetIds.includes(asset.id));
  if (added.length !== 1) return { ok: true as const, detail, draft, problem:
    "上传附件已读取，但无法唯一确认本次新增图片；当前填写仍保留，请明确选择图片，不重复上传。" };
  const asset = added[0]!;
  if (draft.images.some(image => image.origin === "upload" && image.key === asset.id))
    return { ok: true as const, detail, draft, problem: null };
  if (draft.images.length >= ORDER_IMAGE_LIMIT) return { ok: true as const, detail, draft,
    problem: "图片已上传，但已选图片达到 30 张；当前选择仍保留，请取消暂不使用的图片后再勾选。" };
  const fields = current.catalog?.artworks.find(art => art.id === draft.artworkVersionId)?.customization.fields ?? [];
  return { ok: true as const, detail, draft: { ...draft, images: [...draft.images,
    { origin: "upload" as const, key: asset.id, usage: defaultOrderImageUsage(fields) }] }, problem: null };
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
  if (!images.some(image => !image.usage.trim() || image.usage.trim() === ORDER_WORK_IMAGE_PENDING_USAGE)) return null;
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

export function orderDraftWithArtwork(draft: OrderWorkDraft, id: string, recipeArtworkId?: string | null,
  customizationFields: readonly CustomizationField[] = []): OrderWorkDraft {
  // An empty generic intake needs editable text rows. Existing buyer fields must
  // never gain canonical placeholders that occupy their later mapping targets.
  const fields = !draft.fields.length && id
    ? customizationFields.filter(field => field.type !== "image")
      .map(field => ({ key: field.key, label: field.label, kind: "text" as const, value: "" }))
    : draft.fields;
  return { ...draft, artworkVersionId: id || null, fields,
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
