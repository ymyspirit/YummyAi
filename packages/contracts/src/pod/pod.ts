import { z } from "zod";

export const PodModuleKeySchema = z.enum([
  "print_extraction",
  "print_design",
  "pattern_processing",
  "rights_risk",
  "listing_assets",
  "personalization",
  "production_artwork",
]);

export const PodPhaseSchema = z.enum(["pod_1", "pod_2", "pod_3"]);
export const PodToolAvailabilitySchema = z.enum([
  "definition_ready",
  "implementation_active",
  "enabled",
  "unavailable",
]);
export const PodAssetPolicySchema = z.enum([
  "authorized_only",
  "risk_evidence_allowed",
  "order_context_only",
]);
export const PodInputKindSchema = z.enum([
  "image",
  "text",
  "template",
  "vector",
  "psd",
  "order_customization",
]);
export const PodOutputKindSchema = z.enum([
  "image",
  "text",
  "transparent_image",
  "vector",
  "video",
  "template",
  "risk_report",
  "production_package",
]);

export const PodToolKeySchema = z.enum([
  "pattern_crop",
  "print_extract",
  "design_variation",
  "product_print_variation",
  "instruction_edit",
  "text_to_image",
  "element_fusion",
  "licensed_brand_fusion",
  "series_design",
  "style_reference",
  "style_transfer",
  "canvas_extend",
  "seamless_pattern",
  "seamless_stitch",
  "print_composite",
  "meme_print",
  "background_remove",
  "super_resolution",
  "outpaint",
  "crop_compress",
  "vectorize",
  "authorized_watermark_remove",
  "rights_risk_scan",
  "product_suite",
  "title_draft",
  "virtual_try_on",
  "background_replace",
  "product_video",
  "image_composite",
  "group_photo",
  "pet_outfit",
  "personalization_template",
  "piece_extract",
  "piece_compose",
  "uv_layers",
  "fulfillment_composite",
  "vector_fulfillment",
]);

export const PodSupportCapabilityKeySchema = z.enum([
  "task_center",
  "asset_space",
  "visual_search",
  "print_trace_search",
]);

export const PodP1ExecutableToolKeySchema = z.enum([
  "pattern_crop",
  "print_extract",
  "background_remove",
  "super_resolution",
  "outpaint",
  "crop_compress",
  "vectorize",
  "authorized_watermark_remove",
  "rights_risk_scan",
]);

export const PodP2ExecutableToolKeySchema = z.enum([
  "design_variation",
  "product_print_variation",
  "instruction_edit",
  "text_to_image",
  "element_fusion",
  "licensed_brand_fusion",
  "series_design",
  "style_reference",
  "style_transfer",
  "canvas_extend",
  "seamless_pattern",
  "seamless_stitch",
  "print_composite",
  "meme_print",
  "product_suite",
  "title_draft",
  "virtual_try_on",
  "background_replace",
]);

export const PodP3ExecutableToolKeySchema = z.enum([
  "product_video",
  "piece_extract",
  "piece_compose",
  "uv_layers",
]);

export const PodExecutableToolKeySchema = z.enum([
  ...PodP1ExecutableToolKeySchema.options,
  ...PodP2ExecutableToolKeySchema.options,
  ...PodP3ExecutableToolKeySchema.options,
]);

export const PodTaskStatusSchema = z.enum([
  "queued",
  "running",
  "awaiting_review",
  "partially_succeeded",
  "failed",
  "blocked",
  "approved",
  "rejected",
  "cancelled",
]);

export const PodTaskParameterValueSchema = z.union([
  z.string().max(8_000),
  z.number().finite(),
  z.boolean(),
  z.array(z.string().max(240)).max(100),
]);

export const PodTaskParameterSnapshotSchema = z.record(
  z.string().regex(/^[a-z][a-zA-Z0-9_]{0,63}$/),
  PodTaskParameterValueSchema,
).superRefine((snapshot, context) => {
  if (Object.keys(snapshot).length > 24) {
    context.addIssue({ code: "custom", message: "POD task parameter snapshots support at most 24 fields" });
  }
});

export const PatternCropParameterSnapshotSchema = z.object({
  mode: z.enum(["general", "metal_sign", "decorative_art"]),
  multiCrop: z.boolean(),
  maximumCropsPerInput: z.number().int().min(1).max(8),
  outputFormat: z.enum(["png", "jpeg"]),
  background: z.enum(["preserved", "transparent", "white"]),
  perspectiveCorrection: z.literal(true),
  cropPaddingPercent: z.number().min(0).max(20),
  resultLabel: z.string().trim().min(1).max(80).optional(),
}).strict().superRefine((value, context) => {
  if (!value.multiCrop && value.maximumCropsPerInput !== 1) {
    context.addIssue({ code: "custom", path: ["maximumCropsPerInput"], message: "Single-crop tasks must request exactly one crop per input" });
  }
  if (value.background === "transparent" && value.outputFormat !== "png") {
    context.addIssue({ code: "custom", path: ["outputFormat"], message: "Transparent crop output requires PNG" });
  }
});

export const NormalizedCropBoundsSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().positive().max(1),
  height: z.number().positive().max(1),
}).strict().superRefine((value, context) => {
  if (value.x + value.width > 1.000001 || value.y + value.height > 1.000001) {
    context.addIssue({ code: "custom", message: "Normalized crop bounds must remain inside the source image" });
  }
});

export const PatternCropOutputCheckSchema = z.object({
  fileName: z.string().trim().min(1).max(180),
  inputOrdinal: z.number().int().min(0).max(99),
  cropIndex: z.number().int().min(0).max(7),
  sourceBounds: NormalizedCropBoundsSchema,
  outputWidth: z.number().int().positive().max(100_000),
  outputHeight: z.number().int().positive().max(100_000),
  transparent: z.boolean(),
  perspectiveCorrectionValidated: z.literal(true),
  cropComplete: z.literal(true),
  resultLabel: z.string().trim().min(1).max(80).optional(),
}).strict();

export const PatternCropQualityCheckSnapshotSchema = z.object({
  passed: z.literal(true),
  mode: z.enum(["general", "metal_sign", "decorative_art"]),
  inputCoverageComplete: z.literal(true),
  cropBoundsValid: z.literal(true),
  blankOutputsDetected: z.literal(false),
  duplicateOutputsDetected: z.literal(false),
  outputChecks: z.array(PatternCropOutputCheckSchema).min(1).max(800),
  processorDeploymentId: z.string().trim().min(1).max(160).optional(),
}).strict();

export const PrintExtractParameterSnapshotSchema = z.object({
  mode: z.enum(["specialized", "all_purpose", "transparent"]),
  targetScenario: z.enum(["auto", "apparel", "phone_case", "cup", "home_textile", "clock", "wind_chime", "tablecloth", "other"]),
  correctionStrength: z.enum(["standard", "strong"]),
  restoreOccludedAreas: z.boolean(),
  markInferredAreas: z.literal(true),
  outputFormat: z.enum(["png", "jpeg"]),
  outputBackground: z.enum(["original", "transparent"]),
  minimumCompleteness: z.number().min(0.5).max(1),
}).strict().superRefine((value, context) => {
  if (value.mode === "transparent" && (value.outputFormat !== "png" || value.outputBackground !== "transparent")) {
    context.addIssue({ code: "custom", path: ["outputFormat"], message: "Transparent extraction requires transparent PNG output" });
  }
  if (value.outputBackground === "transparent" && value.outputFormat !== "png") {
    context.addIssue({ code: "custom", path: ["outputFormat"], message: "Transparent backgrounds require PNG output" });
  }
});

export const PrintExtractInferenceRegionSchema = z.object({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  reason: z.enum(["occlusion", "fold", "crop_loss", "perspective_gap"]),
  confidence: z.number().min(0).max(1),
  marked: z.literal(true),
}).strict();

export const PrintExtractOutputCheckSchema = z.object({
  fileName: z.string().trim().min(1).max(180),
  inputOrdinal: z.number().int().min(0).max(99),
  width: z.number().int().positive().max(100_000),
  height: z.number().int().positive().max(100_000),
  transparent: z.boolean(),
  perspectiveCorrectionValidated: z.literal(true),
  deformationCorrectionValidated: z.literal(true),
  cropCoverageComplete: z.literal(true),
  completeness: z.number().min(0).max(1),
  inferredRegions: z.array(PrintExtractInferenceRegionSchema).max(100),
}).strict();

export const PrintExtractQualityCheckSnapshotSchema = z.object({
  passed: z.literal(true),
  mode: z.enum(["specialized", "all_purpose", "transparent"]),
  inputCoverageComplete: z.literal(true),
  aiInferencePresent: z.boolean(),
  inferredAreasMarked: z.literal(true),
  blankOutputsDetected: z.literal(false),
  duplicateOutputsDetected: z.literal(false),
  outputChecks: z.array(PrintExtractOutputCheckSchema).min(1).max(100),
  processorDeploymentId: z.string().trim().min(1).max(160).optional(),
}).strict();

export const BackgroundRemoveParameterSnapshotSchema = z.object({
  edgeRefinement: z.boolean(),
  preserveShadow: z.boolean(),
  outputFormat: z.literal("png"),
}).strict();

export const SuperResolutionParameterSnapshotSchema = z.object({
  scale: z.union([z.literal(2), z.literal(4)]),
  dpi: z.number().int().min(72).max(1_200),
  denoise: z.number().int().min(0).max(100),
  sharpen: z.number().int().min(0).max(100),
  outputFormat: z.enum(["png", "jpeg", "webp", "tiff"]),
}).strict();

