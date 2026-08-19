import {
  AuthorizedWatermarkRemoveParameterSnapshotSchema,
  BackgroundRemoveParameterSnapshotSchema,
  CropCompressParameterSnapshotSchema,
  CreativeDesignParameterSnapshotSchema,
  CreativeDesignQualityCheckSnapshotSchema,
  CreativeDesignToolKeySchema,
  ListingAssetParameterSnapshotSchema,
  ListingAssetQualityCheckSnapshotSchema,
  ListingAssetToolKeySchema,
  OutpaintParameterSnapshotSchema,
  PatternProcessingQualityCheckSnapshotSchema,
  PieceComposeParameterSnapshotSchema,
  PieceComposeQualityCheckSnapshotSchema,
  PieceExtractParameterSnapshotSchema,
  PieceExtractQualityCheckSnapshotSchema,
  PatternCropParameterSnapshotSchema,
  PatternCropQualityCheckSnapshotSchema,
  PrintExtractParameterSnapshotSchema,
  PrintExtractQualityCheckSnapshotSchema,
  ProductVideoParameterSnapshotSchema,
  ProductVideoQualityCheckSnapshotSchema,
  RightsRiskQualityCheckSnapshotSchema,
  RightsRiskReportFileSchema,
  RightsRiskScanParameterSnapshotSchema,
  SuperResolutionParameterSnapshotSchema,
  UvLayersParameterSnapshotSchema,
  UvLayersQualityCheckSnapshotSchema,
  VectorizeParameterSnapshotSchema,
  PodExecutableToolKeySchema,
  PodTaskParameterSnapshotSchema,
  type PodExecutableToolKey,
  type PieceComposeParameterSnapshot,
  type PieceComposePlacementEvidence,
  type PieceExtractParameterSnapshot,
  type PatternCropParameterSnapshot,
  type PrintExtractParameterSnapshot,
  type UvLayersParameterSnapshot,
  type PodTaskParameterSnapshot,
  type TenantContext,
} from "@yummyai/contracts";
import { PodArtworkJobPayloadSchema, type JobEnvelope } from "@yummyai/jobs";
import { createHash } from "node:crypto";

export interface PodArtworkExecutionAsset {
  id: string;
  version: number;
  checksumSha256: string;
  domain: "research" | "authorized";
  rightsStatus: "unverified" | "approved" | "rejected";
  rightsSourceKind?: "owned" | "licensed" | "commissioned" | "ai_generated" | "customer_provided" | "competitor";
  bytes: Uint8Array;
  mediaType: string;
}

export interface PodArtworkExecutionRecord {
  id: string;
  designTaskId: string;
  toolKey: PodExecutableToolKey;
  parameterSnapshot: PodTaskParameterSnapshot;
  inputAssets: PodArtworkExecutionAsset[];
  modelKey?: string;
  maxAttempts: number;
}

export interface PodArtworkExecutionResult {
  outputs: Array<{
    bytes: Uint8Array;
    mediaType:
      | "image/png"
      | "image/jpeg"
      | "image/webp"
      | "image/tiff"
      | "image/svg+xml"
      | "video/mp4"
      | "application/zip"
      | "application/postscript"
      | "text/plain";
    role: "effect" | "production";
    fileName: string;
    metadata: {
      width?: number;
      height?: number;
      unit?: "px" | "mm" | "in";
      dpi?: number;
      colorMode?: "rgb" | "cmyk" | "grayscale" | "spot";
      transparent?: boolean;
      durationSeconds?: number;
      fps?: 24 | 25 | 30;
      videoCodec?: "h264";
      audioCodec?: "none" | "aac";
      aiInference: "none" | "partial" | "full";
      inferenceRegions?: Array<{ x: number; y: number; width: number; height: number }>;
    };
  }>;
  modelKey: string;
  modelVersion: string;
  seed?: string;
  costUsd?: number;
  qualityCheckSnapshot: Record<string, unknown>;
  partial: boolean;
}

export interface PodArtworkExecutionRepository {
  load(context: Pick<TenantContext, "tenantId" | "userId">, taskId: string): Promise<PodArtworkExecutionRecord | undefined>;
  claim(context: Pick<TenantContext, "tenantId" | "userId">, taskId: string, attempt: number): Promise<boolean>;
  complete(
    context: Pick<TenantContext, "tenantId" | "userId">,
    task: PodArtworkExecutionRecord,
    result: PodArtworkExecutionResult,
  ): Promise<void>;
  fail(
    context: Pick<TenantContext, "tenantId" | "userId">,
    taskId: string,
    input: { attempt: number; terminal: boolean; code: string; message: string },
  ): Promise<void>;
}

export interface PodArtworkGateway {
  execute(
    context: Pick<TenantContext, "tenantId" | "userId">,
    input: PodArtworkExecutionRecord,
    signal: AbortSignal,
  ): Promise<PodArtworkExecutionResult>;
}

export class PodArtworkTaskNotFoundError extends Error {
  constructor(taskId: string) {
    super(`POD artwork task ${taskId} was not found`);
    this.name = "PodArtworkTaskNotFoundError";
  }
}

export class PodArtworkInputPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PodArtworkInputPolicyError";
  }
}

export class PodArtworkOutputPolicyError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PodArtworkOutputPolicyError";
  }
}

export class PodArtworkProcessor {
  constructor(
    private readonly repository: PodArtworkExecutionRepository,
    private readonly gateway: PodArtworkGateway,
  ) {}

  async process(envelope: JobEnvelope, signal = new AbortController().signal) {
    const payload = PodArtworkJobPayloadSchema.parse(envelope.payload);
    const context = { tenantId: envelope.tenantId, userId: envelope.requestedBy };
    const task = await this.repository.load(context, payload.taskId);
    if (!task) throw new PodArtworkTaskNotFoundError(payload.taskId);
    const claimed = await this.repository.claim(context, task.id, envelope.attempt);
    if (!claimed) return { taskId: task.id, disposition: "already_claimed" as const };

    try {
      validateExecutionRecord(task);
      const result = validateResult(task, await this.gateway.execute(context, task, signal));
      await this.repository.complete(context, task, result);
      return {
        taskId: task.id,
        disposition: result.partial ? "partially_succeeded" as const : "awaiting_review" as const,
        outputCount: result.outputs.length,
      };
    } catch (error) {
      const terminal = error instanceof PodArtworkInputPolicyError
        || error instanceof PodArtworkOutputPolicyError
        || envelope.attempt + 1 >= Math.min(task.maxAttempts, envelope.maxAttempts);
      await this.repository.fail(context, task.id, {
        attempt: envelope.attempt,
        terminal,
        code: errorCode(error),
        message: safeErrorMessage(error),
      });
      throw error;
    }
  }
}

