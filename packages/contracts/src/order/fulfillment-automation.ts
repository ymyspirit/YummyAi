import { z } from "zod";

const IdempotencyKeySchema = z.string().trim().min(8).max(200);

export const FulfillmentAutomationTypeSchema = z.enum([
  "attention_scan",
  "shipment_reconciliation_scan",
  "pii_retention_scan",
]);

export const FulfillmentAutomationStatusSchema = z.enum([
  "scheduled", "running", "completed", "failed", "cancelled", "dead_letter", "reconciliation_required",
]);

export const ScheduleFulfillmentAutomationInputSchema = z.object({
  type: FulfillmentAutomationTypeSchema,
  runAt: z.iso.datetime(),
  maxAttempts: z.number().int().min(1).max(5).default(3),
  idempotencyKey: IdempotencyKeySchema,
});

export const UpdateFulfillmentAutomationPolicyInputSchema = z.object({
  hourlyQuota: z.number().int().min(1).max(1_000),
  maxAttempts: z.number().int().min(1).max(5),
});

export const CancelFulfillmentAutomationInputSchema = z.object({
  expectedProjectionVersion: z.number().int().positive(),
  reason: z.string().trim().min(1).max(2_000),
  idempotencyKey: IdempotencyKeySchema,
});

export const ReconcileFulfillmentAutomationInputSchema = z.object({
  outcome: z.enum(["completed", "cancelled", "rescheduled"]),
  expectedProjectionVersion: z.number().int().positive(),
  reason: z.string().trim().min(1).max(2_000),
  runAt: z.iso.datetime().nullable(),
  idempotencyKey: IdempotencyKeySchema,
}).superRefine((value, context) => {
  if ((value.outcome === "rescheduled") !== (value.runAt !== null)) context.addIssue({ code: "custom", message: "Only rescheduled outcomes require runAt", path: ["runAt"] });
});

export type ScheduleFulfillmentAutomationInput = z.infer<typeof ScheduleFulfillmentAutomationInputSchema>;
export type UpdateFulfillmentAutomationPolicyInput = z.infer<typeof UpdateFulfillmentAutomationPolicyInputSchema>;
export type CancelFulfillmentAutomationInput = z.infer<typeof CancelFulfillmentAutomationInputSchema>;
export type ReconcileFulfillmentAutomationInput = z.infer<typeof ReconcileFulfillmentAutomationInputSchema>;