export const OutpaintParameterSnapshotSchema = z.object({
  aspectRatio: z.enum(["1:1", "4:5", "3:4", "16:9"]),
  direction: z.enum(["all", "horizontal", "vertical"]),
  prompt: z.string().trim().min(1).max(8_000).optional(),
  outputFormat: z.enum(["png", "jpeg"]),
  markGeneratedAreas: z.literal(true),
}).strict();

export const CropCompressParameterSnapshotSchema = z.object({
  width: z.number().int().positive().max(30_000),
  height: z.number().int().positive().max(30_000),
  quality: z.number().int().min(1).max(100),
  dpi: z.number().int().min(72).max(1_200),
  format: z.enum(["png", "jpeg", "webp", "tiff"]),
  colorSpace: z.enum(["rgb", "cmyk"]),
  preserveTransparency: z.boolean(),
}).strict().superRefine((value, context) => {
  if (value.preserveTransparency && value.format !== "png" && value.format !== "webp" && value.format !== "tiff") {
    context.addIssue({ code: "custom", path: ["preserveTransparency"], message: "JPEG cannot preserve transparency" });
  }
});

export const VectorizeParameterSnapshotSchema = z.object({
  format: z.enum(["svg", "eps"]),
  colorCount: z.number().int().min(1).max(256),
  smoothing: z.boolean(),
  closePaths: z.boolean(),
  colorMode: z.enum(["rgb", "spot"]),
}).strict();

export const AuthorizedWatermarkRemoveParameterSnapshotSchema = z.object({
  rightsAttested: z.literal(true),
  regionDescription: z.string().trim().min(1).max(500),
  outputFormat: z.enum(["png", "jpeg"]),
  markInferredAreas: z.literal(true),
}).strict();

export const PatternProcessingGeneratedRegionSchema = z.object({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  reason: z.enum(["enhancement", "occlusion", "fold", "crop_loss", "perspective_gap", "background"]),
  confidence: z.number().min(0).max(1),
  marked: z.literal(true),
}).strict();

export const PatternProcessingOutputCheckSchema = z.object({
  fileName: z.string().trim().min(1).max(180),
  inputOrdinal: z.number().int().min(0).max(99),
  operation: z.enum(["background_remove", "super_resolution", "outpaint", "crop_compress", "vectorize", "authorized_watermark_remove"]),
  format: z.enum(["png", "jpeg", "webp", "tiff", "svg", "eps"]),
  width: z.number().int().positive().max(100_000),
  height: z.number().int().positive().max(100_000),
  dpi: z.number().int().min(36).max(2_400).optional(),
  colorMode: z.enum(["rgb", "cmyk", "spot"]),
  transparent: z.boolean(),
  sourceWidth: z.number().int().positive().max(100_000).optional(),
  sourceHeight: z.number().int().positive().max(100_000).optional(),
  pathCount: z.number().int().positive().max(1_000_000).optional(),
  pathsClosed: z.boolean().optional(),
  generatedRegions: z.array(PatternProcessingGeneratedRegionSchema).max(100),
  edgeQualityPassed: z.literal(true),
  dimensionsMatched: z.literal(true),
  formatMatched: z.literal(true),
}).strict();

export const PatternProcessingQualityCheckSnapshotSchema = z.object({
  passed: z.literal(true),
  toolKey: z.enum(["background_remove", "super_resolution", "outpaint", "crop_compress", "vectorize", "authorized_watermark_remove"]),
  inputCoverageComplete: z.literal(true),
  blankOutputsDetected: z.literal(false),
  artifactDetected: z.literal(false),
  generatedAreasMarked: z.literal(true),
  outputChecks: z.array(PatternProcessingOutputCheckSchema).min(1).max(100),
  processorDeploymentId: z.string().trim().min(1).max(160).optional(),
}).strict();

export const RightsRiskScanParameterSnapshotSchema = z.object({
  depth: z.enum(["basic", "deep"]),
  visualSimilarity: z.boolean(),
  marketplaces: z.array(z.enum(["amazon", "etsy"])).min(1).max(2).refine((items) => new Set(items).size === items.length, "Marketplace scope must be unique"),
  searchTerms: z.array(z.string().trim().min(1).max(240)).max(50),
  validityDays: z.number().int().min(1).max(90),
}).strict();

export const RightsRiskReportLevelSchema = z.enum(["unknown", "low", "medium", "high"]);