function validateExecutionRecord(task: PodArtworkExecutionRecord) {
  PodExecutableToolKeySchema.parse(task.toolKey);
  PodTaskParameterSnapshotSchema.parse(task.parameterSnapshot);
  const assetFreeTextGeneration = task.toolKey === "text_to_image" && !task.inputAssets.length;
  if (!assetFreeTextGeneration && !task.inputAssets.length) throw new PodArtworkInputPolicyError("POD artwork tasks require at least one input asset");
  if (task.inputAssets.some((asset) => asset.rightsSourceKind === "customer_provided")) {
    throw new PodArtworkInputPolicyError("Customer-order assets require an order-scoped personalization workflow");
  }

  if (task.toolKey === "rights_risk_scan") {
    if (!RightsRiskScanParameterSnapshotSchema.safeParse(task.parameterSnapshot).success) {
      throw new PodArtworkInputPolicyError("Rights risk scan parameter snapshot is invalid");
    }
    validatePrintExtractionInputs(task, "Rights risk scan");
    return;
  }
  for (const asset of task.inputAssets) {
    if (asset.domain !== "authorized" || asset.rightsStatus !== "approved") {
      throw new PodArtworkInputPolicyError(`POD tool ${task.toolKey} requires rights-approved authorized assets`);
    }
  }
  if (
    task.toolKey === "licensed_brand_fusion"
    && (task.parameterSnapshot.rightsAttested !== true || !task.parameterSnapshot.licenseReference)
  ) {
    throw new PodArtworkInputPolicyError("Licensed brand fusion requires rights attestation and a license reference");
  }
  if (CreativeDesignToolKeySchema.safeParse(task.toolKey).success) {
    const parameters = CreativeDesignParameterSnapshotSchema.safeParse(task.parameterSnapshot);
    if (!parameters.success || parameters.data.designTool !== task.toolKey) {
      throw new PodArtworkInputPolicyError("Creative design parameter snapshot is invalid or belongs to another tool");
    }
    if (task.inputAssets.length > 100) throw new PodArtworkInputPolicyError("Creative design supports at most one hundred pinned images");
    const supported = new Set(["image/png", "image/jpeg", "image/webp", "image/tiff"]);
    if (task.inputAssets.some((asset) => !supported.has(asset.mediaType))) {
      throw new PodArtworkInputPolicyError("Creative design inputs must be supported raster images");
    }
  }
  if (ListingAssetToolKeySchema.safeParse(task.toolKey).success) {
    const parameters = ListingAssetParameterSnapshotSchema.safeParse(task.parameterSnapshot);
    if (!parameters.success || parameters.data.listingTool !== task.toolKey) {
      throw new PodArtworkInputPolicyError("Listing asset parameter snapshot is invalid or belongs to another tool");
    }
    const maximum = task.toolKey === "virtual_try_on" ? 2 : 20;
    if (task.inputAssets.length < 1 || task.inputAssets.length > maximum) {
      throw new PodArtworkInputPolicyError(`Listing asset task requires between one and ${maximum} pinned images`);
    }
    const supported = new Set(["image/png", "image/jpeg", "image/webp", "image/tiff"]);
    if (task.inputAssets.some((asset) => !supported.has(asset.mediaType))) {
      throw new PodArtworkInputPolicyError("Listing asset inputs must be supported raster images");
    }
  }
  if (task.toolKey === "pattern_crop") {
    if (!PatternCropParameterSnapshotSchema.safeParse(task.parameterSnapshot).success) {
      throw new PodArtworkInputPolicyError("Pattern crop parameter snapshot is invalid");
    }
    validatePrintExtractionInputs(task, "Pattern crop");
  }
  if (task.toolKey === "print_extract") {
    if (!PrintExtractParameterSnapshotSchema.safeParse(task.parameterSnapshot).success) {
      throw new PodArtworkInputPolicyError("Print extraction parameter snapshot is invalid");
    }
    validatePrintExtractionInputs(task, "Print extraction");
  }
  if (
    task.toolKey === "authorized_watermark_remove"
    && task.parameterSnapshot.rightsAttested !== true
  ) {
    throw new PodArtworkInputPolicyError("Authorized watermark removal requires an explicit rights attestation");
  }
  const patternProcessingSchemas: Record<string, { safeParse(input: unknown): { success: boolean } }> = {
    background_remove: BackgroundRemoveParameterSnapshotSchema,
    super_resolution: SuperResolutionParameterSnapshotSchema,
    outpaint: OutpaintParameterSnapshotSchema,
    crop_compress: CropCompressParameterSnapshotSchema,
    vectorize: VectorizeParameterSnapshotSchema,
    authorized_watermark_remove: AuthorizedWatermarkRemoveParameterSnapshotSchema,
  };
  const patternProcessingSchema = patternProcessingSchemas[task.toolKey];
  if (patternProcessingSchema) {
    if (!patternProcessingSchema.safeParse(task.parameterSnapshot).success) {
      throw new PodArtworkInputPolicyError(`Pattern processing parameter snapshot is invalid for ${task.toolKey}`);
    }
    validatePrintExtractionInputs(task, "Pattern processing");
  }
  if (
    task.toolKey === "licensed_brand_fusion"
    && (task.parameterSnapshot.rightsAttested !== true || typeof task.parameterSnapshot.licenseReference !== "string")
  ) {
    throw new PodArtworkInputPolicyError("Licensed brand fusion requires rights attestation and a license reference");
  }
  if (task.toolKey === "piece_compose") {
    const parameters = PieceComposeParameterSnapshotSchema.safeParse(task.parameterSnapshot);
    if (!parameters.success) throw new PodArtworkInputPolicyError("Piece compose parameter snapshot is invalid");
    if (parameters.data.pieceKeys.length !== task.inputAssets.length) {
      throw new PodArtworkInputPolicyError("Piece compose requires one stable piece key per pinned input asset");
    }
  }
  if (task.toolKey === "piece_extract") {
    if (!PieceExtractParameterSnapshotSchema.safeParse(task.parameterSnapshot).success) {
      throw new PodArtworkInputPolicyError("Piece extraction parameter snapshot is invalid");
    }
    if (task.inputAssets.length !== 1) {
      throw new PodArtworkInputPolicyError("Piece extraction requires exactly one pinned source image or template");
    }
  }
  if (task.toolKey === "uv_layers") {
    if (!UvLayersParameterSnapshotSchema.safeParse(task.parameterSnapshot).success) {
      throw new PodArtworkInputPolicyError("UV layer parameter snapshot is invalid");
    }
    if (task.inputAssets.length !== 1) {
      throw new PodArtworkInputPolicyError("UV layer separation requires exactly one pinned source image or template");
    }
  }
  if (task.toolKey === "product_video") {
    if (!ProductVideoParameterSnapshotSchema.safeParse(task.parameterSnapshot).success) {
      throw new PodArtworkInputPolicyError("Product video parameter snapshot is invalid");
    }
    if (task.inputAssets.length < 1 || task.inputAssets.length > 20) {
      throw new PodArtworkInputPolicyError("Product video requires between one and twenty pinned images");
    }
    const supported = new Set(["image/png", "image/jpeg", "image/webp", "image/tiff"]);
    if (task.inputAssets.some((asset) => !supported.has(asset.mediaType))) {
      throw new PodArtworkInputPolicyError("Product video inputs must be supported raster images");
    }
  }
}

function validatePrintExtractionInputs(task: PodArtworkExecutionRecord, label: string) {
  if (task.inputAssets.length < 1 || task.inputAssets.length > 100) {
    throw new PodArtworkInputPolicyError(`${label} requires between one and one hundred pinned images`);
  }
  const rasterTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/tiff"]);
  if (task.inputAssets.some((asset) => !rasterTypes.has(asset.mediaType))) {
    throw new PodArtworkInputPolicyError(`${label} accepts only PNG, JPEG, WebP, or TIFF source images`);
  }
}

function validateResult(task: PodArtworkExecutionRecord, result: PodArtworkExecutionResult) {
  if (!result.outputs.length) throw new Error("POD artwork processor returned no outputs");
  if (!result.modelKey || !result.modelVersion) throw new Error("POD artwork result is missing model provenance");
  for (const output of result.outputs) {
    if (!output.bytes.byteLength) throw new Error("POD artwork processor returned an empty output");
  }
  if (task.toolKey === "rights_risk_scan") return validateRightsRiskResult(task, result);
  if (CreativeDesignToolKeySchema.safeParse(task.toolKey).success) return validateCreativeDesignResult(task, result);
  if (ListingAssetToolKeySchema.safeParse(task.toolKey).success) return validateListingAssetResult(task, result);
  if (task.toolKey === "pattern_crop") return validatePatternCropResult(task, result);
  if (task.toolKey === "print_extract") return validatePrintExtractResult(task, result);
  if (["background_remove", "super_resolution", "outpaint", "crop_compress", "vectorize", "authorized_watermark_remove"].includes(task.toolKey)) {
    return validatePatternProcessingResult(task, result);
  }
  if (task.toolKey === "piece_compose") return validatePieceComposeResult(task, result);
  if (task.toolKey === "piece_extract") return validatePieceExtractResult(task, result);
  if (task.toolKey === "uv_layers") return validateUvLayersResult(task, result);
  if (task.toolKey === "product_video") return validateProductVideoResult(task, result);
  return result;
}

function validateRightsRiskResult(
  task: PodArtworkExecutionRecord,
  result: PodArtworkExecutionResult,
): PodArtworkExecutionResult {
  const parameters = RightsRiskScanParameterSnapshotSchema.parse(task.parameterSnapshot);
  const quality = RightsRiskQualityCheckSnapshotSchema.safeParse(result.qualityCheckSnapshot);
  if (
    !quality.success
    || quality.data.depth !== parameters.depth
    || quality.data.detectorModelKey !== result.modelKey
    || quality.data.detectorModelVersion !== result.modelVersion
  ) {
    throw new PodArtworkOutputPolicyError("RIGHTS_RISK_QUALITY_INVALID", "Rights risk result is missing strict source, model, expiry, and per-input evidence");
  }
  const expectedValidityMs = parameters.validityDays * 24 * 60 * 60 * 1_000;
  if (new Date(quality.data.validUntil).getTime() - new Date(quality.data.checkedAt).getTime() !== expectedValidityMs) {
    throw new PodArtworkOutputPolicyError("RIGHTS_RISK_EXPIRY_INVALID", "Rights risk report expiry does not match the pinned validity window");
  }
  if (result.partial || result.outputs.length !== task.inputAssets.length || quality.data.outputChecks.length !== task.inputAssets.length) {
    throw new PodArtworkOutputPolicyError("RIGHTS_RISK_OUTPUT_COUNT_INVALID", "Rights risk scan must return exactly one complete report per pinned input");
  }
  const outputNames = result.outputs.map((output) => output.fileName);
  const checkNames = quality.data.outputChecks.map((check) => check.fileName);
  const expectedOrdinals = task.inputAssets.map((_, index) => index);
  if (
    new Set(outputNames).size !== outputNames.length
    || !sameStringMembers(outputNames, checkNames)
    || !sameNumberMembers(quality.data.outputChecks.map((check) => check.inputOrdinal), expectedOrdinals)
  ) {
    throw new PodArtworkOutputPolicyError("RIGHTS_RISK_FILE_MAP_INVALID", "Rights risk report files must uniquely cover every pinned input");
  }

  for (const output of result.outputs) {
    const check = quality.data.outputChecks.find((candidate) => candidate.fileName === output.fileName)!;
    if (
      output.role !== "effect"
      || output.mediaType !== "text/plain"
      || !output.fileName.toLowerCase().endsWith(".json")
      || output.bytes.byteLength > 1_000_000
      || output.metadata.aiInference !== "none"
      || output.metadata.inferenceRegions?.length
      || output.metadata.width !== undefined
      || output.metadata.height !== undefined
      || output.metadata.transparent !== undefined
    ) {
      throw new PodArtworkOutputPolicyError("RIGHTS_RISK_REPORT_INVALID", "Rights risk reports must be small non-visual JSON evidence files");
    }
    const file = parseRightsRiskReportFile(output.bytes);
    if (
      !file
      || file.inputOrdinal !== check.inputOrdinal
      || file.legalRisk !== check.legalRisk
      || file.checkedAt !== quality.data.checkedAt
      || file.evidenceCount !== check.evidence.length
      || file.visualSimilarityPermille !== check.visualSimilarityPermille
    ) {
      throw new PodArtworkOutputPolicyError("RIGHTS_RISK_REPORT_MISMATCH", "Rights risk report file does not match the review evidence");
    }
    if (
      check.visualSimilarityEvaluated !== parameters.visualSimilarity
      || (!parameters.visualSimilarity && (check.visualCandidateCount !== 0 || check.visualSimilarityPermille !== undefined))
    ) {
      throw new PodArtworkOutputPolicyError("RIGHTS_RISK_VISUAL_EVIDENCE_INVALID", "Visual similarity must remain separate and match the pinned scan plan");
    }
  }

  return {
    ...result,
    partial: false,
    qualityCheckSnapshot: {
      ...quality.data,
      sourceChecks: quality.data.sourceChecks.map((source) => ({ ...source })),
      missingSourceKeys: [...quality.data.missingSourceKeys],
      outputChecks: quality.data.outputChecks.map((check) => ({
        ...check,
        ruleHits: check.ruleHits.map((hit) => ({ ...hit, evidenceIds: [...hit.evidenceIds] })),
        evidence: check.evidence.map((evidence) => ({ ...evidence })),
      })),
    },
  };
}

