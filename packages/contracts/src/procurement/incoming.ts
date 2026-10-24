import { z } from "zod";
import { addStockQuantity, compareStockQuantity, subtractStockQuantity } from "@yummyai/contracts/inventory/quantity";
import { NonnegativeStockQuantitySchema, PositiveStockQuantitySchema, StockQuantityViewSchema } from "@yummyai/contracts/inventory/quantity-schema";
import { InventoryPurchaseOrderStatusSchema, ProcurementUnitSchema } from "@yummyai/contracts/procurement";
import { ProcurementStockBasisSchema } from "@yummyai/contracts/procurement/measurement";

const Id = z.uuidv7().transform(value => value.toLowerCase());
const Key = z.string().trim().min(8).max(200);
const Code = z.string().trim().min(1).max(64).regex(/^[A-Z0-9][A-Z0-9._-]*$/);
const Note = z.string().trim().min(1).max(2000);
const IsoTime = z.iso.datetime().transform(value => new Date(value).toISOString());

/** Signed measurements are distinct from unsigned stock quantities. Never use
 * binary floating point to decide whether a recorded measurement meets a bound. */
export const IncomingMeasurementNumberSchema = z.string().trim()
  .regex(/^-?(?:0|[1-9]\d{0,11})(?:\.\d{1,9})?$/)
  .transform(value => {
    const clean = value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
    return /^-?0$/.test(clean) ? "0" : clean;
  });

function scaledMeasurement(value: string) {
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
  return (negative ? -1n : 1n) * (BigInt(whole!) * 1_000_000_000n + BigInt(fraction.padEnd(9, "0")));
}

const NumericCriterion = z.object({
  code: Code, label: z.string().trim().min(1).max(120), kind: z.literal("numeric_range"),
  unit: z.string().trim().min(1).max(32),
  minimum: IncomingMeasurementNumberSchema.nullable(), maximum: IncomingMeasurementNumberSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.minimum === null && value.maximum === null)
    context.addIssue({ code: "custom", message: "A numeric criterion needs an actual bound" });
  if (value.minimum !== null && value.maximum !== null && scaledMeasurement(value.minimum) > scaledMeasurement(value.maximum))
    context.addIssue({ code: "custom", message: "Measurement bounds are reversed" });
});

const ChoiceCriterion = z.object({
  code: Code, label: z.string().trim().min(1).max(120), kind: z.literal("one_of"),
  acceptedValues: z.array(z.string().trim().min(1).max(120)).min(1).max(30),
}).strict().superRefine((value, context) => {
  if (new Set(value.acceptedValues).size !== value.acceptedValues.length)
    context.addIssue({ code: "custom", message: "Accepted measurement values must be unique" });
});

export const IncomingCriterionSchema = z.union([NumericCriterion, ChoiceCriterion]);
export type IncomingCriterion = z.infer<typeof IncomingCriterionSchema>;
export const IncomingReadingSchema = z.object({
  criterionCode: Code, value: z.string().trim().min(1).max(120),
  unit: z.string().trim().min(1).max(32).nullable(),
}).strict();
export type IncomingReading = z.infer<typeof IncomingReadingSchema>;

export const PublishIncomingStandardInputSchema = z.object({
  code: Code, stockItemId: Id, expectedVersion: z.number().int().nonnegative(),
  title: z.string().trim().min(1).max(160), sourceReference: Note,
  criteria: z.array(IncomingCriterionSchema).min(1).max(40), idempotencyKey: Key,
}).strict().superRefine((value, context) => {
  if (new Set(value.criteria.map(item => item.code)).size !== value.criteria.length)
    context.addIssue({ code: "custom", message: "Criterion codes must be unique", path: ["criteria"] });
});

export const IncomingArrivalLineInputSchema = z.object({
  lineKey: Code, quantity: PositiveStockQuantitySchema, unit: ProcurementUnitSchema,
  holdingLocationId: Id, lotCode: z.string().trim().min(1).max(200), expiresAt: IsoTime.nullable(),
}).strict().superRefine((value, context) => {
  if (["each", "pair", "set"].includes(value.unit) && typeof value.quantity === "string" && value.quantity.includes("."))
    context.addIssue({ code: "custom", message: "Discrete units require whole quantities", path: ["quantity"] });
});

