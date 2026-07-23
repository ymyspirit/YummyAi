import type { SecretVault } from "@yummyai/ai-core";
import {
  MarketplacePlatformSchema, MarketplaceRegionSchema, createEntityId,
  type MarketplacePlatform, type TenantContext,
} from "@yummyai/contracts";
import {
  marketplaceAccounts, marketplaceCredentials, orderEvents, orderExceptionEvents, orderExceptions, orderLines, orders,
  shipmentPackageLines, shipmentPackages, shipmentVersions, shipmentWritebackEvents, shipmentWritebackRequests, shipments,
  type DatabaseConnection, type TenantTransaction, withTenant,
} from "@yummyai/database";
import { ShipmentWritebackJobPayloadSchema, type JobEnvelope } from "@yummyai/jobs";
import type {
  MarketplaceConnectorContext, MarketplaceShipmentWritebackConnector,
  MarketplaceShipmentWritebackResult, ShipmentWritebackInput,
} from "@yummyai/marketplace-connectors";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

export interface ShipmentWritebackExecutionSnapshot {
  requestId: string;
  accountId: string;
  orderId: string;
  shipmentId: string;
  projectionVersion: number;
  context: MarketplaceConnectorContext;
  input: ShipmentWritebackInput;
}

export interface ShipmentWritebackExecutionRepository {
  claim(context: TenantContext, requestId: string, attempt: number): Promise<ShipmentWritebackExecutionSnapshot | undefined>;
  withCredential<T>(context: TenantContext, accountId: string, callback: (credential: Readonly<Record<string, string>>) => Promise<T>): Promise<T>;
  complete(context: TenantContext, snapshot: ShipmentWritebackExecutionSnapshot, result: MarketplaceShipmentWritebackResult): Promise<void>;
}

export class ShipmentWritebackProcessor {
  constructor(
    private readonly repository: ShipmentWritebackExecutionRepository,
    private readonly connectors: Readonly<Record<MarketplacePlatform, MarketplaceShipmentWritebackConnector>>,
  ) {}

  async process(envelope: JobEnvelope) {
    const payload = ShipmentWritebackJobPayloadSchema.parse(envelope.payload);
    const context: TenantContext = { tenantId: envelope.tenantId, userId: envelope.requestedBy, permissions: [], dataScope: "tenant" };
    const snapshot = await this.repository.claim(context, payload.writebackRequestId, envelope.attempt);
    if (!snapshot) return { requestId: payload.writebackRequestId, status: "ignored" };
    const connector = this.connectors[snapshot.context.platform];
    let result: MarketplaceShipmentWritebackResult;
    try {
      result = await this.repository.withCredential(context, snapshot.accountId, (credential) => connector.confirm(
        snapshot.context, { withCredential: (callback) => callback(credential) }, snapshot.input, AbortSignal.timeout(30_000),
      ));
    } catch {
      result = { status: "rejected", providerCode: "CREDENTIAL_OR_CONNECTOR_ERROR", externalReference: null };
    }
    await this.repository.complete(context, snapshot, result);
    return { requestId: snapshot.requestId, status: result.status };
  }
}

export class DrizzleShipmentWritebackExecutionRepository implements ShipmentWritebackExecutionRepository {
  constructor(private readonly database: DatabaseConnection, private readonly secrets: SecretVault) {}

