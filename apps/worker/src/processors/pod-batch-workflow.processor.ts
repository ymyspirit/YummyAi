import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  artifactRelations,
  assetFiles,
  canvasPrintSpecVersions,
  creativeDesignBatchItems,
  creativeDesignBatches,
  creativeDesignCandidates,
  creativeDesignVersionAssets,
  creativeDesignVersions,
  designVersionFiles,
  mockupBatchItems,
  mockupBatchOutputs,
  mockupBatches,
  mockupTemplatePackVersions,
  mockupTemplateSlots,
  mockupTemplateSourceInspections,
  type DatabaseConnection,
  type TenantTransaction,
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
} from "@yummyai/mockup-renderer";
import type { Storage } from "@yummyai/storage";
import { and, eq, inArray } from "drizzle-orm";
import sharp from "sharp";

import { HttpPodArtworkGateway } from "./pod-artwork.http-gateway.js";
import type { PodArtworkExecutionAsset, PodArtworkExecutionRecord, PodArtworkGateway } from "./pod-artwork.processor.js";

type WorkerIdentity = Pick<TenantContext, "tenantId" | "userId">;

export class CreativeDesignCandidateProcessor {
  constructor(
    private readonly database: DatabaseConnection,
    private readonly storage: Storage,
    private readonly gateway: PodArtworkGateway,
  ) {}

  async process(envelope: JobEnvelope, signal = new AbortController().signal) {
    const { candidateId } = CreativeDesignJobPayloadSchema.parse(envelope.payload);
    const identity = { tenantId: envelope.tenantId, userId: envelope.requestedBy };
    const claimed = await withTenant(this.database.db, workerContext(identity), async (tx) => {
      const [row] = await tx.select({ candidate: creativeDesignCandidates, item: creativeDesignBatchItems, batch: creativeDesignBatches })
        .from(creativeDesignCandidates)
        .innerJoin(creativeDesignBatchItems, eq(creativeDesignCandidates.itemId, creativeDesignBatchItems.id))
        .innerJoin(creativeDesignBatches, eq(creativeDesignBatchItems.batchId, creativeDesignBatches.id))
        .where(eq(creativeDesignCandidates.id, candidateId)).limit(1);
      if (!row) throw new Error(`Creative design candidate ${candidateId} was not found`);
      if (row.candidate.status !== "queued") return undefined;
      await tx.update(creativeDesignCandidates).set({ status: "running", errorCode: null, errorMessage: null, completedAt: null, updatedAt: new Date() })
        .where(eq(creativeDesignCandidates.id, candidateId));
      await tx.update(creativeDesignBatchItems).set({ status: "running", updatedAt: new Date() }).where(eq(creativeDesignBatchItems.id, row.item.id));
      await tx.update(creativeDesignBatches).set({ status: "running", updatedAt: new Date() }).where(eq(creativeDesignBatches.id, row.batch.id));
      return row;
    });
    if (!claimed) return { candidateId, disposition: "already_claimed" as const };

    try {
      const inputs = await this.loadPinnedReferences(identity, claimed.item.referenceSnapshot);
      const prompt = claimed.item.negativePrompt
        ? `${claimed.item.prompt}\nAvoid: ${claimed.item.negativePrompt}`
        : claimed.item.prompt;
      const record: PodArtworkExecutionRecord = {
        id: candidateId,
        designTaskId: candidateId,
        toolKey: "text_to_image",
        parameterSnapshot: {
          designTool: "text_to_image",
          prompt,
          referenceStrength: inputs.length ? 65 : 0,
          creativity: 70,
          aspectRatio: "1:1",
          outputCount: 1,
          outputFormat: "png",
          markAiGenerated: true,
          markGeneratedAreas: true,
        },
        inputAssets: inputs,
        maxAttempts: envelope.maxAttempts,
      };
      const result = await this.gateway.execute(identity, record, signal);
      const output = result.outputs.find((candidate) => candidate.mediaType.startsWith("image/"));
      if (!output) throw new Error("Creative design processor returned no raster candidate");
      const storedAsset = await storeAuthorizedAsset(this.database, this.storage, identity, {
        bytes: output.bytes,
        fileName: `${candidateId}.${mediaExtension(output.mediaType)}`,
        mediaType: output.mediaType,
        aiGenerated: true,
        rightsMetadata: {
          source: { kind: "ai_generated", reference: `creative-design:${result.modelKey}:${result.modelVersion}` },
          candidateId,
          modelKey: result.modelKey,
          modelVersion: result.modelVersion,
          seed: result.seed,
          promptTemplateVersion: claimed.candidate.promptTemplateVersion,
          processorQuality: result.qualityCheckSnapshot,
          outputMetadata: output.metadata,
        },
      });
      await withTenant(this.database.db, workerContext(identity), async (tx) => {
        await tx.update(creativeDesignCandidates).set({
          status: "generated", assetId: storedAsset.id, assetVersion: storedAsset.version,
          checksumSha256: storedAsset.checksumSha256, modelKey: result.modelKey,
          modelVersion: result.modelVersion, seed: result.seed ?? null,
          costUsd: result.costUsd === undefined ? null : String(result.costUsd),
          qualitySnapshot: result.qualityCheckSnapshot, completedAt: new Date(), updatedAt: new Date(),
        }).where(eq(creativeDesignCandidates.id, candidateId));
        if (inputs.length) await tx.insert(artifactRelations).values(inputs.map((input) => ({
          id: createEntityId(), tenantId: identity.tenantId,
          fromAssetId: input.id, fromAssetVersion: input.version,
          toAssetId: storedAsset.id, toAssetVersion: storedAsset.version,
          relationType: "source_to_result" as const, createdBy: identity.userId,
        }))).onConflictDoNothing();
        await refreshCreativeProgress(tx, claimed.item.batchId);
      });
      return { candidateId, disposition: "generated" as const, assetId: storedAsset.id };
    } catch (error) {
      const terminal = envelope.attempt + 1 >= envelope.maxAttempts;
      await withTenant(this.database.db, workerContext(identity), async (tx) => {
        await tx.update(creativeDesignCandidates).set({
          status: terminal ? "failed" : "queued",
          errorCode: errorCode(error), errorMessage: safeMessage(error),
          completedAt: terminal ? new Date() : null, updatedAt: new Date(),
        }).where(eq(creativeDesignCandidates.id, candidateId));
        await refreshCreativeProgress(tx, claimed.item.batchId);
      });
      throw error;
    }
  }

