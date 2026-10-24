import { z } from "zod";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { OrderOperatorTaskKeySchema } from "@yummyai/contracts/order/workbench";
import {
  WorkflowResponsibilityInputSchema,
  WorkflowResponsibilityViewSchema,
} from "@yummyai/contracts/workflow/responsibility";

export const OrderResponsibilityReasonSchema = z.enum([
  "initial_assignment",
  "handoff",
  "deadline_update",
  "correction",
]);
export const OrderLineResponsibilityInputSchema = WorkflowResponsibilityInputSchema.safeExtend({
  expectedRevision: z.int().nonnegative(),
  expectedSourceChecksum: z.string().regex(/^[a-f0-9]{64}$/),
  reason: OrderResponsibilityReasonSchema,
});
export const OrderLineResponsibilityViewSchema = WorkflowResponsibilityViewSchema.omit({
  runId: true,
  nodeId: true,
  revision: true,
  assignmentRevision: true,
}).extend({
  lineId: EntityIdSchema,
  orderId: EntityIdSchema,
  revision: z.int().nonnegative(),
  assignmentRevision: z.int().nonnegative(),
  currentTaskKey: OrderOperatorTaskKeySchema.or(z.literal("order_exception")),
  openExceptionCount: z.int().nonnegative(),
  currentTask: z.string(),
  active: z.boolean(),
  available: z.boolean(),
  sourceChecksum: z.string().regex(/^[a-f0-9]{64}$/),
  businessRevision: z.int().nonnegative(),
  businessProjectionVersion: z.int().nonnegative(),
  reminderCycle: z.int().nonnegative(),
  lastReason: OrderResponsibilityReasonSchema.nullable(),
});
export type OrderLineResponsibilityInput = z.infer<typeof OrderLineResponsibilityInputSchema>;
export type OrderLineResponsibilityView = z.infer<typeof OrderLineResponsibilityViewSchema>;
