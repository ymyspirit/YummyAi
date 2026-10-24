import { z } from "zod";
import { FactoryManufacturingPlanSchema } from "@yummyai/contracts/order/manufacturing-delivery";
import { EntityIdSchema as Id } from "@yummyai/contracts/common/ids";

const Checksum = z.string().regex(/^[a-f0-9]{64}$/);
export const FactoryGrantCreateSchema = z
  .object({
    factoryId: Id,
    membershipId: Id,
    expiresAt: z.iso.datetime(),
    canRespond: z.boolean(),
    idempotencyKey: z.uuid(),
  })
  .strict();
export const FactoryAccessRevokeSchema = z
  .object({ idempotencyKey: z.uuid(), reason: z.string().trim().min(5).max(500) })
  .strict();
export const FactoryTaskAssignSchema = z
  .object({
    deliveryItemId: Id,
    fileChecksum: Checksum,
    packageChecksum: Checksum,
    expiresAt: z.iso.datetime(),
    idempotencyKey: z.uuid(),
  })
  .strict();
export const FactoryGrantQuerySchema = z
  .object({
    factoryId: Id.optional(),
    q: z.string().trim().max(100).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(25),
    cursor: z.string().min(1).max(240).optional(),
  })
  .strict();
export const FactoryTaskQuerySchema = z
  .object({
    q: z.string().trim().max(100).optional(),
    status: z
      .enum(["all", "pending", "submitted", "received", "accepted", "rejected"])
      .default("all"),
    limit: z.coerce.number().int().min(1).max(50).default(25),
    cursor: z.string().min(1).max(240).optional(),
  })
  .strict();
export const FactoryTaskFeedbackSchema = z
  .object({
    kind: z.enum(["received", "accepted", "rejected"]),
    expectedSequence: z.int().nonnegative(),
    fileChecksum: Checksum,
    idempotencyKey: z.uuid(),
    reference: z.string().trim().min(1).max(200),
    note: z.string().trim().min(5).max(2000),
    occurredAt: z.iso.datetime(),
    confirmedFileVersion: z.literal(true),
    manufacturingChecksum: Checksum.optional(),
    affectedQuantity: z.int().positive().max(100_000).nullable().default(null),
  })
  .strict()
  .superRefine((input, ctx) => {
    if ((input.kind === "rejected") !== (input.affectedQuantity !== null))
      ctx.addIssue({
        code: "custom",
        path: ["affectedQuantity"],
        message: "Only rejection requires an affected quantity",
      });
  });
export const FactoryGrantViewSchema = z
  .object({
    id: Id,
    factoryId: Id,
    factoryName: z.string(),
    membershipId: Id,
    memberName: z.string(),
    memberEmail: z.string(),
    canRespond: z.boolean(),
    expiresAt: z.iso.datetime(),
    createdAt: z.iso.datetime(),
    status: z.enum(["active", "expired", "revoked"]),
    available: z.boolean(),
    blockers: z.array(z.string()),
    revokedAt: z.iso.datetime().nullable(),
    revocationReason: z.string().nullable(),
  })
  .strict();
export const FactoryAssignmentViewSchema = z
  .object({
    id: Id,
    grantId: Id,
    deliveryItemId: Id,
    fileChecksum: Checksum,
    expiresAt: z.iso.datetime(),
    createdAt: z.iso.datetime(),
    status: z.enum(["active", "expired", "revoked"]),
    available: z.boolean(),
    blockers: z.array(z.string()),
    revokedAt: z.iso.datetime().nullable(),
    revocationReason: z.string().nullable(),
  })
  .strict();
export const FactoryAssignmentListSchema = z
  .object({ items: z.array(FactoryAssignmentViewSchema), nextCursor: z.string().nullable() })
  .strict();
export const FactoryCollaborationWorkspaceSchema = z
  .object({
    factories: z.array(
      z.object({ id: Id, name: z.string(), supplierId: Id, status: z.string() }).strict(),
    ),
    members: z.array(z.object({ id: Id, displayName: z.string(), email: z.string() }).strict()),
    grants: z.array(FactoryGrantViewSchema),
    nextCursor: z.string().nullable(),
    choicesTruncated: z.boolean(),
  })
  .strict();
export const FactoryTaskReceiptViewSchema = z
  .object({
    id: Id,
    sequence: z.int().positive(),
    kind: z.enum(["received", "accepted", "rejected"]),
    reference: z.string(),
    note: z.string(),
    affectedQuantity: z.int().positive().nullable(),
    occurredAt: z.iso.datetime(),
    recordedAt: z.iso.datetime(),
    origin: z.enum(["operator", "factory"]),
  })
  .strict();
export const FactoryTaskManufacturingSchema = z
  .object({
    factoryStandardId: z.string(),
    quantity: z.int().positive(),
    sizeMm: z.number().positive(),
    sizeBasis: z.enum(["artwork", "cut_contour", "finished"]),
    sideMode: z.enum(["single", "double"]),
    minimumNeckMm: z.number().min(50),
    minimumNeckBasis: z.literal("cut_contour"),
    expectedCompletionAt: z.iso.datetime(),
    instructions: z.string().max(20_000).optional(),
    recipe: FactoryManufacturingPlanSchema.nullable().optional(),
  })
  .strict();
export const FactoryWorkItemViewSchema = z
  .object({
    id: Id,
    reference: z.string(),
    factoryName: z.string(),
    expiresAt: z.iso.datetime(),
    createdAt: z.iso.datetime(),
    status: z.enum(["pending", "submitted", "received", "accepted", "rejected"]),
    sequence: z.int().nonnegative(),
    canRespond: z.boolean(),
    blockers: z.array(z.string()),
    manufacturing: FactoryTaskManufacturingSchema.nullable(),
    file: z
      .object({
        checksum: Checksum,
        byteSize: z.int().positive(),
        name: z.string(),
        mediaType: z.literal("image/jpeg"),
      })
      .strict()
      .nullable(),
    receipts: z.array(FactoryTaskReceiptViewSchema).max(1000),
    receiptsTruncated: z.boolean(),
  })
  .strict();
export const FactoryWorkItemListSchema = z
  .object({ items: z.array(FactoryWorkItemViewSchema), nextCursor: z.string().nullable() })
  .strict();
export type FactoryGrantCreate = z.infer<typeof FactoryGrantCreateSchema>;
export type FactoryTaskAssign = z.infer<typeof FactoryTaskAssignSchema>;
export type FactoryTaskFeedback = z.infer<typeof FactoryTaskFeedbackSchema>;
export type FactoryTaskQuery = z.infer<typeof FactoryTaskQuerySchema>;
export type FactoryWorkItemView = z.infer<typeof FactoryWorkItemViewSchema>;