  private async loadPinnedReferences(identity: WorkerIdentity, snapshots: Array<{ assetId: string; assetVersion: number; checksumSha256: string }>) {
    if (!snapshots.length) return [];
    const rows = await withTenant(this.database.db, workerContext(identity), (tx) => tx.select().from(assetFiles)
      .where(inArray(assetFiles.id, snapshots.map((snapshot) => snapshot.assetId))));
    const byId = new Map(rows.map((row) => [row.id, row]));
    return Promise.all(snapshots.map(async (snapshot): Promise<PodArtworkExecutionAsset> => {
      const asset = byId.get(snapshot.assetId);
      if (!asset || asset.version !== snapshot.assetVersion || asset.checksumSha256 !== snapshot.checksumSha256) {
        throw new Error(`Creative design reference snapshot changed: ${snapshot.assetId}`);
      }
      if (asset.assetDomain !== "authorized" || asset.rightsStatus !== "approved") throw new Error("Creative design reference rights are no longer approved");
      const rightsSourceKind = (asset.rightsMetadata as { source?: { kind?: PodArtworkExecutionAsset["rightsSourceKind"] } }).source?.kind;
      if (rightsSourceKind === "customer_provided" || rightsSourceKind === "competitor") throw new Error("Creative design reference source is not publishable");
      return {
        id: asset.id, version: asset.version, checksumSha256: asset.checksumSha256,
        domain: "authorized", rightsStatus: "approved", rightsSourceKind,
        mediaType: asset.mediaType,
        bytes: await this.storage.readPrivate(workerContext(identity), storedAssetView(asset), { requiredDomain: "authorized" }),
      };
    }));
  }
}

export class CreativeDesignAdaptationProcessor {
  constructor(
    private readonly database: DatabaseConnection,
    private readonly storage: Storage,
    private readonly gateway: PodArtworkGateway,
  ) {}

