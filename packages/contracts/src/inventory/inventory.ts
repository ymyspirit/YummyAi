import { z } from "zod";

const EntityIdSchema = z.uuidv7();
const IdempotencyKeySchema = z.string().trim().min(8).max(200);
const CodeSchema = z.string().trim().min(1).max(64).regex(/^[A-Z0-9][A-Z0-9._-]*$/);
const PositiveQuantitySchema = z.number().int().positive().max(2_147_483_647);
const SignedQuantitySchema = z.number().int().min(-2_147_483_647).max(2_147_483_647).refine((value) => value !== 0, {
  message: "Quantity delta cannot be zero",
});

export const WarehouseTypeSchema = z.enum(["owned", "third_party", "fba", "supplier", "virtual"]);
export const InventoryUnitSchema = z.enum(["each", "pair", "set", "meter", "gram", "kilogram"]);
export const InventoryBucketSchema = z.enum(["physical", "in_transit", "provider", "virtual"]);
export const InventoryMovementTypeSchema = z.enum([
  "opening",
  "receipt",
  "allocation",
  "release",
  "pick",
  "ship",
  "return",
  "adjustment",
  "transfer_outbound",
  "transfer_inbound",
  "damage",
  "reconciliation",
]);
export const InventorySourceTypeSchema = z.enum([
  "opening",
  "order",
  "order_line",
  "receipt",
  "return",
  "transfer",
  "adjustment",
  "reconciliation",
  "manual",
]);
export const InventoryReservationStatusSchema = z.enum(["active", "released", "fulfilled", "cancelled"]);
export const InventoryTransferStatusSchema = z.enum(["draft", "in_transit", "received", "cancelled"]);

export const CreateWarehouseInputSchema = z.object({
  code: CodeSchema,
  name: z.string().trim().min(1).max(200),
  type: WarehouseTypeSchema,
  countryCode: z.string().regex(/^[A-Z]{2}$/).nullable(),
  timeZone: z.string().trim().min(1).max(100),
}).strict();

export const CreateInventoryLocationInputSchema = z.object({
  warehouseId: EntityIdSchema,
  code: CodeSchema,
  name: z.string().trim().min(1).max(200),
}).strict();

export const CreateStockItemInputSchema = z.object({
  skuId: EntityIdSchema.nullable(),
  code: CodeSchema,
  name: z.string().trim().min(1).max(240),
  baseUnit: InventoryUnitSchema,
}).strict();

export const CreateInventoryLotInputSchema = z.object({
  stockItemId: EntityIdSchema,
  code: CodeSchema,
  sourceType: InventorySourceTypeSchema,
  sourceId: z.string().trim().min(1).max(200),
  unitCostMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  unitCostCurrency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  receivedAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime().nullable(),
}).strict().superRefine((value, context) => {
  if ((value.unitCostMinor === null) !== (value.unitCostCurrency === null)) {
    context.addIssue({
      code: "custom",
      message: "Unit cost amount and currency must both be present or absent",
      path: ["unitCostCurrency"],
    });
  }
  if (value.receivedAt && value.expiresAt && Date.parse(value.expiresAt) <= Date.parse(value.receivedAt)) {
    context.addIssue({
      code: "custom",
      message: "Expiry must be later than receipt",
      path: ["expiresAt"],
    });
  }
});

export const RecordInventoryMovementInputSchema = z.object({
  stockItemId: EntityIdSchema,
  locationId: EntityIdSchema,
  lotId: EntityIdSchema.nullable(),
  bucket: InventoryBucketSchema,
  type: InventoryMovementTypeSchema,
  quantityDelta: SignedQuantitySchema,
  unit: InventoryUnitSchema,
  sourceType: InventorySourceTypeSchema,
  sourceId: z.string().trim().min(1).max(200),
  reasonCode: CodeSchema,
  occurredAt: z.iso.datetime(),
  idempotencyKey: IdempotencyKeySchema,
}).strict();

export const CreateInventoryReservationInputSchema = z.object({
  stockItemId: EntityIdSchema,
  locationId: EntityIdSchema,
  lotId: EntityIdSchema.nullable(),
  quantity: PositiveQuantitySchema,
  unit: InventoryUnitSchema,
  sourceType: z.enum(["order", "order_line", "transfer", "manual"]),
  sourceId: z.string().trim().min(1).max(200),
  expiresAt: z.iso.datetime().nullable(),
  idempotencyKey: IdempotencyKeySchema,
}).strict();

