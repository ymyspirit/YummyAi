"use server";
import {
  WorkflowResponsibilityInputSchema,
  WorkflowResponsibilityViewSchema,
  type WorkflowResponsibilityInput,
} from "@yummyai/contracts/workflow/responsibility";

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
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { parseWorkflowRepairParameters } from "@yummyai/contracts/workflow/operator";
import { parsePodTaskParameters, podFormValue } from "../pod/pod-task-parameters";

import { apiFetch } from "../../server-api";

export interface WorkflowActionState<T = undefined> {
  status: "success" | "error";
  message: string;
  data?: T;
  httpStatus?: number;
}

export async function cloneWorkflowDefinition(
  definitionId: string,
  name?: string,
  scope: "team" | "personal" = "team",
): Promise<WorkflowActionState<{ id: string }>> {
  const input = CloneWorkflowDefinitionInputSchema.parse({ scope, name });
  return request(
    `/v1/workflows/definitions/${definitionId}/clone`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
    WorkflowDefinitionDetailSchema,
    "已克隆为团队模板，可开始编辑。",
    (value) => ({ id: value.id }),
  );
}

export async function createWorkflowDefinition(
  rawInput: CreateWorkflowDefinitionInput,
): Promise<WorkflowActionState<{ id: string }>> {
  const input = CreateWorkflowDefinitionInputSchema.parse(rawInput);
  return request(
    "/v1/workflows/definitions",
    {
      method: "POST",
      body: JSON.stringify(input),
    },
    WorkflowDefinitionDetailSchema,
    "工作流草稿已创建。",
    (value) => ({ id: value.id }),
  );
}

export async function saveWorkflowDraft(
  definitionId: string,
  input: { graph: WorkflowGraph; expectedRevision: number },
): Promise<WorkflowActionState<{ revision: number; valid: boolean; issues: string[] }>> {
  const parsed = UpdateWorkflowDraftInputSchema.parse(input);
  return request(
    `/v1/workflows/definitions/${definitionId}/draft`,
    {
      method: "PATCH",
      body: JSON.stringify(parsed),
    },
    WorkflowDefinitionDetailSchema,
    "草稿已保存为新的不可变版本。",
    (value) => ({
      revision: value.revision,
      valid: value.draft?.validation.valid ?? false,
      issues: value.draft?.validation.issues.map((issue) => issue.message) ?? [],
    }),
  );
}

export async function publishWorkflowDefinition(
  definitionId: string,
  expectedRevision: number,
): Promise<WorkflowActionState<{ revision: number }>> {
  const input = PublishWorkflowDefinitionInputSchema.parse({ expectedRevision });
  return request(
    `/v1/workflows/definitions/${definitionId}/publish`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
    WorkflowDefinitionDetailSchema,
    "模板已发布；现有产品运行仍固定原版本。",
    (value) => ({ revision: value.revision }),
  );
}

export async function startWorkflowRun(
  definitionId: string,
  productPlanId: string,
): Promise<WorkflowActionState<{ id: string }>> {
  const input = StartWorkflowRunInputSchema.parse({ definitionId, productPlanId });
  return request(
    "/v1/workflow-runs",
    {
      method: "POST",
      body: JSON.stringify(input),
    },
    WorkflowRunDetailSchema,
    "产品工作流已启动。",
    (value) => ({ id: value.id }),
  );
}

export async function commandWorkflowNode(
  runId: string,
  nodeId: string,
  command: WorkflowNodeCommand,
): Promise<WorkflowActionState<{ revision: number }>> {
  const checked = WorkflowNodeCommandSchema.safeParse(command);
  if (
    !EntityIdSchema.safeParse(runId).success ||
    !nodeId.trim() ||
    nodeId.length > 120 ||
    !checked.success
  )
    return { status: "error", message: "任务或命令无效，请重新打开任务" };
  const input = checked.data;
  return request(
    `/v1/workflow-runs/${runId}/nodes/${encodeURIComponent(nodeId)}/commands`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
    WorkflowRunDetailSchema,
    messageForCommand(input.type),
    (value) => ({ revision: value.revision }),
  );
}

