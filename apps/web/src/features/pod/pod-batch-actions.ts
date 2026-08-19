"use server";

/* eslint-disable @typescript-eslint/no-unused-vars -- useActionState requires the previous-state parameter */

import {
  CreateCanvasPrintSpecVersionInputSchema,
  CreateCreativeDesignBatchInputSchema,
  CreateCreativeDesignSkuBindingsInputSchema,
  CreateMockupBatchInputSchema,
  CreateMockupListingBindingsInputSchema,
  CreateMockupTemplateInspectionInputSchema,
  CreateMockupTemplatePackVersionInputSchema,
  ReviewMockupBatchInputSchema,
  ReviewVersionInputSchema,
} from "@yummyai/contracts/pod/batch-workflows";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { revalidatePath } from "next/cache";

import { apiFetch } from "../../server-api";

export interface PodBatchActionState {
  status: "idle" | "success" | "error";
  message: string;
}

const idle: PodBatchActionState = { status: "idle", message: "" };
const EntityId = EntityIdSchema;
const CREATIVE_DESIGNS_PATH = "/creative-designs";

export async function createDesignBatch(_state: PodBatchActionState = idle, formData: FormData): Promise<PodBatchActionState> {
  return postParsed("/v1/pod/design-batches", parseJson(formData, "payload", CreateCreativeDesignBatchInputSchema), "批量设计已提交。", [CREATIVE_DESIGNS_PATH]);
}

export async function selectCreativeCandidates(_state: PodBatchActionState = idle, formData: FormData): Promise<PodBatchActionState> {
  const batchId = EntityId.safeParse(text(formData, "batchId"));
  const candidateIds = EntityId.array().min(1).safeParse(formData.getAll("candidateId"));
  if (!batchId.success || !candidateIds.success) return failure("至少选择一个已生成候选。 ");
  const results = await Promise.all(candidateIds.data.map((candidateId) => post(
    `/v1/pod/design-batches/${batchId.data}/candidates/${candidateId}/select`, {},
  )));
  const failed = results.filter((result) => !result.ok);
  revalidatePath(CREATIVE_DESIGNS_PATH);
  return failed.length ? failure(`${failed.length} 个候选未能进入画幅适配。`) : success(`${results.length} 个候选已进入画幅适配。`);
}

export async function retryCreativeItem(_state: PodBatchActionState = idle, formData: FormData) {
  return idAction(formData, ["batchId", "itemId"], ([batchId, itemId]) => `/v1/pod/design-batches/${batchId}/items/${itemId}/retry`, "失败候选已重新排队。", CREATIVE_DESIGNS_PATH);
}

export async function cancelDesignBatch(_state: PodBatchActionState = idle, formData: FormData) {
  return idAction(formData, ["batchId"], ([batchId]) => `/v1/pod/design-batches/${batchId}/cancel`, "批量设计已取消。", CREATIVE_DESIGNS_PATH);
}

export async function reviewCreativeVersion(_state: PodBatchActionState = idle, formData: FormData): Promise<PodBatchActionState> {
  const versionId = EntityId.safeParse(text(formData, "versionId"));
  const parsed = ReviewVersionInputSchema.safeParse({
    decision: text(formData, "decision"),
    ...(text(formData, "rejectionReason") ? { rejectionReason: text(formData, "rejectionReason") } : {}),
  });
  if (!versionId.success || !parsed.success) return failure("创意审核参数无效，驳回时必须填写原因。 ");
  return postParsed(`/v1/pod/creative-design-versions/${versionId.data}/review`, parsed, "创意版本审核已保存。", [CREATIVE_DESIGNS_PATH]);
}

