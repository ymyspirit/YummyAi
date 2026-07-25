"use server";

import type { DesignFileRole, RightsSource } from "@yummyai/contracts";
import { revalidatePath } from "next/cache";

import { apiFetch } from "../../server-api";

export interface DesignActionState {
  message: string;
  status: "idle" | "success" | "error";
  taskId?: string;
  url?: string;
}

export async function createDesignTask(
  _previous: DesignActionState,
  formData: FormData,
): Promise<DesignActionState> {
  const skuId = value(formData, "skuId");
  const title = value(formData, "title");
  const brief = value(formData, "brief");
  const dueAtValue = value(formData, "dueAt");
  if (!UUID_V7_PATTERN.test(skuId)) return failure("请选择一个真实 SKU。");
  if (!title || title.length > 200) return failure("设计任务标题为必填项，最多 200 个字符。");
  if (!brief || brief.length > 8_000) return failure("设计要求为必填项，最多 8000 个字符。");
  const dueAt = dueAtValue ? new Date(dueAtValue) : undefined;
  if (dueAt && Number.isNaN(dueAt.getTime())) return failure("截止日期格式无效。");
  const response = await designRequest<{ id?: unknown }>("/v1/design/tasks", {
    body: JSON.stringify({ skuId, title, brief, ...(dueAt ? { dueAt: dueAt.toISOString() } : {}) }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!response.ok) return failure(response.message);
  if (typeof response.data?.id !== "string") return failure("任务已创建，但接口没有返回任务 ID。请刷新页面确认。");
  revalidatePath("/design");
  revalidatePath("/products");
  return { message: "设计任务已创建，正在打开任务。", status: "success", taskId: response.data.id };
}

export async function uploadDesignVersion(
  taskId: string,
  _previous: DesignActionState,
  formData: FormData,
): Promise<DesignActionState> {
  const file = formData.get("file");
  const role = value(formData, "role") as DesignFileRole;
  const rightsKind = value(formData, "rightsKind") as RightsSource["kind"];
  const rightsReference = value(formData, "rightsReference");
  if (!(file instanceof File) || file.size === 0) return failure("请选择要上传的设计文件。");
  if (file.size > 20 * 1024 * 1024) return failure("单个设计文件不能超过 20 MB。");
  if (!file.type) return failure("文件缺少媒体类型，无法安全登记。");
  if (!(["source", "effect", "production"] as string[]).includes(role)) return failure("请选择文件角色。");
  if (!(["owned", "licensed", "commissioned", "ai_generated", "customer_provided"] as string[]).includes(rightsKind)) {
    return failure("竞品素材不能进入授权设计域，请上传自有、许可、委托、AI 生成或客户提供的文件。");
  }
  if (!rightsReference || rightsReference.length > 500) return failure("请填写可审计的权利来源编号或说明。");
  try {
    const dataBase64 = Buffer.from(await file.arrayBuffer()).toString("base64");
    const uploaded = await designRequest<{ id?: unknown }>("/assets", {
      body: JSON.stringify({ dataBase64, domain: "authorized", fileName: file.name, mediaType: file.type }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    if (!uploaded.ok || typeof uploaded.data?.id !== "string") return failure(uploaded.message || "设计资产上传失败。");
    const assetId = uploaded.data.id;
    const rights = await designRequest(`/v1/design/assets/${assetId}/rights`, {
      body: JSON.stringify({ rightsSource: { kind: rightsKind, reference: rightsReference } }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    if (!rights.ok) return failure(`文件已上传，但权利确认失败：${rights.message}`);
    const version = await designRequest(`/v1/design/tasks/${taskId}/versions`, {
      body: JSON.stringify({ changeNote: value(formData, "changeNote"), files: [{ assetId, role }] }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    if (!version.ok) return failure(`资产已登记，但版本创建失败：${version.message}`);
    revalidatePath("/design");
    return { message: "新校样版本已创建并进入待评审状态。", status: "success" };
  } catch (error) {
    return failure(error instanceof Error ? error.message : "设计版本上传失败。");
  }
}

export async function reviewDesignVersion(
  versionId: string,
  decision: "approve" | "reject",
  _previous: DesignActionState,
  formData: FormData,
): Promise<DesignActionState> {
  const rejectionReason = value(formData, "rejectionReason");
  if (decision === "reject" && !rejectionReason) return failure("驳回时必须填写原因。");
  const response = await designRequest(`/v1/design/versions/${versionId}/review`, {
    body: JSON.stringify({ decision, ...(rejectionReason ? { rejectionReason } : {}) }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!response.ok) return failure(response.message);
  revalidatePath("/design");
  return { message: decision === "approve" ? "校样版本已批准并锁定。" : "校样版本已驳回。", status: "success" };
}

export async function setPrimaryDesignVersion(
  taskId: string,
  versionId: string,
  _previous: DesignActionState,
  _formData: FormData,
): Promise<DesignActionState> {
  void _previous;
  void _formData;
  const response = await designRequest(`/v1/design/tasks/${taskId}/primary/${versionId}`, { method: "POST" });
  if (!response.ok) return failure(response.message);
  revalidatePath("/design");
  revalidatePath("/products");
  return { message: "该批准版本已设为当前主版本。", status: "success" };
}

export async function getDesignFileUrl(
  versionId: string,
  fileId: string,
  _previous: DesignActionState,
  _formData: FormData,
): Promise<DesignActionState> {
  void _previous;
  void _formData;
  const response = await designRequest<{ url?: unknown }>(`/v1/design/versions/${versionId}/files/${fileId}/read-url`, { method: "POST" });
  if (!response.ok || typeof response.data?.url !== "string") return failure(response.message || "安全链接创建失败。");
  return { message: "安全链接已生成，10 分钟内有效。", status: "success", url: response.data.url };
}

async function designRequest<T = unknown>(path: string, init: RequestInit): Promise<{ data?: T; message: string; ok: boolean }> {
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) return { message: "API_BASE_URL 未配置。", ok: false };
  try {
    const response = await apiFetch(`${apiBase.replace(/\/$/, "")}${path}`, { ...init, cache: "no-store" });
    const data = await response.json().catch(() => undefined) as T & { detail?: unknown; message?: unknown; title?: unknown };
    if (!response.ok) return { message: messageFrom(data) ?? `操作失败 (${response.status})`, ok: false };
    return { data, message: "", ok: true };
  } catch (error) {
    return { message: error instanceof Error ? error.message : "设计操作失败。", ok: false };
  }
}

function value(formData: FormData, name: string) {
  const entry = formData.get(name);
  return typeof entry === "string" ? entry.trim() : "";
}

function messageFrom(payload: { detail?: unknown; message?: unknown; title?: unknown } | undefined) {
  for (const key of ["detail", "message", "title"] as const) if (typeof payload?.[key] === "string") return payload[key];
  return undefined;
}

function failure(message: string): DesignActionState { return { message, status: "error" }; }

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
