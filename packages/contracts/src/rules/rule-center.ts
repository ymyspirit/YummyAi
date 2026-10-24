import { z } from "zod";
import { EntityIdSchema as Id } from "@yummyai/contracts/common/ids";
import { ProductionProductTypeSchema, SHAPED_PILLOW_FACTORY_STANDARD } from "@yummyai/contracts/pod/production-editor";

export const RuleCategorySchema = z.enum(["general", "production", "ai_workflow", "acceptance"]);
export const RuleBindingSchema = z.enum(["manual", "original_assets", "faithful_enhancement", "pillow_factory", "effective_dpi", "super_resolution", "subject_measurement", "pillow_pipeline_v1"]);
export const RuleExecutionSchema = z.enum(["automatic", "manual", "unavailable"]);
export const RULE_CATEGORY_LABELS = { general: "通用规范", production: "商品工艺", ai_workflow: "AI 制作流程", acceptance: "验收标准" } as const;
export const RULE_EXECUTION_LABELS = { automatic: "已自动执行", manual: "需人工核验", unavailable: "尚未接入" } as const;
export const RULE_BINDINGS = {
  manual: { execution: "manual", location: "运营按规则核验；文字不会自动改写工艺或模型指令" },
  original_assets: { execution: "automatic", location: "无人设计素材准备：保留原件和来源校验值，另存处理结果" },
  faithful_enhancement: { execution: "automatic", location: "无人设计启动检查配方，顾客图片执行保真美化" },
  pillow_factory: { execution: "automatic", location: "无人设计启动核验工厂标准；生产预检与导出按固定工艺执行" },
  effective_dpi: { execution: "automatic", location: "生产预检：按像素与印刷尺寸检查有效分辨率，低于要求阻止通过" },
  super_resolution: { execution: "unavailable", location: "自动超分尚未接入；分辨率不足时需要处理后重新预检" },
  subject_measurement: { execution: "unavailable", location: "无人设计与手工作业的主体透明度测量阈值尚未统一" },
  pillow_pipeline_v1: { execution: "automatic", location: "仅显式固定 pillow-subject-v1-2026-09-19 配方的新任务：统一 alpha 32 主体测量、按需固定版本超分及独立裁线；旧任务不适用" },
} as const satisfies Record<z.infer<typeof RuleBindingSchema>, { execution: z.infer<typeof RuleExecutionSchema>; location: string }>;

