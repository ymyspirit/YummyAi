import { createHash } from "node:crypto";

import { ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import {
  CreateOrderPersonalizationBatchInputSchema,
  OrderPersonalizationBatchListSchema,
  OrderPersonalizationOptionsViewSchema,
  OrderPersonalizationBatchSchema,
  createEntityId,
  type CreateOrderPersonalizationBatchInput,
  type OrderPersonalizationCandidateBlocker,
  type TenantContext,
} from "@yummyai/contracts";
import {
  orderCustomizationRequirements,
  orderCustomizationVersions,
  orderLineCatalogLinks,
  orderLines,
  orderPersonalizationBatchItems,
  orderPersonalizationBatches,
  orders,
  personalizationTemplateVersions,
  skus,
  skuTemplateBindings,
  type DatabaseConnection,
  withTenant,
} from "@yummyai/database";
import { asc, desc, eq, inArray, sql } from "drizzle-orm";

import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION, ORDER_PERSONALIZATION_BATCH_ENQUEUER } from "../platform.tokens.js";

export interface OrderPersonalizationBatchEnqueuer {
  enqueue(input: { batchId: string; tenantId: string; requestedBy: string }): Promise<void>;
}

@Injectable()
export class OrderPersonalizationBatchService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(ORDER_PERSONALIZATION_BATCH_ENQUEUER) private readonly enqueuer: OrderPersonalizationBatchEnqueuer,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async options(context: TenantContext) {
    const items = await withTenant(this.database.db, context, async (tx) => {
      const orderRows = await tx.select({
        orderId: orders.id,
        externalOrderId: orders.externalOrderId,
        platform: orders.platform,
        placedAt: orders.placedAt,
        sideState: orders.sideState,
        orderLineId: orderLines.id,
        externalLineId: orderLines.externalLineId,
        lineTitle: orderLines.title,
        quantity: orderLines.quantity,
        orderSkuCode: orderLines.skuCode,
        requirementId: orderCustomizationRequirements.id,
        requirementStatus: orderCustomizationRequirements.status,
        skuId: orderLineCatalogLinks.skuId,
        catalogSkuCode: skus.code,
      }).from(orders)
        .innerJoin(orderLines, eq(orderLines.orderId, orders.id))
        .leftJoin(orderCustomizationRequirements, eq(orderCustomizationRequirements.orderLineId, orderLines.id))
        .leftJoin(orderLineCatalogLinks, eq(orderLineCatalogLinks.orderLineId, orderLines.id))
        .leftJoin(skus, eq(orderLineCatalogLinks.skuId, skus.id))
        .orderBy(desc(orders.placedAt), asc(orderLines.createdAt))
        .limit(250);

      const requirementIds = orderRows.flatMap((row) => row.requirementId ? [row.requirementId] : []);
      const skuIds = [...new Set(orderRows.flatMap((row) => row.skuId ? [row.skuId] : []))];
      const versions = requirementIds.length
        ? await tx.select().from(orderCustomizationVersions)
          .where(inArray(orderCustomizationVersions.requirementId, requirementIds))
          .orderBy(desc(orderCustomizationVersions.versionNumber))
        : [];
      const bindings = skuIds.length
        ? await tx.select({
          bindingId: skuTemplateBindings.id,
          skuId: skuTemplateBindings.skuId,
          sizeLabel: skuTemplateBindings.sizeLabel,
          bindingStatus: skuTemplateBindings.status,
          effectiveFrom: skuTemplateBindings.effectiveFrom,
          effectiveTo: skuTemplateBindings.effectiveTo,
          templateVersionId: personalizationTemplateVersions.id,
          templateName: personalizationTemplateVersions.name,
          templateStatus: personalizationTemplateVersions.status,
        }).from(skuTemplateBindings)
          .innerJoin(
            personalizationTemplateVersions,
            eq(skuTemplateBindings.templateVersionId, personalizationTemplateVersions.id),
          )
          .where(inArray(skuTemplateBindings.skuId, skuIds))
          .orderBy(desc(skuTemplateBindings.effectiveFrom))
        : [];

      const latestVersions = new Map<string, typeof orderCustomizationVersions.$inferSelect>();
      for (const version of versions) {
        if (!latestVersions.has(version.requirementId)) latestVersions.set(version.requirementId, version);
      }
      const bindingsBySku = new Map<string, typeof bindings>();
      for (const binding of bindings) {
        bindingsBySku.set(binding.skuId, [...(bindingsBySku.get(binding.skuId) ?? []), binding]);
      }

      return orderRows.flatMap((row) => {
        const version = row.requirementId ? latestVersions.get(row.requirementId) : undefined;
        const baseBlockers: OrderPersonalizationCandidateBlocker[] = [];
        if (row.sideState === "cancelled") baseBlockers.push("order_cancelled");
        if (!row.requirementId) baseBlockers.push("customization_requirement_missing");
        else if (!version) baseBlockers.push("customization_version_missing");
        if (
          row.requirementStatus && ["incomplete", "quarantined", "rejected"].includes(row.requirementStatus)
          || version?.missingFieldKeys.length
        ) baseBlockers.push("customization_not_ready");
        if (!row.skuId) baseBlockers.push("catalog_sku_missing");

        const matchingBindings = row.skuId ? bindingsBySku.get(row.skuId) ?? [] : [];
        if (!matchingBindings.length) {
          const blockers = row.skuId ? [...baseBlockers, "template_binding_missing" as const] : baseBlockers;
          return [mapCandidate(row, version, undefined, blockers)];
        }
        return matchingBindings.map((binding) => {
          const blockers = [...baseBlockers];
          if (binding.bindingStatus !== "active") blockers.push("template_binding_inactive");
          if (binding.templateStatus !== "approved") blockers.push("template_not_approved");
          if (
            row.placedAt < binding.effectiveFrom
            || binding.effectiveTo && row.placedAt >= binding.effectiveTo
          ) blockers.push("binding_not_effective_at_order");
          return mapCandidate(row, version, binding, blockers);
        });
      }).slice(0, 500);
    });
    return OrderPersonalizationOptionsViewSchema.parse({ items });
  }

  async create(context: TenantContext, rawInput: CreateOrderPersonalizationBatchInput) {
    const input = CreateOrderPersonalizationBatchInputSchema.parse(rawInput);
    const requestChecksum = checksum(stableStringify(input.items));
    const prepared = await withTenant(this.database.db, context, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:${input.idempotencyKey}:order-personalization-batch`}, 0))`);
      const [replayed] = await tx.select().from(orderPersonalizationBatches)
        .where(eq(orderPersonalizationBatches.idempotencyKey, input.idempotencyKey)).limit(1);
      if (replayed) {
        if (replayed.requestChecksum !== requestChecksum) {
          throw new ConflictException("The personalization batch idempotency key was already used for a different request");
        }
        return { id: replayed.id, replayed: true };
      }

      const orderIds = [...new Set(input.items.map((item) => item.orderId))];
      const orderLineIds = [...new Set(input.items.map((item) => item.orderLineId))];
      const customizationVersionIds = [...new Set(input.items.map((item) => item.customizationVersionId))];
      const bindingIds = [...new Set(input.items.map((item) => item.bindingId))];
      const visibleOrders = await tx.select({ id: orders.id }).from(orders).where(inArray(orders.id, orderIds));
      const visibleOrderLines = await tx.select({ id: orderLines.id }).from(orderLines).where(inArray(orderLines.id, orderLineIds));
      const visibleCustomizationVersions = await tx.select({ id: orderCustomizationVersions.id }).from(orderCustomizationVersions)
        .where(inArray(orderCustomizationVersions.id, customizationVersionIds));
      const visibleBindings = await tx.select({ id: skuTemplateBindings.id }).from(skuTemplateBindings)
        .where(inArray(skuTemplateBindings.id, bindingIds));
      assertVisibleCount(visibleOrders.length, orderIds.length, "Order");
      assertVisibleCount(visibleOrderLines.length, orderLineIds.length, "Order line");
      assertVisibleCount(visibleCustomizationVersions.length, customizationVersionIds.length, "Customization version");
      assertVisibleCount(visibleBindings.length, bindingIds.length, "Template binding");

      const id = createEntityId();
      await tx.insert(orderPersonalizationBatches).values({
        id,
        tenantId: context.tenantId,
        idempotencyKey: input.idempotencyKey,
        requestChecksum,
        itemCount: input.items.length,
        requestedBy: context.userId,
      });
      await tx.insert(orderPersonalizationBatchItems).values(input.items.map((item, ordinal) => ({
        id: createEntityId(),
        tenantId: context.tenantId,
        batchId: id,
        ordinal,
        ...item,
      })));
      return { id, replayed: false };
    });

    if (!prepared.replayed) {
      try {
        await this.enqueuer.enqueue({ batchId: prepared.id, tenantId: context.tenantId, requestedBy: context.userId });
      } catch {
        const now = new Date();
        await withTenant(this.database.db, context, async (tx) => {
          await tx.update(orderPersonalizationBatchItems).set({
            status: "failed",
            errorCode: "QUEUE_DISPATCH_FAILED",
            errorMessage: "Order personalization preparation queue is unavailable",
            completedAt: now,
            updatedAt: now,
          }).where(eq(orderPersonalizationBatchItems.batchId, prepared.id));
          await tx.update(orderPersonalizationBatches).set({
            status: "failed",
            failedCount: input.items.length,
            errorCode: "QUEUE_DISPATCH_FAILED",
            errorMessage: "Order personalization preparation queue is unavailable",
            completedAt: now,
            updatedAt: now,
          }).where(eq(orderPersonalizationBatches.id, prepared.id));
        });
        await this.audit.record(context, {
          action: "pod.order_personalization_batch.create",
          resourceType: "order_personalization_batch",
          resourceId: prepared.id,
          result: "failure",
          metadata: { itemCount: input.items.length, errorCode: "QUEUE_DISPATCH_FAILED" },
        });
        throw new ServiceUnavailableException("Order personalization preparation queue is unavailable");
      }
      await this.audit.record(context, {
        action: "pod.order_personalization_batch.create",
        resourceType: "order_personalization_batch",
        resourceId: prepared.id,
        result: "success",
        metadata: { itemCount: input.items.length },
      });
    }
    return this.get(context, prepared.id);
  }

  async list(context: TenantContext) {
    const batches = await withTenant(this.database.db, context, (tx) => tx.select().from(orderPersonalizationBatches)
      .orderBy(desc(orderPersonalizationBatches.createdAt)).limit(200));
    if (!batches.length) return OrderPersonalizationBatchListSchema.parse({ items: [] });
    const items = await withTenant(this.database.db, context, (tx) => tx.select().from(orderPersonalizationBatchItems)
      .where(inArray(orderPersonalizationBatchItems.batchId, batches.map((batch) => batch.id)))
      .orderBy(asc(orderPersonalizationBatchItems.ordinal)));
    const byBatch = groupItems(items);
    return OrderPersonalizationBatchListSchema.parse({
      items: batches.map((batch) => mapBatch(batch, byBatch.get(batch.id) ?? [])),
    });
  }

  async get(context: TenantContext, id: string) {
    const [batch] = await withTenant(this.database.db, context, (tx) => tx.select().from(orderPersonalizationBatches)
      .where(eq(orderPersonalizationBatches.id, id)).limit(1));
    if (!batch) throw new NotFoundException("Order personalization batch not found");
    const items = await withTenant(this.database.db, context, (tx) => tx.select().from(orderPersonalizationBatchItems)
      .where(eq(orderPersonalizationBatchItems.batchId, id)).orderBy(asc(orderPersonalizationBatchItems.ordinal)));
    return mapBatch(batch, items);
  }
}

