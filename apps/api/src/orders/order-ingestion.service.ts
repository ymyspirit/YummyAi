import { ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import {
  CompleteOrderIngestionRunInputSchema, OrderIngestionRunViewSchema, createEntityId,
  type CompleteOrderIngestionRunInput, type MarketplacePlatform, type OrderIngestionRunView, type TenantContext,
} from "@yummyai/contracts";
import {
  marketplaceAccounts, orderConnectorCheckpoints, orderIngestionRisks, orderIngestionRuns, orders,
  type DatabaseConnection, withTenant,
} from "@yummyai/database";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION } from "../platform.tokens.js";

interface StartOrderIngestionRunInput {
  accountId: string;
  platform: MarketplacePlatform;
  stream: string;
  sourceVersion: string;
}

const diagnosticMessages = {
  duplicate_delivery: "Duplicate provider delivery was ignored",
  address_gap: "Protected shipping address is incomplete or unavailable",
  customization_missing: "Required customization data is unavailable",
  unsupported_mapping: "Order line could not be linked to an approved local listing or active SKU",
  cancellation_requested: "Provider reports a cancellation request or cancelled state",
  stale_provider_data: "Provider order data is older than the configured freshness threshold",
} as const;

@Injectable()
export class OrderIngestionService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async start(context: TenantContext, input: StartOrderIngestionRunInput): Promise<OrderIngestionRunView> {
    const stream = input.stream.trim();
    const sourceVersion = input.sourceVersion.trim();
    if (!stream || stream.length > 160 || !sourceVersion || sourceVersion.length > 200) throw new UnprocessableEntityException("Order ingestion stream or source version is invalid");
    const runId = createEntityId();
    await withTenant(this.database.db, context, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:${input.accountId}:${input.platform}:${stream}`}, 0))`);
      const [account] = await tx.select().from(marketplaceAccounts).where(eq(marketplaceAccounts.id, input.accountId)).limit(1);
      if (!account || account.platform !== input.platform) throw new UnprocessableEntityException("Marketplace account does not match the ingestion stream");
      await tx.insert(orderConnectorCheckpoints).values({
        id: createEntityId(), tenantId: context.tenantId, accountId: input.accountId, platform: input.platform, stream,
      }).onConflictDoNothing();
      const [checkpoint] = await tx.select().from(orderConnectorCheckpoints).where(and(
        eq(orderConnectorCheckpoints.accountId, input.accountId), eq(orderConnectorCheckpoints.platform, input.platform), eq(orderConnectorCheckpoints.stream, stream),
      )).limit(1);
      if (!checkpoint) throw new ConflictException("Order checkpoint could not be initialized");
      const [active] = await tx.select().from(orderIngestionRuns).where(and(
        eq(orderIngestionRuns.accountId, input.accountId), eq(orderIngestionRuns.platform, input.platform), eq(orderIngestionRuns.stream, stream), eq(orderIngestionRuns.status, "running"),
      )).limit(1);
      if (active) throw new ConflictException("An order ingestion run is already active");
      await tx.insert(orderIngestionRuns).values({
        id: runId, tenantId: context.tenantId, accountId: input.accountId, platform: input.platform, stream,
        sourceVersion, checkpointVersionStart: checkpoint.version,
      });
    });
    await this.audit.record(context, { action: "order.ingestion.start", resourceType: "order_ingestion_run", resourceId: runId, result: "success", metadata: { accountId: input.accountId, platform: input.platform, stream } });
    return this.requireRun(context, runId);
  }

  async complete(context: TenantContext, runId: string, rawInput: CompleteOrderIngestionRunInput): Promise<OrderIngestionRunView> {
    const input = CompleteOrderIngestionRunInputSchema.parse(rawInput);
    if (input.status === "completed" && input.nextCursor !== null) throw new UnprocessableEntityException("Completed ingestion cannot retain a page cursor");
    if (input.status === "partial" && input.nextCursor === null) throw new UnprocessableEntityException("Partial ingestion requires a continuation cursor");
    await withTenant(this.database.db, context, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:${runId}`}, 0))`);
      const [run] = await tx.select().from(orderIngestionRuns).where(eq(orderIngestionRuns.id, runId)).limit(1);
      if (!run) throw new NotFoundException("Order ingestion run not found");
      if (run.status !== "running") throw new ConflictException("Order ingestion run is already finalized");
      const [checkpoint] = await tx.select().from(orderConnectorCheckpoints).where(and(
        eq(orderConnectorCheckpoints.accountId, run.accountId), eq(orderConnectorCheckpoints.platform, run.platform), eq(orderConnectorCheckpoints.stream, run.stream),
      )).limit(1);
      if (!checkpoint || checkpoint.version !== run.checkpointVersionStart) throw new ConflictException("Order checkpoint changed during ingestion");
      const highWaterAt = new Date(input.highWaterAt);
      if (checkpoint.highWaterAt && highWaterAt < checkpoint.highWaterAt) throw new ConflictException("Order checkpoint cannot move backwards");
      const checkpointVersionEnd = checkpoint.version + 1;
      const advanced = await tx.update(orderConnectorCheckpoints).set({
        cursor: input.nextCursor,
        highWaterAt: input.status === "completed" ? highWaterAt : checkpoint.highWaterAt,
        version: checkpointVersionEnd,
        updatedAt: new Date(),
      }).where(and(eq(orderConnectorCheckpoints.id, checkpoint.id), eq(orderConnectorCheckpoints.version, checkpoint.version)))
        .returning({ version: orderConnectorCheckpoints.version });
      if (advanced.length !== 1) throw new ConflictException("Order checkpoint changed during ingestion");
      const externalOrderIds = [...new Set(input.risks.map((risk) => risk.externalOrderId))];
      const orderRows = externalOrderIds.length === 0 ? [] : await tx.select({ id: orders.id, externalOrderId: orders.externalOrderId }).from(orders).where(and(
        eq(orders.accountId, run.accountId), eq(orders.platform, run.platform), inArray(orders.externalOrderId, externalOrderIds),
      ));
      const orderIds = new Map(orderRows.map((row) => [row.externalOrderId, row.id]));
      if (input.risks.length > 0) await tx.insert(orderIngestionRisks).values(input.risks.map((risk) => ({
        id: createEntityId(), tenantId: context.tenantId, ingestionRunId: runId, orderId: orderIds.get(risk.externalOrderId) ?? null,
        code: risk.code, severity: risk.severity, externalOrderId: risk.externalOrderId, externalLineId: risk.externalLineId,
        message: diagnosticMessages[risk.code],
      })));
      await tx.update(orderIngestionRuns).set({
        status: input.status, collectedCount: input.collectedCount, reportedCount: input.reportedCount,
        duplicateCount: input.duplicateCount, riskCount: input.risks.length, sourceVersion: input.sourceVersion,
        checkpointVersionEnd, highWaterAt: input.status === "completed" ? highWaterAt : checkpoint.highWaterAt,
        completedAt: new Date(),
      }).where(eq(orderIngestionRuns.id, runId));
    });
    await this.audit.record(context, { action: "order.ingestion.complete", resourceType: "order_ingestion_run", resourceId: runId, result: "success", metadata: { collectedCount: input.collectedCount, reportedCount: input.reportedCount, duplicateCount: input.duplicateCount, riskCount: input.risks.length, status: input.status } });
    return this.requireRun(context, runId);
  }

  async list(context: TenantContext, limit = 20): Promise<OrderIngestionRunView[]> {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
    const runs = await withTenant(this.database.db, context, (tx) => tx.select().from(orderIngestionRuns).orderBy(desc(orderIngestionRuns.startedAt)).limit(safeLimit));
    if (runs.length === 0) return [];
    const risks = await withTenant(this.database.db, context, (tx) => tx.select().from(orderIngestionRisks).where(inArray(orderIngestionRisks.ingestionRunId, runs.map((run) => run.id))).orderBy(desc(orderIngestionRisks.createdAt)));
    return runs.map((run) => toRunView(run, risks.filter((risk) => risk.ingestionRunId === run.id)));
  }

  async fail(context: TenantContext, runId: string, errorCode: string): Promise<OrderIngestionRunView> {
    const safeCode = errorCode.trim().toUpperCase();
    if (!/^[A-Z0-9_]{3,80}$/.test(safeCode)) throw new UnprocessableEntityException("Order ingestion error code is invalid");
    await withTenant(this.database.db, context, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:${runId}`}, 0))`);
      const [run] = await tx.select().from(orderIngestionRuns).where(eq(orderIngestionRuns.id, runId)).limit(1);
      if (!run) throw new NotFoundException("Order ingestion run not found");
      if (run.status !== "running") throw new ConflictException("Order ingestion run is already finalized");
      await tx.update(orderIngestionRuns).set({ status: "failed", errorCode: safeCode, completedAt: new Date() }).where(eq(orderIngestionRuns.id, runId));
    });
    await this.audit.record(context, { action: "order.ingestion.fail", resourceType: "order_ingestion_run", resourceId: runId, result: "failure", metadata: { errorCode: safeCode } });
    return this.requireRun(context, runId);
  }

  private async requireRun(context: TenantContext, runId: string): Promise<OrderIngestionRunView> {
    const runs = await withTenant(this.database.db, context, (tx) => tx.select().from(orderIngestionRuns).where(eq(orderIngestionRuns.id, runId)).limit(1));
    if (!runs[0]) throw new NotFoundException("Order ingestion run not found");
    const risks = await withTenant(this.database.db, context, (tx) => tx.select().from(orderIngestionRisks).where(eq(orderIngestionRisks.ingestionRunId, runId)).orderBy(desc(orderIngestionRisks.createdAt)));
    return toRunView(runs[0], risks);
  }
}

function toRunView(run: typeof orderIngestionRuns.$inferSelect, risks: Array<typeof orderIngestionRisks.$inferSelect>): OrderIngestionRunView {
  return OrderIngestionRunViewSchema.parse({
    id: run.id, accountId: run.accountId, platform: run.platform, stream: run.stream, status: run.status,
    collectedCount: run.collectedCount, reportedCount: run.reportedCount, duplicateCount: run.duplicateCount, riskCount: run.riskCount,
    sourceVersion: run.sourceVersion, checkpointVersionStart: run.checkpointVersionStart, checkpointVersionEnd: run.checkpointVersionEnd,
    highWaterAt: run.highWaterAt?.toISOString() ?? null, errorCode: run.errorCode, startedAt: run.startedAt.toISOString(), completedAt: run.completedAt?.toISOString() ?? null,
    risks: risks.map((risk) => ({
      id: risk.id, ingestionRunId: risk.ingestionRunId, orderId: risk.orderId, code: risk.code, severity: risk.severity,
      externalOrderId: risk.externalOrderId, externalLineId: risk.externalLineId, message: risk.message, createdAt: risk.createdAt.toISOString(),
    })),
  });
}
