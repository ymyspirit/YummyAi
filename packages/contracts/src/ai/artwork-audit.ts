import { z } from "zod";
import type { ProductionEditorPreflight } from "../pod/production-editor.js";

export const ARTWORK_AUDIT_POLICY = "pillow-review-2026-09-20-v1" as const;
export const ArtworkAuditCodeSchema = z.enum(["physicalSize", "visualReview", "narrowParts", "whiteBorderRule", "barcodeTab", "backText"]);
export const ArtworkAuditStatusSchema = z.enum(["passed", "failed", "needs_review"]);
export const ArtworkAuditMarkSchema = z.object({
  sourceId: z.string().min(1).max(180), label: z.string().min(1).max(160),
  x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().positive().max(1), height: z.number().positive().max(1),
}).strict().refine(v => v.x + v.width <= 1.001 && v.y + v.height <= 1.001, "Mark must stay inside the image");
export const ArtworkAuditCheckSchema = z.object({
  code: ArtworkAuditCodeSchema, title: z.string().min(1).max(100), status: ArtworkAuditStatusSchema,
  method: z.enum(["measurement", "vision", "factory"]), detail: z.string().min(1).max(2000),
  action: z.string().max(1000), evidence: z.array(z.string().min(1).max(1000)).max(20),
  marks: z.array(ArtworkAuditMarkSchema).max(8).default([]),
}).strict();
export const ArtworkVisualCheckSchema = z.object({
  code: z.enum(["visualReview", "narrowParts", "backText"]), status: ArtworkAuditStatusSchema,
  detail: z.string().min(1).max(2000), action: z.string().max(1000),
  evidence: z.array(z.object({ sourceId: z.string().min(1).max(180), detail: z.string().min(1).max(500) }).strict()).max(12),
  marks: z.array(ArtworkAuditMarkSchema).max(8),
}).strict();
export const ArtworkAuditBasisSchema = z.object({
  policy: z.literal(ARTWORK_AUDIT_POLICY), orderLineId: z.uuidv7(), revision: z.int().positive(),
  projectId: z.uuidv7(), versionId: z.uuidv7(), versionNumber: z.int().positive(), documentHash: z.string().regex(/^[a-f0-9]{64}$/),
  sourceVersionId: z.uuidv7().nullable(), factoryStandardId: z.string().nullable(), ruleBasis: z.string(),
  checks: z.array(ArtworkAuditCheckSchema).length(6),
}).strict();
export const ArtworkAuditReportSchema = ArtworkAuditBasisSchema.extend({
  complete: z.boolean(), checks: z.array(ArtworkAuditCheckSchema).length(6),
}).strict();
export type ArtworkAuditCode = z.infer<typeof ArtworkAuditCodeSchema>;
export type ArtworkAuditCheck = z.infer<typeof ArtworkAuditCheckSchema>;
export type ArtworkVisualCheck = z.infer<typeof ArtworkVisualCheckSchema>;
export type ArtworkAuditBasis = z.infer<typeof ArtworkAuditBasisSchema>;
export type ArtworkAuditReport = z.infer<typeof ArtworkAuditReportSchema>;

const manualCodes: Record<ArtworkAuditCode, string> = {
  physicalSize: "physical_size_unconfirmed", visualReview: "visual_review_required",
  narrowParts: "narrow_parts_unconfirmed", whiteBorderRule: "white_border_unconfirmed",
  barcodeTab: "barcode_rule_unconfirmed", backText: "back_text_unconfirmed",
};
/** Server callers must load trusted, current evidence. Never accept a report from
 * a render/save request. This does not modify human confirmation or approval. */
export function applyArtworkAudit(preflight: ProductionEditorPreflight, report: ArtworkAuditReport | null | undefined): ProductionEditorPreflight {
  if (!report) return preflight;
  const parsed = ArtworkAuditReportSchema.safeParse(report);
  if (!parsed.success || new Set(report.checks.map(c => c.code)).size !== 6) return preflight;
  const covered = new Set(report.complete ? report.checks.filter(c => c.status === "passed").map(c => manualCodes[c.code]) : []);
  const issues = preflight.issues.filter(i => !(i.severity === "manual" && covered.has(i.code)));
  for (const check of report.checks) {
    if (report.complete && check.status === "passed") continue;
    // Replace a generic checkbox reminder with the concrete result. Hard errors stay.
    const index = issues.findIndex(i => i.severity === "manual" && i.code === manualCodes[check.code]);
    if (index >= 0) issues.splice(index, 1);
    issues.push({ code: `artwork_audit_${check.code}`, severity: check.status === "failed" ? "error" : "manual",
      message: `${check.title}：${report.complete || check.status !== "passed" ? check.detail : "自动核对尚未完成。"}${check.action ? ` ${check.action}` : ""}` });
  }
  return { ...preflight, issues, productionReady: !issues.some(i => i.severity !== "warning") };
}