function mapCandidate(
  row: {
    orderId: string;
    externalOrderId: string;
    platform: string;
    placedAt: Date;
    orderLineId: string;
    externalLineId: string;
    lineTitle: string;
    quantity: number;
    orderSkuCode: string | null;
    requirementStatus: string | null;
    skuId: string | null;
    catalogSkuCode: string | null;
  },
  version: typeof orderCustomizationVersions.$inferSelect | undefined,
  binding: {
    bindingId: string;
    templateVersionId: string;
    templateName: string;
    sizeLabel: string;
  } | undefined,
  blockers: OrderPersonalizationCandidateBlocker[],
) {
  return {
    orderId: row.orderId,
    externalOrderId: row.externalOrderId,
    platform: row.platform,
    placedAt: row.placedAt.toISOString(),
    orderLineId: row.orderLineId,
    externalLineId: row.externalLineId,
    lineTitle: row.lineTitle,
    quantity: row.quantity,
    ...(row.skuId ? { skuId: row.skuId } : {}),
    ...(row.catalogSkuCode || row.orderSkuCode ? { skuCode: row.catalogSkuCode ?? row.orderSkuCode! } : {}),
    ...(version ? {
      customizationVersionId: version.id,
      customizationVersionNumber: version.versionNumber,
      completeness: version.completeness,
    } : {}),
    ...(row.requirementStatus ? { requirementStatus: row.requirementStatus } : {}),
    ...(binding ? {
      bindingId: binding.bindingId,
      templateVersionId: binding.templateVersionId,
      templateName: binding.templateName,
      sizeLabel: binding.sizeLabel,
    } : {}),
    eligible: blockers.length === 0,
    blockers: [...new Set(blockers)],
  };
}