export const RightsRiskReportEvidenceSchema = z.object({
  evidenceId: z.string().trim().regex(/^[a-z][a-z0-9_.-]{0,79}$/),
  kind: z.enum(["trademark_registry", "hot_ip", "tro_record", "copyright_registry", "license", "web", "internal"]),
  reference: z.string().trim().min(1).max(1_000),
  title: z.string().trim().min(1).max(500).optional(),
  checkedAt: z.iso.datetime(),
  accessible: z.boolean(),
  contentHashSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();

export const RightsRiskSourceCheckSchema = z.object({
  sourceKey: z.string().trim().regex(/^[a-z][a-z0-9_.-]{0,79}$/),
  sourceVersion: z.string().trim().min(1).max(160),
  checkedAt: z.iso.datetime(),
  status: z.enum(["complete", "unavailable"]),
}).strict();

export const RightsRiskRuleHitSchema = z.object({
  ruleKey: z.string().trim().regex(/^[a-z][a-z0-9_.-]{0,79}$/),
  category: z.enum(["trademark", "hot_ip", "tro", "copyright", "license_scope", "restricted_term", "internal_case"]),
  label: z.string().trim().min(1).max(240),
  severity: z.enum(["low", "medium", "high"]),
  evidenceIds: z.array(z.string().trim().regex(/^[a-z][a-z0-9_.-]{0,79}$/)).max(50),
}).strict();

export const RightsRiskOutputCheckSchema = z.object({
  fileName: z.string().trim().min(1).max(180),
  inputOrdinal: z.number().int().min(0).max(99),
  legalRisk: RightsRiskReportLevelSchema,
  confidence: z.number().min(0).max(1),
  ruleHits: z.array(RightsRiskRuleHitSchema).max(200),
  evidence: z.array(RightsRiskReportEvidenceSchema).max(200),
  visualSimilarityEvaluated: z.boolean(),
  visualSimilarityPermille: z.number().int().min(0).max(1_000).optional(),
  visualCandidateCount: z.number().int().nonnegative().max(10_000),
  manualReviewRequired: z.literal(true),
  downstreamBlocked: z.boolean(),
}).strict().superRefine((value, context) => {
  if ((value.legalRisk === "high" || value.legalRisk === "unknown") !== value.downstreamBlocked) {
    context.addIssue({ code: "custom", path: ["downstreamBlocked"], message: "High and unknown legal risk must remain blocked" });
  }
  if (value.legalRisk === "high" && !value.ruleHits.length && !value.evidence.length) {
    context.addIssue({ code: "custom", path: ["evidence"], message: "High legal risk requires evidence or a rule hit" });
  }
  if (!value.visualSimilarityEvaluated && (value.visualSimilarityPermille !== undefined || value.visualCandidateCount !== 0)) {
    context.addIssue({ code: "custom", path: ["visualSimilarityPermille"], message: "Visual similarity evidence must remain separate and absent when not evaluated" });
  }
  const evidenceIds = new Set(value.evidence.map((entry) => entry.evidenceId));
  if (value.ruleHits.some((hit) => hit.evidenceIds.some((id) => !evidenceIds.has(id)))) {
    context.addIssue({ code: "custom", path: ["ruleHits"], message: "Every rule-hit evidence reference must resolve inside the report" });
  }
});

export const RightsRiskQualityCheckSnapshotSchema = z.object({
  passed: z.literal(true),
  depth: z.enum(["basic", "deep"]),
  disclaimer: z.literal("auxiliary_non_legal_opinion"),
  checkedAt: z.iso.datetime(),
  validUntil: z.iso.datetime(),
  ruleVersion: z.string().trim().min(1).max(160),
  detectorModelKey: z.string().trim().min(1).max(200),
  detectorModelVersion: z.string().trim().min(1).max(200),
  sourceChecks: z.array(RightsRiskSourceCheckSchema).min(1).max(100),
  missingSourceKeys: z.array(z.string().trim().regex(/^[a-z][a-z0-9_.-]{0,79}$/)).max(100),
  inputCoverageComplete: z.literal(true),
  highRiskDetected: z.boolean(),
  unknownRiskDetected: z.boolean(),
  outputChecks: z.array(RightsRiskOutputCheckSchema).min(1).max(100),
  processorDeploymentId: z.string().trim().min(1).max(160).optional(),
}).strict().superRefine((value, context) => {
  if (new Date(value.validUntil).getTime() <= new Date(value.checkedAt).getTime()) {
    context.addIssue({ code: "custom", path: ["validUntil"], message: "Risk report expiry must be after its check time" });
  }
  if (value.highRiskDetected !== value.outputChecks.some((check) => check.legalRisk === "high")) {
    context.addIssue({ code: "custom", path: ["highRiskDetected"], message: "High-risk summary must match per-input reports" });
  }
  if (value.unknownRiskDetected !== value.outputChecks.some((check) => check.legalRisk === "unknown")) {
    context.addIssue({ code: "custom", path: ["unknownRiskDetected"], message: "Unknown-risk summary must match per-input reports" });
  }
  const unavailable = value.sourceChecks.filter((source) => source.status === "unavailable").map((source) => source.sourceKey);
  if (!sameStringMembers(unavailable, value.missingSourceKeys)) {
    context.addIssue({ code: "custom", path: ["missingSourceKeys"], message: "Missing sources must match unavailable source checks" });
  }
  if (unavailable.length && !value.unknownRiskDetected) {
    context.addIssue({ code: "custom", path: ["unknownRiskDetected"], message: "Unavailable sources cannot be reported as a conclusive risk level" });
  }
});

export const RightsRiskReportFileSchema = z.object({
  inputOrdinal: z.number().int().min(0).max(99),
  legalRisk: RightsRiskReportLevelSchema,
  checkedAt: z.iso.datetime(),
  disclaimer: z.literal("auxiliary_non_legal_opinion"),
  evidenceCount: z.number().int().nonnegative().max(200),
  visualSimilarityPermille: z.number().int().min(0).max(1_000).optional(),
}).strict();

export const CreativeDesignToolKeySchema = z.enum([
  "design_variation",
  "product_print_variation",
  "instruction_edit",
  "text_to_image",
  "element_fusion",
  "licensed_brand_fusion",
  "series_design",
  "style_reference",
  "style_transfer",
  "canvas_extend",
  "seamless_pattern",
  "seamless_stitch",
  "print_composite",
  "meme_print",
]);

export const CreativeDesignParameterSnapshotSchema = z.object({
  designTool: CreativeDesignToolKeySchema,
  prompt: z.string().trim().max(8_000),
  referenceStrength: z.number().int().min(0).max(100),
  creativity: z.number().int().min(0).max(100),
  aspectRatio: z.enum(["1:1", "4:5", "3:4", "16:9"]),
  outputCount: z.number().int().min(1).max(16),
  outputFormat: z.literal("png"),
  markAiGenerated: z.boolean(),
  markGeneratedAreas: z.literal(true),
  rightsAttested: z.literal(true).optional(),
  licenseReference: z.string().trim().min(1).max(500).optional(),
  batchPrompts: z.array(z.string().trim().min(1).max(240)).max(100).optional(),
  repeatType: z.enum(["four_way", "two_way"]).optional(),
  seamCheckRequired: z.literal(true).optional(),
  tilePreviewRequired: z.literal(true).optional(),
}).strict().superRefine((value, context) => {
  if (value.designTool === "text_to_image" && !value.prompt) {
    context.addIssue({ code: "custom", path: ["prompt"], message: "Text-to-image requires a prompt" });
  }
  if (value.designTool === "licensed_brand_fusion" && (!value.rightsAttested || !value.licenseReference)) {
    context.addIssue({ code: "custom", path: ["licenseReference"], message: "Licensed brand fusion requires attestation and a license reference" });
  }
  if (value.designTool !== "licensed_brand_fusion" && (value.rightsAttested !== undefined || value.licenseReference !== undefined)) {
    context.addIssue({ code: "custom", path: ["rightsAttested"], message: "License evidence is only accepted by licensed brand fusion" });
  }
  if (value.designTool === "series_design" && !value.batchPrompts?.length) {
    context.addIssue({ code: "custom", path: ["batchPrompts"], message: "Series design requires at least one series prompt" });
  }
  if (value.designTool !== "series_design" && value.batchPrompts !== undefined) {
    context.addIssue({ code: "custom", path: ["batchPrompts"], message: "Batch prompts are only accepted by series design" });
  }
  const seamless = value.designTool === "seamless_pattern" || value.designTool === "seamless_stitch";
  if (seamless && (!value.repeatType || !value.seamCheckRequired || !value.tilePreviewRequired)) {
    context.addIssue({ code: "custom", path: ["repeatType"], message: "Seamless tools require repeat, seam-check, and tile-preview settings" });
  }
  if (!seamless && (value.repeatType !== undefined || value.seamCheckRequired !== undefined || value.tilePreviewRequired !== undefined)) {
    context.addIssue({ code: "custom", path: ["repeatType"], message: "Repeat settings are only accepted by seamless tools" });
  }
  if ((value.designTool === "seamless_stitch") === value.markAiGenerated) {
    context.addIssue({ code: "custom", path: ["markAiGenerated"], message: "Only deterministic seamless stitching must be marked non-generative" });
  }
});

export const CreativeDesignOutputCheckSchema = z.object({
  fileName: z.string().trim().min(1).max(180),
  outputIndex: z.number().int().min(0).max(15),
  sourceInputOrdinals: z.array(z.number().int().min(0).max(99)).max(100),
  width: z.number().int().positive().max(100_000),
  height: z.number().int().positive().max(100_000),
  format: z.literal("png"),
  transparent: z.boolean(),
  aiInference: z.enum(["none", "partial", "full"]),
  generatedRegions: z.array(PatternProcessingGeneratedRegionSchema).max(100),
  promptSafetyPassed: z.literal(true),
  contentSafetyPassed: z.literal(true),
  textDetected: z.boolean(),
  textReviewRequired: z.boolean(),
  sourceIdentityPreserved: z.literal(true),
  horizontalSeamPassed: z.boolean().optional(),
  verticalSeamPassed: z.boolean().optional(),
  tilePreviewValidated: z.boolean().optional(),
}).strict().superRefine((value, context) => {
  if (value.textDetected && !value.textReviewRequired) {
    context.addIssue({ code: "custom", path: ["textReviewRequired"], message: "Detected text requires human text review" });
  }
  if (value.aiInference === "none" && value.generatedRegions.length) {
    context.addIssue({ code: "custom", path: ["generatedRegions"], message: "Non-generative output cannot contain generated regions" });
  }
  if (value.aiInference === "partial" && !value.generatedRegions.length) {
    context.addIssue({ code: "custom", path: ["generatedRegions"], message: "Partial AI output requires marked generated regions" });
  }
});

export const CreativeDesignQualityCheckSnapshotSchema = z.object({
  passed: z.literal(true),
  toolKey: CreativeDesignToolKeySchema,
  inputCoverageComplete: z.literal(true),
  outputCountMatched: z.literal(true),
  duplicateOutputsDetected: z.literal(false),
  finalPromptHashSha256: z.string().regex(/^[a-f0-9]{64}$/),
  outputChecks: z.array(CreativeDesignOutputCheckSchema).min(1).max(16),
  processorDeploymentId: z.string().trim().min(1).max(160).optional(),
}).strict().superRefine((value, context) => {
  const indices = value.outputChecks.map((check) => check.outputIndex).sort((a, b) => a - b);
  if (indices.some((index, position) => index !== position)) {
    context.addIssue({ code: "custom", path: ["outputChecks"], message: "Creative output indices must be unique and contiguous from zero" });
  }
});

export const ListingAssetToolKeySchema = z.enum([
  "product_suite",
  "title_draft",
  "virtual_try_on",
  "background_replace",
]);

export const ListingPlatformSchema = z.enum(["amazon", "etsy"]);
export const ListingLocaleSchema = z.string().trim().regex(/^[a-z]{2}-[A-Z]{2}$/);

export const ProductSuiteParameterSnapshotSchema = z.object({
  listingTool: z.literal("product_suite"),
  platform: ListingPlatformSchema,
  locale: ListingLocaleSchema,
  productCategory: z.enum(["apparel", "phone_case"]),
  suiteTemplate: z.enum(["standard", "lifestyle", "detail"]),
  outputCount: z.number().int().min(1).max(16),
  outputFormat: z.literal("png"),
  markAiGenerated: z.literal(true),
  preserveProductIdentity: z.literal(true),
  factSourcePolicy: z.literal("sku_catalog_snapshot"),
}).strict();

export const TitleDraftParameterSnapshotSchema = z.object({
  listingTool: z.literal("title_draft"),
  platform: ListingPlatformSchema,
  locale: ListingLocaleSchema,
  outputCount: z.number().int().min(1).max(16),
  outputFormat: z.literal("txt"),
  productFacts: z.string().trim().min(1).max(8_000),
  keywordConstraints: z.array(z.string().trim().min(1).max(240)).max(50),
  platformRuleVersion: z.string().trim().min(1).max(160),
  requireFactAttribution: z.literal(true),
  markAiGenerated: z.literal(true),
}).strict();

export const VirtualTryOnParameterSnapshotSchema = z.object({
  listingTool: z.literal("virtual_try_on"),
  platform: ListingPlatformSchema,
  locale: ListingLocaleSchema,
  prompt: z.string().trim().min(1).max(8_000),
  aspectRatio: z.enum(["1:1", "4:5", "3:4"]),
  outputCount: z.number().int().min(1).max(16),
  outputFormat: z.literal("png"),
  modelLicenseReference: z.string().trim().min(1).max(500),
  preserveGarmentIdentity: z.literal(true),
  discloseAi: z.literal(true),
  markAiGenerated: z.literal(true),
}).strict();

export const BackgroundReplaceParameterSnapshotSchema = z.object({
  listingTool: z.literal("background_replace"),
  platform: ListingPlatformSchema,
  locale: ListingLocaleSchema,
  prompt: z.string().trim().min(1).max(8_000),
  aspectRatio: z.enum(["1:1", "4:5", "3:4"]),
  outputCount: z.number().int().min(1).max(16),
  outputFormat: z.literal("png"),
  preserveSubject: z.literal(true),
  generatedBackground: z.literal(true),
  markAiGenerated: z.literal(true),
}).strict();

export const ListingAssetParameterSnapshotSchema = z.discriminatedUnion("listingTool", [
  ProductSuiteParameterSnapshotSchema,
  TitleDraftParameterSnapshotSchema,
  VirtualTryOnParameterSnapshotSchema,
  BackgroundReplaceParameterSnapshotSchema,
]);

export const ListingImageOutputCheckSchema = z.object({
  fileName: z.string().trim().min(1).max(180),
  outputIndex: z.number().int().min(0).max(15),
  sourceInputOrdinals: z.array(z.number().int().min(0).max(99)).min(1).max(20),
  contentKind: z.literal("image"),
  slotKey: z.string().trim().regex(/^[a-z][a-z0-9_.-]{0,79}$/),
  width: z.number().int().positive().max(100_000),
  height: z.number().int().positive().max(100_000),
  format: z.literal("png"),
  transparent: z.boolean(),
  aiInference: z.enum(["partial", "full"]),
  generatedRegions: z.array(PatternProcessingGeneratedRegionSchema).max(100),
  productIdentityPreserved: z.literal(true),
  categoryIdentityPassed: z.literal(true),
  printPlacementPreserved: z.literal(true),
  approvedFactsOnly: z.literal(true),
  contentSafetyPassed: z.literal(true),
  textDetected: z.boolean(),
  textReviewRequired: z.boolean(),
  modelLicenseVerified: z.literal(true).optional(),
  backgroundOnlyChanged: z.literal(true).optional(),
}).strict().superRefine((value, context) => {
  if (value.textDetected && !value.textReviewRequired) {
    context.addIssue({ code: "custom", path: ["textReviewRequired"], message: "Detected listing text requires human review" });
  }
  if (value.aiInference === "partial" && !value.generatedRegions.length) {
    context.addIssue({ code: "custom", path: ["generatedRegions"], message: "Partial listing image generation requires marked regions" });
  }
});

export const ListingTitleOutputCheckSchema = z.object({
  fileName: z.string().trim().min(1).max(180),
  outputIndex: z.number().int().min(0).max(15),
  sourceInputOrdinals: z.array(z.number().int().min(0).max(99)).min(1).max(20),
  contentKind: z.literal("title"),
  title: z.string().trim().min(1).max(500),
  characterCount: z.number().int().positive().max(500),
  byteCount: z.number().int().positive().max(2_000),
  contentHashSha256: z.string().regex(/^[a-f0-9]{64}$/),
  factsMatched: z.literal(true),
  unsupportedFactKeys: z.array(z.string().trim().min(1).max(120)).length(0),
  keywordSources: z.array(z.string().trim().min(1).max(240)).max(50),
  platformRuleVersionMatched: z.literal(true),
  trademarkRiskChecked: z.literal(true),
  textReviewRequired: z.literal(true),
  contentSafetyPassed: z.literal(true),
}).strict().superRefine((value, context) => {
  if (value.characterCount !== [...value.title].length) {
    context.addIssue({ code: "custom", path: ["characterCount"], message: "Title character count must match the title" });
  }
  if (value.byteCount !== new TextEncoder().encode(value.title).byteLength) {
    context.addIssue({ code: "custom", path: ["byteCount"], message: "Title byte count must match UTF-8 content" });
  }
});

export const ListingAssetFailedOutputSchema = z.object({
  outputIndex: z.number().int().min(0).max(15),
  slotKey: z.string().trim().regex(/^[a-z][a-z0-9_.-]{0,79}$/).optional(),
  errorCode: z.string().trim().regex(/^[A-Z][A-Z0-9_]{1,79}$/),
  safeMessage: z.string().trim().min(1).max(240),
}).strict();

export const ListingAssetQualityCheckSnapshotSchema = z.object({
  passed: z.literal(true),
  toolKey: ListingAssetToolKeySchema,
  platform: ListingPlatformSchema,
  locale: ListingLocaleSchema,
  requestedOutputCount: z.number().int().min(1).max(16),
  successfulOutputCount: z.number().int().min(1).max(16),
  failedOutputCount: z.number().int().min(0).max(15),
  inputCoverageComplete: z.literal(true),
  duplicateOutputsDetected: z.literal(false),
  outputChecks: z.array(z.discriminatedUnion("contentKind", [
    ListingImageOutputCheckSchema,
    ListingTitleOutputCheckSchema,
  ])).min(1).max(16),
  failedOutputs: z.array(ListingAssetFailedOutputSchema).max(15),
  processorDeploymentId: z.string().trim().min(1).max(160).optional(),
}).strict().superRefine((value, context) => {
  if (
    value.successfulOutputCount !== value.outputChecks.length
    || value.failedOutputCount !== value.failedOutputs.length
    || value.successfulOutputCount + value.failedOutputCount !== value.requestedOutputCount
  ) {
    context.addIssue({ code: "custom", path: ["requestedOutputCount"], message: "Listing output counts must reconcile" });
  }
  const indices = [...value.outputChecks.map((check) => check.outputIndex), ...value.failedOutputs.map((failure) => failure.outputIndex)].sort((a, b) => a - b);
  if (indices.some((index, position) => index !== position)) {
    context.addIssue({ code: "custom", path: ["outputChecks"], message: "Listing output indices must be unique and contiguous from zero" });
  }
  if (value.toolKey !== "product_suite" && value.failedOutputs.length) {
    context.addIssue({ code: "custom", path: ["failedOutputs"], message: "Only product suites support isolated partial output" });
  }
  const expectsTitles = value.toolKey === "title_draft";
  if (value.outputChecks.some((check) => (check.contentKind === "title") !== expectsTitles)) {
    context.addIssue({ code: "custom", path: ["outputChecks"], message: "Listing output kind must match the selected tool" });
  }
  if (value.toolKey === "virtual_try_on" && value.outputChecks.some((check) => check.contentKind === "image" && !check.modelLicenseVerified)) {
    context.addIssue({ code: "custom", path: ["outputChecks"], message: "Virtual try-on requires model license evidence" });
  }
  if (value.toolKey === "background_replace" && value.outputChecks.some((check) => check.contentKind === "image" && !check.backgroundOnlyChanged)) {
    context.addIssue({ code: "custom", path: ["outputChecks"], message: "Background replacement must preserve the subject" });
  }
});

export const ProductionPieceKeySchema = z.string().trim().regex(/^[a-z][a-z0-9_.-]{0,79}$/);
export const PieceExtractDefinitionSchema = z.string().trim().min(1).max(240).superRefine((value, context) => {
  const [pieceKey, displayName, rawRotation, flipMode, extra] = value.split("|").map((entry) => entry.trim());
  const rotation = Number(rawRotation);
  if (
    extra !== undefined
    || !ProductionPieceKeySchema.safeParse(pieceKey).success
    || !displayName
    || displayName.length > 80
    || displayName.includes("|")
    || ![0, 90, 180, 270].includes(rotation)
    || !["none", "horizontal", "vertical", "both"].includes(flipMode ?? "")
  ) {
    context.addIssue({ code: "custom", message: "Piece definitions must use pieceKey|displayName|rotation|flipMode" });
  }
});

export const PieceExtractParameterSnapshotSchema = z.object({
  width: z.number().positive().max(100_000),
  height: z.number().positive().max(100_000),
  unit: z.enum(["px", "mm", "in"]),
  dpi: z.number().int().min(36).max(2_400),
  colorMode: z.enum(["rgb", "cmyk", "grayscale", "spot"]),
  extractionMode: z.enum(["separate", "combined"]),
  boundarySource: z.enum(["alpha", "dark_line"]),
  pieceDefinitions: z.array(PieceExtractDefinitionSchema).min(1).max(98),
  printArea: z.string().trim().min(1).max(500),
  seamAllowanceMm: z.number().min(0).max(100),
  outputFormat: z.enum(["png", "tiff", "jpeg"]),
  preserveTransparency: z.boolean(),
  minimumConfidence: z.number().min(0.5).max(1),
  templateDraftName: z.string().trim().min(1).max(160),
}).strict().superRefine((value, context) => {
  const pieceKeys = value.pieceDefinitions.map((definition) => definition.split("|")[0]!.trim());
  if (new Set(pieceKeys).size !== pieceKeys.length) {
    context.addIssue({ code: "custom", path: ["pieceDefinitions"], message: "Piece definition keys must be unique" });
  }
  if (value.extractionMode === "separate" && value.boundarySource !== "alpha") {
    context.addIssue({ code: "custom", path: ["boundarySource"], message: "Separate extraction requires alpha boundaries" });
  }
  if (value.extractionMode === "combined" && value.boundarySource !== "dark_line") {
    context.addIssue({ code: "custom", path: ["boundarySource"], message: "Combined extraction requires dark-line boundaries" });
  }
  if (value.extractionMode === "separate" && (value.outputFormat === "jpeg" || !value.preserveTransparency)) {
    context.addIssue({ code: "custom", path: ["outputFormat"], message: "Separate extraction requires transparent PNG or TIFF output" });
  }
  if (value.outputFormat === "jpeg" && value.preserveTransparency) {
    context.addIssue({ code: "custom", path: ["preserveTransparency"], message: "JPEG output cannot preserve transparency" });
  }
});

export const PieceExtractRegionEvidenceSchema = z.object({
  pieceKey: ProductionPieceKeySchema,
  displayName: z.string().trim().min(1).max(80),
  inputOrdinal: z.literal(0),
  x: z.number().nonnegative().finite(),
  y: z.number().nonnegative().finite(),
  width: z.number().positive().finite(),
  height: z.number().positive().finite(),
  unit: z.enum(["px", "mm", "in"]),
  rotationDegrees: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
  flipMode: z.enum(["none", "horizontal", "vertical", "both"]),
  boundaryClosed: z.literal(true),
  printAreaDetected: z.literal(true),
  seamLineRecorded: z.literal(true),
  confidence: z.number().min(0).max(1),
  manualConfirmationRequired: z.boolean(),
  outputFileName: z.string().trim().min(1).max(500),
}).strict();

export const PieceExtractOutputCheckSchema = z.object({
  fileName: z.string().trim().min(1).max(500),
  kind: z.enum(["full_canvas", "piece", "template_package"]),
  pieceKeys: z.array(ProductionPieceKeySchema).max(100),
  dimensionsValid: z.literal(true),
  colorModeValid: z.literal(true),
  formatValid: z.literal(true),
}).strict();

export const PieceExtractQualityCheckSnapshotSchema = z.object({
  passed: z.literal(true),
  extractionMode: z.enum(["separate", "combined"]),
  canvasMatched: z.literal(true),
  dpiMatched: z.literal(true),
  colorModeMatched: z.literal(true),
  blankPieceKeys: z.array(ProductionPieceKeySchema).max(100),
  duplicatePieceKeys: z.array(ProductionPieceKeySchema).max(100),
  unexpectedPieceKeys: z.array(ProductionPieceKeySchema).max(100),
  lowConfidencePieceKeys: z.array(ProductionPieceKeySchema).max(100),
  regions: z.array(PieceExtractRegionEvidenceSchema).min(1).max(100),
  templateDraft: z.object({
    name: z.string().trim().min(1).max(160),
    fileName: z.string().trim().min(1).max(500),
    status: z.literal("awaiting_confirmation"),
    stableKeysComplete: z.literal(true),
  }).strict(),
  outputChecks: z.array(PieceExtractOutputCheckSchema).min(1).max(100),
  processorDeploymentId: z.string().trim().min(1).max(160).optional(),
}).strict();

export const UvLayerDefinitionSchema = z.string().trim().min(1).max(240).superRefine((value, context) => {
  const [layerKey, displayName, channel, rawOrder, rawOpacity, extra] = value.split("|").map((entry) => entry.trim());
  const order = Number(rawOrder);
  const opacity = Number(rawOpacity);
  if (
    extra !== undefined
    || !ProductionPieceKeySchema.safeParse(layerKey).success
    || !displayName
    || displayName.length > 80
    || !["color", "white_ink", "varnish", "emboss", "cut", "mask"].includes(channel ?? "")
    || !Number.isInteger(order)
    || order < 0
    || order > 99
    || !Number.isFinite(opacity)
    || opacity < 0
    || opacity > 1
  ) {
    context.addIssue({ code: "custom", message: "UV layer definitions must use layerKey|displayName|channel|order|opacity" });
  }
});

export const UvLayersParameterSnapshotSchema = z.object({
  width: z.number().positive().max(100_000),
  height: z.number().positive().max(100_000),
  unit: z.enum(["px", "mm", "in"]),
  dpi: z.number().int().min(36).max(2_400),
  colorMode: z.enum(["rgb", "cmyk", "grayscale", "spot"]),
  separationMode: z.enum(["automatic", "rule_based"]),
  layerPrefix: ProductionPieceKeySchema,
  supplierChannelProfile: z.string().trim().min(1).max(500),
  layerDefinitions: z.array(UvLayerDefinitionSchema).min(1).max(98),
  outputFormat: z.enum(["png", "tiff"]),
  preserveTransparency: z.literal(true),
  whiteInkLayer: z.boolean(),
  varnishLayer: z.boolean(),
  conflictPolicy: z.literal("manual_review"),
  compositePreview: z.literal(true),
}).strict().superRefine((value, context) => {
  const definitions = value.layerDefinitions.map((definition) => definition.split("|").map((entry) => entry.trim()));
  const keys = definitions.map(([key]) => key!);
  const orders = definitions.map(([, , , order]) => Number(order));
  const channels = definitions.map(([, , channel]) => channel);
  if (new Set(keys).size !== keys.length) {
    context.addIssue({ code: "custom", path: ["layerDefinitions"], message: "UV layer keys must be unique" });
  }
  if (new Set(orders).size !== orders.length) {
    context.addIssue({ code: "custom", path: ["layerDefinitions"], message: "UV layer order values must be unique" });
  }
  if (value.whiteInkLayer !== channels.includes("white_ink")) {
    context.addIssue({ code: "custom", path: ["whiteInkLayer"], message: "White-ink toggle must match the layer definitions" });
  }
  if (value.varnishLayer !== channels.includes("varnish")) {
    context.addIssue({ code: "custom", path: ["varnishLayer"], message: "Varnish toggle must match the layer definitions" });
  }
});

export const UvLayerEvidenceSchema = z.object({
  layerKey: ProductionPieceKeySchema,
  displayName: z.string().trim().min(1).max(80),
  channel: z.enum(["color", "white_ink", "varnish", "emboss", "cut", "mask"]),
  order: z.number().int().min(0).max(99),
  opacity: z.number().min(0).max(1),
  sourceInputOrdinal: z.literal(0),
  sourcePixelCount: z.number().int().nonnegative(),
  conflictPixelCount: z.number().int().nonnegative(),
  width: z.number().positive().finite(),
  height: z.number().positive().finite(),
  unit: z.enum(["px", "mm", "in"]),
  transparent: z.literal(true),
  outputFileName: z.string().trim().min(1).max(500),
}).strict();

export const UvConflictRegionEvidenceSchema = z.object({
  regionKey: ProductionPieceKeySchema,
  x: z.number().nonnegative().finite(),
  y: z.number().nonnegative().finite(),
  width: z.number().positive().finite(),
  height: z.number().positive().finite(),
  unit: z.enum(["px", "mm", "in"]),
  reason: z.enum(["ambiguous_overlap", "unclassified", "low_confidence", "channel_rule_conflict"]),
  candidateLayerKeys: z.array(ProductionPieceKeySchema).min(1).max(20),
  confidence: z.number().min(0).max(1),
}).strict();

export const UvLayersOutputCheckSchema = z.object({
  fileName: z.string().trim().min(1).max(500),
  kind: z.enum(["layer", "composite_preview", "layer_package"]),
  layerKeys: z.array(ProductionPieceKeySchema).max(98),
  dimensionsValid: z.literal(true),
  transparencyValid: z.literal(true),
  channelProfileValid: z.literal(true),
}).strict();

export const UvLayersQualityCheckSnapshotSchema = z.object({
  passed: z.boolean(),
  exportReady: z.boolean(),
  manualReviewRequired: z.boolean(),
  separationMode: z.enum(["automatic", "rule_based"]),
  canvasMatched: z.literal(true),
  dpiMatched: z.literal(true),
  colorModeMatched: z.literal(true),
  transparencyMatched: z.literal(true),
  blankLayerKeys: z.array(ProductionPieceKeySchema).max(98),
  unexpectedLayerKeys: z.array(ProductionPieceKeySchema).max(98),
  layers: z.array(UvLayerEvidenceSchema).min(1).max(98),
  conflictRegions: z.array(UvConflictRegionEvidenceSchema).max(1_000),
  outputChecks: z.array(UvLayersOutputCheckSchema).min(1).max(100),
  processorDeploymentId: z.string().trim().min(1).max(160).optional(),
}).strict().superRefine((value, context) => {
  const hasConflicts = value.conflictRegions.length > 0;
  if (value.passed === hasConflicts || value.exportReady === hasConflicts || value.manualReviewRequired !== hasConflicts) {
    context.addIssue({ code: "custom", message: "UV export readiness and manual review must match unresolved conflicts" });
  }
});

export const ProductVideoParameterSnapshotSchema = z.object({
  durationSeconds: z.number().int().min(5).max(60),
  shotTemplate: z.enum(["product_focus", "lifestyle", "detail"]),
  aspectRatio: z.enum(["1:1", "4:5", "9:16", "16:9"]),
  resolution: z.enum(["720p", "1080p"]),
  fps: z.union([z.literal(24), z.literal(25), z.literal(30)]),
  transition: z.enum(["cut", "fade", "slide"]),
  loop: z.boolean(),
  captionMode: z.enum(["off", "product_title", "custom"]),
  captionText: z.string().trim().min(1).max(500).optional(),
  soundtrackMode: z.enum(["none", "licensed"]),
  soundtrackLicenseReference: z.string().trim().min(1).max(500).optional(),
  soundtrackRightsAttested: z.boolean(),
  allowAiMotion: z.boolean(),
  safeArea: z.literal(true),
}).strict().superRefine((value, context) => {
  if ((value.captionMode === "custom") !== Boolean(value.captionText)) {
    context.addIssue({ code: "custom", path: ["captionText"], message: "Custom captions require caption text, and other caption modes cannot include it" });
  }
  const licensed = value.soundtrackMode === "licensed";
  if (licensed !== Boolean(value.soundtrackLicenseReference) || licensed !== value.soundtrackRightsAttested) {
    context.addIssue({ code: "custom", path: ["soundtrackLicenseReference"], message: "Licensed soundtracks require a license reference and explicit rights attestation" });
  }
});

export const ProductVideoOutputCheckSchema = z.object({
  fileName: z.string().trim().min(1).max(180),
  usedInputOrdinals: z.array(z.number().int().min(0).max(19)).min(1).max(20),
  durationSeconds: z.number().positive().max(60),
  fps: z.union([z.literal(24), z.literal(25), z.literal(30)]),
  width: z.number().int().positive().max(8_192),
  height: z.number().int().positive().max(8_192),
  videoCodec: z.literal("h264"),
  audioCodec: z.enum(["none", "aac"]),
}).strict();

export const ProductVideoQualityCheckSnapshotSchema = z.object({
  passed: z.literal(true),
  durationMatched: z.literal(true),
  fpsMatched: z.literal(true),
  dimensionsMatched: z.literal(true),
  inputCoverageComplete: z.literal(true),
  playbackValid: z.literal(true),
  blankFramesDetected: z.literal(false),
  corruptFramesDetected: z.literal(false),
  safeAreaPassed: z.literal(true),
  captionOverflowDetected: z.literal(false),
  audioClippingDetected: z.literal(false),
  soundtrackLicenseMatched: z.literal(true),
  aiMotionEvidenceMatched: z.literal(true),
  outputChecks: z.array(ProductVideoOutputCheckSchema).length(1),
  processorDeploymentId: z.string().trim().min(1).max(160).optional(),
}).strict();

export const PieceComposeManualPlacementSchema = z.string().trim().min(1).max(240).superRefine((value, context) => {
  const [pieceKey, rawX, rawY, rawRotation, rawScale, extra] = value.split(",").map((entry) => entry.trim());
  const x = Number(rawX);
  const y = Number(rawY);
  const rotation = Number(rawRotation);
  const scale = Number(rawScale);
  if (
    extra !== undefined
    || !ProductionPieceKeySchema.safeParse(pieceKey).success
    || !Number.isFinite(x)
    || x < 0
    || !Number.isFinite(y)
    || y < 0
    || ![0, 90, 180, 270].includes(rotation)
    || !Number.isFinite(scale)
    || scale <= 0
    || scale > 10
  ) {
    context.addIssue({ code: "custom", message: "Manual placements must use pieceKey,x,y,rotation,scale" });
  }
});

export const PieceComposeParameterSnapshotSchema = z.object({
  width: z.number().positive().max(100_000),
  height: z.number().positive().max(100_000),
  unit: z.enum(["px", "mm", "in"]),
  dpi: z.number().int().min(36).max(2_400),
  colorMode: z.enum(["rgb", "cmyk", "grayscale", "spot"]),
  positioningTemplate: z.string().trim().min(1).max(500),
  fitMode: z.enum(["contain", "cover", "stretch"]),
  layoutMode: z.enum(["automatic", "manual"]),
  pieceKeys: z.array(ProductionPieceKeySchema).min(1).max(100),
  minimumDpi: z.number().int().min(36).max(2_400),
  gapMm: z.number().min(0).max(1_000),
  allowRotation: z.boolean(),
  manualPlacements: z.array(PieceComposeManualPlacementSchema).max(100),
}).strict().superRefine((value, context) => {
  const uniqueKeys = new Set(value.pieceKeys);
  if (uniqueKeys.size !== value.pieceKeys.length) {
    context.addIssue({ code: "custom", path: ["pieceKeys"], message: "Piece keys must be unique" });
  }
  if (value.minimumDpi > value.dpi) {
    context.addIssue({ code: "custom", path: ["minimumDpi"], message: "Minimum effective DPI cannot exceed the requested output DPI" });
  }
  if (value.layoutMode === "automatic" && value.manualPlacements.length) {
    context.addIssue({ code: "custom", path: ["manualPlacements"], message: "Automatic layout cannot include manual placements" });
  }
  if (value.layoutMode === "manual") {
    const placementKeys = value.manualPlacements.map((placement) => placement.split(",")[0]!.trim());
    if (new Set(placementKeys).size !== placementKeys.length || !sameStringMembers(placementKeys, value.pieceKeys)) {
      context.addIssue({ code: "custom", path: ["manualPlacements"], message: "Manual layout requires exactly one placement for every piece key" });
    }
  }
});

export const PieceComposePlacementEvidenceSchema = z.object({
  pieceKey: ProductionPieceKeySchema,
  inputOrdinal: z.int().min(0).max(99),
  x: z.number().nonnegative().finite(),
  y: z.number().nonnegative().finite(),
  width: z.number().positive().finite(),
  height: z.number().positive().finite(),
  unit: z.enum(["px", "mm", "in"]),
  rotationDegrees: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
  scaleX: z.number().positive().max(10),
  scaleY: z.number().positive().max(10),
  effectiveDpi: z.number().int().min(1).max(9_600),
  insidePrintArea: z.literal(true),
  seamLinePreserved: z.literal(true),
}).strict();

export const PieceComposeOutputCheckSchema = z.object({
  fileName: z.string().trim().min(1).max(500),
  pieceKeys: z.array(ProductionPieceKeySchema).min(1).max(100),
  dimensionsValid: z.literal(true),
  colorModeValid: z.literal(true),
}).strict();

export const PieceComposeQualityCheckSnapshotSchema = z.object({
  passed: z.literal(true),
  layoutMode: z.enum(["automatic", "manual"]),
  positioningTemplateMatched: z.literal(true),
  dimensionsMatched: z.literal(true),
  colorModeMatched: z.literal(true),
  minimumDpiPassed: z.literal(true),
  overlapDetected: z.literal(false),
  outOfBoundsDetected: z.literal(false),
  blankPieceKeys: z.array(ProductionPieceKeySchema).max(100),
  placements: z.array(PieceComposePlacementEvidenceSchema).min(1).max(100),
  outputChecks: z.array(PieceComposeOutputCheckSchema).min(1).max(500),
  processorDeploymentId: z.string().trim().min(1).max(160).optional(),
}).strict();

export const CreatePodArtworkTaskInputSchema = z.object({
  idempotencyKey: z.uuidv7(),
  skuId: z.uuidv7(),
  toolKey: PodExecutableToolKeySchema,
  title: z.string().trim().min(1).max(160),
  inputAssetIds: z.array(z.uuidv7()).max(100),
  parameterSnapshot: PodTaskParameterSnapshotSchema,
}).strict().superRefine((input, context) => {
  if (new Set(input.inputAssetIds).size !== input.inputAssetIds.length) {
    context.addIssue({ code: "custom", path: ["inputAssetIds"], message: "POD task input asset IDs must be unique" });
  }
  if (input.toolKey !== "text_to_image" && !input.inputAssetIds.length) {
    context.addIssue({ code: "custom", path: ["inputAssetIds"], message: "This POD tool requires at least one input asset" });
  }
  validatePrintExtractionParameters(input.toolKey, input.parameterSnapshot, input.inputAssetIds.length, context);
  validatePatternProcessingParameters(input.toolKey, input.parameterSnapshot, input.inputAssetIds.length, context);
  validateRightsRiskParameters(input.toolKey, input.parameterSnapshot, input.inputAssetIds.length, context);
  validateCreativeDesignParameters(input.toolKey, input.parameterSnapshot, input.inputAssetIds.length, context);
  validateListingAssetParameters(input.toolKey, input.parameterSnapshot, input.inputAssetIds.length, context);
  validatePieceComposeParameters(input.toolKey, input.parameterSnapshot, input.inputAssetIds.length, context);
  validatePieceExtractParameters(input.toolKey, input.parameterSnapshot, input.inputAssetIds.length, context);
  validateUvLayersParameters(input.toolKey, input.parameterSnapshot, input.inputAssetIds.length, context);
  validateProductVideoParameters(input.toolKey, input.parameterSnapshot, input.inputAssetIds.length, context);
});

export const PodTaskAssetSnapshotSchema = z.object({
  assetId: z.uuidv7(),
  ordinal: z.number().int().min(0),
  version: z.number().int().positive(),
  checksumSha256: z.string().regex(/^[0-9a-f]{64}$/),
  domain: z.enum(["research", "authorized"]),
  rightsStatus: z.enum(["unverified", "approved", "rejected"]),
  rightsSourceKind: z.enum(["owned", "licensed", "commissioned", "ai_generated", "customer_provided", "competitor"]).optional(),
}).strict();

export const PodArtworkTaskViewSchema = z.object({
  id: z.uuidv7(),
  designTaskId: z.uuidv7(),
  skuId: z.uuidv7(),
  title: z.string(),
  toolKey: PodExecutableToolKeySchema,
  status: PodTaskStatusSchema,
  parameterSnapshot: PodTaskParameterSnapshotSchema,
  inputAssets: z.array(PodTaskAssetSnapshotSchema),
  modelKey: z.string().min(1).optional(),
  modelVersion: z.string().min(1).optional(),
  seed: z.string().min(1).optional(),
  progressPercent: z.number().int().min(0).max(100),
  attemptCount: z.number().int().min(0),
  maxAttempts: z.number().int().positive().max(20),
  resultVersionId: z.uuidv7().optional(),
  errorCode: z.string().min(1).optional(),
  errorMessage: z.string().min(1).optional(),
  qualityCheckSnapshot: z.record(z.string(), z.unknown()).optional(),
  reviewSnapshot: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).strict().superRefine((task, context) => {
  validatePrintExtractionParameters(task.toolKey, task.parameterSnapshot, task.inputAssets.length, context);
  validatePatternProcessingParameters(task.toolKey, task.parameterSnapshot, task.inputAssets.length, context);
  validateRightsRiskParameters(task.toolKey, task.parameterSnapshot, task.inputAssets.length, context);
  validateCreativeDesignParameters(task.toolKey, task.parameterSnapshot, task.inputAssets.length, context);
  validateListingAssetParameters(task.toolKey, task.parameterSnapshot, task.inputAssets.length, context);
  validatePieceComposeParameters(task.toolKey, task.parameterSnapshot, task.inputAssets.length, context);
  validatePieceExtractParameters(task.toolKey, task.parameterSnapshot, task.inputAssets.length, context);
  validateUvLayersParameters(task.toolKey, task.parameterSnapshot, task.inputAssets.length, context);
  validateProductVideoParameters(task.toolKey, task.parameterSnapshot, task.inputAssets.length, context);
});

export const PodArtworkTaskListViewSchema = z.object({
  items: z.array(PodArtworkTaskViewSchema),
}).strict();

const PodExportSha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const CreatePodExportInputSchema = z.object({ idempotencyKey: z.uuidv7() }).strict();
export const PodExportStatusSchema = z.enum(["queued", "running", "completed", "failed"]);
export const PodExportFileSchema = z.object({
  path: z.string().min(1).refine((path) => !path.startsWith("/") && !path.includes(".."), "Export path must stay inside the package"),
  sha256: PodExportSha256Schema,
  assetId: z.uuidv7(),
  assetVersion: z.int().positive(),
  mediaType: z.string().min(1).max(200),
});
export const PodExportManifestSchema = z.object({
  exportId: z.uuidv7(),
  tenantId: z.uuidv7(),
  taskId: z.uuidv7(),
  designTaskId: z.uuidv7(),
  designVersionId: z.uuidv7(),
  toolKey: PodExecutableToolKeySchema,
  inputAssets: z.array(z.object({
    assetId: z.uuidv7(),
    assetVersion: z.int().positive(),
    checksumSha256: PodExportSha256Schema,
  })),
  files: z.array(PodExportFileSchema).min(1),
  modelKey: z.string().min(1).optional(),
  modelVersion: z.string().min(1).optional(),
  seed: z.string().min(1).optional(),
  qualityCheckSnapshot: z.record(z.string(), z.unknown()),
  createdBy: z.uuidv7(),
  createdAt: z.iso.datetime(),
});
export const PodExportViewSchema = z.object({
  id: z.uuidv7(),
  taskId: z.uuidv7(),
  designVersionId: z.uuidv7(),
  status: PodExportStatusSchema,
  checksumSha256: PodExportSha256Schema.optional(),
  byteSize: z.int().nonnegative().optional(),
  manifest: PodExportManifestSchema.optional(),
  errorCode: z.string().min(1).optional(),
  errorMessage: z.string().min(1).optional(),
  createdAt: z.iso.datetime(),
  completedAt: z.iso.datetime().optional(),
});
export const PodExportListViewSchema = z.object({
  items: z.array(PodExportViewSchema).max(100),
});

export const PodTaskInputOptionsViewSchema = z.object({
  toolKey: PodExecutableToolKeySchema,
  enabled: z.boolean(),
  requiresAssetInput: z.boolean(),
  skus: z.array(z.object({
    id: z.uuidv7(),
    code: z.string().min(1),
    spuCode: z.string().min(1),
    productName: z.string().min(1),
  }).strict()),
  assets: z.array(z.object({
    id: z.uuidv7(),
    fileName: z.string().min(1),
    mediaType: z.string().min(1),
    version: z.number().int().positive(),
    checksumSha256: z.string().regex(/^[0-9a-f]{64}$/),
    domain: z.enum(["research", "authorized"]),
    rightsStatus: z.enum(["unverified", "approved", "rejected"]),
    rightsSourceKind: z.enum(["owned", "licensed", "commissioned", "ai_generated", "customer_provided", "competitor"]).optional(),
  }).strict()),
}).strict();

export const PodModuleDefinitionSchema = z.object({
  key: PodModuleKeySchema,
  label: z.string().min(1).max(40),
  order: z.number().int().min(1).max(7),
  phase: PodPhaseSchema,
}).strict();

export const PodToolDefinitionSchema = z.object({
  key: PodToolKeySchema,
  module: PodModuleKeySchema,
  label: z.string().min(1).max(60),
  description: z.string().min(1).max(240),
  phase: PodPhaseSchema,
  availability: PodToolAvailabilitySchema,
  assetPolicy: PodAssetPolicySchema,
  inputKinds: z.array(PodInputKindSchema).min(1),
  outputKinds: z.array(PodOutputKindSchema).min(1),
  parameterSummary: z.array(z.string().min(1).max(80)).max(8),
}).strict();

export const PodSupportCapabilitySchema = z.object({
  key: PodSupportCapabilityKeySchema,
  label: z.string().min(1).max(60),
  description: z.string().min(1).max(240),
  phase: PodPhaseSchema,
  availability: PodToolAvailabilitySchema,
}).strict();

export const PodToolCatalogViewSchema = z.object({
  supportedMarketplaces: z.tuple([z.literal("amazon"), z.literal("etsy")]),
  modules: z.array(PodModuleDefinitionSchema).length(7),
  tools: z.array(PodToolDefinitionSchema).min(1),
  supportCapabilities: z.array(PodSupportCapabilitySchema),
}).strict().superRefine((catalog, context) => {
  const expectedModules = PodModuleKeySchema.options;
  if (catalog.modules.some((module, index) => module.key !== expectedModules[index] || module.order !== index + 1)) {
    context.addIssue({ code: "custom", path: ["modules"], message: "POD modules must keep the canonical seven-item order" });
  }

  const moduleKeys = new Set(catalog.modules.map((module) => module.key));
  const toolKeys = new Set<string>();
  catalog.tools.forEach((tool, index) => {
    if (!moduleKeys.has(tool.module)) {
      context.addIssue({ code: "custom", path: ["tools", index, "module"], message: "Tool module is not present in the catalog" });
    }
    if (toolKeys.has(tool.key)) {
      context.addIssue({ code: "custom", path: ["tools", index, "key"], message: "Tool keys must be unique" });
    }
    toolKeys.add(tool.key);
  });
});

export type PodModuleKey = z.infer<typeof PodModuleKeySchema>;
export type PodPhase = z.infer<typeof PodPhaseSchema>;
export type PodToolAvailability = z.infer<typeof PodToolAvailabilitySchema>;
export type PodAssetPolicy = z.infer<typeof PodAssetPolicySchema>;
export type PodToolKey = z.infer<typeof PodToolKeySchema>;
export type PodModuleDefinition = z.infer<typeof PodModuleDefinitionSchema>;
export type PodToolDefinition = z.infer<typeof PodToolDefinitionSchema>;
export type PodSupportCapability = z.infer<typeof PodSupportCapabilitySchema>;
export type PodToolCatalogView = z.infer<typeof PodToolCatalogViewSchema>;
export type PodP1ExecutableToolKey = z.infer<typeof PodP1ExecutableToolKeySchema>;
export type PodP2ExecutableToolKey = z.infer<typeof PodP2ExecutableToolKeySchema>;
export type PodP3ExecutableToolKey = z.infer<typeof PodP3ExecutableToolKeySchema>;
export type PodExecutableToolKey = z.infer<typeof PodExecutableToolKeySchema>;
export type PodTaskStatus = z.infer<typeof PodTaskStatusSchema>;
export type PodTaskParameterSnapshot = z.infer<typeof PodTaskParameterSnapshotSchema>;
export type PatternCropParameterSnapshot = z.infer<typeof PatternCropParameterSnapshotSchema>;
export type PatternCropQualityCheckSnapshot = z.infer<typeof PatternCropQualityCheckSnapshotSchema>;
export type PrintExtractParameterSnapshot = z.infer<typeof PrintExtractParameterSnapshotSchema>;
export type PrintExtractQualityCheckSnapshot = z.infer<typeof PrintExtractQualityCheckSnapshotSchema>;
export type PatternProcessingQualityCheckSnapshot = z.infer<typeof PatternProcessingQualityCheckSnapshotSchema>;
export type RightsRiskQualityCheckSnapshot = z.infer<typeof RightsRiskQualityCheckSnapshotSchema>;
export type CreativeDesignQualityCheckSnapshot = z.infer<typeof CreativeDesignQualityCheckSnapshotSchema>;
export type ListingAssetParameterSnapshot = z.infer<typeof ListingAssetParameterSnapshotSchema>;
export type ListingAssetQualityCheckSnapshot = z.infer<typeof ListingAssetQualityCheckSnapshotSchema>;
export type PieceExtractParameterSnapshot = z.infer<typeof PieceExtractParameterSnapshotSchema>;
export type PieceExtractRegionEvidence = z.infer<typeof PieceExtractRegionEvidenceSchema>;
export type PieceExtractQualityCheckSnapshot = z.infer<typeof PieceExtractQualityCheckSnapshotSchema>;
export type UvLayersParameterSnapshot = z.infer<typeof UvLayersParameterSnapshotSchema>;
export type UvLayerEvidence = z.infer<typeof UvLayerEvidenceSchema>;
export type UvLayersQualityCheckSnapshot = z.infer<typeof UvLayersQualityCheckSnapshotSchema>;
export type ProductVideoParameterSnapshot = z.infer<typeof ProductVideoParameterSnapshotSchema>;
export type ProductVideoQualityCheckSnapshot = z.infer<typeof ProductVideoQualityCheckSnapshotSchema>;
export type PieceComposeParameterSnapshot = z.infer<typeof PieceComposeParameterSnapshotSchema>;
export type PieceComposePlacementEvidence = z.infer<typeof PieceComposePlacementEvidenceSchema>;
export type PieceComposeQualityCheckSnapshot = z.infer<typeof PieceComposeQualityCheckSnapshotSchema>;
export type CreatePodArtworkTaskInput = z.infer<typeof CreatePodArtworkTaskInputSchema>;
export type PodTaskAssetSnapshot = z.infer<typeof PodTaskAssetSnapshotSchema>;
export type PodArtworkTaskView = z.infer<typeof PodArtworkTaskViewSchema>;
export type CreatePodExportInput = z.infer<typeof CreatePodExportInputSchema>;
export type PodExportStatus = z.infer<typeof PodExportStatusSchema>;
export type PodExportFile = z.infer<typeof PodExportFileSchema>;
export type PodExportManifest = z.infer<typeof PodExportManifestSchema>;
export type PodExportView = z.infer<typeof PodExportViewSchema>;
export type PodExportListView = z.infer<typeof PodExportListViewSchema>;
export type PodTaskInputOptionsView = z.infer<typeof PodTaskInputOptionsViewSchema>;

function sameStringMembers(left: string[], right: string[]) {
  return left.length === right.length && left.every((entry) => right.includes(entry));
}

function validatePrintExtractionParameters(
  toolKey: string,
  parameterSnapshot: z.infer<typeof PodTaskParameterSnapshotSchema>,
  inputCount: number,
  context: z.RefinementCtx,
) {
  const schema = toolKey === "pattern_crop"
    ? PatternCropParameterSnapshotSchema
    : toolKey === "print_extract"
      ? PrintExtractParameterSnapshotSchema
      : undefined;
  if (!schema) return;
  const parameters = schema.safeParse(parameterSnapshot);
  if (!parameters.success) {
    parameters.error.issues.forEach((issue) => context.addIssue({
      code: "custom",
      path: ["parameterSnapshot", ...issue.path],
      message: issue.message,
    }));
  }
  if (inputCount < 1 || inputCount > 100) {
    context.addIssue({ code: "custom", path: ["inputAssetIds"], message: "Print extraction tasks require between one and one hundred pinned input images" });
  }
}

function validatePatternProcessingParameters(
  toolKey: string,
  parameterSnapshot: z.infer<typeof PodTaskParameterSnapshotSchema>,
  inputCount: number,
  context: z.RefinementCtx,
) {
  const schemas: Record<string, z.ZodType> = {
    background_remove: BackgroundRemoveParameterSnapshotSchema,
    super_resolution: SuperResolutionParameterSnapshotSchema,
    outpaint: OutpaintParameterSnapshotSchema,
    crop_compress: CropCompressParameterSnapshotSchema,
    vectorize: VectorizeParameterSnapshotSchema,
    authorized_watermark_remove: AuthorizedWatermarkRemoveParameterSnapshotSchema,
  };
  const schema = schemas[toolKey];
  if (!schema) return;
  const parameters = schema.safeParse(parameterSnapshot);
  if (!parameters.success) {
    parameters.error.issues.forEach((issue) => context.addIssue({
      code: "custom",
      path: ["parameterSnapshot", ...issue.path],
      message: issue.message,
    }));
  }
  if (inputCount < 1 || inputCount > 100) {
    context.addIssue({ code: "custom", path: ["inputAssetIds"], message: "Pattern processing tasks require between one and one hundred pinned input images" });
  }
}

function validateRightsRiskParameters(
  toolKey: string,
  parameterSnapshot: z.infer<typeof PodTaskParameterSnapshotSchema>,
  inputCount: number,
  context: z.RefinementCtx,
) {
  if (toolKey !== "rights_risk_scan") return;
  const parameters = RightsRiskScanParameterSnapshotSchema.safeParse(parameterSnapshot);
  if (!parameters.success) {
    parameters.error.issues.forEach((issue) => context.addIssue({
      code: "custom",
      path: ["parameterSnapshot", ...issue.path],
      message: issue.message,
    }));
  }
  if (inputCount < 1 || inputCount > 100) {
    context.addIssue({ code: "custom", path: ["inputAssetIds"], message: "Rights risk scans require between one and one hundred pinned input images" });
  }
}

function validateCreativeDesignParameters(
  toolKey: string,
  parameterSnapshot: z.infer<typeof PodTaskParameterSnapshotSchema>,
  inputCount: number,
  context: z.RefinementCtx,
) {
  if (!CreativeDesignToolKeySchema.safeParse(toolKey).success) return;
  const parameters = CreativeDesignParameterSnapshotSchema.safeParse(parameterSnapshot);
  if (!parameters.success || (parameters.success && parameters.data.designTool !== toolKey)) {
    if (!parameters.success) {
      parameters.error.issues.forEach((issue) => context.addIssue({
        code: "custom",
        path: ["parameterSnapshot", ...issue.path],
        message: issue.message,
      }));
    } else {
      context.addIssue({ code: "custom", path: ["parameterSnapshot", "designTool"], message: "Creative design tool key must match the task" });
    }
  }
  const allowsNoInput = toolKey === "text_to_image";
  if ((!allowsNoInput && inputCount < 1) || inputCount > 100) {
    context.addIssue({ code: "custom", path: ["inputAssetIds"], message: "Creative design tasks require one to one hundred pinned inputs, except text-to-image" });
  }
}

function validateListingAssetParameters(
  toolKey: string,
  parameterSnapshot: z.infer<typeof PodTaskParameterSnapshotSchema>,
  inputCount: number,
  context: z.RefinementCtx,
) {
  if (!ListingAssetToolKeySchema.safeParse(toolKey).success) return;
  const parameters = ListingAssetParameterSnapshotSchema.safeParse(parameterSnapshot);
  if (!parameters.success) {
    parameters.error.issues.forEach((issue) => context.addIssue({
      code: "custom",
      path: ["parameterSnapshot", ...issue.path],
      message: issue.message,
    }));
  } else if (parameters.data.listingTool !== toolKey) {
    context.addIssue({ code: "custom", path: ["parameterSnapshot", "listingTool"], message: "Listing asset tool key must match the task" });
  }
  const maximum = toolKey === "virtual_try_on" ? 2 : 20;
  if (inputCount < 1 || inputCount > maximum) {
    context.addIssue({ code: "custom", path: ["inputAssetIds"], message: `Listing asset tasks require between one and ${maximum} pinned inputs` });
  }
}

function validatePieceComposeParameters(
  toolKey: string,
  parameterSnapshot: z.infer<typeof PodTaskParameterSnapshotSchema>,
  inputCount: number,
  context: z.RefinementCtx,
) {
  if (toolKey !== "piece_compose") return;
  const parameters = PieceComposeParameterSnapshotSchema.safeParse(parameterSnapshot);
  if (!parameters.success) {
    parameters.error.issues.forEach((issue) => context.addIssue({
      code: "custom",
      path: ["parameterSnapshot", ...issue.path],
      message: issue.message,
    }));
  } else if (parameters.data.pieceKeys.length !== inputCount) {
    context.addIssue({
      code: "custom",
      path: ["parameterSnapshot", "pieceKeys"],
      message: "Piece compose requires one stable piece key per pinned input asset",
    });
  }
}

function validatePieceExtractParameters(
  toolKey: string,
  parameterSnapshot: z.infer<typeof PodTaskParameterSnapshotSchema>,
  inputCount: number,
  context: z.RefinementCtx,
) {
  if (toolKey !== "piece_extract") return;
  const parameters = PieceExtractParameterSnapshotSchema.safeParse(parameterSnapshot);
  if (!parameters.success) {
    parameters.error.issues.forEach((issue) => context.addIssue({
      code: "custom",
      path: ["parameterSnapshot", ...issue.path],
      message: issue.message,
    }));
  }
  if (inputCount !== 1) {
    context.addIssue({
      code: "custom",
      path: ["inputAssetIds"],
      message: "Piece extraction requires exactly one pinned source image or template",
    });
  }
}

function validateUvLayersParameters(
  toolKey: string,
  parameterSnapshot: z.infer<typeof PodTaskParameterSnapshotSchema>,
  inputCount: number,
  context: z.RefinementCtx,
) {
  if (toolKey !== "uv_layers") return;
  const parameters = UvLayersParameterSnapshotSchema.safeParse(parameterSnapshot);
  if (!parameters.success) {
    parameters.error.issues.forEach((issue) => context.addIssue({
      code: "custom",
      path: ["parameterSnapshot", ...issue.path],
      message: issue.message,
    }));
  }
  if (inputCount !== 1) {
    context.addIssue({
      code: "custom",
      path: ["inputAssetIds"],
      message: "UV layer separation requires exactly one pinned source image or template",
    });
  }
}

function validateProductVideoParameters(
  toolKey: string,
  parameterSnapshot: z.infer<typeof PodTaskParameterSnapshotSchema>,
  inputCount: number,
  context: z.RefinementCtx,
) {
  if (toolKey !== "product_video") return;
  const parameters = ProductVideoParameterSnapshotSchema.safeParse(parameterSnapshot);
  if (!parameters.success) {
    parameters.error.issues.forEach((issue) => context.addIssue({
      code: "custom",
      path: ["parameterSnapshot", ...issue.path],
      message: issue.message,
    }));
  }
  if (inputCount < 1 || inputCount > 20) {
    context.addIssue({
      code: "custom",
      path: ["inputAssetIds"],
      message: "Product video requires between one and twenty pinned images",
    });
  }
}
