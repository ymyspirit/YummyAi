import { z } from "zod";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { NormalizeOrderInputSchema } from "@yummyai/contracts/order/order";
import { StoreNodeExecutionPinsSchema } from "@yummyai/contracts/marketplace/store-node-execution-base";

export const OrderSyncCheckpointSchema = z.object({
  cursor: z.string().trim().min(1).max(4_000).nullable(),
  highWaterAt: z.iso.datetime().nullable(), version: z.number().int().positive(),
}).strict();
export const OrderSyncRequestSchema = z.object({
  checkpoint: OrderSyncCheckpointSchema, updatedAfter: z.iso.datetime(), updatedBefore: z.iso.datetime(),
  pageSize: z.number().int().min(1).max(100), maxPages: z.number().int().min(1).max(50),
}).strict().superRefine((value, context) => {
  if (Date.parse(value.updatedAfter) >= Date.parse(value.updatedBefore))
    context.addIssue({ code: "custom", path: ["updatedAfter"], message: "updatedAfter must be earlier than updatedBefore" });
});
export const OrderSyncPageMetadataSchema = z.object({
  fetchedAt: z.iso.datetime(), highWaterAt: z.iso.datetime(), nextCursor: z.string().trim().min(1).max(4_000).nullable(),
  reportedCount: z.number().int().nonnegative().nullable(), sourceVersion: z.string().trim().min(1).max(200),
}).strict();
export const OrderSyncPageSchema = OrderSyncPageMetadataSchema.extend({ records: z.array(z.object({
  order: NormalizeOrderInputSchema, providerUpdatedAt: z.iso.datetime(),
  requiresCustomizationLineIds: z.array(z.string().min(1).max(200)).max(1000).optional(),
  buyerRequestedCancellation: z.boolean().optional(),
}).strict()).max(100) }).strict();
export type OrderSyncCheckpoint = z.infer<typeof OrderSyncCheckpointSchema>;
export type OrderSyncRequest = z.infer<typeof OrderSyncRequestSchema>;
export type OrderSyncPageMetadata = z.infer<typeof OrderSyncPageMetadataSchema>;

export const STORE_NODE_ORDER_SYNC_OPERATION = "marketplace.orders.sync.v1" as const;
export const OrderSyncNodeInputSchema = z.object({ runId: EntityIdSchema,
  request: OrderSyncRequestSchema.refine(value => value.maxPages === 1, "A node execution reads one pinned page"),
}).strict();
export type OrderSyncNodeInput = z.infer<typeof OrderSyncNodeInputSchema>;
export function orderSyncNodeRequestText(accountId: string, pins: z.infer<typeof StoreNodeExecutionPinsSchema>, input: OrderSyncNodeInput): string {
  return canonicalJson([STORE_NODE_ORDER_SYNC_OPERATION, EntityIdSchema.parse(accountId),
    StoreNodeExecutionPinsSchema.parse({ nodeId: pins.nodeId, certificateGeneration: pins.certificateGeneration,
      authorizationGeneration: pins.authorizationGeneration, bindingRevision: pins.bindingRevision }), OrderSyncNodeInputSchema.parse(input)]);
}

export const SaveOrderSyncSettingsSchema = z.object({ requestKey: EntityIdSchema,
  expectedVersion: z.int().nonnegative(), enabled: z.boolean(),
}).strict();
export const OrderSyncSettingsViewSchema = z.object({ accountId: EntityIdSchema, version: z.int().nonnegative(), enabled: z.boolean(),
  canManage: z.boolean(), canEnable: z.boolean(), supported: z.boolean(), reason: z.string().max(500).nullable(),
  nextRunAt: z.iso.datetime().nullable(), lastRunId: EntityIdSchema.nullable(),
  activeExecutionId: EntityIdSchema.nullable(), updatedAt: z.iso.datetime().nullable(),
}).strict();
export type OrderSyncSettingsView = z.infer<typeof OrderSyncSettingsViewSchema>;
