import { z } from "zod";
export const NotificationKindSchema = z.enum([
  "job_completed",
  "job_failed",
  "review_requested",
  "review_decided",
  "design_overdue",
  "system",
]);
export const CreateNotificationSchema = z.object({
  kind: NotificationKindSchema,
  title: z.string().trim().min(1).max(160),
  body: z.string().trim().min(1).max(2_000),
  resourceType: z.string().max(80).optional(),
  resourceId: z.uuidv7().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  deduplicationKey: z.string().min(1).max(300).optional(),
});
export type NotificationKind = z.infer<typeof NotificationKindSchema>;
export type CreateNotificationInput = z.input<typeof CreateNotificationSchema>;
export const NotificationViewSchema = z.object({
  id: z.uuidv7(),
  kind: NotificationKindSchema,
  title: z.string().max(160),
  body: z.string().max(2_000),
  resourceType: z.string().max(80).optional(),
  resourceId: z.uuidv7().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  readAt: z.iso.datetime().optional(),
  createdAt: z.iso.datetime(),
});
export const NotificationInboxQuerySchema = z
  .object({
    unreadOnly: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    limit: z.coerce.number().int().min(1).max(100).default(30),
    after: z.uuidv7().optional(),
  })
  .strict();
export const NotificationInboxSchema = z.object({
  items: z.array(NotificationViewSchema).max(100),
  total: z.number().int().nonnegative(),
  unread: z.number().int().nonnegative(),
  nextCursor: z.uuidv7().nullable(),
});
export type NotificationInbox = z.infer<typeof NotificationInboxSchema>;
export const NotificationReadRequestSchema = z.object({}).strict();
export const NotificationReadAllResultSchema = z.object({ count: z.number().int().nonnegative() });
