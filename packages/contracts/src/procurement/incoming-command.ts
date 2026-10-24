import { z } from "zod";
import {
  PublishIncomingStandardInputSchema, RecordIncomingArrivalInputSchema, RecordIncomingInspectionInputSchema,
  ReviewIncomingInspectionInputSchema, PostIncomingInspectionInputSchema, ReturnIncomingRejectedInputSchema,
} from "@yummyai/contracts/procurement/incoming";

const Id = z.uuidv7().transform(value => value.toLowerCase());
export const IncomingCommandKindSchema = z.enum(["publish_standard", "record_arrival", "record_inspection", "review_inspection", "post_inspection", "return_rejected"]);
export const PrepareIncomingCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("publish_standard"), targetId: Id, input: PublishIncomingStandardInputSchema }).strict(),
  z.object({ kind: z.literal("record_arrival"), targetId: Id, input: RecordIncomingArrivalInputSchema }).strict(),
  z.object({ kind: z.literal("record_inspection"), targetId: Id, input: RecordIncomingInspectionInputSchema }).strict(),
  z.object({ kind: z.literal("review_inspection"), targetId: Id, input: ReviewIncomingInspectionInputSchema }).strict(),
  z.object({ kind: z.literal("post_inspection"), targetId: Id, input: PostIncomingInspectionInputSchema }).strict(),
  z.object({ kind: z.literal("return_rejected"), targetId: Id, postingId: Id, input: ReturnIncomingRejectedInputSchema }).strict(),
]).superRefine((value, context) => {
  if (value.kind === "publish_standard" && value.targetId !== value.input.stockItemId)
    context.addIssue({ code: "custom", message: "原检验标准必须属于原物料", path: ["targetId"] });
});
export type PrepareIncomingCommand = z.infer<typeof PrepareIncomingCommandSchema>;
export type IncomingCommandKind = z.infer<typeof IncomingCommandKindSchema>;
export const IncomingCommandScopeSchema = z.object({ kind: IncomingCommandKindSchema, targetId: Id }).strict();
export type IncomingCommandScope = z.infer<typeof IncomingCommandScopeSchema>;
export const IncomingCommandEmptyBodySchema = z.object({}).strict();

export const IncomingCommandViewSchema = z.object({
  id: Id, kind: IncomingCommandKindSchema, targetId: Id, postingId: Id.nullable(),
  targetLabel: z.string().min(1).max(1000), targetDetail: z.string().max(2000).nullable(),
  status: z.enum(["prepared", "succeeded", "rejected", "cancelled", "expired"]),
  createdAt: z.iso.datetime(), expiresAt: z.iso.datetime(), completedAt: z.iso.datetime().nullable(),
  contextAuthority: z.string().min(1), acknowledged: z.boolean(),
  canExecute: z.boolean(), canCancel: z.boolean(),
  original: PrepareIncomingCommandSchema.nullable(),
  result: z.object({ kind: IncomingCommandKindSchema, id: Id }).strict().nullable(),
  blockReason: z.enum(["basis_changed", "permission_denied", "input_unavailable", "expired"]).nullable(),
}).strict().superRefine((value, context) => {
  if ((value.status === "succeeded") !== (value.result !== null) || (value.status === "prepared") !== (value.completedAt === null))
    context.addIssue({ code: "custom", message: "原操作状态与原业务结果不一致" });
  if (value.result && value.result.kind !== value.kind || value.original &&
    (value.original.kind !== value.kind || value.original.targetId !== value.targetId ||
      (value.original.kind === "return_rejected" ? value.original.postingId : null) !== value.postingId))
    context.addIssue({ code: "custom", message: "原填写与原业务对象不一致" });
  if (value.canExecute && (value.status !== "prepared" || !value.original || value.blockReason !== null) ||
    value.canCancel && value.status !== "prepared" || value.acknowledged && (value.status === "prepared" || value.original !== null))
    context.addIssue({ code: "custom", message: "原操作与填写留存状态不一致" });
});
export const IncomingCommandListSchema = z.object({ items: z.array(IncomingCommandViewSchema).max(1), contextAuthority: z.string().min(1) }).strict();
export const IncomingOrderCommandsSchema = z.object({ purchaseOrderId: Id, items: z.array(IncomingCommandViewSchema).max(50), nextCursor: Id.nullable(), contextAuthority: z.string().min(1) }).strict();
export type IncomingCommandView = z.infer<typeof IncomingCommandViewSchema>;
