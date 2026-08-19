import { createHash } from "node:crypto";

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  CreateCanvasPrintSpecVersionInputSchema,
  CreateCreativeDesignBatchInputSchema,
  CreateCreativeDesignSkuBindingsInputSchema,
  ReviewVersionInputSchema,
  createEntityId,
  type CreateCanvasPrintSpecVersionInput,
  type CreateCreativeDesignBatchInput,
  type CreateCreativeDesignSkuBindingsInput,
  type ReviewVersionInput,
  type TenantContext,
} from "@yummyai/contracts";
import {
  assetFiles,
  canvasPrintSpecVersions,
  creativeDesignBatchItems,
  creativeDesignBatches,
  creativeDesignCandidates,
  creativeDesignVersionAssets,
  creativeDesignVersions,
  designRecipeVersions,
  skus,
  type DatabaseConnection,
  withTenant,
} from "@yummyai/database";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION, POD_BATCH_WORKFLOW_ENQUEUER } from "../platform.tokens.js";
import { DesignService } from "./design.service.js";

export interface PodBatchWorkflowEnqueuer {
  enqueueCreativeCandidate(input: { candidateId: string; tenantId: string; requestedBy: string }): Promise<void>;
  enqueueCreativeAdaptation(input: { creativeDesignVersionId: string; tenantId: string; requestedBy: string }): Promise<void>;
  enqueueTemplateCompile(input: { inspectionId: string; tenantId: string; requestedBy: string }): Promise<void>;
  enqueueMockupRender(input: { itemId: string; tenantId: string; requestedBy: string }): Promise<void>;
}

type RightsSourceKind = "owned" | "licensed" | "commissioned" | "ai_generated" | "customer_provided" | "competitor";

