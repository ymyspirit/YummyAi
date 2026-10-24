import { z } from "zod";
import { FactoryProductionPinSchema, FactoryDestinationSchema } from "@yummyai/contracts/suppliers/factory-directory";
import { EntityIdSchema as Id } from "@yummyai/contracts/common/ids";
import { ProductionDeliveryManufacturingSchema } from "@yummyai/contracts/order/manufacturing-delivery";
import { FactoryErpStatusViewSchema } from "@yummyai/contracts/order/factory-erp-import";

const Checksum = z.string().regex(/^[a-f0-9]{64}$/);
/** Confirmed business states and the actual 2026-10-21 export vocabulary. */
export const FactoryErpStatusSchema = z.enum(["scheduled", "shipped"]);
export const FactoryErpRawStatusSchema = z.enum(["已审核", "已出库", "已作废"]);
export function mapPillowFactoryErpStatus(raw: string) {
  const status = FactoryErpRawStatusSchema.parse(raw);
  if (status === "已审核") return { status: "scheduled", exception: null } as const;
  if (status === "已出库") return { status: "shipped", exception: null } as const;
  return { status: null, exception: "voided_requires_review" } as const;
}

/** Read projection only: a sealed/downloaded package has not been submitted. */
export function pillowFactoryDeliveryProgress(status: "pending" | "submitted" | "received" | "accepted" | "rejected" | "rework") {
  switch (status) {
    case "pending": return { status: null, label: "待提交", basis: null, exception: null } as const;
    case "submitted": case "received": case "accepted":
      return { status: "scheduled", label: "已排产", basis: "submission_default", exception: null } as const;
    case "rejected": return { status: null, label: "文件被拒收", basis: null, exception: "rejected" } as const;
    case "rework": return { status: null, label: "返工跟进", basis: null, exception: "rework" } as const;
  }
}
export const PRODUCTION_DELIVERY_MAX_ITEMS = 50;
export const ProductionDeliveryQuerySchema = z.object({
  order: Id.optional(), line: Id.optional(), supplier: Id.optional(), factory: Id.optional(), dueBefore: z.iso.datetime().optional(),
}).strict();
export const ProductionDeliverySelectionSchema = z.object({
  productionOrderId: Id, productionVersionId: Id, expectedProjectionVersion: z.int().positive(),
}).strict();
export const CreateProductionDeliverySchema = z.object({
  factoryId: Id,
  supplierId: Id, items: z.array(ProductionDeliverySelectionSchema).min(1).max(PRODUCTION_DELIVERY_MAX_ITEMS),
  idempotencyKey: z.uuid(),
}).strict().refine(v => new Set(v.items.map(i => i.productionOrderId)).size === v.items.length, { path: ["items"], message: "Production orders must be unique" });

