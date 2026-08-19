import { Permission } from "@yummyai/authz";
import {
  TemplateCanvasSchema,
  TemplateSlotSchema,
  createEntityId,
  type OrderPersonalizationResolutionSnapshot,
  type TenantContext,
} from "@yummyai/contracts";
import {
  assetFiles,
  designTasks,
  designVersionFiles,
  designVersions,
  orderPersonalizationBatchItems,
  orderPersonalizationRenderTasks,
  personalizationTemplateVersions,
  rightsAssessments,
  templateSlots,
  type DatabaseConnection,
  withTenant,
} from "@yummyai/database";
import type { Storage } from "@yummyai/storage";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import {
  OrderPersonalizationRenderPolicyError,
  type OrderPersonalizationRenderExecutionRecord,
  type OrderPersonalizationRenderRepository,
  type OrderPersonalizationRenderSourceAsset,
  type OrderPersonalizationRenderTaskRecord,
} from "./order-personalization-render.processor.js";
import type { PodArtworkExecutionResult } from "./pod-artwork.processor.js";

export class DrizzleOrderPersonalizationRenderRepository implements OrderPersonalizationRenderRepository {
  constructor(
    private readonly database: DatabaseConnection,
    private readonly storage: Storage,
  ) {}

  async load(context: Pick<TenantContext, "tenantId" | "userId">, renderTaskId: string) {
    return withTenant(this.database.db, workerContext(context), async (tx) => {
      const [loaded] = await tx.select({
        task: orderPersonalizationRenderTasks,
        item: orderPersonalizationBatchItems,
      }).from(orderPersonalizationRenderTasks)
        .innerJoin(orderPersonalizationBatchItems, eq(orderPersonalizationRenderTasks.batchItemId, orderPersonalizationBatchItems.id))
        .where(eq(orderPersonalizationRenderTasks.id, renderTaskId)).limit(1);
      if (!loaded) return undefined;
      if (
        loaded.item.status !== "prepared"
        || !loaded.item.encryptedResolution
        || !loaded.item.resolutionChecksum
        || !loaded.item.templateVersionId
      ) {
        throw new OrderPersonalizationRenderPolicyError("BATCH_ITEM_NOT_PREPARED", "Order personalization batch item is not render-ready");
      }
      return {
        id: loaded.task.id,
        designTaskId: loaded.task.designTaskId,
        batchItemId: loaded.item.id,
        toolKey: loaded.task.toolKey,
        parameterSnapshot: loaded.task.parameterSnapshot,
        encryptedResolution: loaded.item.encryptedResolution,
        resolutionChecksum: loaded.item.resolutionChecksum,
        orderId: loaded.item.orderId,
        orderLineId: loaded.item.orderLineId,
        customizationVersionId: loaded.item.customizationVersionId,
        templateVersionId: loaded.item.templateVersionId,
        maxAttempts: loaded.task.maxAttempts,
      } satisfies OrderPersonalizationRenderTaskRecord;
    });
  }

  async claim(context: Pick<TenantContext, "tenantId" | "userId">, renderTaskId: string, attempt: number) {
    const now = new Date();
    const [claimed] = await withTenant(this.database.db, workerContext(context), (tx) => tx.update(orderPersonalizationRenderTasks).set({
      status: "running",
      progressPercent: 1,
      attemptCount: attempt + 1,
      errorCode: null,
      errorMessage: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
    }).where(and(
      eq(orderPersonalizationRenderTasks.id, renderTaskId),
      eq(orderPersonalizationRenderTasks.status, "queued"),
    )).returning({ id: orderPersonalizationRenderTasks.id }));
    return Boolean(claimed);
  }

