import { z } from "zod";

export const CANVAS_BRIDGE = {
  protocolVersion: 1,
  pluginVersion: "1.1.0",
  compatiblePluginVersions: ["1.0.0", "1.1.0"],
  upstreamVersion: "v0.18.0",
  upstreamCommit: "d213a74614e0e4bd8a26383d1e1e907249e9c61b",
  sdkVersion: "0.1.0",
  pluginFile: "yummyai-bridge-1.1.0.js",
  maxImageBytes: 20 * 1024 * 1024,
} as const;

const Id = z.uuidv7();
export const CanvasTemplateKeySchema = z.enum(["freeform", "original_pattern", "tire_cover", "shaped_pillow"]);
export const CanvasWorkflowTemplateSchema = z.object({
  key: CanvasTemplateKeySchema, version: z.int().positive(), name: z.string(), description: z.string(),
  productType: z.enum(["tire_cover", "shaped_pillow"]).nullable(),
  steps: z.array(z.object({ key: z.string(), name: z.string(), instructions: z.string() }).strict()).min(1).max(10),
}).strict();
/** Snapshotted at creation: upstream/catalog changes never rewrite an existing task. */
export const CanvasWorkflowSnapshotSchema = z.object({
  template: CanvasWorkflowTemplateSchema, rootBatchId: Id, parentBatchId: Id.nullable(),
  stepIndex: z.int().min(0).max(9), sourceVersionIds: z.array(Id).max(4),
}).strict().refine((value) => value.stepIndex < value.template.steps.length, "工作流步骤无效");
export const CANVAS_WORKFLOW_TEMPLATES: readonly CanvasWorkflowTemplate[] = [
  { key: "freeform", version: 1, name: "自由创作", description: "从空白需求开始，制作并审核设计方案。", productType: null,
    steps: [{ key: "create", name: "创作与审核", instructions: "说明主题、风格、文字和预期用途，完成后回传设计方案供审核。" }] },
  { key: "original_pattern", version: 1, name: "原创图案", description: "先选创意方向，再精修通过的方案。", productType: null,
    steps: [{ key: "concept", name: "创意方案", instructions: "围绕主题制作原创图案，说明风格、配色与需保留的文字。可回传多个方案供筛选。" },
      { key: "refine", name: "精修定稿", instructions: "以审核通过的方案为参考，修正构图、边缘、文字和细节，回传最终图案。" }] },
  { key: "tire_cover", version: 1, name: "备胎罩", description: "图案方向 → 构图定稿 → 关联圆形工艺底稿。", productType: "tire_cover",
    steps: [{ key: "concept", name: "图案方案", instructions: "制作适合圆形备胎罩的原创图案，说明主题与定制文字。重要主体避开边缘；摄像头孔位按工艺底稿核对。" },
      { key: "refine", name: "构图定稿", instructions: "精修通过的图案，核对圆形构图和文字可读性。尺寸、安全区和孔位在关联生产工艺底稿后逐项确认。" }] },
  { key: "shaped_pillow", version: 1, name: "异形抱枕", description: "原创图案 → 轮廓方案 → 关联抱枕工艺底稿。", productType: "shaped_pillow",
    steps: [{ key: "concept", name: "图案方案", instructions: "制作可用于异形抱枕的原创图案，尽量保留完整主体。此处使用通用授权素材；买家照片请从订单进入生产作图。" },
      { key: "refine", name: "轮廓方案", instructions: "精修主体与边缘，检查细长部位。实际尺寸、白边、裁剪线、底部条码区和正反面须在生产作图中按工厂要求确认。" }] },
];
export const ContinueCanvasWorkflowInputSchema = z.object({
  versionIds: z.array(Id).min(1).max(4), prompt: z.string().trim().min(1).max(8_000),
}).strict().refine((v) => new Set(v.versionIds).size === v.versionIds.length, "方案不能重复");
export const ReviewCanvasResultsInputSchema = z.object({
  versionIds: z.array(Id).min(1).max(4), decision: z.enum(["approve", "reject"]), rejectionReason: z.string().trim().max(1_000).optional(),
}).strict().refine((v) => new Set(v.versionIds).size === v.versionIds.length, "方案不能重复")
  .refine((v) => v.decision !== "reject" || !!v.rejectionReason, "请填写退回原因");
