import { createEntityId } from "@yummyai/contracts";
import {
  artifactRelations,
  assetFiles,
  type canvasPrintSpecVersions,
  creativeDesignCandidates,
  creativeDesignVersionAssets,
  creativeDesignVersions,
  creativeExecutions,
  designVersionFiles,
  mockupBatchItems,
  mockupBatchOutputs,
  mockupTemplateSlots,
  mockupTemplateSourceInspections,
  type DatabaseConnection,
  withTenant,
} from "@yummyai/database";
import {
  CreativeDesignAdaptationJobPayloadSchema,
  CreativeDesignJobPayloadSchema,
  MockupRenderJobPayloadSchema,
  MockupTemplateCompileJobPayloadSchema,
  type JobEnvelope,
} from "@yummyai/jobs";
import {
  MOCKUP_COMPILER_VERSION,
  MockupRenderManifestSchema,
  MockupTemplatePolicyError,
  NativeImageMagickRunner,
  compileControlledPsd,
  renderCompiledMockup,
  type ImageMagickRunner,
} from "@yummyai/mockup-renderer";
import type { Storage } from "@yummyai/storage";
import { and, eq } from "drizzle-orm";
import sharp from "sharp";
import { z } from "zod";
import { MockupTemplateInspectionSchema } from "@yummyai/contracts";
import { creativeMockupStep, stageCreativeOutpaint, type CreativeOperation } from "@yummyai/pod-core";
import { CreativeExecutionRecovery, type CreativeExecutionClaim } from "./creative-execution-recovery.js";
import { readCreativeAssets, creativeDerivedRights } from "./creative-execution-assets.js";
import { creativeOwnerRunning, creativeOwnerStopped, refreshCreativeProgress, refreshMockupItem } from "./creative-execution-owner-state.js";
import { executeCreativePod, creativeFailure, creativeFailureDiagnostic } from "./creative-execution-pod.js";
import { creativeLocalResponse, decodeCreativeOutputs, type CreativeLocalOutput } from "./creative-execution-response.js";
import { decodePodResponse } from "./pod-artwork-response.js";

import { HttpPodArtworkGateway } from "./pod-artwork.http-gateway.js";
import type { PodArtworkGateway } from "./pod-artwork.processor.js";