  async hydrate(
    context: Pick<TenantContext, "tenantId" | "userId">,
    task: OrderPersonalizationRenderTaskRecord,
    resolution: OrderPersonalizationResolutionSnapshot,
  ): Promise<OrderPersonalizationRenderExecutionRecord> {
    assertResolutionScope(task, resolution);
    const tenantContext = workerContext(context);
    const loaded = await withTenant(this.database.db, tenantContext, async (tx) => {
      const [template] = await tx.select().from(personalizationTemplateVersions)
        .where(eq(personalizationTemplateVersions.id, resolution.templateVersionId)).limit(1);
      if (!template || template.status !== "approved") {
        throw new OrderPersonalizationRenderPolicyError("TEMPLATE_NOT_APPROVED", "Pinned personalization template is not approved");
      }
      const storedSlots = await tx.select().from(templateSlots)
        .where(eq(templateSlots.templateVersionId, template.id)).orderBy(asc(templateSlots.createdAt));
      const assetEvidence = resolution.slots.filter((slot) => slot.kind !== "text");
      const customerIds = [...new Set(assetEvidence.map((slot) => slot.assetId))];
      const customers = customerIds.length
        ? await tx.select().from(assetFiles).where(and(inArray(assetFiles.id, customerIds), isNull(assetFiles.deletedAt)))
        : [];
      const [templateSource] = template.sourceAssetId
        ? await tx.select().from(assetFiles).where(and(eq(assetFiles.id, template.sourceAssetId), isNull(assetFiles.deletedAt))).limit(1)
        : [];
      return { template, storedSlots, assetEvidence, customers, templateSource };
    });

    const evidenceById = new Map(loaded.assetEvidence.map((slot) => [slot.assetId, slot]));
    if (loaded.customers.length !== evidenceById.size) {
      throw new OrderPersonalizationRenderPolicyError("CUSTOMER_ASSET_NOT_FOUND", "One or more pinned customer assets are unavailable");
    }
    const customerAssets = await Promise.all(loaded.customers.map(async (asset) => {
      const evidence = evidenceById.get(asset.id)!;
      const source = asset.rightsMetadata as { source?: { kind?: string; reference?: string } };
      if (
        asset.version !== evidence.assetVersion
        || asset.checksumSha256 !== evidence.checksumSha256
        || asset.mediaType !== evidence.mediaType
        || asset.assetDomain !== "order"
        || asset.rightsStatus !== "approved"
        || source.source?.kind !== "customer_provided"
        || source.source.reference !== `order-customization:${resolution.customizationVersionId}`
      ) throw new OrderPersonalizationRenderPolicyError("CUSTOMER_ASSET_SNAPSHOT_MISMATCH", "Pinned customer asset evidence no longer matches");
      return {
        id: asset.id,
        version: asset.version,
        checksumSha256: asset.checksumSha256,
        mediaType: asset.mediaType,
        bytes: await this.storage.readPrivate(tenantContext, {
          id: asset.id,
          tenantId: asset.tenantId,
          assetDomain: "order",
          objectKey: asset.objectKey,
        }, { requiredDomain: "order" }),
      };
    }));

    let templateSource: OrderPersonalizationRenderSourceAsset | undefined;
    if (loaded.template.sourceAssetId) {
      const source = loaded.templateSource;
      if (
        !source
        || source.version !== loaded.template.sourceAssetVersion
        || source.assetDomain !== "authorized"
        || source.rightsStatus !== "approved"
      ) throw new OrderPersonalizationRenderPolicyError("TEMPLATE_SOURCE_SNAPSHOT_MISMATCH", "Pinned template source evidence no longer matches");
      templateSource = {
        id: source.id,
        version: source.version,
        checksumSha256: source.checksumSha256,
        mediaType: source.mediaType,
        bytes: await this.storage.readPrivate(tenantContext, {
          id: source.id,
          tenantId: source.tenantId,
          assetDomain: "authorized",
          objectKey: source.objectKey,
        }, { requiredDomain: "authorized" }),
      };
    }

    return {
      ...task,
      resolution,
      canvas: TemplateCanvasSchema.parse(loaded.template.canvas),
      slots: loaded.storedSlots.map((slot) => TemplateSlotSchema.parse({
        id: slot.id,
        templateVersionId: slot.templateVersionId,
        stableKey: slot.stableKey,
        name: slot.name,
        kind: slot.kind,
        psdGroup: slot.psdGroup ?? undefined,
        geometry: slot.geometry,
        fillMode: slot.fillMode,
        validationSnapshot: slot.validationSnapshot,
        replaceable: slot.replaceable,
        reuseLabel: slot.reuseLabel ?? undefined,
      })),
      customerAssets,
      templateSource,
    };
  }

