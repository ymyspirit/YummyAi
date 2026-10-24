import { z } from "zod";
import { EntityIdSchema as Id } from "@yummyai/contracts/common/ids";
import { ProductionOrderStatusSchema } from "@yummyai/contracts/order/production";

export const NativeProductionQuerySchema = z.object({ q: z.string().trim().max(100).default(""), after: Id.optional() }).strict();
export const NativeProductionSourceQuerySchema = z.object({ specificationVersionId: Id.optional() }).strict();
export const NativeProductionFactoryQuerySchema = z.object({
  specificationVersionId: Id, routingDecisionId: Id, purchaseOrderVersionId: Id,
  quantity: z.coerce.number().int().positive().max(100_000).optional(),
}).strict();
export const NativeProductionLineSchema = z.object({
  id: Id, orderId: Id, orderNumber: z.string(), title: z.string(), skuCode: z.string().nullable(),
  quantity: z.int().positive(), allocatedQuantity: z.int().nonnegative(), workflowState: z.string(),
  blockers: z.array(z.string()),
}).strict();
export const NativeProductionWorkspaceSchema = z.object({
  items: NativeProductionLineSchema.array(), nextCursor: Id.nullable(), canCreate: z.boolean(), contextAuthority: z.string().min(1),
}).strict();
export const NativeProductionDesignSchema = z.object({
  versionId: Id, taskId: Id, title: z.string(), versionNumber: z.int().positive(),
  files: z.array(z.object({ id: Id, name: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1).max(100),
}).strict();
export const NativeProductionDetailSchema = z.object({
  line: NativeProductionLineSchema,
  sku: z.object({ id: Id, code: z.string(), spuId: Id, spuName: z.string() }).strict().nullable(),
  specifications: z.array(z.object({ versionId: Id, name: z.string(), versionNumber: z.int().positive() }).strict()),
  source: z.object({ specificationVersionId: Id, productType: z.enum(["shaped_pillow", "tire_cover", "rectangular_print"]) }).strict().nullable(),
  designs: NativeProductionDesignSchema.array(), designsTruncated: z.boolean(),
  routes: z.array(z.object({ routingDecisionId: Id, purchaseOrderId: Id, purchaseOrderVersionId: Id,
    purchaseVersionNumber: z.int().positive(), supplierId: Id, supplierName: z.string() }).strict()),
  routesTruncated: z.boolean(),
  productions: z.array(z.object({ id: Id, status: ProductionOrderStatusSchema, quantity: z.int().positive(), createdAt: z.iso.datetime() }).strict()),
  canCreate: z.boolean(), contextAuthority: z.string().min(1), diagnostics: z.array(z.string()),
}).strict();
export const NativeProductionReceiptSchema = z.object({ productionOrderId: Id, orderId: Id, lineId: Id }).strict();
export type NativeProductionLine = z.infer<typeof NativeProductionLineSchema>;
export type NativeProductionDetail = z.infer<typeof NativeProductionDetailSchema>;
export type NativeProductionWorkspace = z.infer<typeof NativeProductionWorkspaceSchema>;
export type NativeProductionFactoryQuery = z.infer<typeof NativeProductionFactoryQuerySchema>;
