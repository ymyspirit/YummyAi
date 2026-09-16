import { z } from "zod";
import { FulfillmentSupplierViewSchema } from "@yummyai/contracts/order/routing";
import { InventoryWarehouseViewSchema, InventoryLocationViewSchema, InventoryStockItemViewSchema } from "@yummyai/contracts/inventory";

const Id = z.uuidv7();
const Key = z.string().trim().min(8).max(200);
const shortText = z.string().trim().max(200);
export const SupplyTermsSchema = z.object({
  fulfillmentModes: z.array(z.enum(["custom_order", "fba_replenishment"])).min(1).max(2),
  supplierCode: shortText.default(""),
  purchaseUrl: z.union([z.literal(""), z.url().max(2000).refine((url) => /^https?:\/\//i.test(url))]).default(""),
  specifications: z.string().trim().max(2000).default(""),
  process: shortText.default(""),
  stockItemId: Id.nullable().default(null),
  unitCostMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  minimumOrderQuantity: z.number().int().positive().max(2_147_483_647),
  leadTimeDays: z.number().int().nonnegative().max(3650).nullable(),
  validFrom: z.iso.datetime(),
  validUntil: z.iso.datetime().nullable(),
  status: z.enum(["active", "paused", "discontinued"]),
  preference: z.enum(["primary", "alternative"]),
  sampleStatus: z.enum(["untested", "passed", "failed"]),
  notes: z.string().trim().max(4000).default(""),
}).strict().refine((value) => !value.validUntil || Date.parse(value.validUntil) > Date.parse(value.validFrom), { path: ["validUntil"], message: "报价截止时间必须晚于生效时间" });

export const CreateProductSupplyInputSchema = z.object({
  productPlanId: Id, supplierId: Id, skuId: Id.nullable(), terms: SupplyTermsSchema, idempotencyKey: Key,
}).strict();
export const ReviseProductSupplyInputSchema = z.object({
  expectedVersion: z.number().int().positive(), terms: SupplyTermsSchema, idempotencyKey: Key,
}).strict();
export const CreateSupplyPurchaseInputSchema = z.object({
  purpose: z.enum(["custom_order", "fba_replenishment"]),
  expectedVersion: z.number().int().positive(),
  code: z.string().trim().min(1).max(64).regex(/^[A-Z0-9][A-Z0-9._-]*$/),
  destinationLocationId: Id, quantity: z.number().int().positive().max(2_147_483_647),
  expectedAt: z.iso.datetime(), idempotencyKey: Key,
}).strict();
export const ProductSupplyVersionViewSchema = z.object({
  id: Id, version: z.number().int().positive(), terms: SupplyTermsSchema, createdAt: z.iso.datetime(),
});
export const ProductSupplyViewSchema = z.object({
  id: Id, productPlanId: Id, productName: z.string(), supplierId: Id, supplierName: z.string(),
  supplierStatus: FulfillmentSupplierViewSchema.shape.status,
  skuId: Id.nullable(), skuCode: z.string().nullable(),
  currentVersion: z.number().int().positive(), versionId: Id, terms: SupplyTermsSchema, updatedAt: z.iso.datetime(),
});
export const SupplyProductChoiceSchema = z.object({
  id: Id, name: z.string(), status: z.string(),
  skus: z.array(z.object({ id: Id, code: z.string(), attributes: z.record(z.string(), z.string()) })),
});
export const ProductSupplyWorkspaceSchema = z.object({
  links: z.array(ProductSupplyViewSchema), products: z.array(SupplyProductChoiceSchema),
  suppliers: z.array(FulfillmentSupplierViewSchema), stockItems: z.array(InventoryStockItemViewSchema),
  locations: z.array(InventoryLocationViewSchema), warehouses: z.array(InventoryWarehouseViewSchema),
});
export type SupplyTerms = z.infer<typeof SupplyTermsSchema>;
export type CreateProductSupplyInput = z.infer<typeof CreateProductSupplyInputSchema>;
export type ReviseProductSupplyInput = z.infer<typeof ReviseProductSupplyInputSchema>;
export type CreateSupplyPurchaseInput = z.infer<typeof CreateSupplyPurchaseInputSchema>;
export type ProductSupplyView = z.infer<typeof ProductSupplyViewSchema>;
export type ProductSupplyVersionView = z.infer<typeof ProductSupplyVersionViewSchema>;
export type ProductSupplyWorkspace = z.infer<typeof ProductSupplyWorkspaceSchema>;
