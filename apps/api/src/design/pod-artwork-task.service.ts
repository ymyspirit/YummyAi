import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  CreatePodArtworkTaskInputSchema,
  PodArtworkTaskViewSchema,
  PodTaskInputOptionsViewSchema,
  createEntityId,
  type CreatePodArtworkTaskInput,
  type PodArtworkTaskView,
  type PodExecutableToolKey,
  type TenantContext,
} from "@yummyai/contracts";
import {
  assetFiles,
  designTasks,
  podArtworkTaskInputs,
  podArtworkTasks,
  productPlans,
  skus,
  spus,
  type DatabaseConnection,
  withTenant,
} from "@yummyai/database";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION, POD_ARTWORK_ENQUEUER } from "../platform.tokens.js";
import { PodWorkbenchService } from "./pod-workbench.service.js";

export interface PodArtworkEnqueuer {
  enqueue(input: {
    taskId: string;
    tenantId: string;
    requestedBy: string;
    maxAttempts: number;
  }): Promise<void>;
}

type InputAsset = {
  id: string;
  version: number;
  checksumSha256: string;
  domain: "research" | "authorized";
  rightsStatus: "unverified" | "approved" | "rejected";
  rightsSourceKind?: "owned" | "licensed" | "commissioned" | "ai_generated" | "customer_provided" | "competitor";
};

export class PodArtworkInputAssetError extends BadRequestException {
  constructor(message: string) {
    super(message);
    this.name = "PodArtworkInputAssetError";
  }
}

export function assertPodArtworkInputPolicy(toolKey: PodExecutableToolKey, assets: readonly InputAsset[]) {
  if (toolKey === "text_to_image" && !assets.length) return;
  if (!assets.length) throw new PodArtworkInputAssetError("POD artwork tasks require at least one input asset");
  if (assets.some((asset) => asset.rightsSourceKind === "customer_provided")) {
    throw new PodArtworkInputAssetError("Customer-order assets require an order-scoped personalization workflow");
  }
  if (toolKey === "rights_risk_scan") return;
  if (assets.some((asset) => asset.domain !== "authorized" || asset.rightsStatus !== "approved")) {
    throw new PodArtworkInputAssetError("POD artwork transforms require rights-approved assets in the authorized domain");
  }
}

