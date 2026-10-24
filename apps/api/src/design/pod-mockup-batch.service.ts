import { createHash } from "node:crypto";
import { requireMockupCompletionEvidence, stageCreativeExecution } from "@yummyai/pod-core";
import { authorize, Permission, type PermissionValue } from "@yummyai/authz";
import { assertCatalogListingAccess, catalogAssetReadFilter, creativeOwnerFilter,
  mockupPackOwner, requireMockupInspectionAccess, requireMockupPackAccess, requireMockupBatchAccess,
  requireMockupAsset, requireMockupInspectionSources, requireMockupPackSources, requireMockupDesignSource, requirePrintSpecAccess, printSpecOwner } from "@yummyai/catalog-core";

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  CreateMockupBatchInputSchema,
  CreateMockupListingBindingsInputSchema,
  CreateMockupTemplateInspectionInputSchema,
  CreateMockupTemplatePackVersionInputSchema,
  ReviewMockupBatchInputSchema,
  ReviewVersionInputSchema,
  createEntityId,
  type CreateMockupBatchInput,
  type CreateMockupListingBindingsInput,
  type CreateMockupTemplateInspectionInput,
  type CreateMockupTemplatePackVersionInput,
  type ReviewMockupBatchInput,
  type ReviewVersionInput,
  type TenantContext,
} from "@yummyai/contracts";
import {
  assetFiles,
  canvasPrintSpecVersions,
  designTasks,
  designVersions,
  listings,
  listingVersions,
  mockupBatchItems,
  mockupBatchOutputs,
  mockupBatches,
  mockupTemplatePackVersions,
  mockupTemplateSlots,
  mockupTemplateSourceInspections,
  skus,
  type DatabaseConnection,
  withTenant,
  creativeExecutions,
  type TenantTransaction,
} from "@yummyai/database";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION, POD_BATCH_WORKFLOW_ENQUEUER } from "../platform.tokens.js";
import type { PodBatchWorkflowEnqueuer } from "./pod-batch-workflow.service.js";
import { PodGovernanceService } from "./pod-governance.service.js";
import { currentDesignAuthority } from "./design-access.js";

const MOCKUP_COMPILER_VERSION = "controlled-psd-v1";

