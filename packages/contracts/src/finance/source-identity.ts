import { z } from "zod";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";

// A source entry identifies one economic event/component in the source ledger.
// An order reference, CSV row number, amount or document name is not that ID.
export const FinanceSourceEntryIdSchema = z.string().trim().min(1).max(300)
  .refine(value => !Array.from(value).some(character => {
    const code = character.charCodeAt(0); return code < 32 || code === 127;
  }), "Source entry IDs must not contain control characters");
export const FinanceSourceIdentitySchema = z.discriminatedUnion("kind", [
  z.object({ schemaVersion: z.literal(2), kind: z.literal("marketplace_account") }).strict(),
  z.object({ schemaVersion: z.literal(2), kind: z.literal("supplier"), supplierId: EntityIdSchema }).strict(),
  z.object({ schemaVersion: z.literal(2), kind: z.literal("named_source"),
    sourceName: z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/) }).strict(),
]);
export const FinanceSourceDiagnosticSchema = z.object({
  schemaVersion: z.literal(1), unidentifiedFactIds: z.array(EntityIdSchema),
}).strict();
export type FinanceSourceIdentity = z.infer<typeof FinanceSourceIdentitySchema>;
export type FinanceSourceDiagnostic = z.infer<typeof FinanceSourceDiagnosticSchema>;

export function financeSourceScopeKey(input: {
  provider: string; accountId: string | null; sourceIdentity: FinanceSourceIdentity;
}): string {
  const source = FinanceSourceIdentitySchema.parse(input.sourceIdentity);
  if (source.kind === "marketplace_account") {
    if (!input.accountId || !["amazon", "etsy", "advertising"].includes(input.provider)) {
      throw new Error("finance_source_account_mismatch");
    }
    return `account:${EntityIdSchema.parse(input.accountId).toLowerCase()}`;
  }
  if (input.accountId !== null) throw new Error("finance_source_account_mismatch");
  if (source.kind === "supplier") {
    if (input.provider !== "supplier") throw new Error("finance_source_supplier_mismatch");
    return `supplier:${source.supplierId.toLowerCase()}`;
  }
  if (["amazon", "etsy", "supplier"].includes(input.provider)) throw new Error("finance_source_named_mismatch");
  return `source:${source.sourceName}`;
}

export function hasFinanceSourceIdentityEvidence(run: {
  sourceIdentityVersion?: number | null;
  diagnostics?: { sourceIdentity?: FinanceSourceDiagnostic };
}): boolean {
  const source = FinanceSourceDiagnosticSchema.safeParse(run.diagnostics?.sourceIdentity);
  return run.sourceIdentityVersion === 1 && source.success && source.data.unidentifiedFactIds.length === 0;
}