export const ReleaseInventoryReservationInputSchema = z.object({
  expectedVersion: z.number().int().positive(),
  outcome: z.enum(["released", "fulfilled", "cancelled"]),
  reasonCode: CodeSchema,
  idempotencyKey: IdempotencyKeySchema,
}).strict();

export const CreateInventoryTransferInputSchema = z.object({
  stockItemId: EntityIdSchema,
  lotId: EntityIdSchema.nullable(),
  sourceLocationId: EntityIdSchema,
  destinationLocationId: EntityIdSchema,
  quantity: PositiveQuantitySchema,
  unit: InventoryUnitSchema,
  idempotencyKey: IdempotencyKeySchema,
}).strict().superRefine((value, context) => {
  if (value.sourceLocationId === value.destinationLocationId) {
    context.addIssue({
      code: "custom",
      message: "Transfer locations must be different",
      path: ["destinationLocationId"],
    });
  }
});

export const DispatchInventoryTransferInputSchema = z.object({
  expectedVersion: z.number().int().positive(),
  occurredAt: z.iso.datetime(),
  idempotencyKey: IdempotencyKeySchema,
}).strict();

export const ReceiveInventoryTransferInputSchema = z.object({
  expectedVersion: z.number().int().positive(),
  occurredAt: z.iso.datetime(),
  idempotencyKey: IdempotencyKeySchema,
}).strict();

export const CancelInventoryTransferInputSchema = z.object({
  expectedVersion: z.number().int().positive(),
  reasonCode: CodeSchema,
  occurredAt: z.iso.datetime(),
  idempotencyKey: IdempotencyKeySchema,
}).strict();

export const RebuildInventoryProjectionInputSchema = z.object({
  idempotencyKey: IdempotencyKeySchema,
}).strict();

export const InventoryBalanceViewSchema = z.object({
  stockItemId: EntityIdSchema,
  locationId: EntityIdSchema,
  lotId: EntityIdSchema.nullable(),
  unit: InventoryUnitSchema,
  physicalQuantity: z.number().int().nonnegative(),
  reservedQuantity: z.number().int().nonnegative(),
  availableQuantity: z.number().int(),
  inTransitQuantity: z.number().int().nonnegative(),
  providerQuantity: z.number().int().nonnegative(),
  virtualQuantity: z.number().int().nonnegative(),
  projectionVersion: z.number().int().positive(),
  updatedAt: z.iso.datetime(),
});

export const InventoryWarehouseViewSchema = z.object({
  id: EntityIdSchema,
  code: CodeSchema,
  name: z.string(),
  type: WarehouseTypeSchema,
  countryCode: z.string().regex(/^[A-Z]{2}$/).nullable(),
  timeZone: z.string(),
  status: z.enum(["active", "inactive"]),
});

export const InventoryLocationViewSchema = z.object({
  id: EntityIdSchema,
  warehouseId: EntityIdSchema,
  code: CodeSchema,
  name: z.string(),
  status: z.enum(["active", "inactive"]),
});

export const InventoryStockItemViewSchema = z.object({
  id: EntityIdSchema,
  skuId: EntityIdSchema.nullable(),
  code: CodeSchema,
  name: z.string(),
  baseUnit: InventoryUnitSchema,
  status: z.enum(["active", "inactive"]),
});

export const InventoryLotViewSchema = z.object({
  id: EntityIdSchema,
  stockItemId: EntityIdSchema,
  code: CodeSchema,
  sourceType: InventorySourceTypeSchema,
  sourceId: z.string(),
  unitCostMinor: z.number().int().nonnegative().nullable(),
  unitCostCurrency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  receivedAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});

