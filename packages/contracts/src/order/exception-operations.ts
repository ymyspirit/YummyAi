import { z } from "zod";
import { EntityIdSchema as Id } from "@yummyai/contracts/common/ids";
import {
  OpenOrderExceptionCommandSchema,
  ResolveOrderExceptionCommandSchema,
  OrderExceptionViewSchema,
} from "@yummyai/contracts/order/order";
const checksum = z.string().regex(/^[a-f0-9]{64}$/);
export const OrderExceptionOperationsQuerySchema = z
  .object({
    status: z.enum(["open", "resolved", "all"]).default("all"),
    page: z.coerce.number().int().min(1).max(1000000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
    exceptionId: Id.optional(),
  })
  .strict();
export const OpenReviewedOrderExceptionSchema = OpenOrderExceptionCommandSchema.extend({
  expectedOrderSequence: z.int().positive(),
  expectedSourceChecksum: checksum,
});
export const ResolveReviewedOrderExceptionSchema = ResolveOrderExceptionCommandSchema.extend({
  expectedSequence: z.int().positive(),
  expectedSourceChecksum: checksum,
});
export const OrderExceptionOperationsItemSchema = z
  .object({
    exception: OrderExceptionViewSchema,
    sequence: z.int().nonnegative(),
    sourceChecksum: checksum,
    canResolve: z.boolean(),
    eventMissing: z.boolean(),
  })
  .strict();
export const OrderExceptionOperationsViewSchema = z
  .object({
    orderId: Id,
    lineId: Id.nullable(),
    label: z.string(),
    orderSequence: z.int().positive(),
    sourceChecksum: checksum,
    asOf: z.iso.datetime(),
    canCreate: z.boolean(),
    query: OrderExceptionOperationsQuerySchema,
    total: z.int().nonnegative(),
    page: z.int().positive(),
    pageSize: z.int().positive(),
    summary: z
      .object({
        open: z.int().nonnegative(),
        resolved: z.int().nonnegative(),
        missingEvent: z.int().nonnegative(),
      })
      .strict(),
    items: z.array(OrderExceptionOperationsItemSchema).max(100),
  })
  .strict();
export type OpenReviewedOrderException = z.infer<typeof OpenReviewedOrderExceptionSchema>;
export type ResolveReviewedOrderException = z.infer<typeof ResolveReviewedOrderExceptionSchema>;
export type OrderExceptionOperationsView = z.infer<typeof OrderExceptionOperationsViewSchema>;