@Injectable()
export class PodArtworkTaskService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(POD_ARTWORK_ENQUEUER) private readonly enqueuer: PodArtworkEnqueuer,
    @Inject(PodWorkbenchService) private readonly workbench: PodWorkbenchService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async create(context: TenantContext, rawInput: CreatePodArtworkTaskInput) {
    const input = CreatePodArtworkTaskInputSchema.parse(rawInput);
    if (!this.workbench.isToolEnabled(input.toolKey)) {
      throw new ServiceUnavailableException("POD artwork tool is not connected to a verified processor deployment");
    }

    const prepared = await withTenant(this.database.db, context, async (tx) => {
      const [replayed] = await tx.select({ id: podArtworkTasks.id })
        .from(podArtworkTasks)
        .where(eq(podArtworkTasks.idempotencyKey, input.idempotencyKey))
        .limit(1);
      if (replayed) return { id: replayed.id, replayed: true };

      const [sku] = await tx.select({ id: skus.id }).from(skus).where(eq(skus.id, input.skuId)).limit(1);
      if (!sku) throw new NotFoundException("SKU not found");
      const rows = await tx.select().from(assetFiles).where(and(
        inArray(assetFiles.id, input.inputAssetIds),
        isNull(assetFiles.deletedAt),
      ));
      if (rows.length !== input.inputAssetIds.length) throw new NotFoundException("One or more POD input assets were not found");
      const byId = new Map(rows.map((row) => [row.id, row]));
      const assets = input.inputAssetIds.map((id) => {
        const row = byId.get(id)!;
        const rightsMetadata = row.rightsMetadata as { source?: { kind?: InputAsset["rightsSourceKind"] } };
        return {
          id: row.id,
          version: row.version,
          checksumSha256: row.checksumSha256,
          domain: row.assetDomain as InputAsset["domain"],
          rightsStatus: row.rightsStatus as InputAsset["rightsStatus"],
          rightsSourceKind: rightsMetadata.source?.kind,
        };
      });
      assertPodArtworkInputPolicy(input.toolKey, assets);

      const id = createEntityId();
      const designTaskId = createEntityId();
      await tx.insert(designTasks).values({
        id: designTaskId,
        tenantId: context.tenantId,
        skuId: input.skuId,
        title: input.title,
        brief: `POD tool ${input.toolKey}. Input assets and parameters are pinned by the POD task snapshot.`,
        createdBy: context.userId,
      });
      await tx.insert(podArtworkTasks).values({
        id,
        tenantId: context.tenantId,
        designTaskId,
        toolKey: input.toolKey,
        parameterSnapshot: input.parameterSnapshot,
        idempotencyKey: input.idempotencyKey,
        requestedBy: context.userId,
      });
      if (assets.length) {
        await tx.insert(podArtworkTaskInputs).values(assets.map((asset, ordinal) => ({
          id: createEntityId(),
          tenantId: context.tenantId,
          taskId: id,
          assetFileId: asset.id,
          ordinal,
          assetVersion: asset.version,
          checksumSha256: asset.checksumSha256,
          assetDomain: asset.domain,
          rightsStatus: asset.rightsStatus,
          rightsSourceKind: asset.rightsSourceKind,
        })));
      }
      return { id, replayed: false };
    });

    if (!prepared.replayed) {
      try {
        await this.enqueuer.enqueue({
          taskId: prepared.id,
          tenantId: context.tenantId,
          requestedBy: context.userId,
          maxAttempts: 3,
        });
      } catch {
        await withTenant(this.database.db, context, (tx) => tx.update(podArtworkTasks).set({
          status: "failed",
          errorCode: "QUEUE_UNAVAILABLE",
          errorMessage: "POD artwork queue is unavailable",
          completedAt: new Date(),
          updatedAt: new Date(),
        }).where(eq(podArtworkTasks.id, prepared.id)));
        throw new ServiceUnavailableException("POD artwork queue is unavailable");
      }
      await this.audit.record(context, {
        action: "pod.artwork_task.create",
        resourceType: "pod_artwork_task",
        resourceId: prepared.id,
        result: "success",
        metadata: { toolKey: input.toolKey, inputCount: input.inputAssetIds.length },
      });
    }
    return this.get(context, prepared.id);
  }

  async list(context: TenantContext): Promise<{ items: PodArtworkTaskView[] }> {
    const rows = await withTenant(this.database.db, context, (tx) => tx.select({ id: podArtworkTasks.id })
      .from(podArtworkTasks).orderBy(desc(podArtworkTasks.createdAt)).limit(100));
    return { items: await Promise.all(rows.map((row) => this.get(context, row.id))) };
  }

  async inputOptions(context: TenantContext, toolKey: PodExecutableToolKey) {
    const enabled = this.workbench.isToolEnabled(toolKey);
    const result = await withTenant(this.database.db, context, async (tx) => {
      const skuRows = await tx.select({
        id: skus.id,
        code: skus.code,
        spuCode: spus.code,
        productName: productPlans.name,
      }).from(skus)
        .innerJoin(spus, eq(skus.spuId, spus.id))
        .innerJoin(productPlans, eq(spus.productPlanId, productPlans.id))
        .where(inArray(skus.status, ["draft", "active"]))
        .orderBy(asc(productPlans.name), asc(skus.code))
        .limit(500);
      const conditions = toolKey === "rights_risk_scan"
        ? and(
            isNull(assetFiles.deletedAt),
            sql`coalesce(${assetFiles.rightsMetadata}->'source'->>'kind', '') <> 'customer_provided'`,
          )
        : and(
            eq(assetFiles.assetDomain, "authorized"),
            eq(assetFiles.rightsStatus, "approved"),
            isNull(assetFiles.deletedAt),
            sql`coalesce(${assetFiles.rightsMetadata}->'source'->>'kind', '') <> 'customer_provided'`,
          );
      const assets = await tx.select().from(assetFiles).where(conditions)
        .orderBy(desc(assetFiles.createdAt)).limit(500);
      return { skuRows, assets };
    });
    return PodTaskInputOptionsViewSchema.parse({
      toolKey,
      enabled,
      requiresAssetInput: toolKey !== "text_to_image",
      skus: result.skuRows,
      assets: result.assets.map((asset) => ({
        id: asset.id,
        fileName: asset.fileName,
        mediaType: asset.mediaType,
        version: asset.version,
        checksumSha256: asset.checksumSha256,
        domain: asset.assetDomain,
        rightsStatus: asset.rightsStatus,
        rightsSourceKind: (asset.rightsMetadata as { source?: { kind?: string } }).source?.kind,
      })),
    });
  }

  async get(context: TenantContext, id: string): Promise<PodArtworkTaskView> {
    const result = await withTenant(this.database.db, context, async (tx) => {
      const [row] = await tx.select({ task: podArtworkTasks, design: designTasks })
        .from(podArtworkTasks)
        .innerJoin(designTasks, eq(podArtworkTasks.designTaskId, designTasks.id))
        .where(eq(podArtworkTasks.id, id)).limit(1);
      if (!row) throw new NotFoundException("POD artwork task not found");
      const inputs = await tx.select().from(podArtworkTaskInputs)
        .where(eq(podArtworkTaskInputs.taskId, id)).orderBy(asc(podArtworkTaskInputs.ordinal));
      return { row, inputs };
    });
    const { task, design } = result.row;
    return PodArtworkTaskViewSchema.parse({
      id: task.id,
      designTaskId: task.designTaskId,
      skuId: design.skuId,
      title: design.title,
      toolKey: task.toolKey,
      status: task.status,
      parameterSnapshot: task.parameterSnapshot,
      inputAssets: result.inputs.map((input) => ({
        assetId: input.assetFileId,
        ordinal: input.ordinal,
        version: input.assetVersion,
        checksumSha256: input.checksumSha256,
        domain: input.assetDomain,
        rightsStatus: input.rightsStatus,
        rightsSourceKind: input.rightsSourceKind ?? undefined,
      })),
      modelKey: task.modelKey ?? undefined,
      modelVersion: task.modelVersion ?? undefined,
      seed: task.seed ?? undefined,
      progressPercent: task.progressPercent,
      attemptCount: task.attemptCount,
      maxAttempts: task.maxAttempts,
      resultVersionId: task.resultVersionId ?? undefined,
      errorCode: task.errorCode ?? undefined,
      errorMessage: task.errorMessage ?? undefined,
      qualityCheckSnapshot: task.qualityCheckSnapshot ?? undefined,
      reviewSnapshot: task.reviewSnapshot ?? undefined,
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
    });
  }
}
