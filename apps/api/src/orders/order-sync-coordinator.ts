import { createHash } from "node:crypto";
import { ConflictException, Inject, Injectable, UnprocessableEntityException } from "@nestjs/common";
import { authorize, Permission } from "@yummyai/authz";
import type { OrderIngestionRunView, TenantContext } from "@yummyai/contracts";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { OrderSyncNodeInputSchema, OrderSyncPageSchema } from "@yummyai/contracts/order/sync";
import { orderSyncSchedules, orderIngestionRuns, type TenantTransaction, type marketplaceStoreNodeExecutions } from "@yummyai/database";
import { and, eq } from "drizzle-orm";
import { databaseNow, lockMarketplaceAccount } from "../marketplaces/marketplace-authority.js";
import {
  MarketplaceConnectorError,
  executeOrderSync,
  assessOrderIngestion,
  type MarketplaceConnectorContext,
  type MarketplaceCredentialAccessor,
  type MarketplaceOrderIngestionAdapter,
  type OrderSyncRequest,
} from "@yummyai/marketplace-connectors";

import { OrderIngestionService } from "./order-ingestion.service.js";
import { OrderService } from "./order.service.js";

export interface RunOrderSyncInput {
  connectorContext: MarketplaceConnectorContext;
  stream?: string;
  adapter: MarketplaceOrderIngestionAdapter;
  credentials: MarketplaceCredentialAccessor;
  request: OrderSyncRequest;
}

@Injectable()
export class OrderSyncCoordinator {
  constructor(
    @Inject(OrderIngestionService) private readonly ingestion: OrderIngestionService,
    @Inject(OrderService) private readonly orders: OrderService,
  ) {}

  async assertNodeRunInTransaction(tx: TenantTransaction, row: typeof marketplaceStoreNodeExecutions.$inferSelect) {
    const { account, authority } = await lockMarketplaceAccount(tx, row.authorityCeiling, row.accountId, Permission.StoreManage);
    for (const permission of [Permission.StoreRead, Permission.OrderRead, Permission.OrderWrite, Permission.OrderPiiRead]) authorize(authority, permission);
    const input = OrderSyncNodeInputSchema.parse(row.input);
    const [schedule] = await tx.select().from(orderSyncSchedules).where(eq(orderSyncSchedules.accountId, row.accountId)).for("update");
    const [run] = await tx.select().from(orderIngestionRuns).where(eq(orderIngestionRuns.id, input.runId)).for("update");
    if (account.platform !== "amazon" || !schedule?.enabled || schedule.activeExecutionId !== row.id || schedule.lastRunId !== input.runId
      || schedule.requestedBy !== authority.userId || row.createdBy !== authority.userId || row.tenantId !== authority.tenantId
      || schedule.authorizationGeneration !== row.authorizationGeneration || account.authorizationGeneration !== row.authorizationGeneration
      || canonicalJson(schedule.request) !== canonicalJson(input.request) || run?.status !== "running" || run.accountId !== row.accountId
      || run.platform !== "amazon" || run.stream !== "automatic-orders" || run.checkpointVersionStart !== input.request.checkpoint.version)
      throw new ConflictException({ code: "order_sync_authority_changed" });
    return { account, authority, schedule, input };
  }

  async adoptNodePageInTransaction(tx: TenantTransaction, row: typeof marketplaceStoreNodeExecutions.$inferSelect, raw: unknown) {
    const { account, authority, schedule, input } = await this.assertNodeRunInTransaction(tx, row);
    const result = OrderSyncPageSchema.parse(raw), now = await databaseNow(tx), request = input.request;
    const cursorHash = result.nextCursor ? createHash("sha256").update(result.nextCursor).digest("hex") : null;
    if (result.sourceVersion !== "amazon-orders-2026-01-01" || result.highWaterAt !== request.updatedBefore
      || result.records.length > request.pageSize || Date.parse(result.fetchedAt) < row.startedAt!.getTime() - 30_000
      || Date.parse(result.fetchedAt) > now.getTime() + 30_000
      || cursorHash && (schedule.cursorHashes.includes(cursorHash) || schedule.cursorHashes.length >= 50)
      || result.records.some(record => record.order.accountId !== account.id || record.order.platform !== "amazon"
        || !account.marketplaceIds.includes(String(record.order.redactedSource.marketplaceId))
        || Date.parse(record.providerUpdatedAt) < Date.parse(request.updatedAfter) || Date.parse(record.providerUpdatedAt) > Date.parse(request.updatedBefore)))
      throw new ConflictException({ code: "order_sync_result_invalid" });
    const risks = assessOrderIngestion({ records: result.records, fetchedAt: result.fetchedAt });
    let duplicateCount = 0;
    for (const record of result.records) {
      const materialized = await this.orders.materializeNormalizedInTransaction(tx, authority, record.order);
      if (materialized.replayed) duplicateCount++;
      for (const externalLineId of materialized.unlinkedLineIds) {
        if (!risks.some(risk => risk.code === "unsupported_mapping" && risk.externalOrderId === record.order.externalOrderId && risk.externalLineId === externalLineId))
          risks.push({ code: "unsupported_mapping", severity: "warning", externalOrderId: record.order.externalOrderId,
            externalLineId, message: "Order line could not be linked to an approved local listing or active SKU" });
      }
    }
    await this.ingestion.completeInTransaction(tx, authority, input.runId, { collectedCount: result.records.length,
      reportedCount: result.reportedCount, duplicateCount, sourceVersion: result.sourceVersion, risks,
      nextCursor: result.nextCursor, highWaterAt: result.highWaterAt, status: result.nextCursor ? "partial" : "completed" });
    await tx.update(orderSyncSchedules).set({ activeExecutionId: null, failureCount: 0, errorCode: null,
      request: result.nextCursor ? { ...request, checkpoint: { ...request.checkpoint, cursor: result.nextCursor, version: request.checkpoint.version + 1 } } : null,
      cursorHashes: cursorHash ? [...schedule.cursorHashes, cursorHash] : [],
      nextRunAt: new Date(now.getTime() + 5 * 60_000), updatedAt: now }).where(eq(orderSyncSchedules.id, schedule.id));
  }

