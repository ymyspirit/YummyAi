import { z } from "zod";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { CreateProductionDeliverySchema, RecordProductionDeliveryFeedbackSchema } from "@yummyai/contracts/order/production-delivery";
import { CreateProductionRecoveryInputSchema, RecordProductionMilestoneInputSchema, RecordQualityInspectionInputSchema } from "@yummyai/contracts/order/production";
import { RecordQualityGroupsInputSchema } from "@yummyai/contracts/order/quality-groups";
import { AppendShipmentVersionInputSchema, CreateShipmentInputSchema, ReviewShipmentVersionInputSchema } from "@yummyai/contracts/order/shipment";
import { CreateWholeOrderShipmentInputSchema, InspectWholeOrderInputSchema, RecordWholeOrderProductionInputSchema } from "@yummyai/contracts/order/whole-fulfillment";
import { DispatchOrderShipmentInputSchema, RecordManualShipmentConfirmationInputSchema } from "@yummyai/contracts/order/workspace";

export const FULFILLMENT_COMMAND_VERSION = "fulfillment-command-v1" as const;
const Id = EntityIdSchema.refine(value => value === value.toLowerCase(), "履约引用须使用规范的小写编号");
const Checksum = z.string().regex(/^[a-f0-9]{64}$/);
const RequestId = z.uuid().refine(value => value === value.toLowerCase(), "原请求编号须使用规范的小写编号");
const base = { requestId: RequestId, targetId: Id };
export const FulfillmentCommandKindSchema = z.enum([
  "delivery_create", "delivery_feedback", "production_milestone", "quality_inspection", "quality_group_inspection", "production_recovery",
  "whole_production_milestone", "whole_quality_inspection", "shipment_create", "whole_shipment_create", "shipment_version",
  "shipment_review", "shipment_dispatch", "shipment_platform_confirmation",
]);
export type FulfillmentCommandKind = z.infer<typeof FulfillmentCommandKindSchema>;

/** These are the original owner inputs, never an arbitrary path or tool call. */
export const PrepareFulfillmentCommandSchema = z.discriminatedUnion("kind", [
  z.object({ ...base, kind: z.literal("delivery_create"), input: CreateProductionDeliverySchema }).strict(),
  z.object({ ...base, kind: z.literal("delivery_feedback"), packageId: Id, input: RecordProductionDeliveryFeedbackSchema }).strict(),
  z.object({ ...base, kind: z.literal("production_milestone"), input: RecordProductionMilestoneInputSchema.extend({ externalEventId: z.string().trim().min(1).max(300) }) }).strict(),
  z.object({ ...base, kind: z.literal("quality_inspection"), input: RecordQualityInspectionInputSchema }).strict(),
  z.object({ ...base, kind: z.literal("quality_group_inspection"), input: RecordQualityGroupsInputSchema }).strict(),
  z.object({ ...base, kind: z.literal("production_recovery"), input: CreateProductionRecoveryInputSchema }).strict(),
  z.object({ ...base, kind: z.literal("whole_production_milestone"), input: RecordWholeOrderProductionInputSchema }).strict(),
  z.object({ ...base, kind: z.literal("whole_quality_inspection"), input: InspectWholeOrderInputSchema }).strict(),
  z.object({ ...base, kind: z.literal("shipment_create"), input: CreateShipmentInputSchema }).strict(),
  z.object({ ...base, kind: z.literal("whole_shipment_create"), input: CreateWholeOrderShipmentInputSchema }).strict(),
  z.object({ ...base, kind: z.literal("shipment_version"), input: AppendShipmentVersionInputSchema }).strict(),
  z.object({ ...base, kind: z.literal("shipment_review"), versionId: Id, input: ReviewShipmentVersionInputSchema }).strict(),
  z.object({ ...base, kind: z.literal("shipment_dispatch"), input: DispatchOrderShipmentInputSchema }).strict(),
  z.object({ ...base, kind: z.literal("shipment_platform_confirmation"), input: RecordManualShipmentConfirmationInputSchema }).strict(),
]).superRefine((command, context) => {
  if (command.kind === "production_recovery" && command.targetId !== command.input.originalProductionOrderId)
    context.addIssue({ code: "custom", path: ["targetId"], message: "补做必须绑定原生产单" });
  function visit(value: unknown, key: string, path: Array<string | number>) {
    if (typeof value === "string" && /Ids?$/.test(key) && EntityIdSchema.safeParse(value).success && value !== value.toLowerCase())
      context.addIssue({ code: "custom", path, message: "履约引用须使用规范的小写编号" });
    else if (Array.isArray(value)) value.forEach((item, index) => visit(item, key, [...path, index]));
    else if (value && typeof value === "object") for (const [childKey, child] of Object.entries(value)) visit(child, childKey, [...path, childKey]);
  }
  visit(command.input, "input", ["input"]);
});
export type PrepareFulfillmentCommand = z.infer<typeof PrepareFulfillmentCommandSchema>;

