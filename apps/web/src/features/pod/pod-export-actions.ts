"use server";

import {
  CreatePodExportInputSchema,
  PodExportViewSchema,
} from "@yummyai/contracts/pod";
import { EntityIdSchema, createEntityId } from "@yummyai/contracts/common/ids";
import { revalidatePath } from "next/cache";

import { apiFetch } from "../../server-api";

export interface PodExportActionState {
  status: "idle" | "success" | "error";
  message: string;
  exportId?: string;
  downloadUrl?: string;
}

export async function requestPodExport(
  _previous: PodExportActionState,
  formData: FormData,
): Promise<PodExportActionState> {
  const taskId = EntityIdSchema.safeParse(value(formData, "taskId"));
  if (!taskId.success) return failure("任务标识无效，无法创建导出。");
  const input = CreatePodExportInputSchema.parse({ idempotencyKey: createEntityId() });
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) return failure("API_BASE_URL 未配置。");
  try {
    const response = await apiFetch(`${apiBase.replace(/\/$/, "")}/v1/pod/tasks/${taskId.data}/exports`, {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const payload = await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
    if (!response.ok) return failure(messageFrom(payload) ?? `不可变导出创建失败 (${response.status})。`);
    const parsed = PodExportViewSchema.safeParse(payload);
    if (!parsed.success) return failure("导出已提交，但接口返回格式无效。请刷新任务中心确认。");
    revalidatePath("/pod-workbench");
    return {
      status: "success",
      message: "不可变导出已进入队列。",
      exportId: parsed.data.id,
    };
  } catch (error) {
    return failure(error instanceof Error ? error.message : "不可变导出创建失败。");
  }
}

export async function requestPodExportDownload(
  _previous: PodExportActionState,
  formData: FormData,
): Promise<PodExportActionState> {
  const exportId = EntityIdSchema.safeParse(value(formData, "exportId"));
  if (!exportId.success) return failure("导出标识无效，无法下载。");
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) return failure("API_BASE_URL 未配置。");
  try {
    const response = await apiFetch(`${apiBase.replace(/\/$/, "")}/v1/pod/exports/${exportId.data}/read-url`, {
      method: "POST",
      cache: "no-store",
    });
    const payload = await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
    if (!response.ok) return failure(messageFrom(payload) ?? `导出包下载授权失败 (${response.status})。`);
    if (typeof payload?.url !== "string") return failure("下载授权已返回，但缺少有效地址。");
    return {
      status: "success",
      message: "下载授权已创建，有效期 10 分钟。",
      exportId: exportId.data,
      downloadUrl: payload.url,
    };
  } catch (error) {
    return failure(error instanceof Error ? error.message : "导出包下载授权失败。");
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

function failure(message: string): PodExportActionState {
  return { message, status: "error" };
}
