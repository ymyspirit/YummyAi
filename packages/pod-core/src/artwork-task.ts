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
import { ForbiddenError, Permission, authorize } from "@yummyai/authz";
import {
  PodPreparedOperationSchema,
  type PodPreparedOperation,
} from "@yummyai/contracts/pod/operation";
import { isDeepStrictEqual } from "node:util";
import {
  assetFiles,
  activeCreativeAsset,
  designTasks,
  podArtworkTaskInputs,
  podArtworkTasks,
  podArtworkInvocations,
  podArtworkExecutions,
  readModelBillingAcknowledgments,
  productPlans,
  skus,
  spus,
  type DatabaseConnection,
  type TenantTransaction,
  withTenant,
} from "@yummyai/database";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { podOwnerErrors, PodOwnerError, type PodOwnerErrors } from "./errors.js";
import { podInvocationViews } from "./invocation.js";
import { podExecutionFingerprint } from "./execution.js";
import { assertPodMethod, selectPodMethod, assertPodMethodInput } from "./harness.js";
import { readPodCompletion } from "./completion.js";
import type { PodCompletionRecord } from "@yummyai/contracts/pod/completion";

export interface PodToolActivation {
  isToolEnabled(toolKey: PodExecutableToolKey): boolean;
}
export interface PodAudit {
  recordInTransaction(
    tx: TenantTransaction,
    context: TenantContext,
    event: {
      action: string;
      resourceType: string;
      resourceId: string;
      result: "success";
      metadata: Record<string, unknown>;
    },
  ): Promise<unknown>;
}

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
  rightsSourceKind?:
    "owned" | "licensed" | "commissioned" | "ai_generated" | "customer_provided" | "competitor";
};

export class PodArtworkInputAssetError extends PodOwnerError {
  constructor(message: string) {
    super("POD_INPUT_POLICY_BLOCKED", 400, message);
    this.name = "PodArtworkInputAssetError";
  }
}

export function assertPodArtworkInputPolicy(
  toolKey: PodExecutableToolKey,
  assets: readonly InputAsset[],
) {
  if (toolKey === "text_to_image" && !assets.length) return;
  if (!assets.length)
    throw new PodArtworkInputAssetError("POD artwork tasks require at least one input asset");
  if (assets.some((asset) => asset.rightsSourceKind === "customer_provided")) {
    throw new PodArtworkInputAssetError(
      "Customer-order assets require an order-scoped personalization workflow",
    );
  }
  if (toolKey === "rights_risk_scan") return;
  if (assets.some((asset) => asset.rightsSourceKind === "competitor"))
    throw new PodArtworkInputAssetError(
      "Competitor source assets cannot be transformed into publishable artwork",
    );
  if (assets.some((asset) => asset.domain !== "authorized" || asset.rightsStatus !== "approved")) {
    throw new PodArtworkInputAssetError(
      "POD artwork transforms require rights-approved assets in the authorized domain",
    );
  }
}

export class PodArtworkOwner {
  constructor(
    private readonly database: DatabaseConnection,
    private readonly enqueuer: PodArtworkEnqueuer,
    private readonly workbench: PodToolActivation,
    private readonly audit: PodAudit,
    private readonly errors: PodOwnerErrors = podOwnerErrors,
  ) {}

  async assertReconfigurationSafe(tx: TenantTransaction, context: TenantContext, operationId: string) {
    authorize(context, Permission.DesignRead);
    const [task] = await tx.select().from(podArtworkTasks).where(eq(podArtworkTasks.idempotencyKey, operationId)).limit(1);
    if (!task) return;
    if (context.dataScope !== "tenant" && task.requestedBy !== context.userId) throw new ForbiddenError(Permission.DesignRead, "outside_data_scope");
    if (task.status === "running" || task.errorCode === "POD_RESULT_UNCERTAIN") throw this.errors.badRequest("原 POD 请求可能已经提交，请先核对原任务的结果与费用，不能重新创建请求");
  }