  async process(envelope: JobEnvelope, signal = new AbortController().signal) {
    const { creativeDesignVersionId } = CreativeDesignAdaptationJobPayloadSchema.parse(envelope.payload);
    const identity = { tenantId: envelope.tenantId, userId: envelope.requestedBy };
    const loaded = await withTenant(this.database.db, workerContext(identity), async (tx) => {
      const [row] = await tx.select({ version: creativeDesignVersions, candidate: creativeDesignCandidates, item: creativeDesignBatchItems })
        .from(creativeDesignVersions)
        .innerJoin(creativeDesignCandidates, eq(creativeDesignVersions.sourceCandidateId, creativeDesignCandidates.id))
        .innerJoin(creativeDesignBatchItems, eq(creativeDesignCandidates.itemId, creativeDesignBatchItems.id))
        .where(eq(creativeDesignVersions.id, creativeDesignVersionId)).limit(1);
      if (!row) throw new Error(`Creative design version ${creativeDesignVersionId} was not found`);
      if (row.version.status !== "adapting") return undefined;
      const [master] = await tx.select({ versionAsset: creativeDesignVersionAssets, asset: assetFiles })
        .from(creativeDesignVersionAssets).innerJoin(assetFiles, eq(creativeDesignVersionAssets.assetId, assetFiles.id))
        .where(and(eq(creativeDesignVersionAssets.creativeDesignVersionId, creativeDesignVersionId), eq(creativeDesignVersionAssets.role, "master"))).limit(1);
      if (!master) throw new Error("Creative design master asset is missing");
      const specs = await tx.select().from(canvasPrintSpecVersions).where(inArray(canvasPrintSpecVersions.id, row.item.printSpecVersionIds));
      if (specs.length !== row.item.printSpecVersionIds.length || specs.some((spec) => spec.status !== "approved")) throw new Error("Creative design print specification snapshot is no longer approved");
      const existing = await tx.select().from(creativeDesignVersionAssets).where(and(
        eq(creativeDesignVersionAssets.creativeDesignVersionId, creativeDesignVersionId), eq(creativeDesignVersionAssets.role, "aspect_variant"),
      ));
      return { ...row, master, specs, existing };
    });
    if (!loaded) return { creativeDesignVersionId, disposition: "already_completed" as const };
    const masterBytes = await this.storage.readPrivate(workerContext(identity), storedAssetView(loaded.master.asset), { requiredDomain: "authorized" });
    try {
      for (const spec of loaded.specs) {
        if (loaded.existing.some((asset) => asset.printSpecVersionId === spec.id)) continue;
        const adapted = await adaptArtwork(masterBytes, loaded.item.focalPoint, spec, async () => {
          const result = await this.gateway.execute(identity, {
            id: `${creativeDesignVersionId}:${spec.id}`,
            designTaskId: creativeDesignVersionId,
            toolKey: "canvas_extend",
            parameterSnapshot: {
              designTool: "canvas_extend",
              prompt: `Extend the existing artwork naturally to a ${spec.aspectWidth}:${spec.aspectHeight} canvas. Preserve the original subject and style.`,
              referenceStrength: 95,
              creativity: 25,
              aspectRatio: nearestSupportedRatio(spec.aspectWidth / spec.aspectHeight),
              outputCount: 1,
              outputFormat: "png",
              markAiGenerated: true,
              markGeneratedAreas: true,
            },
            inputAssets: [{
              id: loaded.master.asset.id, version: loaded.master.asset.version,
              checksumSha256: loaded.master.asset.checksumSha256, domain: "authorized",
              rightsStatus: loaded.master.asset.rightsStatus as "unverified" | "approved" | "rejected",
              rightsSourceKind: "ai_generated", bytes: masterBytes, mediaType: loaded.master.asset.mediaType,
            }],
            maxAttempts: envelope.maxAttempts,
          }, signal);
          const output = result.outputs.find((entry) => entry.mediaType.startsWith("image/"));
          if (!output) throw new Error("Canvas extension returned no raster output");
          return { bytes: output.bytes, generatedRegions: output.metadata.inferenceRegions ?? [], qualitySnapshot: result.qualityCheckSnapshot };
        });
        const stored = await storeAuthorizedAsset(this.database, this.storage, identity, {
          bytes: adapted.bytes, fileName: `${creativeDesignVersionId}-${spec.id}.png`, mediaType: "image/png",
          aiGenerated: adapted.mode === "ai_outpaint",
          rightsMetadata: {
            source: { kind: adapted.mode === "ai_outpaint" ? "ai_generated" : "owned", reference: `creative-adaptation:${adapted.mode}:v1` },
            creativeDesignVersionId, printSpecVersionId: spec.id,
            adaptationMode: adapted.mode, generatedRegions: adapted.generatedRegions,
          },
        });
        await withTenant(this.database.db, workerContext(identity), async (tx) => {
          await tx.insert(creativeDesignVersionAssets).values({
            id: createEntityId(), tenantId: identity.tenantId, creativeDesignVersionId,
            assetId: stored.id, assetVersion: stored.version, role: "aspect_variant",
            printSpecVersionId: spec.id, adaptationMode: adapted.mode,
            generatedRegions: adapted.generatedRegions, qualitySnapshot: adapted.qualitySnapshot,
          }).onConflictDoNothing();
          await tx.insert(artifactRelations).values({
            id: createEntityId(), tenantId: identity.tenantId,
            fromAssetId: loaded.master.asset.id, fromAssetVersion: loaded.master.asset.version,
            toAssetId: stored.id, toAssetVersion: stored.version,
            relationType: "result_to_derivative", createdBy: identity.userId,
          }).onConflictDoNothing();
        });
      }
      await withTenant(this.database.db, workerContext(identity), (tx) => tx.update(creativeDesignVersions)
        .set({ status: "pending_review" }).where(eq(creativeDesignVersions.id, creativeDesignVersionId)));
      return { creativeDesignVersionId, disposition: "pending_review" as const };
    } catch (error) {
      if (envelope.attempt + 1 >= envelope.maxAttempts) {
        await withTenant(this.database.db, workerContext(identity), (tx) => tx.update(creativeDesignVersions)
          .set({ status: "rejected", rejectionReason: `Adaptation failed: ${safeMessage(error)}` })
          .where(eq(creativeDesignVersions.id, creativeDesignVersionId)));
      }
      throw error;
    }
  }
}

