import { z } from "zod";

import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { ErpContextAuthoritySchema } from "@yummyai/contracts/auth/session";

export const ShipmentStatusSchema = z.enum([
  "draft", "approved", "writeback_pending", "shipped", "in_transit", "delivered", "exception", "cancelled",
]);

export const TrackingStatusSchema = z.enum([
  "information_received", "picked_up", "in_transit", "out_for_delivery", "delivered", "delivery_exception", "returned",
]);

export const ShipmentProductionAllocationInputSchema = z.object({
  productionOrderId: EntityIdSchema,
  productionVersionId: EntityIdSchema,
  qualityInspectionId: EntityIdSchema,
  qualityGroupId: EntityIdSchema.nullable().optional(),
  expectedProductionProjectionVersion: z.int().positive(),
  quantity: z.int().positive().max(100_000),
}).strict();

export const ShipmentPackageLineInputSchema = z.object({
  orderLineId: EntityIdSchema,
  quantity: z.number().int().positive().max(100_000),
  // Omission is retained for exact historical receipt recovery. New writes require sources.
  productionAllocations: z.array(ShipmentProductionAllocationInputSchema).min(1).max(100).optional(),
}).strict().superRefine(validateShipmentProductionAllocations);

export function validateShipmentProductionAllocations(line: { quantity: number; productionAllocations?: ShipmentProductionAllocationInput[] }, context: z.RefinementCtx) {
  if (!line.productionAllocations) return;
  if (line.productionAllocations.reduce((sum, source) => sum + source.quantity, 0) !== line.quantity)
    context.addIssue({ code: "custom", path: ["productionAllocations"], message: "生产来源分配总数必须等于装箱数量" });
  if (new Set(line.productionAllocations.map(shipmentProductionSourceKey)).size !== line.productionAllocations.length)
    context.addIssue({ code: "custom", path: ["productionAllocations"], message: "同一包裹商品不能重复分配同一生产批次或实物组" });
}

export function shipmentProductionSourceKey(source: { productionOrderId: string; qualityGroupId?: string | null }) {
  return source.qualityGroupId ? source.productionOrderId + ":" + source.qualityGroupId : source.productionOrderId;
}

export const ShipmentProductionSourceSchema = z.object({
  orderLineId: EntityIdSchema, productionOrderId: EntityIdSchema, productionVersionId: EntityIdSchema,
  versionNumber: z.int().positive(), projectionVersion: z.int().positive(),
  source: z.enum(["initial", "remake"]), status: z.string(), quantity: z.int().positive(),
  qualityInspectionId: EntityIdSchema.nullable(), inspectedAt: z.string().nullable(),
  qualityGroupId: EntityIdSchema.nullable().default(null), groupLabel: z.string().nullable().default(null),
  allocatedQuantity: z.int().nonnegative(), availableQuantity: z.int().nonnegative(),
  blockers: z.array(z.string()),
}).strict();
export type ShipmentProductionSource = z.infer<typeof ShipmentProductionSourceSchema>;
export type ShipmentProductionAllocationInput = z.infer<typeof ShipmentProductionAllocationInputSchema>;

/** A complete, same-snapshot basis for the original partial/multi-package form.
 * Quantities are original order and production facts, not a client reservation. */
export const ShipmentCreateWorkspaceSchema = z.object({
  orderId: EntityIdSchema,
  orderNumber: z.string().min(1).max(2_000),
  orderSequence: z.int().positive(),
  contextAuthority: ErpContextAuthoritySchema,
  lines: z.array(z.object({ lineId: EntityIdSchema, title: z.string().max(20_000), quantity: z.int().positive() }).strict()).min(1).max(100),
  sources: z.array(ShipmentProductionSourceSchema).max(1_000),
  canCreate: z.boolean(),
  blockers: z.array(z.string().min(1).max(2_000)).max(100),
}).strict().superRefine((value, context) => {
  const lines = new Set(value.lines.map(line => line.lineId));
  if (lines.size !== value.lines.length || value.sources.some(source => !lines.has(source.orderLineId)))
    context.addIssue({ code: "custom", message: "装箱依据必须完整归属于同一原订单" });
  if (new Set(value.sources.map(source => `${source.orderLineId}:${shipmentProductionSourceKey(source)}`)).size !== value.sources.length)
    context.addIssue({ code: "custom", path: ["sources"], message: "装箱依据不能重复生产批次或实物组" });
  if (value.canCreate && value.blockers.length)
    context.addIssue({ code: "custom", path: ["canCreate"], message: "有阻断原因时不能创建包裹草稿" });
});
export type ShipmentCreateWorkspace = z.infer<typeof ShipmentCreateWorkspaceSchema>;

export const ShipmentPackageInputSchema = z.object({
  packageReferenceId: z.string().trim().min(1).max(160),
  trackingNumber: z.string().trim().min(1).max(200),
  carrierCode: z.string().trim().regex(/^[A-Z0-9_:-]{1,80}$/),
  carrierName: z.string().trim().min(1).max(160),
  carrierService: z.string().trim().min(1).max(160),
  labelAssetId: EntityIdSchema.nullable().default(null),
  externalLabelId: z.string().trim().min(1).max(300).nullable().default(null),
  labelCostMinor: z.number().int().nonnegative().nullable().default(null),
  labelCurrency: z.string().regex(/^[A-Z]{3}$/).nullable().default(null),
  weightGrams: z.number().int().positive().max(10_000_000).nullable().default(null),
  dimensionsMm: z.object({ length: z.number().int().positive(), width: z.number().int().positive(), height: z.number().int().positive() }).strict().nullable().default(null),
  lines: z.array(ShipmentPackageLineInputSchema).min(1).max(1_000),
}).strict().superRefine((value, context) => {
  if ((value.labelCostMinor === null) !== (value.labelCurrency === null)) {
    context.addIssue({ code: "custom", path: ["labelCostMinor"], message: "Label cost and currency must be provided together" });
  }
  if (new Set(value.lines.map((line) => line.orderLineId)).size !== value.lines.length) {
    context.addIssue({ code: "custom", path: ["lines"], message: "A package cannot repeat an order line" });
  }
});