  async claim(context: TenantContext, requestId: string, attempt: number) {
    return withTenant(this.database.db, context, async (tx) => {
      await lock(tx, requestId);
      const [request] = await tx.select().from(shipmentWritebackRequests).where(eq(shipmentWritebackRequests.id, requestId)).limit(1);
      if (!request) return undefined;
      if (attempt > 0 && request.status === "dispatched") {
        await appendWritebackEvent(tx, context, request, "uncertain", "reconciliation_required", "WORKER_INTERRUPTED_OUTCOME_UNKNOWN", null);
        await tx.update(shipmentWritebackRequests).set({ status: "reconciliation_required", projectionVersion: request.projectionVersion + 1, updatedAt: new Date() }).where(eq(shipmentWritebackRequests.id, request.id));
        await tx.update(shipments).set({ status: "exception", updatedAt: new Date() }).where(eq(shipments.id, request.shipmentId));
        await openLogisticsException(tx, context, request.orderId, `worker-uncertain:${request.id}`, "SHIPMENT_WRITEBACK_UNCERTAIN");
        return undefined;
      }
      if (request.status !== "queued") return undefined;
      const [[account], [version], [order]] = await Promise.all([
        tx.select().from(marketplaceAccounts).where(eq(marketplaceAccounts.id, request.accountId)).limit(1),
        tx.select().from(shipmentVersions).where(eq(shipmentVersions.id, request.shipmentVersionId)).limit(1),
        tx.select().from(orders).where(eq(orders.id, request.orderId)).limit(1),
      ]);
      if (!account || !version || !order || account.status !== "active" || account.healthStatus !== "healthy" || !account.externalAccountId) {
        await appendWritebackEvent(tx, context, request, "rejected", "rejected", "ACCOUNT_OR_SNAPSHOT_UNAVAILABLE", null);
        await tx.update(shipmentWritebackRequests).set({ status: "rejected", projectionVersion: request.projectionVersion + 1, updatedAt: new Date() }).where(eq(shipmentWritebackRequests.id, request.id));
        await tx.update(shipments).set({ status: "approved", updatedAt: new Date() }).where(eq(shipments.id, request.shipmentId));
        return undefined;
      }
      const packages = await tx.select().from(shipmentPackages).where(eq(shipmentPackages.shipmentVersionId, version.id));
      const allocations = await tx.select().from(shipmentPackageLines).where(eq(shipmentPackageLines.shipmentVersionId, version.id));
      const lineRows = await tx.select({ id: orderLines.id, externalLineId: orderLines.externalLineId }).from(orderLines).where(eq(orderLines.orderId, order.id));
      const externalLines = new Map(lineRows.map((line) => [line.id, line.externalLineId]));
      if (!packages.length || allocations.some((entry) => !externalLines.has(entry.orderLineId))) return undefined;
      await appendWritebackEvent(tx, context, request, "dispatched", "dispatched", null, null);
      await tx.update(shipmentWritebackRequests).set({ status: "dispatched", projectionVersion: request.projectionVersion + 1, updatedAt: new Date() }).where(eq(shipmentWritebackRequests.id, request.id));
      return {
        requestId: request.id, accountId: account.id, orderId: order.id, shipmentId: request.shipmentId,
        projectionVersion: request.projectionVersion + 1,
        context: {
          tenantId: context.tenantId, accountId: account.id, platform: MarketplacePlatformSchema.parse(account.platform),
          region: MarketplaceRegionSchema.parse(account.region), externalAccountId: account.externalAccountId,
          marketplaceIds: account.marketplaceIds,
        },
        input: {
          externalOrderId: order.externalOrderId, shipDate: version.shipDate.toISOString(),
          packages: packages.map((pkg) => ({
            packageReferenceId: pkg.packageReferenceId, trackingNumber: pkg.trackingNumber,
            carrierCode: pkg.carrierCode, carrierName: pkg.carrierName, carrierService: pkg.carrierService,
            lines: allocations.filter((entry) => entry.packageId === pkg.id).map((entry) => ({ externalLineId: externalLines.get(entry.orderLineId)!, quantity: entry.quantity })),
          })),
        },
      } satisfies ShipmentWritebackExecutionSnapshot;
    });
  }

  async withCredential<T>(context: TenantContext, accountId: string, callback: (credential: Readonly<Record<string, string>>) => Promise<T>) {
    const [credential] = await withTenant(this.database.db, context, (tx) => tx.select({ encryptedEnvelope: marketplaceCredentials.encryptedEnvelope }).from(marketplaceCredentials).where(eq(marketplaceCredentials.accountId, accountId)).limit(1));
    if (!credential) throw new Error("Marketplace credential is unavailable");
    return this.secrets.withSecret(credential.encryptedEnvelope, (raw) => callback(z.record(z.string(), z.string()).parse(JSON.parse(raw))));
  }

  async complete(context: TenantContext, snapshot: ShipmentWritebackExecutionSnapshot, result: MarketplaceShipmentWritebackResult) {
    await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, snapshot.requestId);
      const [request] = await tx.select().from(shipmentWritebackRequests).where(eq(shipmentWritebackRequests.id, snapshot.requestId)).limit(1);
      if (!request || request.status !== "dispatched" || request.projectionVersion !== snapshot.projectionVersion) return;
      const action = result.status === "accepted" ? "accepted" : result.status === "uncertain" ? "uncertain" : "rejected";
      const toStatus = result.status === "accepted" ? "accepted" : result.status === "uncertain" ? "reconciliation_required" : "rejected";
      await appendWritebackEvent(tx, context, request, action, toStatus, result.providerCode, result.externalReference);
      await tx.update(shipmentWritebackRequests).set({ status: toStatus, projectionVersion: request.projectionVersion + 1, updatedAt: new Date() }).where(eq(shipmentWritebackRequests.id, request.id));
      await tx.update(shipments).set({ status: result.status === "accepted" ? "shipped" : result.status === "uncertain" ? "exception" : "approved", updatedAt: new Date() }).where(eq(shipments.id, request.shipmentId));
      if (result.status === "accepted") await advanceOrderIfFullyShipped(tx, context, request.orderId, request.id);
      else await openLogisticsException(tx, context, request.orderId, `worker-result:${request.id}:${result.status}`, result.status === "uncertain" ? "SHIPMENT_WRITEBACK_UNCERTAIN" : "SHIPMENT_WRITEBACK_REJECTED");
    });
  }
}

