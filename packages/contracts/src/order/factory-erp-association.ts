import { z } from "zod";
const Id = z.uuidv7().transform(value => value.toLowerCase());
/** Explicit CAS includes the last release when a factory head is unbound. */
export const FactoryErpAssociationPinSchema = z.object({
  expectedActiveBindingId: Id.nullable(), expectedRevision: z.int().min(0).max(1_000_000), expectedReleaseId: Id.nullable(), confirmed: z.literal(true),
}).strict().superRefine((value, ctx) => {
  if (value.expectedRevision === 0 && (value.expectedActiveBindingId !== null || value.expectedReleaseId !== null) ||
    value.expectedActiveBindingId !== null && (value.expectedRevision === 0 || value.expectedReleaseId !== null) ||
    value.expectedActiveBindingId === null && value.expectedRevision > 0 && value.expectedReleaseId === null)
    ctx.addIssue({ code: "custom", message: "Association pin must distinguish an initial head, an active binding and a released revision" });
});
export type FactoryErpAssociationPin = z.infer<typeof FactoryErpAssociationPinSchema>;
export const FactoryErpAssociationViewSchema = z.object({
  activeBindingId: Id.nullable(), revision: z.int().min(0).max(1_000_000), releaseId: Id.nullable(),
}).strict();