export const RuleFieldsSchema = z.object({
  name: z.string().trim().min(1).max(120), category: RuleCategorySchema,
  instructions: z.string().trim().min(1).max(6000), source: z.string().trim().min(1).max(1200),
  appliesTo: z.enum(["order_design", "operations"]),
  scopeKind: z.enum(["all", "product_type", "spu"]),
  productType: ProductionProductTypeSchema.nullable(), spuId: Id.nullable(),
}).strict();
export const RuleDefinitionSchema = RuleFieldsSchema.extend({ binding: RuleBindingSchema }).strict();
function validScope(value: z.infer<typeof RuleFieldsSchema>) {
  return value.scopeKind === "all" ? value.productType === null && value.spuId === null
    : value.scopeKind === "product_type" ? value.productType !== null && value.spuId === null
      : value.spuId !== null && value.productType === null;
}
export const SaveRuleInputSchema = z.object({
  fields: RuleFieldsSchema.refine(validScope, "适用范围不完整"),
  changeReason: z.string().trim().min(1).max(600),
  expectedRevision: z.int().nonnegative(), idempotencyKey: z.uuid(),
}).strict();
export const ChangeRuleStateSchema = z.object({
  expectedRevision: z.int().positive(), version: z.int().positive(),
  changeReason: z.string().trim().min(1).max(600),
}).strict();
export const RuleVersionSchema = RuleDefinitionSchema.extend({
  id: Id, ruleId: Id, version: z.int().positive(), createdAt: z.iso.datetime(), changeReason: z.string(),
  execution: RuleExecutionSchema, executionLocation: z.string(),
});
export const RuleRowSchema = z.object({
  id: Id, code: z.string(), revision: z.int().positive(), latestVersion: z.int().positive(),
  activeVersion: z.int().positive().nullable(), builtIn: z.boolean(), updatedAt: z.iso.datetime(),
  latest: RuleVersionSchema, active: RuleVersionSchema.nullable(),
});
export const RuleWorkspaceSchema = z.object({
  rules: z.array(RuleRowSchema), spus: z.array(z.object({ id: Id, code: z.string(), name: z.string(), productTypes: z.array(ProductionProductTypeSchema).default([]) })),
  canManage: z.boolean(), canPublish: z.boolean(),
  factoryStandard: z.object({
    id: z.string(), dpi: z.number(), format: z.string(), background: z.string(), whiteBorderPx: z.number(),
    cutLinePx: z.number(), panelGapPx: z.number(), sheetMarginPx: z.number(), barcodeWidthPx: z.number(), barcodeHeightPx: z.number(), minimumNeckMm: z.number(),
  }),
});
export const RuleHistorySchema = z.object({
  versions: z.array(RuleVersionSchema),
  events: z.array(z.object({ action: z.enum(["create", "revise", "publish", "disable"]), version: z.int().positive(), reason: z.string(), createdAt: z.iso.datetime() })),
});
/** Full immutable definition, not a pointer to today's mutable active version. */
export const RulePinSchema = RuleVersionSchema.extend({ code: z.string() });
export const OrderRuleSnapshotSchema = z.object({ schemaVersion: z.literal(1), capturedAt: z.iso.datetime(), rules: z.array(RulePinSchema) });
export type RuleFields = z.infer<typeof RuleFieldsSchema>;
export type RuleDefinition = z.infer<typeof RuleDefinitionSchema>;
export type RuleVersion = z.infer<typeof RuleVersionSchema>;
export type RuleRow = z.infer<typeof RuleRowSchema>;
export type RuleWorkspace = z.infer<typeof RuleWorkspaceSchema>;
export type RuleHistory = z.infer<typeof RuleHistorySchema>;
export type OrderRuleSnapshot = z.infer<typeof OrderRuleSnapshotSchema>;
export type SaveRuleInput = z.infer<typeof SaveRuleInputSchema>;

/** Manual requirements can be revised; prose cannot change an automatic binding. */
export function canEditRuleText(rule: { builtIn: boolean; latest: { binding: RuleVersion["binding"] } }) {
  return !rule.builtIn || rule.latest.binding === "manual";
}