@Injectable()
export class PodMockupBatchService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(POD_BATCH_WORKFLOW_ENQUEUER) private readonly enqueuer: PodBatchWorkflowEnqueuer,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PodGovernanceService) private readonly governance: PodGovernanceService,
  ) {}

  async createInspection(context: TenantContext, rawInput: CreateMockupTemplateInspectionInput) {
    const input = CreateMockupTemplateInspectionInputSchema.parse(rawInput);
    const prepared = await this.transaction(context, [Permission.DesignRead, Permission.DesignWrite, Permission.AssetRead], async (tx, authority, checkedAt) => {
      const asset = await requireMockupAsset(tx, authority, input.sourceAssetId,
        { version: input.sourceAssetVersion, checksumSha256: input.checksumSha256 }, checkedAt);
      assertTemplateSourceAsset(asset);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:${input.sourceAssetId}:${input.sourceAssetVersion}:${input.slotKey}:${MOCKUP_COMPILER_VERSION}:inspection`},0))`);
      const [existing] = await tx.select().from(mockupTemplateSourceInspections).where(and(
        eq(mockupTemplateSourceInspections.sourceAssetId, input.sourceAssetId),
        eq(mockupTemplateSourceInspections.sourceAssetVersion, input.sourceAssetVersion),
        eq(mockupTemplateSourceInspections.slotKey, input.slotKey),
        eq(mockupTemplateSourceInspections.compilerVersion, MOCKUP_COMPILER_VERSION),
      )).limit(1);
      if (existing) {
        await requireMockupInspectionAccess(tx, authority, existing.id, [Permission.DesignRead, Permission.DesignWrite]);
        return { row: existing, replayed: true };
      }
      const [row] = await tx.insert(mockupTemplateSourceInspections).values({
        id: createEntityId(), tenantId: context.tenantId,
        sourceAssetId: asset.id, sourceAssetVersion: asset.version, checksumSha256: asset.checksumSha256,
        slotKey: input.slotKey, compilerVersion: MOCKUP_COMPILER_VERSION, requestedBy: context.userId,
      }).returning();
      await stageCreativeExecution(tx, authority, { kind: "template_compile", ownerId: row!.id, stepKey: "compile" }, "internal_write");
      await this.audit.recordInTransaction(tx, context, { action: "pod.mockup_template_inspection.create", resourceType: "mockup_template_source_inspection", resourceId: row!.id, result: "success", metadata: { slotKey: input.slotKey } });
      return { row: row!, replayed: false };
    });
    if (!prepared.replayed) {
      try {
        await this.enqueuer.enqueueTemplateCompile({ inspectionId: prepared.row.id, tenantId: context.tenantId, requestedBy: context.userId });
      } catch {
        await withTenant(this.database.db, context, (tx) => tx.update(mockupTemplateSourceInspections).set({
          status: "failed", errorCode: "QUEUE_UNAVAILABLE", errorMessage: "Mockup template compile queue is unavailable", completedAt: new Date(),
        }).where(and(eq(mockupTemplateSourceInspections.id, prepared.row.id), eq(mockupTemplateSourceInspections.status, "queued"))));
        throw new ServiceUnavailableException("Mockup template compile queue is unavailable");
      }
    }
    return this.getInspection(context, prepared.row.id);
  }

  async listInspections(context: TenantContext) {
    return this.transaction(context, [Permission.DesignRead, Permission.AssetRead], async (tx, authority) => {
      const rows = await tx.select().from(mockupTemplateSourceInspections).where(creativeOwnerFilter(authority, Permission.DesignRead, mockupTemplateSourceInspections.requestedBy))
        .orderBy(desc(mockupTemplateSourceInspections.createdAt)).limit(500);
      const visible = [];
      for (const row of rows) if (await this.accessible(async () => requireMockupInspectionSources(tx, authority, row))) visible.push(await this.inspectionView(tx, row));
      return visible;
    });
  }

  async getInspection(context: TenantContext, inspectionId: string) {
    return this.transaction(context, [Permission.DesignRead, Permission.AssetRead], async (tx, authority) => {
      const row = await requireMockupInspectionAccess(tx, authority, inspectionId, [Permission.DesignRead]);
      await requireMockupInspectionSources(tx, authority, row);
      return this.inspectionView(tx, row);
    });
  }

  async confirmInspection(context: TenantContext, inspectionId: string, expectedFingerprint: string) {
    await this.transaction(context, [Permission.DesignRead, Permission.DesignReview, Permission.AssetRead], async (tx, authority, checkedAt) => {
      const row = await requireMockupInspectionAccess(tx, authority, inspectionId, [Permission.DesignRead, Permission.DesignReview], "update");
      const { assets } = await requireMockupInspectionSources(tx, authority, row, checkedAt, true);
      if (this.inspectionFingerprint(row) !== expectedFingerprint) throw new ConflictException("模板检查依据已变化 请刷新后重新确认");
      const evidenceMode = await requireMockupCompletionEvidence(tx, authority, { kind: "template_compile", ownerId: row.id, stepKey: "compile" }, assets, true);
      if (row.confirmedAt) return;
      await tx.update(mockupTemplateSourceInspections).set({ confirmedBy: context.userId, confirmedAt: new Date() }).where(eq(mockupTemplateSourceInspections.id, inspectionId));
      await this.audit.recordInTransaction(tx, context, { action: "pod.mockup_template_inspection.confirm", resourceType: "mockup_template_source_inspection", resourceId: inspectionId,
        result: "success", metadata: { ssimPermille: row.compilation!.ssimPermille, evidenceMode, expectedFingerprint } });
    });
    return this.getInspection(context, inspectionId);
  }

  async createTemplatePack(context: TenantContext, rawInput: CreateMockupTemplatePackVersionInput) {
    const input = CreateMockupTemplatePackVersionInputSchema.parse(rawInput);
    const created = await this.transaction(context, [Permission.DesignRead, Permission.DesignWrite, Permission.AssetRead], async (tx, authority, checkedAt) => {
      const packId = input.packId ?? createEntityId();
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:${packId}:mockup-template-pack`}, 0))`);
      const [original] = await tx.select().from(mockupTemplatePackVersions).where(eq(mockupTemplatePackVersions.packId, packId))
        .orderBy(asc(mockupTemplatePackVersions.versionNumber)).limit(1);
      if (input.packId && !original) throw new NotFoundException("原模板包不存在");
      if (original) authorize(authority, Permission.DesignWrite, { ownerId: original.createdBy });
      const inspectionIds = [...new Set(input.slots.map((slot) => slot.inspectionId))];
      const inspections = [];
      for (const id of inspectionIds.sort()) {
        const inspection = await requireMockupInspectionAccess(tx, authority, id, [Permission.DesignRead]);
        const { assets } = await requireMockupInspectionSources(tx, authority, inspection, checkedAt, true);
        await requireMockupCompletionEvidence(tx, authority, { kind: "template_compile", ownerId: id, stepKey: "compile" }, assets, true);
        inspections.push(inspection);
      }
      if (inspections.length !== inspectionIds.length) throw new NotFoundException("One or more template inspections were not found");
      const inspectionById = new Map(inspections.map((inspection) => [inspection.id, inspection]));
      for (const slot of input.slots) {
        const inspection = inspectionById.get(slot.inspectionId)!;
        if (inspection.status !== "completed" || !inspection.compilation || inspection.compilation.ssimPermille < 990 || !inspection.confirmedAt) {
          throw new ConflictException(`Template slot ${slot.slotKey} does not have a passing compiled render package`);
        }
        if (inspection.slotKey !== slot.slotKey || inspection.compilation.slotKey !== slot.slotKey) {
          throw new ConflictException(`Template inspection does not match slot ${slot.slotKey}`);
        }
      }
      const specIds = [...new Set(input.slots.flatMap((slot) => slot.acceptedPrintSpecVersionIds))];
      const specVersions = [];
      for (const id of specIds.sort()) specVersions.push(await requirePrintSpecAccess(tx, authority, id, [Permission.DesignRead]));
      if (specVersions.length !== specIds.length || specVersions.some((spec) => spec.status !== "approved")) {
        throw new ConflictException("Template slots require approved canvas print specification versions");
      }
      const [latest] = await tx.select({ versionNumber: mockupTemplatePackVersions.versionNumber }).from(mockupTemplatePackVersions)
        .where(eq(mockupTemplatePackVersions.packId, packId)).orderBy(desc(mockupTemplatePackVersions.versionNumber)).limit(1);
      const [pack] = await tx.insert(mockupTemplatePackVersions).values({
        id: createEntityId(), tenantId: context.tenantId, packId,
        versionNumber: (latest?.versionNumber ?? 0) + 1,
        name: input.name, platform: input.platform, locale: input.locale,
        productCategory: input.productCategory, createdBy: context.userId,
      }).returning();
      await tx.insert(mockupTemplateSlots).values(input.slots.map((slot) => ({
        id: createEntityId(), tenantId: context.tenantId, templatePackVersionId: pack!.id,
        inspectionId: slot.inspectionId, slotKey: slot.slotKey, label: slot.label,
        ordinal: slot.ordinal, required: slot.required,
        acceptedPrintSpecVersionIds: slot.acceptedPrintSpecVersionIds,
      })));
      await this.audit.recordInTransaction(tx, context, { action: "pod.mockup_template_pack.create", resourceType: "mockup_template_pack_version", resourceId: pack!.id,
        result: "success", metadata: { slotCount: input.slots.length } });
      return pack!;
    });
    return this.getTemplatePack(context, created.id);
  }

  async listTemplatePacks(context: TenantContext) {
    const packs = await this.transaction(context, [Permission.DesignRead], (tx, authority) => tx.select().from(mockupTemplatePackVersions)
      .where(creativeOwnerFilter(authority, Permission.DesignRead, mockupPackOwner())).orderBy(desc(mockupTemplatePackVersions.createdAt)).limit(500));
    return { items: packs };
  }

  async getTemplatePack(context: TenantContext, versionId: string) {
    return this.transaction(context, [Permission.DesignRead, Permission.AssetRead], async (tx, authority) => {
      const pack = await requireMockupPackAccess(tx, authority, versionId, [Permission.DesignRead]);
      const { slots } = await requireMockupPackSources(tx, authority, pack);
      return { ...pack, slots };
    });
  }

  async reviewTemplatePack(context: TenantContext, versionId: string, rawInput: ReviewVersionInput) {
    const input = ReviewVersionInputSchema.parse(rawInput);
    await this.transaction(context, [Permission.DesignRead, Permission.DesignReview, Permission.AssetRead], async (tx, authority, checkedAt) => {
      const pack = await requireMockupPackAccess(tx, authority, versionId, [Permission.DesignRead, Permission.DesignReview], "update");
      if (pack.status !== "draft") throw new ConflictException("Only draft template pack versions can be reviewed");
      if (input.decision === "reject") await requireMockupPackSources(tx, authority, pack);
      if (input.decision === "approve") {
        const originalSources = await requireMockupPackSources(tx, authority, pack, checkedAt);
        for (const inspection of originalSources.inspections) {
          const { assets } = await requireMockupInspectionSources(tx, authority, inspection, checkedAt, true);
          await requireMockupCompletionEvidence(tx, authority, { kind: "template_compile", ownerId: inspection.id, stepKey: "compile" }, assets, true);
        }
        const slots = await tx.select({ slot: mockupTemplateSlots, inspection: mockupTemplateSourceInspections })
          .from(mockupTemplateSlots)
          .innerJoin(mockupTemplateSourceInspections, eq(mockupTemplateSlots.inspectionId, mockupTemplateSourceInspections.id))
          .where(eq(mockupTemplateSlots.templatePackVersionId, versionId));
        if (!slots.length || slots.some(({ inspection }) => inspection.status !== "completed" || !inspection.compilation || inspection.compilation.ssimPermille < 990)) {
          throw new ConflictException("Every template slot must have a passing compiled render package before approval");
        }
      }
      await tx.update(mockupTemplatePackVersions).set({
        status: input.decision === "approve" ? "approved" : "rejected",
        rejectionReason: input.rejectionReason ?? null,
        reviewedBy: context.userId,
        reviewedAt: new Date(),
      }).where(eq(mockupTemplatePackVersions.id, versionId));
      await this.audit.recordInTransaction(tx, context, { action: "pod.mockup_template_pack.review", resourceType: "mockup_template_pack_version", resourceId: versionId,
        result: "success", metadata: { decision: input.decision } });
    });
    return this.getTemplatePack(context, versionId);
  }

  async createBatch(context: TenantContext, rawInput: CreateMockupBatchInput) {
    if (!mockupRendererConfigured()) {
      throw new ServiceUnavailableException("Batch mockup rendering is disabled until the controlled renderer is ready");
    }
    const input = CreateMockupBatchInputSchema.parse(rawInput);
    const requestIdentity = checksum({ policyVersion: "mockup-render-v1", input });
    const prepared = await this.transaction(context, [Permission.DesignRead, Permission.DesignWrite, Permission.AssetRead, Permission.ProductRead], async (tx, authority, checkedAt) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:${requestIdentity}:mockup-batch`}, 0))`);
      const pack = await requireMockupPackAccess(tx, authority, input.templatePackVersionId, [Permission.DesignRead]);
      if (pack.status !== "approved") throw new ConflictException("Mockup batches require an approved template pack version");
      if (pack.platform !== input.platform || pack.locale !== input.locale) throw new ConflictException("Template platform and locale must match the batch");
      const templateSources = await requireMockupPackSources(tx, authority, pack, checkedAt);
      const slots = templateSources.slots;
      if (!slots.length) throw new ConflictException("Template pack has no slots");
      const inspections = await tx.select().from(mockupTemplateSourceInspections)
        .where(inArray(mockupTemplateSourceInspections.id, slots.map((slot) => slot.inspectionId)));
      const inspectionById = new Map(inspections.map((inspection) => [inspection.id, inspection]));
      for (const inspection of inspections) {
        const { assets } = await requireMockupInspectionSources(tx, authority, inspection, checkedAt, true);
        await requireMockupCompletionEvidence(tx, authority, { kind: "template_compile", ownerId: inspection.id, stepKey: "compile" }, assets, true);
      }
      if (inspections.length !== slots.length || inspections.some((inspection) => inspection.status !== "completed" || !inspection.compilation)) {
        throw new ConflictException("Template pack compilation snapshot is incomplete");
      }
      const artworkByVersion = new Map<string, typeof assetFiles.$inferSelect>();
      const bindingByVersion = new Map<string, { printSpecVersionId: string }>();
      for (const item of input.items) {
        const source = await requireMockupDesignSource(tx, authority, item.designVersionId, item.skuId, checkedAt);
        if (slots.some((slot) => !slot.acceptedPrintSpecVersionIds.includes(source.printSpecVersionId))) {
          throw new ConflictException("Formal design print specification is incompatible with one or more template slots");
        }
        artworkByVersion.set(item.designVersionId, source.artwork);
        bindingByVersion.set(item.designVersionId, source);
      }
      const requestChecksum = checksum({
        policyVersion: "mockup-render-v2", requestedBy: context.userId,
        platform: input.platform,
        locale: input.locale,
        template: {
          id: pack.id, versionNumber: pack.versionNumber,
          slots: slots.map((slot) => ({
            slotKey: slot.slotKey, required: slot.required,
            acceptedPrintSpecVersionIds: slot.acceptedPrintSpecVersionIds,
            compilationChecksum: inspectionById.get(slot.inspectionId)!.compilation!.checksumSha256,
            compilerVersion: inspectionById.get(slot.inspectionId)!.compilerVersion,
          })),
        },
        items: input.items.map((item) => {
          const asset = artworkByVersion.get(item.designVersionId)!;
          return {
            ...item,
            printSpecVersionId: bindingByVersion.get(item.designVersionId)!.printSpecVersionId,
            asset: { id: asset.id, version: asset.version, checksumSha256: asset.checksumSha256 },
          };
        }),
      });
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:${requestChecksum}:original-mockup-request`},0))`);
      const [replayed] = await tx.select({ id: mockupBatches.id }).from(mockupBatches).where(eq(mockupBatches.requestChecksum, requestChecksum)).limit(1);
      if (replayed) {
        await requireMockupBatchAccess(tx, authority, replayed.id, [Permission.DesignRead, Permission.DesignWrite]);
        return { id: replayed.id, itemIds: [] as string[], replayed: true };
      }
      const batchId = createEntityId();
      await tx.insert(mockupBatches).values({
        id: batchId, tenantId: context.tenantId, name: input.name,
        templatePackVersionId: pack.id, platform: input.platform, locale: input.locale,
        itemCount: input.items.length, requestChecksum, createdBy: context.userId,
      });
      const itemIds: string[] = [];
      for (const [ordinal, item] of input.items.entries()) {
        const itemId = createEntityId();
        itemIds.push(itemId);
        await tx.insert(mockupBatchItems).values({ id: itemId, tenantId: context.tenantId, batchId, ordinal, ...item });
        await tx.insert(mockupBatchOutputs).values(slots.map((slot) => ({
          id: createEntityId(), tenantId: context.tenantId, itemId,
          templateSlotId: slot.id, slotKey: slot.slotKey, attempt: 1,
        })));
        for (const slot of slots) await stageCreativeExecution(tx, authority,
          { kind: "mockup_render", ownerId: itemId, stepKey: `slot:${slot.id}` }, "internal_write");
      }
      await this.audit.recordInTransaction(tx, context, { action: "pod.mockup_batch.create", resourceType: "mockup_batch", resourceId: batchId,
        result: "success", metadata: { itemCount: input.items.length, requestChecksum, policyVersion: "mockup-render-v2" } });
      return { id: batchId, itemIds, replayed: false };
    });
    if (!prepared.replayed) {
      const dispatches = await Promise.allSettled(prepared.itemIds.map((itemId) => this.enqueuer.enqueueMockupRender({ itemId, tenantId: context.tenantId, requestedBy: context.userId })));
      const failedItemIds = dispatches.flatMap((result, index) => result.status === "rejected" ? [prepared.itemIds[index]!] : []);
      if (failedItemIds.length) await this.failQueuedOutputs(context, failedItemIds, "QUEUE_UNAVAILABLE", "Mockup render queue is unavailable");
      if (failedItemIds.length === prepared.itemIds.length) throw new ServiceUnavailableException("Mockup render queue is unavailable");
    }
    return this.getBatch(context, prepared.id);
  }

  async listBatches(context: TenantContext) {
    return this.transaction(context, [Permission.DesignRead], (tx, authority) => tx.select().from(mockupBatches)
      .where(creativeOwnerFilter(authority, Permission.DesignRead, mockupBatches.createdBy)).orderBy(desc(mockupBatches.createdAt)).limit(200));
  }

  async batchOptions(context: TenantContext) {
    return this.transaction(context, [Permission.DesignRead, Permission.AssetRead], async (tx, authority, checkedAt) => {
      const packs = await tx.select().from(mockupTemplatePackVersions)
        .where(and(eq(mockupTemplatePackVersions.status, "approved"), creativeOwnerFilter(authority, Permission.DesignRead, mockupPackOwner())))
        .orderBy(asc(mockupTemplatePackVersions.name)).limit(500);
      const templatePacks = [];
      for (const pack of packs) {
        const sources = await this.accessible(() => requireMockupPackSources(tx, authority, pack, checkedAt));
        if (sources) templatePacks.push({ ...pack, slots: sources.slots });
      }
      const formalDesigns = [];
      if (authority.permissions.includes(Permission.ProductRead)) {
        const designs = await tx.select({ designVersionId: designVersions.id, designTaskId: designTasks.id,
          title: designTasks.title, skuId: skus.id, skuCode: skus.code, spuId: skus.spuId }).from(designVersions)
          .innerJoin(designTasks, eq(designTasks.id, designVersions.taskId)).innerJoin(skus, eq(skus.id, designTasks.skuId))
          .where(and(eq(designVersions.status, "approved"), eq(designTasks.status, "approved"),
            creativeOwnerFilter(authority, Permission.DesignRead, designTasks.createdBy)))
          .orderBy(asc(designTasks.title), asc(skus.code)).limit(500);
        for (const design of designs) {
          const source = await this.accessible(() => requireMockupDesignSource(tx, authority, design.designVersionId, design.skuId, checkedAt));
          if (source) formalDesigns.push({ ...design, printSpecVersionId: source.printSpecVersionId, creativeDesignVersionId: source.creativeDesignVersionId });
        }
      }
      const listingRows = await tx.select({
        listingVersionId: listingVersions.id, versionNumber: listingVersions.versionNumber,
        status: listingVersions.status, listingId: listings.id, platform: listings.platform,
        locale: listings.locale, spuId: listings.spuId,
      }).from(listingVersions).innerJoin(listings, eq(listingVersions.listingId, listings.id)).where(
        authority.permissions.includes(Permission.ListingRead) && authority.permissions.includes(Permission.ListingWrite)
          ? and(creativeOwnerFilter(authority, Permission.ListingRead, listings.createdBy), creativeOwnerFilter(authority, Permission.ListingWrite, listings.createdBy)) : sql`false`)
        .orderBy(desc(listingVersions.createdAt)).limit(500);
      const listingTargets = [];
      for (const listing of listingRows) if (await this.accessible(() => assertCatalogListingAccess(tx, authority, listing.listingId,
        [Permission.ListingRead, Permission.ListingWrite]))) listingTargets.push(listing);
      const templateSources = await tx.select({
        id: assetFiles.id, fileName: assetFiles.fileName, mediaType: assetFiles.mediaType,
        version: assetFiles.version, checksumSha256: assetFiles.checksumSha256, byteSize: assetFiles.byteSize,
      }).from(assetFiles).where(and(
        eq(assetFiles.assetDomain, "authorized"), eq(assetFiles.rightsStatus, "approved"), isNull(assetFiles.deletedAt),
        sql`lower(${assetFiles.fileName}) like '%.psd'`,
        sql`coalesce(${assetFiles.rightsMetadata}->'source'->>'kind', '') not in ('customer_provided','competitor')`,
        catalogAssetReadFilter(authority, assetFiles.ownerUserId, assetFiles.id),
      )).orderBy(desc(assetFiles.createdAt)).limit(200);
      const templateSourceAssets = [];
      for (const source of templateSources) if (await this.accessible(() => requireMockupAsset(tx, authority, source.id, undefined, checkedAt))) templateSourceAssets.push(source);
      const [inspections, printSpecs] = await Promise.all([
        tx.select().from(mockupTemplateSourceInspections).where(creativeOwnerFilter(authority, Permission.DesignRead, mockupTemplateSourceInspections.requestedBy)).orderBy(desc(mockupTemplateSourceInspections.createdAt)).limit(500),
        tx.select().from(canvasPrintSpecVersions).where(and(eq(canvasPrintSpecVersions.status, "approved"), creativeOwnerFilter(authority, Permission.DesignRead, printSpecOwner()))).orderBy(asc(canvasPrintSpecVersions.name)).limit(500),
      ]);
      const visibleInspections = [];
      for (const inspection of inspections) if (await this.accessible(() => requireMockupInspectionSources(tx, authority, inspection))) visibleInspections.push(await this.inspectionView(tx, inspection));
      return {
        templatePacks,
        formalDesigns,
        listingVersions: listingTargets,
        templateSourceAssets,
        inspections: visibleInspections,
        printSpecs,
      };
    });
  }

  async getBatch(context: TenantContext, batchId: string) {
    return this.transaction(context, [Permission.DesignRead, Permission.AssetRead, Permission.ProductRead], async (tx, authority) => {
      const batch = await requireMockupBatchAccess(tx, authority, batchId, [Permission.DesignRead]);
      const items = await tx.select().from(mockupBatchItems).where(eq(mockupBatchItems.batchId, batchId)).orderBy(asc(mockupBatchItems.ordinal));
      const template = await this.batchSources(tx, authority, batch, items);
      const outputs = items.length ? await tx.select().from(mockupBatchOutputs).where(inArray(mockupBatchOutputs.itemId, items.map((item) => item.id))) : [];
      const views = [];
      for (const item of items) {
        const latest = latestOutputs(outputs.filter(output => output.itemId === item.id));
        views.push({ ...item, outputs: latest, reviewFingerprint: await this.reviewFingerprint(tx, authority, item, latest) });
      }
      return { ...batch, templatePack: { ...template.pack, slots: template.slots }, items: views };
    });
  }

  async cancelBatch(context: TenantContext, batchId: string) {
    return this.transaction(context, [Permission.DesignRead, Permission.DesignWrite], async (tx, authority) => {
      const batch = await requireMockupBatchAccess(tx, authority, batchId, [Permission.DesignRead, Permission.DesignWrite], "update");
      if (["completed", "cancelled"].includes(batch.status)) throw new ConflictException("Mockup batch is already terminal");
      const items = await tx.select({ id: mockupBatchItems.id }).from(mockupBatchItems).where(eq(mockupBatchItems.batchId, batchId));
      const now = new Date();
      if (items.length) await tx.update(mockupBatchOutputs).set({ status: "failed", errorCode: "BATCH_CANCELLED", errorMessage: "Mockup batch was cancelled", completedAt: now })
        .where(and(inArray(mockupBatchOutputs.itemId, items.map((item) => item.id)), inArray(mockupBatchOutputs.status, ["queued", "running"])));
      await tx.update(mockupBatchItems).set({ status: "cancelled", completedAt: now, updatedAt: now }).where(and(eq(mockupBatchItems.batchId, batchId), inArray(mockupBatchItems.status, ["queued", "running"])));
      await tx.update(mockupBatches).set({ status: "cancelled", completedAt: now, updatedAt: now }).where(eq(mockupBatches.id, batchId));
      await this.audit.recordInTransaction(tx, context, { action: "pod.mockup_batch.cancel", resourceType: "mockup_batch", resourceId: batchId, result: "success" });
      return { ...batch, status: "cancelled", completedAt: now, updatedAt: now };
    });
  }

  async retryOutput(context: TenantContext, batchId: string, outputId: string) {
    const itemId = await this.transaction(context, [Permission.DesignRead, Permission.DesignWrite, Permission.AssetRead, Permission.ProductRead], async (tx, authority, checkedAt) => {
      const batch = await requireMockupBatchAccess(tx, authority, batchId, [Permission.DesignRead, Permission.DesignWrite], "update");
      if (batch.status === "cancelled") throw new ConflictException("已取消的套图批次不能重试");
      const [current] = await tx.select({ output: mockupBatchOutputs, item: mockupBatchItems }).from(mockupBatchOutputs)
        .innerJoin(mockupBatchItems, eq(mockupBatchOutputs.itemId, mockupBatchItems.id))
        .where(and(eq(mockupBatchOutputs.id, outputId), eq(mockupBatchItems.batchId, batchId))).for("update");
      if (!current) throw new NotFoundException("Mockup output not found");
      const [latest] = await tx.select().from(mockupBatchOutputs).where(and(eq(mockupBatchOutputs.itemId, current.item.id),
        eq(mockupBatchOutputs.templateSlotId, current.output.templateSlotId))).orderBy(desc(mockupBatchOutputs.attempt)).limit(1).for("update");
      if (latest?.id !== outputId) throw new ConflictException("槽位已有新尝试 请刷新后查看最新结果");
      if (!["failed", "rejected"].includes(current.output.status)) throw new ConflictException("Only failed or rejected slots can be retried");
      if (current.output.attempt >= 20) throw new ConflictException("Mockup output retry limit reached");
      await this.batchSources(tx, authority, batch, [current.item], checkedAt);
      await tx.insert(mockupBatchOutputs).values({
        id: createEntityId(), tenantId: context.tenantId, itemId: current.output.itemId,
        templateSlotId: current.output.templateSlotId, slotKey: current.output.slotKey,
        attempt: current.output.attempt + 1,
      });
      await stageCreativeExecution(tx, authority, { kind: "mockup_render", ownerId: current.item.id,
        stepKey: `slot:${current.output.templateSlotId}:attempt:${current.output.attempt + 1}` }, "internal_write");
      await tx.update(mockupBatchItems).set({ status: "queued", rejectionReason: null, reviewedBy: null, reviewedAt: null, completedAt: null, updatedAt: new Date() })
        .where(eq(mockupBatchItems.id, current.item.id));
      await refreshBatchStatus(tx, batchId);
      await this.audit.recordInTransaction(tx, context, { action: "pod.mockup_output.retry", resourceType: "mockup_batch_output", resourceId: outputId,
        result: "success", metadata: { batchId, itemId: current.item.id, attempt: current.output.attempt + 1 } });
      return current.item.id;
    });
    try {
      await this.enqueuer.enqueueMockupRender({ itemId, tenantId: context.tenantId, requestedBy: context.userId });
    } catch {
      await this.failQueuedOutputs(context, [itemId], "QUEUE_UNAVAILABLE", "Mockup render queue is unavailable");
      throw new ServiceUnavailableException("Mockup render queue is unavailable");
    }
    return this.getBatch(context, batchId);
  }

  async reviewBatch(context: TenantContext, batchId: string, rawInput: ReviewMockupBatchInput) {
    const input = ReviewMockupBatchInputSchema.parse(rawInput);
    await this.transaction(context, [Permission.DesignRead, Permission.DesignReview, Permission.AssetRead, Permission.ProductRead], async (tx, authority, checkedAt) => {
      const batch = await requireMockupBatchAccess(tx, authority, batchId, [Permission.DesignRead, Permission.DesignReview], "update");
      if (batch.status === "cancelled") throw new ConflictException("已取消的套图批次不能审核");
      const slots = await tx.select().from(mockupTemplateSlots).where(eq(mockupTemplateSlots.templatePackVersionId, batch.templatePackVersionId));
      for (const decision of [...input.decisions].sort((a, b) => a.itemId.localeCompare(b.itemId))) {
        const [item] = await tx.select().from(mockupBatchItems).where(and(eq(mockupBatchItems.id, decision.itemId), eq(mockupBatchItems.batchId, batchId))).for("update");
        if (!item) throw new NotFoundException("Mockup batch item not found");
        await this.batchSources(tx, authority, batch, [item], decision.decision === "approve" ? checkedAt : undefined);
        const allOutputs = await tx.select().from(mockupBatchOutputs).where(eq(mockupBatchOutputs.itemId, item.id)).orderBy(asc(mockupBatchOutputs.id)).for("update");
        const latest = latestOutputs(allOutputs);
        if (await this.reviewFingerprint(tx, authority, item, latest) !== decision.expectedFingerprint)
          throw new ConflictException("套图审核依据已变化 请刷新后重新查看");
        if (latest.some(output => ["queued", "running"].includes(output.status))) throw new ConflictException("仍有槽位执行中 请等待后再审核");
        if (decision.decision === "approve") {
          const bySlot = new Map(latest.map((output) => [output.slotKey, output]));
          const blocking = slots.filter((slot) => slot.required).some((slot) => !["succeeded", "approved"].includes(bySlot.get(slot.slotKey)?.status ?? "missing"));
          if (blocking) throw new ConflictException("All required mockup slots must succeed before item approval");
          const approvedOutputs = latest.filter(output => ["succeeded", "approved"].includes(output.status));
          if (!approvedOutputs.length) throw new ConflictException("没有待审核的套图产物");
          await this.governance.approveMockupOutputsInTransaction(tx, authority, approvedOutputs, checkedAt);
          await tx.update(mockupBatchOutputs).set({ status: "approved" }).where(inArray(mockupBatchOutputs.id, approvedOutputs.map(output => output.id)));
          await tx.update(mockupBatchItems).set({ status: "completed", rejectionReason: null, reviewedBy: context.userId, reviewedAt: new Date(), completedAt: new Date(), updatedAt: new Date() })
            .where(eq(mockupBatchItems.id, item.id));
        } else {
          const reviewable = latest.filter((output) => ["succeeded", "approved"].includes(output.status));
          if (reviewable.length) await tx.update(mockupBatchOutputs).set({ status: "rejected" }).where(inArray(mockupBatchOutputs.id, reviewable.map((output) => output.id)));
          await tx.update(mockupBatchItems).set({ status: "awaiting_review", rejectionReason: decision.rejectionReason, reviewedBy: context.userId, reviewedAt: new Date(), updatedAt: new Date() })
            .where(eq(mockupBatchItems.id, item.id));
        }
      }
      await refreshBatchStatus(tx, batchId);
      await this.audit.recordInTransaction(tx, context, { action: "pod.mockup_batch.review", resourceType: "mockup_batch", resourceId: batchId,
        result: "success", metadata: { decisionCount: input.decisions.length } });
    });
    return this.getBatch(context, batchId);
  }

  async capabilities(context: TenantContext) {
    const approvedPack = await this.transaction(context, [Permission.DesignRead], async (tx, authority, checkedAt) => {
      if (!authority.permissions.includes(Permission.AssetRead)) return undefined;
      const packs = await tx.select().from(mockupTemplatePackVersions).where(and(eq(mockupTemplatePackVersions.status, "approved"),
        creativeOwnerFilter(authority, Permission.DesignRead, mockupPackOwner()))).orderBy(asc(mockupTemplatePackVersions.id)).limit(500);
      for (const pack of packs) if (await this.accessible(() => requireMockupPackSources(tx, authority, pack, checkedAt))) return pack;
      return undefined;
    });
    const creativeReady = creativeBatchConfigured();
    const rendererReady = mockupRendererConfigured();
    return {
      batchDesign: {
        enabled: creativeReady,
        blockers: creativeReady ? [] : ["POD batch workflow flag, processor deployment, text_to_image, and canvas_extend must be ready"],
      },
      mockupBatches: {
        enabled: rendererReady && Boolean(approvedPack),
        blockers: [
          ...(rendererReady ? [] : ["Controlled ImageMagick renderer is not enabled"]),
          ...(approvedPack ? [] : ["At least one approved mockup template pack is required"]),
        ],
      },
    };
  }

  async createListingBindings(context: TenantContext, batchId: string, rawInput: CreateMockupListingBindingsInput) {
    const input = CreateMockupListingBindingsInputSchema.parse(rawInput);
    await this.transaction(context, [Permission.DesignRead, Permission.DesignWrite, Permission.ListingRead, Permission.ListingWrite],
      (tx, authority) => requireMockupBatchAccess(tx, authority, batchId, [Permission.DesignRead, Permission.DesignWrite]));
    const results: Array<{ itemId: string; status: "succeeded" | "failed"; bindingIds?: string[]; error?: string }> = [];
    for (const bindingInput of input.bindings) {
      try {
        const bindingIds = await this.governance.createApprovedMockupListingBindings(context, {
          batchId,
          itemId: bindingInput.itemId,
          listingVersionId: bindingInput.listingVersionId,
          slots: bindingInput.slots,
        });
        results.push({ itemId: bindingInput.itemId, status: "succeeded", bindingIds });
      } catch (error) {
        results.push({ itemId: bindingInput.itemId, status: "failed", error: error instanceof Error ? error.message : "Listing binding failed" });
        await this.audit.record(context, {
          action: "pod.mockup_item.listing_bind", resourceType: "mockup_batch_item", resourceId: bindingInput.itemId,
          result: "failure", metadata: { listingVersionId: bindingInput.listingVersionId },
        });
      }
    }
    return { items: results };
  }

  private async failQueuedOutputs(context: TenantContext, itemIds: string[], errorCode: string, errorMessage: string) {
    const now = new Date();
    await withTenant(this.database.db, context, async (tx) => {
      const items = await tx.select({ batchId: mockupBatchItems.batchId }).from(mockupBatchItems).where(inArray(mockupBatchItems.id, itemIds));
      const batchIds = [...new Set(items.map(item => item.batchId))].sort();
      const batches = batchIds.length ? await tx.select().from(mockupBatches).where(inArray(mockupBatches.id, batchIds)).orderBy(asc(mockupBatches.id)).for("update") : [];
      await tx.update(mockupBatchOutputs).set({ status: "failed", errorCode, errorMessage, completedAt: now })
        .where(and(inArray(mockupBatchOutputs.itemId, itemIds), eq(mockupBatchOutputs.status, "queued")));
      await tx.update(mockupBatchItems).set({ status: "failed", completedAt: now, updatedAt: now })
        .where(and(inArray(mockupBatchItems.id, itemIds), eq(mockupBatchItems.status, "queued")));
      for (const batch of batches) if (batch.status !== "cancelled") await refreshBatchStatus(tx, batch.id);
    });
  }

  private transaction<T>(context: TenantContext, required: readonly PermissionValue[],
    work: (tx: TenantTransaction, authority: TenantContext, checkedAt: number) => Promise<T>) {
    return withTenant(this.database.db, context, async tx => {
      const { authority, checkedAt } = await currentDesignAuthority(tx, context, required);
      return work(tx, authority, checkedAt);
    });
  }

  private async accessible<T>(work: () => Promise<T>): Promise<T | undefined> {
    try { return await work(); } catch (error) {
      if (error instanceof Error && "status" in error && [403, 404, 409].includes(Number(error.status))) return undefined;
      throw error;
    }
  }

  private inspectionFingerprint(row: typeof mockupTemplateSourceInspections.$inferSelect) {
    return checksum({ version: "mockup-inspection-review-v1", id: row.id, sourceAssetId: row.sourceAssetId,
      sourceAssetVersion: row.sourceAssetVersion, checksumSha256: row.checksumSha256, slotKey: row.slotKey,
      compilerVersion: row.compilerVersion, status: row.status, compilation: row.compilation });
  }

  private async inspectionView(tx: TenantTransaction, row: typeof mockupTemplateSourceInspections.$inferSelect) {
    const [execution] = await tx.select({ id: creativeExecutions.id }).from(creativeExecutions)
      .where(and(eq(creativeExecutions.inspectionId, row.id), eq(creativeExecutions.kind, "template_compile"), eq(creativeExecutions.stepKey, "compile")));
    return { ...row, reviewFingerprint: this.inspectionFingerprint(row),
      executionEvidence: execution ? "original_execution" as const : "legacy_compilation" as const };
  }

  private async batchSources(tx: TenantTransaction, authority: TenantContext, batch: typeof mockupBatches.$inferSelect,
    items: Array<typeof mockupBatchItems.$inferSelect>, checkedAt?: number) {
    const pack = await requireMockupPackAccess(tx, authority, batch.templatePackVersionId, [Permission.DesignRead]);
    const sources = await requireMockupPackSources(tx, authority, pack, checkedAt);
    if (checkedAt !== undefined && (pack.status !== "approved" || pack.platform !== batch.platform || pack.locale !== batch.locale))
      throw new ConflictException("原模板包当前不可用于此批次");
    if (checkedAt !== undefined) for (const inspection of sources.inspections) {
      const { assets } = await requireMockupInspectionSources(tx, authority, inspection, checkedAt, true);
      await requireMockupCompletionEvidence(tx, authority, { kind: "template_compile", ownerId: inspection.id, stepKey: "compile" }, assets, true);
    }
    for (const item of items) {
      const design = await requireMockupDesignSource(tx, authority, item.designVersionId, item.skuId, checkedAt);
      if (checkedAt !== undefined && sources.slots.some(slot => !slot.acceptedPrintSpecVersionIds.includes(design.printSpecVersionId)))
        throw new ConflictException("原正式设计与模板规格不兼容");
    }
    return { ...sources, pack };
  }

  private async reviewFingerprint(tx: TenantTransaction, authority: TenantContext, item: typeof mockupBatchItems.$inferSelect,
    outputs: Array<typeof mockupBatchOutputs.$inferSelect>) {
    const assets = [];
    for (const id of [...new Set(outputs.flatMap(output => output.assetId ? [output.assetId] : []))].sort()) {
      const file = await requireMockupAsset(tx, authority, id);
      assets.push({ id: file.id, version: file.version, checksumSha256: file.checksumSha256, rightsStatus: file.rightsStatus,
        deletedAt: file.deletedAt?.toISOString() ?? null, rightsMetadata: file.rightsMetadata });
    }
    return checksum({ version: "mockup-item-review-v1", item: { id: item.id, status: item.status, reviewedBy: item.reviewedBy,
      reviewedAt: item.reviewedAt?.toISOString() ?? null, rejectionReason: item.rejectionReason }, outputs, assets });
  }
}

