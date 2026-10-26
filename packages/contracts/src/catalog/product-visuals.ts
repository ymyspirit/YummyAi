import { z } from "zod";
import type { CanvasResultView } from "@yummyai/contracts/pod/canvas-bridge";
import type { StudioImagePricing } from "@yummyai/contracts/ai/studio-image-pricing";

const Id = z.uuidv7();
const Money = z.number().positive().max(10000).multipleOf(0.000001);
export const VisualSlotKeySchema = z.enum(["artwork", "scene", "detail", "customization"]);
export const VISUAL_SLOTS = [
  {
    key: "artwork",
    label: "图稿候选",
    instructions:
      "以授权参考主体制作异形抱枕图稿候选，保持身份、姿态、比例、文字和可见内容；背景透明。生产尺寸、裁线和正反面在原生产编辑器核对。",
  },
  {
    key: "scene",
    label: "场景图",
    instructions:
      "展示参考图中真实的异形抱枕，保留主体图案、轮廓、材质与正反面；仅调整背景和布景，不增加产品数量或未确认配件。",
  },
  {
    key: "detail",
    label: "细节图",
    instructions:
      "围绕真实样品展示已确认的印刷、材质和边缘细节。保持样品轮廓与图案，不虚构背面、拉链、填充或工艺特写。",
  },
  {
    key: "customization",
    label: "定制说明图",
    instructions:
      "只说明当前已经配置的定制字段与操作步骤，使用授权样品示意。使用目标语言；尺寸、单双面、配件和定制选项以固定商品事实为准。",
  },
] as const;
export const VisualDeliverySnapshotSchema = z
  .object({
    version: z.literal(1),
    productType: z.literal("shaped_pillow"),
    groupId: z.uuid(),
    slotKey: VisualSlotKeySchema,
    requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    salesPlanId: Id,
    salesPlanRevision: z.int().positive(),
    sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    sampleAssetId: Id,
    sampleAttestation: z.string().trim().min(1).max(500),
    modelId: Id,
    providerConfigId: Id,
    providerModel: z.string().min(1).max(160),
    providerFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.enum(["1024x1024", "1536x1024", "1024x1536", "2048x2048"]),
    callCeilingUsd: Money,
    totalBudgetUsd: Money,
  })
  .strict()
  .refine((v) => v.totalBudgetUsd >= v.callCeilingUsd, "总预算不能低于单次预算占用");
export const PrepareProductVisualsSchema = z
  .object({
    requestId: z.uuid(),
    expectedRevision: z.int().positive(),
    sampleAssetId: Id,
    referenceAssetIds: z.array(Id).max(8).default([]),
    sampleAttestation: z.string().trim().min(1).max(500),
    modelId: Id,
    size: z.enum(["1024x1024", "1536x1024", "1024x1536", "2048x2048"]).default("2048x2048"),
    direction: z.string().trim().min(1).max(2000),
    callCeilingUsd: Money,
    totalBudgetUsd: Money,
    budgetAttested: z.literal(true),
  })
  .strict()
  .refine((v) => v.totalBudgetUsd >= v.callCeilingUsd, "总预算不能低于单次预算占用")
  .refine(
    (v) =>
      new Set([v.sampleAssetId, ...v.referenceAssetIds]).size === v.referenceAssetIds.length + 1,
    "参考素材不可重复",
  );
export const GenerateProductVisualSchema = z
  .object({
    requestId: z.uuid(),
    modelId: Id,
    slotKey: VisualSlotKeySchema,
    artworkVersionId: Id.optional(),
    prompt: z.string().trim().max(1500).default(""),
    size: z.enum(["1024x1024", "1536x1024", "1024x1536", "2048x2048"]).default("2048x2048"),
    quality: z.enum(["low", "medium", "high"]).default("high"),
  })
  .strict()
  .refine((v) => v.slotKey === "artwork" || !!v.artworkVersionId, "套图需明确选择已审核图稿版本");
export const ReviewProductVisualSchema = z
  .object({
    versionId: Id,
    decision: z.enum(["approve", "reject"]),
    reason: z.string().trim().max(1000).default(""),
    checks: z
      .object({ identity: z.boolean(), shape: z.boolean(), facts: z.boolean(), sides: z.boolean() })
      .strict(),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.decision === "approve" && Object.values(v.checks).some((value) => !value))
      c.addIssue({
        code: "custom",
        path: ["checks"],
        message: "通过前请逐项核对主体、轮廓、商品事实及单双面",
      });
    if (v.decision === "reject" && !v.reason)
      c.addIssue({ code: "custom", path: ["reason"], message: "退回须填写原因" });
  });
export const AdoptProductVisualsSchema = z
  .object({
    expectedRevision: z.int().positive(),
    idempotencyKey: z.uuid(),
    versionIds: z
      .array(Id)
      .length(3)
      .refine((v) => new Set(v).size === v.length, "所选版本不可重复"),
    useSampleAsMain: z.boolean().default(false),
  })
  .strict();
export const CollectProductVisualsSchema = z.object({}).strict();
export type VisualDeliverySnapshot = z.infer<typeof VisualDeliverySnapshotSchema>;
export type VisualSlotKey = z.infer<typeof VisualSlotKeySchema>;
export type ProductVisualTask = {
  id: string;
  projectId: string;
  slotKey: VisualSlotKey;
  status: string;
  model: string;
  createdAt: string;
  error: string | null;
  result: CanvasResultView | null;
  controlledReview: boolean;
  technicalIssues: string[];
};
export type ProductVisualProject = {
  id: string;
  name: string;
  snapshot: VisualDeliverySnapshot;
  slots: Array<{ slotKey: VisualSlotKey; projectId: string }>;
  stale: boolean;
  adoptedRevision: number | null;
  tasks: ProductVisualTask[];
  budget: { occupiedUsd: number; remainingUsd: number; actualUsd: null };
};
export type ProductVisualWorkspace = {
  planId: string;
  revision: number;
  blockers: string[];
  sourceSummary: string[];
  references: Array<{ id: string; fileName: string }>;
  models: Array<{ id: string; label: string; providerLabel: string; selectionRevision: string; imagePricing?: StudioImagePricing }>;
  projects: ProductVisualProject[];
  permissions: { create: boolean; review: boolean; adopt: boolean; sync: boolean };
};