  async complete(
    context: Pick<TenantContext, "tenantId" | "userId">,
    task: OrderPersonalizationRenderExecutionRecord,
    result: PodArtworkExecutionResult,
  ) {
    const tenantContext = workerContext(context);
    const outputs = await Promise.all(result.outputs.map(async (output) => {
      const fileName = `${task.id}-${output.fileName}`;
      const stored = await this.storage.putPrivate(tenantContext, {
        body: output.bytes,
        domain: "order",
        fileName,
        mediaType: output.mediaType,
      });
      return { ...output, fileName, stored };
    }));

    await withTenant(this.database.db, tenantContext, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`order-personalization-render:${task.id}`}, 0))`);
      const [current] = await tx.select().from(orderPersonalizationRenderTasks)
        .where(eq(orderPersonalizationRenderTasks.id, task.id)).limit(1);
      if (!current || current.resultVersionId) return;
      if (current.status !== "running") throw new Error("Order personalization render task is not running");

      const outputAssets: Array<{ id: string; version: number }> = [];
      for (const output of outputs) {
        const id = createEntityId();
        await tx.insert(assetFiles).values({
          id,
          tenantId: tenantContext.tenantId,
          ownerUserId: tenantContext.userId,
          objectKey: output.stored.objectKey,
          assetDomain: "order",
          fileName: output.fileName,
          mediaType: output.mediaType,
          byteSize: output.bytes.byteLength,
          checksumSha256: output.stored.checksumSha256,
          rightsStatus: "unverified",
          rightsMetadata: {
            source: { kind: "customer_provided", reference: `order-customization:${task.customizationVersionId}` },
            orderPersonalizationRenderTaskId: task.id,
            modelKey: result.modelKey,
            modelVersion: result.modelVersion,
            seed: result.seed,
            outputMetadata: output.metadata,
          },
          aiGenerated: output.metadata.aiInference !== "none",
        });
        outputAssets.push({ id, version: 1 });
      }

      await tx.insert(rightsAssessments).values(outputAssets.map((output) => ({
        id: createEntityId(),
        tenantId: tenantContext.tenantId,
        assetId: output.id,
        assetVersion: output.version,
        scopeSnapshot: {
          purpose: "order_personalization_output",
          renderTaskId: task.id,
          orderLineId: task.orderLineId,
          toolKey: task.toolKey,
        },
        status: "pending" as const,
        legalRisk: "unknown" as const,
        evidenceSnapshot: [],
        modelKey: result.modelKey,
        modelVersion: result.modelVersion,
      })));

      const [latest] = await tx.select({ versionNumber: designVersions.versionNumber }).from(designVersions)
        .where(eq(designVersions.taskId, task.designTaskId)).orderBy(desc(designVersions.versionNumber)).limit(1);
      const versionId = createEntityId();
      await tx.insert(designVersions).values({
        id: versionId,
        tenantId: tenantContext.tenantId,
        taskId: task.designTaskId,
        versionNumber: (latest?.versionNumber ?? 0) + 1,
        status: "pending_review",
        changeNote: `Generated by order personalization render task ${task.id}. Rights and quality review are required.`,
        createdBy: tenantContext.userId,
      });
      await tx.insert(designVersionFiles).values(outputAssets.map((output, index) => ({
        id: createEntityId(),
        tenantId: tenantContext.tenantId,
        versionId,
        assetFileId: output.id,
        role: outputs[index]!.role,
      })));
      const now = new Date();
      await tx.update(orderPersonalizationRenderTasks).set({
        status: result.partial ? "partially_succeeded" : "awaiting_review",
        progressPercent: 100,
        resultVersionId: versionId,
        modelKey: result.modelKey,
        modelVersion: result.modelVersion,
        seed: result.seed ?? null,
        qualityCheckSnapshot: result.qualityCheckSnapshot,
        completedAt: now,
        updatedAt: now,
      }).where(eq(orderPersonalizationRenderTasks.id, task.id));
      await tx.update(designTasks).set({ status: "in_review", updatedAt: now })
        .where(eq(designTasks.id, task.designTaskId));
    });
  }

  async fail(
    context: Pick<TenantContext, "tenantId" | "userId">,
    renderTaskId: string,
    input: { attempt: number; terminal: boolean; code: string; message: string },
  ) {
    const now = new Date();
    await withTenant(this.database.db, workerContext(context), (tx) => tx.update(orderPersonalizationRenderTasks).set({
      status: input.terminal ? "failed" : "queued",
      progressPercent: input.terminal ? 100 : 0,
      attemptCount: input.attempt + 1,
      errorCode: input.code,
      errorMessage: input.message,
      completedAt: input.terminal ? now : null,
      updatedAt: now,
    }).where(and(
      eq(orderPersonalizationRenderTasks.id, renderTaskId),
      eq(orderPersonalizationRenderTasks.status, "running"),
    )));
  }
}

function assertResolutionScope(task: OrderPersonalizationRenderTaskRecord, resolution: OrderPersonalizationResolutionSnapshot) {
  if (
    resolution.orderId !== task.orderId
    || resolution.orderLineId !== task.orderLineId
    || resolution.customizationVersionId !== task.customizationVersionId
    || resolution.templateVersionId !== task.templateVersionId
  ) throw new OrderPersonalizationRenderPolicyError("RESOLUTION_SCOPE_MISMATCH", "Encrypted slot resolution is outside the pinned render scope");
}

function workerContext(context: Pick<TenantContext, "tenantId" | "userId">): TenantContext {
  return {
    ...context,
    permissions: [Permission.AssetRead, Permission.DesignRead, Permission.DesignWrite, Permission.OrderPiiRead, Permission.OrderRead],
    dataScope: "tenant",
  };
}