export class MockupTemplateCompileProcessor {
  constructor(
    private readonly database: DatabaseConnection,
    private readonly storage: Storage,
    private readonly runner = new NativeImageMagickRunner(),
  ) {}

  async process(envelope: JobEnvelope) {
    const { inspectionId } = MockupTemplateCompileJobPayloadSchema.parse(envelope.payload);
    const identity = { tenantId: envelope.tenantId, userId: envelope.requestedBy };
    const claimed = await withTenant(this.database.db, workerContext(identity), async (tx) => {
      const [row] = await tx.select({ inspection: mockupTemplateSourceInspections, asset: assetFiles })
        .from(mockupTemplateSourceInspections).innerJoin(assetFiles, eq(mockupTemplateSourceInspections.sourceAssetId, assetFiles.id))
        .where(eq(mockupTemplateSourceInspections.id, inspectionId)).limit(1);
      if (!row) throw new Error(`Mockup template inspection ${inspectionId} was not found`);
      if (row.inspection.status !== "queued") return undefined;
      if (row.asset.version !== row.inspection.sourceAssetVersion || row.asset.checksumSha256 !== row.inspection.checksumSha256) throw new Error("PSD template source snapshot changed");
      await tx.update(mockupTemplateSourceInspections).set({ status: "running", errorCode: null, errorMessage: null, completedAt: null })
        .where(eq(mockupTemplateSourceInspections.id, inspectionId));
      return row;
    });
    if (!claimed) return { inspectionId, disposition: "already_claimed" as const };
    try {
      const bytes = await this.storage.readPrivate(workerContext(identity), storedAssetView(claimed.asset), { requiredDomain: "authorized" });
      const compiled = await compileControlledPsd(bytes, claimed.inspection.slotKey, this.runner);
      const stored = await Promise.all([
        storeAuthorizedAsset(this.database, this.storage, identity, assetInput(compiled.background, `${inspectionId}-background.png`, "template_background", inspectionId)),
        storeAuthorizedAsset(this.database, this.storage, identity, assetInput(compiled.foreground, `${inspectionId}-foreground.png`, "template_foreground", inspectionId)),
        compiled.mask ? storeAuthorizedAsset(this.database, this.storage, identity, assetInput(compiled.mask, `${inspectionId}-mask.png`, "template_mask", inspectionId)) : undefined,
        storeAuthorizedAsset(this.database, this.storage, identity, assetInput(compiled.preview, `${inspectionId}-preview.png`, "template_preview", inspectionId)),
        storeAuthorizedAsset(this.database, this.storage, identity, { ...assetInput(compiled.manifestBytes, `${inspectionId}-manifest.json`, "template_manifest", inspectionId), mediaType: "application/json" }),
      ]);
      const [background, foreground, mask, preview, manifest] = stored;
      await withTenant(this.database.db, workerContext(identity), async (tx) => {
        await tx.update(mockupTemplateSourceInspections).set({
          status: "completed",
          compilation: {
            canvasWidth: compiled.manifest.canvas.width, canvasHeight: compiled.manifest.canvas.height,
            slotKey: compiled.manifest.slotKey, transform: compiled.manifest.transform,
            backgroundAssetId: background.id, foregroundAssetId: foreground.id,
            ...(mask ? { maskAssetId: mask.id } : {}), previewAssetId: preview.id,
            manifestAssetId: manifest.id, checksumSha256: manifest.checksumSha256,
            ssimPermille: compiled.ssimPermille, compilerVersion: MOCKUP_COMPILER_VERSION,
          },
          warnings: compiled.warnings, completedAt: new Date(),
        }).where(eq(mockupTemplateSourceInspections.id, inspectionId));
        await tx.insert(artifactRelations).values(stored.flatMap((asset) => asset ? [{
          id: createEntityId(), tenantId: identity.tenantId,
          fromAssetId: claimed.asset.id, fromAssetVersion: claimed.asset.version,
          toAssetId: asset.id, toAssetVersion: asset.version,
          relationType: "result_to_template" as const, createdBy: identity.userId,
        }] : [])).onConflictDoNothing();
      });
      return { inspectionId, disposition: "completed" as const, ssimPermille: compiled.ssimPermille };
    } catch (error) {
      const terminal = error instanceof MockupTemplatePolicyError || envelope.attempt + 1 >= envelope.maxAttempts;
      await withTenant(this.database.db, workerContext(identity), (tx) => tx.update(mockupTemplateSourceInspections).set({
        status: terminal ? "failed" : "queued", errorCode: errorCode(error), errorMessage: safeMessage(error),
        completedAt: terminal ? new Date() : null,
      }).where(eq(mockupTemplateSourceInspections.id, inspectionId)));
      throw error;
    }
  }
}

