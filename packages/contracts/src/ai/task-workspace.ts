import { z } from "zod";
import { AgentMethodSelectionSchema } from "@yummyai/contracts/harness/methods";
import {
  AssistBasisViewSchema,
  AssistKindSchema,
  AssistViewSchema,
  CreateAssistSchema,
  type AssistSource,
  type CreateAssist,
} from "@yummyai/contracts/ai/assist";

export const ASSIST_TASKS = [
  {
    kind: "order_review",
    label: "订单预审",
    group: "定制履约",
    description: "核对已保存的定制要求、印花和规格匹配",
    destination: "/orders",
  },
  {
    kind: "artwork_preflight",
    label: "生产稿预检",
    group: "定制履约",
    description: "对照本单要求检查已保存的生产稿",
    destination: "/order-artwork",
  },
  {
    kind: "after_sales_review",
    label: "售后分析",
    group: "定制履约",
    description: "整理处理依据和客服回复草稿",
    destination: "/after-sales",
  },
  {
    kind: "creative",
    label: "原创方向分析",
    group: "商品上新",
    description: "从项目研究证据提出原创设计方向",
    destination: "/content-projects",
  },
  {
    kind: "template_config",
    label: "模板配置建议",
    group: "商品上新",
    description: "根据授权模板的解析结果建议定制槽位",
    destination: "/pod-workbench?module=personalization",
  },
  {
    kind: "sku_package",
    label: "Listing 资料包",
    group: "商品上新",
    description: "依据已确认的商品事实与套图拟定文案",
    destination: "/listings",
  },
  {
    kind: "business_review",
    label: "经营分析",
    group: "经营与知识",
    description: "解释不可变利润计算和关联业务进度",
    destination: "/finance",
  },
  {
    kind: "procurement_review",
    label: "采购分析",
    group: "经营与知识",
    description: "核对库存、补货条件和有效供应商报价",
    destination: "/procurement",
  },
  {
    kind: "knowledge_answer",
    label: "运营知识问答",
    group: "经营与知识",
    description: "检索已发布知识并给出有引用的回答",
    destination: "/knowledge",
  },
] as const satisfies ReadonlyArray<{
  kind: z.infer<typeof AssistKindSchema>;
  label: string;
  group: string;
  description: string;
  destination: string;
}>;

export function assistTaskHref(
  request: CreateAssist | null,
  kind: z.infer<typeof AssistKindSchema>,
  sources: AssistSource[] = [],
  runId?: string,
) {
  if (request?.salesPlan && (kind === "creative" || kind === "sku_package"))
    return `/sales-plans?${new URLSearchParams({ plan: request.salesPlan.id, view: "tasks", kind, ...(runId ? { launchRun: runId } : {}) })}`;
  let href: string = ASSIST_TASKS.find((task) => task.kind === kind)!.destination;
  if (request?.kind === "order_review") href = `/orders?line=${request.orderLineId}`;
  if (request?.kind === "artwork_preflight") href = `/order-artwork?line=${request.orderLineId}`;
  if (request?.kind === "sku_package") href = `/listings/${request.listingId}`;
  if (request?.kind === "creative" && request.projectId)
    href = `/creative-designs/canvas?brief=${request.projectId}`;
  if (request?.kind === "after_sales_review")
    href = sources.find((source) => source.id === request.caseId)?.href ?? href;
  if (runId && kind !== "knowledge_answer")
    href += `${href.includes("?") ? "&" : "?"}assistRun=${encodeURIComponent(runId)}`;
  return href;
}

export const AssistTaskStatusSchema = AssistViewSchema.shape.status;
export const AssistTaskQuerySchema = z
  .object({
    kind: AssistKindSchema.optional(),
    status: AssistTaskStatusSchema.optional(),
    page: z.coerce.number().int().min(1).max(10000).default(1),
  })
  .strict();
export const AssistTaskTargetQuerySchema = z
  .object({ kind: AssistKindSchema, q: z.string().trim().max(200).default("") })
  .strict();
export const AssistTaskBasisRequestSchema = z
  .object({
    kind: AssistKindSchema,
    targetId: z.string().min(1).max(80).nullable(),
    taskGoal: z.string().trim().max(2000).default(""),
  })
  .strict();
export type AssistTaskInput = CreateAssist extends infer T
  ? T extends CreateAssist
    ? Omit<T, "requestId" | "modelId">
    : never
  : never;
export const AssistTaskInputSchema = z.union([
  CreateAssistSchema.options[0].omit({ requestId: true, modelId: true }),
  CreateAssistSchema.options[1].omit({ requestId: true, modelId: true }),
  CreateAssistSchema.options[2].omit({ requestId: true, modelId: true }),
  CreateAssistSchema.options[3].omit({ requestId: true, modelId: true }),
  CreateAssistSchema.options[4].omit({ requestId: true, modelId: true }),
  CreateAssistSchema.options[5].omit({ requestId: true, modelId: true }),
  CreateAssistSchema.options[6].omit({ requestId: true, modelId: true }),
  CreateAssistSchema.options[7].omit({ requestId: true, modelId: true }),
  CreateAssistSchema.options[8].omit({ requestId: true, modelId: true }),
]);
export const AssistTaskTargetSchema = z
  .object({ id: z.string(), label: z.string(), detail: z.string(), href: z.string() })
  .strict();
export const AssistTaskTargetsSchema = z
  .object({ items: z.array(AssistTaskTargetSchema), hasMore: z.boolean() })
  .strict();
export const AssistTaskBasisSchema = AssistBasisViewSchema.extend({
  methodSelection: AgentMethodSelectionSchema.nullable().optional(),
  input: AssistTaskInputSchema,
  scope: z.string(),
  href: z.string(),
}).strict();
export const AssistTaskRowSchema = AssistViewSchema.pick({
  id: true,
  kind: true,
  scope: true,
  status: true,
  createdAt: true,
  completedAt: true,
  modelLabel: true,
  stale: true,
  costUsd: true,
  inputTokens: true,
  outputTokens: true,
  error: true,
})
  .extend({ title: z.string(), goal: z.string(), href: z.string() })
  .strict();
export const AssistTaskWorkspaceSchema = z
  .object({
    capabilities: z.array(z.object({ kind: AssistKindSchema, canStart: z.boolean() }).strict()),
    items: z.array(AssistTaskRowSchema),
    page: z.number().int().positive(),
    hasMore: z.boolean(),
  })
  .strict();
export type AssistTaskBasis = z.infer<typeof AssistTaskBasisSchema>;
export type AssistTaskTarget = z.infer<typeof AssistTaskTargetSchema>;
export type AssistTaskWorkspace = z.infer<typeof AssistTaskWorkspaceSchema>;
export type AssistTaskRow = z.infer<typeof AssistTaskRowSchema>;
