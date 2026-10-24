import { z } from "zod";
import { EntityIdSchema as Id } from "@yummyai/contracts/common/ids";
import { FactoryErpAssociationPinSchema, FactoryErpAssociationViewSchema } from "@yummyai/contracts/order/factory-erp-association";
import { FactoryErpVoidSummarySchema } from "@yummyai/contracts/order/factory-erp-void-review";

export const FACTORY_ERP_TEMPLATE = "pillow-erp-2026-10-21-v1" as const;
export const FACTORY_ERP_MAX_BYTES = 5 * 1024 * 1024;
export const FACTORY_ERP_HEADERS = ["编号", "来源", "订单号", "运单号", "尺寸", "定制内容", "商品种类", "商品总数", "快递提供商", "快递服务", "状态", "创建时间", "更新时间"] as const;
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const FactoryErpOptionsSchema = z.object({
  sheetName: z.string().min(1).max(100).optional(),
  csvEncoding: z.enum(["utf-8", "gb18030"]).optional(),
  delimiter: z.enum([",", "\t", ";"]).optional(),
}).strict();
export type FactoryErpOptions = z.infer<typeof FactoryErpOptionsSchema>;
export const FactoryErpDiagnosticSchema = z.object({
  code: z.string().regex(/^[a-z0-9_]+$/).max(100), rowNumber: z.int().positive().nullable(),
}).strict();
export type FactoryErpDiagnostic = z.infer<typeof FactoryErpDiagnosticSchema>;
export const FactoryErpExportRowSchema = z.object({
  rowNumber: z.int().min(2).max(5001), rawCells: z.array(z.string().max(4000)).length(13),
  externalId: z.string().min(1).max(4000), sourceLabel: z.string().max(4000), orderReference: z.string().max(4000),
  trackingReference: z.string().max(4000), sizeText: z.string().max(4000), customizationText: z.string().max(4000),
  itemKinds: z.int().positive().max(100000), itemQuantity: z.int().positive().max(100000),
  carrier: z.string().max(4000), carrierService: z.string().max(4000), rawStatus: z.string().min(1).max(4000),
  createdAtLocal: z.string().max(100), updatedAtLocal: z.string().max(100),
}).strict();
export type FactoryErpExportRow = z.infer<typeof FactoryErpExportRowSchema>;
export const FactoryErpParsedSchema = z.object({
  format: z.enum(["xlsx", "csv"]), sheetName: z.string().nullable(), headers: z.array(z.string()).length(13),
  rows: z.array(FactoryErpExportRowSchema).min(1).max(5000), diagnostics: z.array(FactoryErpDiagnosticSchema).max(10000),
  coverage: z.literal("current_page_or_unspecified"),
}).strict();
export type FactoryErpParsed = z.infer<typeof FactoryErpParsedSchema>;
export const UploadFactoryErpImportSchema = z.object({
  factoryId: Id, fileName: z.string().min(1).max(200).regex(/^[^\\/]+\.(xlsx|csv)$/i).refine(value => !Array.from(value).some(char => char.charCodeAt(0) < 32)),
  contentBase64: z.string().min(4).max(4 * Math.ceil(FACTORY_ERP_MAX_BYTES / 3)).refine(value => {
    const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
    return value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value) && value.length / 4 * 3 - padding <= FACTORY_ERP_MAX_BYTES;
  }, "Invalid bounded base64 source"),
  checksumSha256: Hash, options: FactoryErpOptionsSchema.default({}), idempotencyKey: z.uuid(),
}).strict();
export type UploadFactoryErpImport = z.infer<typeof UploadFactoryErpImportSchema>;
export const FactoryErpItemSelectionSchema = z.object({
  deliveryItemId: Id, productionOrderId: Id, productionVersionId: Id, fileChecksum: Hash, manufacturingChecksum: Hash,
}).strict();
export type FactoryErpItemSelection = z.infer<typeof FactoryErpItemSelectionSchema>;
export const FactoryErpRowBindingSchema = z.object({
  rowNumber: z.int().min(2).max(5001), items: z.array(FactoryErpItemSelectionSchema).min(1).max(50),
  wholeGroupConfirmed: z.literal(true), association: FactoryErpAssociationPinSchema.optional(),
}).strict().refine(v => new Set(v.items.map(i => i.deliveryItemId)).size === v.items.length && new Set(v.items.map(i => i.productionOrderId)).size === v.items.length, { message: "Original production orders must be unique", path: ["items"] });
export const ApplyFactoryErpImportSchema = z.object({
  fileChecksum: Hash, previewChecksum: Hash, idempotencyKey: z.uuid(),
  rows: z.array(FactoryErpRowBindingSchema).min(1).max(5000), confirmed: z.literal(true),
}).strict().superRefine((v, ctx) => {
  if (new Set(v.rows.map(r => r.rowNumber)).size !== v.rows.length) ctx.addIssue({ code: "custom", path: ["rows"], message: "Row numbers must be unique" });
  const ids = v.rows.flatMap(r => r.items.map(i => i.deliveryItemId));
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", path: ["rows"], message: "A delivery item cannot belong to multiple heads" });
  const orders = v.rows.flatMap(r => r.items.map(i => i.productionOrderId));
  if (new Set(orders).size !== orders.length) ctx.addIssue({ code: "custom", path: ["rows"], message: "An original production order cannot belong to multiple heads" });
});
export type ApplyFactoryErpImport = z.infer<typeof ApplyFactoryErpImportSchema>;
export const FactoryErpPageQuerySchema = z.object({ offset: z.coerce.number().int().min(0).max(5000).default(0), limit: z.coerce.number().int().min(1).max(100).default(25) }).strict();
export const FactoryErpCandidatesQuerySchema = z.object({
  factoryId: Id, q: z.string().max(200).optional(), cursor: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
}).strict();
export const FactoryErpCandidateSchema = FactoryErpItemSelectionSchema.extend({
  orderLineId: Id, orderNumber: z.string(), quantity: z.int().positive(), packageId: Id,
  submittedFeedbackId: Id, submittedAt: z.iso.datetime(), bindingId: Id.nullable(), externalId: z.string().nullable(),
}).strict();
export const FactoryErpCandidatePageSchema = z.object({ items: z.array(FactoryErpCandidateSchema), nextCursor: z.string().nullable() }).strict();
export type FactoryErpCandidatePage = z.infer<typeof FactoryErpCandidatePageSchema>;
export const FactoryErpStatusViewSchema = z.object({
  bindingId: Id, externalId: z.string(), status: z.enum(["scheduled", "shipped"]).nullable(),
  exception: z.literal("voided_requires_review").nullable(), observationId: Id, importId: Id,
  rawStatus: z.string(), updatedAtLocal: z.string(), recordedAt: z.iso.datetime(),
  trackingReference: z.string(), carrier: z.string(), carrierService: z.string(), shippedQuantity: z.null(),
  privateSourceExpired: z.boolean().optional(), bindingRevision: z.int().positive().optional(),
  bindingReleased: z.boolean().optional(), bindingReleaseId: Id.nullable().optional(), historicalStatus: z.enum(["scheduled", "shipped"]).nullable().optional(),
  voidSummary: FactoryErpVoidSummarySchema.optional(),
}).strict();
export type FactoryErpStatusView = z.infer<typeof FactoryErpStatusViewSchema>;
export const FactoryErpPreviewRowSchema = FactoryErpExportRowSchema.extend({
  diagnostics: z.array(FactoryErpDiagnosticSchema), binding: z.object({ id: Id, items: z.array(FactoryErpItemSelectionSchema) }).strict().nullable(),
  association: FactoryErpAssociationViewSchema.optional(),
}).strict();
export const FactoryErpImportViewSchema = z.object({
  id: Id, factoryId: Id, fileName: z.string(), fileChecksum: Hash, byteSize: z.int().positive(),
  templateVersion: z.literal(FACTORY_ERP_TEMPLATE), previewChecksum: Hash, format: z.enum(["xlsx", "csv"]),
  options: FactoryErpOptionsSchema, sheetName: z.string().nullable(), headers: z.array(z.string()).length(13),
  coverage: z.literal("current_page_or_unspecified"), rowCount: z.int().positive(),
  diagnostics: z.array(FactoryErpDiagnosticSchema), rows: z.array(FactoryErpPreviewRowSchema),
  offset: z.int().nonnegative(), limit: z.int().positive(), createdAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
}).strict();
export type FactoryErpImportView = z.infer<typeof FactoryErpImportViewSchema>;
export const FactoryErpImportListQuerySchema = z.object({ factoryId: Id, cursor: z.string().max(300).optional(), limit: z.coerce.number().int().min(1).max(100).default(20) }).strict();
export const FactoryErpImportListSchema = z.object({ items: z.array(FactoryErpImportViewSchema.omit({ rows: true, diagnostics: true, headers: true, offset: true, limit: true })), nextCursor: z.string().nullable() }).strict();
export const FactoryErpApplyResultSchema = z.object({
  id: Id, importId: Id, fileChecksum: Hash, previewChecksum: Hash, requestChecksum: Hash,
  createdAt: z.iso.datetime(), appliedRows: z.int().positive(), observations: z.array(z.object({
    rowNumber: z.int().positive(), bindingId: Id, observationId: Id,
    disposition: z.enum(["advanced", "unchanged", "exception"]), status: z.enum(["scheduled", "shipped"]).nullable(),
  }).strict()),
}).strict();
export type FactoryErpApplyResult = z.infer<typeof FactoryErpApplyResultSchema>;