export const RecordIncomingArrivalInputSchema = z.object({
  code: Code, expectedPurchaseOrderVersion: z.number().int().positive(),
  arrivedAt: IsoTime, externalReference: Note,
  lines: z.array(IncomingArrivalLineInputSchema).min(1).max(200), idempotencyKey: Key,
}).strict().superRefine((value, context) => {
  if (new Set(value.lines.map(item => item.lineKey)).size !== value.lines.length)
    context.addIssue({ code: "custom", message: "Arrival line keys must be unique", path: ["lines"] });
});

export const RecordIncomingInspectionInputSchema = z.object({
  expectedInspectionVersion: z.number().int().nonnegative(), standardVersionId: Id,
  acceptedQuantity: NonnegativeStockQuantitySchema, rejectedQuantity: NonnegativeStockQuantitySchema,
  sampleQuantity: PositiveStockQuantitySchema,
  rejectionReason: Note.nullable(), measuredAt: IsoTime,
  readings: z.array(IncomingReadingSchema).max(40), notes: Note.nullable(), idempotencyKey: Key,
}).strict().superRefine((value, context) => {
  const inspected = addStockQuantity(value.acceptedQuantity, value.rejectedQuantity);
  if (compareStockQuantity(inspected, 0) <= 0)
    context.addIssue({ code: "custom", message: "Inspection must cover an actual positive quantity" });
  if (compareStockQuantity(value.sampleQuantity, inspected) > 0)
    context.addIssue({ code: "custom", message: "The sample cannot exceed the inspected quantity", path: ["sampleQuantity"] });
  if ((compareStockQuantity(value.rejectedQuantity, 0) > 0) !== (value.rejectionReason !== null))
    context.addIssue({ code: "custom", message: "Rejected quantity needs its actual reason", path: ["rejectionReason"] });
  if (new Set(value.readings.map(item => item.criterionCode)).size !== value.readings.length)
    context.addIssue({ code: "custom", message: "Reading codes must be unique", path: ["readings"] });
  if (value.expectedInspectionVersion > 0 && value.notes === null)
    context.addIssue({ code: "custom", message: "A reinspection needs its actual reason", path: ["notes"] });
});

export const ReviewIncomingInspectionInputSchema = z.object({
  expectedInspectionVersion: z.number().int().positive(), inspectionId: Id,
  decision: z.enum(["approved", "rejected"]), reason: Note, idempotencyKey: Key,
}).strict();

export const PostIncomingInspectionInputSchema = z.object({
  expectedInspectionVersion: z.number().int().positive(), approvalId: Id,
  acceptedQuantity: NonnegativeStockQuantitySchema, rejectedQuantity: NonnegativeStockQuantitySchema,
  rejectionLocationId: Id.nullable(), ownershipConfirmation: z.literal("merchant_received").nullable(), postedAt: IsoTime, idempotencyKey: Key,
}).strict().superRefine((value, context) => {
  if (compareStockQuantity(addStockQuantity(value.acceptedQuantity, value.rejectedQuantity), 0) <= 0)
    context.addIssue({ code: "custom", message: "A posting must dispose an actual positive quantity" });
  if ((compareStockQuantity(value.rejectedQuantity, 0) > 0) !== (value.rejectionLocationId !== null))
    context.addIssue({ code: "custom", message: "Rejected goods need their actual holding location", path: ["rejectionLocationId"] });
  if ((compareStockQuantity(value.acceptedQuantity, 0) > 0) !== (value.ownershipConfirmation !== null))
    context.addIssue({ code: "custom", message: "Accepted stock requires actual merchant ownership confirmation", path: ["ownershipConfirmation"] });
});

export const ReturnIncomingRejectedInputSchema = z.object({
  quantity: PositiveStockQuantitySchema, returnedAt: IsoTime, externalReference: Note,
  reason: Note, idempotencyKey: Key,
}).strict();

