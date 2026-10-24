import { z } from "zod";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { WorkflowNodeRunStatusSchema, WorkflowRunStatusSchema } from "@yummyai/contracts/workflow";
import { BusinessTaskInboxQuerySchema } from "@yummyai/contracts/common/task-inbox";

export const WorkflowTaskInboxQuerySchema = BusinessTaskInboxQuerySchema;

export const WorkflowTaskInboxItemSchema = z
  .object({
    id: EntityIdSchema,
    source: z.literal("workflow"),
    runId: EntityIdSchema,
    nodeId: z.string().min(1).max(120),
    title: z.string(),
    runTitle: z.string(),
    productPlanId: EntityIdSchema,
    productName: z.string(),
    productArchived: z.boolean(),
    definitionVersion: z.number().int().positive(),
    definitionMissing: z.boolean(),
    nodeStatus: WorkflowNodeRunStatusSchema,
    runStatus: WorkflowRunStatusSchema,
    runRevision: z.number().int().positive(),
    responsibilityRevision: z.number().int().nonnegative(),
    assignedUserId: EntityIdSchema.nullable(),
    assignedUserName: z.string().nullable(),
    dueAt: z.iso.datetime().nullable(),
    updatedAt: z.iso.datetime(),
    isCurrent: z.boolean(),
    isClosed: z.boolean(),
    isOverdue: z.boolean(),
    isDueToday: z.boolean(),
  })
  .strict();
export const WorkflowTaskInboxViewSchema = z
  .object({
    source: z.literal("workflow"),
    asOf: z.iso.datetime(),
    query: WorkflowTaskInboxQuerySchema,
    items: z.array(WorkflowTaskInboxItemSchema).max(100),
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    pageSize: z.number().int().positive().max(100),
    summary: z
      .object({
        overdue: z.number().int().nonnegative(),
        dueToday: z.number().int().nonnegative(),
        blocked: z.number().int().nonnegative(),
        upcoming: z.number().int().nonnegative(),
        unassigned: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
export type WorkflowTaskInboxQuery = z.infer<typeof WorkflowTaskInboxQuerySchema>;
export type WorkflowTaskInboxView = z.infer<typeof WorkflowTaskInboxViewSchema>;