/** Non-private lifecycle receipts never carry file names, raw cells or storage pointers. */
export const FactoryErpSourceLifecycleSchema = z.object({
  id: Id, factoryId: Id, fileChecksum: Hash, byteSize: z.int().min(1).max(FACTORY_ERP_MAX_BYTES),
  templateVersion: z.literal(FACTORY_ERP_TEMPLATE), previewChecksum: Hash,
  createdAt: z.iso.datetime(), expiresAt: z.iso.datetime(), checkedAt: z.iso.datetime(),
  access: z.enum(["retained", "expired"]), privateRedactedAt: z.iso.datetime().nullable(),
  purgeStatus: z.enum(["not_due", "pending", "running", "failed", "purged"]),
  attempts: z.int().nonnegative(), nextAttemptAt: z.iso.datetime().nullable(), purgedAt: z.iso.datetime().nullable(),
  lastApplicationId: Id.nullable(),
}).strict().superRefine((value, ctx) => {
  const retained = Date.parse(value.expiresAt) > Date.parse(value.checkedAt) && value.privateRedactedAt === null;
  if ((value.access === "retained") !== retained || retained && (value.privateRedactedAt !== null || value.purgeStatus !== "not_due" || value.purgedAt !== null))
    ctx.addIssue({ code: "custom", message: "Source access must match the server retention boundary" });
  if (!retained && value.purgeStatus === "not_due" || (value.purgeStatus === "purged") !== (value.purgedAt !== null) || value.purgedAt !== null && (value.privateRedactedAt === null || Date.parse(value.purgedAt) < Date.parse(value.privateRedactedAt)))
    ctx.addIssue({ code: "custom", message: "Physical deletion requires a completed private-redaction receipt" });
});
export type FactoryErpSourceLifecycle = z.infer<typeof FactoryErpSourceLifecycleSchema>;
export const FactoryErpSourceLifecyclePageSchema = z.object({
  items: z.array(FactoryErpSourceLifecycleSchema).max(100), nextCursor: Id.nullable(),
}).strict();
export type FactoryErpSourceLifecyclePage = z.infer<typeof FactoryErpSourceLifecyclePageSchema>;
export const FactoryErpApplicationListQuerySchema = z.object({
  cursor: Id.optional(), limit: z.coerce.number().int().min(1).max(100).default(20),
}).strict();
export const FactoryErpApplicationPageSchema = z.object({
  items: z.array(FactoryErpApplyResultSchema.pick({ id: true, importId: true, createdAt: true, appliedRows: true })).max(100), nextCursor: Id.nullable(),
}).strict();
export type FactoryErpApplicationPage = z.infer<typeof FactoryErpApplicationPageSchema>;