export class MockupRenderProcessor {
  constructor(
    private readonly database: DatabaseConnection,
    private readonly storage: Storage,
    private readonly runner = new NativeImageMagickRunner(),
  ) {}

  async process(envelope: JobEnvelope) {
    const { itemId } = MockupRenderJobPayloadSchema.parse(envelope.payload);
    const identity = { tenantId: envelope.tenantId, userId: envelope.requestedBy };
    const loaded = await withTenant(this.database.db, workerContext(identity), async (tx) => {
      const [row] = await tx.select({ item: mockupBatchItems, batch: mockupBatches, pack: mockupTemplatePackVersions })
        .from(mockupBatchItems)
        .innerJoin(mockupBatches, eq(mockupBatchItems.batchId, mockupBatches.id))
        .innerJoin(mockupTemplatePackVersions, eq(mockupBatches.templatePackVersionId, mockupTemplatePackVersions.id))
        .where(eq(mockupBatchItems.id, itemId)).limit(1);
      if (!row) throw new Error(`Mockup batch item ${itemId} was not found`);
      if (row.item.status === "cancelled") return undefined;
      if (row.pack.status !== "approved") throw new Error("Mockup template pack is no longer approved");
      const [artwork] = await tx.select({ asset: assetFiles }).from(designVersionFiles)
        .innerJoin(assetFiles, eq(designVersionFiles.assetFileId, assetFiles.id))
        .where(and(eq(designVersionFiles.versionId, row.item.designVersionId), eq(designVersionFiles.role, "production"))).limit(1);
      if (!artwork) throw new Error("Formal design version is missing its production artwork");
      const outputs = await tx.select({ output: mockupBatchOutputs, slot: mockupTemplateSlots, inspection: mockupTemplateSourceInspections })
        .from(mockupBatchOutputs)
        .innerJoin(mockupTemplateSlots, eq(mockupBatchOutputs.templateSlotId, mockupTemplateSlots.id))
        .innerJoin(mockupTemplateSourceInspections, eq(mockupTemplateSlots.inspectionId, mockupTemplateSourceInspections.id))
        .where(and(eq(mockupBatchOutputs.itemId, itemId), eq(mockupBatchOutputs.status, "queued")));
      if (!outputs.length) return undefined;
      await tx.update(mockupBatchOutputs).set({ status: "running", errorCode: null, errorMessage: null, completedAt: null })
        .where(inArray(mockupBatchOutputs.id, outputs.map(({ output }) => output.id)));
      await tx.update(mockupBatchItems).set({ status: "running", updatedAt: new Date() }).where(eq(mockupBatchItems.id, itemId));
      await tx.update(mockupBatches).set({ status: "running", updatedAt: new Date() }).where(eq(mockupBatches.id, row.batch.id));
      return { ...row, artwork: artwork.asset, outputs };
    });
    if (!loaded) return { itemId, disposition: "already_claimed" as const };
    const artworkBytes = await this.storage.readPrivate(workerContext(identity), storedAssetView(loaded.artwork), { requiredDomain: "authorized" });
    let succeeded = 0;
    let failed = 0;
    for (const entry of loaded.outputs) {
      try {
        const compilation = entry.inspection.compilation;
        if (entry.inspection.status !== "completed" || !compilation) throw new Error(`Template slot ${entry.slot.slotKey} is not compiled`);
        const assetIds = [compilation.backgroundAssetId, compilation.foregroundAssetId, compilation.previewAssetId, compilation.manifestAssetId, ...(compilation.maskAssetId ? [compilation.maskAssetId] : [])];
        const componentRows = await withTenant(this.database.db, workerContext(identity), (tx) => tx.select().from(assetFiles).where(inArray(assetFiles.id, assetIds)));
        if (componentRows.length !== assetIds.length) throw new Error(`Compiled template assets for ${entry.slot.slotKey} are incomplete`);
        const byId = new Map(componentRows.map((asset) => [asset.id, asset]));
        const [background, foreground, preview, manifestBytes, mask] = await Promise.all([
          readAuthorized(this.storage, identity, byId.get(compilation.backgroundAssetId)!),
          readAuthorized(this.storage, identity, byId.get(compilation.foregroundAssetId)!),
          readAuthorized(this.storage, identity, byId.get(compilation.previewAssetId)!),
          readAuthorized(this.storage, identity, byId.get(compilation.manifestAssetId)!),
          compilation.maskAssetId ? readAuthorized(this.storage, identity, byId.get(compilation.maskAssetId)!) : undefined,
        ]);
        const manifest = MockupRenderManifestSchema.parse(JSON.parse(new TextDecoder().decode(manifestBytes)));
        const rendered = await renderCompiledMockup(artworkBytes, { manifest, background, foreground, preview, ...(mask ? { mask } : {}) }, this.runner);
        const outputAsset = await storeAuthorizedAsset(this.database, this.storage, identity, {
          bytes: rendered.bytes, fileName: `${itemId}-${entry.slot.slotKey}-v${entry.output.attempt}.png`, mediaType: "image/png",
          aiGenerated: false,
          rightsMetadata: {
            source: { kind: "owned", reference: `controlled-mockup-render:${MOCKUP_COMPILER_VERSION}` },
            mockupBatchItemId: itemId, mockupOutputId: entry.output.id,
            designVersionId: loaded.item.designVersionId, templatePackVersionId: loaded.pack.id,
            templateInspectionId: entry.inspection.id,
          },
        });
        await withTenant(this.database.db, workerContext(identity), async (tx) => {
          await tx.update(mockupBatchOutputs).set({
            status: "succeeded", assetId: outputAsset.id, assetVersion: outputAsset.version,
            checksumSha256: outputAsset.checksumSha256, width: rendered.width, height: rendered.height,
            qualitySnapshot: { deterministic: true, compilerVersion: MOCKUP_COMPILER_VERSION, sourceUnchanged: true }, completedAt: new Date(),
          }).where(eq(mockupBatchOutputs.id, entry.output.id));
          await tx.insert(artifactRelations).values([
            {
              id: createEntityId(), tenantId: identity.tenantId,
              fromAssetId: loaded.artwork.id, fromAssetVersion: loaded.artwork.version,
              toAssetId: outputAsset.id, toAssetVersion: outputAsset.version,
              relationType: "result_to_derivative" as const, createdBy: identity.userId,
            },
            {
              id: createEntityId(), tenantId: identity.tenantId,
              fromAssetId: entry.inspection.sourceAssetId, fromAssetVersion: entry.inspection.sourceAssetVersion,
              toAssetId: outputAsset.id, toAssetVersion: outputAsset.version,
              relationType: "result_to_template" as const, createdBy: identity.userId,
            },
          ]).onConflictDoNothing();
        });
        succeeded += 1;
      } catch (error) {
        failed += 1;
        await withTenant(this.database.db, workerContext(identity), (tx) => tx.update(mockupBatchOutputs).set({
          status: "failed", errorCode: errorCode(error), errorMessage: safeMessage(error), completedAt: new Date(),
        }).where(eq(mockupBatchOutputs.id, entry.output.id)));
      }
    }
    await withTenant(this.database.db, workerContext(identity), async (tx) => {
      await tx.update(mockupBatchItems).set({
        status: succeeded > 0 ? failed > 0 ? "partially_succeeded" : "awaiting_review" : "failed",
        completedAt: new Date(), updatedAt: new Date(),
      }).where(eq(mockupBatchItems.id, itemId));
      await refreshMockupProgress(tx, loaded.batch.id);
    });
    return { itemId, disposition: failed ? "partially_succeeded" as const : "awaiting_review" as const, succeeded, failed };
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
  const metadata = await sharp(bytes).metadata();
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
    qualitySnapshot: { ...expanded.qualitySnapshot, policyVersion: "canvas-adaptation-v1", safeZonePreserved: true, focalPoint, sourceDimensions: metadata, expandedDimensions: expandedMetadata },
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

async function storeAuthorizedAsset(
  database: DatabaseConnection,
  storage: Storage,
  identity: WorkerIdentity,
  input: { bytes: Uint8Array; fileName: string; mediaType: string; aiGenerated: boolean; rightsStatus?: "unverified" | "approved"; rightsMetadata: Record<string, unknown> },
) {
  const context = workerContext(identity);
  const stored = await storage.putPrivate(context, { body: input.bytes, domain: "authorized", fileName: input.fileName, mediaType: input.mediaType });
  return withTenant(database.db, context, async (tx) => {
    const [existing] = await tx.select().from(assetFiles).where(eq(assetFiles.objectKey, stored.objectKey)).limit(1);
    if (existing) return { id: existing.id, version: existing.version, checksumSha256: existing.checksumSha256 };
    const [created] = await tx.insert(assetFiles).values({
      id: createEntityId(), tenantId: identity.tenantId, ownerUserId: identity.userId,
      objectKey: stored.objectKey, assetDomain: "authorized", fileName: input.fileName,
      mediaType: input.mediaType, byteSize: input.bytes.byteLength, checksumSha256: stored.checksumSha256,
      rightsStatus: input.rightsStatus ?? "unverified", rightsMetadata: input.rightsMetadata, aiGenerated: input.aiGenerated,
    }).returning();
    return { id: created!.id, version: created!.version, checksumSha256: created!.checksumSha256 };
  });
}

function assetInput(bytes: Uint8Array, fileName: string, kind: string, inspectionId: string) {
  return {
    bytes, fileName, mediaType: "image/png", aiGenerated: false, rightsStatus: "approved" as const,
    rightsMetadata: { source: { kind: "owned", reference: `controlled-psd-compile:${MOCKUP_COMPILER_VERSION}` }, inspectionId, compiledAssetKind: kind },
  };
}

async function readAuthorized(storage: Storage, identity: WorkerIdentity, asset: typeof assetFiles.$inferSelect) {
  return storage.readPrivate(workerContext(identity), storedAssetView(asset), { requiredDomain: "authorized" });
}

function storedAssetView(asset: typeof assetFiles.$inferSelect) {
  return { id: asset.id, tenantId: asset.tenantId, assetDomain: asset.assetDomain as "authorized", objectKey: asset.objectKey };
}

async function refreshCreativeProgress(tx: TenantTransaction, batchId: string) {
  const items = await tx.select({ id: creativeDesignBatchItems.id }).from(creativeDesignBatchItems).where(eq(creativeDesignBatchItems.batchId, batchId));
  if (!items.length) return;
  const candidates = await tx.select().from(creativeDesignCandidates).where(inArray(creativeDesignCandidates.itemId, items.map((item) => item.id)));
  for (const item of items) {
    const statuses = candidates.filter((candidate) => candidate.itemId === item.id).map((candidate) => candidate.status);
    const itemStatus = statuses.every((status) => status === "failed") ? "failed"
      : statuses.every((status) => ["generated", "selected", "failed"].includes(status)) ? statuses.includes("failed") ? "partially_succeeded" : "awaiting_review"
        : statuses.some((status) => status === "running") ? "running" : "queued";
    await tx.update(creativeDesignBatchItems).set({ status: itemStatus, completedAt: ["failed", "partially_succeeded", "awaiting_review"].includes(itemStatus) ? new Date() : null, updatedAt: new Date() })
      .where(eq(creativeDesignBatchItems.id, item.id));
  }
  const generatedCount = candidates.filter((candidate) => ["generated", "selected"].includes(candidate.status)).length;
  const failedItemCount = items.filter((item) => {
    const statuses = candidates.filter((candidate) => candidate.itemId === item.id).map((candidate) => candidate.status);
    return statuses.every((status) => status === "failed");
  }).length;
  const terminal = candidates.every((candidate) => ["generated", "selected", "failed", "cancelled"].includes(candidate.status));
  const status = terminal ? generatedCount > 0 ? failedItemCount > 0 ? "partially_succeeded" : "awaiting_review" : "failed" : "running";
  await tx.update(creativeDesignBatches).set({
    status, generatedCount, failedCount: failedItemCount,
    completedAt: terminal ? new Date() : null, updatedAt: new Date(),
  }).where(eq(creativeDesignBatches.id, batchId));
}

async function refreshMockupProgress(tx: TenantTransaction, batchId: string) {
  const items = await tx.select({ status: mockupBatchItems.status }).from(mockupBatchItems).where(eq(mockupBatchItems.batchId, batchId));
  const failedCount = items.filter((item) => item.status === "failed").length;
  const completedCount = items.filter((item) => item.status === "completed").length;
  const finishedRendering = items.every((item) => ["awaiting_review", "partially_succeeded", "failed", "completed"].includes(item.status));
  const status = finishedRendering
    ? failedCount === items.length ? "failed" : failedCount > 0 || items.some((item) => item.status === "partially_succeeded") ? "partially_succeeded" : "awaiting_review"
    : "running";
  await tx.update(mockupBatches).set({ status, failedCount, completedCount, completedAt: finishedRendering ? new Date() : null, updatedAt: new Date() })
    .where(eq(mockupBatches.id, batchId));
}

function workerContext(identity: WorkerIdentity): TenantContext {
  return { ...identity, permissions: [Permission.AssetRead], dataScope: "tenant" };
}

function nearestSupportedRatio(ratio: number): "1:1" | "4:5" | "3:4" | "16:9" {
  const choices = [["1:1", 1], ["4:5", 0.8], ["3:4", 0.75], ["16:9", 16 / 9]] as const;
  return [...choices].sort((left, right) => Math.abs(left[1] - ratio) - Math.abs(right[1] - ratio))[0]![0];
}

function mediaExtension(mediaType: string) {
  return mediaType === "image/jpeg" ? "jpg" : mediaType === "image/webp" ? "webp" : mediaType === "image/tiff" ? "tiff" : "png";
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

function errorCode(error: unknown) {
  if (error instanceof MockupTemplatePolicyError) return error.code;
  return "PROCESSING_FAILED";
}

function safeMessage(error: unknown) {
  return (error instanceof Error ? error.message : "POD batch processing failed").slice(0, 500);
}
