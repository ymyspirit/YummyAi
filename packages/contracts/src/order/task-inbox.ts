import { z } from "zod";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { BusinessTaskInboxQuerySchema } from "@yummyai/contracts/common/task-inbox";
import {
  OrderLifecycleStatusSchema,
  OrderOperatorTaskKeySchema,
} from "@yummyai/contracts/order/workbench";

export const OrderTaskInboxQuerySchema = BusinessTaskInboxQuerySchema;
export const OrderTaskInboxItemSchema = z
  .object({
    id: EntityIdSchema,
    source: z.literal("order"),
    orderId: EntityIdSchema,
    externalOrderId: z.string(),
    externalLineId: z.string(),
    title: z.string(),
    itemTitle: z.string(),
    storeName: z.string(),
    skuCode: z.string().nullable(),
    quantity: z.int().positive(),
    taskKey: OrderOperatorTaskKeySchema.or(z.literal("order_exception")),
    orderStatus: OrderLifecycleStatusSchema,
    openExceptionCount: z.int().nonnegative(),
    hasWorkRecord: z.boolean(),
    sourceAvailable: z.boolean(),
    responsibilityRevision: z.int().nonnegative(),
    assignedUserId: EntityIdSchema.nullable(),
    assignedUserName: z.string().nullable(),
    dueAt: z.iso.datetime().nullable(),
    platformShipByAt: z.iso.datetime().nullable(),
    updatedAt: z.iso.datetime(),
    isClosed: z.boolean(),
    isOverdue: z.boolean(),
    isDueToday: z.boolean(),
    needsAttention: z.boolean(),
  })
  .strict();
export const OrderTaskInboxViewSchema = z
  .object({
    source: z.literal("order"),
    asOf: z.iso.datetime(),
    query: OrderTaskInboxQuerySchema,
    items: z.array(OrderTaskInboxItemSchema).max(100),
    total: z.int().nonnegative(),
    page: z.int().positive(),
    pageSize: z.int().positive().max(100),
    summary: z
      .object({
        overdue: z.int().nonnegative(),
        dueToday: z.int().nonnegative(),
        attention: z.int().nonnegative(),
        unassigned: z.int().nonnegative(),
        unavailable: z.int().nonnegative(),
      })
      .strict(),
  })
  .strict();
export type OrderTaskInboxView = z.infer<typeof OrderTaskInboxViewSchema>;
