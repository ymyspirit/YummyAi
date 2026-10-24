import { z } from "zod";
import { EntityIdSchema as Id } from "@yummyai/contracts/common/ids";
import { ProductionPhysicalQuantitiesSchema } from "@yummyai/contracts/order/production-quantity";

const Fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const Count = z.int().min(0).max(100_000);
export const FactoryPortalSessionViewSchema = z.object({
  authenticated: z.literal(true), contextAuthority: Fingerprint, canRead: z.boolean(), canRespond: z.boolean(),
}).strict().refine(value => !value.canRespond || value.canRead, { message: "工厂响应权限须保留本人任务读取权限" });

/** Authority is an opaque response stamp, never a bearer credential or caller-selected scope. */
const Authority = { assignmentId: Id, contextAuthority: Fingerprint, taskFingerprint: Fingerprint,
  access: z.object({ canRead: z.literal(true), canReport: z.boolean() }).strict() };
export const FactoryQuantityReportInputSchema = z.object({
  idempotencyKey: z.uuid(), fileChecksum: Fingerprint, manufacturingChecksum: Fingerprint,
  acceptedFeedbackId: Id, expectedBasisFingerprint: Fingerprint, wholeProductionConfirmed: z.literal(true),
  observedAt: z.iso.datetime(), quantities: ProductionPhysicalQuantitiesSchema,
  evidenceCode: z.string().regex(/^[A-Z0-9_:-]{1,160}$/), reference: z.string().trim().min(1).max(200),
}).strict();
export const FactoryQuantityBasisSchema = z.object({
  scope: z.literal("full_production_version"), quantity: z.int().positive(), unit: z.enum(["each", "pair", "set"]).nullable(),
  versionNumber: z.int().positive(), fileChecksum: Fingerprint, manufacturingChecksum: Fingerprint.nullable(),
  acceptedFeedbackId: Id.nullable(), stoppedQuantity: Count, approvedQuantities: ProductionPhysicalQuantitiesSchema.nullable(),
  fingerprint: Fingerprint, blockers: z.array(z.string().min(1).max(1000)).max(100),
}).strict().superRefine((value, context) => {
  if (value.stoppedQuantity > value.quantity) context.addIssue({ code: "custom", path: ["stoppedQuantity"], message: "核准停做量不能超过本任务原数量" });
  if (value.approvedQuantities && Object.values(value.approvedQuantities).every(count => count !== null) &&
      Object.values(value.approvedQuantities).reduce<number>((sum, count) => sum + (count ?? 0), 0) + value.stoppedQuantity !== value.quantity)
    context.addIssue({ code: "custom", path: ["approvedQuantities"], message: "运营核准实物与已停做量须覆盖原数量" });
});
export const FactoryQuantityReportViewSchema = z.object({
  reportId: Id, assignmentId: Id, origin: z.literal("factory"), scope: z.literal("full_production_version"),
  input: FactoryQuantityReportInputSchema, recordedAt: z.iso.datetime(),
}).strict();
export const FactoryQuantityHistoryEntrySchema = FactoryQuantityReportViewSchema.extend({ reviewedAt: z.iso.datetime().nullable() });
export const FactoryQuantityHistoryQuerySchema = z.object({ before: Id.optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }).strict();
export const FactoryQuantityWorkspaceSchema = z.object({ ...Authority, basis: FactoryQuantityBasisSchema,
  reports: z.array(FactoryQuantityHistoryEntrySchema).max(50), nextCursor: Id.nullable(),
}).strict().superRefine((value, context) => {
  if (value.reports.some(report => report.assignmentId !== value.assignmentId))
    context.addIssue({ code: "custom", path: ["reports"], message: "工厂清点历史须属于本次原任务" });
  if (value.access.canReport && (value.basis.blockers.length > 0 || !value.basis.acceptedFeedbackId || !value.basis.manufacturingChecksum || !value.basis.unit))
    context.addIssue({ code: "custom", path: ["access"], message: "工厂报告须有本人接受和明确的原制造数量依据" });
});
export const FactoryQuantityReportResultSchema = z.object({ ...Authority, report: FactoryQuantityReportViewSchema, replayed: z.boolean() }).strict()
  .refine(value => value.report.assignmentId === value.assignmentId, { path: ["report"], message: "报告回执须属于本次原任务" });
export const FactoryQuantityAccessViewSchema = z.object(Authority).strict();
export type FactoryQuantityReportInput = z.infer<typeof FactoryQuantityReportInputSchema>;
export type FactoryQuantityWorkspace = z.infer<typeof FactoryQuantityWorkspaceSchema>;
export type FactoryQuantityReportView = z.infer<typeof FactoryQuantityReportViewSchema>;
export type FactoryQuantityReportResult = z.infer<typeof FactoryQuantityReportResultSchema>;