export async function repairWorkflowNode(
  runId: string,
  nodeId: string,
  expectedRevision: number,
  form: FormData,
): Promise<WorkflowActionState<{ revision: number }>> {
  if (!EntityIdSchema.safeParse(runId).success) return { status: "error", message: "任务标识无效" };
  const base = process.env.API_BASE_URL?.replace(/\/$/, "");
  if (!base) return { status: "error", message: "工作流服务尚未配置" };
  try {
    const response = await apiFetch(`${base}/v1/workflow-runs/${runId}`, { cache: "no-store" });
    if (!response.ok)
      return {
        status: "error",
        message: "无法读取当前工作流，请刷新后重试",
        httpStatus: response.status,
      };
    const run = WorkflowRunDetailSchema.parse(await response.json()),
      node = run.graph.nodes.find((node) => node.id === nodeId);
    if (!node || node.kind !== "internal_action")
      return { status: "error", message: "请选择可重新配置的自动任务" };
    if (run.revision !== expectedRevision)
      return { status: "error", message: "流程已更新，请载入最新输入后重试", httpStatus: 409 };
    const capability = node.config.capabilityKey;
    let parameters: Record<string, unknown>;
    if (capability === "yummyai.custom_product.generate_provisional_facts") {
      if (!EntityIdSchema.safeParse(podFormValue(form, "researchSnapshotId")).success)
        return { status: "error", message: "请选择有效的研究快照" };
      parameters = {
        researchSnapshotId: podFormValue(form, "researchSnapshotId"),
        targetMarketplace: podFormValue(form, "targetMarketplace"),
      };
    } else if (capability === "yummyai.custom_product.export_package")
      parameters = { mode: podFormValue(form, "mode") };
    else {
      const parsed = parsePodTaskParameters(capability?.replace(/^pod\./, "") ?? "", form);
      if ("error" in parsed) return { status: "error", message: parsed.error };
      parameters = {
        skuId: podFormValue(form, "skuId"),
        title: podFormValue(form, "title"),
        inputAssetIds: form.getAll("inputAssetIds").filter((value) => typeof value === "string"),
        parameterSnapshot: parsed.values,
      };
    }
    try {
      parameters = parseWorkflowRepairParameters(capability, parameters);
    } catch {
      return { status: "error", message: "输入配置未通过校验，请检查必填项、输出格式和工具限制" };
    }
    return commandWorkflowNode(runId, nodeId, { type: "retry", parameters, expectedRevision });
  } catch {
    return { status: "error", message: "工作流服务暂不可用，请稍后重试" };
  }
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
    if (!response.ok)
      return {
        status: "error",
        message:
          response.status >= 500
            ? "工作流服务暂不可用，请稍后刷新。"
            : (messageFrom(payload) ?? `操作失败 (${response.status})`),
        httpStatus: response.status,
      };
    const value = schema.parse(payload);
    revalidatePath("/workflows");
    revalidatePath("/products");
    return { status: "success", message: successMessage, data: pick(value) };
  } catch {
    return { status: "error", message: "工作流服务暂不可用，请稍后刷新。" };
  }
}

function messageFrom(payload: unknown) {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  for (const key of ["detail", "message", "title"]) {
    const value = record[key];
    if (typeof value === "string") return value;
    if (
      value &&
      typeof value === "object" &&
      "message" in value &&
      typeof value.message === "string"
    )
      return value.message;
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

export async function saveWorkflowResponsibility(
  runId: string,
  nodeId: string,
  raw: WorkflowResponsibilityInput,
) {
  const input = WorkflowResponsibilityInputSchema.safeParse(raw);
  if (!EntityIdSchema.safeParse(runId).success || !nodeId || nodeId.length > 120 || !input.success)
    return { status: "error" as const, message: "责任安排参数无效 请核对成员、截止时间及原因" };
  return request(
    `/v1/workflow-runs/${runId}/nodes/${encodeURIComponent(nodeId)}/responsibility`,
    { method: "POST", body: JSON.stringify(input.data) },
    WorkflowResponsibilityViewSchema,
    "责任安排已保存",
    (value) => value,
  );
}
