import { z } from "zod";
import { ErpContextAuthoritySchema } from "@yummyai/contracts/auth/session";
import { StudioGenerateRequestSchema, StudioSelectionRevisionSchema } from "@yummyai/contracts/pod/creative-studio";
import { StudioScopeSchema } from "@yummyai/contracts/pod/studio-address";
import { StudioImagePricingSchema, StudioImageUsdSchema } from "@yummyai/contracts/ai/studio-image-pricing";
import { VisualDeliverySnapshotSchema } from "@yummyai/contracts/catalog/product-visuals";
import { CreativeOwnerResponseAdoptionReceiptSchema } from "@yummyai/contracts/harness/creative-owner-response-adoption";
export { StudioImagePricingSchema, StudioImageUsdSchema, StudioImageReservationSchema } from "@yummyai/contracts/ai/studio-image-pricing";
export type { StudioImagePricing } from "@yummyai/contracts/ai/studio-image-pricing";

const Id = z.uuidv7();
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const StudioPaidImageInputSchema = StudioGenerateRequestSchema.extend({ capability: z.literal("image") }).strict();
export type StudioPaidImageInput = z.infer<typeof StudioPaidImageInputSchema>;
export const StudioPaidImageQuoteSchema = z.object({
  version: z.literal(1), quoteHash: Hash, inputFingerprint: Hash,
  modelId: Id, providerConfigId: Id, model: z.string().max(500), label: z.string().max(500), providerLabel: z.string().max(500),
  selectionRevision: StudioSelectionRevisionSchema, providerFingerprint: Hash,
  contextAuthority: ErpContextAuthoritySchema,
  unit: z.literal("image"), count: z.literal(1), currency: z.literal("USD"), basis: z.literal("operator_estimate"),
  pricing: StudioImagePricingSchema, size: z.string().max(30), quality: z.enum(["auto", "low", "medium", "high"]),
  background: z.enum(["auto", "transparent", "opaque"]),
  references: z.array(z.object({ assetId: Id, version: z.int().positive(), checksum: Hash }).strict()).max(10),
  visualDelivery: VisualDeliverySnapshotSchema.optional(),
  createdAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
}).strict();
export type StudioPaidImageQuote = z.infer<typeof StudioPaidImageQuoteSchema>;
export const StudioPaidImageAdmissionSchema = z.object({
  version: z.literal(1), enabled: z.boolean(), code: z.enum(["ready", "operator_paused"]),
}).strict().refine(value => value.enabled === (value.code === "ready"), "Admission state is inconsistent");
export const StudioPaidImageRequestSchema = z.object({
  version: z.literal(1), id: Id, scope: StudioScopeSchema, requestId: z.uuid(), originalInput: StudioPaidImageInputSchema, input: StudioPaidImageInputSchema,
  quote: StudioPaidImageQuoteSchema,
  status: z.enum(["prepared", "cancelled", "queued", "running", "completed", "failed", "uncertain"]),
  generationId: Id.nullable(), createdAt: z.iso.datetime(), committedAt: z.iso.datetime().nullable(),
  admission: StudioPaidImageAdmissionSchema,
  responseAdoption: CreativeOwnerResponseAdoptionReceiptSchema.optional(),
  execution: z.object({ phase: z.string().max(80).nullable(), costUsd: StudioImageUsdSchema.nullable(),
    budgetState: z.enum(["reserved", "committed", "released"]).nullable(), budgetAmountUsd: z.string().regex(/^(0|[1-9]\d{0,7})\.\d{6}$/).nullable(),
    errorCode: z.string().max(120).nullable() }).strict(),
  result: z.object({ assetId: Id, namespace: z.literal("image_files"), key: z.string().max(500), mediaType: z.string().max(160),
    checksumSha256: Hash, byteSize: z.int().positive(), rightsStatus: z.enum(["unverified", "approved", "rejected"]) }).strict().nullable(),
}).strict();
export type StudioPaidImageRequest = z.infer<typeof StudioPaidImageRequestSchema>;
export const StudioPaidImageLookupSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("missing"), scope: StudioScopeSchema, requestId: z.uuid() }).strict(),
  z.object({ status: z.literal("found"), request: StudioPaidImageRequestSchema }).strict(),
]);
export type StudioPaidImageLookup = z.infer<typeof StudioPaidImageLookupSchema>;
export const StudioPaidImagePageSchema = z.object({ items: z.array(StudioPaidImageRequestSchema).max(40), nextCursor: Id.nullable() }).strict();
export const StudioPaidImageAbandonSchema = z.object({ version: z.literal(1), id: Id, scope: StudioScopeSchema,
  requestId: z.uuid(), status: z.literal("cancelled") }).strict();

const Errors = [
  ["studio_paid_image_invalid", 400, "请核对单张图片的模型与实际生成参数"],
  ["studio_visual_image_changed", 409, "套图方案 样品 图稿或模型已变化 请核对原报价"],
  ["studio_visual_image_budget_exceeded", 409, "本套图预算预留不足 请核对原任务占用与额度"],
  ["studio_visual_image_attempt_limit", 409, "本步骤尝试次数或本人并行任务已达上限 请核对已有任务"],
  ["studio_paid_image_missing", 404, "尚未找到原生图准备 请继续按原编号核对"],
  ["studio_paid_execution_paused", 409, "真实付费生成尚未启用 已保存的准备可以继续核对"],
  ["studio_paid_image_changed", 409, "原输入 模型 报价 权限或参考图已变化 请先核对原请求"],
  ["studio_paid_image_expired", 409, "本次报价已过期 请取消尚未提交的准备后重新报价"],
  ["studio_paid_image_cancelled", 409, "本次准备已取消 原编号不能再次提交"],
  ["studio_image_pricing_required", 409, "所选图片模型尚未配置每张预估费用与预算预留"],
  ["studio_image_budget_required", 409, "组织图片任务与月度预算尚未配置或剩余额度不足"],
  ["studio_image_budget_changed", 409, "组织预算已被更新 请重新读取当前金额后保存"],
  ["studio_image_budget_invalid", 400, "请填写有效的组织月预算 默认任务预留上限和单张图片预留上限"],
  ["studio_image_budget_forbidden", 403, "组织预算需要具备组织范围模型配置权限的管理员维护"],
  ["studio_image_budget_unavailable", 503, "组织预算暂时无法读取 原设置与任务占用保持"],
] as const;
export function publicStudioPaidImageError(code: unknown, status: number) {
  const row = Errors.find(value => value[0] === code && value[1] === status);
  return row && { code: row[0], status: row[1], message: row[2] };
}