export class CreativeDesignCandidateProcessor {
  private readonly recovery: CreativeExecutionRecovery;
  constructor(database: DatabaseConnection, private readonly storage: Storage, private readonly gateway: PodArtworkGateway) {
    this.recovery = new CreativeExecutionRecovery(database, storage, undefined, creativeOwnerStopped);
  }
  async process(envelope: JobEnvelope, signal = new AbortController().signal) {
    const { candidateId } = CreativeDesignJobPayloadSchema.parse(envelope.payload);
    const identity = { tenantId: envelope.tenantId, userId: envelope.requestedBy };
    const operation: CreativeOperation = { kind: "creative_candidate", ownerId: candidateId, stepKey: "generate" };
    let claim: CreativeExecutionClaim | undefined;
    try {
      claim = await this.recovery.claim(identity, operation, (tx, admission) => creativeOwnerRunning(tx, admission.execution));
      if (!claim) return { candidateId, disposition: "already_claimed" as const };
      return await this.recovery.withLease(identity, claim, signal, async executionSignal => {
        const source = await this.recovery.authorized(identity, claim!, async (_tx, admission) => {
          if (admission.source.kind !== "creative_candidate") throw new Error("CREATIVE_INPUT_CHANGED");
          return admission.source;
        });
        const references = await readCreativeAssets(this.recovery, this.storage, identity, claim!, source.referenceSnapshot.map(ref => ref.assetId));
        const inputs = references.map(ref => ref.input), prompt = source.negativePrompt ? `${source.prompt}\nAvoid: ${source.negativePrompt}` : source.prompt;
        const result = await executeCreativePod(this.recovery, identity, claim!, this.gateway, {
          id: claim!.id, designTaskId: candidateId, toolKey: "text_to_image", maxAttempts: 1,
          parameterSnapshot: { designTool: "text_to_image", prompt, referenceStrength: inputs.length ? 65 : 0, creativity: 70,
            aspectRatio: "1:1", outputCount: 1, outputFormat: "png", markAiGenerated: true, markGeneratedAreas: true }, inputAssets: inputs,
        }, executionSignal);
        const output = result.outputs.find(output => ["image/png", "image/jpeg", "image/webp", "image/tiff"].includes(output.mediaType));
        if (!output) throw new Error("CREATIVE_RESPONSE_INVALID");
        const raster = sharp(output.bytes, { limitInputPixels: 64_000_000, failOn: "error" }); await raster.stats();
        return this.recovery.complete(identity, claim!, [{ bytes: output.bytes, mediaType: output.mediaType, role: "master", aiGenerated: true,
          rightsStatus: "unverified", rightsMetadata: { source: { kind: "ai_generated", reference: `creative-design:${result.modelKey}:${result.modelVersion}` },
            candidateId, modelKey: result.modelKey, modelVersion: result.modelVersion, seed: result.seed,
            promptTemplateVersion: source.promptTemplateVersion, processorQuality: result.qualityCheckSnapshot, outputMetadata: output.metadata } }],
          async (tx, _admission, assets) => {
            const stored = assets[0]!;
            await tx.update(creativeDesignCandidates).set({ status: "generated", assetId: stored.id, assetVersion: stored.version,
              checksumSha256: stored.checksumSha256, modelKey: result.modelKey, modelVersion: result.modelVersion, seed: result.seed ?? null,
              costUsd: result.costUsd === undefined ? null : String(result.costUsd), qualitySnapshot: result.qualityCheckSnapshot,
              completedAt: new Date(), updatedAt: new Date() }).where(eq(creativeDesignCandidates.id, candidateId));
            if (inputs.length) await tx.insert(artifactRelations).values(inputs.map(input => ({ id: createEntityId(), tenantId: identity.tenantId,
              fromAssetId: input.id, fromAssetVersion: input.version, toAssetId: stored.id, toAssetVersion: stored.version,
              relationType: "source_to_result" as const, createdBy: identity.userId }))).onConflictDoNothing();
            await refreshCreativeProgress(tx, source.batchId);
            return { candidateId, disposition: "generated" as const, assetId: stored.id };
          });
      });
    } catch (cause) {
      const failure = creativeFailure(cause);
      await this.recovery.fail(identity, operation, claim, failure.code, failure.permanent);
      throw new Error(failure.code);
    }
  }
}

