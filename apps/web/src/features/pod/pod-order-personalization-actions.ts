"use server";

import {
  CreateOrderPersonalizationBatchInputSchema,
  CreateOrderPersonalizationRenderTaskInputSchema,
  OrderPersonalizationBatchSchema,
  OrderPersonalizationRenderTaskSchema,
} from "@yummyai/contracts/pod/order-personalization";
import { createEntityId } from "@yummyai/contracts/common/ids";
import { revalidatePath } from "next/cache";

import { apiFetch } from "../../server-api";

export type PodOrderPersonalizationActionState = {
  status: "idle" | "success" | "error";
  message: string;
};

export async function createOrderPersonalizationBatch(
  _previous: PodOrderPersonalizationActionState,
  formData: FormData,
): Promise<PodOrderPersonalizationActionState> {
  const rawCandidates = formData.getAll("candidate").filter((entry): entry is string => typeof entry === "string");
  if (!rawCandidates.length) return failure("请至少选择一个可处理订单行。");
  const items = rawCandidates.map((candidate) => {
    const [orderId, orderLineId, customizationVersionId, bindingId, extra] = candidate.split(":");
    return extra === undefined ? { orderId, orderLineId, customizationVersionId, bindingId } : {};
  });
  const parsed = CreateOrderPersonalizationBatchInputSchema.safeParse({
    idempotencyKey: createEntityId(),
    items,
  });
  if (!parsed.success) {
    const duplicate = parsed.error.issues.some((issue) => issue.path.at(-1) === "orderLineId");
    return failure(duplicate
      ? "同一订单行只能选择一个尺寸模板，请取消重复选择后重试。"
      : parsed.error.issues[0]?.message ?? "订单个性化批次参数无效。");
  }
  const result = await post("/v1/pod/order-personalization-batches", parsed.data);
  if ("error" in result) return failure(result.error);
  if (!OrderPersonalizationBatchSchema.safeParse(result.payload).success) {
    return failure("批次已提交，但接口返回格式无效。请刷新后确认。");
  }
  revalidatePath("/pod-workbench");
  return success(`已创建 ${parsed.data.items.length} 个订单行的安全预处理批次。`);
}

export async function createOrderPersonalizationRenderTask(
  _previous: PodOrderPersonalizationActionState,
  formData: FormData,
): Promise<PodOrderPersonalizationActionState> {
  const toolKey = value(formData, "toolKey");
  const vector = toolKey === "vector_fulfillment";
  const dpiValue = value(formData, "dpi");
  const colorMode = value(formData, "colorMode");
  const parsed = CreateOrderPersonalizationRenderTaskInputSchema.safeParse({
    idempotencyKey: createEntityId(),
    batchItemId: value(formData, "batchItemId"),
    toolKey,
    parameterSnapshot: {
      outputFormat: vector ? "svg" : value(formData, "outputFormat"),
      fitMode: vector ? "template" : value(formData, "fitMode") || "template",
      autoComposition: vector ? "off" : value(formData, "autoComposition") || "off",
      allowAiEnhancement: vector ? false : formData.has("allowAiEnhancement"),
      identityMode: vector ? "standard" : value(formData, "identityMode") || "standard",
      customerAssetUsage: vector ? "mapped" : value(formData, "customerAssetUsage") || "mapped",
      referenceIdentityTransfer: vector ? "not_applicable" : value(formData, "referenceIdentityTransfer") || "not_applicable",
      ...(!vector && dpiValue ? { dpi: Number(dpiValue) } : {}),
      ...(colorMode ? { colorMode } : {}),
      transparent: vector ? true : formData.has("transparent"),
      ...(vector ? {
        vectorTemplateProfile: value(formData, "vectorTemplateProfile"),
        vectorWidth: Number(value(formData, "vectorWidth")),
        vectorHeight: Number(value(formData, "vectorHeight")),
        vectorUnit: value(formData, "vectorUnit"),
        vectorLayoutMode: value(formData, "vectorLayoutMode"),
        textToPath: true,
        hollowMode: formData.has("hollowMode"),
        bridgeWidthMm: Number(value(formData, "bridgeWidthMm")),
        minimumLineWidthMm: Number(value(formData, "minimumLineWidthMm")),
        pathRepair: value(formData, "pathRepair"),
      } : {}),
    },
  });
  if (!parsed.success) return failure(vector
    ? "SVG 生产参数不完整或超出范围，请检查模板配置、画布、线宽和连接桥。"
    : parsed.error.issues[0]?.message ?? "履约图生成参数无效。");
  const result = await post("/v1/pod/order-personalization-render-tasks", parsed.data);
  if ("error" in result) return failure(result.error);
  if (!OrderPersonalizationRenderTaskSchema.safeParse(result.payload).success) {
    return failure("渲染任务已提交，但接口返回格式无效。请刷新后确认。");
  }
  revalidatePath("/pod-workbench");
  return success(vector
    ? "履约 SVG 任务已创建。通过路径与生产质量检查后，仍需人工审核。"
    : "渲染任务已创建。输出仍需人工审核后才能进入后续流程。");
}

async function post(path: string, body: unknown): Promise<{ payload: unknown } | { error: string }> {
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) return { error: "API_BASE_URL 未配置。" };
  try {
    const response = await apiFetch(`${apiBase.replace(/\/$/, "")}${path}`, {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
    if (!response.ok) return { error: messageFrom(payload) ?? `请求失败 (${response.status})。` };
    return { payload };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "请求失败。" };
  }
}

function value(formData: FormData, name: string) {
  const entry = formData.get(name);
  return typeof entry === "string" ? entry.trim() : "";
}

function messageFrom(payload: Record<string, unknown> | undefined) {
  for (const key of ["detail", "message", "title"]) if (typeof payload?.[key] === "string") return payload[key];
  return undefined;
}

function failure(message: string): PodOrderPersonalizationActionState {
  return { message, status: "error" };
}

function success(message: string): PodOrderPersonalizationActionState {
  return { message, status: "success" };
}