export async function bindCreativeSkus(_state: PodBatchActionState = idle, formData: FormData): Promise<PodBatchActionState> {
  const versionId = EntityId.safeParse(text(formData, "versionId"));
  const skuIds = formData.getAll("skuId");
  const specId = text(formData, "printSpecVersionId");
  const parsed = CreateCreativeDesignSkuBindingsInputSchema.safeParse({ bindings: skuIds.map((skuId) => ({ skuId, printSpecVersionId: specId })) });
  if (!versionId.success || !parsed.success) return failure("请选择至少一个 SKU 和兼容的印刷规格。 ");
  return postParsed(`/v1/pod/creative-design-versions/${versionId.data}/sku-bindings`, parsed, "正式设计版本已按 SKU 创建。", [CREATIVE_DESIGNS_PATH, "/design"]);
}

export async function createPrintSpec(_state: PodBatchActionState = idle, formData: FormData): Promise<PodBatchActionState> {
  return postParsed("/v1/pod/print-specs", parseJson(formData, "payload", CreateCanvasPrintSpecVersionInputSchema), "印刷规格草稿已创建。", [CREATIVE_DESIGNS_PATH]);
}

export async function reviewPrintSpec(_state: PodBatchActionState = idle, formData: FormData): Promise<PodBatchActionState> {
  const versionId = EntityId.safeParse(text(formData, "versionId"));
  const parsed = ReviewVersionInputSchema.safeParse({ decision: text(formData, "decision"), ...(text(formData, "rejectionReason") ? { rejectionReason: text(formData, "rejectionReason") } : {}) });
  if (!versionId.success || !parsed.success) return failure("印刷规格审核参数无效，驳回时必须填写原因。 ");
  return postParsed(`/v1/pod/print-specs/${versionId.data}/review`, parsed, "印刷规格审核已保存。", [CREATIVE_DESIGNS_PATH, "/pod-workbench/mockup-batches"]);
}

export async function createTemplateInspection(_state: PodBatchActionState = idle, formData: FormData): Promise<PodBatchActionState> {
  return postParsed("/v1/pod/mockup-template-inspections", parseJson(formData, "payload", CreateMockupTemplateInspectionInputSchema), "PSD 模板已进入受控编译。", ["/pod-workbench/mockup-batches"]);
}

export async function confirmTemplateInspection(_state: PodBatchActionState = idle, formData: FormData) {
  return idAction(formData, ["inspectionId"], ([id]) => `/v1/pod/mockup-template-inspections/${id}/confirm`, "PSD 编译结果已确认。", "/pod-workbench/mockup-batches");
}

export async function createTemplatePack(_state: PodBatchActionState = idle, formData: FormData): Promise<PodBatchActionState> {
  return postParsed("/v1/pod/mockup-template-packs", parseJson(formData, "payload", CreateMockupTemplatePackVersionInputSchema), "模板包版本草稿已创建。", ["/pod-workbench/mockup-batches"]);
}

export async function reviewTemplatePack(_state: PodBatchActionState = idle, formData: FormData): Promise<PodBatchActionState> {
  const versionId = EntityId.safeParse(text(formData, "versionId"));
  const parsed = ReviewVersionInputSchema.safeParse({ decision: text(formData, "decision"), ...(text(formData, "rejectionReason") ? { rejectionReason: text(formData, "rejectionReason") } : {}) });
  if (!versionId.success || !parsed.success) return failure("模板包审核参数无效。 ");
  return postParsed(`/v1/pod/mockup-template-packs/${versionId.data}/review`, parsed, "模板包审核已保存。", ["/pod-workbench/mockup-batches"]);
}

export async function createMockupBatch(_state: PodBatchActionState = idle, formData: FormData): Promise<PodBatchActionState> {
  return postParsed("/v1/pod/mockup-batches", parseJson(formData, "payload", CreateMockupBatchInputSchema), "批量套图已提交。", ["/pod-workbench/mockup-batches"]);
}

export async function retryMockupOutput(_state: PodBatchActionState = idle, formData: FormData) {
  return idAction(formData, ["batchId", "outputId"], ([batchId, outputId]) => `/v1/pod/mockup-batches/${batchId}/outputs/${outputId}/retry`, "失败槽位已创建新版本并重新排队。", "/pod-workbench/mockup-batches");
}

