import { z } from "zod";

import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { InventoryUnitSchema } from "@yummyai/contracts/inventory";
import { MarketplacePlatformSchema } from "@yummyai/contracts/marketplace/platform";

const IdempotencyKeySchema = z.string().trim().min(8).max(200);
const NonnegativeQuantitySchema = z.number().int().nonnegative().max(2_147_483_647);

export const NetworkInventoryProviderSchema = z.enum([
  "internal",
  "amazon",
  "etsy",
  "third_party",
  "supplier",
]);

export const NetworkStockSourceSchema = z.enum([
  "owned",
  "fba",
  "fbm",
  "overseas_3pl",
  "supplier",
  "in_transit",
  "virtual",
]);

export const NetworkStockConditionSchema = z.enum(["sellable", "quarantine", "damaged"]);

export const RecordNetworkInventorySnapshotInputSchema = z.object({
  accountId: EntityIdSchema.nullable(),
  provider: NetworkInventoryProviderSchema,
  scopeKey: z.string().trim().min(1).max(200),
  providerSnapshotId: z.string().trim().min(1).max(300).nullable(),
  checkpointSequence: z.number().int().positive(),
  checkpointCursor: z.string().trim().min(1).max(2_000).nullable(),
  observedAt: z.iso.datetime(),
  idempotencyKey: IdempotencyKeySchema,
  lines: z.array(z.object({
    stockItemId: EntityIdSchema,
    warehouseId: EntityIdSchema.nullable(),
    locationId: EntityIdSchema.nullable(),
    externalSku: z.string().trim().min(1).max(200).nullable(),
    source: NetworkStockSourceSchema,
    condition: NetworkStockConditionSchema,
    quantity: NonnegativeQuantitySchema,
    unit: InventoryUnitSchema,
  }).strict()).min(1).max(10_000),
}).strict();

export const ChannelAllocationTargetSchema = z.object({
  accountId: EntityIdSchema,
  platform: MarketplacePlatformSchema,
  marketplaceId: z.string().trim().min(1).max(80),
  listingId: EntityIdSchema.nullable(),
  priority: z.number().int().min(1).max(1_000),
  capQuantity: NonnegativeQuantitySchema.nullable(),
  bufferQuantity: NonnegativeQuantitySchema.default(0),
}).strict();

export const UpsertChannelAllocationPolicyInputSchema = z.object({
  policyId: EntityIdSchema.nullable().default(null),
  stockItemId: EntityIdSchema,
  name: z.string().trim().min(1).max(160),
  eligibleSources: z.array(NetworkStockSourceSchema).min(1),
  allowVirtual: z.boolean().default(false),
  safetyBufferQuantity: NonnegativeQuantitySchema.default(0),
  channels: z.array(ChannelAllocationTargetSchema).min(1).max(100),
  reasonCode: z.string().trim().min(1).max(64).regex(/^[A-Z0-9][A-Z0-9._-]*$/),
  idempotencyKey: IdempotencyKeySchema,
}).strict().superRefine((value, context) => {
  if (!value.allowVirtual && value.eligibleSources.includes("virtual")) {
    context.addIssue({
      code: "custom",
      message: "Virtual stock requires allowVirtual",
      path: ["eligibleSources"],
    });
  }
  const targets = new Set<string>();
  for (const [index, channel] of value.channels.entries()) {
    const key = `${channel.accountId}:${channel.marketplaceId}:${channel.listingId ?? "*"}`;
    if (targets.has(key)) {
      context.addIssue({
        code: "custom",
        message: "Channel allocation targets must be unique",
        path: ["channels", index],
      });
    }
    targets.add(key);
  }
});

export const RunChannelAllocationInputSchema = z.object({
  policyId: EntityIdSchema,
  expectedPolicyVersion: z.number().int().positive(),
  idempotencyKey: IdempotencyKeySchema,
}).strict();

export const RecordChannelMutationReconciliationInputSchema = z.object({
  accountId: EntityIdSchema,
  listingId: EntityIdSchema.nullable(),
  syncRequestId: EntityIdSchema.nullable(),
  mutationKey: z.string().trim().min(1).max(300),
  reasonCode: z.string().trim().min(1).max(100),
  message: z.string().trim().min(1).max(2_000),
  idempotencyKey: IdempotencyKeySchema,
}).strict();

export const ResolveChannelMutationReconciliationInputSchema = z.object({
  outcome: z.enum(["confirmed", "rejected"]),
  reasonCode: z.string().trim().min(1).max(100),
  idempotencyKey: IdempotencyKeySchema,
}).strict();

export const NetworkInventorySnapshotLineViewSchema = z.object({
  id: EntityIdSchema,
  stockItemId: EntityIdSchema,
  warehouseId: EntityIdSchema.nullable(),
  locationId: EntityIdSchema.nullable(),
  externalSku: z.string().nullable(),
  source: NetworkStockSourceSchema,
  condition: NetworkStockConditionSchema,
  quantity: NonnegativeQuantitySchema,
  unit: InventoryUnitSchema,
});

export const NetworkInventorySnapshotViewSchema = z.object({
  id: EntityIdSchema,
  accountId: EntityIdSchema.nullable(),
  provider: NetworkInventoryProviderSchema,
  scopeKey: z.string(),
  providerSnapshotId: z.string().nullable(),
  checkpointSequence: z.number().int().positive(),
  checkpointCursor: z.string().nullable(),
  observedAt: z.iso.datetime(),
  recordedAt: z.iso.datetime(),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  lines: z.array(NetworkInventorySnapshotLineViewSchema),
});