export type RecordIncomingArrivalInput = z.infer<typeof RecordIncomingArrivalInputSchema>;
export type RecordIncomingInspectionInput = z.infer<typeof RecordIncomingInspectionInputSchema>;
export type PublishIncomingStandardInput = z.infer<typeof PublishIncomingStandardInputSchema>;
export type ReviewIncomingInspectionInput = z.infer<typeof ReviewIncomingInspectionInputSchema>;
export type PostIncomingInspectionInput = z.infer<typeof PostIncomingInspectionInputSchema>;
export type ReturnIncomingRejectedInput = z.infer<typeof ReturnIncomingRejectedInputSchema>;

export const IncomingEvaluationSchema = z.object({
  items: z.array(z.object({ code: Code, result: z.enum(["pass", "fail", "missing", "invalid"]) }).strict()).min(1).max(40),
  complete: z.boolean(), passed: z.boolean(),
}).strict();

/** Evaluates explicit published criteria only. Missing/invalid readings never
 * become a pass, and an extra reading cannot invent another approved criterion. */
export function evaluateIncomingReadings(criteria: IncomingCriterion[], readings: IncomingReading[]) {
  const codes = new Set(criteria.map(item => item.code));
  if (!criteria.length || codes.size !== criteria.length ||
      new Set(readings.map(item => item.criterionCode)).size !== readings.length ||
      readings.some(item => !codes.has(item.criterionCode))) throw new TypeError("Incoming criteria or readings are inconsistent");
  const items = criteria.map(criterion => {
    const reading = readings.find(item => item.criterionCode === criterion.code);
    let result: "pass" | "fail" | "missing" | "invalid" = "missing";
    if (reading && criterion.kind === "one_of")
      result = reading.unit !== null ? "invalid" : criterion.acceptedValues.includes(reading.value) ? "pass" : "fail";
    if (reading && criterion.kind === "numeric_range") {
      const parsed = IncomingMeasurementNumberSchema.safeParse(reading.value);
      if (!parsed.success || reading.unit !== criterion.unit) result = "invalid";
      else {
        const actual = scaledMeasurement(parsed.data);
        result = (criterion.minimum !== null && actual < scaledMeasurement(criterion.minimum)) ||
          (criterion.maximum !== null && actual > scaledMeasurement(criterion.maximum)) ? "fail" : "pass";
      }
    }
    return { code: criterion.code, result };
  });
  return IncomingEvaluationSchema.parse({ items, complete: items.every(item => item.result === "pass" || item.result === "fail"), passed: items.every(item => item.result === "pass") });
}

export const IncomingLineQuantitiesSchema = z.object({
  arrived: StockQuantityViewSchema, accepted: StockQuantityViewSchema,
  rejected: StockQuantityViewSchema, returned: StockQuantityViewSchema,
  pending: StockQuantityViewSchema, rejectedHeld: StockQuantityViewSchema,
}).strict();

/** Accepted and rejected are mutually exclusive completed dispositions; a return
 * consumes rejected custody, never a second portion of the original arrival. */
export function incomingLineQuantities(arrived: z.infer<typeof PositiveStockQuantitySchema>,
  accepted: z.infer<typeof NonnegativeStockQuantitySchema>, rejected: z.infer<typeof NonnegativeStockQuantitySchema>,
  returned: z.infer<typeof NonnegativeStockQuantitySchema>) {
  for (const quantity of [accepted, rejected, returned]) NonnegativeStockQuantitySchema.parse(quantity);
  PositiveStockQuantitySchema.parse(arrived);
  const pending = subtractStockQuantity(arrived, addStockQuantity(accepted, rejected));
  const rejectedHeld = subtractStockQuantity(rejected, returned);
  if (compareStockQuantity(pending, 0) < 0 || compareStockQuantity(rejectedHeld, 0) < 0)
    throw new RangeError("Incoming quantities do not conserve the original arrival");
  return IncomingLineQuantitiesSchema.parse({ arrived, accepted, rejected, returned, pending, rejectedHeld });
}