export const ProductionDeliveryCostSchema = z.object({
  basis: z.enum(["quote", "confirmed"]), amountMinor: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  currency: z.enum(["CNY", "USD"]), reference: z.string().trim().min(1).max(200),
}).strict();
export const RecordProductionDeliveryFeedbackSchema = z.object({
  kind: z.enum(["submitted", "received", "accepted", "rejected", "rework"]),
  expectedSequence: z.int().nonnegative(), fileChecksum: Checksum, idempotencyKey: z.uuid(),
  reference: z.string().trim().min(1).max(200), note: z.string().trim().min(5).max(2000), occurredAt: z.iso.datetime(),
  verifiedByOperator: z.literal(true), affectedQuantity: z.int().positive().max(100_000).nullable().default(null),
  cost: ProductionDeliveryCostSchema.nullable().default(null), replacementProductionOrderId: Id.nullable().default(null),
  manufacturingChecksum: Checksum.optional(),
}).strict().superRefine((v, ctx) => {
  const rework = v.kind === "rejected" || v.kind === "rework";
  if (rework && v.affectedQuantity === null) ctx.addIssue({code:"custom",path:["affectedQuantity"],message:"Rejection and rework need an affected quantity"});
  if (!rework && (v.affectedQuantity !== null || v.cost !== null || v.replacementProductionOrderId !== null))
    ctx.addIssue({code:"custom",path:["kind"],message:"Only rejection and rework accept repair details"});
  if (v.replacementProductionOrderId !== null && v.kind !== "rework") ctx.addIssue({code:"custom",path:["replacementProductionOrderId"],message:"Only rework may link a replacement"});
});
export const ProductionDeliveryFileSchema = z.object({
  key: z.string(), path: z.string(), checksum: Checksum, byteSize: z.int().positive(),
  width: z.int().positive(), height: z.int().positive(), dpi: z.literal(150), mediaType: z.literal("image/jpeg"),
}).strict();
export const ProductionDeliverySnapshotSchema = z.object({
  factory: FactoryProductionPinSchema.nullable().default(null),
  orderNumber: z.string(), orderLineId: Id, quantity: z.int().positive(), instructions: z.string(),
  skuCode: z.string().nullable().optional(), productTitle: z.string().optional(),
  productionOrderId: Id, productionVersionId: Id, workRevisionId: Id, workRevision: z.int().nonnegative(),
  editorProjectId: Id, editorVersionId: Id, editorVersionNumber: z.int().positive(), renderId: Id,
  templateVersionId: Id.nullable(), sourceVersionId: Id.nullable(), ruleSnapshotChecksum: Checksum.nullable(),
  ruleSnapshotStatus: z.enum(["pinned", "legacy_missing"]), factoryStandardId: z.string(),
  designRunId: Id.nullable(), designRunInputChecksum: Checksum.nullable(),
  sizeMm: z.number().positive(), sizeBasis: z.enum(["artwork", "cut_contour", "finished"]),
  sideMode: z.enum(["single", "double"]), minimumNeckMm: z.number().min(50), minimumNeckBasis: z.literal("cut_contour"),
  expectedCompletionAt: z.iso.datetime(), file: ProductionDeliveryFileSchema,
  logistics: z.object({taskId:Id,externalReference:z.string(),provider:z.enum(["shipos","yunexpress"]),labelMode:z.enum(["factory_pull","include"]),trackingNumbers:z.array(z.string()),labels:z.array(z.object({id:Id,fileName:z.string(),path:z.string(),checksum:Checksum}).strict())}).strict().optional(),
  manufacturing: ProductionDeliveryManufacturingSchema.optional(),
}).strict();
export const ProductionDeliveryFeedbackViewSchema = z.object({
  origin:z.enum(["operator","factory"]).default("operator"),
  id: Id, sequence: z.int().positive(), kind: RecordProductionDeliveryFeedbackSchema.shape.kind,
  reference: z.string(), note: z.string(), occurredAt: z.iso.datetime(), recordedAt: z.iso.datetime(), recordedBy: Id,
  affectedQuantity: z.int().positive().nullable(), cost: ProductionDeliveryCostSchema.nullable(),
  replacementProductionOrderId: Id.nullable(), replacementEditorVersionId: Id.nullable(),
  replacementEditorVersionNumber: z.int().positive().nullable().default(null),
}).strict();
export const ProductionDeliveryItemViewSchema = z.object({
  id: Id, productionOrderId: Id, snapshot: ProductionDeliverySnapshotSchema.nullable(),
  blockers: z.array(z.string()), status: z.enum(["pending", "submitted", "received", "accepted", "rejected"]),
  sequence: z.int().nonnegative(), feedback: z.array(ProductionDeliveryFeedbackViewSchema),
  factoryErp: FactoryErpStatusViewSchema.nullable().default(null),
}).strict();
export const ProductionDeliveryPackageViewSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(1), factory: FactoryDestinationSchema.nullable().default(null),
  id: Id, supplierId: Id, supplierName: z.string(), checksum: Checksum, createdAt: z.iso.datetime(),
  canDownload: z.boolean(), items: z.array(ProductionDeliveryItemViewSchema),
}).strict();
export const ProductionDeliveryCandidateViewSchema = z.object({
  factoryId: Id.nullable().default(null), factoryName: z.string().nullable().default(null), factoryVersionId: Id.nullable().default(null),
  productionOrderId: Id, productionVersionId: Id, projectionVersion: z.int().positive(), supplierId: Id,
  supplierName: z.string(), orderLineId: Id, orderNumber: z.string(), quantity: z.int().positive(),
  expectedCompletionAt: z.iso.datetime(), editorVersionId: Id.nullable(), status: z.string(), blockers: z.array(z.string()),
  parentProductionOrderId: Id.nullable().default(null),
}).strict();
export const ProductionDeliveryWorkspaceSchema = z.object({
  candidates: z.array(ProductionDeliveryCandidateViewSchema), packages: z.array(ProductionDeliveryPackageViewSchema),
  truncated: z.boolean(),
}).strict();
export type CreateProductionDelivery = z.infer<typeof CreateProductionDeliverySchema>;
export type ProductionDeliverySelection = z.infer<typeof ProductionDeliverySelectionSchema>;
export type RecordProductionDeliveryFeedback = z.infer<typeof RecordProductionDeliveryFeedbackSchema>;
export type ProductionDeliverySnapshot = z.infer<typeof ProductionDeliverySnapshotSchema>;
export type ProductionDeliveryPackageView = z.infer<typeof ProductionDeliveryPackageViewSchema>;
export type ProductionDeliveryWorkspace = z.infer<typeof ProductionDeliveryWorkspaceSchema>;
