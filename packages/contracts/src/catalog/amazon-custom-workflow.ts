import { z } from "zod";

import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { ProductStatusSchema } from "@yummyai/contracts/catalog/product";

export const AMAZON_CUSTOM_WORKFLOW_STEPS = [
  {
    key: "research_capture",
    title: "录入竞品研究资料",
    ownerRole: "市场研究 / 运营",
    system: "YummyAI",
    location: "研究资料库",
  },
  {
    key: "research_review",
    title: "复核研究结论",
    ownerRole: "研究负责人",
    system: "YummyAI",
    location: "研究资料详情 / 分析报告",
  },
  {
    key: "product_plan",
    title: "创建产品企划",
    ownerRole: "产品运营",
    system: "YummyAI",
    location: "产品目录",
  },
  {
    key: "provisional_facts",
    title: "生成临时产品事实",
    ownerRole: "产品运营",
    system: "YummyAI",
    location: "Amazon Studio 产品包",
  },
  {
    key: "seller_facts",
    title: "核对自有产品事实",
    ownerRole: "产品 / 采购",
    system: "YummyAI",
    location: "Amazon Studio 产品包",
  },
  {
    key: "customization_schema",
    title: "配置 Amazon Custom 定制字段",
    ownerRole: "产品运营 / 工艺",
    system: "YummyAI",
    location: "客户定制字段",
  },
  {
    key: "spu_sku",
    title: "创建 SPU 与 SKU",
    ownerRole: "产品运营",
    system: "YummyAI",
    location: "商品变体",
  },
  {
    key: "design_proof",
    title: "完成设计校样",
    ownerRole: "设计师 / 设计审核",
    system: "YummyAI",
    location: "设计校样",
  },
  {
    key: "authorized_assets",
    title: "关联授权素材并完成产品包预检",
    ownerRole: "产品运营 / 设计审核",
    system: "YummyAI",
    location: "Amazon Studio 产品包",
  },
  {
    key: "studio_draft",
    title: "导出 Amazon Studio 草稿包",
    ownerRole: "产品运营",
    system: "YummyAI",
    location: "Amazon Studio 产品包",
  },
  {
    key: "studio_content",
    title: "生成 Listing 文案、9 图和 A+",
    ownerRole: "内容运营 / 设计师",
    system: "Amazon Studio",
    location: "Amazon Custom 项目",
  },
  {
    key: "content_review",
    title: "内容合规审核与正式包确认",
    ownerRole: "运营负责人 / 合规审核",
    system: "Amazon Studio",
    location: "项目审核与导出",
  },
  {
    key: "seller_central",
    title: "导出完整上架资料包",
    ownerRole: "店铺运营",
    system: "YummyAI",
    location: "商品企划 / 上架资料齐套包",
  },
  {
    key: "online_qa",
    title: "资料齐套验收与交接",
    ownerRole: "产品负责人",
    system: "YummyAI",
    location: "工作流 / 资料齐套报告",
  },
] as const;

export const AMAZON_CUSTOM_WORKFLOW_STEP_KEYS = AMAZON_CUSTOM_WORKFLOW_STEPS.map(
  (step) => step.key,
) as [
  (typeof AMAZON_CUSTOM_WORKFLOW_STEPS)[number]["key"],
  ...(typeof AMAZON_CUSTOM_WORKFLOW_STEPS)[number]["key"][],
];

export const AmazonCustomWorkflowStepKeySchema = z.enum(AMAZON_CUSTOM_WORKFLOW_STEP_KEYS);
export const AmazonCustomWorkflowStepStatusSchema = z.enum([
  "not_started",
  "in_progress",
  "blocked",
  "completed",
]);
export const AmazonCustomWorkflowStatusSchema = z.enum([
  "not_started",
  "active",
  "blocked",
  "completed",
]);
export const AmazonCustomWorkflowEventActionSchema = z.enum([
  "workflow_started",
  "step_started",
  "step_blocked",
  "step_unblocked",
  "step_completed",
  "step_note_updated",
  "step_reopened",
]);

export const StartAmazonCustomWorkflowInputSchema = z.object({}).strict();

export const TransitionAmazonCustomWorkflowStepInputSchema = z
  .object({
    status: z.enum(["in_progress", "blocked", "completed"]),
    note: z.string().trim().min(1).max(1_000).optional(),
    expectedRevision: z.int().nonnegative(),
  })
  .superRefine((input, context) => {
    if (input.status === "blocked" && !input.note) {
      context.addIssue({
        code: "custom",
        path: ["note"],
        message: "A blocker reason is required",
      });
    }
  });