export function normalizeFulfillmentCommand(raw: unknown): PrepareFulfillmentCommand {
  const command = PrepareFulfillmentCommandSchema.parse(raw);
  if (["whole_production_milestone", "whole_quality_inspection", "whole_shipment_create"].includes(command.kind)) {
    const value = command as Extract<PrepareFulfillmentCommand, { kind: "whole_production_milestone" | "whole_quality_inspection" | "whole_shipment_create" }>;
    value.input.items.sort((a, b) => a.lineId.localeCompare(b.lineId));
  }
  if (command.kind === "delivery_create") command.input.items.sort((a, b) => a.productionOrderId.localeCompare(b.productionOrderId));
  return command;
}
export const fulfillmentCommandCanonicalJson = (raw: unknown) => canonicalJson(normalizeFulfillmentCommand(raw));
export const fulfillmentCommandRequestKey = (command: PrepareFulfillmentCommand) => command.kind === "production_milestone" ? command.input.externalEventId : command.input.idempotencyKey;

const item = z.object({ productionOrderId: Id, eventId: Id, sequence: z.int().positive() }).strict();
const inspection = z.object({ productionOrderId: Id, inspectionId: Id }).strict();
const shipment = { shipmentId: Id, versionId: Id, versionNumber: z.int().positive() };
export const FulfillmentCommandReceiptSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("delivery_create"), packageId: Id, itemIds: z.array(Id).min(1).max(50), packageChecksum: Checksum }).strict(),
  z.object({ kind: z.literal("delivery_feedback"), packageId: Id, itemId: Id, feedbackId: Id, sequence: z.int().positive() }).strict(),
  item.extend({ kind: z.literal("production_milestone") }).strict(),
  inspection.extend({ kind: z.literal("quality_inspection") }).strict(),
  inspection.extend({ kind: z.literal("quality_group_inspection"), groupIds: z.array(Id).min(1).max(200) }).strict(),
  z.object({ kind: z.literal("production_recovery"), recoveryId: Id, replacementProductionOrderId: Id.nullable() }).strict(),
  z.object({ kind: z.literal("whole_production_milestone"), items: z.array(item).min(1).max(100) }).strict(),
  z.object({ kind: z.literal("whole_quality_inspection"), items: z.array(inspection).min(1).max(100) }).strict(),
  z.object({ kind: z.literal("shipment_create"), ...shipment }).strict(),
  z.object({ kind: z.literal("whole_shipment_create"), ...shipment }).strict(),
  z.object({ kind: z.literal("shipment_version"), ...shipment }).strict(),
  z.object({ kind: z.literal("shipment_review"), shipmentId: Id, reviewId: Id, versionId: Id }).strict(),
  z.object({ kind: z.literal("shipment_dispatch"), shipmentId: Id, trackingEventIds: z.array(Id).min(1).max(100) }).strict(),
  z.object({ kind: z.literal("shipment_platform_confirmation"), shipmentId: Id, confirmationId: Id, versionId: Id }).strict(),
]);
export type FulfillmentCommandReceipt = z.infer<typeof FulfillmentCommandReceiptSchema>;
export const FulfillmentCommandStatusSchema = z.enum(["prepared", "executing", "uncertain", "succeeded", "rejected", "cancelled", "expired", "acknowledged"]);
export const FulfillmentCommandErrorSchema = z.enum(["conflict", "source_unavailable", "forbidden", "unknown", "superseded"]);
export const FulfillmentCommandSummarySchema = z.object({ orderNumber: z.string().min(1).max(2000), lineCount: z.int().positive().max(100), label: z.string().min(1).max(200) }).strict();
export const FulfillmentCommandViewSchema = z.object({
  id: Id, requestId: RequestId, requestChecksum: Checksum, kind: FulfillmentCommandKindSchema, targetId: Id,
  orderId: Id, lineIds: z.array(Id).min(1).max(100), status: FulfillmentCommandStatusSchema,
  createdAt: z.iso.datetime(), expiresAt: z.iso.datetime(), leaseExpiresAt: z.iso.datetime().nullable(),
  acknowledged: z.boolean(), canExecute: z.boolean(), canCancel: z.boolean(), summary: FulfillmentCommandSummarySchema.nullable(),
  receipt: FulfillmentCommandReceiptSchema.nullable(), errorCode: FulfillmentCommandErrorSchema.nullable(),
}).strict().superRefine((view, context) => {
  if (view.receipt && (view.receipt.kind !== view.kind || view.status !== "succeeded"))
    context.addIssue({ code: "custom", path: ["receipt"], message: "履约回执必须匹配原提交" });
  if (view.status === "succeeded" && !view.receipt) context.addIssue({ code: "custom", path: ["receipt"], message: "成功须有原业务回执" });
  if (view.canExecute && (!["prepared", "uncertain"].includes(view.status) || !view.summary || view.acknowledged))
    context.addIssue({ code: "custom", path: ["canExecute"], message: "当前原提交不能恢复执行" });
});
export type FulfillmentCommandView = z.infer<typeof FulfillmentCommandViewSchema>;
export type FulfillmentCommandSummary = z.infer<typeof FulfillmentCommandSummarySchema>;
export const FulfillmentCommandListSchema = z.object({ items: z.array(FulfillmentCommandViewSchema).max(100), truncated: z.boolean() }).strict();
export const FulfillmentCommandQuerySchema = z.object({
  orderId: Id, lineId: Id.optional(), requestId: RequestId.optional(), requestChecksum: Checksum.optional(),
}).strict().refine(value => Boolean(value.requestId) === Boolean(value.requestChecksum), { message: "恢复原请求须同时指定原编号与摘要" });
