import { z } from "zod";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { InventoryUnitSchema } from "@yummyai/contracts/inventory";
import { PositiveStockQuantitySchema, NonnegativeStockQuantitySchema } from "@yummyai/contracts/inventory/quantity-schema";
import { stockQuantityAtoms } from "@yummyai/contracts/inventory/quantity";

const Id = EntityIdSchema.transform(value => value.toLowerCase());
const Code = z.string().trim().min(1).max(64);
export const ProductionMaterialRequestKeySchema = z.string().trim().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/);
const base = z.object({
  bindingId: Id, materialCode: Code, expectedProductionRevision: z.int().positive(), contextAuthority: z.string().min(1),
  idempotencyKey: ProductionMaterialRequestKeySchema, occurredAt: z.iso.datetime(),
  reason: z.string().trim().min(10).max(1000).nullable().default(null),
});
const quantity = PositiveStockQuantitySchema;
const dimension = { locationId: Id, lotId: Id.nullable() };
/** All facts are operator-confirmed. A planned BOM quantity is never an actual. */
export const RecordProductionMaterialSchema = z.discriminatedUnion("kind", [
  base.extend({ kind: z.literal("reserve"), quantity, ...dimension }).strict(),
  base.extend({ kind: z.literal("consume"), quantity, ...dimension, reservationEntryId: Id.nullable(), actualConfirmed: z.literal(true) }).strict(),
  base.extend({ kind: z.literal("release"), originalEntryId: Id }).strict(),
  base.extend({ kind: z.literal("return"), originalEntryId: Id, quantity, actualConfirmed: z.literal(true) }).strict(),
  base.extend({ kind: z.literal("factory_report"), quantity, reportReference: z.string().trim().min(1).max(200), actualConfirmed: z.literal(true) }).strict(),
  base.extend({ kind: z.literal("factory_correction"), originalEntryId: Id, quantity }).strict(),
]);
export type RecordProductionMaterial = z.infer<typeof RecordProductionMaterialSchema>;
export const ProductionMaterialsQuerySchema = z.object({ bindingId: Id.optional(), beforeId: Id.optional() }).strict();

export const ProductionMaterialEntrySchema = z.object({
  id: Id, bindingId: Id, productionOrderId: Id, materialCode: Code,
  kind: z.enum(["reserve", "consume", "release", "return", "factory_report", "factory_correction"]),
  quantity, unit: InventoryUnitSchema, reservationId: Id.nullable(), movementId: Id.nullable(), originalEntryId: Id.nullable(),
  locationId: Id.nullable(), lotId: Id.nullable(), remainingReservedQuantity: NonnegativeStockQuantitySchema.nullable(),
  locationName: z.string().nullable(), warehouseName: z.string().nullable(), lotCode: z.string().nullable(),
  correctableQuantity: NonnegativeStockQuantitySchema.nullable(),
  reportReference: z.string().nullable(), reason: z.string().nullable(), idempotencyKey: z.string(),
  createdBy: Id, occurredAt: z.iso.datetime(), recordedAt: z.iso.datetime(),
}).strict();
export const ProductionMaterialsWorkspaceSchema = z.object({
  contextAuthority: z.string().min(1),
  productionOrderId: Id, productionRevision: z.int().positive(), productionStatus: z.string(),
  bindingId: Id.nullable(), sourceContentChecksum: z.string().nullable(), currentBinding: z.boolean(),
  canWrite: z.boolean(), diagnostics: z.array(z.string()), nextCursor: Id.nullable(),
  lines: z.array(z.object({ code: Code, name: z.string(), stockItemId: Id, unit: InventoryUnitSchema,
    responsibility: z.enum(["merchant", "factory"]), plannedNumerator: z.string(), plannedDenominator: z.string(),
    actualNetQuantity: NonnegativeStockQuantitySchema, outstandingReservedQuantity: NonnegativeStockQuantitySchema,
    actualSource: z.enum(["merchant_inventory", "manual_factory_report"]),
  }).strict()), entries: z.array(ProductionMaterialEntrySchema),
}).strict();
export type ProductionMaterialsWorkspace = z.infer<typeof ProductionMaterialsWorkspaceSchema>;
export const ProductionMaterialReceiptSchema = ProductionMaterialEntrySchema.extend({ contextAuthority: z.string().min(1) });
export const ProductionMaterialRecordResultSchema = z.object({ entry: ProductionMaterialEntrySchema, replayed: z.boolean(), contextAuthority: z.string().min(1) }).strict();

const DimensionCursor = z.string().max(110).superRefine((value, context) => {
  const parts = value.split(":");
  if (parts.length !== 3 || !Id.safeParse(parts[0]).success || !Id.safeParse(parts[1]).success || parts[2] !== "-" && !Id.safeParse(parts[2]).success)
    context.addIssue({ code: "custom", message: "Invalid inventory dimension cursor" });
}).transform(value => value.toLowerCase());
const optionsQuery = z.object({ bindingId: Id, materialCode: Code });
export const ProductionMaterialStockQuerySchema = optionsQuery.extend({ after: DimensionCursor.optional(), selected: DimensionCursor.optional() }).strict();
export const ProductionMaterialReservationQuerySchema = optionsQuery.extend({ after: Id.optional(), selected: Id.optional() }).strict();
const StockOption = z.object({ dimensionKey: DimensionCursor, stockItemId: Id, unit: InventoryUnitSchema,
  locationId: Id, locationName: z.string(), warehouseName: z.string(), lotId: Id.nullable(), lotCode: z.string().nullable(),
  availableQuantity: NonnegativeStockQuantitySchema, physicalQuantity: NonnegativeStockQuantitySchema,
  reservedQuantity: NonnegativeStockQuantitySchema, expiresAt: z.iso.datetime().nullable(),
}).strict();
const optionsBase = z.object({ productionOrderId: Id, bindingId: Id, materialCode: Code, stockItemId: Id,
  unit: InventoryUnitSchema, contextAuthority: z.string().min(1) });
export const ProductionMaterialStockOptionsSchema = optionsBase.extend({ items: z.array(StockOption).max(25), selected: z.array(StockOption).max(1), nextCursor: DimensionCursor.nullable() }).strict();
const ReservationOption = z.object({ entryId: Id, reservationId: Id, locationId: Id, locationName: z.string(),
  warehouseName: z.string(), lotId: Id.nullable(), lotCode: z.string().nullable(), remainingQuantity: NonnegativeStockQuantitySchema,
  dimensionActive: z.boolean(), unit: InventoryUnitSchema }).strict();
export const ProductionMaterialReservationOptionsSchema = optionsBase.extend({ items: z.array(ReservationOption).max(25), selected: z.array(ReservationOption).max(1), nextCursor: Id.nullable() }).strict();

/** Compare measured stock to a rational plan without rounding thirds or losses. */
export function measuredQuantityExceedsPlan(value: number | string, numerator: string, denominator: string) {
  if (!/^\d+$/.test(numerator) || !/^[1-9]\d*$/.test(denominator)) throw new RangeError("Invalid exact manufacturing plan");
  return stockQuantityAtoms(value) * BigInt(denominator) > BigInt(numerator) * 1_000_000_000n;
}