function parseRightsRiskReportFile(bytes: Uint8Array) {
  try {
    const decoded: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const parsed = RightsRiskReportFileSchema.safeParse(decoded);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function validateCreativeDesignResult(
  task: PodArtworkExecutionRecord,
  result: PodArtworkExecutionResult,
): PodArtworkExecutionResult {
  const parameters = CreativeDesignParameterSnapshotSchema.parse(task.parameterSnapshot);
  const quality = CreativeDesignQualityCheckSnapshotSchema.safeParse(result.qualityCheckSnapshot);
  const promptMaterial = [parameters.prompt, ...(parameters.batchPrompts ?? [])].join("\n");
  const expectedPromptHash = createHash("sha256").update(promptMaterial, "utf8").digest("hex");
  if (
    !quality.success
    || quality.data.toolKey !== task.toolKey
    || quality.data.finalPromptHashSha256 !== expectedPromptHash
  ) {
    throw new PodArtworkOutputPolicyError("CREATIVE_DESIGN_QUALITY_INVALID", "Creative design result is missing strict prompt, input, safety, and output evidence");
  }
  if (
    result.partial
    || result.outputs.length !== parameters.outputCount
    || quality.data.outputChecks.length !== parameters.outputCount
  ) {
    throw new PodArtworkOutputPolicyError("CREATIVE_DESIGN_OUTPUT_COUNT_INVALID", "Creative design must return the complete pinned output count");
  }
  if (parameters.markAiGenerated && !result.seed) {
    throw new PodArtworkOutputPolicyError("CREATIVE_DESIGN_SEED_MISSING", "AI-generated creative output requires a reproducibility seed");
  }
  if (!parameters.markAiGenerated && result.seed) {
    throw new PodArtworkOutputPolicyError("CREATIVE_DESIGN_SEED_INVALID", "Deterministic creative transforms cannot claim an AI seed");
  }
  const outputNames = result.outputs.map((output) => output.fileName);
  const checkNames = quality.data.outputChecks.map((check) => check.fileName);
  const expectedInputOrdinals = task.inputAssets.map((_, index) => index);
  if (new Set(outputNames).size !== outputNames.length || !sameStringMembers(outputNames, checkNames)) {
    throw new PodArtworkOutputPolicyError("CREATIVE_DESIGN_FILE_MAP_INVALID", "Creative design files must have one unique quality record each");
  }

  for (const output of result.outputs) {
    const check = quality.data.outputChecks.find((candidate) => candidate.fileName === output.fileName)!;
    if (
      !sameNumberMembers(check.sourceInputOrdinals, expectedInputOrdinals)
      || output.role !== "effect"
      || output.mediaType !== "image/png"
      || !output.fileName.toLowerCase().endsWith(".png")
      || output.metadata.width !== check.width
      || output.metadata.height !== check.height
      || output.metadata.unit !== "px"
      || output.metadata.colorMode !== "rgb"
      || output.metadata.transparent !== check.transparent
      || output.metadata.aiInference !== check.aiInference
      || !sameInferenceRectangles(output.metadata.inferenceRegions ?? [], check.generatedRegions)
    ) {
      throw new PodArtworkOutputPolicyError("CREATIVE_DESIGN_OUTPUT_INVALID", "Creative design output metadata or pinned input coverage does not match review evidence");
    }
    const expectedInference = task.toolKey === "seamless_stitch"
      ? "none"
      : task.toolKey === "canvas_extend" ? "partial" : "full";
    if (check.aiInference !== expectedInference) {
      throw new PodArtworkOutputPolicyError("CREATIVE_DESIGN_AI_MARK_INVALID", "Creative design AI provenance does not match the selected tool");
    }
    if (task.toolKey === "canvas_extend" && !check.generatedRegions.length) {
      throw new PodArtworkOutputPolicyError("CANVAS_EXTEND_REGION_MISSING", "Canvas extension requires marked AI-generated rectangles");
    }
    if (task.toolKey === "seamless_pattern" || task.toolKey === "seamless_stitch") {
      const verticalRequired = parameters.repeatType === "four_way";
      if (
        check.horizontalSeamPassed !== true
        || (verticalRequired && check.verticalSeamPassed !== true)
        || check.tilePreviewValidated !== true
      ) {
        throw new PodArtworkOutputPolicyError("SEAMLESS_DESIGN_CHECK_INVALID", "Seamless output requires the pinned directional seam checks and tile preview");
      }
    }
  }
  const covered = new Set(quality.data.outputChecks.flatMap((check) => check.sourceInputOrdinals));
  if (!sameNumberMembers([...covered], expectedInputOrdinals)) {
    throw new PodArtworkOutputPolicyError("CREATIVE_DESIGN_INPUT_COVERAGE_INVALID", "Creative design review evidence must cover every pinned input");
  }

  return {
    ...result,
    partial: false,
    qualityCheckSnapshot: {
      ...quality.data,
      outputChecks: quality.data.outputChecks.map((check) => ({
        ...check,
        sourceInputOrdinals: [...check.sourceInputOrdinals],
        generatedRegions: check.generatedRegions.map((region) => ({ ...region })),
      })),
    },
  };
}

function validateListingAssetResult(
  task: PodArtworkExecutionRecord,
  result: PodArtworkExecutionResult,
): PodArtworkExecutionResult {
  const parameters = ListingAssetParameterSnapshotSchema.parse(task.parameterSnapshot);
  const quality = ListingAssetQualityCheckSnapshotSchema.safeParse(result.qualityCheckSnapshot);
  if (
    !quality.success
    || quality.data.toolKey !== task.toolKey
    || quality.data.platform !== parameters.platform
    || quality.data.locale !== parameters.locale
    || quality.data.requestedOutputCount !== parameters.outputCount
  ) {
    throw new PodArtworkOutputPolicyError("LISTING_ASSET_QUALITY_INVALID", "Listing asset result is missing strict fact, identity, safety, and output evidence");
  }
  const partialAllowed = task.toolKey === "product_suite";
  if (
    result.outputs.length !== quality.data.successfulOutputCount
    || result.partial !== (quality.data.failedOutputCount > 0)
    || (!partialAllowed && result.partial)
  ) {
    throw new PodArtworkOutputPolicyError("LISTING_ASSET_OUTPUT_COUNT_INVALID", "Listing asset outputs do not reconcile with the pinned task and isolated failures");
  }
  if (!result.seed) {
    throw new PodArtworkOutputPolicyError("LISTING_ASSET_SEED_MISSING", "AI-generated listing assets require a reproducibility seed");
  }
  const outputNames = result.outputs.map((output) => output.fileName);
  const checkNames = quality.data.outputChecks.map((check) => check.fileName);
  if (new Set(outputNames).size !== outputNames.length || !sameStringMembers(outputNames, checkNames)) {
    throw new PodArtworkOutputPolicyError("LISTING_ASSET_FILE_MAP_INVALID", "Listing asset files must have one unique quality record each");
  }
  const expectedInputOrdinals = task.inputAssets.map((_, index) => index);
  const covered = new Set<number>();
  for (const output of result.outputs) {
    const check = quality.data.outputChecks.find((candidate) => candidate.fileName === output.fileName)!;
    check.sourceInputOrdinals.forEach((ordinal) => covered.add(ordinal));
    if (check.sourceInputOrdinals.some((ordinal) => !expectedInputOrdinals.includes(ordinal))) {
      throw new PodArtworkOutputPolicyError("LISTING_ASSET_INPUT_REFERENCE_INVALID", "Listing asset evidence references an unpinned input");
    }
    if (check.contentKind === "title") {
      const decoded = decodeUtf8(output.bytes);
      const expectedHash = createHash("sha256").update(output.bytes).digest("hex");
      if (
        output.role !== "effect"
        || output.mediaType !== "text/plain"
        || !output.fileName.toLowerCase().endsWith(".txt")
        || output.bytes.byteLength > 10_000
        || output.metadata.aiInference !== "full"
        || output.metadata.inferenceRegions?.length
        || output.metadata.width !== undefined
        || output.metadata.height !== undefined
        || decoded !== check.title
        || expectedHash !== check.contentHashSha256
      ) {
        throw new PodArtworkOutputPolicyError("TITLE_DRAFT_OUTPUT_INVALID", "Title draft text, hash, AI provenance, or review evidence does not match the output file");
      }
      continue;
    }
    if (
      output.role !== "effect"
      || output.mediaType !== "image/png"
      || !output.fileName.toLowerCase().endsWith(".png")
      || output.metadata.width !== check.width
      || output.metadata.height !== check.height
      || output.metadata.unit !== "px"
      || output.metadata.colorMode !== "rgb"
      || output.metadata.transparent !== check.transparent
      || output.metadata.aiInference !== check.aiInference
      || !sameInferenceRectangles(output.metadata.inferenceRegions ?? [], check.generatedRegions)
    ) {
      throw new PodArtworkOutputPolicyError("LISTING_IMAGE_OUTPUT_INVALID", "Listing image metadata, AI regions, or review evidence does not match the output file");
    }
    const expectedInference = task.toolKey === "background_replace" ? "partial" : "full";
    if (check.aiInference !== expectedInference) {
      throw new PodArtworkOutputPolicyError("LISTING_IMAGE_AI_MARK_INVALID", "Listing image AI provenance does not match the selected tool");
    }
  }
  if (!sameNumberMembers([...covered], expectedInputOrdinals)) {
    throw new PodArtworkOutputPolicyError("LISTING_ASSET_INPUT_COVERAGE_INVALID", "Listing asset evidence must cover every pinned input");
  }
  return {
    ...result,
    partial: quality.data.failedOutputCount > 0,
    qualityCheckSnapshot: {
      ...quality.data,
      outputChecks: quality.data.outputChecks.map((check) => ({
        ...check,
        sourceInputOrdinals: [...check.sourceInputOrdinals],
        ...(check.contentKind === "image" ? { generatedRegions: check.generatedRegions.map((region) => ({ ...region })) } : {
          unsupportedFactKeys: [...check.unsupportedFactKeys],
          keywordSources: [...check.keywordSources],
        }),
      })),
      failedOutputs: quality.data.failedOutputs.map((failure) => ({ ...failure })),
    },
  };
}

function decodeUtf8(bytes: Uint8Array) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function validatePatternCropResult(
  task: PodArtworkExecutionRecord,
  result: PodArtworkExecutionResult,
): PodArtworkExecutionResult {
  const parameters = PatternCropParameterSnapshotSchema.parse(task.parameterSnapshot) as PatternCropParameterSnapshot;
  const quality = PatternCropQualityCheckSnapshotSchema.safeParse(result.qualityCheckSnapshot);
  if (!quality.success || quality.data.mode !== parameters.mode) {
    throw new PodArtworkOutputPolicyError("PATTERN_CROP_QUALITY_INVALID", "Pattern crop result is missing strict bounds, coverage, and file evidence");
  }
  if (result.partial || result.outputs.length !== quality.data.outputChecks.length) {
    throw new PodArtworkOutputPolicyError("PATTERN_CROP_OUTPUT_COUNT_INVALID", "Pattern crop must return one complete file for every crop check");
  }
  const expectedMediaType = parameters.outputFormat === "png" ? "image/png" : "image/jpeg";
  const expectedTransparent = parameters.background === "transparent";
  const outputNames = result.outputs.map((output) => output.fileName);
  const checkNames = quality.data.outputChecks.map((check) => check.fileName);
  if (new Set(outputNames).size !== outputNames.length || !sameStringMembers(outputNames, checkNames)) {
    throw new PodArtworkOutputPolicyError("PATTERN_CROP_FILE_MAP_INVALID", "Pattern crop output names must uniquely match the quality evidence");
  }
  const expectedOrdinals = task.inputAssets.map((_, index) => index);
  const coveredOrdinals = [...new Set(quality.data.outputChecks.map((check) => check.inputOrdinal))];
  if (!sameNumberMembers(coveredOrdinals, expectedOrdinals)) {
    throw new PodArtworkOutputPolicyError("PATTERN_CROP_INPUT_COVERAGE_INVALID", "Pattern crop quality evidence must cover every pinned input");
  }
  for (const inputOrdinal of expectedOrdinals) {
    const inputChecks = quality.data.outputChecks.filter((check) => check.inputOrdinal === inputOrdinal).sort((left, right) => left.cropIndex - right.cropIndex);
    if (
      inputChecks.length < 1
      || inputChecks.length > parameters.maximumCropsPerInput
      || (!parameters.multiCrop && inputChecks.length !== 1)
      || inputChecks.some((check, index) => check.cropIndex !== index)
    ) {
      throw new PodArtworkOutputPolicyError("PATTERN_CROP_INDEX_INVALID", "Pattern crop indices must be contiguous and remain within the pinned per-input limit");
    }
  }
  for (const output of result.outputs) {
    const check = quality.data.outputChecks.find((candidate) => candidate.fileName === output.fileName)!;
    const extensionValid = parameters.outputFormat === "png"
      ? output.fileName.toLowerCase().endsWith(".png")
      : /\.jpe?g$/i.test(output.fileName);
    if (
      output.role !== "effect"
      || output.mediaType !== expectedMediaType
      || !extensionValid
      || output.metadata.width !== check.outputWidth
      || output.metadata.height !== check.outputHeight
      || output.metadata.unit !== "px"
      || output.metadata.colorMode !== "rgb"
      || output.metadata.transparent !== expectedTransparent
      || check.transparent !== expectedTransparent
      || output.metadata.aiInference !== "none"
      || (output.metadata.inferenceRegions?.length ?? 0) !== 0
      || (parameters.resultLabel !== undefined && check.resultLabel !== parameters.resultLabel)
    ) {
      throw new PodArtworkOutputPolicyError("PATTERN_CROP_OUTPUT_INVALID", "Pattern crop output metadata or labels do not match the pinned crop plan");
    }
  }
  return {
    ...result,
    partial: false,
    qualityCheckSnapshot: {
      passed: true,
      mode: parameters.mode,
      inputCoverageComplete: true,
      cropBoundsValid: true,
      blankOutputsDetected: false,
      duplicateOutputsDetected: false,
      outputChecks: quality.data.outputChecks.map((check) => ({ ...check, sourceBounds: { ...check.sourceBounds } })),
      ...(quality.data.processorDeploymentId ? { processorDeploymentId: quality.data.processorDeploymentId } : {}),
    },
  };
}

function validatePrintExtractResult(
  task: PodArtworkExecutionRecord,
  result: PodArtworkExecutionResult,
): PodArtworkExecutionResult {
  const parameters = PrintExtractParameterSnapshotSchema.parse(task.parameterSnapshot) as PrintExtractParameterSnapshot;
  const quality = PrintExtractQualityCheckSnapshotSchema.safeParse(result.qualityCheckSnapshot);
  if (!quality.success || quality.data.mode !== parameters.mode) {
    throw new PodArtworkOutputPolicyError("PRINT_EXTRACT_QUALITY_INVALID", "Print extraction result is missing strict correction, AI-region, and file evidence");
  }
  if (result.partial || result.outputs.length !== task.inputAssets.length || quality.data.outputChecks.length !== task.inputAssets.length) {
    throw new PodArtworkOutputPolicyError("PRINT_EXTRACT_OUTPUT_COUNT_INVALID", "Print extraction must return exactly one complete result for every pinned input");
  }
  const expectedMediaType = parameters.outputFormat === "png" ? "image/png" : "image/jpeg";
  const expectedTransparent = parameters.outputBackground === "transparent";
  const outputNames = result.outputs.map((output) => output.fileName);
  const checkNames = quality.data.outputChecks.map((check) => check.fileName);
  const expectedOrdinals = task.inputAssets.map((_, index) => index);
  if (
    new Set(outputNames).size !== outputNames.length
    || !sameStringMembers(outputNames, checkNames)
    || !sameNumberMembers(quality.data.outputChecks.map((check) => check.inputOrdinal), expectedOrdinals)
  ) {
    throw new PodArtworkOutputPolicyError("PRINT_EXTRACT_FILE_MAP_INVALID", "Print extraction files and input ordinals must uniquely cover every pinned input");
  }
  const inferredRegionCount = quality.data.outputChecks.reduce((sum, check) => sum + check.inferredRegions.length, 0);
  if (quality.data.aiInferencePresent !== (inferredRegionCount > 0) || (!parameters.restoreOccludedAreas && inferredRegionCount > 0)) {
    throw new PodArtworkOutputPolicyError("PRINT_EXTRACT_AI_EVIDENCE_INVALID", "Print extraction AI inference does not match the pinned restoration plan");
  }
  for (const output of result.outputs) {
    const check = quality.data.outputChecks.find((candidate) => candidate.fileName === output.fileName)!;
    const extensionValid = parameters.outputFormat === "png"
      ? output.fileName.toLowerCase().endsWith(".png")
      : /\.jpe?g$/i.test(output.fileName);
    const inferenceExpected = check.inferredRegions.length > 0;
    if (
      output.role !== "effect"
      || output.mediaType !== expectedMediaType
      || !extensionValid
      || output.metadata.width !== check.width
      || output.metadata.height !== check.height
      || output.metadata.unit !== "px"
      || output.metadata.colorMode !== "rgb"
      || output.metadata.transparent !== expectedTransparent
      || check.transparent !== expectedTransparent
      || check.completeness < parameters.minimumCompleteness
      || output.metadata.aiInference !== (inferenceExpected ? "partial" : "none")
      || !sameInferenceRectangles(output.metadata.inferenceRegions ?? [], check.inferredRegions)
      || check.inferredRegions.some((region) => region.x + region.width > check.width || region.y + region.height > check.height)
    ) {
      throw new PodArtworkOutputPolicyError("PRINT_EXTRACT_OUTPUT_INVALID", "Print extraction output metadata, completeness, or marked AI regions do not match the pinned plan");
    }
  }
  return {
    ...result,
    partial: false,
    qualityCheckSnapshot: {
      passed: true,
      mode: parameters.mode,
      inputCoverageComplete: true,
      aiInferencePresent: inferredRegionCount > 0,
      inferredAreasMarked: true,
      blankOutputsDetected: false,
      duplicateOutputsDetected: false,
      outputChecks: quality.data.outputChecks.map((check) => ({
        ...check,
        inferredRegions: check.inferredRegions.map((region) => ({ ...region })),
      })),
      ...(quality.data.processorDeploymentId ? { processorDeploymentId: quality.data.processorDeploymentId } : {}),
    },
  };
}

function sameInferenceRectangles(
  metadataRegions: Array<{ x: number; y: number; width: number; height: number }>,
  evidenceRegions: Array<{ x: number; y: number; width: number; height: number }>,
) {
  return metadataRegions.length === evidenceRegions.length && evidenceRegions.every((region) => (
    metadataRegions.some((candidate) => candidate.x === region.x && candidate.y === region.y && candidate.width === region.width && candidate.height === region.height)
  ));
}

function validatePatternProcessingResult(
  task: PodArtworkExecutionRecord,
  result: PodArtworkExecutionResult,
): PodArtworkExecutionResult {
  const quality = PatternProcessingQualityCheckSnapshotSchema.safeParse(result.qualityCheckSnapshot);
  if (!quality.success || quality.data.toolKey !== task.toolKey) {
    throw new PodArtworkOutputPolicyError("PATTERN_PROCESSING_QUALITY_INVALID", "Pattern processing result is missing strict input, artifact, generated-region, and file evidence");
  }
  if (result.partial || result.outputs.length !== task.inputAssets.length || quality.data.outputChecks.length !== task.inputAssets.length) {
    throw new PodArtworkOutputPolicyError("PATTERN_PROCESSING_OUTPUT_COUNT_INVALID", "Pattern processing must return exactly one complete output per pinned input");
  }
  const outputNames = result.outputs.map((output) => output.fileName);
  const checkNames = quality.data.outputChecks.map((check) => check.fileName);
  const expectedOrdinals = task.inputAssets.map((_, index) => index);
  if (
    new Set(outputNames).size !== outputNames.length
    || !sameStringMembers(outputNames, checkNames)
    || !sameNumberMembers(quality.data.outputChecks.map((check) => check.inputOrdinal), expectedOrdinals)
    || quality.data.outputChecks.some((check) => check.operation !== task.toolKey)
  ) {
    throw new PodArtworkOutputPolicyError("PATTERN_PROCESSING_FILE_MAP_INVALID", "Pattern processing files and evidence must uniquely cover every pinned input");
  }

  for (const output of result.outputs) {
    const check = quality.data.outputChecks.find((candidate) => candidate.fileName === output.fileName)!;
    if (
      output.role !== "effect"
      || output.metadata.width !== check.width
      || output.metadata.height !== check.height
      || output.metadata.unit !== "px"
      || output.metadata.dpi !== check.dpi
      || output.metadata.colorMode !== check.colorMode
      || output.metadata.transparent !== check.transparent
      || !sameInferenceRectangles(output.metadata.inferenceRegions ?? [], check.generatedRegions)
    ) {
      throw new PodArtworkOutputPolicyError("PATTERN_PROCESSING_METADATA_INVALID", "Pattern processing output metadata does not match the review evidence");
    }

    if (task.toolKey === "background_remove") {
      const parameters = BackgroundRemoveParameterSnapshotSchema.parse(task.parameterSnapshot);
      assertPatternProcessingFormat(output, check, parameters.outputFormat);
      if (
        !check.transparent
        || check.generatedRegions.length
        || output.metadata.aiInference !== "none"
        || check.sourceWidth !== check.width
        || check.sourceHeight !== check.height
      ) {
        throw new PodArtworkOutputPolicyError("BACKGROUND_REMOVE_OUTPUT_INVALID", "Background removal must preserve source dimensions and return a non-generative transparent PNG");
      }
    } else if (task.toolKey === "super_resolution") {
      const parameters = SuperResolutionParameterSnapshotSchema.parse(task.parameterSnapshot);
      assertPatternProcessingFormat(output, check, parameters.outputFormat);
      const enhancementRegion = check.generatedRegions[0];
      if (
        !check.sourceWidth
        || !check.sourceHeight
        || check.width !== check.sourceWidth * parameters.scale
        || check.height !== check.sourceHeight * parameters.scale
        || check.dpi !== parameters.dpi
        || check.generatedRegions.length !== 1
        || !enhancementRegion
        || enhancementRegion.reason !== "enhancement"
        || enhancementRegion.x !== 0
        || enhancementRegion.y !== 0
        || enhancementRegion.width !== check.width
        || enhancementRegion.height !== check.height
        || output.metadata.aiInference !== "full"
      ) {
        throw new PodArtworkOutputPolicyError("SUPER_RESOLUTION_OUTPUT_INVALID", "Super-resolution dimensions, DPI, or full-image AI enhancement evidence do not match the pinned scale");
      }
    } else if (task.toolKey === "outpaint") {
      const parameters = OutpaintParameterSnapshotSchema.parse(task.parameterSnapshot);
      assertPatternProcessingFormat(output, check, parameters.outputFormat);
      const [ratioWidth, ratioHeight] = parameters.aspectRatio.split(":").map(Number) as [number, number];
      if (
        Math.abs(check.width / check.height - ratioWidth / ratioHeight) > 1 / Math.max(check.width, check.height)
        || !check.generatedRegions.length
        || (output.metadata.aiInference !== "partial" && output.metadata.aiInference !== "full")
      ) {
        throw new PodArtworkOutputPolicyError("OUTPAINT_OUTPUT_INVALID", "Outpaint output must match the pinned aspect ratio and expose every generated region");
      }
    } else if (task.toolKey === "crop_compress") {
      const parameters = CropCompressParameterSnapshotSchema.parse(task.parameterSnapshot);
      assertPatternProcessingFormat(output, check, parameters.format);
      if (
        check.width !== parameters.width
        || check.height !== parameters.height
        || check.dpi !== parameters.dpi
        || check.colorMode !== parameters.colorSpace
        || check.transparent !== parameters.preserveTransparency
        || check.generatedRegions.length
        || output.metadata.aiInference !== "none"
      ) {
        throw new PodArtworkOutputPolicyError("CROP_COMPRESS_OUTPUT_INVALID", "Crop/compress output does not match the pinned size, DPI, color, or transparency plan");
      }
    } else if (task.toolKey === "vectorize") {
      const parameters = VectorizeParameterSnapshotSchema.parse(task.parameterSnapshot);
      assertPatternProcessingFormat(output, check, parameters.format);
      if (
        !check.pathCount
        || check.pathsClosed !== parameters.closePaths
        || check.colorMode !== parameters.colorMode
        || !check.transparent
        || check.generatedRegions.length
        || output.metadata.aiInference !== "none"
        || !safeVectorOutput(output.bytes, parameters.format)
      ) {
        throw new PodArtworkOutputPolicyError("VECTORIZE_OUTPUT_INVALID", "Vector output is unsafe or missing strict path, color, and transparency evidence");
      }
    } else if (task.toolKey === "authorized_watermark_remove") {
      const parameters = AuthorizedWatermarkRemoveParameterSnapshotSchema.parse(task.parameterSnapshot);
      assertPatternProcessingFormat(output, check, parameters.outputFormat);
      if (!check.generatedRegions.length || output.metadata.aiInference !== "partial") {
        throw new PodArtworkOutputPolicyError("WATERMARK_REMOVE_OUTPUT_INVALID", "Authorized watermark removal must expose every inpainted region for review");
      }
    }
  }

  return {
    ...result,
    partial: false,
    qualityCheckSnapshot: {
      passed: true,
      toolKey: task.toolKey,
      inputCoverageComplete: true,
      blankOutputsDetected: false,
      artifactDetected: false,
      generatedAreasMarked: true,
      outputChecks: quality.data.outputChecks.map((check) => ({
        ...check,
        generatedRegions: check.generatedRegions.map((region) => ({ ...region })),
      })),
      ...(quality.data.processorDeploymentId ? { processorDeploymentId: quality.data.processorDeploymentId } : {}),
    },
  };
}

function assertPatternProcessingFormat(
  output: PodArtworkExecutionResult["outputs"][number],
  check: { format: "png" | "jpeg" | "webp" | "tiff" | "svg" | "eps" },
  format: "png" | "jpeg" | "webp" | "tiff" | "svg" | "eps",
) {
  const mediaTypes = {
    png: "image/png", jpeg: "image/jpeg", webp: "image/webp", tiff: "image/tiff",
    svg: "image/svg+xml", eps: "application/postscript",
  } as const;
  const extensionValid = format === "jpeg" ? /\.jpe?g$/i.test(output.fileName) : output.fileName.toLowerCase().endsWith(`.${format}`);
  if (check.format !== format || output.mediaType !== mediaTypes[format] || !extensionValid) {
    throw new PodArtworkOutputPolicyError("PATTERN_PROCESSING_FORMAT_INVALID", "Pattern processing output format does not match the pinned plan");
  }
}

function safeVectorOutput(bytes: Uint8Array, format: "svg" | "eps") {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
    if (format === "eps") return text.startsWith("%!PS-Adobe");
    if (!/^<svg(?:\s|>)/i.test(text)) return false;
    return !/<script\b|<foreignObject\b|javascript:|<!DOCTYPE|<!ENTITY|(?:href|xlink:href)\s*=\s*["'](?:https?:|\/\/|data:)/i.test(text);
  } catch {
    return false;
  }
}

function validateProductVideoResult(
  task: PodArtworkExecutionRecord,
  result: PodArtworkExecutionResult,
): PodArtworkExecutionResult {
  const parameters = ProductVideoParameterSnapshotSchema.parse(task.parameterSnapshot);
  const quality = ProductVideoQualityCheckSnapshotSchema.safeParse(result.qualityCheckSnapshot);
  if (!quality.success) {
    throw new PodArtworkOutputPolicyError("PRODUCT_VIDEO_QUALITY_INVALID", "Product video result is missing strict playback, input coverage, caption, audio, and file evidence");
  }
  if (result.partial || result.outputs.length !== 1) {
    throw new PodArtworkOutputPolicyError("PRODUCT_VIDEO_OUTPUT_COUNT_INVALID", "Product video must return exactly one complete MP4 output");
  }
  const output = result.outputs[0]!;
  if (output.mediaType !== "video/mp4" || output.role !== "effect" || !output.fileName.toLowerCase().endsWith(".mp4")) {
    throw new PodArtworkOutputPolicyError("PRODUCT_VIDEO_OUTPUT_INVALID", "Product video output must be an effect-role MP4 file");
  }
  if (output.bytes.length < 12 || new TextDecoder("ascii").decode(output.bytes.slice(4, 8)) !== "ftyp") {
    throw new PodArtworkOutputPolicyError("PRODUCT_VIDEO_CONTAINER_INVALID", "Product video output is not an MP4 container");
  }
  const dimensions = productVideoDimensions(parameters.resolution, parameters.aspectRatio);
  if (
    output.metadata.width !== dimensions.width
    || output.metadata.height !== dimensions.height
    || output.metadata.unit !== "px"
    || output.metadata.dpi !== undefined
    || output.metadata.colorMode !== "rgb"
    || output.metadata.transparent !== false
    || output.metadata.fps !== parameters.fps
    || output.metadata.videoCodec !== "h264"
    || Math.abs((output.metadata.durationSeconds ?? 0) - parameters.durationSeconds) > 0.05
  ) {
    throw new PodArtworkOutputPolicyError("PRODUCT_VIDEO_METADATA_MISMATCH", "Product video metadata does not match the pinned rendering plan");
  }
  if (!parameters.allowAiMotion && output.metadata.aiInference !== "none") {
    throw new PodArtworkOutputPolicyError("PRODUCT_VIDEO_AI_NOT_ALLOWED", "Product video used AI motion without pinned consent");
  }
  const expectedAudioCodec = parameters.soundtrackMode === "licensed" ? "aac" : "none";
  if (output.metadata.audioCodec !== expectedAudioCodec) {
    throw new PodArtworkOutputPolicyError("PRODUCT_VIDEO_AUDIO_MISMATCH", "Product video audio does not match the pinned soundtrack plan");
  }
  const check = quality.data.outputChecks[0]!;
  const expectedOrdinals = task.inputAssets.map((_, index) => index);
  if (
    check.fileName !== output.fileName
    || !sameNumberMembers(check.usedInputOrdinals, expectedOrdinals)
    || Math.abs(check.durationSeconds - parameters.durationSeconds) > 0.05
    || check.fps !== parameters.fps
    || check.width !== dimensions.width
    || check.height !== dimensions.height
    || check.videoCodec !== "h264"
    || check.audioCodec !== expectedAudioCodec
  ) {
    throw new PodArtworkOutputPolicyError("PRODUCT_VIDEO_EVIDENCE_MISMATCH", "Product video quality evidence does not match all pinned inputs and output parameters");
  }
  return {
    ...result,
    qualityCheckSnapshot: {
      passed: true,
      durationMatched: true,
      fpsMatched: true,
      dimensionsMatched: true,
      inputCoverageComplete: true,
      playbackValid: true,
      blankFramesDetected: false,
      corruptFramesDetected: false,
      safeAreaPassed: true,
      captionOverflowDetected: false,
      audioClippingDetected: false,
      soundtrackLicenseMatched: true,
      aiMotionEvidenceMatched: true,
      outputChecks: [{ ...check, usedInputOrdinals: [...check.usedInputOrdinals] }],
      ...(quality.data.processorDeploymentId ? { processorDeploymentId: quality.data.processorDeploymentId } : {}),
    },
  };
}

function productVideoDimensions(resolution: "720p" | "1080p", aspectRatio: "1:1" | "4:5" | "9:16" | "16:9") {
  const short = resolution === "1080p" ? 1080 : 720;
  return ({
    "1:1": { width: short, height: short },
    "4:5": { width: short, height: Math.round(short * 5 / 4) },
    "9:16": { width: short, height: Math.round(short * 16 / 9) },
    "16:9": { width: Math.round(short * 16 / 9), height: short },
  } as const)[aspectRatio];
}

function sameNumberMembers(left: number[], right: number[]) {
  if (left.length !== new Set(left).size || right.length !== new Set(right).size) return false;
  return left.length === right.length && left.every((entry) => right.includes(entry));
}

function sameStringMembers(left: string[], right: string[]) {
  if (left.length !== new Set(left).size || right.length !== new Set(right).size) return false;
  return left.length === right.length && left.every((entry) => right.includes(entry));
}

function validateUvLayersResult(
  task: PodArtworkExecutionRecord,
  result: PodArtworkExecutionResult,
): PodArtworkExecutionResult {
  const parameters = UvLayersParameterSnapshotSchema.parse(task.parameterSnapshot);
  const quality = UvLayersQualityCheckSnapshotSchema.safeParse(result.qualityCheckSnapshot);
  if (!quality.success) {
    throw new PodArtworkOutputPolicyError("UV_LAYERS_QUALITY_INVALID", "UV layer result is missing strict channel, conflict, and file evidence");
  }
  if (result.partial) {
    throw new PodArtworkOutputPolicyError("UV_LAYERS_PARTIAL", "UV layer separation cannot complete with a partial channel package");
  }
  const expectedMediaType = parameters.outputFormat === "png" ? "image/png" : "image/tiff";
  const outputNames = result.outputs.map((output) => output.fileName);
  if (new Set(outputNames).size !== outputNames.length) {
    throw new PodArtworkOutputPolicyError("UV_LAYERS_OUTPUT_INVALID", "UV layer output file names must be unique");
  }
  for (const output of result.outputs) {
    if (output.role !== "production" || (output.mediaType !== expectedMediaType && output.mediaType !== "application/zip")) {
      throw new PodArtworkOutputPolicyError("UV_LAYERS_OUTPUT_INVALID", "UV layer outputs must match the pinned transparent format or be the layer ZIP package");
    }
    if (output.metadata.aiInference !== "none") {
      throw new PodArtworkOutputPolicyError("UV_LAYERS_OUTPUT_INVALID", "UV separation cannot introduce generative image inference");
    }
    if (output.mediaType !== "application/zip" && (
      output.metadata.unit !== parameters.unit
      || output.metadata.dpi !== parameters.dpi
      || output.metadata.colorMode !== parameters.colorMode
      || output.metadata.transparent !== true
      || !approximatelyEqual(output.metadata.width ?? -1, parameters.width)
      || !approximatelyEqual(output.metadata.height ?? -1, parameters.height)
    )) {
      throw new PodArtworkOutputPolicyError("UV_LAYERS_OUTPUT_INVALID", "Every UV visual output must preserve the pinned canvas, DPI, color mode, and transparency");
    }
  }

  const evidence = quality.data;
  if (
    evidence.separationMode !== parameters.separationMode
    || evidence.blankLayerKeys.length
    || evidence.unexpectedLayerKeys.length
  ) {
    throw new PodArtworkOutputPolicyError("UV_LAYERS_EVIDENCE_INVALID", "UV layer mode or layer diagnostics do not match the pinned request");
  }
  const definitions = parseUvLayerDefinitions(parameters);
  const expectedKeys = definitions.map((definition) => definition.layerKey);
  if (evidence.layers.length !== definitions.length || !sameMembers(evidence.layers.map((layer) => layer.layerKey), expectedKeys)) {
    throw new PodArtworkOutputPolicyError("UV_LAYERS_CHANNEL_MISMATCH", "UV separation must return exactly one layer for every pinned channel definition");
  }
  const outputByName = new Map(result.outputs.map((output) => [output.fileName, output]));
  for (const layer of evidence.layers) {
    const definition = definitions.find((candidate) => candidate.layerKey === layer.layerKey)!;
    if (
      layer.displayName !== definition.displayName
      || layer.channel !== definition.channel
      || layer.order !== definition.order
      || !approximatelyEqual(layer.opacity, definition.opacity)
      || layer.width !== parameters.width
      || layer.height !== parameters.height
      || layer.unit !== parameters.unit
      || layer.sourcePixelCount <= 0
      || outputByName.get(layer.outputFileName)?.mediaType !== expectedMediaType
    ) {
      throw new PodArtworkOutputPolicyError("UV_LAYERS_CHANNEL_INVALID", "UV layer metadata, order, opacity, source coverage, or file mapping violates the pinned channel definition");
    }
  }
  for (const conflict of evidence.conflictRegions) {
    if (
      conflict.unit !== parameters.unit
      || conflict.x + conflict.width > parameters.width + 0.000_1
      || conflict.y + conflict.height > parameters.height + 0.000_1
      || new Set(conflict.candidateLayerKeys).size !== conflict.candidateLayerKeys.length
      || conflict.candidateLayerKeys.some((key) => !expectedKeys.includes(key))
      || conflict.candidateLayerKeys.some((key) => evidence.layers.find((layer) => layer.layerKey === key)!.conflictPixelCount <= 0)
    ) {
      throw new PodArtworkOutputPolicyError("UV_LAYERS_CONFLICT_INVALID", "UV conflict regions must stay inside the pinned canvas and reference valid affected layers");
    }
  }
  if (!evidence.conflictRegions.length && evidence.layers.some((layer) => layer.conflictPixelCount !== 0)) {
    throw new PodArtworkOutputPolicyError("UV_LAYERS_CONFLICT_INVALID", "UV layers cannot report conflict pixels without machine-readable conflict regions");
  }

  const checkedFiles = evidence.outputChecks.map((check) => check.fileName);
  if (!sameMembers(checkedFiles, outputNames)) {
    throw new PodArtworkOutputPolicyError("UV_LAYERS_OUTPUT_EVIDENCE_MISMATCH", "UV quality evidence must cover every output file exactly once");
  }
  const layerChecks = evidence.outputChecks.filter((check) => check.kind === "layer");
  const previewChecks = evidence.outputChecks.filter((check) => check.kind === "composite_preview");
  const packageChecks = evidence.outputChecks.filter((check) => check.kind === "layer_package");
  if (
    layerChecks.length !== definitions.length
    || previewChecks.length !== 1
    || packageChecks.length !== 1
    || outputByName.get(previewChecks[0]!.fileName)?.mediaType !== expectedMediaType
    || outputByName.get(packageChecks[0]!.fileName)?.mediaType !== "application/zip"
    || !sameMembers(previewChecks[0]!.layerKeys, expectedKeys)
    || !sameMembers(packageChecks[0]!.layerKeys, expectedKeys)
  ) {
    throw new PodArtworkOutputPolicyError("UV_LAYERS_OUTPUT_EVIDENCE_MISMATCH", "UV separation requires one file per layer, one composite preview, and one layer package");
  }
  for (const check of layerChecks) {
    const layer = evidence.layers.find((candidate) => candidate.outputFileName === check.fileName);
    if (!layer || !sameMembers(check.layerKeys, [layer.layerKey])) {
      throw new PodArtworkOutputPolicyError("UV_LAYERS_OUTPUT_EVIDENCE_MISMATCH", "Each UV layer output must map to exactly one pinned layer key");
    }
  }
  return { ...result, qualityCheckSnapshot: evidence };
}

function parseUvLayerDefinitions(parameters: UvLayersParameterSnapshot) {
  return parameters.layerDefinitions.map((entry) => {
    const [layerKey, displayName, channel, rawOrder, rawOpacity] = entry.split("|").map((value) => value.trim());
    return {
      layerKey: layerKey!, displayName: displayName!, channel: channel!,
      order: Number(rawOrder), opacity: Number(rawOpacity),
    };
  });
}

function validatePieceExtractResult(
  task: PodArtworkExecutionRecord,
  result: PodArtworkExecutionResult,
): PodArtworkExecutionResult {
  const parameters = PieceExtractParameterSnapshotSchema.parse(task.parameterSnapshot);
  const quality = PieceExtractQualityCheckSnapshotSchema.safeParse(result.qualityCheckSnapshot);
  if (!quality.success) {
    throw new PodArtworkOutputPolicyError("PIECE_EXTRACT_QUALITY_INVALID", "Piece extraction result is missing strict region and template-draft evidence");
  }
  if (result.partial) {
    throw new PodArtworkOutputPolicyError("PIECE_EXTRACT_PARTIAL", "Piece extraction cannot complete with a partial production template draft");
  }
  const expectedMediaType = ({ png: "image/png", tiff: "image/tiff", jpeg: "image/jpeg" } as const)[parameters.outputFormat];
  const outputNames = result.outputs.map((output) => output.fileName);
  if (new Set(outputNames).size !== outputNames.length) {
    throw new PodArtworkOutputPolicyError("PIECE_EXTRACT_OUTPUT_INVALID", "Piece extraction output file names must be unique");
  }
  for (const output of result.outputs) {
    if (output.role !== "production" || ![expectedMediaType, "application/zip"].includes(output.mediaType)) {
      throw new PodArtworkOutputPolicyError("PIECE_EXTRACT_OUTPUT_INVALID", "Piece extraction outputs must match the pinned visual format or be the template ZIP package");
    }
    if (output.metadata.aiInference !== "none") {
      throw new PodArtworkOutputPolicyError("PIECE_EXTRACT_OUTPUT_INVALID", "Piece extraction cannot introduce generative image inference");
    }
    if (output.mediaType !== "application/zip" && (
      output.metadata.unit !== parameters.unit
      || output.metadata.dpi !== parameters.dpi
      || output.metadata.colorMode !== parameters.colorMode
      || output.metadata.transparent !== parameters.preserveTransparency
      || !output.metadata.width
      || !output.metadata.height
    )) {
      throw new PodArtworkOutputPolicyError("PIECE_EXTRACT_OUTPUT_INVALID", "Piece extraction visual metadata does not match the pinned production plan");
    }
  }

  const evidence = quality.data;
  if (
    evidence.extractionMode !== parameters.extractionMode
    || evidence.templateDraft.name !== parameters.templateDraftName
    || evidence.blankPieceKeys.length
    || evidence.duplicatePieceKeys.length
    || evidence.unexpectedPieceKeys.length
  ) {
    throw new PodArtworkOutputPolicyError("PIECE_EXTRACT_EVIDENCE_INVALID", "Piece extraction mode, template draft, or region diagnostics do not match the pinned request");
  }
  const definitions = parsePieceExtractDefinitions(parameters);
  const expectedKeys = definitions.map((definition) => definition.pieceKey);
  if (evidence.regions.length !== definitions.length || !sameMembers(evidence.regions.map((region) => region.pieceKey), expectedKeys)) {
    throw new PodArtworkOutputPolicyError("PIECE_EXTRACT_REGION_MISMATCH", "Piece extraction must return exactly one region for every pinned piece definition");
  }
  const outputByName = new Map(result.outputs.map((output) => [output.fileName, output]));
  for (const region of evidence.regions) {
    const definition = definitions.find((candidate) => candidate.pieceKey === region.pieceKey)!;
    const output = outputByName.get(region.outputFileName);
    if (
      region.displayName !== definition.displayName
      || region.rotationDegrees !== definition.rotationDegrees
      || region.flipMode !== definition.flipMode
      || region.unit !== parameters.unit
      || region.x + region.width > parameters.width + 0.000_1
      || region.y + region.height > parameters.height + 0.000_1
      || !output
      || output.mediaType !== expectedMediaType
      || !approximatelyEqual(output.metadata.width ?? -1, region.width)
      || !approximatelyEqual(output.metadata.height ?? -1, region.height)
    ) {
      throw new PodArtworkOutputPolicyError("PIECE_EXTRACT_REGION_INVALID", "Piece extraction region geometry, orientation, or output evidence violates the pinned definition");
    }
    const shouldConfirm = region.confidence < parameters.minimumConfidence;
    if (region.manualConfirmationRequired !== shouldConfirm) {
      throw new PodArtworkOutputPolicyError("PIECE_EXTRACT_CONFIDENCE_INVALID", "Piece extraction low-confidence regions must be explicitly marked for manual confirmation");
    }
  }
  const expectedLowConfidence = evidence.regions
    .filter((region) => region.confidence < parameters.minimumConfidence)
    .map((region) => region.pieceKey);
  if (!sameMembers(evidence.lowConfidencePieceKeys, expectedLowConfidence)) {
    throw new PodArtworkOutputPolicyError("PIECE_EXTRACT_CONFIDENCE_INVALID", "Piece extraction low-confidence keys do not match the recomputed threshold");
  }

  const checkedFiles = evidence.outputChecks.map((check) => check.fileName);
  if (!sameMembers(checkedFiles, outputNames)) {
    throw new PodArtworkOutputPolicyError("PIECE_EXTRACT_OUTPUT_EVIDENCE_MISMATCH", "Piece extraction quality evidence must cover every output file exactly once");
  }
  const pieceChecks = evidence.outputChecks.filter((check) => check.kind === "piece");
  const fullCanvasChecks = evidence.outputChecks.filter((check) => check.kind === "full_canvas");
  const templateChecks = evidence.outputChecks.filter((check) => check.kind === "template_package");
  if (
    pieceChecks.length !== definitions.length
    || fullCanvasChecks.length !== 1
    || templateChecks.length !== 1
    || evidence.templateDraft.fileName !== templateChecks[0]!.fileName
    || outputByName.get(templateChecks[0]!.fileName)?.mediaType !== "application/zip"
    || outputByName.get(fullCanvasChecks[0]!.fileName)?.mediaType !== expectedMediaType
    || !sameMembers(fullCanvasChecks[0]!.pieceKeys, expectedKeys)
    || !sameMembers(templateChecks[0]!.pieceKeys, expectedKeys)
  ) {
    throw new PodArtworkOutputPolicyError("PIECE_EXTRACT_OUTPUT_EVIDENCE_MISMATCH", "Piece extraction requires one full canvas, one output per piece, and one template package");
  }
  const fullCanvasOutput = outputByName.get(fullCanvasChecks[0]!.fileName)!;
  if (
    !approximatelyEqual(fullCanvasOutput.metadata.width ?? -1, parameters.width)
    || !approximatelyEqual(fullCanvasOutput.metadata.height ?? -1, parameters.height)
  ) {
    throw new PodArtworkOutputPolicyError("PIECE_EXTRACT_CANVAS_INVALID", "Piece extraction full canvas dimensions do not match the pinned production canvas");
  }
  for (const check of pieceChecks) {
    const region = evidence.regions.find((candidate) => candidate.outputFileName === check.fileName);
    if (!region || !sameMembers(check.pieceKeys, [region.pieceKey])) {
      throw new PodArtworkOutputPolicyError("PIECE_EXTRACT_OUTPUT_EVIDENCE_MISMATCH", "Each extracted piece output must map to exactly one pinned region");
    }
  }
  return { ...result, qualityCheckSnapshot: evidence };
}

function parsePieceExtractDefinitions(parameters: PieceExtractParameterSnapshot) {
  return parameters.pieceDefinitions.map((entry) => {
    const [pieceKey, displayName, rawRotation, flipMode] = entry.split("|").map((value) => value.trim());
    return {
      pieceKey: pieceKey!,
      displayName: displayName!,
      rotationDegrees: Number(rawRotation),
      flipMode: flipMode!,
    };
  });
}

function validatePieceComposeResult(
  task: PodArtworkExecutionRecord,
  result: PodArtworkExecutionResult,
): PodArtworkExecutionResult {
  const parameters = PieceComposeParameterSnapshotSchema.parse(task.parameterSnapshot);
  const quality = PieceComposeQualityCheckSnapshotSchema.safeParse(result.qualityCheckSnapshot);
  if (!quality.success) {
    throw new PodArtworkOutputPolicyError("PIECE_LAYOUT_QUALITY_INVALID", "Piece layout result is missing strict quality evidence");
  }
  if (result.partial) {
    throw new PodArtworkOutputPolicyError("PIECE_LAYOUT_PARTIAL", "Piece layout cannot complete with partial production output");
  }
  const fileNames = result.outputs.map((output) => output.fileName);
  if (new Set(fileNames).size !== fileNames.length) {
    throw new PodArtworkOutputPolicyError("PIECE_LAYOUT_OUTPUT_INVALID", "Piece layout output file names must be unique");
  }
  for (const output of result.outputs) {
    if (output.role !== "production" || !["image/png", "image/tiff", "application/zip"].includes(output.mediaType)) {
      throw new PodArtworkOutputPolicyError("PIECE_LAYOUT_OUTPUT_INVALID", "Piece layout outputs must be production PNG, TIFF, or ZIP files");
    }
    if (output.metadata.aiInference !== "none") {
      throw new PodArtworkOutputPolicyError("PIECE_LAYOUT_OUTPUT_INVALID", "Piece layout cannot introduce generative image inference");
    }
    if (output.mediaType !== "application/zip" && (
      output.metadata.unit !== parameters.unit
      || output.metadata.dpi === undefined
      || output.metadata.dpi < parameters.minimumDpi
      || output.metadata.colorMode !== parameters.colorMode
      || !output.metadata.width
      || !output.metadata.height
    )) {
      throw new PodArtworkOutputPolicyError("PIECE_LAYOUT_OUTPUT_INVALID", "Piece layout visual output metadata does not meet pinned production constraints");
    }
  }

  const evidence = quality.data;
  if (evidence.layoutMode !== parameters.layoutMode || evidence.blankPieceKeys.length) {
    throw new PodArtworkOutputPolicyError("PIECE_LAYOUT_EVIDENCE_INVALID", "Piece layout mode or blank-piece evidence does not match the pinned request");
  }
  const expectedByKey = new Map(parameters.pieceKeys.map((pieceKey, inputOrdinal) => [pieceKey, inputOrdinal]));
  if (evidence.placements.length !== parameters.pieceKeys.length) {
    throw new PodArtworkOutputPolicyError("PIECE_LAYOUT_INPUT_MISMATCH", "Piece layout must include exactly one placement for every pinned input");
  }
  const placementKeys = evidence.placements.map((placement) => placement.pieceKey);
  if (!sameMembers(placementKeys, parameters.pieceKeys)) {
    throw new PodArtworkOutputPolicyError("PIECE_LAYOUT_INPUT_MISMATCH", "Piece layout placement keys do not match the pinned inputs");
  }
  for (const placement of evidence.placements) {
    if (
      expectedByKey.get(placement.pieceKey) !== placement.inputOrdinal
      || placement.unit !== parameters.unit
      || placement.effectiveDpi < parameters.minimumDpi
      || (!parameters.allowRotation && placement.rotationDegrees !== 0)
      || (parameters.fitMode !== "stretch" && !approximatelyEqual(placement.scaleX, placement.scaleY))
    ) {
      throw new PodArtworkOutputPolicyError("PIECE_LAYOUT_PLACEMENT_INVALID", "Piece layout placement violates input order, DPI, unit, rotation, or fit constraints");
    }
  }
  validatePlacementGeometry(parameters, evidence.placements);
  if (parameters.layoutMode === "manual") validateManualPlacementEvidence(parameters.manualPlacements, evidence.placements);

  const checkedFiles = evidence.outputChecks.map((check) => check.fileName);
  if (!sameMembers(checkedFiles, fileNames)) {
    throw new PodArtworkOutputPolicyError("PIECE_LAYOUT_OUTPUT_EVIDENCE_MISMATCH", "Piece layout quality evidence must cover every output file exactly once");
  }
  const evidencedPieces = [...new Set(evidence.outputChecks.flatMap((check) => check.pieceKeys))];
  if (!sameMembers(evidencedPieces, parameters.pieceKeys) || evidence.outputChecks.some(
    (check) => new Set(check.pieceKeys).size !== check.pieceKeys.length
      || check.pieceKeys.some((pieceKey) => !expectedByKey.has(pieceKey)),
  )) {
    throw new PodArtworkOutputPolicyError("PIECE_LAYOUT_OUTPUT_EVIDENCE_MISMATCH", "Piece layout output evidence does not cover every pinned piece");
  }
  return { ...result, qualityCheckSnapshot: evidence };
}

function validatePlacementGeometry(
  parameters: PieceComposeParameterSnapshot,
  placements: PieceComposePlacementEvidence[],
) {
  for (const placement of placements) {
    if (
      placement.x + placement.width > parameters.width + 0.000_1
      || placement.y + placement.height > parameters.height + 0.000_1
    ) {
      throw new PodArtworkOutputPolicyError("PIECE_LAYOUT_BOUNDS_INVALID", "Piece layout placement geometry exceeds the pinned production canvas");
    }
  }
  const minimumGap = parameters.unit === "mm"
    ? parameters.gapMm
    : parameters.unit === "in"
      ? parameters.gapMm / 25.4
      : parameters.gapMm * parameters.dpi / 25.4;
  for (let leftIndex = 0; leftIndex < placements.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < placements.length; rightIndex += 1) {
      const left = placements[leftIndex]!;
      const right = placements[rightIndex]!;
      const gapX = Math.max(0, left.x - (right.x + right.width), right.x - (left.x + left.width));
      const gapY = Math.max(0, left.y - (right.y + right.height), right.y - (left.y + left.height));
      if (Math.hypot(gapX, gapY) + 0.000_1 < minimumGap) {
        throw new PodArtworkOutputPolicyError("PIECE_LAYOUT_GAP_INVALID", "Piece layout does not preserve the pinned minimum gap between pieces");
      }
    }
  }
}

function validateManualPlacementEvidence(
  manualPlacements: string[],
  placements: Array<{
    pieceKey: string;
    x: number;
    y: number;
    rotationDegrees: number;
    scaleX: number;
    scaleY: number;
  }>,
) {
  const expected = new Map(manualPlacements.map((entry) => {
    const [pieceKey, rawX, rawY, rawRotation, rawScale] = entry.split(",").map((value) => value.trim());
    return [pieceKey!, {
      x: Number(rawX),
      y: Number(rawY),
      rotation: Number(rawRotation),
      scale: Number(rawScale),
    }] as const;
  }));
  const matches = placements.every((placement) => {
    const pinned = expected.get(placement.pieceKey);
    return pinned
      && approximatelyEqual(placement.x, pinned.x)
      && approximatelyEqual(placement.y, pinned.y)
      && placement.rotationDegrees === pinned.rotation
      && approximatelyEqual(placement.scaleX, pinned.scale)
      && approximatelyEqual(placement.scaleY, pinned.scale);
  });
  if (!matches) {
    throw new PodArtworkOutputPolicyError("PIECE_LAYOUT_MANUAL_MISMATCH", "Piece layout output does not match the pinned manual placement plan");
  }
}

function sameMembers(left: string[], right: string[]) {
  return left.length === right.length
    && new Set(left).size === left.length
    && left.every((entry) => right.includes(entry));
}

function approximatelyEqual(left: number, right: number) {
  return Math.abs(left - right) <= 0.000_1;
}

function errorCode(error: unknown) {
  if (error instanceof PodArtworkInputPolicyError) return "INPUT_POLICY_BLOCKED";
  if (error instanceof PodArtworkOutputPolicyError) return error.code;
  if (error instanceof Error && error.name) return error.name.replaceAll(/[^A-Za-z0-9_]/g, "_").toUpperCase().slice(0, 80);
  return "POD_PROCESSING_FAILED";
}

function safeErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "POD artwork processing failed";
  return message.slice(0, 500);
}
