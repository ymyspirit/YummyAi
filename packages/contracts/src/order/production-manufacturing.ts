import { z } from "zod";
import { EntityIdSchema as Id } from "@yummyai/contracts/common/ids";
import { ProductionProductTypeSchema } from "@yummyai/contracts/pod/production-editor";

export const ProductionManufacturingFactoryBasisSchema = z.object({
  productType: ProductionProductTypeSchema, productPlanId: Id, skuId: Id.nullable(),
  longestMm: z.number().finite().positive(), templateVersionId: Id,
  sideMode: z.enum(["single", "double"]).nullable(), factoryStandardId: z.string().min(1).nullable(),
}).strict();
export type ProductionManufacturingFactoryBasis = z.infer<typeof ProductionManufacturingFactoryBasisSchema>;

/** One production quantity unit is one finished SKU unit, never a raw component. */
export const ProductionManufacturingSelectionSchema = z.object({
  versionId: Id,
  orderUnitConfirmed: z.literal(true),
}).strict();

/** A new product assignment for an approved native design, never reconstructed order history. */
export const ProductionProductConfirmationSchema = z.object({
  specificationVersionId: Id,
  note: z.string().trim().min(1).max(2000),
}).strict();

export const ProductionManufacturingPinSchema = z.object({
  id: Id, bindingVersion: z.literal(1), productionOrderId: Id, productionVersionId: Id,
  recipeId: Id, versionId: Id, reviewId: Id, versionNumber: z.int().positive(),
  code: z.string(), name: z.string(), spuId: Id, skuId: Id.nullable(),
  specificationId: Id, specificationVersionId: Id, processProfileVersionId: Id, canvasPrintSpecVersionId: Id.nullable(),
  source: z.enum(["order_work_revision", "approved_product_confirmation", "original_production_binding"]), workRevisionId: Id.nullable(), originalBindingId: Id.nullable(),
  quantity: z.int().positive(), unit: z.enum(["each", "pair", "set"]), quantityBasis: z.literal("ordered_sku_units"),
  contentChecksum: z.string().regex(/^[a-f0-9]{64}$/), createdAt: z.iso.datetime(),
}).strict().superRefine((value, context) => {
  if (value.source === "order_work_revision" && (!value.workRevisionId || value.originalBindingId) ||
      value.source === "approved_product_confirmation" && (value.workRevisionId || value.originalBindingId) ||
      value.source === "original_production_binding" && !value.originalBindingId)
    context.addIssue({ code: "custom", path: ["source"], message: "制造来源须明确引用实际审单、本次商品确认或原生产绑定" });
});

export type ProductionManufacturingSelection = z.infer<typeof ProductionManufacturingSelectionSchema>;
export type ProductionProductConfirmation = z.infer<typeof ProductionProductConfirmationSchema>;
export type ProductionManufacturingPin = z.infer<typeof ProductionManufacturingPinSchema>;

export const ProductionManufacturingOptionsSchema = z.object({
  source: z.object({ specificationVersionId: Id, specificationId: Id, spuId: Id, name: z.string(), versionNumber: z.int().positive(),
    packageContents: z.string(), packageQuantity: z.int().positive(), processProfileVersionId: Id }).strict().nullable(),
  items: z.array(z.object({ versionId: Id, recipeId: Id, code: z.string(), name: z.string(), versionNumber: z.int().positive(),
    outputQuantity: z.int().positive(), outputUnit: z.enum(["each", "pair", "set"]), approvedAt: z.iso.datetime() }).strict()),
  nextCursor: Id.nullable(), diagnostics: z.array(z.string()), contextAuthority: z.string().min(1),
}).strict();
export type ProductionManufacturingOptions = z.infer<typeof ProductionManufacturingOptionsSchema>;