const global = { scopeKind: "all", productType: null, spuId: null } as const;
const pillow = { scopeKind: "product_type", productType: "shaped_pillow", spuId: null } as const;
const source = "已确认的异形抱枕制作要求；docs/operations/custom-pillow-workflow.md";
/** Baseline bindings are code-owned. Editing free text cannot confer automatic execution. */
export const INITIAL_RULES: Array<RuleDefinition & { code: string }> = [
  { code: "pillow-pipeline-v1-2026-09-19", name: "异形抱枕 V1 主体测量与按需超分", category: "ai_workflow", ...pillow, appliesTo: "order_design", binding: "pillow_pipeline_v1", source,
    instructions: "仅在显式启用并审核的 pillow-subject-v1-2026-09-19 配方中执行。必须先保真美化，由固定 gpt-image-2.5 路由完成抠图和外伸长胡须处理；按 alpha ≥ 32 的同一可见主体核验尺寸与分辨率，必要时使用已固定工具及模型指纹的 Real-ESRGAN 补强。锁定图案后只优化独立裁线，200 px 基础缝边和最多 30 px 局部圆滑余量；完整 JPG 待审稿仍需运营核验。旧配方与历史快照不会自动升级。" },
  { code: "original-assets", name: "保留顾客原图与处理来源", category: "general", ...global, appliesTo: "order_design", binding: "original_assets", source,
    instructions: "保留顾客原始图片，处理结果另存。美化与抠图须可追溯到原图；生产文件修改生成新版本。" },
  { code: "test-cleanup", name: "各模块测试完成后清理测试数据", category: "general", ...global, appliesTo: "operations", binding: "manual", source: "用户确认；CLAUDE.md / AGENTS.md · Change and Test Discipline",
    instructions: "记录测试创建的准确 ID，使用支持的删除或归档流程，清理相关资源并核对列表、搜索和数量。保留真实业务数据及必需的不可变历史；清理未完成须说明。" },
  { code: "pillow-factory", name: "异形抱枕工厂交付标准", category: "production", ...pillow, appliesTo: "order_design", binding: "pillow_factory", source: `用户确认的 PS 制作教程；工厂标准 ${SHAPED_PILLOW_FACTORY_STANDARD.id}`,
    instructions: "使用已确认工厂标准的固定工艺底稿。尺寸以图案最长边为依据；正反片同文件横向排版，底部留空白条码框。交付参数直接引用工厂标准，不在规则文字中另存一套数值。" },
  { code: "pillow-contour", name: "主体与裁剪线分开处理", category: "production", ...pillow, appliesTo: "order_design", binding: "manual", source,
    instructions: "外伸过长的胡须在抠图阶段处理，以脸颊毛发主体为安全白边依据。抠图确认后的图案保持不变；优化独立黑色裁剪线，使其圆滑、可缝合，必要时白边可小幅超出基准。核验细颈、耳部、正反轮廓与文字方向。" },
  { code: "faithful-enhancement", name: "所有顾客图片执行保真美化", category: "ai_workflow", ...global, appliesTo: "order_design", binding: "faithful_enhancement", source,
    instructions: "不论顾客是否选择图片美化，顾客图片均先保真美化，再按配方处理。保留人物或宠物身份、花纹与颜色。启动时核对配方，不满足时暂停，不擅自更改模型授权或预算。" },
  { code: "pillow-model", name: "使用配置的 image-2.5 完成抠图", category: "ai_workflow", ...pillow, appliesTo: "order_design", binding: "manual", source,
    instructions: "在工艺底稿的自动制图配方中选择已配置的 image-2.5 模型；不用内置脚本替代抠图。每次派发固定模型路由、提供方和配方，运营核对模型与抠图结果。" },
  { code: "super-resolution", name: "有效分辨率不足时的超分处理", category: "ai_workflow", ...pillow, appliesTo: "order_design", binding: "super_resolution", source,
    instructions: "有效分辨率不足须补足像素并检查失真，再重新生成生产稿。仅修改 DPI 元数据不提高图案清晰度。目前需人工接管执行，自动超分尚未接入。" },
  { code: "subject-measurement", name: "统一可见主体的测量口径", category: "ai_workflow", ...pillow, appliesTo: "order_design", binding: "subject_measurement", source,
    instructions: "尺寸应按可见主体测量。当前无人设计与手工处理的透明度阈值尚未统一；运营核对实际主体最长边，不能只看整张图片的像素数。" },
  { code: "effective-dpi", name: "检查实际图案分辨率和输出 DPI", category: "acceptance", ...pillow, appliesTo: "order_design", binding: "effective_dpi", source,
    instructions: "生产预检同时核验图像像素与摆放尺寸形成的有效分辨率，以及文件输出 DPI。低分辨率不能通过修改元数据或勾选确认绕过。" },
  { code: "operator-review", name: "运营核对后才能批准生产稿", category: "acceptance", ...global, appliesTo: "order_design", binding: "manual", source,
    instructions: "自动检查通过后仍须运营查看原图与完整生产文件，核对身份、裁切、尺寸、文字、正反面、缝边和条码位置。通过或写明驳回理由；技术预检不等同于运营审核、工厂验收或生产放行。" },
];