export class CreativeDesignAdaptationProcessor {
  private readonly recovery: CreativeExecutionRecovery;
  constructor(private readonly database: DatabaseConnection, private readonly storage: Storage, private readonly gateway: PodArtworkGateway,
    private readonly diagnostic?: (event: ReturnType<typeof creativeFailureDiagnostic>) => void) {
    this.recovery = new CreativeExecutionRecovery(database, storage, undefined, creativeOwnerStopped);
  }
  async process(envelope: JobEnvelope, signal = new AbortController().signal) {
    const { creativeDesignVersionId } = CreativeDesignAdaptationJobPayloadSchema.parse(envelope.payload);
    const identity = { tenantId: envelope.tenantId, userId: envelope.requestedBy };
    const roots = await withTenant(this.database.db, { ...identity, permissions: [], dataScope: "tenant" }, tx =>
      tx.select({ stepKey: creativeExecutions.stepKey }).from(creativeExecutions).where(and(
        eq(creativeExecutions.creativeVersionId, creativeDesignVersionId), eq(creativeExecutions.effect, "internal_write"),
        eq(creativeExecutions.requestedBy, identity.userId))));
    if (!roots.length) throw new Error("CREATIVE_LEGACY_AUTHORITY_MISSING");
    for (const root of roots) {
      const operation: CreativeOperation = { kind: "creative_adaptation", ownerId: creativeDesignVersionId, stepKey: root.stepKey };
      let claim: CreativeExecutionClaim | undefined;
      try {
        claim = await this.recovery.claim(identity, operation);
        if (!claim) continue;
        await this.recovery.withLease(identity, claim, signal, async executionSignal => {
          const input = await this.recovery.authorized(identity, claim!, async (tx, admission) => {
            if (admission.source.kind !== "creative_adaptation") throw new Error("CREATIVE_INPUT_CHANGED");
            const [master] = await tx.select().from(assetFiles).where(eq(assetFiles.id, admission.source.master.assetId));
            return { source: admission.source, master: master! };
          });
          if (!claim!.hasResponse) {
            const [master] = await readCreativeAssets(this.recovery, this.storage, identity, claim!, [input.master.id], true);
            const adapted = await adaptArtwork(master!.input.bytes, input.source.focalPoint, input.source.spec, async () => {
              const child = await this.recovery.authorized(identity, claim!, (tx) => stageCreativeOutpaint(tx, identity, claim!.id, claim!.token));
              const childOperation: CreativeOperation = { kind: "creative_adaptation", ownerId: creativeDesignVersionId, stepKey: child.stepKey };
              let childClaim: CreativeExecutionClaim | undefined;
              try {
                childClaim = await this.recovery.claim(identity, childOperation);
                let result;
                if (childClaim) {
                  result = await this.recovery.withLease(identity, childClaim, executionSignal, async childSignal => {
                    const result = await executeCreativePod(this.recovery, identity, childClaim!, this.gateway, {
                      id: child.id, designTaskId: creativeDesignVersionId, toolKey: "canvas_extend", maxAttempts: 1,
                      parameterSnapshot: { designTool: "canvas_extend",
                        prompt: `Extend the existing artwork naturally to a ${input.source.spec.aspectWidth}:${input.source.spec.aspectHeight} canvas. Preserve the original subject and style.`,
                        referenceStrength: 95, creativity: 25, aspectRatio: nearestSupportedRatio(input.source.spec.aspectWidth / input.source.spec.aspectHeight),
                        outputCount: 1, outputFormat: "png", markAiGenerated: true, markGeneratedAreas: true },
                      inputAssets: [master!.input],
                    }, childSignal);
                    const output = result.outputs.find(output => ["image/png", "image/jpeg", "image/webp", "image/tiff"].includes(output.mediaType));
                    if (!output) throw new Error("CREATIVE_RESPONSE_INVALID");
                    await sharp(output.bytes, { limitInputPixels: 64_000_000, failOn: "error" }).stats();
                    await this.recovery.complete(identity, childClaim!, [{ bytes: output.bytes, mediaType: output.mediaType, role: "expanded",
                      aiGenerated: true, rightsStatus: "unverified", rightsMetadata: { source: input.master.rightsMetadata.source,
                        derivative: { kind: "ai_outpaint", sourceAssetId: input.master.id, sourceAssetVersion: input.master.version },
                        modelKey: result.modelKey, modelVersion: result.modelVersion, creativeDesignVersionId } }],
                      async (tx, _admission, assets) => {
                        await tx.insert(artifactRelations).values({ id: createEntityId(), tenantId: identity.tenantId,
                          fromAssetId: input.master.id, fromAssetVersion: input.master.version, toAssetId: assets[0]!.id,
                          toAssetVersion: assets[0]!.version, relationType: "result_to_derivative", createdBy: identity.userId }).onConflictDoNothing();
                        return { assetId: assets[0]!.id, modelKey: result.modelKey, modelVersion: result.modelVersion };
                      });
                    return result;
                  });
                } else {
                  const saved = await this.recovery.readCompleted(identity, childOperation);
                  if (saved.kind !== "pod") throw new Error("CREATIVE_RESPONSE_INVALID");
                  result = decodePodResponse(saved.checkpoint);
                }
                const output = result.outputs.find(output => ["image/png", "image/jpeg", "image/webp", "image/tiff"].includes(output.mediaType));
                if (!output) throw new Error("CREATIVE_RESPONSE_INVALID");
                return { bytes: output.bytes, generatedRegions: output.metadata.inferenceRegions ?? [],
                  qualitySnapshot: { ...result.qualityCheckSnapshot, originalOutpaintExecutionId: child.id } };
              } catch (cause) {
                this.diagnostic?.(creativeFailureDiagnostic(cause));
                const failure = creativeFailure(cause);
                await this.recovery.fail(identity, childOperation, childClaim, failure.code, failure.permanent);
                throw new Error(failure.code);
              }
            });
            await this.recovery.record(identity, claim!, creativeLocalResponse(
              [{ bytes: adapted.bytes, mediaType: "image/png", role: "aspect_variant" }],
              { mode: adapted.mode, generatedRegions: adapted.generatedRegions, qualitySnapshot: adapted.qualitySnapshot }));
          }
          const response = await this.recovery.read(identity, claim!);
          if (response.kind !== "local") throw new Error("CREATIVE_RESPONSE_INVALID");
          const details = z.object({ mode: z.enum(["crop", "ai_outpaint"]), generatedRegions: z.array(z.object({
            x: z.number().finite(), y: z.number().finite(), width: z.number().positive(), height: z.number().positive() }).strict()).max(100),
            qualitySnapshot: z.record(z.string(), z.unknown()) }).strict().parse(response.result);
          const outputs = decodeCreativeOutputs(response);
          if (outputs.length !== 1 || outputs[0]!.mediaType !== "image/png" || outputs[0]!.role !== "aspect_variant") throw new Error("CREATIVE_RESPONSE_INVALID");
          await this.recovery.complete(identity, claim!, [{ ...outputs[0]!, aiGenerated: input.master.aiGenerated || details.mode === "ai_outpaint",
            rightsStatus: details.mode === "crop" && input.master.rightsStatus === "approved" ? "approved" : "unverified",
            rightsMetadata: { source: input.master.rightsMetadata.source, creativeDesignVersionId, printSpecVersionId: input.source.spec.id,
              derivative: { kind: details.mode, sourceAssetId: input.master.id, sourceAssetVersion: input.master.version,
                sourceChecksum: input.master.checksumSha256, originalRights: input.master.rightsMetadata },
              adaptationMode: details.mode, generatedRegions: details.generatedRegions } }], async (tx, _admission, assets) => {
                const asset = assets[0]!;
                await tx.insert(creativeDesignVersionAssets).values({ id: createEntityId(), tenantId: identity.tenantId,
                  creativeDesignVersionId, assetId: asset.id, assetVersion: asset.version, role: "aspect_variant",
                  printSpecVersionId: input.source.spec.id, adaptationMode: details.mode, generatedRegions: details.generatedRegions,
                  qualitySnapshot: details.qualitySnapshot });
                await tx.insert(artifactRelations).values({ id: createEntityId(), tenantId: identity.tenantId,
                  fromAssetId: input.master.id, fromAssetVersion: input.master.version, toAssetId: asset.id,
                  toAssetVersion: asset.version, relationType: "result_to_derivative", createdBy: identity.userId }).onConflictDoNothing();
                const states = await tx.select({ id: creativeExecutions.id, phase: creativeExecutions.phase }).from(creativeExecutions)
                  .where(and(eq(creativeExecutions.creativeVersionId, creativeDesignVersionId), eq(creativeExecutions.effect, "internal_write")));
                if (states.every(row => row.id === claim!.id || row.phase === "completed"))
                  await tx.update(creativeDesignVersions).set({ status: "pending_review" }).where(eq(creativeDesignVersions.id, creativeDesignVersionId));
                return { creativeDesignVersionId, assetId: asset.id, printSpecVersionId: input.source.spec.id };
              });
        });
      } catch (cause) {
        this.diagnostic?.(creativeFailureDiagnostic(cause));
        const failure = creativeFailure(cause);
        await this.recovery.fail(identity, operation, claim, failure.code, failure.permanent);
        throw new Error(failure.code);
      }
    }
    return { creativeDesignVersionId, disposition: "processed" as const };
  }
}