export const ShipmentVersionContentSchema = z.object({
  shipDate: z.iso.datetime(),
  promisedDeliveryAt: z.iso.datetime().nullable().default(null),
  estimatedDeliveryAt: z.iso.datetime().nullable().default(null),
  shipFromCountryCode: z.string().regex(/^[A-Z]{2}$/),
  packages: z.array(ShipmentPackageInputSchema).min(1).max(100),
}).strict();

export const ShipmentVersionEditorViewSchema = z.object({
  shipmentId: EntityIdSchema, orderId: EntityIdSchema, versionId: EntityIdSchema, versionNumber: z.int().positive(),
  productionSourceVersion: z.union([z.literal(1), z.literal(2)]).nullable(), content: ShipmentVersionContentSchema,
  lines: z.array(z.object({ lineId: EntityIdSchema, title: z.string() }).strict()),
  sources: z.array(ShipmentProductionSourceSchema), canRevise: z.boolean(), blockers: z.array(z.string()),
  sourceOnly: z.boolean(),
}).strict();
export type ShipmentVersionEditorView = z.infer<typeof ShipmentVersionEditorViewSchema>;

/** Original create validation before the existing form owner supplies its real key. */
export const ShipmentCreateContentSchema = ShipmentVersionContentSchema.superRefine(validateShipmentContent);

export const CreateShipmentInputSchema = ShipmentVersionContentSchema.extend({
  idempotencyKey: z.string().trim().min(8).max(200),
}).strict().superRefine(validateShipmentContent);

export const AppendShipmentVersionInputSchema = ShipmentVersionContentSchema.extend({
  expectedCurrentVersion: z.number().int().positive(),
  idempotencyKey: z.string().trim().min(8).max(200),
}).strict().superRefine(validateShipmentContent);

function validateShipmentContent(value: z.infer<typeof ShipmentVersionContentSchema>, context: z.RefinementCtx) {
  if (new Set(value.packages.map((entry) => entry.packageReferenceId)).size !== value.packages.length) {
    context.addIssue({ code: "custom", path: ["packages"], message: "Package reference IDs must be unique within a version" });
  }
  const shipDate = Date.parse(value.shipDate);
  if (value.promisedDeliveryAt && Date.parse(value.promisedDeliveryAt) < shipDate) context.addIssue({ code: "custom", path: ["promisedDeliveryAt"], message: "Promised delivery cannot precede ship date" });
  if (value.estimatedDeliveryAt && Date.parse(value.estimatedDeliveryAt) < shipDate) context.addIssue({ code: "custom", path: ["estimatedDeliveryAt"], message: "Estimated delivery cannot precede ship date" });
}

export const ReviewShipmentVersionInputSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  reasonCode: z.string().regex(/^[A-Z0-9_:-]{1,160}$/),
  reason: z.string().trim().min(1).max(2_000),
  expectedCurrentVersion: z.number().int().positive(),
  idempotencyKey: z.string().trim().min(8).max(200),
}).strict();

export const RequestShipmentWritebackInputSchema = z.object({
  shipmentVersionId: EntityIdSchema,
  idempotencyKey: z.string().trim().min(8).max(200),
}).strict();

export const RecordShipmentWritebackEventInputSchema = z.object({
  action: z.enum(["dispatched", "accepted", "rejected", "uncertain", "reconcile_accepted", "reconcile_rejected"]),
  expectedProjectionVersion: z.number().int().positive(),
  providerCode: z.string().trim().max(160).nullable().default(null),
  externalReference: z.string().trim().min(1).max(300).nullable().default(null),
  occurredAt: z.iso.datetime(),
}).strict().superRefine((value, context) => {
  if (["accepted", "reconcile_accepted"].includes(value.action) && value.externalReference === null) {
    context.addIssue({ code: "custom", path: ["externalReference"], message: "Accepted writeback requires external acknowledgement" });
  }
});

export const RecordTrackingEventInputSchema = z.object({
  packageId: EntityIdSchema,
  status: TrackingStatusSchema,
  provider: z.string().trim().regex(/^[a-z0-9_:-]{1,80}$/),
  externalEventId: z.string().trim().min(1).max(300),
  detailCode: z.string().trim().regex(/^[A-Z0-9_:-]{1,160}$/),
  occurredAt: z.iso.datetime(),
  estimatedDeliveryAt: z.iso.datetime().nullable().default(null),
}).strict();

export type ShipmentStatus = z.infer<typeof ShipmentStatusSchema>;
export type TrackingStatus = z.infer<typeof TrackingStatusSchema>;
export type ShipmentPackageInput = z.infer<typeof ShipmentPackageInputSchema>;
export type CreateShipmentInput = z.infer<typeof CreateShipmentInputSchema>;
export type AppendShipmentVersionInput = z.infer<typeof AppendShipmentVersionInputSchema>;
export type ReviewShipmentVersionInput = z.infer<typeof ReviewShipmentVersionInputSchema>;
export type RequestShipmentWritebackInput = z.infer<typeof RequestShipmentWritebackInputSchema>;
export type RecordShipmentWritebackEventInput = z.infer<typeof RecordShipmentWritebackEventInputSchema>;
export type RecordTrackingEventInput = z.infer<typeof RecordTrackingEventInputSchema>;