export const IncomingStandardViewSchema = z.object({
  id: Id, stockItemId: Id, code: Code, version: z.number().int().positive(), title: z.string(),
  sourceReference: z.string(), criteria: z.array(IncomingCriterionSchema).min(1).max(40), recordedAt: z.iso.datetime(),
}).strict();
export const IncomingReviewViewSchema = z.object({
  id: Id, inspectionId: Id, decision: z.enum(["approved", "rejected"]), reason: z.string(), recordedAt: z.iso.datetime(),
}).strict();
export const IncomingInspectionViewSchema = z.object({
  id: Id, version: z.number().int().positive(), standardVersionId: Id,
  acceptedQuantity: NonnegativeStockQuantitySchema, rejectedQuantity: NonnegativeStockQuantitySchema,
  sampleQuantity: PositiveStockQuantitySchema, rejectionReason: z.string().nullable(), measuredAt: z.iso.datetime(),
  readings: z.array(IncomingReadingSchema).max(40), evaluation: IncomingEvaluationSchema, notes: z.string().nullable(),
  recordedAt: z.iso.datetime(), review: IncomingReviewViewSchema.nullable(),
}).strict();
export const IncomingReturnViewSchema = z.object({
  id: Id, postingId: Id, quantity: PositiveStockQuantitySchema, returnedAt: z.iso.datetime(),
  externalReference: z.string(), reason: z.string(), recordedAt: z.iso.datetime(),
}).strict();
export const IncomingPostingViewSchema = z.object({
  id: Id, arrivalLineId: Id, approvalId: Id, receiptId: Id,
  acceptedQuantity: NonnegativeStockQuantitySchema, rejectedQuantity: NonnegativeStockQuantitySchema,
  rejectionLocationId: Id.nullable(), merchantOwnershipConfirmed: z.boolean(), postedAt: z.iso.datetime(), recordedAt: z.iso.datetime(),
  returns: z.array(IncomingReturnViewSchema),
}).strict();
export const IncomingArrivalLineViewSchema = z.object({
  id: Id, arrivalId: Id, lineKey: Code, stockItemId: Id, stockName: z.string(), stockCode: Code,
  holdingLocationId: Id, holdingLocationName: z.string(), supplierLotCode: z.string().min(1).max(200), expiresAt: z.iso.datetime().nullable(),
  unit: ProcurementUnitSchema, quantities: IncomingLineQuantitiesSchema,
  inspections: z.array(IncomingInspectionViewSchema), postings: z.array(IncomingPostingViewSchema),
  canInspect: z.boolean(), canReview: z.boolean(), canPost: z.boolean(), canReturn: z.boolean(),
}).strict();
export const IncomingArrivalViewSchema = z.object({
  id: Id, code: Code, purchaseOrderId: Id, purchaseOrderVersionId: Id,
  arrivedAt: z.iso.datetime(), externalReference: z.string(), recordedAt: z.iso.datetime(),
  lines: z.array(IncomingArrivalLineViewSchema),
}).strict();
export const IncomingWorkspaceViewSchema = z.object({
  purchaseOrderId: Id, purchaseOrderCode: Code, receivingPolicy: z.literal("inspection_required").nullable(),
  purchaseOrderVersion: z.number().int().positive(), purchaseOrderStatus: InventoryPurchaseOrderStatusSchema,
  purchaseLines: z.array(z.object({ lineKey: Code, stockItemId: Id, stockName: z.string(), stockCode: Code,
    quantity: PositiveStockQuantitySchema, unit: ProcurementUnitSchema, stockBasis: ProcurementStockBasisSchema.nullable().optional(),
    destinationLocationId: Id, destinationLocationName: z.string() }).strict()).max(200),
  locations: z.array(z.object({ id: Id, code: z.string(), name: z.string(), warehouseName: z.string() }).strict()).max(1000),
  arrivals: z.array(IncomingArrivalViewSchema), standards: z.array(IncomingStandardViewSchema),
  canRecordArrival: z.boolean(), canPublishStandard: z.boolean(), standardWritableStockItemIds: z.array(Id),
  truncated: z.boolean(), contextAuthority: z.string(), recordingTime: z.iso.datetime(),
}).strict();
export type IncomingWorkspaceView = z.infer<typeof IncomingWorkspaceViewSchema>;
export type IncomingArrivalLineView = z.infer<typeof IncomingArrivalLineViewSchema>;
export const IncomingLineWorkspaceViewSchema = z.object({ line: IncomingArrivalLineViewSchema, contextAuthority: z.string(), recordingTime: z.iso.datetime() }).strict();
