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
  creativeDesignSkuBindings,
  designTasks,
  designVersionFiles,
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
} from "@yummyai/database";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION, POD_BATCH_WORKFLOW_ENQUEUER } from "../platform.tokens.js";
import type { PodBatchWorkflowEnqueuer } from "./pod-batch-workflow.service.js";
import { PodGovernanceService } from "./pod-governance.service.js";

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
    const prepared = await withTenant(this.database.db, context, async (tx) => {
      const [asset] = await tx.select().from(assetFiles).where(and(eq(assetFiles.id, input.sourceAssetId), isNull(assetFiles.deletedAt))).limit(1);
      if (!asset) throw new NotFoundException("PSD template source asset not found");
      if (asset.version !== input.sourceAssetVersion || asset.checksumSha256 !== input.checksumSha256) {
        throw new ConflictException("PSD template source asset version or checksum changed");
      }
      assertTemplateSourceAsset(asset);
      const [existing] = await tx.select().from(mockupTemplateSourceInspections).where(and(
        eq(mockupTemplateSourceInspections.sourceAssetId, input.sourceAssetId),
        eq(mockupTemplateSourceInspections.sourceAssetVersion, input.sourceAssetVersion),
        eq(mockupTemplateSourceInspections.slotKey, input.slotKey),
        eq(mockupTemplateSourceInspections.compilerVersion, MOCKUP_COMPILER_VERSION),
      )).limit(1);
      if (existing) return { row: existing, replayed: true };
      const [row] = await tx.insert(mockupTemplateSourceInspections).values({
        id: createEntityId(), tenantId: context.tenantId,
        sourceAssetId: asset.id, sourceAssetVersion: asset.version, checksumSha256: asset.checksumSha256,
        slotKey: input.slotKey, compilerVersion: MOCKUP_COMPILER_VERSION, requestedBy: context.userId,
      }).returning();
      return { row: row!, replayed: false };
    });
    if (!prepared.replayed) {
      try {
        await this.enqueuer.enqueueTemplateCompile({ inspectionId: prepared.row.id, tenantId: context.tenantId, requestedBy: context.userId });
      } catch {
        await withTenant(this.database.db, context, (tx) => tx.update(mockupTemplateSourceInspections).set({
          status: "failed", errorCode: "QUEUE_UNAVAILABLE", errorMessage: "Mockup template compile queue is unavailable", completedAt: new Date(),
        }).where(eq(mockupTemplateSourceInspections.id, prepared.row.id)));
        throw new ServiceUnavailableException("Mockup template compile queue is unavailable");
      }
      await this.record(context, "pod.mockup_template_inspection.create", "mockup_template_source_inspection", prepared.row.id, { slotKey: input.slotKey });
    }
    return this.getInspection(context, prepared.row.id);
  }

  async listInspections(context: TenantContext) {
    return withTenant(this.database.db, context, (tx) => tx.select().from(mockupTemplateSourceInspections)
      .orderBy(desc(mockupTemplateSourceInspections.createdAt)).limit(500));
  }

  async getInspection(context: TenantContext, inspectionId: string) {
    const [row] = await withTenant(this.database.db, context, (tx) => tx.select().from(mockupTemplateSourceInspections)
      .where(eq(mockupTemplateSourceInspections.id, inspectionId)).limit(1));
    if (!row) throw new NotFoundException("Mockup template source inspection not found");
    return row;
  }

  async confirmInspection(context: TenantContext, inspectionId: string) {
    const row = await this.getInspection(context, inspectionId);
    if (row.status !== "completed" || !row.compilation) throw new ConflictException("Only completed template inspections can be confirmed");
    if (row.compilation.ssimPermille < 990) throw new ConflictException("Template golden-image SSIM must be at least 0.99");
    await withTenant(this.database.db, context, (tx) => tx.update(mockupTemplateSourceInspections).set({
      confirmedBy: context.userId,
      confirmedAt: new Date(),
    }).where(eq(mockupTemplateSourceInspections.id, inspectionId)));
    await this.record(context, "pod.mockup_template_inspection.confirm", "mockup_template_source_inspection", inspectionId, {
      ssimPermille: row.compilation.ssimPermille,
    });
    return this.getInspection(context, inspectionId);
  }

  async createTemplatePack(context: TenantContext, rawInput: CreateMockupTemplatePackVersionInput) {
    const input = CreateMockupTemplatePackVersionInputSchema.parse(rawInput);
    const created = await withTenant(this.database.db, context, async (tx) => {
      const inspectionIds = [...new Set(input.slots.map((slot) => slot.inspectionId))];
      const inspections = await tx.select().from(mockupTemplateSourceInspections).where(inArray(mockupTemplateSourceInspections.id, inspectionIds));
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
      const specVersions = await tx.select().from(canvasPrintSpecVersions).where(inArray(canvasPrintSpecVersions.id, specIds));
      if (specVersions.length !== specIds.length || specVersions.some((spec) => spec.status !== "approved")) {
        throw new ConflictException("Template slots require approved canvas print specification versions");
      }
      const packId = input.packId ?? createEntityId();
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:${packId}:mockup-template-pack`}, 0))`);
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
      return pack!;
    });
    await this.record(context, "pod.mockup_template_pack.create", "mockup_template_pack_version", created.id, { slotCount: input.slots.length });
    return this.getTemplatePack(context, created.id);
  }

  async listTemplatePacks(context: TenantContext) {
    const packs = await withTenant(this.database.db, context, (tx) => tx.select().from(mockupTemplatePackVersions)
      .orderBy(desc(mockupTemplatePackVersions.createdAt)).limit(500));
    return { items: packs };
  }

  async getTemplatePack(context: TenantContext, versionId: string) {
    return withTenant(this.database.db, context, async (tx) => {
      const [pack] = await tx.select().from(mockupTemplatePackVersions).where(eq(mockupTemplatePackVersions.id, versionId)).limit(1);
      if (!pack) throw new NotFoundException("Mockup template pack version not found");
      const slots = await tx.select().from(mockupTemplateSlots).where(eq(mockupTemplateSlots.templatePackVersionId, versionId))
        .orderBy(asc(mockupTemplateSlots.ordinal));
      return { ...pack, slots };
    });
  }

  async reviewTemplatePack(context: TenantContext, versionId: string, rawInput: ReviewVersionInput) {
    const input = ReviewVersionInputSchema.parse(rawInput);
    await withTenant(this.database.db, context, async (tx) => {
      const [pack] = await tx.select().from(mockupTemplatePackVersions).where(eq(mockupTemplatePackVersions.id, versionId)).limit(1);
      if (!pack) throw new NotFoundException("Mockup template pack version not found");
      if (pack.status !== "draft") throw new ConflictException("Only draft template pack versions can be reviewed");
      if (input.decision === "approve") {
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
    });
    await this.record(context, "pod.mockup_template_pack.review", "mockup_template_pack_version", versionId, { decision: input.decision });
    return this.getTemplatePack(context, versionId);
  }

  async createBatch(context: TenantContext, rawInput: CreateMockupBatchInput) {
    if (!mockupRendererConfigured()) {
      throw new ServiceUnavailableException("Batch mockup rendering is disabled until the controlled renderer is ready");
    }
    const input = CreateMockupBatchInputSchema.parse(rawInput);
    const requestIdentity = checksum({ policyVersion: "mockup-render-v1", input });
    const prepared = await withTenant(this.database.db, context, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:${requestIdentity}:mockup-batch`}, 0))`);
      const [pack] = await tx.select().from(mockupTemplatePackVersions).where(eq(mockupTemplatePackVersions.id, input.templatePackVersionId)).limit(1);
      if (!pack) throw new NotFoundException("Mockup template pack version not found");
      if (pack.status !== "approved") throw new ConflictException("Mockup batches require an approved template pack version");
      if (pack.platform !== input.platform || pack.locale !== input.locale) throw new ConflictException("Template platform and locale must match the batch");
      const slots = await tx.select().from(mockupTemplateSlots).where(eq(mockupTemplateSlots.templatePackVersionId, pack.id));
      if (!slots.length) throw new ConflictException("Template pack has no slots");
      const inspections = await tx.select().from(mockupTemplateSourceInspections)
        .where(inArray(mockupTemplateSourceInspections.id, slots.map((slot) => slot.inspectionId)));
      const inspectionById = new Map(inspections.map((inspection) => [inspection.id, inspection]));
      if (inspections.length !== slots.length || inspections.some((inspection) => inspection.status !== "completed" || !inspection.compilation)) {
        throw new ConflictException("Template pack compilation snapshot is incomplete");
      }
      const designVersionIds = [...new Set(input.items.map((item) => item.designVersionId))];
      const versions = await tx.select({ version: designVersions, task: designTasks }).from(designVersions)
        .innerJoin(designTasks, eq(designVersions.taskId, designTasks.id))
        .where(inArray(designVersions.id, designVersionIds));
      if (versions.length !== designVersionIds.length) throw new NotFoundException("One or more formal design versions were not found");
      const versionById = new Map(versions.map((row) => [row.version.id, row]));
      const bindings = await tx.select().from(creativeDesignSkuBindings).where(inArray(creativeDesignSkuBindings.designVersionId, designVersionIds));
      const bindingByVersion = new Map(bindings.map((binding) => [binding.designVersionId, binding]));
      const artworkRows = await tx.select({ versionId: designVersionFiles.versionId, asset: assetFiles }).from(designVersionFiles)
        .innerJoin(assetFiles, eq(designVersionFiles.assetFileId, assetFiles.id))
        .where(and(inArray(designVersionFiles.versionId, designVersionIds), eq(designVersionFiles.role, "production"), isNull(assetFiles.deletedAt)));
      const artworkByVersion = new Map(artworkRows.map((row) => [row.versionId, row.asset]));
      for (const item of input.items) {
        const version = versionById.get(item.designVersionId)!;
        const binding = bindingByVersion.get(item.designVersionId);
        if (version.version.status !== "approved" || version.task.status !== "approved") {
          throw new ConflictException("Mockup batches require approved formal design versions");
        }
        if (version.task.skuId !== item.skuId || !binding || binding.skuId !== item.skuId) {
          throw new ConflictException("Formal design version is not bound to the selected SKU");
        }
        if (slots.some((slot) => !slot.acceptedPrintSpecVersionIds.includes(binding.printSpecVersionId))) {
          throw new ConflictException("Formal design print specification is incompatible with one or more template slots");
        }
        if (!artworkByVersion.has(item.designVersionId)) throw new ConflictException("Formal design version is missing its production asset snapshot");
      }
      const requestChecksum = checksum({
        policyVersion: "mockup-render-v1",
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
      const [replayed] = await tx.select({ id: mockupBatches.id }).from(mockupBatches).where(eq(mockupBatches.requestChecksum, requestChecksum)).limit(1);
      if (replayed) return { id: replayed.id, itemIds: [] as string[], replayed: true };
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
      }
      return { id: batchId, itemIds, replayed: false };
    });
    if (!prepared.replayed) {
      const dispatches = await Promise.allSettled(prepared.itemIds.map((itemId) => this.enqueuer.enqueueMockupRender({ itemId, tenantId: context.tenantId, requestedBy: context.userId })));
      const failedItemIds = dispatches.flatMap((result, index) => result.status === "rejected" ? [prepared.itemIds[index]!] : []);
      if (failedItemIds.length) await this.failQueuedOutputs(context, failedItemIds, "QUEUE_UNAVAILABLE", "Mockup render queue is unavailable");
      await this.record(context, "pod.mockup_batch.create", "mockup_batch", prepared.id, { itemCount: input.items.length, queueFailureCount: failedItemIds.length });
      if (failedItemIds.length === prepared.itemIds.length) throw new ServiceUnavailableException("Mockup render queue is unavailable");
    }
    return this.getBatch(context, prepared.id);
  }

  async listBatches(context: TenantContext) {
    return withTenant(this.database.db, context, (tx) => tx.select().from(mockupBatches).orderBy(desc(mockupBatches.createdAt)).limit(200));
  }

  async batchOptions(context: TenantContext) {
    return withTenant(this.database.db, context, async (tx) => {
      const packs = await tx.select().from(mockupTemplatePackVersions)
        .where(eq(mockupTemplatePackVersions.status, "approved"))
        .orderBy(asc(mockupTemplatePackVersions.name));
      const slots = packs.length ? await tx.select().from(mockupTemplateSlots)
        .where(inArray(mockupTemplateSlots.templatePackVersionId, packs.map((pack) => pack.id)))
        .orderBy(asc(mockupTemplateSlots.ordinal)) : [];
      const formalDesigns = await tx.select({
        designVersionId: designVersions.id, designTaskId: designTasks.id,
        title: designTasks.title, skuId: skus.id, skuCode: skus.code, spuId: skus.spuId,
        printSpecVersionId: creativeDesignSkuBindings.printSpecVersionId,
        creativeDesignVersionId: creativeDesignSkuBindings.creativeDesignVersionId,
      }).from(creativeDesignSkuBindings)
        .innerJoin(designVersions, eq(creativeDesignSkuBindings.designVersionId, designVersions.id))
        .innerJoin(designTasks, eq(creativeDesignSkuBindings.designTaskId, designTasks.id))
        .innerJoin(skus, eq(creativeDesignSkuBindings.skuId, skus.id))
        .where(and(eq(designVersions.status, "approved"), eq(designTasks.status, "approved")))
        .orderBy(asc(designTasks.title), asc(skus.code)).limit(500);
      const listingRows = await tx.select({
        listingVersionId: listingVersions.id, versionNumber: listingVersions.versionNumber,
        status: listingVersions.status, listingId: listings.id, platform: listings.platform,
        locale: listings.locale, spuId: listings.spuId,
      }).from(listingVersions).innerJoin(listings, eq(listingVersions.listingId, listings.id))
        .orderBy(desc(listingVersions.createdAt)).limit(500);
      const templateSources = await tx.select({
        id: assetFiles.id, fileName: assetFiles.fileName, mediaType: assetFiles.mediaType,
        version: assetFiles.version, checksumSha256: assetFiles.checksumSha256, byteSize: assetFiles.byteSize,
      }).from(assetFiles).where(and(
        eq(assetFiles.assetDomain, "authorized"), eq(assetFiles.rightsStatus, "approved"), isNull(assetFiles.deletedAt),
        sql`lower(${assetFiles.fileName}) like '%.psd'`,
        sql`coalesce(${assetFiles.rightsMetadata}->'source'->>'kind', '') not in ('customer_provided','competitor')`,
      )).orderBy(desc(assetFiles.createdAt)).limit(200);
      const [inspections, printSpecs] = await Promise.all([
        tx.select().from(mockupTemplateSourceInspections).orderBy(desc(mockupTemplateSourceInspections.createdAt)).limit(500),
        tx.select().from(canvasPrintSpecVersions).where(eq(canvasPrintSpecVersions.status, "approved")).orderBy(asc(canvasPrintSpecVersions.name)),
      ]);
      return {
        templatePacks: packs.map((pack) => ({ ...pack, slots: slots.filter((slot) => slot.templatePackVersionId === pack.id) })),
        formalDesigns,
        listingVersions: listingRows,
        templateSourceAssets: templateSources,
        inspections,
        printSpecs,
      };
    });
  }

  async getBatch(context: TenantContext, batchId: string) {
    return withTenant(this.database.db, context, async (tx) => {
      const [batch] = await tx.select().from(mockupBatches).where(eq(mockupBatches.id, batchId)).limit(1);
      if (!batch) throw new NotFoundException("Mockup batch not found");
      const items = await tx.select().from(mockupBatchItems).where(eq(mockupBatchItems.batchId, batchId)).orderBy(asc(mockupBatchItems.ordinal));
      const outputs = items.length ? await tx.select().from(mockupBatchOutputs).where(inArray(mockupBatchOutputs.itemId, items.map((item) => item.id))) : [];
      return { ...batch, items: items.map((item) => ({ ...item, outputs: latestOutputs(outputs.filter((output) => output.itemId === item.id)) })) };
    });
  }

  async cancelBatch(context: TenantContext, batchId: string) {
    await withTenant(this.database.db, context, async (tx) => {
      const [batch] = await tx.select().from(mockupBatches).where(eq(mockupBatches.id, batchId)).limit(1);
      if (!batch) throw new NotFoundException("Mockup batch not found");
      if (["completed", "cancelled"].includes(batch.status)) throw new ConflictException("Mockup batch is already terminal");
      const items = await tx.select({ id: mockupBatchItems.id }).from(mockupBatchItems).where(eq(mockupBatchItems.batchId, batchId));
      const now = new Date();
      if (items.length) await tx.update(mockupBatchOutputs).set({ status: "failed", errorCode: "BATCH_CANCELLED", errorMessage: "Mockup batch was cancelled", completedAt: now })
        .where(and(inArray(mockupBatchOutputs.itemId, items.map((item) => item.id)), inArray(mockupBatchOutputs.status, ["queued", "running"])));
      await tx.update(mockupBatchItems).set({ status: "cancelled", completedAt: now, updatedAt: now }).where(and(eq(mockupBatchItems.batchId, batchId), inArray(mockupBatchItems.status, ["queued", "running"])));
      await tx.update(mockupBatches).set({ status: "cancelled", completedAt: now, updatedAt: now }).where(eq(mockupBatches.id, batchId));
    });
    await this.record(context, "pod.mockup_batch.cancel", "mockup_batch", batchId);
    return this.getBatch(context, batchId);
  }

  async retryOutput(context: TenantContext, batchId: string, outputId: string) {
    const itemId = await withTenant(this.database.db, context, async (tx) => {
      const [current] = await tx.select({ output: mockupBatchOutputs, item: mockupBatchItems }).from(mockupBatchOutputs)
        .innerJoin(mockupBatchItems, eq(mockupBatchOutputs.itemId, mockupBatchItems.id))
        .where(and(eq(mockupBatchOutputs.id, outputId), eq(mockupBatchItems.batchId, batchId))).limit(1);
      if (!current) throw new NotFoundException("Mockup output not found");
      if (!["failed", "rejected"].includes(current.output.status)) throw new ConflictException("Only failed or rejected slots can be retried");
      if (current.output.attempt >= 20) throw new ConflictException("Mockup output retry limit reached");
      await tx.insert(mockupBatchOutputs).values({
        id: createEntityId(), tenantId: context.tenantId, itemId: current.output.itemId,
        templateSlotId: current.output.templateSlotId, slotKey: current.output.slotKey,
        attempt: current.output.attempt + 1,
      });
      await tx.update(mockupBatchItems).set({ status: "queued", rejectionReason: null, reviewedBy: null, reviewedAt: null, completedAt: null, updatedAt: new Date() })
        .where(eq(mockupBatchItems.id, current.item.id));
      return current.item.id;
    });
    try {
      await this.enqueuer.enqueueMockupRender({ itemId, tenantId: context.tenantId, requestedBy: context.userId });
    } catch {
      await this.failQueuedOutputs(context, [itemId], "QUEUE_UNAVAILABLE", "Mockup render queue is unavailable");
      throw new ServiceUnavailableException("Mockup render queue is unavailable");
    }
    await this.record(context, "pod.mockup_output.retry", "mockup_batch_output", outputId, { batchId, itemId });
    return this.getBatch(context, batchId);
  }

  async reviewBatch(context: TenantContext, batchId: string, rawInput: ReviewMockupBatchInput) {
    const input = ReviewMockupBatchInputSchema.parse(rawInput);
    await withTenant(this.database.db, context, async (tx) => {
      const [batch] = await tx.select().from(mockupBatches).where(eq(mockupBatches.id, batchId)).limit(1);
      if (!batch) throw new NotFoundException("Mockup batch not found");
      const slots = await tx.select().from(mockupTemplateSlots).where(eq(mockupTemplateSlots.templatePackVersionId, batch.templatePackVersionId));
      for (const decision of input.decisions) {
        const [item] = await tx.select().from(mockupBatchItems).where(and(eq(mockupBatchItems.id, decision.itemId), eq(mockupBatchItems.batchId, batchId))).limit(1);
        if (!item) throw new NotFoundException("Mockup batch item not found");
        const allOutputs = await tx.select().from(mockupBatchOutputs).where(eq(mockupBatchOutputs.itemId, item.id));
        const latest = latestOutputs(allOutputs);
        if (decision.decision === "approve") {
          const bySlot = new Map(latest.map((output) => [output.slotKey, output]));
          const blocking = slots.filter((slot) => slot.required).some((slot) => bySlot.get(slot.slotKey)?.status !== "succeeded");
          if (blocking) throw new ConflictException("All required mockup slots must succeed before item approval");
          const approvedAssetIds = latest.flatMap((output) => output.status === "succeeded" && output.assetId ? [output.assetId] : []);
          if (approvedAssetIds.length) await tx.update(assetFiles).set({ rightsStatus: "approved" }).where(inArray(assetFiles.id, approvedAssetIds));
          await tx.update(mockupBatchOutputs).set({ status: "approved" }).where(inArray(mockupBatchOutputs.id, latest.filter((output) => output.status === "succeeded").map((output) => output.id)));
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
    });
    await this.record(context, "pod.mockup_batch.review", "mockup_batch", batchId, { decisionCount: input.decisions.length });
    return this.getBatch(context, batchId);
  }

  async capabilities(context: TenantContext) {
    const [approvedPack] = await withTenant(this.database.db, context, (tx) => tx.select({ id: mockupTemplatePackVersions.id })
      .from(mockupTemplatePackVersions).where(eq(mockupTemplatePackVersions.status, "approved")).limit(1));
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
      await tx.update(mockupBatchOutputs).set({ status: "failed", errorCode, errorMessage, completedAt: now })
        .where(and(inArray(mockupBatchOutputs.itemId, itemIds), eq(mockupBatchOutputs.status, "queued")));
      await tx.update(mockupBatchItems).set({ status: "failed", completedAt: now, updatedAt: now }).where(inArray(mockupBatchItems.id, itemIds));
    });
  }

  private record(context: TenantContext, action: string, resourceType: string, resourceId: string, metadata?: Record<string, unknown>) {
    return this.audit.record(context, { action, resourceType, resourceId, result: "success", metadata });
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
  const status = completedCount === items.length ? "completed"
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
