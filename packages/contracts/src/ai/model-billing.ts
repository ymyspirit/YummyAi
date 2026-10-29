import { z } from "zod";
import {
  OfficialApiPriceCatalogSchema,
  OfficialApiPriceCheckSchema,
} from "@yummyai/contracts/ai/official-model-pricing";
import {
  HarnessInvocationViewSchema,
  ModelBillingAcknowledgmentSchema,
} from "@yummyai/contracts/harness";

export const ModelBillingOwnerSchema = z.enum(["assist", "pod", "order_design"]);
export const ModelBillingConfirmOwnerSchema = z.enum(["assist", "pod"]);
export const ModelBillingSubjectIdSchema = z.uuidv7();
const Checksum = z.string().regex(/^[a-f0-9]{64}$/);
const Reference = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/);
const ConfirmedUsd = z
  .string()
  .trim()
  .regex(/^(0|[1-9]\d{0,7})(\.\d{1,8})?$/)
  .transform((value) => {
    const [whole, fraction = ""] = value.split(".");
    return whole + "." + fraction.padEnd(8, "0");
  })
  .refine(
    (value) => BigInt(value.replace(".", "")) <= 9999999999999900n,
    "Amount exceeds supported budget precision",
  );
export const ModelBillingConfirmSchema = z
  .object({
    commandId: z.uuid(),
    expectedFingerprint: Checksum,
    amountUsd: ConfirmedUsd,
    currency: z.literal("USD"),
    evidenceKind: z.enum(["provider_invoice", "provider_usage", "provider_support"]),
    invoiceReference: Reference,
    providerRequestId: z
      .string()
      .trim()
      .min(1)
      .max(512)
      .refine(
        (value) => !Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127),
      ),
    proofChecksum: Checksum,
    matchesOriginalRequest: z.literal(true),
  })
  .strict();
export const ModelBillingBudgetImpactSchema = z
  .object({
    ledgerId: z.uuidv7(),
    beforeState: z.enum(["reserved", "committed", "released"]).nullable(),
    beforeAmountUsd: z.string().nullable(),
    afterState: z.literal("committed"),
    afterAmountUsd: z.string().regex(/^\d{1,8}\.\d{6}$/),
    periodStartedAt: z.iso.datetime(),
  })
  .strict();
export const ModelBillingReceiptViewSchema = ModelBillingAcknowledgmentSchema.extend({
  owner: ModelBillingConfirmOwnerSchema,
  subjectId: z.uuidv7(),
  evidenceKind: z.enum(["provider_invoice", "provider_usage", "provider_support"]),
  invoiceReference: Reference,
  providerRequestId: z.string().min(1).max(512),
  previousId: z.uuidv7().nullable(),
  budgetImpact: ModelBillingBudgetImpactSchema.nullable(),
}).strict();
export const ModelBillingBasisSchema = z
  .object({
    owner: ModelBillingOwnerSchema,
    subjectId: z.uuidv7(),
    fingerprint: Checksum,
    modelLabel: z.string().max(512),
    state: z.string().max(80),
    createdAt: z.iso.datetime(),
    providerRequestId: z.string().max(512).nullable(),
    canConfirm: z.boolean(),
    blockers: z.array(z.string().max(240)).max(8),
    originalInvocation: HarnessInvocationViewSchema.nullable(),
    history: z.array(ModelBillingReceiptViewSchema).max(20),
    hasMoreHistory: z.boolean(),
    officialPriceCheck: OfficialApiPriceCheckSchema.optional(),
  })
  .strict();
export const ModelBillingCursorSchema = z
  .object({ at: z.iso.datetime(), id: z.uuidv7(), owner: ModelBillingOwnerSchema })
  .strict();
export const ModelBillingListQuerySchema = z
  .object({
    after: z
      .string()
      .max(500)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
    scope: z.enum(["unreconciled", "all"]).default("unreconciled"),
  })
  .strict();
export const ModelBillingWorkspaceSchema = z
  .object({
    nextCursor: z.string().nullable(),
    officialPriceCatalog: OfficialApiPriceCatalogSchema.optional(),
    items: z
      .array(
        z
          .object({
            owner: ModelBillingOwnerSchema,
            id: z.uuidv7(),
            state: z.string(),
            createdAt: z.iso.datetime(),
            modelLabel: z.string().max(512),
            reconciled: z.boolean(),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();
export type ModelBillingConfirm = z.infer<typeof ModelBillingConfirmSchema>;
export type ModelBillingOwner = z.infer<typeof ModelBillingOwnerSchema>;
export type ModelBillingBasis = z.infer<typeof ModelBillingBasisSchema>;
export type ModelBillingReceiptView = z.infer<typeof ModelBillingReceiptViewSchema>;
export type ModelBillingBudgetImpact = z.infer<typeof ModelBillingBudgetImpactSchema>;
export type ModelBillingWorkspace = z.infer<typeof ModelBillingWorkspaceSchema>;