  async create(
    context: TenantContext,
    rawInput: CreatePodArtworkTaskInput,
    execution: {
      guard?: (tx: TenantTransaction) => Promise<void>;
      pinned?: PodPreparedOperation;
      deferDispatch?: boolean;
      onCreated?: (tx: TenantTransaction, taskId: string) => Promise<void>;
    } = {},
  ) {
    authorize(context, Permission.DesignRead);
    authorize(context, Permission.DesignWrite);
    authorize(context, Permission.AssetRead);
    const input = CreatePodArtworkTaskInputSchema.parse(rawInput);
    if (!this.workbench.isToolEnabled(input.toolKey)) {
      throw this.errors.unavailable(
        "POD artwork tool is not connected to a verified processor deployment",
      );
    }

    const prepared = await withTenant(this.database.db, context, async (tx) => {
      if (execution.guard) await execution.guard(tx);
      // Serialize a stable owner request even when two workflow deliveries race.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${context.tenantId + ":pod:" + input.idempotencyKey}, 0))`,
      );
      const [replayed] = await tx
        .select()
        .from(podArtworkTasks)
        .where(eq(podArtworkTasks.idempotencyKey, input.idempotencyKey))
        .limit(1);
      if (replayed) {
        const [design] = await tx
          .select()
          .from(designTasks)
          .where(eq(designTasks.id, replayed.designTaskId));
        const inputs = await tx
          .select()
          .from(podArtworkTaskInputs)
          .where(eq(podArtworkTaskInputs.taskId, replayed.id))
          .orderBy(asc(podArtworkTaskInputs.ordinal));
        if (
          !design ||
          replayed.requestedBy !== context.userId ||
          design.skuId !== input.skuId ||
          design.title !== input.title ||
          replayed.toolKey !== input.toolKey ||
          !isDeepStrictEqual(replayed.parameterSnapshot, input.parameterSnapshot) ||
          !isDeepStrictEqual(
            inputs.map((entry) => entry.assetFileId),
            input.inputAssetIds,
          )
        )
          throw this.errors.badRequest("POD request identity belongs to different inputs");
        if (execution.onCreated) await execution.onCreated(tx, replayed.id);
        return { id: replayed.id, replayed: true };
      }

      const [sku] = await tx
        .select({ id: skus.id })
        .from(skus)
        .where(eq(skus.id, input.skuId))
        .limit(1);
      if (!sku) throw this.errors.notFound("SKU not found");
      await this.requireSkuScope(tx, context, input.skuId, execution.pinned?.productPlanId);
      const rows = await tx
        .select()
        .from(assetFiles)
        .where(and(inArray(assetFiles.id, input.inputAssetIds), isNull(assetFiles.deletedAt)));
      if (rows.length !== input.inputAssetIds.length)
        throw this.errors.notFound("One or more POD input assets were not found");
      const byId = new Map(rows.map((row) => [row.id, row]));
      const assets = input.inputAssetIds.map((id) => {
        const row = byId.get(id)!;
        const rightsMetadata = row.rightsMetadata as {
          source?: { kind?: InputAsset["rightsSourceKind"] };
        };
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
      if (execution.pinned) {
        const expected = execution.pinned.assets;
        if (
          expected.length !== assets.length ||
          assets.some(
            (asset, index) =>
              !isDeepStrictEqual(expected[index], {
                id: asset.id,
                version: asset.version,
                checksumSha256: asset.checksumSha256,
                domain: asset.domain,
                rightsStatus: asset.rightsStatus,
                rightsSourceKind: asset.rightsSourceKind ?? null,
                fileName: byId.get(asset.id)!.fileName,
                mediaType: byId.get(asset.id)!.mediaType,
                byteSize: byId.get(asset.id)!.byteSize,
              }),
          )
        )
          throw this.errors.badRequest(
            "POD input assets changed after the workflow input was pinned",
          );
      }

      const id = createEntityId();
      const designTaskId = createEntityId();
      const methodSnapshot = execution.pinned
        ? await assertPodMethod(tx, context, input.toolKey, execution.pinned.methodSnapshot, { lock: true })
        : await selectPodMethod(tx, context, input.toolKey);
      assertPodMethodInput(input.toolKey, methodSnapshot, input);
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
      await tx.insert(podArtworkExecutions).values({
        taskId: id, tenantId: context.tenantId,
        methodSnapshot,
        inputFingerprint: podExecutionFingerprint({ id, designTaskId, toolKey: input.toolKey, parameterSnapshot: input.parameterSnapshot, inputAssets: assets, methodSnapshot }),
        dispatchCount: execution.deferDispatch ? 0 : 1,
        lastDispatchedAt: execution.deferDispatch ? null : sql`clock_timestamp()`,
      });
      if (assets.length) {
        await tx.insert(podArtworkTaskInputs).values(
          assets.map((asset, ordinal) => ({
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
          })),
        );
      }
      if (execution.onCreated) await execution.onCreated(tx, id);
      await this.audit.recordInTransaction(tx, context, {
        action: "pod.artwork_task.create",
        resourceType: "pod_artwork_task",
        resourceId: id,
        result: "success",
        metadata: { toolKey: input.toolKey, inputCount: input.inputAssetIds.length },
      });
      return { id, replayed: false };
    });

    if (!prepared.replayed && !execution.deferDispatch) {
      try {
        await this.enqueuer.enqueue({
          taskId: prepared.id,
          tenantId: context.tenantId,
          requestedBy: context.userId,
          maxAttempts: 3,
        });
      } catch {
        // The original queued row is the durable intent; the Worker dispatcher
        // recovers transport failure without creating or purchasing another task.
        await withTenant(this.database.db, context, async tx => {
          await tx.update(podArtworkTasks).set({ errorCode: "QUEUE_UNAVAILABLE", errorMessage: "POD dispatch is pending recovery", updatedAt: new Date() }).where(and(eq(podArtworkTasks.id, prepared.id), eq(podArtworkTasks.status, "queued")));
          await tx.update(podArtworkExecutions).set({ lastDispatchedAt: null, updatedAt: sql`clock_timestamp()` }).where(and(eq(podArtworkExecutions.taskId, prepared.id), eq(podArtworkExecutions.dispatchCount, 1), eq(podArtworkExecutions.phase, "pending")));
        });
      }
    }
    return this.get(context, prepared.id);
  }

  async list(context: TenantContext): Promise<{ items: PodArtworkTaskView[] }> {
    authorize(context, Permission.DesignRead);
    const rows = await withTenant(this.database.db, context, (tx) =>
      tx
        .select({ id: podArtworkTasks.id })
        .from(podArtworkTasks)
        .where(
          context.dataScope === "tenant"
            ? undefined
            : eq(podArtworkTasks.requestedBy, context.userId),
        )
        .orderBy(desc(podArtworkTasks.createdAt))
        .limit(100),
    );
    return { items: await Promise.all(rows.map((row) => this.get(context, row.id))) };
  }

  async inputOptions(context: TenantContext, toolKey: PodExecutableToolKey, productPlanId?: string) {
    authorize(context, Permission.DesignRead);
    authorize(context, Permission.AssetRead);
    const enabled = this.workbench.isToolEnabled(toolKey);
    const result = await withTenant(this.database.db, context, async (tx) => {
      const skuRows = await tx
        .select({
          id: skus.id,
          code: skus.code,
          spuCode: spus.code,
          productName: productPlans.name,
        })
        .from(skus)
        .innerJoin(spus, eq(skus.spuId, spus.id))
        .innerJoin(productPlans, eq(spus.productPlanId, productPlans.id))
        .where(
          and(
            inArray(skus.status, ["draft", "active"]),
            sql`${spus.status} <> 'archived' and ${productPlans.status} <> 'archived'`,
            context.dataScope === "tenant" ? undefined : eq(productPlans.createdBy, context.userId),
            productPlanId ? eq(productPlans.id, productPlanId) : undefined,
          ),
        )
        .orderBy(asc(productPlans.name), asc(skus.code))
        .limit(500);
      const conditions =
        toolKey === "rights_risk_scan"
          ? and(
              isNull(assetFiles.deletedAt),
              inArray(assetFiles.assetDomain, ["research", "authorized"]),
              sql`coalesce(${assetFiles.rightsMetadata}->'source'->>'kind', '') <> 'customer_provided'`,
            )
          : and(
              eq(assetFiles.assetDomain, "authorized"),
              eq(assetFiles.rightsStatus, "approved"),
              isNull(assetFiles.deletedAt),
              sql`coalesce(${assetFiles.rightsMetadata}->'source'->>'kind', '') NOT IN ('customer_provided','competitor')`,
            );
      const assets = await tx
        .select()
        .from(assetFiles)
        .where(and(conditions, activeCreativeAsset()))
        .orderBy(desc(assetFiles.createdAt))
        .limit(500);
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

  async completion(context: TenantContext, id: string): Promise<PodCompletionRecord> {
    authorize(context, Permission.DesignRead);
    authorize(context, Permission.AssetRead);
    const task = await this.get(context, id);
    if (!task.completion) throw this.errors.notFound("此任务未记录原始交接凭据，不能补造历史记录");
    return task.completion;
  }

  async get(context: TenantContext, id: string): Promise<PodArtworkTaskView> {
    authorize(context, Permission.DesignRead);
    const result = await withTenant(this.database.db, context, async (tx) => {
      const [row] = await tx
        .select({ task: podArtworkTasks, design: designTasks })
        .from(podArtworkTasks)
        .innerJoin(designTasks, eq(podArtworkTasks.designTaskId, designTasks.id))
        .where(eq(podArtworkTasks.id, id))
        .limit(1);
      if (!row) throw this.errors.notFound("POD artwork task not found");
      if (context.dataScope !== "tenant" && row.task.requestedBy !== context.userId)
        throw new ForbiddenError(Permission.DesignRead, "outside_data_scope");
      const inputs = await tx
        .select()
        .from(podArtworkTaskInputs)
        .where(eq(podArtworkTaskInputs.taskId, id))
        .orderBy(asc(podArtworkTaskInputs.ordinal));
      const invocations = await tx.select().from(podArtworkInvocations).where(eq(podArtworkInvocations.taskId,id)).orderBy(desc(podArtworkInvocations.attemptNumber)).limit(20);
      const [execution] = await tx.select().from(podArtworkExecutions).where(eq(podArtworkExecutions.taskId, id));
      if (execution?.methodSnapshot?.methodSelection.mode === "published") authorize(context, Permission.WorkflowRead);
      return { row, inputs, invocations, execution, reconciliations: await readModelBillingAcknowledgments(tx, "pod", invocations.map(item => item.id)) };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
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
      invocations: podInvocationViews(task,result.invocations,result.reconciliations,result.execution),
      methodSnapshot: result.execution?.methodSnapshot ?? null,
      completion: readPodCompletion(task, result.execution),
      resultVersionId: task.resultVersionId ?? undefined,
      errorCode: task.errorCode ?? undefined,
      errorMessage: task.errorMessage ?? undefined,
      qualityCheckSnapshot: task.qualityCheckSnapshot ?? undefined,
      reviewSnapshot: task.reviewSnapshot ?? undefined,
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
    });
  }

  async prepareOperation(
    tx: TenantTransaction,
    context: TenantContext,
    planId: string,
    input: CreatePodArtworkTaskInput,
  ): Promise<PodPreparedOperation> {
    authorize(context, Permission.DesignRead);
    authorize(context, Permission.DesignWrite);
    authorize(context, Permission.AssetRead);
    const parsed = CreatePodArtworkTaskInputSchema.parse(input);
    if (!this.workbench.isToolEnabled(parsed.toolKey))
      throw this.errors.unavailable("POD tool has no configured processor deployment");
    await this.requireSkuScope(tx, context, parsed.skuId, planId);
    const assets: PodPreparedOperation["assets"] = [];
    for (const id of parsed.inputAssetIds) {
      const [row] = await tx
        .select()
        .from(assetFiles)
        .where(and(eq(assetFiles.id, id), isNull(assetFiles.deletedAt)))
        .limit(1);
      if (!row) throw this.errors.notFound("POD input asset is unavailable");
      assets.push({
        id,
        version: row.version,
        checksumSha256: row.checksumSha256,
        domain: row.assetDomain,
        rightsStatus: row.rightsStatus,
        rightsSourceKind:
          (row.rightsMetadata as { source?: { kind?: string } }).source?.kind ?? null,
        fileName: row.fileName,
        mediaType: row.mediaType,
        byteSize: row.byteSize,
      });
    }
    assertPodArtworkInputPolicy(
      parsed.toolKey,
      assets.map((asset) => ({
        ...asset,
        domain: asset.domain as InputAsset["domain"],
        rightsStatus: asset.rightsStatus as InputAsset["rightsStatus"],
        rightsSourceKind: asset.rightsSourceKind as InputAsset["rightsSourceKind"],
      })),
    );
    const methodSnapshot = await selectPodMethod(tx, context, parsed.toolKey);
    assertPodMethodInput(parsed.toolKey, methodSnapshot, parsed);
    return PodPreparedOperationSchema.parse({
      schemaVersion: 1,
      productPlanId: planId,
      input: parsed,
      assets,
      methodSnapshot,
    });
  }

  async assertPreparedCurrent(
    tx: TenantTransaction,
    context: TenantContext,
    input: PodPreparedOperation,
  ) {
    await assertPodMethod(tx, context, input.input.toolKey, input.methodSnapshot, { lock: true });
    await this.requireSkuScope(tx, context, input.input.skuId, input.productPlanId);
    for (const pin of input.assets) {
      const [asset] = await tx.select().from(assetFiles).where(eq(assetFiles.id, pin.id)).limit(1);
      const source = asset
        ? ((asset.rightsMetadata as { source?: { kind?: string } }).source?.kind ?? null)
        : null;
      if (
        !asset ||
        asset.deletedAt ||
        asset.version !== pin.version ||
        asset.checksumSha256 !== pin.checksumSha256 ||
        asset.assetDomain !== pin.domain ||
        asset.rightsStatus !== pin.rightsStatus ||
        source !== pin.rightsSourceKind ||
        asset.fileName !== pin.fileName ||
        asset.mediaType !== pin.mediaType ||
        asset.byteSize !== pin.byteSize
      )
        throw this.errors.badRequest("POD input asset changed during capability execution");
    }
  }

  async dispatchPending(context: TenantContext, id: string) {
    authorize(context, Permission.DesignWrite);
    const task = await this.get(context, id);
    if (task.status !== "queued") return false;
    if (!this.workbench.isToolEnabled(task.toolKey))
      throw this.errors.unavailable("POD tool is no longer configured");
    const [row] = await withTenant(this.database.db, context, (tx) =>
      tx
        .select({ requestedBy: podArtworkTasks.requestedBy })
        .from(podArtworkTasks)
        .where(eq(podArtworkTasks.id, id)),
    );
    if (!row || row.requestedBy !== context.userId)
      throw this.errors.badRequest("POD task belongs to a different requesting actor");
    const intent = await withTenant(this.database.db, context, async tx => {
      const [current] = await tx.select().from(podArtworkTasks).where(eq(podArtworkTasks.id, id)).for("update");
      if (!current || current.requestedBy !== context.userId || current.status !== "queued") return undefined;
      const [execution] = await tx.update(podArtworkExecutions).set({ dispatchCount: sql`${podArtworkExecutions.dispatchCount}+1`, lastDispatchedAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()` }).where(and(eq(podArtworkExecutions.taskId, id), eq(podArtworkExecutions.phase, "pending"))).returning({ generation: podArtworkExecutions.dispatchCount });
      return { generation: execution?.generation ?? null };
    });
    if (!intent) return false;
    try {
      await this.enqueuer.enqueue({ taskId: id, tenantId: context.tenantId, requestedBy: context.userId, maxAttempts: task.maxAttempts });
    } catch {
      if (intent.generation === null) throw this.errors.unavailable("POD artwork queue is unavailable");
      await withTenant(this.database.db, context, async tx => {
        await tx.update(podArtworkExecutions).set({ lastDispatchedAt: null, updatedAt: sql`clock_timestamp()` }).where(and(eq(podArtworkExecutions.taskId, id), eq(podArtworkExecutions.dispatchCount, intent.generation!), eq(podArtworkExecutions.phase, "pending")));
        await tx.update(podArtworkTasks).set({ errorCode: "QUEUE_UNAVAILABLE", errorMessage: "POD dispatch is pending recovery", updatedAt: new Date() }).where(and(eq(podArtworkTasks.id, id), eq(podArtworkTasks.status, "queued")));
      });
      return false;
    }
    return true;
  }

  private async requireSkuScope(
    tx: TenantTransaction,
    context: TenantContext,
    skuId: string,
    planId?: string,
  ) {
    const [row] = await tx
      .select({ plan: productPlans, skuStatus: skus.status, spuStatus: spus.status })
      .from(skus)
      .innerJoin(spus, eq(spus.id, skus.spuId))
      .innerJoin(productPlans, eq(productPlans.id, spus.productPlanId))
      .where(eq(skus.id, skuId))
      .limit(1);
    if (
      !row ||
      (planId && row.plan.id !== planId) ||
      [row.plan.status, row.spuStatus, row.skuStatus].includes("archived")
    )
      throw this.errors.notFound("POD SKU does not belong to the active product plan");
    if (context.dataScope !== "tenant" && row.plan.createdBy !== context.userId)
      throw new ForbiddenError(Permission.DesignWrite, "outside_data_scope");
  }
}