export class MockupTemplateCompileProcessor {
  private readonly recovery: CreativeExecutionRecovery;
  constructor(database: DatabaseConnection, private readonly storage: Storage, private readonly runner: ImageMagickRunner = new NativeImageMagickRunner()) {
    this.recovery = new CreativeExecutionRecovery(database, storage, undefined, creativeOwnerStopped);
  }
  async process(envelope: JobEnvelope, signal = new AbortController().signal) {
    const { inspectionId } = MockupTemplateCompileJobPayloadSchema.parse(envelope.payload);
    const identity = { tenantId: envelope.tenantId, userId: envelope.requestedBy };
    const operation: CreativeOperation = { kind: "template_compile", ownerId: inspectionId, stepKey: "compile" };
    let claim: CreativeExecutionClaim | undefined;
    try {
      claim = await this.recovery.claim(identity, operation, (tx, admission) => creativeOwnerRunning(tx, admission.execution));
      if (!claim) return { inspectionId, disposition: "already_claimed" as const };
      return await this.recovery.withLease(identity, claim, signal, async executionSignal => {
        const input = await this.recovery.authorized(identity, claim!, async (tx, admission) => {
          if (admission.source.kind !== "template_compile" || admission.source.compilerVersion !== MOCKUP_COMPILER_VERSION) throw new Error("CREATIVE_INPUT_CHANGED");
          const [file] = await tx.select().from(assetFiles).where(eq(assetFiles.id, admission.source.sourceAssetId));
          return { source: admission.source, file: file! };
        });
        if (!claim!.hasResponse) {
          const [source] = await readCreativeAssets(this.recovery, this.storage, identity, claim!, [input.source.sourceAssetId]);
          executionSignal.throwIfAborted();
          const compiled = await compileControlledPsd(source!.input.bytes, input.source.slotKey, this.runner);
          const outputs: CreativeLocalOutput[] = [
            { bytes: compiled.background, mediaType: "image/png", role: "background" },
            { bytes: compiled.foreground, mediaType: "image/png", role: "foreground" },
            ...(compiled.mask ? [{ bytes: compiled.mask, mediaType: "image/png" as const, role: "mask" }] : []),
            { bytes: compiled.preview, mediaType: "image/png", role: "preview" },
            { bytes: compiled.manifestBytes, mediaType: "application/json", role: "manifest" },
          ];
          await this.recovery.record(identity, claim!, creativeLocalResponse(outputs, {
            manifest: compiled.manifest, ssimPermille: compiled.ssimPermille, warnings: compiled.warnings,
          }));
        }
        const response = await this.recovery.read(identity, claim!);
        if (response.kind !== "local") throw new Error("CREATIVE_RESPONSE_INVALID");
        const details = z.object({ manifest: MockupRenderManifestSchema, ssimPermille: z.int().min(990).max(1000),
          warnings: MockupTemplateInspectionSchema.shape.warnings }).strict().parse(response.result);
        const outputs = decodeCreativeOutputs(response);
        const roles = outputs.map(output => output.role);
        if (new Set(roles).size !== roles.length || roles.some(role => !["background", "foreground", "mask", "preview", "manifest"].includes(role))
          || ["background", "foreground", "preview", "manifest"].some(role => !roles.includes(role))) throw new Error("CREATIVE_RESPONSE_INVALID");
        return this.recovery.complete(identity, claim!, outputs.map(output => ({
          ...output, aiGenerated: input.file.aiGenerated, rightsStatus: "approved" as const,
          rightsMetadata: { ...creativeDerivedRights([input.file], { kind: "controlled_psd_compile", compilerVersion: MOCKUP_COMPILER_VERSION }),
            inspectionId, compiledAssetKind: output.role },
        })), async (tx, _admission, assets) => {
          const byRole = new Map(outputs.map((output, index) => [output.role, assets[index]!]));
          const background = byRole.get("background")!, foreground = byRole.get("foreground")!, mask = byRole.get("mask"),
            preview = byRole.get("preview")!, manifest = byRole.get("manifest")!;
          await tx.update(mockupTemplateSourceInspections).set({ status: "completed", compilation: {
            canvasWidth: details.manifest.canvas.width, canvasHeight: details.manifest.canvas.height,
            slotKey: details.manifest.slotKey, transform: details.manifest.transform,
            backgroundAssetId: background.id, foregroundAssetId: foreground.id, ...(mask ? { maskAssetId: mask.id } : {}),
            previewAssetId: preview.id, manifestAssetId: manifest.id, checksumSha256: manifest.checksumSha256,
            ssimPermille: details.ssimPermille, compilerVersion: MOCKUP_COMPILER_VERSION,
          }, warnings: details.warnings, completedAt: new Date() }).where(eq(mockupTemplateSourceInspections.id, inspectionId));
          await tx.insert(artifactRelations).values(assets.map(asset => ({ id: createEntityId(), tenantId: identity.tenantId,
            fromAssetId: input.file.id, fromAssetVersion: input.file.version, toAssetId: asset.id, toAssetVersion: asset.version,
            relationType: "result_to_template" as const, createdBy: identity.userId }))).onConflictDoNothing();
          return { inspectionId, disposition: "completed" as const, ssimPermille: details.ssimPermille };
        });
      });
    } catch (cause) {
      const failure = creativeFailure(cause);
      await this.recovery.fail(identity, operation, claim, failure.code, failure.permanent || cause instanceof MockupTemplatePolicyError);
      throw new Error(failure.code);
    }
  }
}

