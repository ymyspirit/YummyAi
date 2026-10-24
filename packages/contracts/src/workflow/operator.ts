import { z } from "zod";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { CatalogOperationParametersSchema } from "@yummyai/contracts/catalog/operation";
import { HarnessExecutionContractSchema, HarnessInvocationViewSchema } from "@yummyai/contracts/harness";
import { AgentMethodSelectionSchema } from "@yummyai/contracts/harness/methods";
import {
  CreatePodArtworkTaskInputSchema,
  PodExecutableToolKeySchema,
  PodModuleKeySchema,
  PodTaskInputOptionsViewSchema,
  PodTaskParameterSnapshotSchema,
} from "@yummyai/contracts/pod";
import {
  CustomProductProfileV1Schema,
  CustomProductPackageCompletenessSchema,
} from "@yummyai/contracts/catalog/custom-product-package";

export const WorkflowAttemptStatusSchema = z.enum([
  "queued",
  "running",
  "waiting",
  "failed",
  "completed",
  "cancelled",
]);
export const WorkflowAttemptViewSchema = z.object({
  id: EntityIdSchema,
  number: z.int().positive(),
  status: WorkflowAttemptStatusSchema,
  actor: z.string().min(1),
  queuedAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  errorCode: z.string().nullable(),
  message: z.string().nullable(),
  recoveryCount: z.int().nonnegative(),
  inputChecksum: z.string().nullable(),
  inputAvailable: z.boolean(),
  executionContract: HarnessExecutionContractSchema.nullable().optional(),
  methodSelection: AgentMethodSelectionSchema.nullable().optional(),
  invocations: z.array(HarnessInvocationViewSchema).max(22).optional(),
  child: z
    .object({
      id: EntityIdSchema,
      module: PodModuleKeySchema,
      status: z.string(),
      progressPercent: z.number().min(0).max(100),
      needsReconciliation: z.boolean(),
    })
    .nullable(),
});
export const WorkflowNodeInspectionSchema = z.object({
  runId: EntityIdSchema,
  nodeId: z.string().min(1),
  inspectedAt: z.iso.datetime(),
  access: z.object({
    canCommand: z.boolean(),
    canApprove: z.boolean(),
    canRetry: z.boolean(),
    canRepair: z.boolean(),
  }),
  attempts: z.array(WorkflowAttemptViewSchema).max(30),
  hasMoreAttempts: z.boolean(),
});
export const WorkflowRepairOptionsSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("profile"),
    targetMarketplace: z.string(),
    researchSnapshotId: EntityIdSchema.nullable(),
    sources: z
      .array(
        z.object({ snapshotId: EntityIdSchema, title: z.string(), capturedAt: z.iso.datetime() }),
      )
      .max(51),
    hasMoreSources: z.boolean(),
  }),
  z.object({ kind: z.literal("package"), mode: z.enum(["draft", "release"]) }),
  z.object({
    kind: z.literal("pod"),
    toolKey: PodExecutableToolKeySchema,
    title: z.string(),
    skuId: EntityIdSchema.nullable(),
    inputAssetIds: z.array(EntityIdSchema),
    parameterSnapshot: PodTaskParameterSnapshotSchema.nullable(),
    options: PodTaskInputOptionsViewSchema,
  }),
]);
export const WorkflowArtifactInspectionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("profile"),
    receiptId: EntityIdSchema,
    checksum: z.string(),
    createdAt: z.iso.datetime(),
    profile: CustomProductProfileV1Schema,
  }),
  z.object({
    kind: z.literal("package"),
    receiptId: EntityIdSchema,
    checksum: z.string(),
    createdAt: z.iso.datetime(),
    mode: z.enum(["draft", "release"]),
    fileName: z.string(),
    completeness: CustomProductPackageCompletenessSchema,
    canDownload: z.boolean(),
  }),
  z.object({
    kind: z.literal("pod"),
    taskId: EntityIdSchema,
    module: PodModuleKeySchema,
    designTaskId: EntityIdSchema,
    versionId: EntityIdSchema,
    toolKey: PodExecutableToolKeySchema,
    status: z.string(),
    progressPercent: z.number().min(0).max(100),
  }),
]);
export type WorkflowNodeInspection = z.infer<typeof WorkflowNodeInspectionSchema>;
export type WorkflowRepairOptions = z.infer<typeof WorkflowRepairOptionsSchema>;
export type WorkflowArtifactInspection = z.infer<typeof WorkflowArtifactInspectionSchema>;

