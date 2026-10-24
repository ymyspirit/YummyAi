import { z } from "zod";
import { EntityIdSchema as Id } from "@yummyai/contracts/common/ids";
import { ProductionManufacturingSelectionSchema } from "@yummyai/contracts/order/production-manufacturing";
import { ProductionCapacityPlanSchema } from "@yummyai/contracts/suppliers/factory-capacity";
import { OrderLifecycleStatusSchema } from "@yummyai/contracts/order/workbench";
import { ShiposShipmentSelectionSchema } from "@yummyai/contracts/suppliers/shipos";
import { ProductionOrderStatusSchema, RecordProductionMilestoneInputSchema, RecordQualityInspectionInputSchema } from "@yummyai/contracts/order/production";
import { ShipmentPackageLineInputSchema, ShipmentProductionSourceSchema, validateShipmentProductionAllocations } from "@yummyai/contracts/order/shipment";

export const WholeOrderLinePinSchema = z.object({
  lineId: Id, quantity: z.int().positive().max(100_000),
  expectedRevision: z.int().nonnegative(), expectedProjectionVersion: z.int().nonnegative(),
}).strict();
const uniqueLines = (items: Array<{ lineId: string }>) => new Set(items.map(item => item.lineId)).size === items.length;
export const ReleaseWholeOrderInputSchema = z.object({
  supplierId: Id, factoryId: Id, factoryVersionId: Id,
  items: z.array(WholeOrderLinePinSchema.extend({ renderId: Id, capabilityVersionId: Id, manufacturing: ProductionManufacturingSelectionSchema.optional(), capacityPlan: ProductionCapacityPlanSchema.optional() })).min(1).max(100),
  expectedCompletionAt: z.iso.datetime(), instructions: z.string().trim().max(2_000).default(""),
  idempotencyKey: z.uuid(),
}).strict().refine(value => uniqueLines(value.items), { path: ["items"], message: "整单不能重复包含同一商品" });

const ProductionLinePinSchema = WholeOrderLinePinSchema.extend({ productionOrderId: Id, expectedProductionProjectionVersion: z.int().positive() });
export const RecordWholeOrderProductionInputSchema = RecordProductionMilestoneInputSchema.pick({ occurredAt: true, evidence: true }).extend({
  type: z.enum(["submitted", "acknowledged", "started", "completed"]),
  items: z.array(ProductionLinePinSchema).min(1).max(100), idempotencyKey: z.uuid(),
}).strict().refine(value => uniqueLines(value.items), { path: ["items"], message: "整单不能重复包含同一商品" });
// Reuse field validation; result/defect refinements apply to the resulting line inspection.
export const InspectWholeOrderInputSchema = z.object({
  assessment: RecordQualityInspectionInputSchema.shape.assessment,
  qualityStandardVersionId: RecordQualityInspectionInputSchema.shape.qualityStandardVersionId,
  scoreBps: RecordQualityInspectionInputSchema.shape.scoreBps,
  inspectedAt: RecordQualityInspectionInputSchema.shape.inspectedAt,
  evidenceAssetIds: RecordQualityInspectionInputSchema.shape.evidenceAssetIds,
}).extend({
  items: z.array(ProductionLinePinSchema).min(1).max(100), idempotencyKey: z.uuid(),
}).strict().refine(value => uniqueLines(value.items), { path: ["items"], message: "整单不能重复包含同一商品" });

export const CreateWholeOrderShipmentInputSchema = z.object({
  items: z.array(WholeOrderLinePinSchema.extend({ productionAllocations: ShipmentPackageLineInputSchema.shape.productionAllocations }).superRefine(validateShipmentProductionAllocations)).min(1).max(100),
  trackingNumber: z.string().trim().min(1).max(200),
  carrierCode: z.string().trim().regex(/^[A-Z0-9_:-]{1,80}$/),
  carrierName: z.string().trim().min(1).max(160), carrierService: z.string().trim().min(1).max(160),
  shipFromCountryCode: z.string().regex(/^[A-Z]{2}$/), shipDate: z.iso.datetime(),
  shiposSource: ShiposShipmentSelectionSchema.optional(),
  idempotencyKey: z.uuid(),
}).strict().refine(value => uniqueLines(value.items), { path: ["items"], message: "整单不能重复包含同一商品" });

export const WholeOrderFulfillmentViewSchema = z.object({
  orderId: Id, orderNumber: z.string(), orderStatus: OrderLifecycleStatusSchema.nullable(),
  quantity: z.int().positive(), shipmentIds: z.array(Id),
  platformConfirmationPending: z.boolean(),
  shipmentSources: z.array(ShipmentProductionSourceSchema).default([]),
  items: z.array(WholeOrderLinePinSchema.extend({
    externalLineId: z.string(), title: z.string(), sku: z.string().nullable(), specification: z.string().nullable(),
    readyQuantity: z.int().nonnegative(), shippedQuantity: z.int().nonnegative(),
    renderId: Id.nullable(), fileName: z.string().nullable(), editorVersionNumber: z.int().positive().nullable(),
    productionBlockers: z.array(z.string()), shipmentBlockers: z.array(z.string()), operationBlockers: z.array(z.string()),
    production: z.object({ id: Id, status: ProductionOrderStatusSchema, projectionVersion: z.int().positive(),
      wholeOrder: z.boolean(), qualityResult: z.enum(["passed", "failed"]).nullable() }).strict().nullable(),
  })).min(1).max(100),
  factories: z.array(z.object({
    supplierId: Id, supplierName: z.string(), factoryId: Id, factoryVersionId: Id, factoryName: z.string(),
    items: z.array(z.object({ lineId: Id, capabilityVersionId: Id, capabilityName: z.string() })).min(1).max(100),
  }).strict()),
  factoryDiagnostics: z.array(z.object({ supplierId: Id, supplierName: z.string(), factoryId: Id, factoryName: z.string(),
    blockers: z.array(z.string()), capabilityIds: z.array(Id) }).strict()).default([]),
}).strict();

export type WholeOrderLinePin = z.infer<typeof WholeOrderLinePinSchema>;
export type ReleaseWholeOrderInput = z.infer<typeof ReleaseWholeOrderInputSchema>;
export type WholeOrderFulfillmentView = z.infer<typeof WholeOrderFulfillmentViewSchema>;
