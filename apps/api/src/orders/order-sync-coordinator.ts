import { Inject, Injectable, UnprocessableEntityException } from "@nestjs/common";
import type { OrderIngestionRunView, TenantContext } from "@yummyai/contracts";
import {
  MarketplaceConnectorError,
  executeOrderSync,
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
