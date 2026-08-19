"use server";

import {
  CloneWorkflowDefinitionInputSchema,
  CreateWorkflowDefinitionInputSchema,
  PublishWorkflowDefinitionInputSchema,
  StartWorkflowRunInputSchema,
  UpdateWorkflowDraftInputSchema,
  WorkflowDefinitionDetailSchema,
  WorkflowNodeCommandSchema,
  WorkflowRunDetailSchema,
  type WorkflowGraph,
  type CreateWorkflowDefinitionInput,
  type WorkflowNodeCommand,
} from "@yummyai/contracts/workflow";
import { revalidatePath } from "next/cache";

import { apiFetch } from "../../server-api";

export interface WorkflowActionState<T = undefined> {
  status: "success" | "error";
  message: string;
  data?: T;
}

export async function cloneWorkflowDefinition(
  definitionId: string,
  name?: string,
  scope: "team" | "personal" = "team",
): Promise<WorkflowActionState<{ id: string }>> {
  const input = CloneWorkflowDefinitionInputSchema.parse({ scope, name });
  return request(`/v1/workflows/definitions/${definitionId}/clone`, {
    method: "POST",
    body: JSON.stringify(input),
  }, WorkflowDefinitionDetailSchema, "已克隆为团队模板，可开始编辑。", (value) => ({ id: value.id }));
}

export async function createWorkflowDefinition(
  rawInput: CreateWorkflowDefinitionInput,
): Promise<WorkflowActionState<{ id: string }>> {
  const input = CreateWorkflowDefinitionInputSchema.parse(rawInput);
  return request("/v1/workflows/definitions", {
    method: "POST",
    body: JSON.stringify(input),
  }, WorkflowDefinitionDetailSchema, "工作流草稿已创建。", (value) => ({ id: value.id }));
}

export async function saveWorkflowDraft(
  definitionId: string,
  input: { graph: WorkflowGraph; expectedRevision: number },
): Promise<WorkflowActionState<{ revision: number; valid: boolean; issues: string[] }>> {
  const parsed = UpdateWorkflowDraftInputSchema.parse(input);
  return request(`/v1/workflows/definitions/${definitionId}/draft`, {
    method: "PATCH",
    body: JSON.stringify(parsed),
  }, WorkflowDefinitionDetailSchema, "草稿已保存为新的不可变版本。", (value) => ({
    revision: value.revision,
    valid: value.draft?.validation.valid ?? false,
    issues: value.draft?.validation.issues.map((issue) => issue.message) ?? [],
  }));
}

export async function publishWorkflowDefinition(
  definitionId: string,
  expectedRevision: number,
): Promise<WorkflowActionState<{ revision: number }>> {
  const input = PublishWorkflowDefinitionInputSchema.parse({ expectedRevision });
  return request(`/v1/workflows/definitions/${definitionId}/publish`, {
    method: "POST",
    body: JSON.stringify(input),
  }, WorkflowDefinitionDetailSchema, "模板已发布；现有产品运行仍固定原版本。", (value) => ({ revision: value.revision }));
}

export async function startWorkflowRun(
  definitionId: string,
  productPlanId: string,
): Promise<WorkflowActionState<{ id: string }>> {
  const input = StartWorkflowRunInputSchema.parse({ definitionId, productPlanId });
  return request("/v1/workflow-runs", {
    method: "POST",
    body: JSON.stringify(input),
  }, WorkflowRunDetailSchema, "产品工作流已启动。", (value) => ({ id: value.id }));
}

export async function commandWorkflowNode(
  runId: string,
  nodeId: string,
  command: WorkflowNodeCommand,
): Promise<WorkflowActionState<{ revision: number }>> {
  const input = WorkflowNodeCommandSchema.parse(command);
  return request(`/v1/workflow-runs/${runId}/nodes/${encodeURIComponent(nodeId)}/commands`, {
    method: "POST",
    body: JSON.stringify(input),
  }, WorkflowRunDetailSchema, messageForCommand(input.type), (value) => ({ revision: value.revision }));
}

async function request<T, R>(
  path: string,
  init: RequestInit,
  schema: { parse(value: unknown): T },
  successMessage: string,
  pick: (value: T) => R,
): Promise<WorkflowActionState<R>> {
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) return { status: "error", message: "API_BASE_URL 未配置。" };
  try {
    const response = await apiFetch(`${apiBase.replace(/\/$/, "")}${path}`, {
      ...init,
      cache: "no-store",
      headers: { "content-type": "application/json", ...init.headers },
    });
    const payload = await response.json().catch(() => undefined);
    if (!response.ok) return { status: "error", message: messageFrom(payload) ?? `操作失败 (${response.status})` };
    const value = schema.parse(payload);
    revalidatePath("/workflows");
    revalidatePath("/products");
    return { status: "success", message: successMessage, data: pick(value) };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : "工作流操作失败。" };
  }
}

function messageFrom(payload: unknown) {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  for (const key of ["detail", "message", "title"]) {
    const value = record[key];
    if (typeof value === "string") return value;
    if (value && typeof value === "object" && "message" in value && typeof value.message === "string") return value.message;
  }
  return undefined;
}

function messageForCommand(type: WorkflowNodeCommand["type"]) {
  const messages: Record<WorkflowNodeCommand["type"], string> = {
    start: "任务已开始。",
    complete: "任务已完成，流程已推进。",
    block: "阻断原因已记录。",
    unblock: "阻断已解除。",
    approve: "审核已批准，流程已推进。",
    reject: "审核已退回，返工节点已重新打开。",
    retry: "自动任务已重新排队。",
    reopen: "已完成任务已重新打开，历史记录保留。",
    update_note: "任务说明已更新，完成状态不变。",
    cancel: "工作流运行已取消。",
  };
  return messages[type];
}
