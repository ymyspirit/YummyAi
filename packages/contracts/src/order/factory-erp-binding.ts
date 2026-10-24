import { z } from "zod";
import { FactoryErpApplyResultSchema, FactoryErpItemSelectionSchema } from "@yummyai/contracts/order/factory-erp-import";
import { FactoryErpEvidenceSourceSchema } from "@yummyai/contracts/order/factory-erp-source-pin";
import { FactoryErpVoidSummarySchema } from "@yummyai/contracts/order/factory-erp-void-review";
export { FactoryErpAssociationPinSchema, FactoryErpAssociationViewSchema, type FactoryErpAssociationPin } from "@yummyai/contracts/order/factory-erp-association";

const Id = z.uuidv7().transform(value => value.toLowerCase()), Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Selection = FactoryErpItemSelectionSchema.transform(value => ({ ...value, deliveryItemId: value.deliveryItemId.toLowerCase(), productionOrderId: value.productionOrderId.toLowerCase(), productionVersionId: value.productionVersionId.toLowerCase() }));
const State = z.enum(["scheduled", "shipped"]).nullable();
export const FactoryErpBindingReasonSchema = z.enum(["wrong_group", "factory_number_reused", "duplicate_binding", "operator_confirmed_change"]);
export type FactoryErpBindingReason = z.infer<typeof FactoryErpBindingReasonSchema>;
export const FactoryErpBindingSourceSchema = FactoryErpEvidenceSourceSchema;
export type FactoryErpBindingSource = z.infer<typeof FactoryErpBindingSourceSchema>;

const Base = z.object({
  expectedRevision: z.int().min(1).max(1_000_000), expectedItemsChecksum: Hash, expectedObservationSequence: z.int().nonnegative(),
  source: FactoryErpBindingSourceSchema, reasonCode: FactoryErpBindingReasonSchema, idempotencyKey: Id, confirmed: z.literal(true),
});
const Release = Base.extend({ action: z.literal("release") }).strict();
const Correct = Base.extend({ action: z.literal("correct"), items: z.array(Selection).min(1).max(50), wholeGroupConfirmed: z.literal(true) }).strict();
export const ChangeFactoryErpBindingSchema = z.discriminatedUnion("action", [Release, Correct]).superRefine((value, ctx) => {
  if (value.action !== "correct") return;
  if (new Set(value.items.map(item => item.deliveryItemId)).size !== value.items.length ||
    new Set(value.items.map(item => item.productionOrderId)).size !== value.items.length)
    ctx.addIssue({ code: "custom", message: "A corrected whole group cannot repeat a delivery item or production order" });
});
export type ChangeFactoryErpBinding = z.infer<typeof ChangeFactoryErpBindingSchema>;
export const FactoryErpBindingChangeResultSchema = z.object({
  id: Id, bindingId: Id, factoryId: Id, action: z.enum(["release", "correct"]), reasonCode: FactoryErpBindingReasonSchema,
  source: FactoryErpBindingSourceSchema, originalRevision: z.int().positive(), originalItemsChecksum: Hash, originalObservationSequence: z.int().nonnegative(),
  replacementBindingId: Id.nullable(), replacementRevision: z.int().positive().nullable(), application: FactoryErpApplyResultSchema.nullable(),
  requestChecksum: Hash, createdAt: z.iso.datetime(),
}).strict().superRefine((value, ctx) => {
  if (value.action === "release") {
    if (value.replacementBindingId !== null || value.replacementRevision !== null || value.application !== null)
      ctx.addIssue({ code: "custom", message: "Release does not create a replacement or a factory observation" });
  } else if (!value.application || !value.replacementBindingId || value.replacementRevision !== value.originalRevision + 1 ||
    value.application.importId !== value.source.importId || value.application.fileChecksum !== value.source.fileChecksum ||
    value.application.previewChecksum !== value.source.previewChecksum || value.application.appliedRows !== 1 || value.application.observations.length !== 1 ||
    value.application.observations[0]?.bindingId !== value.replacementBindingId || value.application.observations[0]?.rowNumber !== value.source.rowNumber)
    ctx.addIssue({ code: "custom", message: "Correction requires one explicit new-source application to the next binding revision" });
});
export type FactoryErpBindingChangeResult = z.infer<typeof FactoryErpBindingChangeResultSchema>;
export const FactoryErpBindingItemSchema = FactoryErpItemSelectionSchema.extend({ quantity: z.int().min(1).max(100_000) }).strict();
const BindingViewBase = z.object({
  id: Id, factoryId: Id, revision: z.int().min(1).max(1_000_000), previousBindingId: Id.nullable(), nextBindingId: Id.nullable(),
  releasedBy: Id.nullable(), state: z.enum(["active", "released"]), itemsChecksum: Hash, quantity: z.int().min(1).max(100_000),
  sourceImportId: Id, observationSequence: z.int().nonnegative(), recordedStatus: State, recordedException: z.literal("voided_requires_review").nullable(),
  items: z.array(FactoryErpBindingItemSchema).min(1).max(50), createdAt: z.iso.datetime(), release: FactoryErpBindingChangeResultSchema.nullable(),
  voidSummary: FactoryErpVoidSummarySchema.optional(),
}).strict();
export const FactoryErpBindingViewSchema = BindingViewBase.superRefine((value, ctx) => {
  if ((value.state === "released") !== (value.releasedBy !== null) || (value.revision === 1) !== (value.previousBindingId === null) ||
    (value.releasedBy !== null) !== (value.release !== null) || value.release && (value.release.id !== value.releasedBy || value.release.bindingId !== value.id || value.release.originalRevision !== value.revision) ||
    new Set(value.items.map(item => item.deliveryItemId)).size !== value.items.length || value.items.reduce((sum, item) => sum + item.quantity, 0) !== value.quantity)
    ctx.addIssue({ code: "custom", message: "Binding history must preserve its complete original group and release receipt" });
});
export type FactoryErpBindingView = z.infer<typeof FactoryErpBindingViewSchema>;
export const FactoryErpBindingPageQuerySchema = z.object({ factoryId: Id, cursor: Id.optional(), limit: z.coerce.number().int().min(1).max(100).default(20) }).strict();
const BindingHeader = BindingViewBase.omit({ items: true, release: true }).superRefine((value, ctx) => {
  if ((value.state === "released") !== (value.releasedBy !== null) || (value.revision === 1) !== (value.previousBindingId === null) || value.state === "active" && value.nextBindingId !== null)
    ctx.addIssue({ code: "custom", message: "Binding page headers must preserve the actual release and revision shape" });
});
export const FactoryErpBindingPageSchema = z.object({
  items: z.array(BindingHeader).max(100), nextCursor: Id.nullable(),
}).strict();
export const FactoryErpBindingChangePageQuerySchema = z.object({ cursor: Id.optional(), limit: z.coerce.number().int().min(1).max(100).default(20) }).strict();
export const FactoryErpBindingChangePageSchema = z.object({
  items: z.array(FactoryErpBindingChangeResultSchema).max(100), nextCursor: Id.nullable(),
}).strict();