export const UpdateAmazonCustomWorkflowStepNoteInputSchema = z
  .object({
    note: z.string().trim().max(1_000),
    expectedRevision: z.int().nonnegative(),
  })
  .strict();

export const AmazonCustomWorkflowStepViewSchema = z.object({
  key: AmazonCustomWorkflowStepKeySchema,
  title: z.string().min(1),
  ownerRole: z.string().min(1),
  system: z.enum(["YummyAI", "Amazon Studio", "Seller Central"]),
  location: z.string().min(1),
  status: AmazonCustomWorkflowStepStatusSchema,
  note: z.string().optional(),
  startedAt: z.iso.datetime().optional(),
  completedAt: z.iso.datetime().optional(),
  updatedAt: z.iso.datetime().optional(),
  updatedByName: z.string().optional(),
});

export const AmazonCustomWorkflowEventViewSchema = z.object({
  id: EntityIdSchema,
  stepKey: AmazonCustomWorkflowStepKeySchema,
  action: AmazonCustomWorkflowEventActionSchema,
  fromStatus: AmazonCustomWorkflowStepStatusSchema,
  toStatus: AmazonCustomWorkflowStepStatusSchema,
  note: z.string().optional(),
  actorName: z.string(),
  revision: z.int().positive(),
  occurredAt: z.iso.datetime(),
});

export const AmazonCustomWorkflowSummarySchema = z.object({
  workflowId: EntityIdSchema.optional(),
  productPlanId: EntityIdSchema,
  productName: z.string().min(1),
  productStatus: ProductStatusSchema,
  ownerName: z.string().optional(),
  spuCode: z.string().optional(),
  skuCodes: z.array(z.string()),
  status: AmazonCustomWorkflowStatusSchema,
  completedSteps: z.int().min(0).max(AMAZON_CUSTOM_WORKFLOW_STEPS.length),
  totalSteps: z.literal(AMAZON_CUSTOM_WORKFLOW_STEPS.length),
  currentStepKey: AmazonCustomWorkflowStepKeySchema.optional(),
  currentStepTitle: z.string().optional(),
  currentStepStatus: AmazonCustomWorkflowStepStatusSchema.optional(),
  latestBlocker: z.string().optional(),
  revision: z.int().nonnegative(),
  updatedAt: z.iso.datetime().optional(),
});

export const AmazonCustomWorkflowDetailSchema = AmazonCustomWorkflowSummarySchema.extend({
  steps: z.array(AmazonCustomWorkflowStepViewSchema).length(AMAZON_CUSTOM_WORKFLOW_STEPS.length),
  events: z.array(AmazonCustomWorkflowEventViewSchema).max(50),
});

export const AmazonCustomWorkflowWorkspaceSchema = z.object({
  items: z.array(AmazonCustomWorkflowSummarySchema),
});

export type AmazonCustomWorkflowStepKey = z.infer<typeof AmazonCustomWorkflowStepKeySchema>;
export type AmazonCustomWorkflowStepStatus = z.infer<typeof AmazonCustomWorkflowStepStatusSchema>;
export type AmazonCustomWorkflowStatus = z.infer<typeof AmazonCustomWorkflowStatusSchema>;
export type AmazonCustomWorkflowEventAction = z.infer<typeof AmazonCustomWorkflowEventActionSchema>;
export type TransitionAmazonCustomWorkflowStepInput = z.infer<
  typeof TransitionAmazonCustomWorkflowStepInputSchema
>;
export type UpdateAmazonCustomWorkflowStepNoteInput = z.infer<
  typeof UpdateAmazonCustomWorkflowStepNoteInputSchema
>;
export type AmazonCustomWorkflowStepView = z.infer<typeof AmazonCustomWorkflowStepViewSchema>;
export type AmazonCustomWorkflowEventView = z.infer<typeof AmazonCustomWorkflowEventViewSchema>;
export type AmazonCustomWorkflowSummary = z.infer<typeof AmazonCustomWorkflowSummarySchema>;
export type AmazonCustomWorkflowDetail = z.infer<typeof AmazonCustomWorkflowDetailSchema>;
export type AmazonCustomWorkflowWorkspace = z.infer<typeof AmazonCustomWorkflowWorkspaceSchema>;
