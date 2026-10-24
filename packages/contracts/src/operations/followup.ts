import { z } from "zod";
import { EntityIdSchema as Id } from "@yummyai/contracts/common/ids";
import { BusinessTaskInboxQuerySchema } from "@yummyai/contracts/common/task-inbox";
import {
  WorkflowResponsibilityInputSchema,
  WorkflowResponsibilityViewSchema,
} from "@yummyai/contracts/workflow/responsibility";

export const FollowupSourceSchema = z.enum([
  "procurement_order",
  "after_sales_case",
  "order_exception",
]);
export const FollowupReasonSchema = z.enum([
  "initial_assignment",
  "handoff",
  "deadline_update",
  "correction",
]);
export const FollowupResponsibilityInputSchema = WorkflowResponsibilityInputSchema.safeExtend({
  expectedRevision: z.int().nonnegative(),
  expectedSourceChecksum: z.string().regex(/^[a-f0-9]{64}$/),
  reason: FollowupReasonSchema,
});
export const FollowupTaskItemSchema = z
  .object({
    id: Id,
    source: FollowupSourceSchema,
    label: z.string(),
    contextLabel: z.string(),
    parentOrderId: Id.nullable(),
    parentLineId: Id.nullable(),
    status: z.string(),
    taskKey: z.string(),
    title: z.string(),
    businessVersion: z.int().nonnegative(),
    businessDueAt: z.iso.datetime().nullable(),
    sourceChecksum: z.string().regex(/^[a-f0-9]{64}$/),
    available: z.boolean(),
    isClosed: z.boolean(),
    needsAttention: z.boolean(),
    issueCount: z.int().nonnegative(),
    assignedUserId: Id.nullable(),
    assignedUserName: z.string().nullable(),
    dueAt: z.iso.datetime().nullable(),
    responsibilityRevision: z.int().nonnegative(),
    updatedAt: z.iso.datetime(),
    isOverdue: z.boolean(),
    isDueToday: z.boolean(),
  })
  .strict();
export const FollowupResponsibilityViewSchema = WorkflowResponsibilityViewSchema.omit({
  runId: true,
  nodeId: true,
}).extend({
  objectId: Id,
  source: FollowupSourceSchema,
  revision: z.int().nonnegative(),
  currentTask: z.string(),
  sourceChecksum: z.string().regex(/^[a-f0-9]{64}$/),
  active: z.boolean(),
  available: z.boolean(),
  businessVersion: z.int().nonnegative(),
  reminderCycle: z.int().nonnegative(),
  lastReason: FollowupReasonSchema.nullable(),
  canResume: z.boolean(),
});
export const FollowupTaskInboxQuerySchema = BusinessTaskInboxQuerySchema;
export const FollowupTaskInboxViewSchema = z
  .object({
    source: FollowupSourceSchema,
    asOf: z.iso.datetime(),
    query: FollowupTaskInboxQuerySchema,
    items: z.array(FollowupTaskItemSchema).max(100),
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
export const FollowupDetailViewSchema = z
  .object({ item: FollowupTaskItemSchema, responsibility: FollowupResponsibilityViewSchema })
  .strict();
export type FollowupSource = z.infer<typeof FollowupSourceSchema>;
export type FollowupResponsibilityInput = z.infer<typeof FollowupResponsibilityInputSchema>;
export type FollowupResponsibilityView = z.infer<typeof FollowupResponsibilityViewSchema>;
export type FollowupTaskItem = z.infer<typeof FollowupTaskItemSchema>;
export type FollowupTaskInboxView = z.infer<typeof FollowupTaskInboxViewSchema>;