export const CanvasProductionInputSchema = z.object({ versionId: Id, templateProjectId: Id, templateVersionId: Id }).strict();
export const CanvasResultViewSchema = z.object({
  versionId: Id, assetId: Id, name: z.string(), status: z.enum(["adapting", "pending_review", "approved", "rejected"]),
  rejectionReason: z.string().nullable(), width: z.number().nullable(), height: z.number().nullable(),
  previewPath: z.string(),
  productionProjects: z.array(z.object({ id: Id, name: z.string(), templateName: z.string() })),
});
export const CanvasProductionTemplateSchema = z.object({
  projectId: Id, versionId: Id, name: z.string(), productType: z.enum(["shaped_pillow", "tire_cover"]),
  versionNumber: z.int().positive(),
});
const Base64 = z.string().min(4).max(Math.ceil(CANVAS_BRIDGE.maxImageBytes / 3) * 4).regex(/^[A-Za-z0-9+/]+={0,2}$/);
export const CreateCanvasBriefInputSchema = z.object({
  requestId: z.uuid(),
  name: z.string().trim().min(1).max(160),
  prompt: z.string().trim().min(1).max(8_000),
  negativePrompt: z.string().trim().max(4_000).default(""),
  referenceAssetIds: z.array(Id).max(10).default([]),
  templateKey: CanvasTemplateKeySchema.default("freeform"),
}).strict().refine((v) => new Set(v.referenceAssetIds).size === v.referenceAssetIds.length, "素材不能重复");

export const SubmitCanvasResultInputSchema = z.object({
  submissionId: z.uuid(),
  protocolVersion: z.literal(CANVAS_BRIDGE.protocolVersion),
  pluginVersion: z.enum(CANVAS_BRIDGE.compatiblePluginVersions),
  upstreamVersion: z.literal(CANVAS_BRIDGE.upstreamVersion),
  sourceNodeId: z.string().min(1).max(160),
  title: z.string().trim().min(1).max(160),
  contentBase64: Base64,
  rightsAttested: z.literal(true),
  sourceKind: z.enum(["owned", "licensed", "ai_generated"]),
  sourceReference: z.string().trim().min(1).max(500),
}).strict();

export const CanvasAssetSchema = z.object({
  id: Id, fileName: z.string(), mediaType: z.string(), version: z.int().positive(), checksumSha256: z.string(),
});
export const CanvasBriefSchema = z.object({
  id: Id, itemId: Id, name: z.string(), prompt: z.string(), negativePrompt: z.string(), status: z.string(),
  referenceAssets: z.array(CanvasAssetSchema), resultCount: z.int().min(0).max(4),
  workflow: CanvasWorkflowSnapshotSchema.nullable().default(null), nextBriefId: Id.nullable().default(null),
});
export const CanvasResultReceiptSchema = z.object({
  batchId: Id, candidateId: Id, versionId: Id, assetId: Id, replayed: z.boolean(),
});

const Envelope = { channel: z.literal("yummyai-canvas"), protocolVersion: z.literal(1), channelId: z.uuid(), requestId: z.uuid() };
export const CanvasRequestSchema = z.discriminatedUnion("type", [
  z.object({ ...Envelope, type: z.literal("ready"), upstreamVersion: z.string().max(80), pluginVersion: z.string().max(80) }).strict(),
  z.object({ ...Envelope, type: z.literal("brief.read") }).strict(),
  z.object({ ...Envelope, type: z.literal("asset.read"), assetId: Id }).strict(),
  z.object({ ...Envelope, type: z.literal("result.submit"), input: SubmitCanvasResultInputSchema }).strict(),
]);
export const CanvasResponseSchema = z.object({
  ...Envelope, type: z.literal("response"), ok: z.boolean(), payload: z.unknown().optional(), error: z.string().max(1_000).optional(),
}).strict();

export type CreateCanvasBriefInput = z.infer<typeof CreateCanvasBriefInputSchema>;
export type SubmitCanvasResultInput = z.infer<typeof SubmitCanvasResultInputSchema>;
export type CanvasBrief = z.infer<typeof CanvasBriefSchema>;
export type CanvasResultReceipt = z.infer<typeof CanvasResultReceiptSchema>;
export type CanvasRequest = z.infer<typeof CanvasRequestSchema>;
export type CanvasResponse = z.infer<typeof CanvasResponseSchema>;
export type CanvasWorkflowTemplate = z.infer<typeof CanvasWorkflowTemplateSchema>;
export type CanvasWorkflowSnapshot = z.infer<typeof CanvasWorkflowSnapshotSchema>;
export type CanvasResultView = z.infer<typeof CanvasResultViewSchema>;
export type CanvasProductionTemplate = z.infer<typeof CanvasProductionTemplateSchema>;

export function canvasVersionSupported(version: string, pluginVersion: string): boolean {
  return version.replace(/^v/, "") === CANVAS_BRIDGE.upstreamVersion.slice(1) && (CANVAS_BRIDGE.compatiblePluginVersions as readonly string[]).includes(pluginVersion);
}