type TemplateSourcePolicyView = Pick<typeof assetFiles.$inferSelect, "assetDomain" | "rightsStatus" | "rightsMetadata" | "byteSize" | "fileName" | "mediaType">;

export function assertTemplateSourceAsset(asset: TemplateSourcePolicyView) {
  const sourceKind = (asset.rightsMetadata as { source?: { kind?: string } }).source?.kind;
  if (asset.assetDomain !== "authorized" || asset.rightsStatus !== "approved" || sourceKind === "customer_provided" || sourceKind === "competitor") {
    throw new BadRequestException("PSD template sources must be rights-approved assets in the authorized domain");
  }
  if (asset.byteSize > 250 * 1024 * 1024) throw new BadRequestException("PSD template source exceeds 250 MB");
  const psdMediaTypes = new Set(["image/vnd.adobe.photoshop", "application/vnd.adobe.photoshop", "application/octet-stream"]);
  if (!asset.fileName.toLowerCase().endsWith(".psd") || !psdMediaTypes.has(asset.mediaType)) {
    throw new BadRequestException("Mockup template source must be a PSD file");
  }
}

function latestOutputs(outputs: Array<typeof mockupBatchOutputs.$inferSelect>) {
  const latest = new Map<string, typeof mockupBatchOutputs.$inferSelect>();
  for (const output of outputs) {
    const current = latest.get(output.slotKey);
    if (!current || output.attempt > current.attempt) latest.set(output.slotKey, output);
  }
  return [...latest.values()].sort((left, right) => left.slotKey.localeCompare(right.slotKey));
}