export class MockupRenderProcessor {
  private readonly recovery: CreativeExecutionRecovery;
  constructor(private readonly database: DatabaseConnection, private readonly storage: Storage, private readonly runner: ImageMagickRunner = new NativeImageMagickRunner()) {
    this.recovery = new CreativeExecutionRecovery(database, storage, undefined, creativeOwnerStopped);
  }
  async process(envelope: JobEnvelope, signal = new AbortController().signal) {
    const { itemId } = MockupRenderJobPayloadSchema.parse(envelope.payload), identity = { tenantId: envelope.tenantId, userId: envelope.requestedBy };
    const steps = await withTenant(this.database.db, { ...identity, permissions: [], dataScope: "tenant" }, tx =>
      tx.select({ stepKey: creativeExecutions.stepKey }).from(creativeExecutions).where(and(eq(creativeExecutions.mockupItemId, itemId), eq(creativeExecutions.requestedBy, identity.userId))));
    if (!steps.length) throw new Error("CREATIVE_LEGACY_AUTHORITY_MISSING");
    let succeeded = 0, deferred = 0;
    for (const step of steps) {
      const operation: CreativeOperation = { kind: "mockup_render", ownerId: itemId, stepKey: step.stepKey };
      let claim: CreativeExecutionClaim | undefined;
      try {
        claim = await this.recovery.claim(identity, operation, (tx, admission) => creativeOwnerRunning(tx, admission.execution));
        if (!claim) continue;
        await this.recovery.withLease(identity, claim, signal, async executionSignal => {
          const input = await this.recovery.authorized(identity, claim!, async (tx, admission) => {
            if (admission.source.kind !== "mockup_render") throw new Error("CREATIVE_INPUT_CHANGED");
            const [item] = await tx.select().from(mockupBatchItems).where(eq(mockupBatchItems.id, itemId));
            const [artwork] = await tx.select({ file: assetFiles }).from(designVersionFiles).innerJoin(assetFiles, eq(assetFiles.id, designVersionFiles.assetFileId))
              .where(and(eq(designVersionFiles.versionId, item!.designVersionId), eq(designVersionFiles.role, "production")));
            const [template] = await tx.select({ slot: mockupTemplateSlots, inspection: mockupTemplateSourceInspections })
              .from(mockupTemplateSlots).innerJoin(mockupTemplateSourceInspections, eq(mockupTemplateSourceInspections.id, mockupTemplateSlots.inspectionId))
              .where(eq(mockupTemplateSlots.id, creativeMockupStep(step.stepKey).slotId));
            const [original] = await tx.select().from(assetFiles).where(eq(assetFiles.id, template!.inspection.sourceAssetId));
            return { item: item!, artwork: artwork!.file, template: template!, original: original!, outputId: admission.source.output.id,
              templatePackVersionId: admission.source.templatePackVersionId };
          });
          const compilation = input.template.inspection.compilation!;
          if (!claim!.hasResponse) {
            const ids = [input.artwork.id, compilation.backgroundAssetId, compilation.foregroundAssetId,
              compilation.previewAssetId, compilation.manifestAssetId, ...(compilation.maskAssetId ? [compilation.maskAssetId] : [])];
            const files = await readCreativeAssets(this.recovery, this.storage, identity, claim!, ids);
            const bytes = (id: string) => files.find(file => file.file.id === id)!.input.bytes;
            const manifest = MockupRenderManifestSchema.parse(JSON.parse(new TextDecoder().decode(bytes(compilation.manifestAssetId))));
            executionSignal.throwIfAborted();
            const rendered = await renderCompiledMockup(bytes(input.artwork.id), {
              manifest, background: bytes(compilation.backgroundAssetId), foreground: bytes(compilation.foregroundAssetId),
              preview: bytes(compilation.previewAssetId), ...(compilation.maskAssetId ? { mask: bytes(compilation.maskAssetId) } : {}),
            }, this.runner);
            await this.recovery.record(identity, claim!, creativeLocalResponse([{ bytes: rendered.bytes, mediaType: "image/png", role: "mockup" }],
              { outputId: input.outputId, width: rendered.width, height: rendered.height,
                qualitySnapshot: { deterministic: true, compilerVersion: MOCKUP_COMPILER_VERSION, sourceUnchanged: true } }));
          }
          const response = await this.recovery.read(identity, claim!);
          if (response.kind !== "local") throw new Error("CREATIVE_RESPONSE_INVALID");
          const details = z.object({ outputId: z.uuidv7(), width: z.int().positive().max(100000), height: z.int().positive().max(100000),
            qualitySnapshot: z.record(z.string(), z.unknown()) }).strict().parse(response.result);
          const outputs = decodeCreativeOutputs(response);
          if (details.outputId !== input.outputId || outputs.length !== 1 || outputs[0]!.role !== "mockup" || outputs[0]!.mediaType !== "image/png") throw new Error("CREATIVE_RESPONSE_INVALID");
          await this.recovery.complete(identity, claim!, [{ ...outputs[0]!, aiGenerated: input.artwork.aiGenerated || input.original.aiGenerated,
            rightsStatus: "unverified", rightsMetadata: { ...creativeDerivedRights([input.artwork, input.original], {
              kind: "controlled_mockup_render", compilerVersion: MOCKUP_COMPILER_VERSION }),
              mockupBatchItemId: itemId, mockupOutputId: input.outputId, designVersionId: input.item.designVersionId,
              templatePackVersionId: input.templatePackVersionId, templateInspectionId: input.template.inspection.id } }],
            async (tx, _admission, assets) => {
              const asset = assets[0]!;
              await tx.update(mockupBatchOutputs).set({ status: "succeeded", assetId: asset.id, assetVersion: asset.version,
                checksumSha256: asset.checksumSha256, width: details.width, height: details.height,
                qualitySnapshot: details.qualitySnapshot, completedAt: new Date() }).where(eq(mockupBatchOutputs.id, input.outputId));
              await tx.insert(artifactRelations).values([input.artwork, input.original].map(from => ({ id: createEntityId(), tenantId: identity.tenantId,
                fromAssetId: from.id, fromAssetVersion: from.version, toAssetId: asset.id, toAssetVersion: asset.version,
                relationType: from.id === input.artwork.id ? "result_to_derivative" as const : "result_to_template" as const,
                createdBy: identity.userId }))).onConflictDoNothing();
              await refreshMockupItem(tx, itemId); return { itemId, outputId: input.outputId, assetId: asset.id };
            });
          succeeded++;
        });
      } catch (cause) {
        const failure = creativeFailure(cause);
        const disposition = await this.recovery.fail(identity, operation, claim, failure.code, failure.permanent);
        if (disposition === "deferred") deferred++;
      }
    }
    return { itemId, disposition: deferred ? "recovery_pending" as const : "processed" as const, succeeded, deferred };
  }
}

