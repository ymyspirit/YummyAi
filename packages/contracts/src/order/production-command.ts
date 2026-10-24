import { z } from "zod";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { CreateProductionOrderInputSchema } from "@yummyai/contracts/order/production";
import { ReleaseOrderArtworkInputSchema } from "@yummyai/contracts/order/workspace";
import { ReleaseWholeOrderInputSchema } from "@yummyai/contracts/order/whole-fulfillment";

export const ProductionCommandKindSchema = z.enum(["approved_design", "reviewed_line", "reviewed_order"]);
const CanonicalId = EntityIdSchema.refine(value => value === value.toLowerCase(), "生产恢复引用须使用规范的小写编号");
export const PrepareProductionCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("approved_design"), targetId: CanonicalId, input: CreateProductionOrderInputSchema }).strict(),
  z.object({ kind: z.literal("reviewed_line"), targetId: CanonicalId, input: ReleaseOrderArtworkInputSchema }).strict(),
  z.object({ kind: z.literal("reviewed_order"), targetId: CanonicalId, input: ReleaseWholeOrderInputSchema }).strict(),
]).superRefine((command, context) => {
  // Database UUID values are canonical lowercase. Reject noncanonical entity
  // references before persisting an intent; never rewrite authored notes or keys.
  function visit(value: unknown, key: string, path: Array<string | number>) {
    if (typeof value === "string" && /Ids?$/.test(key) && EntityIdSchema.safeParse(value).success && value !== value.toLowerCase()) {
      context.addIssue({ code: "custom", path, message: "生产恢复引用须使用规范的小写编号" });
    } else if (Array.isArray(value)) value.forEach((item, index) => visit(item, key, [...path, index]));
    else if (value && typeof value === "object") for (const [childKey, child] of Object.entries(value)) visit(child, childKey, [...path, childKey]);
  }
  visit(command.input, "input", ["input"]);
});
export type PrepareProductionCommand = z.infer<typeof PrepareProductionCommandSchema>;
export type ProductionCommandKind = z.infer<typeof ProductionCommandKindSchema>;

export const ProductionCommandStatusSchema = z.enum(["prepared", "executing", "succeeded", "rejected", "uncertain", "cancelled", "expired"]);
export const ProductionCommandReceiptSchema = z.object({ productionOrderIds: z.array(EntityIdSchema).min(1).max(100) }).strict();
export type ProductionCommandReceipt = z.infer<typeof ProductionCommandReceiptSchema>;
export const ProductionCommandSummarySchema = z.object({
  orderNumber: z.string().min(1).max(2000), lineCount: z.int().positive().max(100), quantity: z.int().positive(),
  factoryName: z.string().min(1).max(500).nullable(), expectedCompletionAt: z.iso.datetime(),
  instructions: z.string().max(20_000),
}).strict();
export const ProductionCommandViewSchema = z.object({
  id: EntityIdSchema, kind: ProductionCommandKindSchema, orderId: EntityIdSchema,
  lineIds: z.array(EntityIdSchema).min(1).max(100), status: ProductionCommandStatusSchema,
  createdAt: z.iso.datetime(), expiresAt: z.iso.datetime(), leaseExpiresAt: z.iso.datetime().nullable(),
  acknowledged: z.boolean(), canExecute: z.boolean(), canCancel: z.boolean(),
  summary: ProductionCommandSummarySchema.nullable(), receipt: ProductionCommandReceiptSchema.nullable(),
  errorCode: z.enum(["conflict", "source_unavailable", "forbidden", "unknown", "superseded"]).nullable(),
}).strict();
export const ProductionCommandListSchema = z.object({ items: z.array(ProductionCommandViewSchema).max(100), truncated: z.boolean() }).strict();
export const ProductionCommandQuerySchema = z.object({ orderId: CanonicalId, lineId: CanonicalId.optional() }).strict();
export const ProductionCommandReferenceSchema = z.object({ id: EntityIdSchema }).strict();
export type ProductionCommandView = z.infer<typeof ProductionCommandViewSchema>;
export type ProductionCommandSummary = z.infer<typeof ProductionCommandSummarySchema>;

/** Canonical input is preserved server-side; views expose only the authorized
 * order summary, never a reusable body or execution lease token. */
export function normalizeProductionCommand(raw: unknown): PrepareProductionCommand {
  const command = PrepareProductionCommandSchema.parse(raw);
  if (command.kind === "reviewed_order") command.input.items.sort((left, right) => left.lineId.localeCompare(right.lineId));
  return command;
}
