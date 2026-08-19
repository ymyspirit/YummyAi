import { createHash } from "node:crypto";

import type { SecretVault } from "@yummyai/ai-core";
import {
  OrderPersonalizationResolutionSnapshotSchema,
  VectorFulfillmentQualityCheckSnapshotSchema,
  type OrderPersonalizationRenderParameterSnapshot,
  type OrderPersonalizationRenderTool,
  type OrderPersonalizationResolutionSlot,
  type OrderPersonalizationResolutionSnapshot,
  type TemplateCanvas,
  type TemplateSlot,
  type TenantContext,
} from "@yummyai/contracts";
import { OrderPersonalizationRenderJobPayloadSchema, type JobEnvelope } from "@yummyai/jobs";
import { z } from "zod";

import type { PodArtworkExecutionResult } from "./pod-artwork.processor.js";

export interface OrderPersonalizationRenderSourceAsset {
  id: string;
  version: number;
  checksumSha256: string;
  mediaType: string;
  bytes: Uint8Array;
}

export interface OrderPersonalizationRenderTaskRecord {
  id: string;
  designTaskId: string;
  batchItemId: string;
  toolKey: OrderPersonalizationRenderTool;
  parameterSnapshot: OrderPersonalizationRenderParameterSnapshot;
  encryptedResolution: string;
  resolutionChecksum: string;
  orderId: string;
  orderLineId: string;
  customizationVersionId: string;
  templateVersionId: string;
  maxAttempts: number;
}

export interface OrderPersonalizationRenderExecutionRecord extends OrderPersonalizationRenderTaskRecord {
  resolution: OrderPersonalizationResolutionSnapshot;
  canvas: TemplateCanvas;
  slots: TemplateSlot[];
  customerAssets: OrderPersonalizationRenderSourceAsset[];
  templateSource?: OrderPersonalizationRenderSourceAsset;
}

export interface OrderPersonalizationRenderRepository {
  load(context: Pick<TenantContext, "tenantId" | "userId">, renderTaskId: string): Promise<OrderPersonalizationRenderTaskRecord | undefined>;
  claim(context: Pick<TenantContext, "tenantId" | "userId">, renderTaskId: string, attempt: number): Promise<boolean>;
  hydrate(
    context: Pick<TenantContext, "tenantId" | "userId">,
    task: OrderPersonalizationRenderTaskRecord,
    resolution: OrderPersonalizationResolutionSnapshot,
  ): Promise<OrderPersonalizationRenderExecutionRecord>;
  complete(
    context: Pick<TenantContext, "tenantId" | "userId">,
    task: OrderPersonalizationRenderExecutionRecord,
    result: PodArtworkExecutionResult,
  ): Promise<void>;
  fail(
    context: Pick<TenantContext, "tenantId" | "userId">,
    renderTaskId: string,
    input: { attempt: number; terminal: boolean; code: string; message: string },
  ): Promise<void>;
}

export interface OrderPersonalizationRenderGateway {
  execute(input: OrderPersonalizationRenderExecutionRecord, signal: AbortSignal): Promise<PodArtworkExecutionResult>;
}

export class OrderPersonalizationRenderPolicyError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "OrderPersonalizationRenderPolicyError";
  }
}

export class OrderPersonalizationRenderProcessor {
  constructor(
    private readonly repository: OrderPersonalizationRenderRepository,
    private readonly gateway: OrderPersonalizationRenderGateway,
    private readonly piiVault: SecretVault,
  ) {}

