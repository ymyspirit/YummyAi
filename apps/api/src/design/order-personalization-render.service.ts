import { createHash } from "node:crypto";

import { ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import {
  CreateOrderPersonalizationRenderTaskInputSchema,
  OrderPersonalizationRenderTaskListSchema,
  OrderPersonalizationRenderTaskSchema,
  createEntityId,
  type CreateOrderPersonalizationRenderTaskInput,
  type OrderPersonalizationRenderTool,
  type TenantContext,
} from "@yummyai/contracts";
import {
  designTasks,
  orderLineCatalogLinks,
  orderPersonalizationBatchItems,
  orderPersonalizationRenderTasks,
  type DatabaseConnection,
  withTenant,
} from "@yummyai/database";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";

import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION, ORDER_PERSONALIZATION_RENDER_ENQUEUER } from "../platform.tokens.js";

export interface OrderPersonalizationRenderEnqueuer {
  enqueue(input: { renderTaskId: string; tenantId: string; requestedBy: string; maxAttempts: number }): Promise<void>;
}

@Injectable()
export class OrderPersonalizationRenderService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(ORDER_PERSONALIZATION_RENDER_ENQUEUER) private readonly enqueuer: OrderPersonalizationRenderEnqueuer,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async create(context: TenantContext, rawInput: CreateOrderPersonalizationRenderTaskInput) {
    const input = CreateOrderPersonalizationRenderTaskInputSchema.parse(rawInput);
    const requestChecksum = checksum(stableStringify({
      batchItemId: input.batchItemId,
      toolKey: input.toolKey,
      parameterSnapshot: input.parameterSnapshot,
    }));
    const prepared = await withTenant(this.database.db, context, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:${input.idempotencyKey}:order-personalization-render`}, 0))`);
      const [replayed] = await tx.select().from(orderPersonalizationRenderTasks)
        .where(eq(orderPersonalizationRenderTasks.idempotencyKey, input.idempotencyKey)).limit(1);
      if (replayed) {
        if (replayed.requestChecksum !== requestChecksum) {
          throw new ConflictException("The render idempotency key was already used for a different request");
        }
        return { id: replayed.id, replayed: true };
      }
      if (!orderRenderToolEnabled(input.toolKey)) {
        throw new ServiceUnavailableException("The order-personalization processor is not enabled for this tool");
      }
      const [source] = await tx.select({
        itemId: orderPersonalizationBatchItems.id,
        orderLineId: orderPersonalizationBatchItems.orderLineId,
        skuId: orderLineCatalogLinks.skuId,
      }).from(orderPersonalizationBatchItems)
        .innerJoin(orderLineCatalogLinks, eq(orderPersonalizationBatchItems.orderLineId, orderLineCatalogLinks.orderLineId))
        .where(and(
          eq(orderPersonalizationBatchItems.id, input.batchItemId),
          eq(orderPersonalizationBatchItems.status, "prepared"),
          isNotNull(orderPersonalizationBatchItems.encryptedResolution),
          isNotNull(orderPersonalizationBatchItems.resolutionChecksum),
          isNotNull(orderLineCatalogLinks.skuId),
        )).limit(1);
      if (!source?.skuId) throw new NotFoundException("Prepared personalization batch item was not found");

      const designTaskId = createEntityId();
      const id = createEntityId();
      await tx.insert(designTasks).values({
        id: designTaskId,
        tenantId: context.tenantId,
        skuId: source.skuId,
        title: `Order personalization ${input.toolKey}`,
        brief: "Order-scoped rendering. Customer values remain encrypted outside the purpose-bound Worker execution.",
        createdBy: context.userId,
      });
      await tx.insert(orderPersonalizationRenderTasks).values({
        id,
        tenantId: context.tenantId,
        batchItemId: source.itemId,
        designTaskId,
        toolKey: input.toolKey,
        parameterSnapshot: input.parameterSnapshot,
        requestChecksum,
        idempotencyKey: input.idempotencyKey,
        requestedBy: context.userId,
      });
      return { id, replayed: false };
    });

    if (!prepared.replayed) {
      try {
        await this.enqueuer.enqueue({
          renderTaskId: prepared.id,
          tenantId: context.tenantId,
          requestedBy: context.userId,
          maxAttempts: 3,
        });
      } catch {
        const now = new Date();
        await withTenant(this.database.db, context, (tx) => tx.update(orderPersonalizationRenderTasks).set({
          status: "failed",
          errorCode: "QUEUE_DISPATCH_FAILED",
          errorMessage: "Order personalization render queue is unavailable",
          completedAt: now,
          updatedAt: now,
        }).where(eq(orderPersonalizationRenderTasks.id, prepared.id)));
        await this.audit.record(context, {
          action: "pod.order_personalization_render.create",
          resourceType: "order_personalization_render_task",
          resourceId: prepared.id,
          result: "failure",
          metadata: { toolKey: input.toolKey, errorCode: "QUEUE_DISPATCH_FAILED" },
        });
        throw new ServiceUnavailableException("Order personalization render queue is unavailable");
      }
      await this.audit.record(context, {
        action: "pod.order_personalization_render.create",
        resourceType: "order_personalization_render_task",
        resourceId: prepared.id,
        result: "success",
        metadata: { toolKey: input.toolKey },
      });
    }
    return this.get(context, prepared.id);
  }

  async list(context: TenantContext) {
    const rows = await withTenant(this.database.db, context, (tx) => tx.select().from(orderPersonalizationRenderTasks)
      .orderBy(desc(orderPersonalizationRenderTasks.createdAt)).limit(200));
    return OrderPersonalizationRenderTaskListSchema.parse({ items: rows.map(mapTask) });
  }

  async get(context: TenantContext, id: string) {
    const [row] = await withTenant(this.database.db, context, (tx) => tx.select().from(orderPersonalizationRenderTasks)
      .where(eq(orderPersonalizationRenderTasks.id, id)).limit(1));
    if (!row) throw new NotFoundException("Order personalization render task not found");
    return mapTask(row);
  }
}

export function orderRenderToolEnabled(toolKey: OrderPersonalizationRenderTool) {
  const enabled = new Set((process.env.POD_ORDER_ENABLED_TOOLS ?? "").split(",").map((value) => value.trim()).filter(Boolean));
  return Boolean(
    process.env.POD_ORDER_PROCESSOR_URL?.trim()
    && process.env.POD_ORDER_PROCESSOR_API_KEY?.trim()
    && process.env.POD_ORDER_PROCESSOR_DEPLOYMENT_ID?.trim()
    && enabled.has(toolKey),
  );
}

function mapTask(row: typeof orderPersonalizationRenderTasks.$inferSelect) {
  return OrderPersonalizationRenderTaskSchema.parse({
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    batchItemId: row.batchItemId,
    designTaskId: row.designTaskId,
    toolKey: row.toolKey,
    status: row.status,
    parameterSnapshot: row.parameterSnapshot,
    progressPercent: row.progressPercent,
    attemptCount: row.attemptCount,
    maxAttempts: row.maxAttempts,
    resultVersionId: row.resultVersionId ?? undefined,
    modelKey: row.modelKey ?? undefined,
    modelVersion: row.modelVersion ?? undefined,
    seed: row.seed ?? undefined,
    qualityCheckSnapshot: row.qualityCheckSnapshot ?? undefined,
    errorCode: row.errorCode ?? undefined,
    errorMessage: row.errorMessage ?? undefined,
    requestedBy: row.requestedBy ?? undefined,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString(),
    completedAt: row.completedAt?.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

function checksum(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
