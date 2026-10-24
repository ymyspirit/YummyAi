import { z } from "zod";
import { EntityIdSchema as Id } from "@yummyai/contracts/common/ids";
export const WorkflowResponsibilityInputSchema = z
  .object({
    expectedRevision: z.int().positive(),
    assignedUserId: Id.nullable(),
    dueAt: z.iso.datetime({ offset: true }).nullable(),
    escalationUserId: Id.nullable(),
    escalationDelayMinutes: z.int().min(1).max(10_080).nullable(),
    reason: z.string().trim().min(1).max(1_000),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.escalationUserId !== null &&
      (!value.assignedUserId ||
        !value.dueAt ||
        !value.escalationDelayMinutes ||
        value.escalationUserId === value.assignedUserId)
    )
      context.addIssue({
        code: "custom",
        path: ["escalationUserId"],
        message: "升级提醒需要负责人、截止时间及不同的接收人",
      });
    if ((value.escalationUserId === null) !== (value.escalationDelayMinutes === null))
      context.addIssue({
        code: "custom",
        path: ["escalationDelayMinutes"],
        message: "升级接收人与延迟必须同时设置或清除",
      });
  });
export const WorkflowAttentionErrorSchema = z.enum([
  "RECIPIENT_UNAVAILABLE",
  "ESCALATION_UNAVAILABLE",
  "SOURCE_UNAVAILABLE",
  "DISPATCH_FAILED",
]);
export const WorkflowResponsibilityViewSchema = z
  .object({
    runId: Id,
    nodeId: z.string().min(1).max(120),
    revision: z.int().positive(),
    assignmentRevision: z.int().nonnegative(),
    assignedUserId: Id.nullable(),
    assignedUserName: z.string().nullable(),
    dueAt: z.iso.datetime().nullable(),
    escalationUserId: Id.nullable(),
    escalationUserName: z.string().nullable(),
    escalationDelayMinutes: z.int().positive().nullable(),
    canManage: z.boolean(),
    candidates: z
      .array(
        z
          .object({ id: Id, label: z.string(), canAssign: z.boolean(), canEscalate: z.boolean() })
          .strict(),
      )
      .max(100),
    candidatesTruncated: z.boolean(),
    assignmentNotifiedAt: z.iso.datetime().nullable(),
    dueNotifiedAt: z.iso.datetime().nullable(),
    escalationNotifiedAt: z.iso.datetime().nullable(),
    nextCheckAt: z.iso.datetime().nullable(),
    lastError: WorkflowAttentionErrorSchema.nullable(),
  })
  .strict();
export type WorkflowResponsibilityInput = z.infer<typeof WorkflowResponsibilityInputSchema>;
export type WorkflowResponsibilityView = z.infer<typeof WorkflowResponsibilityViewSchema>;
