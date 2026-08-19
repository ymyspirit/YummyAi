import { z } from "zod";

import { EntityIdSchema } from "../common/ids.js";

export const AiTaskTypeSchema = z.enum([
  "AI-01",
  "AI-02",
  "AI-03",
  "AI-04",
  "AI-05",
  "AI-06",
  "AI-07",
  "AI-08",
]);

export const EvidenceRefSchema = z.object({
  snapshotId: EntityIdSchema,
  sourceType: z.enum(["field", "media", "review", "internal"]),
  sourcePath: z.string().min(1).max(300),
  excerpt: z.string().max(500).optional(),
});

const ClaimCoreSchema = z.object({
  id: z.string().min(1).max(80),
  text: z.string().min(1).max(2_000),
});

export const FactClaimSchema = ClaimCoreSchema.extend({
  kind: z.literal("fact"),
  evidence: z.array(EvidenceRefSchema).min(1),
});

export const InferenceClaimSchema = ClaimCoreSchema.extend({
  kind: z.literal("inference"),
  confidence: z.number().min(0).max(1),
  evidence: z.array(EvidenceRefSchema),
});

export const RecommendationClaimSchema = ClaimCoreSchema.extend({
  kind: z.literal("recommendation"),
  priority: z.enum(["low", "medium", "high"]),
  evidence: z.array(EvidenceRefSchema),
});

export const AnalysisClaimSchema = z.discriminatedUnion("kind", [
  FactClaimSchema,
  InferenceClaimSchema,
  RecommendationClaimSchema,
]);

export const AnalysisSectionSchema = z.object({
  id: z.string().min(1).max(80),
  title: z.string().min(1).max(160),
  summary: z.string().max(2_000).optional(),
  claims: z.array(AnalysisClaimSchema).min(1),
});

export const ComparisonRowSchema = z.object({
  dimension: z.string().min(1).max(120),
  values: z.record(EntityIdSchema, z.string().max(1_000)),
  evidence: z.array(EvidenceRefSchema),
});

export const AnalysisContentSchema = z.object({
  title: z.string().min(1).max(200),
  executiveSummary: z.string().min(1).max(4_000),
  sections: z.array(AnalysisSectionSchema).min(1),
  comparison: z.array(ComparisonRowSchema).optional(),
});

export const ReportModelMetadataSchema = z.object({
  providerId: z.string().min(1),
  modelKey: z.string().min(1),
  providerRequestId: z.string().optional(),
  costUsd: z.number().nonnegative(),
});

export const AnalysisReportSchema = AnalysisContentSchema.extend({
  id: EntityIdSchema,
  reportSeriesId: EntityIdSchema,
  version: z.int().positive(),
  taskType: AiTaskTypeSchema,
  status: z.enum(["completed", "failed", "cancelled"]),
  inputSnapshotIds: z.array(EntityIdSchema).min(1),
  model: ReportModelMetadataSchema,
  promptTemplateVersion: z.string().min(1).max(80),
  createdBy: EntityIdSchema,
  createdAt: z.iso.datetime(),
});

export const AnalysisRequestSchema = z.object({
  taskType: AiTaskTypeSchema,
  modelKey: z.string().min(1).max(120),
  snapshotIds: z.array(EntityIdSchema).min(1).max(50),
  reportSeriesId: EntityIdSchema.optional(),
  maxCostUsd: z.number().positive().max(100),
});

export const GeneratedImageProvenanceSchema = z.object({
  id: EntityIdSchema,
  providerId: z.string().min(1),
  modelKey: z.string().min(1),
  promptTemplateVersion: z.string().min(1),
  userPrompt: z.string().min(1).max(8_000),
  revisedPrompt: z.string().max(8_000).optional(),
  providerRequestId: z.string().optional(),
  referenceAssets: z.array(z.object({
    assetId: EntityIdSchema,
    version: z.int().positive(),
    checksumSha256: z.string().regex(/^[0-9a-f]{64}$/),
  })),
  seed: z.string().optional(),
  costUsd: z.number().nonnegative(),
  createdBy: EntityIdSchema,
  createdAt: z.iso.datetime(),
  checksumSha256: z.string().regex(/^[0-9a-f]{64}$/),
  aiGenerated: z.literal(true),
});

export type AiTaskType = z.infer<typeof AiTaskTypeSchema>;
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;
export type AnalysisClaim = z.infer<typeof AnalysisClaimSchema>;
export type AnalysisContent = z.infer<typeof AnalysisContentSchema>;
export type AnalysisReport = z.infer<typeof AnalysisReportSchema>;
export type AnalysisRequest = z.infer<typeof AnalysisRequestSchema>;
export type GeneratedImageProvenance = z.infer<typeof GeneratedImageProvenanceSchema>;