@Injectable()
export class PodBatchWorkflowService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(POD_BATCH_WORKFLOW_ENQUEUER) private readonly enqueuer: PodBatchWorkflowEnqueuer,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(DesignService) private readonly designs: DesignService,
  ) {}

  async listPrintSpecs(context: TenantContext) {
    return withTenant(this.database.db, context, (tx) => tx.select().from(canvasPrintSpecVersions)
      .orderBy(desc(canvasPrintSpecVersions.createdAt)).limit(500));
  }

  async createPrintSpec(context: TenantContext, rawInput: CreateCanvasPrintSpecVersionInput) {
    const input = CreateCanvasPrintSpecVersionInputSchema.parse(rawInput);
    const created = await withTenant(this.database.db, context, async (tx) => {
      const specId = input.specId ?? createEntityId();
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:${specId}:canvas-print-spec`}, 0))`);
      const [latest] = await tx.select({ versionNumber: canvasPrintSpecVersions.versionNumber })
        .from(canvasPrintSpecVersions).where(eq(canvasPrintSpecVersions.specId, specId))
        .orderBy(desc(canvasPrintSpecVersions.versionNumber)).limit(1);
      const [row] = await tx.insert(canvasPrintSpecVersions).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        specId,
        versionNumber: (latest?.versionNumber ?? 0) + 1,
        name: input.name,
        aspectWidth: input.aspectWidth,
        aspectHeight: input.aspectHeight,
        targetDpi: input.targetDpi,
        bleedMm: String(input.bleedMm),
        safeZoneMm: String(input.safeZoneMm),
        wrapMode: input.wrapMode,
        physicalSizes: input.physicalSizes,
        createdBy: context.userId,
      }).returning();
      return row!;
    });
    await this.record(context, "pod.print_spec.create", "canvas_print_spec_version", created.id, { versionNumber: created.versionNumber });
    return created;
  }

  async reviewPrintSpec(context: TenantContext, versionId: string, rawInput: ReviewVersionInput) {
    const input = ReviewVersionInputSchema.parse(rawInput);
    const row = await withTenant(this.database.db, context, async (tx) => {
      const [current] = await tx.select().from(canvasPrintSpecVersions).where(eq(canvasPrintSpecVersions.id, versionId)).limit(1);
      if (!current) throw new NotFoundException("Canvas print specification version not found");
      if (current.status !== "draft") throw new ConflictException("Only draft print specification versions can be reviewed");
      const [updated] = await tx.update(canvasPrintSpecVersions).set({
        status: input.decision === "approve" ? "approved" : "rejected",
        rejectionReason: input.rejectionReason ?? null,
        reviewedBy: context.userId,
        reviewedAt: new Date(),
      }).where(eq(canvasPrintSpecVersions.id, versionId)).returning();
      return updated!;
    });
    await this.record(context, "pod.print_spec.review", "canvas_print_spec_version", versionId, { decision: input.decision });
    return row;
  }

  async createDesignBatch(context: TenantContext, rawInput: CreateCreativeDesignBatchInput) {
    if (!creativeBatchConfigured()) {
      throw new ServiceUnavailableException("Batch design is disabled until the POD processor and required creative tools are ready");
    }
    const input = CreateCreativeDesignBatchInputSchema.parse(rawInput);
    const requestIdentity = checksum({ policyVersion: "creative-design-batch-v1", input });
    const prepared = await withTenant(this.database.db, context, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:${requestIdentity}:creative-design-batch`}, 0))`);

      if (input.recipeVersionId) {
        const [recipe] = await tx.select({ id: designRecipeVersions.id }).from(designRecipeVersions)
          .where(eq(designRecipeVersions.id, input.recipeVersionId)).limit(1);
        if (!recipe) throw new NotFoundException("Design recipe version not found");
      }
      const specIds = [...new Set(input.items.flatMap((item) => item.printSpecVersionIds))];
      const specRows = await tx.select().from(canvasPrintSpecVersions).where(inArray(canvasPrintSpecVersions.id, specIds));
      if (specRows.length !== specIds.length) throw new NotFoundException("One or more canvas print specification versions were not found");
      if (specRows.some((spec) => spec.status !== "approved")) {
        throw new BadRequestException("Creative design batches require approved canvas print specification versions");
      }
      const referenceIds = [...new Set(input.items.flatMap((item) => item.referenceAssetIds))];
      const referenceRows = referenceIds.length
        ? await tx.select().from(assetFiles).where(and(inArray(assetFiles.id, referenceIds), isNull(assetFiles.deletedAt)))
        : [];
      assertAuthorizedAssets(referenceIds, referenceRows, "Creative design references");
      const referenceById = new Map(referenceRows.map((asset) => [asset.id, asset]));
      const requestChecksum = checksum({
        policyVersion: "creative-design-batch-v1",
        recipeVersionId: input.recipeVersionId ?? null,
        items: input.items.map((item) => ({
          ...item,
          referenceAssets: item.referenceAssetIds.map((id) => {
            const asset = referenceById.get(id)!;
            return { id, version: asset.version, checksumSha256: asset.checksumSha256 };
          }),
          printSpecs: item.printSpecVersionIds.map((id) => {
            const spec = specRows.find((row) => row.id === id)!;
            return { id, versionNumber: spec.versionNumber };
          }),
        })),
      });
      const [replayed] = await tx.select({ id: creativeDesignBatches.id }).from(creativeDesignBatches)
        .where(eq(creativeDesignBatches.requestChecksum, requestChecksum)).limit(1);
      if (replayed) return { id: replayed.id, candidateIds: [] as string[], replayed: true };

      const batchId = createEntityId();
      await tx.insert(creativeDesignBatches).values({
        id: batchId,
        tenantId: context.tenantId,
        name: input.name,
        recipeVersionId: input.recipeVersionId,
        itemCount: input.items.length,
        requestChecksum,
        createdBy: context.userId,
      });
      const candidateIds: string[] = [];
      for (const [ordinal, item] of input.items.entries()) {
        const itemId = createEntityId();
        await tx.insert(creativeDesignBatchItems).values({
          id: itemId,
          tenantId: context.tenantId,
          batchId,
          ordinal,
          rowKey: item.rowKey,
          name: item.name,
          prompt: item.prompt,
          negativePrompt: item.negativePrompt,
          referenceSnapshot: item.referenceAssetIds.map((id) => {
            const asset = referenceById.get(id)!;
            return { assetId: id, assetVersion: asset.version, checksumSha256: asset.checksumSha256 };
          }),
          candidateCount: item.candidateCount,
          printSpecVersionIds: item.printSpecVersionIds,
          focalPoint: item.focalPoint,
        });
        const candidates = Array.from({ length: item.candidateCount }, (_, candidateOrdinal) => {
          const parameterSnapshot = {
            prompt: item.prompt,
            negativePrompt: item.negativePrompt ?? null,
            focalPoint: item.focalPoint,
            candidateOrdinal,
            generationPolicyVersion: "creative-canvas-v1",
          };
          return {
            id: createEntityId(), tenantId: context.tenantId, itemId, ordinal: candidateOrdinal,
            promptTemplateVersion: "creative-canvas-v1", parameterSnapshot,
            inputChecksum: checksum({ parameterSnapshot, referenceSnapshot: item.referenceAssetIds.map((id) => {
              const asset = referenceById.get(id)!;
              return { id, version: asset.version, checksumSha256: asset.checksumSha256 };
            }) }),
          };
        });
        candidateIds.push(...candidates.map((candidate) => candidate.id));
        await tx.insert(creativeDesignCandidates).values(candidates);
      }
      return { id: batchId, candidateIds, replayed: false };
    });

    if (!prepared.replayed) {
      const dispatches = await Promise.allSettled(prepared.candidateIds.map((candidateId) => this.enqueuer.enqueueCreativeCandidate({
        candidateId,
        tenantId: context.tenantId,
        requestedBy: context.userId,
      })));
      const failedIds = dispatches.flatMap((result, index) => result.status === "rejected" ? [prepared.candidateIds[index]!] : []);
      if (failedIds.length) {
        const now = new Date();
        await withTenant(this.database.db, context, (tx) => tx.update(creativeDesignCandidates).set({
          status: "failed",
          errorCode: "QUEUE_UNAVAILABLE",
          errorMessage: "Creative design queue is unavailable",
          completedAt: now,
          updatedAt: now,
        }).where(inArray(creativeDesignCandidates.id, failedIds)));
      }
      await this.record(context, "pod.creative_design_batch.create", "creative_design_batch", prepared.id, {
        itemCount: input.items.length,
        candidateCount: prepared.candidateIds.length,
        queueFailureCount: failedIds.length,
      });
      if (failedIds.length === prepared.candidateIds.length) {
        throw new ServiceUnavailableException("Creative design queue is unavailable");
      }
    }
    return this.getDesignBatch(context, prepared.id);
  }

  async listDesignBatches(context: TenantContext) {
    return withTenant(this.database.db, context, (tx) => tx.select().from(creativeDesignBatches)
      .orderBy(desc(creativeDesignBatches.createdAt)).limit(200));
  }

  async designOptions(context: TenantContext) {
    return withTenant(this.database.db, context, async (tx) => {
      const [allSpecs, assets, skuRows] = await Promise.all([
        tx.select().from(canvasPrintSpecVersions).orderBy(asc(canvasPrintSpecVersions.name), desc(canvasPrintSpecVersions.versionNumber)),
        tx.select({
          id: assetFiles.id, fileName: assetFiles.fileName, mediaType: assetFiles.mediaType,
          version: assetFiles.version, checksumSha256: assetFiles.checksumSha256,
        }).from(assetFiles).where(and(
          eq(assetFiles.assetDomain, "authorized"), eq(assetFiles.rightsStatus, "approved"), isNull(assetFiles.deletedAt),
          sql`coalesce(${assetFiles.rightsMetadata}->'source'->>'kind', '') not in ('customer_provided','competitor')`,
        )).orderBy(desc(assetFiles.createdAt)).limit(500),
        tx.select({ id: skus.id, code: skus.code, attributes: skus.attributes, status: skus.status })
          .from(skus).where(inArray(skus.status, ["draft", "active"])).orderBy(asc(skus.code)).limit(500),
      ]);
      return {
        printSpecs: allSpecs.filter((spec) => spec.status === "approved"),
        printSpecVersions: allSpecs,
        referenceAssets: assets,
        skus: skuRows,
      };
    });
  }

  async getDesignBatch(context: TenantContext, batchId: string) {
    return withTenant(this.database.db, context, async (tx) => {
      const [batch] = await tx.select().from(creativeDesignBatches).where(eq(creativeDesignBatches.id, batchId)).limit(1);
      if (!batch) throw new NotFoundException("Creative design batch not found");
      const items = await tx.select().from(creativeDesignBatchItems).where(eq(creativeDesignBatchItems.batchId, batchId))
        .orderBy(asc(creativeDesignBatchItems.ordinal));
      const itemIds = items.map((item) => item.id);
      const candidates = itemIds.length ? await tx.select().from(creativeDesignCandidates)
        .where(inArray(creativeDesignCandidates.itemId, itemIds)).orderBy(asc(creativeDesignCandidates.ordinal)) : [];
      const candidateIds = candidates.map((candidate) => candidate.id);
      const versions = candidateIds.length ? await tx.select().from(creativeDesignVersions)
        .where(inArray(creativeDesignVersions.sourceCandidateId, candidateIds)) : [];
      const versionIds = versions.map((version) => version.id);
      const assets = versionIds.length ? await tx.select().from(creativeDesignVersionAssets)
        .where(inArray(creativeDesignVersionAssets.creativeDesignVersionId, versionIds)) : [];
      return {
        ...batch,
        items: items.map((item) => ({
          ...item,
          candidates: candidates.filter((candidate) => candidate.itemId === item.id),
          creativeVersions: versions.filter((version) => candidates.some((candidate) => candidate.itemId === item.id && candidate.id === version.sourceCandidateId))
            .map((version) => ({ ...version, assets: assets.filter((asset) => asset.creativeDesignVersionId === version.id) })),
        })),
      };
    });
  }

  async cancelDesignBatch(context: TenantContext, batchId: string) {
    await withTenant(this.database.db, context, async (tx) => {
      const [batch] = await tx.select().from(creativeDesignBatches).where(eq(creativeDesignBatches.id, batchId)).limit(1);
      if (!batch) throw new NotFoundException("Creative design batch not found");
      if (["completed", "cancelled"].includes(batch.status)) throw new ConflictException("Creative design batch is already terminal");
      const now = new Date();
      await tx.update(creativeDesignCandidates).set({ status: "cancelled", completedAt: now, updatedAt: now })
        .where(and(inArray(creativeDesignCandidates.itemId, tx.select({ id: creativeDesignBatchItems.id }).from(creativeDesignBatchItems).where(eq(creativeDesignBatchItems.batchId, batchId))), inArray(creativeDesignCandidates.status, ["queued", "running"])));
      await tx.update(creativeDesignBatchItems).set({ status: "cancelled", completedAt: now, updatedAt: now })
        .where(and(eq(creativeDesignBatchItems.batchId, batchId), inArray(creativeDesignBatchItems.status, ["queued", "running"])));
      await tx.update(creativeDesignBatches).set({ status: "cancelled", completedAt: now, updatedAt: now })
        .where(eq(creativeDesignBatches.id, batchId));
    });
    await this.record(context, "pod.creative_design_batch.cancel", "creative_design_batch", batchId);
    return this.getDesignBatch(context, batchId);
  }

  async retryDesignItem(context: TenantContext, batchId: string, itemId: string) {
    const candidateIds = await withTenant(this.database.db, context, async (tx) => {
      const [item] = await tx.select().from(creativeDesignBatchItems)
        .where(and(eq(creativeDesignBatchItems.id, itemId), eq(creativeDesignBatchItems.batchId, batchId))).limit(1);
      if (!item) throw new NotFoundException("Creative design batch item not found");
      const failed = await tx.select({ id: creativeDesignCandidates.id }).from(creativeDesignCandidates)
        .where(and(eq(creativeDesignCandidates.itemId, itemId), eq(creativeDesignCandidates.status, "failed")));
      if (!failed.length) throw new ConflictException("The batch item has no failed candidates to retry");
      await tx.update(creativeDesignCandidates).set({
        status: "queued", errorCode: null, errorMessage: null, completedAt: null, updatedAt: new Date(),
      }).where(inArray(creativeDesignCandidates.id, failed.map((row) => row.id)));
      await tx.update(creativeDesignBatchItems).set({ status: "queued", errorCode: null, errorMessage: null, completedAt: null, updatedAt: new Date() })
        .where(eq(creativeDesignBatchItems.id, itemId));
      return failed.map((row) => row.id);
    });
    const dispatched = await Promise.allSettled(candidateIds.map((candidateId) => this.enqueuer.enqueueCreativeCandidate({ candidateId, tenantId: context.tenantId, requestedBy: context.userId })));
    if (dispatched.some((result) => result.status === "rejected")) throw new ServiceUnavailableException("Creative design queue is unavailable");
    await this.record(context, "pod.creative_design_item.retry", "creative_design_batch_item", itemId, { batchId, candidateCount: candidateIds.length });
    return this.getDesignBatch(context, batchId);
  }

  async selectCandidate(context: TenantContext, batchId: string, candidateId: string) {
    const selected = await withTenant(this.database.db, context, async (tx) => {
      const [candidate] = await tx.select({
        candidate: creativeDesignCandidates,
        item: creativeDesignBatchItems,
      }).from(creativeDesignCandidates)
        .innerJoin(creativeDesignBatchItems, eq(creativeDesignCandidates.itemId, creativeDesignBatchItems.id))
        .where(and(eq(creativeDesignCandidates.id, candidateId), eq(creativeDesignBatchItems.batchId, batchId))).limit(1);
      if (!candidate) throw new NotFoundException("Creative design candidate not found");
      if (candidate.candidate.status === "selected") {
        const [version] = await tx.select().from(creativeDesignVersions).where(eq(creativeDesignVersions.sourceCandidateId, candidateId)).limit(1);
        return { versionId: version!.id, replayed: true };
      }
      if (candidate.candidate.status !== "generated" || !candidate.candidate.assetId || !candidate.candidate.assetVersion) {
        throw new ConflictException("Only generated candidates can be selected");
      }
      const versionId = createEntityId();
      await tx.update(creativeDesignCandidates).set({ status: "selected", updatedAt: new Date() })
        .where(eq(creativeDesignCandidates.id, candidateId));
      await tx.insert(creativeDesignVersions).values({
        id: versionId,
        tenantId: context.tenantId,
        familyId: createEntityId(),
        versionNumber: 1,
        sourceCandidateId: candidateId,
        name: candidate.item.name,
        createdBy: context.userId,
      });
      await tx.insert(creativeDesignVersionAssets).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        creativeDesignVersionId: versionId,
        assetId: candidate.candidate.assetId,
        assetVersion: candidate.candidate.assetVersion,
        role: "master",
        adaptationMode: "original",
        generatedRegions: [],
        qualitySnapshot: candidate.candidate.qualitySnapshot,
      });
      return { versionId, replayed: false };
    });
    if (!selected.replayed) {
      try {
        await this.enqueuer.enqueueCreativeAdaptation({ creativeDesignVersionId: selected.versionId, tenantId: context.tenantId, requestedBy: context.userId });
      } catch {
        throw new ServiceUnavailableException("Creative design adaptation queue is unavailable");
      }
      await this.record(context, "pod.creative_design_candidate.select", "creative_design_candidate", candidateId, { batchId, creativeDesignVersionId: selected.versionId });
    }
    return this.getCreativeVersion(context, selected.versionId);
  }

  async getCreativeVersion(context: TenantContext, versionId: string) {
    return withTenant(this.database.db, context, async (tx) => {
      const [version] = await tx.select().from(creativeDesignVersions).where(eq(creativeDesignVersions.id, versionId)).limit(1);
      if (!version) throw new NotFoundException("Creative design version not found");
      const assets = await tx.select().from(creativeDesignVersionAssets)
        .where(eq(creativeDesignVersionAssets.creativeDesignVersionId, versionId));
      return { ...version, assets };
    });
  }

  async reviewCreativeVersion(context: TenantContext, versionId: string, rawInput: ReviewVersionInput) {
    const input = ReviewVersionInputSchema.parse(rawInput);
    await withTenant(this.database.db, context, async (tx) => {
      const [version] = await tx.select().from(creativeDesignVersions).where(eq(creativeDesignVersions.id, versionId)).limit(1);
      if (!version) throw new NotFoundException("Creative design version not found");
      if (version.status !== "pending_review") throw new ConflictException("Only pending creative design versions can be reviewed");
      const assets = await tx.select().from(creativeDesignVersionAssets)
        .where(eq(creativeDesignVersionAssets.creativeDesignVersionId, versionId));
      if (input.decision === "approve") {
        const [candidate] = await tx.select({ itemId: creativeDesignCandidates.itemId }).from(creativeDesignCandidates)
          .where(eq(creativeDesignCandidates.id, version.sourceCandidateId)).limit(1);
        const [item] = await tx.select({ printSpecVersionIds: creativeDesignBatchItems.printSpecVersionIds }).from(creativeDesignBatchItems)
          .where(eq(creativeDesignBatchItems.id, candidate!.itemId)).limit(1);
        const presentSpecs = new Set(assets.flatMap((asset) => asset.printSpecVersionId ? [asset.printSpecVersionId] : []));
        if (!assets.some((asset) => asset.role === "master") || item!.printSpecVersionIds.some((id) => !presentSpecs.has(id))) {
          throw new ConflictException("Master and every required aspect variant must be complete before approval");
        }
        await tx.update(assetFiles).set({ rightsStatus: "approved" }).where(inArray(assetFiles.id, assets.map((asset) => asset.assetId)));
      }
      await tx.update(creativeDesignVersions).set({
        status: input.decision === "approve" ? "approved" : "rejected",
        rejectionReason: input.rejectionReason ?? null,
        reviewedBy: context.userId,
        reviewedAt: new Date(),
      }).where(eq(creativeDesignVersions.id, versionId));
    });
    await this.record(context, "pod.creative_design_version.review", "creative_design_version", versionId, { decision: input.decision });
    return this.getCreativeVersion(context, versionId);
  }

  async createSkuBindings(context: TenantContext, versionId: string, rawInput: CreateCreativeDesignSkuBindingsInput) {
    const input = CreateCreativeDesignSkuBindingsInputSchema.parse(rawInput);
    const created = await this.designs.promoteApprovedCreativeBindings(context, versionId, input);
    await this.record(context, "pod.creative_design_version.sku_bind", "creative_design_version", versionId, { bindingCount: created.length });
    return { items: created };
  }

  private record(context: TenantContext, action: string, resourceType: string, resourceId: string, metadata?: Record<string, unknown>) {
    return this.audit.record(context, { action, resourceType, resourceId, result: "success", metadata });
  }
}