async function refreshBatchStatus(tx: Parameters<Parameters<typeof withTenant>[2]>[0], batchId: string) {
  const items = await tx.select({ status: mockupBatchItems.status }).from(mockupBatchItems).where(eq(mockupBatchItems.batchId, batchId));
  const completedCount = items.filter((item) => item.status === "completed").length;
  const failedCount = items.filter((item) => item.status === "failed").length;
  const status = items.some(item => item.status === "running") ? "running"
    : items.some(item => item.status === "queued") ? "queued"
    : completedCount === items.length ? "completed"
    : completedCount > 0 ? "partially_succeeded"
      : failedCount === items.length ? "failed" : "awaiting_review";
  await tx.update(mockupBatches).set({
    status, completedCount, failedCount,
    completedAt: status === "completed" || status === "failed" ? new Date() : null,
    updatedAt: new Date(),
  }).where(eq(mockupBatches.id, batchId));
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

function creativeBatchConfigured() {
  if (process.env.POD_BATCH_WORKFLOWS_ENABLED?.trim().toLowerCase() !== "true") return false;
  if (!process.env.POD_PROCESSOR_DEPLOYMENT_ID?.trim() || !process.env.POD_PROCESSOR_URL?.trim() || !process.env.POD_PROCESSOR_API_KEY?.trim()) return false;
  const tools = new Set(process.env.POD_ENABLED_TOOLS?.split(",").map((value) => value.trim()).filter(Boolean));
  return tools.has("text_to_image") && tools.has("canvas_extend");
}

export function mockupRendererConfigured() {
  return process.env.POD_BATCH_WORKFLOWS_ENABLED?.trim().toLowerCase() === "true"
    && process.env.POD_MOCKUP_RENDERER_ENABLED?.trim().toLowerCase() === "true";
}