export function parseWorkflowRepairParameters(
  capability: string | undefined,
  parameters: unknown,
): Record<string, unknown> {
  if (capability === "yummyai.custom_product.generate_provisional_facts")
    return CatalogOperationParametersSchema.pick({
      researchSnapshotId: true,
      researchItemId: true,
      targetMarketplace: true,
    })
      .strict()
      .parse(parameters);
  if (capability === "yummyai.custom_product.export_package")
    return CatalogOperationParametersSchema.pick({ mode: true, targetMarketplace: true })
      .strict()
      .parse(parameters);
  const tool = PodExecutableToolKeySchema.parse(capability?.replace(/^pod\./, ""));
  const fields = z
    .object({
      skuId: CreatePodArtworkTaskInputSchema.shape.skuId,
      title: CreatePodArtworkTaskInputSchema.shape.title,
      inputAssetIds: CreatePodArtworkTaskInputSchema.shape.inputAssetIds,
      parameterSnapshot: CreatePodArtworkTaskInputSchema.shape.parameterSnapshot,
    })
    .strict()
    .parse(parameters);
  const checked = CreatePodArtworkTaskInputSchema.parse({
    ...fields,
    toolKey: tool,
    idempotencyKey: "00000000-0000-7000-8000-000000000000",
  });
  return {
    skuId: checked.skuId,
    title: checked.title,
    inputAssetIds: checked.inputAssetIds,
    parameterSnapshot: checked.parameterSnapshot,
  };
}

// Stored transport errors and legacy messages can contain private data. Only known,
// code-owned guidance is returned by the operator read model.
const executionMessages: Record<string, string> = {
  WORKFLOW_INPUT_INVALID: "输入资料不完整，请核对并重新配置",
  WORKFLOW_INPUT_CHANGED: "固定的商品或素材已变化，请核对后重新配置",
  WORKFLOW_QUALITY_BLOCKED: "产品包缺少已核实事实或授权素材，请先到商品模块补齐",
  WORKFLOW_ACCESS_REVOKED: "成员权限或数据范围已变化，请联系负责人核对",
  WORKFLOW_PRODUCT_SCOPE_CHANGED: "关联商品已归档或不在当前权限范围",
  WORKFLOW_LEGACY_INPUT_MISSING: "旧任务缺少固定输入，需要人工核对后重新配置",
  WORKFLOW_CONTRACT_MISSING: "旧任务缺少工具与执行方法快照，请核对原操作后明确重新配置",
  WORKFLOW_CONTRACT_CHANGED: "已固定的工具或执行方法无法核验，任务已停止，请核对后处理",
  WORKFLOW_METHOD_UNAVAILABLE: "已固定的方法被撤回或知识依据不可用，请先核对原回执和子任务；系统不会自动重提请求",
  WORKFLOW_OUTPUT_INVALID: "产物不满足工具契约，未推进节点，请核对原回执或子任务",
  WORKFLOW_RECOVERY_EXHAUSTED: "恢复次数已达到上限，请核对执行记录",
  WORKFLOW_ATTEMPT_EXPIRED: "本次执行已到期，请核对输入后重新排队",
  WORKFLOW_POD_TASK_FAILED: "原 POD 任务未形成可用结果，请先查看原任务，避免重复提交",
  WORKFLOW_POD_QUEUE_UNAVAILABLE: "POD 派发暂不可用，保留原任务等待恢复",
  WORKFLOW_EXECUTION_UNAVAILABLE: "执行服务暂不可用，系统保留本次输入等待恢复",
  QUEUE_UNAVAILABLE: "派发暂不可用，任务已保存，等待自动补发",
};
export function workflowExecutionCode(code: string | null | undefined): string | null {
  return code
    ? Object.hasOwn(executionMessages, code)
      ? code
      : "WORKFLOW_EXECUTION_FAILED"
    : null;
}
export function workflowExecutionMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  return (
    executionMessages[workflowExecutionCode(code)!] ?? "自动执行未完成，请核对原任务和输入资料"
  );
}