function assertVisibleCount(actual: number, expected: number, label: string) {
  if (actual !== expected) throw new NotFoundException(`${label} not found`);
}

function groupItems(items: Array<typeof orderPersonalizationBatchItems.$inferSelect>) {
  const result = new Map<string, Array<typeof orderPersonalizationBatchItems.$inferSelect>>();
  for (const item of items) result.set(item.batchId, [...(result.get(item.batchId) ?? []), item]);
  return result;
}

function mapBatch(
  batch: typeof orderPersonalizationBatches.$inferSelect,
  items: Array<typeof orderPersonalizationBatchItems.$inferSelect>,
) {
  return OrderPersonalizationBatchSchema.parse({
    id: batch.id,
    idempotencyKey: batch.idempotencyKey,
    status: batch.status,
    itemCount: batch.itemCount,
    preparedCount: batch.preparedCount,
    failedCount: batch.failedCount,
    errorCode: batch.errorCode ?? undefined,
    errorMessage: batch.errorMessage ?? undefined,
    requestedBy: batch.requestedBy ?? undefined,
    items: items.map((item) => ({
      id: item.id,
      ordinal: item.ordinal,
      orderId: item.orderId,
      orderLineId: item.orderLineId,
      customizationVersionId: item.customizationVersionId,
      bindingId: item.bindingId,
      templateVersionId: item.templateVersionId ?? undefined,
      status: item.status,
      resolvedSlotCount: item.resolvedSlotCount,
      resolutionChecksum: item.resolutionChecksum ?? undefined,
      errorCode: item.errorCode ?? undefined,
      errorMessage: item.errorMessage ?? undefined,
      startedAt: item.startedAt?.toISOString(),
      completedAt: item.completedAt?.toISOString(),
    })),
    createdAt: batch.createdAt.toISOString(),
    startedAt: batch.startedAt?.toISOString(),
    completedAt: batch.completedAt?.toISOString(),
    updatedAt: batch.updatedAt.toISOString(),
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