  async failNodeRunInTransaction(tx: TenantTransaction, row: typeof marketplaceStoreNodeExecutions.$inferSelect, code: string) {
    const input = OrderSyncNodeInputSchema.parse(row.input);
    const [run] = await tx.select().from(orderIngestionRuns).where(eq(orderIngestionRuns.id, input.runId)).for("update");
    if (run?.status === "running") await this.ingestion.failInTransaction(tx, row.authorityCeiling, run.id, code.toUpperCase());
    const [schedule] = await tx.select().from(orderSyncSchedules).where(and(eq(orderSyncSchedules.accountId, row.accountId), eq(orderSyncSchedules.activeExecutionId, row.id))).for("update");
    if (!schedule) return;
    const retryable = ["store_node_upstream_rate_limited", "store_node_upstream_retryable", "store_node_operation_unknown", "store_node_execution_expired"].includes(code);
    const now = await databaseNow(tx);
    await tx.update(orderSyncSchedules).set({ activeExecutionId: null, enabled: retryable && schedule.enabled && schedule.failureCount < 5,
      errorCode: code, failureCount: schedule.failureCount + 1, updatedAt: now,
      nextRunAt: new Date(now.getTime() + 5 * 60_000 * 2 ** Math.min(schedule.failureCount, 4)) }).where(eq(orderSyncSchedules.id, schedule.id));
  }

  async run(context: TenantContext, input: RunOrderSyncInput, signal: AbortSignal): Promise<OrderIngestionRunView> {
    const stream = input.stream?.trim() || "orders";
    if (input.connectorContext.tenantId !== context.tenantId || input.connectorContext.platform !== input.adapter.platform) {
      throw new UnprocessableEntityException("Marketplace connector context does not match the order sync request");
    }
    const run = await this.ingestion.start(context, {
      accountId: input.connectorContext.accountId,
      platform: input.adapter.platform,
      stream,
      sourceVersion: `${input.adapter.platform}-order-sync`,
    });
    try {
      if (input.request.checkpoint.version !== run.checkpointVersionStart) {
        throw new UnprocessableEntityException("Order sync request does not match the persisted checkpoint version");
      }
      const execution = await executeOrderSync({
        adapter: input.adapter,
        context: input.connectorContext,
        credentials: input.credentials,
        request: input.request,
        signal,
        materialize: async (order) => {
          if (order.accountId !== input.connectorContext.accountId || order.platform !== input.adapter.platform) {
            throw new UnprocessableEntityException("Normalized order identity does not match the ingestion run");
          }
          const result = await this.orders.materializeNormalized(context, order);
          return { replayed: result.replayed, unlinkedLineIds: result.unlinkedLineIds };
        },
      });
      return this.ingestion.complete(context, run.id, {
        collectedCount: execution.collectedCount,
        reportedCount: execution.reportedCount,
        duplicateCount: execution.duplicateCount,
        sourceVersion: execution.sourceVersion,
        nextCursor: execution.nextCursor,
        highWaterAt: execution.highWaterAt,
        risks: execution.risks,
        status: execution.status,
      });
    } catch (error) {
      const code = error instanceof MarketplaceConnectorError
        ? `CONNECTOR_${error.code.toUpperCase()}`
        : "INGESTION_FAILED";
      await this.ingestion.fail(context, run.id, code).catch(() => undefined);
      throw error;
    }
  }
}
