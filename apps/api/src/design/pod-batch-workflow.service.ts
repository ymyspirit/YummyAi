import { ArchiveRecordInputSchema } from "@yummyai/contracts";
import { authorize, Permission } from "@yummyai/authz";
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
  RightsSourceSchema,
  createEntityId,
  type CreateCanvasPrintSpecVersionInput,
  type CreateCreativeDesignBatchInput,
  type CreateCreativeDesignSkuBindingsInput,
  type ReviewVersionInput,
  type TenantContext,
} from "@yummyai/contracts";
import {
  assetFiles,
  activeCreativeAsset,
  spus, productPlans,
  canvasPrintSpecVersions,
  creativeDesignBatchItems,
  creativeDesignBatches,
  creativeDesignCandidates,
  creativeExecutions,
  creativeDesignVersionAssets,
  creativeDesignVersions,
  designRecipeVersions,
  skus,
  type DatabaseConnection,
  withTenant,
} from "@yummyai/database";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";

import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION, POD_BATCH_WORKFLOW_ENQUEUER } from "../platform.tokens.js";
import { DesignService } from "./design.service.js";
import { currentDesignAuthority } from "./design-access.js";
import { requireAssetAuthority } from "../assets/asset-access.js";
import { stageCreativeExecution } from "@yummyai/pod-core";
import { catalogPlanFilter } from "@yummyai/catalog-core";
import { creativeOwnerFilter, printSpecOwner, requireBatchAccess, requireBatchInputs, requireCreativeVersionAccess, requirePrintSpecAccess, requireReferenceAuthority } from "./canvas-workflow-access.js";

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
    return withTenant(this.database.db, context, async (tx) => {
      const { authority } = await currentDesignAuthority(tx, context, [Permission.DesignRead]);
      return tx.select().from(canvasPrintSpecVersions).where(creativeOwnerFilter(authority, Permission.DesignRead, printSpecOwner()))
        .orderBy(desc(canvasPrintSpecVersions.createdAt)).limit(500);
    });
  }

  async createPrintSpec(context: TenantContext, rawInput: CreateCanvasPrintSpecVersionInput) {
    const input = CreateCanvasPrintSpecVersionInputSchema.parse(rawInput);
    const created = await withTenant(this.database.db, context, async (tx) => {
      const { authority } = await currentDesignAuthority(tx, context, [Permission.DesignWrite]);
      const specId = input.specId ?? createEntityId();
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:${specId}:canvas-print-spec`}, 0))`);
      const [latest] = await tx.select({ id: canvasPrintSpecVersions.id, versionNumber: canvasPrintSpecVersions.versionNumber })
        .from(canvasPrintSpecVersions).where(eq(canvasPrintSpecVersions.specId, specId))
        .orderBy(desc(canvasPrintSpecVersions.versionNumber)).limit(1);
      if (input.specId && !latest) throw new NotFoundException("Canvas print specification not found");
      if (latest) await requirePrintSpecAccess(tx, authority, latest.id, [Permission.DesignRead, Permission.DesignWrite]);
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
      const { authority, checkedAt } = await currentDesignAuthority(tx, context, [Permission.DesignRead, Permission.DesignReview]);
      const current = await requirePrintSpecAccess(tx, authority, versionId, [Permission.DesignRead, Permission.DesignReview], "update");
      if (current.status !== "draft") throw new ConflictException("Only draft print specification versions can be reviewed");
      const [updated] = await tx.update(canvasPrintSpecVersions).set({
        status: input.decision === "approve" ? "approved" : "rejected",
        rejectionReason: input.rejectionReason ?? null,
        reviewedBy: context.userId,
        reviewedAt: new Date(checkedAt),
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
    const requestIdentity = checksum({ policyVersion: "creative-design-batch-v2", applicant: context.userId, input });
    const prepared = await withTenant(this.database.db, context, async (tx) => {
      const { authority, checkedAt } = await currentDesignAuthority(tx, context, [Permission.DesignRead, Permission.DesignWrite, Permission.AssetRead]);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:${requestIdentity}:creative-design-batch`}, 0))`);

      if (input.recipeVersionId) {
        const [recipe] = await tx.select().from(designRecipeVersions)
          .where(eq(designRecipeVersions.id, input.recipeVersionId)).limit(1);
        if (!recipe) throw new NotFoundException("Design recipe version not found");
        authorize(authority, Permission.DesignRead, { ownerId: recipe.createdBy });
      }
      const specIds = [...new Set(input.items.flatMap((item) => item.printSpecVersionIds))];
      const specRows: (typeof canvasPrintSpecVersions.$inferSelect)[] = [];
      for (const id of [...specIds].sort()) specRows.push(await requirePrintSpecAccess(tx, authority, id, [Permission.DesignRead]));
      if (specRows.length !== specIds.length) throw new NotFoundException("One or more canvas print specification versions were not found");
      if (specRows.some((spec) => spec.status !== "approved")) {
        throw new BadRequestException("Creative design batches require approved canvas print specification versions");
      }
      const referenceIds = [...new Set(input.items.flatMap((item) => item.referenceAssetIds))];
      const referenceRows = referenceIds.length
        ? await tx.select().from(assetFiles).where(and(inArray(assetFiles.id, referenceIds), isNull(assetFiles.deletedAt))).orderBy(asc(assetFiles.id)).for("share")
        : [];
      assertAuthorizedAssets(referenceIds, referenceRows, "Creative design references");
      requireReferenceAuthority(authority, referenceRows, checkedAt);
      const referenceById = new Map(referenceRows.map((asset) => [asset.id, asset]));
      const pinnedInput = {
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
      };
      const requestChecksum = checksum({ policyVersion: "creative-design-batch-v2", applicant: context.userId, name: input.name, ...pinnedInput });
      const legacyRequestChecksum = checksum({ policyVersion: "creative-design-batch-v1", ...pinnedInput });
      const [replayed] = await tx.select({ id: creativeDesignBatches.id }).from(creativeDesignBatches)
        .where(or(eq(creativeDesignBatches.requestChecksum, requestChecksum), and(eq(creativeDesignBatches.requestChecksum, legacyRequestChecksum), eq(creativeDesignBatches.createdBy, context.userId), eq(creativeDesignBatches.name, input.name))))
        .orderBy(sql`case when ${creativeDesignBatches.requestChecksum} = ${requestChecksum} then 0 else 1 end`).limit(1);
      if (replayed) {
        await requireBatchAccess(tx, authority, replayed.id, [Permission.DesignRead, Permission.DesignWrite]);
        return { id: replayed.id, candidateIds: [] as string[], replayed: true };
      }

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
        for (const candidate of candidates) await stageCreativeExecution(tx, context,
          { kind: "creative_candidate", ownerId: candidate.id, stepKey: "generate" }, "external_request");
      }
      return { id: batchId, candidateIds, replayed: false };
    });

    if (!prepared.replayed) {
      const failedIds = await this.dispatchCandidates(context, prepared.id, prepared.candidateIds);
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

  async archiveDesignBatch(context: TenantContext, id: string, raw: unknown) {
    authorize(context, Permission.DesignWrite);
    const input = ArchiveRecordInputSchema.parse(raw);
    return withTenant(this.database.db, context, async tx => {
      const { authority } = await currentDesignAuthority(tx, context, [Permission.DesignRead, Permission.DesignWrite]);
      const row = await requireBatchAccess(tx, authority, id, [Permission.DesignRead, Permission.DesignWrite], { lock: "update" });
      if (input.archived && ["queued", "running"].includes(row.status)) throw new ConflictException("请先取消正在执行的创意任务");
      if (Boolean(row.archivedAt) === input.archived) return { id, archived: input.archived };
      await tx.update(creativeDesignBatches).set({ archivedAt: input.archived ? new Date() : null }).where(eq(creativeDesignBatches.id, id));
      await this.audit.recordInTransaction(tx, context, { action: "creative_design_batch.archive", resourceType: "creative_design_batch", resourceId: id, result: "success", metadata: input });
      return { id, archived: input.archived };
    });
  }

  async listDesignBatches(context: TenantContext) {
    return withTenant(this.database.db, context, async (tx) => {
      const { authority } = await currentDesignAuthority(tx, context, [Permission.DesignRead]);
      return tx.select().from(creativeDesignBatches).where(and(isNull(creativeDesignBatches.archivedAt), creativeOwnerFilter(authority, Permission.DesignRead, creativeDesignBatches.createdBy)))
        .orderBy(desc(creativeDesignBatches.createdAt)).limit(200);
    });
  }

  async designOptions(context: TenantContext) {
    return withTenant(this.database.db, context, async (tx) => {
      const { authority } = await currentDesignAuthority(tx, context, [Permission.DesignRead, Permission.AssetRead]);
      const [allSpecs, assets, skuRows] = await Promise.all([
        tx.select().from(canvasPrintSpecVersions).where(creativeOwnerFilter(authority, Permission.DesignRead, printSpecOwner())).orderBy(asc(canvasPrintSpecVersions.name), desc(canvasPrintSpecVersions.versionNumber)),
        tx.select({
          id: assetFiles.id, fileName: assetFiles.fileName, mediaType: assetFiles.mediaType,
          version: assetFiles.version, checksumSha256: assetFiles.checksumSha256,
        }).from(assetFiles).where(and(
          eq(assetFiles.assetDomain, "authorized"), eq(assetFiles.rightsStatus, "approved"), isNull(assetFiles.deletedAt),
          activeCreativeAsset(),
          creativeOwnerFilter(authority, Permission.AssetRead, assetFiles.ownerUserId),
          sql`coalesce(${assetFiles.rightsMetadata}->'source'->>'kind', '') not in ('customer_provided','competitor')`,
        )).orderBy(desc(assetFiles.createdAt)).limit(500),
        authority.permissions.includes(Permission.ProductRead) ? tx.select({ id: skus.id, code: skus.code, attributes: skus.attributes, status: skus.status })
          .from(skus).innerJoin(spus, eq(spus.id, skus.spuId)).innerJoin(productPlans, eq(productPlans.id, spus.productPlanId))
          .where(and(inArray(skus.status, ["draft", "active"]), catalogPlanFilter(authority, Permission.ProductRead), sql`${spus.status} <> 'archived' and ${productPlans.status} <> 'archived'`)).orderBy(asc(skus.code)).limit(500) : [],
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
      const { authority } = await currentDesignAuthority(tx, context, [Permission.DesignRead, Permission.AssetRead]);
      const batch = await requireBatchAccess(tx, authority, batchId, [Permission.DesignRead]);
      const items = (await requireBatchInputs(tx, authority, batch)).sort((a, b) => a.ordinal - b.ordinal);
      const itemIds = items.map((item) => item.id);
      const candidates = itemIds.length ? await tx.select().from(creativeDesignCandidates)
        .where(inArray(creativeDesignCandidates.itemId, itemIds)).orderBy(asc(creativeDesignCandidates.ordinal)) : [];
      const candidateIds = candidates.map((candidate) => candidate.id);
      const versions = candidateIds.length ? await tx.select().from(creativeDesignVersions)
        .where(inArray(creativeDesignVersions.sourceCandidateId, candidateIds)) : [];
      const versionIds = versions.map((version) => version.id);
      const assets = versionIds.length ? await tx.select().from(creativeDesignVersionAssets)
        .where(inArray(creativeDesignVersionAssets.creativeDesignVersionId, versionIds)) : [];
      for (const version of versions) authorize(authority, Permission.DesignRead, { ownerId: version.createdBy });
      const outputIds = [...new Set([...assets.map(asset => asset.assetId), ...candidates.flatMap(candidate => candidate.assetId ? [candidate.assetId] : [])])].sort();
      const files = outputIds.length ? await tx.select().from(assetFiles).where(inArray(assetFiles.id, outputIds)).orderBy(asc(assetFiles.id)).for("share") : [];
      if (files.length !== outputIds.length) throw new NotFoundException("Creative asset not found");
      requireReferenceAuthority(authority, files);
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
      const { authority } = await currentDesignAuthority(tx, context, [Permission.DesignRead, Permission.DesignWrite, Permission.AssetRead]);
      const batch = await requireBatchAccess(tx, authority, batchId, [Permission.DesignRead, Permission.DesignWrite], { lock: "update" });
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
      const { authority, checkedAt } = await currentDesignAuthority(tx, context, [Permission.DesignRead, Permission.DesignWrite, Permission.AssetRead]);
      const batch = await requireBatchAccess(tx, authority, batchId, [Permission.DesignRead, Permission.DesignWrite], { lock: "update", mutation: true });
      await requireBatchInputs(tx, authority, batch, checkedAt);
      const [item] = await tx.select().from(creativeDesignBatchItems)
        .where(and(eq(creativeDesignBatchItems.id, itemId), eq(creativeDesignBatchItems.batchId, batchId))).limit(1);
      if (!item) throw new NotFoundException("Creative design batch item not found");
      const failed = await tx.select().from(creativeDesignCandidates)
        .where(and(eq(creativeDesignCandidates.itemId, itemId), eq(creativeDesignCandidates.status, "failed"))).for("update");
      if (!failed.length) throw new ConflictException("The batch item has no failed candidates to retry");
      if (failed.some(candidate => candidate.errorCode !== "QUEUE_UNAVAILABLE"))
        throw new ConflictException("原调用结果待核对 请先确认响应与费用 不能直接重新生成");
      const originals = await tx.select({ row: creativeExecutions, active: sql<boolean>`${creativeExecutions.leaseExpiresAt}>clock_timestamp()` })
        .from(creativeExecutions).where(inArray(creativeExecutions.candidateId, failed.map(candidate => candidate.id))).for("share", { skipLocked: true });
      if (failed.some(candidate => {
        const original = originals.find(record => record.row.candidateId === candidate.id);
        return !original || original.active || original.row.requestedBy !== context.userId || original.row.kind !== "creative_candidate"
          || original.row.stepKey !== "generate" || !["pending", "preparing"].includes(original.row.phase) || original.row.attemptCount >= 3
          || original.row.submittedAt || original.row.receipt || original.row.responseObjectKey;
      })) throw new ConflictException("原执行不能证明尚未提交 请核对原响应与费用后创建新操作");
      await tx.update(creativeDesignCandidates).set({
        status: "queued", errorCode: null, errorMessage: null, completedAt: null, updatedAt: new Date(),
      }).where(inArray(creativeDesignCandidates.id, failed.map((row) => row.id)));
      await tx.update(creativeDesignBatchItems).set({ status: "queued", errorCode: null, errorMessage: null, completedAt: null, updatedAt: new Date() })
        .where(eq(creativeDesignBatchItems.id, itemId));
      return failed.map((row) => row.id);
    });
    const failedIds = await this.dispatchCandidates(context, batchId, candidateIds);
    if (failedIds.length) throw new ServiceUnavailableException("Creative design queue is unavailable");
    await this.record(context, "pod.creative_design_item.retry", "creative_design_batch_item", itemId, { batchId, candidateCount: candidateIds.length });
    return this.getDesignBatch(context, batchId);
  }

  async selectCandidate(context: TenantContext, batchId: string, candidateId: string) {
    const selected = await withTenant(this.database.db, context, async (tx) => {
      const { authority, checkedAt } = await currentDesignAuthority(tx, context, [Permission.DesignRead, Permission.DesignWrite, Permission.AssetRead]);
      const batch = await requireBatchAccess(tx, authority, batchId, [Permission.DesignRead, Permission.DesignWrite], { lock: "update", mutation: true });
      await requireBatchInputs(tx, authority, batch, checkedAt);
      const [candidate] = await tx.select({
        candidate: creativeDesignCandidates,
        item: creativeDesignBatchItems,
      }).from(creativeDesignCandidates)
        .innerJoin(creativeDesignBatchItems, eq(creativeDesignCandidates.itemId, creativeDesignBatchItems.id))
        .where(and(eq(creativeDesignCandidates.id, candidateId), eq(creativeDesignBatchItems.batchId, batchId))).limit(1).for("update");
      if (!candidate) throw new NotFoundException("Creative design candidate not found");
      if (candidate.candidate.assetId) {
        const [asset] = await tx.select().from(assetFiles).where(eq(assetFiles.id, candidate.candidate.assetId)).for("share");
        if (!asset) throw new NotFoundException("Creative asset not found");
        requireReferenceAuthority(authority, [asset], checkedAt);
        const kind = (asset.rightsMetadata.source as { kind?: string } | undefined)?.kind;
        if (asset.deletedAt || asset.assetDomain !== "authorized" || asset.rightsStatus === "rejected" ||
          ["customer_provided", "competitor"].includes(kind ?? "") || asset.version !== candidate.candidate.assetVersion || asset.checksumSha256 !== candidate.candidate.checksumSha256)
          throw new ConflictException("候选原图已变化或不可用 请核对原任务");
      }
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
      for (const id of [...candidate.item.printSpecVersionIds].sort()) {
        await requirePrintSpecAccess(tx, authority, id, [Permission.DesignRead]);
        // Geometry decides whether expansion is necessary. Paid outpainting is
        // a separate child invocation, never inferred from the wrap-mode label.
        await stageCreativeExecution(tx, context, { kind: "creative_adaptation", ownerId: versionId, stepKey: `spec:${id}` }, "internal_write");
      }
      return { versionId, replayed: false };
    });
    if (!selected.replayed) {
      await withTenant(this.database.db, context, async tx => {
        const { authority, checkedAt } = await currentDesignAuthority(tx, context, [Permission.DesignRead, Permission.DesignWrite, Permission.AssetRead]);
        const batch = await requireBatchAccess(tx, authority, batchId, [Permission.DesignRead, Permission.DesignWrite], { mutation: true });
        await requireBatchInputs(tx, authority, batch, checkedAt);
      });
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
      const { authority } = await currentDesignAuthority(tx, context, [Permission.DesignRead, Permission.AssetRead]);
      const { version } = await requireCreativeVersionAccess(tx, authority, versionId, [Permission.DesignRead]);
      const assets = await tx.select().from(creativeDesignVersionAssets)
        .where(eq(creativeDesignVersionAssets.creativeDesignVersionId, versionId));
      const ids = [...new Set(assets.map(asset => asset.assetId))].sort();
      const files = ids.length ? await tx.select().from(assetFiles).where(inArray(assetFiles.id, ids)).orderBy(asc(assetFiles.id)).for("share") : [];
      if (files.length !== ids.length) throw new NotFoundException("Creative asset not found");
      for (const file of files) requireAssetAuthority(authority, Permission.AssetRead, file);
      return { ...version, assets };
    });
  }

  async reviewCreativeVersion(context: TenantContext, versionId: string, rawInput: ReviewVersionInput) {
    const input = ReviewVersionInputSchema.parse(rawInput);
    await withTenant(this.database.db, context, async (tx) => {
      const { authority, checkedAt } = await currentDesignAuthority(tx, context, [Permission.DesignRead, Permission.DesignReview, Permission.AssetRead]);
      const { version, batch: parent } = await requireCreativeVersionAccess(tx, authority, versionId, [Permission.DesignRead, Permission.DesignReview], { lock: "update", mutation: true });
      await requireBatchInputs(tx, authority, parent, checkedAt);
      if (version.status !== "pending_review") throw new ConflictException("Only pending creative design versions can be reviewed");
      const assets = await tx.select().from(creativeDesignVersionAssets)
        .where(eq(creativeDesignVersionAssets.creativeDesignVersionId, versionId));
      const ids = [...new Set(assets.map(asset => asset.assetId))].sort();
      const files = ids.length ? await tx.select().from(assetFiles).where(inArray(assetFiles.id, ids)).orderBy(asc(assetFiles.id)).for("update") : [];
      if (files.length !== ids.length) throw new NotFoundException("Creative asset not found");
      for (const file of files) requireAssetAuthority(authority, Permission.AssetRead, file);
      if (input.decision === "approve") {
        const [candidate] = await tx.select({ itemId: creativeDesignCandidates.itemId }).from(creativeDesignCandidates)
          .where(eq(creativeDesignCandidates.id, version.sourceCandidateId)).limit(1);
        const [item] = await tx.select({ printSpecVersionIds: creativeDesignBatchItems.printSpecVersionIds }).from(creativeDesignBatchItems)
          .where(eq(creativeDesignBatchItems.id, candidate!.itemId)).limit(1);
        const presentSpecs = new Set(assets.flatMap((asset) => asset.printSpecVersionId ? [asset.printSpecVersionId] : []));
        if (!assets.some((asset) => asset.role === "master") || item!.printSpecVersionIds.some((id) => !presentSpecs.has(id))) {
          throw new ConflictException("Master and every required aspect variant must be complete before approval");
        }
        for (const file of files) {
          const metadata = file.rightsMetadata, raw = metadata.source as { kind?: string; reference?: string } | undefined;
          if (file.deletedAt || file.assetDomain !== "authorized" || !raw || raw.kind === "competitor" || raw.kind === "customer_provided")
            throw new ConflictException("Creative approval requires available authorized source material");
          const source = RightsSourceSchema.safeParse({ ...raw, reference: raw.reference || (["owned", "ai_generated"].includes(raw.kind ?? "") ? `creative-review:${version.id}` : undefined) });
          if (!source.success || (source.data.licenseExpiresAt && !(Date.parse(source.data.licenseExpiresAt) > checkedAt)))
            throw new ConflictException("Current rights evidence is missing or expired");
          const hadApproval = file.rightsStatus === "approved" && typeof metadata.approvedAt === "string" && Number.isFinite(Date.parse(metadata.approvedAt));
          await tx.update(assetFiles).set({ rightsStatus: "approved", rightsMetadata: {
            ...metadata, source: source.data, approvedAt: hadApproval ? metadata.approvedAt : new Date(checkedAt).toISOString(),
            approvedBy: hadApproval ? metadata.approvedBy : context.userId,
          } }).where(eq(assetFiles.id, file.id));
        }
      }
      await tx.update(creativeDesignVersions).set({
        status: input.decision === "approve" ? "approved" : "rejected",
        rejectionReason: input.rejectionReason ?? null,
        reviewedBy: context.userId,
        reviewedAt: new Date(checkedAt),
      }).where(eq(creativeDesignVersions.id, versionId));
      const [source] = await tx.select({ batchId: creativeDesignBatchItems.batchId }).from(creativeDesignCandidates)
        .innerJoin(creativeDesignBatchItems, eq(creativeDesignCandidates.itemId, creativeDesignBatchItems.id))
        .where(eq(creativeDesignCandidates.id, version.sourceCandidateId)).limit(1);
      if (source) {
        const [batch] = await tx.select().from(creativeDesignBatches).where(eq(creativeDesignBatches.id, source.batchId)).for("update");
        if (batch?.executionMode === "infinite_canvas" && batch.status !== "cancelled") {
          const versions = await tx.select({ status: creativeDesignVersions.status }).from(creativeDesignVersions)
            .innerJoin(creativeDesignCandidates, eq(creativeDesignVersions.sourceCandidateId, creativeDesignCandidates.id))
            .innerJoin(creativeDesignBatchItems, eq(creativeDesignCandidates.itemId, creativeDesignBatchItems.id))
            .where(eq(creativeDesignBatchItems.batchId, batch.id));
          const pending = versions.some((entry) => entry.status === "pending_review" || entry.status === "adapting");
          await tx.update(creativeDesignBatches).set({ approvedCount: versions.filter((entry) => entry.status === "approved").length, status: pending ? "awaiting_review" : "completed", completedAt: pending ? null : new Date(), updatedAt: new Date() }).where(eq(creativeDesignBatches.id, batch.id));
          await tx.update(creativeDesignBatchItems).set({ status: pending ? "awaiting_review" : "completed", updatedAt: new Date() }).where(eq(creativeDesignBatchItems.batchId, batch.id));
        }
      }
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

  private async dispatchCandidates(context: TenantContext, batchId: string, ids: string[]) {
    const failed: string[] = [];
    for (const candidateId of ids) {
      // Queue I/O never holds membership or source locks. Every next dispatch
      // rechecks authority; workers still need their own execution admission.
      await withTenant(this.database.db, context, async tx => {
        const { authority, checkedAt } = await currentDesignAuthority(tx, context, [Permission.DesignRead, Permission.DesignWrite, Permission.AssetRead]);
        const batch = await requireBatchAccess(tx, authority, batchId, [Permission.DesignRead, Permission.DesignWrite], { mutation: true });
        await requireBatchInputs(tx, authority, batch, checkedAt);
        const [candidate] = await tx.select({ status: creativeDesignCandidates.status }).from(creativeDesignCandidates)
          .innerJoin(creativeDesignBatchItems, eq(creativeDesignBatchItems.id, creativeDesignCandidates.itemId))
          .where(and(eq(creativeDesignCandidates.id, candidateId), eq(creativeDesignBatchItems.batchId, batchId)));
        if (candidate?.status !== "queued") throw new ConflictException("候选已被处理 请核对当前任务");
      });
      try { await this.enqueuer.enqueueCreativeCandidate({ candidateId, tenantId: context.tenantId, requestedBy: context.userId }); }
      catch {
        failed.push(candidateId);
        // This is queue bookkeeping, not permission to adopt a model result.
        await withTenant(this.database.db, context, tx => tx.update(creativeDesignCandidates).set({
          status: "failed", errorCode: "QUEUE_UNAVAILABLE", errorMessage: "Creative design queue is unavailable", completedAt: new Date(), updatedAt: new Date(),
        }).where(and(eq(creativeDesignCandidates.id, candidateId), eq(creativeDesignCandidates.status, "queued"))));
      }
    }
    return failed;
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