export const InventoryMovementViewSchema = z.object({
  id: EntityIdSchema,
  stockItemId: EntityIdSchema,
  locationId: EntityIdSchema,
  lotId: EntityIdSchema.nullable(),
  bucket: InventoryBucketSchema,
  type: InventoryMovementTypeSchema,
  quantityDelta: SignedQuantitySchema,
  unit: InventoryUnitSchema,
  sourceType: InventorySourceTypeSchema,
  sourceId: z.string(),
  reasonCode: CodeSchema,
  occurredAt: z.iso.datetime(),
  recordedAt: z.iso.datetime(),
});

export const InventoryReservationViewSchema = z.object({
  id: EntityIdSchema,
  stockItemId: EntityIdSchema,
  locationId: EntityIdSchema,
  lotId: EntityIdSchema.nullable(),
  quantity: PositiveQuantitySchema,
  unit: InventoryUnitSchema,
  sourceType: z.enum(["order", "order_line", "transfer", "manual"]),
  sourceId: z.string(),
  status: InventoryReservationStatusSchema,
  version: z.number().int().positive(),
  expiresAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const InventoryTransferViewSchema = z.object({
  id: EntityIdSchema,
  stockItemId: EntityIdSchema,
  lotId: EntityIdSchema.nullable(),
  sourceLocationId: EntityIdSchema,
  destinationLocationId: EntityIdSchema,
  quantity: PositiveQuantitySchema,
  unit: InventoryUnitSchema,
  status: InventoryTransferStatusSchema,
  version: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const InventoryWorkspaceViewSchema = z.object({
  warehouses: z.array(InventoryWarehouseViewSchema),
  locations: z.array(InventoryLocationViewSchema),
  stockItems: z.array(InventoryStockItemViewSchema),
  lots: z.array(InventoryLotViewSchema),
  balances: z.array(InventoryBalanceViewSchema),
  reservations: z.array(InventoryReservationViewSchema),
  transfers: z.array(InventoryTransferViewSchema),
  movements: z.array(InventoryMovementViewSchema),
});

export type WarehouseType = z.infer<typeof WarehouseTypeSchema>;
export type InventoryUnit = z.infer<typeof InventoryUnitSchema>;
export type InventoryBucket = z.infer<typeof InventoryBucketSchema>;
export type InventoryMovementType = z.infer<typeof InventoryMovementTypeSchema>;
export type InventorySourceType = z.infer<typeof InventorySourceTypeSchema>;
export type CreateWarehouseInput = z.infer<typeof CreateWarehouseInputSchema>;
export type CreateInventoryLocationInput = z.infer<typeof CreateInventoryLocationInputSchema>;
export type CreateStockItemInput = z.infer<typeof CreateStockItemInputSchema>;
export type CreateInventoryLotInput = z.infer<typeof CreateInventoryLotInputSchema>;
export type RecordInventoryMovementInput = z.infer<typeof RecordInventoryMovementInputSchema>;
export type CreateInventoryReservationInput = z.infer<typeof CreateInventoryReservationInputSchema>;
export type ReleaseInventoryReservationInput = z.infer<typeof ReleaseInventoryReservationInputSchema>;
export type CreateInventoryTransferInput = z.infer<typeof CreateInventoryTransferInputSchema>;
export type DispatchInventoryTransferInput = z.infer<typeof DispatchInventoryTransferInputSchema>;
export type ReceiveInventoryTransferInput = z.infer<typeof ReceiveInventoryTransferInputSchema>;
export type CancelInventoryTransferInput = z.infer<typeof CancelInventoryTransferInputSchema>;
export type RebuildInventoryProjectionInput = z.infer<typeof RebuildInventoryProjectionInputSchema>;
export type InventoryBalanceView = z.infer<typeof InventoryBalanceViewSchema>;
export type InventoryWarehouseView = z.infer<typeof InventoryWarehouseViewSchema>;
export type InventoryLocationView = z.infer<typeof InventoryLocationViewSchema>;
export type InventoryStockItemView = z.infer<typeof InventoryStockItemViewSchema>;
export type InventoryLotView = z.infer<typeof InventoryLotViewSchema>;
export type InventoryMovementView = z.infer<typeof InventoryMovementViewSchema>;
export type InventoryReservationView = z.infer<typeof InventoryReservationViewSchema>;
export type InventoryTransferView = z.infer<typeof InventoryTransferViewSchema>;
export type InventoryWorkspaceView = z.infer<typeof InventoryWorkspaceViewSchema>;
