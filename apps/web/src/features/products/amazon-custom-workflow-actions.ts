"use server";

import {
  AmazonCustomWorkflowStepKeySchema,
  TransitionAmazonCustomWorkflowStepInputSchema,
  UpdateAmazonCustomWorkflowStepNoteInputSchema,
  type AmazonCustomWorkflowStepKey,
} from "@yummyai/contracts/catalog/amazon-custom-workflow";
import { revalidatePath } from "next/cache";

import { apiFetch } from "../../server-api";

export interface AmazonCustomWorkflowActionState {
  message: string;
  status: "idle" | "success" | "error";
}

export async function startAmazonCustomWorkflow(
  planId: string,
  _previous: AmazonCustomWorkflowActionState,
): Promise<AmazonCustomWorkflowActionState> {
  void _previous;
  return workflowRequest(
    `/v1/products/plans/${planId}/custom-workflow`,
    {
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
    "流程已创建，第一个任务已进入执行中。",
  );
}

export async function transitionAmazonCustomWorkflowStep(
  planId: string,
  rawStepKey: AmazonCustomWorkflowStepKey,
  _previous: AmazonCustomWorkflowActionState,
  formData: FormData,
): Promise<AmazonCustomWorkflowActionState> {
  void _previous;
  const stepKey = AmazonCustomWorkflowStepKeySchema.safeParse(rawStepKey);
  const expectedRevision = Number(value(formData, "expectedRevision"));
  const status = value(formData, "status");
  const note = value(formData, "note");
  const input = TransitionAmazonCustomWorkflowStepInputSchema.safeParse({
    expectedRevision,
    status,
    ...(note ? { note } : {}),
  });
  if (!stepKey.success || !input.success) {
    return failure(
      status === "blocked" && !note
        ? "请填写阻断原因。"
        : "任务状态无效，请刷新页面后重试。",
    );
  }
  return workflowRequest(
    `/v1/products/plans/${planId}/custom-workflow/steps/${stepKey.data}/transitions`,
    {
      body: JSON.stringify(input.data),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
    messageFor(input.data.status),
  );
}

export async function updateAmazonCustomWorkflowStepNote(
  planId: string,
  rawStepKey: AmazonCustomWorkflowStepKey,
  _previous: AmazonCustomWorkflowActionState,
  formData: FormData,
): Promise<AmazonCustomWorkflowActionState> {
  void _previous;
  const stepKey = AmazonCustomWorkflowStepKeySchema.safeParse(rawStepKey);
  const input = UpdateAmazonCustomWorkflowStepNoteInputSchema.safeParse({
    expectedRevision: Number(value(formData, "expectedRevision")),
    note: value(formData, "note"),
  });
  if (!stepKey.success || !input.success) {
    return failure("完成说明无效，请刷新页面后重试。");
  }
  return workflowRequest(
    `/v1/products/plans/${planId}/custom-workflow/steps/${stepKey.data}`,
    {
      body: JSON.stringify(input.data),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    },
    "完成说明已更新，任务进度保持不变。",
  );
}

async function workflowRequest(
  path: string,
  init: RequestInit,
  successMessage: string,
): Promise<AmazonCustomWorkflowActionState> {
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) return failure("API_BASE_URL 未配置，任务状态无法保存。");
  try {
    const response = await apiFetch(`${apiBase.replace(/\/$/, "")}${path}`, {
      ...init,
      cache: "no-store",
    });
    const payload = (await response.json().catch(() => undefined)) as
      { detail?: unknown; message?: unknown; title?: unknown } | undefined;
    if (!response.ok) {
      return failure(messageFrom(payload) ?? `操作失败 (${response.status})`);
    }
    revalidatePath("/amazon-custom-sop");
    revalidatePath("/products");
    return { message: successMessage, status: "success" };
  } catch (error) {
    return failure(error instanceof Error ? error.message : "任务状态保存失败。");
  }
}

function messageFor(status: "in_progress" | "blocked" | "completed") {
  if (status === "blocked") return "阻断原因已记录，产品已进入阻断状态。";
  if (status === "completed") return "任务已完成，流程已推进到下一步。";
  return "任务已进入执行中。";
}

function value(formData: FormData, name: string): string {
  const entry = formData.get(name);
  return typeof entry === "string" ? entry.trim() : "";
}

function messageFrom(
  payload: { detail?: unknown; message?: unknown; title?: unknown } | undefined,
) {
  for (const key of ["detail", "message", "title"] as const) {
    const candidate = payload?.[key];
    if (typeof candidate === "string") return candidate;
  }
  return undefined;
}

function failure(message: string): AmazonCustomWorkflowActionState {
  return { message, status: "error" };
}