type AuthorizedAssetPolicyView = Pick<typeof assetFiles.$inferSelect, "id" | "assetDomain" | "rightsStatus" | "rightsMetadata">;

export function assertAuthorizedAssets(ids: string[], rows: AuthorizedAssetPolicyView[], label: string) {
  if (rows.length !== ids.length) throw new NotFoundException(`${label}: one or more assets were not found`);
  for (const asset of rows) {
    const sourceKind = ((asset.rightsMetadata as { source?: { kind?: RightsSourceKind } }).source?.kind);
    if (asset.assetDomain !== "authorized" || asset.rightsStatus !== "approved") {
      throw new BadRequestException(`${label} must be rights-approved assets in the authorized domain`);
    }
    if (sourceKind === "customer_provided" || sourceKind === "competitor") {
      throw new BadRequestException(`${label} cannot use order-private or competitor source material`);
    }
  }
}

function checksum(value: unknown) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export function creativeBatchConfigured() {
  if (process.env.POD_BATCH_WORKFLOWS_ENABLED?.trim().toLowerCase() !== "true") return false;
  if (!process.env.POD_PROCESSOR_DEPLOYMENT_ID?.trim() || !process.env.POD_PROCESSOR_URL?.trim() || !process.env.POD_PROCESSOR_API_KEY?.trim()) return false;
  const tools = new Set(process.env.POD_ENABLED_TOOLS?.split(",").map((value) => value.trim()).filter(Boolean));
  return tools.has("text_to_image") && tools.has("canvas_extend");
}