  async process(envelope: JobEnvelope, signal = new AbortController().signal) {
    const { renderTaskId } = OrderPersonalizationRenderJobPayloadSchema.parse(envelope.payload);
    const context = { tenantId: envelope.tenantId, userId: envelope.requestedBy };
    const task = await this.repository.load(context, renderTaskId);
    if (!task) throw new OrderPersonalizationRenderPolicyError("RENDER_TASK_NOT_FOUND", "Order personalization render task was not found");
    const claimed = await this.repository.claim(context, task.id, envelope.attempt);
    if (!claimed) return { renderTaskId, disposition: "already_claimed" as const };

    try {
      if (sha256(task.encryptedResolution) !== task.resolutionChecksum) {
        throw new OrderPersonalizationRenderPolicyError("RESOLUTION_CHECKSUM_MISMATCH", "Encrypted slot resolution no longer matches its prepared checksum");
      }
      const resolution = this.piiVault.withSecret(task.encryptedResolution, (plaintext) => {
        try {
          return OrderPersonalizationResolutionSnapshotSchema.parse(JSON.parse(plaintext));
        } catch {
          throw new OrderPersonalizationRenderPolicyError("RESOLUTION_SNAPSHOT_INVALID", "Encrypted slot resolution is invalid");
        }
      });
      const execution = await this.repository.hydrate(context, task, resolution);
      validateExecutionPolicy(execution);
      const result = await this.gateway.execute(execution, signal);
      const validatedResult = validateResult(execution, result);
      await this.repository.complete(context, execution, validatedResult);
      return {
        renderTaskId,
        disposition: validatedResult.partial ? "partially_succeeded" as const : "awaiting_review" as const,
        outputCount: validatedResult.outputs.length,
      };
    } catch (error) {
      const terminal = error instanceof OrderPersonalizationRenderPolicyError
        || envelope.attempt + 1 >= Math.min(task.maxAttempts, envelope.maxAttempts);
      await this.repository.fail(context, task.id, {
        attempt: envelope.attempt,
        terminal,
        code: errorCode(error),
        message: safeMessage(error),
      });
      throw error;
    }
  }
}

function validateResult(
  task: OrderPersonalizationRenderExecutionRecord,
  result: PodArtworkExecutionResult,
): PodArtworkExecutionResult {
  if (!result.outputs.length) throw new Error("Order personalization processor returned no outputs");
  if (!result.modelKey || !result.modelVersion) throw new Error("Order personalization result is missing processor provenance");
  const creative = task.toolKey === "group_photo" || task.toolKey === "pet_outfit";
  const vector = task.toolKey === "vector_fulfillment";
  const fileNames = new Set<string>();
  for (const output of result.outputs) {
    if (!output.bytes.byteLength) throw new Error("Order personalization processor returned an empty output");
    if (fileNames.has(output.fileName)) {
      throw new OrderPersonalizationRenderPolicyError("DUPLICATE_OUTPUT_FILE_NAME", "Processor output file names must be unique within a render task");
    }
    fileNames.add(output.fileName);
    const allowed = vector
      ? ["image/svg+xml"]
      : task.toolKey === "fulfillment_composite"
        ? ["image/png", "image/tiff"]
        : ["image/png", "image/jpeg", "image/webp"];
    if (!allowed.includes(output.mediaType)) {
      throw new OrderPersonalizationRenderPolicyError("OUTPUT_FORMAT_NOT_ALLOWED", "Processor output format is not allowed for this order tool");
    }
    if (!task.parameterSnapshot.allowAiEnhancement && output.metadata.aiInference !== "none") {
      throw new OrderPersonalizationRenderPolicyError("UNAUTHORIZED_AI_INFERENCE", "Processor used AI inference that was not enabled in the pinned parameters");
    }
    const expectedMediaType = task.parameterSnapshot.outputFormat === "svg"
      ? "image/svg+xml"
      : `image/${task.parameterSnapshot.outputFormat}`.replace("image/jpg", "image/jpeg");
    if (output.mediaType !== expectedMediaType) {
      throw new OrderPersonalizationRenderPolicyError("OUTPUT_FORMAT_MISMATCH", "Processor output does not match the pinned output format");
    }
    const production = task.toolKey === "fulfillment_composite" || vector;
    if (!production && output.role !== "effect") {
      throw new OrderPersonalizationRenderPolicyError("OUTPUT_ROLE_NOT_ALLOWED", "Preview composition outputs must use the effect role");
    }
    if (production && output.role !== "production") {
      throw new OrderPersonalizationRenderPolicyError("OUTPUT_ROLE_NOT_ALLOWED", "Fulfillment composition outputs must use the production role");
    }
    if (creative && output.metadata.aiInference === "none") {
      throw new OrderPersonalizationRenderPolicyError("AI_INFERENCE_EVIDENCE_MISSING", "Creative order outputs must declare AI inference evidence");
    }
    if (vector) validateSvgOutput(task, output);
  }
  if (vector) {
    if (result.partial) {
      throw new OrderPersonalizationRenderPolicyError("VECTOR_PARTIAL_OUTPUT_NOT_ALLOWED", "Vector fulfillment must pass as a complete production result");
    }
    return {
      ...result,
      qualityCheckSnapshot: validateVectorQuality(task, result),
    };
  }
  if (!creative) return result;
  return {
    ...result,
    qualityCheckSnapshot: validateCreativeQuality(task, result),
  };
}