async function advanceOrderIfFullyShipped(tx: TenantTransaction, context: TenantContext, orderId: string, requestId: string) {
  await lock(tx, orderId);
  const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order || order.workflowState !== "awaiting_shipment") return;
  const lineRows = await tx.select({ id: orderLines.id, quantity: orderLines.quantity }).from(orderLines).where(eq(orderLines.orderId, orderId));
  const accepted = await tx.select().from(shipments).where(and(eq(shipments.orderId, orderId), inArray(shipments.status, ["shipped", "in_transit", "delivered"])));
  const versions = accepted.length ? await tx.select({ id: shipmentVersions.id, shipmentId: shipmentVersions.shipmentId, versionNumber: shipmentVersions.versionNumber }).from(shipmentVersions).where(inArray(shipmentVersions.shipmentId, accepted.map((entry) => entry.id))) : [];
  const ids = versions.filter((version) => accepted.some((entry) => entry.id === version.shipmentId && entry.approvedVersionNumber === version.versionNumber)).map((entry) => entry.id);
  const allocations = ids.length ? await tx.select({ orderLineId: shipmentPackageLines.orderLineId, quantity: shipmentPackageLines.quantity }).from(shipmentPackageLines).where(inArray(shipmentPackageLines.shipmentVersionId, ids)) : [];
  const totals = new Map<string, number>();
  for (const entry of allocations) totals.set(entry.orderLineId, (totals.get(entry.orderLineId) ?? 0) + entry.quantity);
  if (lineRows.some((line) => totals.get(line.id) !== line.quantity)) return;
  const sequence = order.latestEventSequence + 1;
  await tx.update(orders).set({ workflowState: "shipped", latestEventSequence: sequence, updatedAt: new Date() }).where(and(eq(orders.id, order.id), eq(orders.latestEventSequence, order.latestEventSequence)));
  await tx.insert(orderEvents).values({ id: createEntityId(), tenantId: context.tenantId, orderId, sequence, type: "workflow_transitioned", fromWorkflowState: "awaiting_shipment", toWorkflowState: "shipped", message: "Marketplace accepted shipment evidence", idempotencyKey: `shipment-accepted:${requestId}`, actorUserId: context.userId });
}

async function openLogisticsException(tx: TenantTransaction, context: TenantContext, orderId: string, idempotencyKey: string, code: string) {
  await lock(tx, orderId);
  const [existing] = await tx.select({ id: orderEvents.id }).from(orderEvents).where(and(eq(orderEvents.orderId, orderId), eq(orderEvents.idempotencyKey, idempotencyKey))).limit(1);
  if (existing) return;
  const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order) return;
  const exceptionId = createEntityId(); const sequence = order.latestEventSequence + 1;
  await tx.insert(orderExceptions).values({ id: exceptionId, tenantId: context.tenantId, orderId, category: "logistics", code, message: "Shipment writeback requires operational reconciliation.", openedBy: context.userId });
  await tx.insert(orderExceptionEvents).values({ id: createEntityId(), tenantId: context.tenantId, orderId, exceptionId, sequence: 1, status: "open", idempotencyKey, actorUserId: context.userId });
  await tx.insert(orderEvents).values({ id: createEntityId(), tenantId: context.tenantId, orderId, sequence, type: "exception_opened", code, message: "Shipment writeback requires operational reconciliation.", metadata: { exceptionId, category: "logistics" }, idempotencyKey, actorUserId: context.userId });
  await tx.update(orders).set({ latestEventSequence: sequence, updatedAt: new Date() }).where(eq(orders.id, orderId));
}

async function appendWritebackEvent(tx: TenantTransaction, context: TenantContext, request: typeof shipmentWritebackRequests.$inferSelect, action: string, toStatus: string, providerCode: string | null, externalReference: string | null) {
  const [latest] = await tx.select({ sequence: shipmentWritebackEvents.sequence }).from(shipmentWritebackEvents).where(eq(shipmentWritebackEvents.requestId, request.id)).orderBy(desc(shipmentWritebackEvents.sequence)).limit(1);
  await tx.insert(shipmentWritebackEvents).values({ id: createEntityId(), tenantId: context.tenantId, requestId: request.id, sequence: (latest?.sequence ?? 0) + 1, action, fromStatus: request.status, toStatus, providerCode, externalReference, actorUserId: context.userId, occurredAt: new Date() });
}

async function lock(tx: TenantTransaction, key: string) { await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`); }