export async function reviewMockupBatch(_state: PodBatchActionState = idle, formData: FormData): Promise<PodBatchActionState> {
  const batchId = EntityId.safeParse(text(formData, "batchId"));
  const parsed = parseJson(formData, "payload", ReviewMockupBatchInputSchema);
  if (!batchId.success) return failure("套图批次 ID 无效。 ");
  return postParsed(`/v1/pod/mockup-batches/${batchId.data}/review`, parsed, "套图矩阵审核已保存。", ["/pod-workbench/mockup-batches"]);
}

export async function rejectMockupItem(_state: PodBatchActionState = idle, formData: FormData): Promise<PodBatchActionState> {
  const batchId = EntityId.safeParse(text(formData, "batchId"));
  const itemId = EntityId.safeParse(text(formData, "itemId"));
  const parsed = ReviewMockupBatchInputSchema.safeParse({
    decisions: [{ itemId: text(formData, "itemId"), decision: "reject", rejectionReason: text(formData, "rejectionReason") }],
  });
  if (!batchId.success || !itemId.success || !parsed.success) return failure("驳回款式时必须填写原因。 ");
  return postParsed(`/v1/pod/mockup-batches/${batchId.data}/review`, parsed, "该款式的可审核槽位已驳回，可逐槽位重试。", ["/pod-workbench/mockup-batches"]);
}

export async function bindMockupsToListings(_state: PodBatchActionState = idle, formData: FormData): Promise<PodBatchActionState> {
  const batchId = EntityId.safeParse(text(formData, "batchId"));
  const parsed = parseJson(formData, "payload", CreateMockupListingBindingsInputSchema);
  if (!batchId.success) return failure("套图批次 ID 无效。 ");
  return postParsed(`/v1/pod/mockup-batches/${batchId.data}/listing-bindings`, parsed, "Listing 槽位绑定已逐款执行。", ["/pod-workbench/mockup-batches", "/listings"]);
}

async function idAction(
  formData: FormData,
  names: string[],
  path: (ids: string[]) => string,
  message: string,
  revalidate: string,
) {
  const parsed = names.map((name) => EntityId.safeParse(text(formData, name)));
  if (parsed.some((entry) => !entry.success)) return failure("操作对象 ID 无效。 ");
  return postParsed(path(parsed.map((entry) => entry.data!)), { success: true, data: {} }, message, [revalidate]);
}

function parseJson<T>(formData: FormData, name: string, schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }) {
  try {
    return schema.safeParse(JSON.parse(text(formData, name)));
  } catch {
    return { success: false } as const;
  }
}

async function postParsed<T>(
  path: string,
  parsed: { success: true; data: T } | { success: false },
  message: string,
  paths: string[],
): Promise<PodBatchActionState> {
  if (!parsed.success) return failure("提交数据无效，请检查行数、字段和版本选择。 ");
  const response = await post(path, parsed.data);
  if (!response.ok) return failure(response.message);
  paths.forEach((pathToRefresh) => revalidatePath(pathToRefresh));
  return success(message);
}

async function post(path: string, body: unknown): Promise<{ ok: boolean; message: string }> {
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) return { ok: false, message: "API_BASE_URL 未配置。" };
  try {
    const response = await apiFetch(`${apiBase.replace(/\/$/, "")}${path}`, {
      method: "POST", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => undefined) as { message?: unknown; title?: unknown } | undefined;
    return response.ok
      ? { ok: true, message: "" }
      : { ok: false, message: typeof payload?.message === "string" ? payload.message : typeof payload?.title === "string" ? payload.title : `操作失败 (${response.status})。` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "操作失败。" };
  }
}

function text(formData: FormData, name: string) {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function success(message: string): PodBatchActionState { return { status: "success", message }; }
function failure(message: string): PodBatchActionState { return { status: "error", message }; }