export function createCreativeGatewayFromEnvironment() {
  return HttpPodArtworkGateway.fromEnvironment();
}

export async function adaptArtwork(
  bytes: Uint8Array,
  focalPoint: { xPermille: number; yPermille: number },
  spec: Pick<typeof canvasPrintSpecVersions.$inferSelect, "aspectWidth" | "aspectHeight" | "safeZoneMm" | "physicalSizes">,
  outpaint: () => Promise<{ bytes: Uint8Array; generatedRegions: Array<{ x: number; y: number; width: number; height: number }>; qualitySnapshot: Record<string, unknown> }>,
) {
  const metadata = await sharp(bytes, { limitInputPixels: 64_000_000, failOn: "error" }).metadata();
  if (!metadata.width || !metadata.height) throw new Error("Creative design master dimensions are unavailable");
  const desiredRatio = spec.aspectWidth / spec.aspectHeight;
  const sourceRatio = metadata.width / metadata.height;
  let cropWidth = metadata.width;
  let cropHeight = metadata.height;
  if (sourceRatio > desiredRatio) cropWidth = Math.max(1, Math.floor(metadata.height * desiredRatio));
  else cropHeight = Math.max(1, Math.floor(metadata.width / desiredRatio));
  const focalX = metadata.width * focalPoint.xPermille / 1_000;
  const focalY = metadata.height * focalPoint.yPermille / 1_000;
  const left = clamp(Math.round(focalX - cropWidth / 2), 0, metadata.width - cropWidth);
  const top = clamp(Math.round(focalY - cropHeight / 2), 0, metadata.height - cropHeight);
  const size = spec.physicalSizes[0]!;
  const safeX = cropWidth * Number(spec.safeZoneMm) / size.widthMm;
  const safeY = cropHeight * Number(spec.safeZoneMm) / size.heightMm;
  const safePreserved = focalX - safeX >= left && focalX + safeX <= left + cropWidth
    && focalY - safeY >= top && focalY + safeY <= top + cropHeight;
  if (safePreserved) {
    return {
      bytes: new Uint8Array(await sharp(bytes).extract({ left, top, width: cropWidth, height: cropHeight }).png().toBuffer()),
      mode: "crop" as const, generatedRegions: [],
      qualitySnapshot: { policyVersion: "canvas-adaptation-v1", safeZonePreserved: true, focalPoint, crop: { left, top, width: cropWidth, height: cropHeight } },
    };
  }
  const expanded = await outpaint();
  const expandedMetadata = await sharp(expanded.bytes).metadata();
  if (!expandedMetadata.width || !expandedMetadata.height) throw new Error("Canvas extension output dimensions are unavailable");
  const exact = await cropToRatio(expanded.bytes, desiredRatio);
  return {
    bytes: exact, mode: "ai_outpaint" as const, generatedRegions: expanded.generatedRegions,
    qualitySnapshot: { ...expanded.qualitySnapshot, policyVersion: "canvas-adaptation-v1", safeZonePreserved: true, focalPoint,
      sourceDimensions: { width: metadata.width, height: metadata.height }, expandedDimensions: { width: expandedMetadata.width, height: expandedMetadata.height } },
  };
}

async function cropToRatio(bytes: Uint8Array, targetRatio: number) {
  const metadata = await sharp(bytes).metadata();
  if (!metadata.width || !metadata.height) throw new Error("Raster dimensions are unavailable");
  const ratio = metadata.width / metadata.height;
  const width = ratio > targetRatio ? Math.floor(metadata.height * targetRatio) : metadata.width;
  const height = ratio > targetRatio ? metadata.height : Math.floor(metadata.width / targetRatio);
  return new Uint8Array(await sharp(bytes).extract({
    left: Math.floor((metadata.width - width) / 2), top: Math.floor((metadata.height - height) / 2), width, height,
  }).png().toBuffer());
}


function nearestSupportedRatio(ratio: number): "1:1" | "4:5" | "3:4" | "16:9" {
  const choices = [["1:1", 1], ["4:5", 0.8], ["3:4", 0.75], ["16:9", 16 / 9]] as const;
  return [...choices].sort((left, right) => Math.abs(left[1] - ratio) - Math.abs(right[1] - ratio))[0]![0];
}


function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

