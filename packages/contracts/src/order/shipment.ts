import { z } from "zod";

import { EntityIdSchema } from "../common/ids.js";

export const ShipmentStatusSchema = z.enum([
  "draft", "approved", "writeback_pending", "shipped", "in_transit", "delivered", "exception", "cancelled",
]);

export const TrackingStatusSchema = z.enum([
  "information_received", "picked_up", "in_transit", "out_for_delivery", "delivered", "delivery_exception", "returned",
]);

export const ShipmentPackageLineInputSchema = z.object({
  orderLineId: EntityIdSchema,
  quantity: z.number().int().positive().max(100_000),
}).strict();

export const ShipmentPackageInputSchema = z.object({
  packageReferenceId: z.string().trim().min(1).max(160),
  trackingNumber: z.string().trim().min(1).max(200),
  carrierCode: z.string().trim().regex(/^[A-Z0-9_:-]{1,80}$/),
  carrierName: z.string().trim().min(1).max(160),
  carrierService: z.string().trim().min(1).max(160),
  labelAssetId: EntityIdSchema.nullable().default(null),
  externalLabelId: z.string().trim().min(1).max(300).nullable().default(null),
  labelCostMinor: z.number().int().nonnegative().nullable().default(null),
  labelCurrency: z.string().regex(/^[A-Z]{3}$/).nullable().default(null),
  weightGrams: z.number().int().positive().max(10_000_000).nullable().default(null),
  dimensionsMm: z.object({ length: z.number().int().positive(), width: z.number().int().positive(), height: z.number().int().positive() }).strict().nullable().default(null),
  lines: z.array(ShipmentPackageLineInputSchema).min(1).max(1_000),
}).strict().superRefine((value, context) => {
  if ((value.labelCostMinor === null) !== (value.labelCurrency === null)) {
    context.addIssue({ code: "custom", path: ["labelCostMinor"], message: "Label cost and currency must be provided together" });
  }
  if (new Set(value.lines.map((line) => line.orderLineId)).size !== value.lines.length) {
    context.addIssue({ code: "custom", path: ["lines"], message: "A package cannot repeat an order line" });
  }
});

const ShipmentVersionContentSchema = z.object({
  shipDate: z.iso.datetime(),
  promisedDeliveryAt: z.iso.datetime().nullable().default(null),
  estimatedDeliveryAt: z.iso.datetime().nullable().default(null),
  shipFromCountryCode: z.string().regex(/^[A-Z]{2}$/),
  packages: z.array(ShipmentPackageInputSchema).min(1).max(100),
}).strict();

export const CreateShipmentInputSchema = ShipmentVersionContentSchema.extend({
  idempotencyKey: z.string().trim().min(8).max(200),
}).strict().superRefine(validateShipmentContent);

export const AppendShipmentVersionInputSchema = ShipmentVersionContentSchema.extend({
  expectedCurrentVersion: z.number().int().positive(),
  idempotencyKey: z.string().trim().min(8).max(200),
}).strict().superRefine(validateShipmentContent);

function validateShipmentContent(value: z.infer<typeof ShipmentVersionContentSchema>, context: z.RefinementCtx) {
  if (new Set(value.packages.map((entry) => entry.packageReferenceId)).size !== value.packages.length) {
    context.addIssue({ code: "custom", path: ["packages"], message: "Package reference IDs must be unique within a version" });
  }
  const shipDate = Date.parse(value.shipDate);
  if (value.promisedDeliveryAt && Date.parse(value.promisedDeliveryAt) < shipDate) context.addIssue({ code: "custom", path: ["promisedDeliveryAt"], message: "Promised delivery cannot precede ship date" });
  if (value.estimatedDeliveryAt && Date.parse(value.estimatedDeliveryAt) < shipDate) context.addIssue({ code: "custom", path: ["estimatedDeliveryAt"], message: "Estimated delivery cannot precede ship date" });
}

export const ReviewShipmentVersionInputSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  reasonCode: z.string().regex(/^[A-Z0-9_:-]{1,160}$/),
  reason: z.string().trim().min(1).max(2_000),
  expectedCurrentVersion: z.number().int().positive(),
  idempotencyKey: z.string().trim().min(8).max(200),
}).strict();

export const RequestShipmentWritebackInputSchema = z.object({
  shipmentVersionId: EntityIdSchema,
  idempotencyKey: z.string().trim().min(8).max(200),
}).strict();

export const RecordShipmentWritebackEventInputSchema = z.object({
  action: z.enum(["dispatched", "accepted", "rejected", "uncertain", "reconcile_accepted", "reconcile_rejected"]),
  expectedProjectionVersion: z.number().int().positive(),
  providerCode: z.string().trim().max(160).nullable().default(null),
  externalReference: z.string().trim().min(1).max(300).nullable().default(null),
  occurredAt: z.iso.datetime(),
}).strict().superRefine((value, context) => {
  if (["accepted", "reconcile_accepted"].includes(value.action) && value.externalReference === null) {
    context.addIssue({ code: "custom", path: ["externalReference"], message: "Accepted writeback requires external acknowledgement" });
  }
});

export const RecordTrackingEventInputSchema = z.object({
  packageId: EntityIdSchema,
  status: TrackingStatusSchema,
  provider: z.string().trim().regex(/^[a-z0-9_:-]{1,80}$/),
  externalEventId: z.string().trim().min(1).max(300),
  detailCode: z.string().trim().regex(/^[A-Z0-9_:-]{1,160}$/),
  occurredAt: z.iso.datetime(),
  estimatedDeliveryAt: z.iso.datetime().nullable().default(null),
}).strict();

export type ShipmentStatus = z.infer<typeof ShipmentStatusSchema>;
export type TrackingStatus = z.infer<typeof TrackingStatusSchema>;
export type ShipmentPackageInput = z.infer<typeof ShipmentPackageInputSchema>;
export type CreateShipmentInput = z.infer<typeof CreateShipmentInputSchema>;
export type AppendShipmentVersionInput = z.infer<typeof AppendShipmentVersionInputSchema>;
export type ReviewShipmentVersionInput = z.infer<typeof ReviewShipmentVersionInputSchema>;
export type RequestShipmentWritebackInput = z.infer<typeof RequestShipmentWritebackInputSchema>;
export type RecordShipmentWritebackEventInput = z.infer<typeof RecordShipmentWritebackEventInputSchema>;
export type RecordTrackingEventInput = z.infer<typeof RecordTrackingEventInputSchema>;