function validateExecutionPolicy(task: OrderPersonalizationRenderExecutionRecord) {
  if (task.toolKey !== "vector_fulfillment") return;
  if (!task.templateSource) {
    throw new OrderPersonalizationRenderPolicyError("VECTOR_TEMPLATE_REQUIRED", "Vector fulfillment requires the pinned template source");
  }
  if (task.templateSource.mediaType !== "image/svg+xml") {
    throw new OrderPersonalizationRenderPolicyError("VECTOR_TEMPLATE_MEDIA_INVALID", "Vector fulfillment requires an approved SVG template source");
  }
}

function validateSvgOutput(
  task: OrderPersonalizationRenderExecutionRecord,
  output: PodArtworkExecutionResult["outputs"][number],
) {
  const parameters = task.parameterSnapshot;
  if (!output.fileName.toLowerCase().endsWith(".svg")) {
    throw new OrderPersonalizationRenderPolicyError("VECTOR_OUTPUT_FILE_NAME_INVALID", "Vector fulfillment outputs must use the .svg extension");
  }
  if (output.metadata.aiInference !== "none") {
    throw new OrderPersonalizationRenderPolicyError("VECTOR_AI_INFERENCE_NOT_ALLOWED", "Vector fulfillment cannot contain generative inference");
  }
  if (
    output.metadata.width !== parameters.vectorWidth
    || output.metadata.height !== parameters.vectorHeight
    || output.metadata.unit !== parameters.vectorUnit
    || output.metadata.colorMode !== parameters.colorMode
    || output.metadata.transparent !== true
  ) {
    throw new OrderPersonalizationRenderPolicyError("VECTOR_OUTPUT_METADATA_MISMATCH", "SVG output metadata does not match the pinned production plan");
  }
  let svg: string;
  try {
    svg = new TextDecoder("utf-8", { fatal: true }).decode(output.bytes).replace(/^\uFEFF/, "");
  } catch {
    throw new OrderPersonalizationRenderPolicyError("VECTOR_OUTPUT_PAYLOAD_INVALID", "Vector fulfillment output is not valid UTF-8 SVG markup");
  }
  if (!/<svg(?:\s|>)/i.test(svg)) {
    throw new OrderPersonalizationRenderPolicyError("VECTOR_OUTPUT_PAYLOAD_INVALID", "Vector fulfillment output is not a valid SVG payload");
  }
  if (/<script(?:\s|>)/i.test(svg) || /javascript\s*:/i.test(svg) || /<foreignObject(?:\s|>)/i.test(svg) || /<!DOCTYPE|<!ENTITY/i.test(svg)) {
    throw new OrderPersonalizationRenderPolicyError("VECTOR_OUTPUT_UNSAFE_MARKUP", "SVG output contains unsafe executable or external-document markup");
  }
  if (/(?:href|src)\s*=\s*["']\s*(?:https?:|\/\/)/i.test(svg) || /url\(\s*["']?\s*(?:https?:|\/\/)/i.test(svg)) {
    throw new OrderPersonalizationRenderPolicyError("VECTOR_OUTPUT_EXTERNAL_REFERENCE", "SVG output cannot reference external resources");
  }
}

function validateVectorQuality(
  task: OrderPersonalizationRenderExecutionRecord,
  result: PodArtworkExecutionResult,
): Record<string, unknown> {
  try {
    const parsed = VectorFulfillmentQualityCheckSnapshotSchema.parse(result.qualityCheckSnapshot);
    const parameters = task.parameterSnapshot;
    const expectedStableKeys = [...new Set(task.resolution.slots.map((slot) => slot.stableKey))].sort();
    const outputFileNames = result.outputs.map((output) => output.fileName);
    if (!sameMembers(parsed.outputChecks.map((check) => check.fileName), outputFileNames)) {
      throw new OrderPersonalizationRenderPolicyError("VECTOR_OUTPUT_EVIDENCE_MISMATCH", "Every SVG output requires exactly one matching quality check");
    }
    for (const check of parsed.outputChecks) {
      if (!sameMembers(check.usedInputStableKeys, expectedStableKeys)) {
        throw new OrderPersonalizationRenderPolicyError("VECTOR_INPUT_EVIDENCE_MISMATCH", "SVG input evidence does not match all pinned template slots");
      }
      if (check.width !== parameters.vectorWidth || check.height !== parameters.vectorHeight || check.unit !== parameters.vectorUnit) {
        throw new OrderPersonalizationRenderPolicyError("VECTOR_CANVAS_EVIDENCE_MISMATCH", "SVG quality evidence does not match the pinned production canvas");
      }
      if (check.minimumLineWidthMm < (parameters.minimumLineWidthMm ?? Number.POSITIVE_INFINITY)) {
        throw new OrderPersonalizationRenderPolicyError("VECTOR_LINE_WIDTH_BELOW_MINIMUM", "SVG output contains lines below the pinned minimum width");
      }
      if (parameters.hollowMode && (check.minimumBridgeWidthMm ?? 0) < (parameters.bridgeWidthMm ?? Number.POSITIVE_INFINITY)) {
        throw new OrderPersonalizationRenderPolicyError("VECTOR_BRIDGE_WIDTH_BELOW_MINIMUM", "SVG output contains bridges below the pinned minimum width");
      }
      assertViewBoxMatchesCanvas(check.viewBox, check.width, check.height);
    }
    if (parameters.pathRepair === "off" && parsed.repairs.length) {
      throw new OrderPersonalizationRenderPolicyError("VECTOR_UNAUTHORIZED_PATH_REPAIR", "SVG processor repaired paths even though path repair was disabled");
    }
    return {
      passed: true,
      exportReady: true,
      templateProfileMatched: true,
      canvasMatched: true,
      textConvertedToPaths: true,
      authorizedFontsOnly: true,
      pathsClosed: true,
      selfIntersectionsDetected: false,
      duplicatePathsDetected: false,
      isolatedNodesDetected: false,
      holeDirectionsValid: true,
      minimumLineWidthPassed: true,
      minimumBridgeWidthPassed: true,
      outOfBoundsDetected: false,
      rasterImagesEmbedded: false,
      repairs: [...parsed.repairs],
      outputChecks: parsed.outputChecks.map((check) => ({ ...check, usedInputStableKeys: [...check.usedInputStableKeys] })),
      ...(parsed.processorDeploymentId ? { processorDeploymentId: parsed.processorDeploymentId } : {}),
    };
  } catch (error) {
    if (error instanceof OrderPersonalizationRenderPolicyError) throw error;
    throw new OrderPersonalizationRenderPolicyError("VECTOR_QUALITY_EVIDENCE_INVALID", "SVG production quality evidence is missing or invalid");
  }
}

function assertViewBoxMatchesCanvas(viewBox: string, width: number, height: number) {
  const values = viewBox.trim().split(/\s+/).map(Number);
  const viewWidth = values[2] ?? 0;
  const viewHeight = values[3] ?? 0;
  const canvasRatio = width / height;
  const viewRatio = viewWidth / viewHeight;
  if (!Number.isFinite(viewRatio) || Math.abs(viewRatio - canvasRatio) > Math.max(0.001, canvasRatio * 0.001)) {
    throw new OrderPersonalizationRenderPolicyError("VECTOR_VIEWBOX_MISMATCH", "SVG viewBox aspect ratio does not match the pinned production canvas");
  }
}

const CreativeQualityBaseShape = {
  passed: z.literal(true),
  processorDeploymentId: z.string().trim().min(1).max(160).optional(),
};

const CreativeOutputCheckBaseShape = {
  fileName: z.string().trim().min(1).max(180),
  usedInputStableKeys: z.array(z.string().trim().min(1).max(120)).min(1).max(500),
  identityPreserved: z.literal(true),
};

const GroupPhotoQualitySchema = z.object({
  ...CreativeQualityBaseShape,
  outputChecks: z.array(z.object({
    ...CreativeOutputCheckBaseShape,
    subjectCountMatched: z.literal(true),
    noAddedSubjects: z.literal(true),
    duplicateSubjectsDetected: z.literal(false),
  }).passthrough()).min(1).max(20),
}).passthrough();

const PetOutfitQualitySchema = z.object({
  ...CreativeQualityBaseShape,
  outputChecks: z.array(z.object({
    ...CreativeOutputCheckBaseShape,
    referenceIdentityTransferred: z.literal(false),
    coatPatternPreserved: z.literal(true),
    bodyShapePreserved: z.literal(true),
  }).passthrough()).min(1).max(20),
}).passthrough();

function validateCreativeQuality(
  task: OrderPersonalizationRenderExecutionRecord,
  result: PodArtworkExecutionResult,
): Record<string, unknown> {
  const assetSlots = task.resolution.slots.filter(
    (slot): slot is Extract<OrderPersonalizationResolutionSlot, { kind: "image" | "decoration" | "background" }> => slot.kind === "image",
  );
  const expectedStableKeys = [...new Set(assetSlots.map((slot) => slot.stableKey))].sort();
  const uniqueAssetIds = new Set(assetSlots.map((slot) => slot.assetId));
  if (task.toolKey === "group_photo") {
    if (uniqueAssetIds.size !== assetSlots.length) {
      throw new OrderPersonalizationRenderPolicyError("GROUP_PHOTO_DUPLICATE_INPUT", "Group photo rendering cannot reuse the same customer image as multiple people");
    }
    if (uniqueAssetIds.size < 2) {
      throw new OrderPersonalizationRenderPolicyError("GROUP_PHOTO_REQUIRES_MULTIPLE_INPUTS", "Group photo rendering requires at least two distinct customer images");
    }
  } else if (!uniqueAssetIds.size) {
    throw new OrderPersonalizationRenderPolicyError("PET_OUTFIT_REQUIRES_INPUT", "Pet outfit rendering requires a pinned customer image");
  }

  try {
    if (task.toolKey === "group_photo") {
      const parsed = GroupPhotoQualitySchema.parse(result.qualityCheckSnapshot);
      assertOutputChecks(parsed.outputChecks, result.outputs.map((output) => output.fileName), expectedStableKeys);
      return {
        passed: true,
        ...(parsed.processorDeploymentId ? { processorDeploymentId: parsed.processorDeploymentId } : {}),
        outputChecks: parsed.outputChecks.map((check) => ({
          fileName: check.fileName,
          usedInputStableKeys: [...check.usedInputStableKeys],
          identityPreserved: true,
          subjectCountMatched: true,
          noAddedSubjects: true,
          duplicateSubjectsDetected: false,
        })),
      };
    }
    const parsed = PetOutfitQualitySchema.parse(result.qualityCheckSnapshot);
    assertOutputChecks(parsed.outputChecks, result.outputs.map((output) => output.fileName), expectedStableKeys);
    return {
      passed: true,
      ...(parsed.processorDeploymentId ? { processorDeploymentId: parsed.processorDeploymentId } : {}),
      outputChecks: parsed.outputChecks.map((check) => ({
        fileName: check.fileName,
        usedInputStableKeys: [...check.usedInputStableKeys],
        identityPreserved: true,
        referenceIdentityTransferred: false,
        coatPatternPreserved: true,
        bodyShapePreserved: true,
      })),
    };
  } catch (error) {
    if (error instanceof OrderPersonalizationRenderPolicyError) throw error;
    throw new OrderPersonalizationRenderPolicyError("CREATIVE_QUALITY_EVIDENCE_INVALID", "Creative order output quality evidence is missing or invalid");
  }
}

function assertOutputChecks(
  checks: Array<{ fileName: string; usedInputStableKeys: string[] }>,
  outputFileNames: string[],
  expectedStableKeys: string[],
) {
  const checkNames = checks.map((check) => check.fileName);
  if (!sameMembers(checkNames, outputFileNames)) {
    throw new OrderPersonalizationRenderPolicyError("CREATIVE_OUTPUT_EVIDENCE_MISMATCH", "Every creative output requires exactly one matching quality check");
  }
  for (const check of checks) {
    if (!sameMembers(check.usedInputStableKeys, expectedStableKeys)) {
      throw new OrderPersonalizationRenderPolicyError("CREATIVE_INPUT_EVIDENCE_MISMATCH", "Creative output input evidence does not match all pinned customer image slots");
    }
  }
}

function sameMembers(left: string[], right: string[]) {
  if (left.length !== new Set(left).size || right.length !== new Set(right).size) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.length === sortedRight.length && sortedLeft.every((value, index) => value === sortedRight[index]);
}

function errorCode(error: unknown) {
  if (error instanceof OrderPersonalizationRenderPolicyError) return error.code;
  if (error instanceof Error && error.name) return error.name.replaceAll(/[^A-Za-z0-9_]/g, "_").toUpperCase().slice(0, 80);
  return "ORDER_PERSONALIZATION_RENDER_FAILED";
}

function safeMessage(error: unknown) {
  if (error instanceof OrderPersonalizationRenderPolicyError) return error.message.slice(0, 500);
  return "Order personalization rendering could not complete";
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