export const ChannelAllocationPolicyViewSchema = z.object({
  id: EntityIdSchema,
  stockItemId: EntityIdSchema,
  name: z.string(),
  currentVersion: z.number().int().positive(),
  status: z.enum(["active", "inactive"]),
  version: z.object({
    id: EntityIdSchema,
    version: z.number().int().positive(),
    eligibleSources: z.array(NetworkStockSourceSchema),
    allowVirtual: z.boolean(),
    safetyBufferQuantity: NonnegativeQuantitySchema,
    channels: z.array(ChannelAllocationTargetSchema),
    reasonCode: z.string(),
    checksum: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.iso.datetime(),
  }),
});

export const ChannelAvailabilityProjectionViewSchema = z.object({
  id: EntityIdSchema,
  runId: EntityIdSchema,
  stockItemId: EntityIdSchema,
  accountId: EntityIdSchema,
  platform: MarketplacePlatformSchema,
  marketplaceId: z.string(),
  listingId: EntityIdSchema.nullable(),
  priority: z.number().int().positive(),
  capQuantity: NonnegativeQuantitySchema.nullable(),
  bufferQuantity: NonnegativeQuantitySchema,
  allocatedQuantity: NonnegativeQuantitySchema,
  unit: InventoryUnitSchema,
  sourceTrace: z.array(z.object({
    snapshotId: EntityIdSchema,
    source: NetworkStockSourceSchema,
    condition: NetworkStockConditionSchema,
    quantity: NonnegativeQuantitySchema,
  })),
  calculatedAt: z.iso.datetime(),
});

export const ChannelAllocationRunViewSchema = z.object({
  id: EntityIdSchema,
  policyId: EntityIdSchema,
  policyVersionId: EntityIdSchema,
  policyVersion: z.number().int().positive(),
  stockItemId: EntityIdSchema,
  eligibleQuantity: NonnegativeQuantitySchema,
  allocatableQuantity: NonnegativeQuantitySchema,
  allocatedQuantity: NonnegativeQuantitySchema,
  unit: InventoryUnitSchema,
  inputChecksum: z.string().regex(/^[a-f0-9]{64}$/),
  calculatedAt: z.iso.datetime(),
  projections: z.array(ChannelAvailabilityProjectionViewSchema),
});

export const ChannelMutationReconciliationViewSchema = z.object({
  id: EntityIdSchema,
  accountId: EntityIdSchema,
  listingId: EntityIdSchema.nullable(),
  syncRequestId: EntityIdSchema.nullable(),
  mutationKey: z.string(),
  status: z.enum(["open", "confirmed", "rejected"]),
  reasonCode: z.string(),
  message: z.string(),
  createdAt: z.iso.datetime(),
  resolvedAt: z.iso.datetime().nullable(),
});

export const ChannelInventoryWorkspaceViewSchema = z.object({
  stockItems: z.array(z.object({
    id: EntityIdSchema,
    code: z.string(),
    name: z.string(),
    unit: InventoryUnitSchema,
  })),
  accounts: z.array(z.object({
    id: EntityIdSchema,
    displayName: z.string(),
    platform: MarketplacePlatformSchema,
  })),
  snapshots: z.array(NetworkInventorySnapshotViewSchema),
  policies: z.array(ChannelAllocationPolicyViewSchema),
  runs: z.array(ChannelAllocationRunViewSchema),
  reconciliations: z.array(ChannelMutationReconciliationViewSchema),
});

export type NetworkInventoryProvider = z.infer<typeof NetworkInventoryProviderSchema>;
export type NetworkStockSource = z.infer<typeof NetworkStockSourceSchema>;
export type NetworkStockCondition = z.infer<typeof NetworkStockConditionSchema>;
export type RecordNetworkInventorySnapshotInput = z.infer<typeof RecordNetworkInventorySnapshotInputSchema>;
export type ChannelAllocationTarget = z.infer<typeof ChannelAllocationTargetSchema>;
export type UpsertChannelAllocationPolicyInput = z.infer<typeof UpsertChannelAllocationPolicyInputSchema>;
export type RunChannelAllocationInput = z.infer<typeof RunChannelAllocationInputSchema>;
export type RecordChannelMutationReconciliationInput = z.infer<typeof RecordChannelMutationReconciliationInputSchema>;
export type ResolveChannelMutationReconciliationInput = z.infer<typeof ResolveChannelMutationReconciliationInputSchema>;
export type NetworkInventorySnapshotView = z.infer<typeof NetworkInventorySnapshotViewSchema>;
export type ChannelAllocationPolicyView = z.infer<typeof ChannelAllocationPolicyViewSchema>;
export type ChannelAvailabilityProjectionView = z.infer<typeof ChannelAvailabilityProjectionViewSchema>;
export type ChannelAllocationRunView = z.infer<typeof ChannelAllocationRunViewSchema>;
export type ChannelMutationReconciliationView = z.infer<typeof ChannelMutationReconciliationViewSchema>;
export type ChannelInventoryWorkspaceView = z.infer<typeof ChannelInventoryWorkspaceViewSchema>;
