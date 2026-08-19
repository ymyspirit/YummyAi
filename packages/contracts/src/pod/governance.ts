import { z } from "zod";

import { EntityIdSchema } from "../common/ids.js";
import { RightsSourceSchema } from "../design/design.js";
import { PodTaskParameterSnapshotSchema, PodToolKeySchema } from "./pod.js";

export * from "./personalization.js";
export * from "./order-personalization.js";
export * from "./visual-search.js";
export * from "./listing-artifacts.js";
export * from "./batch-workflows.js";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const VersionNumberSchema = z.int().positive();
const JsonSnapshotSchema = z.record(z.string(), z.unknown());

export const PodModelPolicySchema = z.object({
  providerKey: z.string().trim().min(1).max(120).optional(),
  modelKey: z.string().trim().min(1).max(200).optional(),
  modelVersion: z.string().trim().min(1).max(200).optional(),
  routingPolicyVersion: z.string().trim().min(1).max(120),
  seedMode: z.enum(["fixed", "random", "provider_managed"]),
});

export const CreateDesignRecipeVersionInputSchema = z.object({
  recipeId: EntityIdSchema.optional(),
  toolKey: PodToolKeySchema,
  parameterSnapshot: PodTaskParameterSnapshotSchema,
  modelPolicy: PodModelPolicySchema,
  promptTemplateVersion: z.string().trim().min(1).max(120).optional(),
});

export const DesignRecipeVersionSchema = CreateDesignRecipeVersionInputSchema.extend({
  id: EntityIdSchema,
  recipeId: EntityIdSchema,
  versionNumber: VersionNumberSchema,
  createdBy: EntityIdSchema.optional(),
  createdAt: z.iso.datetime(),
});

export const ArtifactRelationTypeSchema = z.enum([
  "source_to_result",
  "result_to_derivative",
  "result_to_listing",
  "result_to_template",
  "result_to_production",
]);

export const CreateArtifactRelationInputSchema = z.object({
  fromAssetId: EntityIdSchema,
  fromAssetVersion: VersionNumberSchema,
  toAssetId: EntityIdSchema,
  toAssetVersion: VersionNumberSchema,
  relationType: ArtifactRelationTypeSchema,
  taskId: EntityIdSchema.optional(),
});

export const ArtifactRelationSchema = CreateArtifactRelationInputSchema.extend({
  id: EntityIdSchema,
  createdBy: EntityIdSchema.optional(),
  createdAt: z.iso.datetime(),
});

export const RightsRiskLevelSchema = z.enum(["unknown", "low", "medium", "high"]);
export const RightsAssessmentStatusSchema = z.enum([
  "pending",
  "review_required",
  "approved",
  "blocked",
  "rejected",
]);
export const RightsEvidenceSchema = z.object({
  kind: z.enum(["trademark_registry", "tro_record", "copyright_registry", "license", "web", "internal"]),
  reference: z.string().trim().min(1).max(1_000),
  title: z.string().trim().min(1).max(500).optional(),
  checkedAt: z.iso.datetime(),
  accessible: z.boolean().optional(),
  sourceVersion: z.string().trim().min(1).max(160).optional(),
  contentHashSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});

const RightsAssessmentInputBaseSchema = z.object({
  assetId: EntityIdSchema,
  assetVersion: VersionNumberSchema,
  taskId: EntityIdSchema.optional(),
  supersedesAssessmentId: EntityIdSchema.optional(),
  rightsSource: RightsSourceSchema.optional(),
  scopeSnapshot: JsonSnapshotSchema,
  status: RightsAssessmentStatusSchema,
  legalRisk: RightsRiskLevelSchema,
  visualSimilarityPermille: z.int().min(0).max(1_000).optional(),
  evidence: z.array(RightsEvidenceSchema).max(200),
  modelKey: z.string().trim().min(1).max(200).optional(),
  modelVersion: z.string().trim().min(1).max(200).optional(),
  decisionReason: z.string().trim().min(1).max(2_000).optional(),
});

function validateRightsAssessment(value: z.infer<typeof RightsAssessmentInputBaseSchema>, context: z.RefinementCtx) {
  if (value.legalRisk === "high" && value.status !== "blocked" && value.status !== "rejected") {
    context.addIssue({ code: "custom", path: ["status"], message: "High legal risk must remain blocked or rejected" });
  }
  if (value.status === "approved" && value.legalRisk !== "low") {
    context.addIssue({ code: "custom", path: ["legalRisk"], message: "Only low legal risk can be approved" });
  }
}

export const CreateRightsAssessmentInputSchema = RightsAssessmentInputBaseSchema.superRefine(validateRightsAssessment);

export const RightsAssessmentSchema = RightsAssessmentInputBaseSchema.extend({
  id: EntityIdSchema,
  assessedBy: EntityIdSchema.optional(),
  assessedAt: z.iso.datetime(),
}).superRefine(validateRightsAssessment);

export const VisualIndexStatusSchema = z.enum(["pending", "indexed", "failed", "removed"]);
export const CreateVisualFingerprintInputSchema = z.object({
  assetId: EntityIdSchema,
  assetVersion: VersionNumberSchema,
  checksumSha256: Sha256Schema,
  perceptualHash: z.string().regex(/^[a-f0-9]{16,128}$/).optional(),
  fingerprintAlgorithm: z.string().trim().min(1).max(120),
  fingerprintVersion: z.string().trim().min(1).max(120),
  indexStatus: VisualIndexStatusSchema,
  vectorIndexReference: z.string().trim().min(1).max(500).optional(),
});

export const VisualFingerprintSchema = CreateVisualFingerprintInputSchema.extend({
  id: EntityIdSchema,
  createdAt: z.iso.datetime(),
  removedAt: z.iso.datetime().optional(),
});

export type PodModelPolicy = z.infer<typeof PodModelPolicySchema>;
export type CreateDesignRecipeVersionInput = z.infer<typeof CreateDesignRecipeVersionInputSchema>;
export type DesignRecipeVersion = z.infer<typeof DesignRecipeVersionSchema>;
export type ArtifactRelationType = z.infer<typeof ArtifactRelationTypeSchema>;
export type CreateArtifactRelationInput = z.infer<typeof CreateArtifactRelationInputSchema>;
export type ArtifactRelation = z.infer<typeof ArtifactRelationSchema>;
export type RightsRiskLevel = z.infer<typeof RightsRiskLevelSchema>;
export type RightsAssessmentStatus = z.infer<typeof RightsAssessmentStatusSchema>;
export type CreateRightsAssessmentInput = z.infer<typeof CreateRightsAssessmentInputSchema>;
export type RightsAssessment = z.infer<typeof RightsAssessmentSchema>;
export type VisualIndexStatus = z.infer<typeof VisualIndexStatusSchema>;
export type CreateVisualFingerprintInput = z.infer<typeof CreateVisualFingerprintInputSchema>;
export type VisualFingerprint = z.infer<typeof VisualFingerprintSchema>;
