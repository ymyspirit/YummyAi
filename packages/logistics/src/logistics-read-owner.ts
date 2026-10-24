import { Permission, requireTenantOrderPermissions } from "@yummyai/authz";
import type { SecretVault } from "@yummyai/ai-core";
import type { TenantContext } from "@yummyai/contracts";
import { OriginalOwnerError } from "@yummyai/contracts/common/original-owner-error";
import { LogisticsTaskSnapshotSchema, type LogisticsTaskView } from "@yummyai/contracts/logistics";
import {
  fulfillmentFactories,
  logisticsConnectionVersions as versions,
  logisticsLabels as labels,
  logisticsQuotes as quotes,
  logisticsTaskProductions as pins,
  logisticsTasks as tasks,
  orders,
  withTenant,
  type DatabaseConnection,
  type TenantTransaction,
} from "@yummyai/database";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";

export const LogisticsReadQuerySchema = z.object({
  orderId: z.uuidv7().optional(),
  factoryId: z.uuidv7().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
}).strict();

export type LogisticsTaskEvidence = {
  taskId: string;
  orderId: string;
  factoryId: string;
  productionVersionIds: string[];
  connectionVersionId: string;
  ruleVersionId: string;
  snapshotChecksum: string;
  status: LogisticsTaskView["status"];
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  privateAvailable: boolean;
};

type Task = typeof tasks.$inferSelect;
const readOptions = { isolationLevel: "repeatable read", accessMode: "read only" } as const;

/** Original logistics task reads, without retention, dispatch, provider or storage operations. */
export class LogisticsReadOwner {
  constructor(private readonly database: DatabaseConnection, private readonly pii: SecretVault) {}

  async index(context: TenantContext, orderId: string): Promise<Array<{ id: string; orderId: string; updatedAt: string }>> {
    requireRead(context);
    return withTenant(this.database.db, context, async tx => {
      const rows = await tx.select({
        id: tasks.id, orderId: tasks.orderId,
        updatedAt: sql<string>`to_char(${tasks.updatedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      }).from(tasks).where(eq(tasks.orderId, orderId)).orderBy(asc(tasks.id)).limit(10_001);
      if (rows.length > 10_000) throw new OriginalOwnerError(409, {
        code: "logistics_read_index_limit", message: "物流任务数量超过读取上限 请缩小范围",
      });
      return rows;
    }, readOptions);
  }

  async workspace(context: TenantContext, raw: unknown = {}): Promise<{ tasks: LogisticsTaskView[] }> {
    requireRead(context);
    const query = LogisticsReadQuerySchema.parse(raw);
    const result = await withTenant(this.database.db, context, async tx => {
      const rows = await tx.select().from(tasks).where(and(
        query.orderId ? eq(tasks.orderId, query.orderId) : undefined,
        query.factoryId ? eq(tasks.factoryId, query.factoryId) : undefined,
      )).orderBy(desc(tasks.createdAt)).limit(query.limit);
      return Promise.all(rows.map(async row => ({ expiresAt: row.expiresAt, view: await this.view(tx, row) })));
    }, readOptions);
    // Another task's query and transaction completion cannot extend a private view's expiry.
    return { tasks: result.map(({ expiresAt, view }) => expiresAt > new Date() ? view : hidePrivateFields(view)) };
  }

  async get(context: TenantContext, id: string): Promise<LogisticsTaskView> {
    requireRead(context);
    const result = await withTenant(this.database.db, context, async tx => {
      const [row] = await tx.select().from(tasks).where(eq(tasks.id, id));
      if (!row) throw new OriginalOwnerError(404, "物流任务不存在");
      return { expiresAt: row.expiresAt, view: await this.view(tx, row) };
    }, readOptions);
    return result.expiresAt > new Date() ? result.view : hidePrivateFields(result.view);
  }

  async evidence(context: TenantContext, id: string): Promise<LogisticsTaskEvidence> {
    requireRead(context);
    const result = await withTenant(this.database.db, context, async tx => {
      const [row] = await tx.select().from(tasks).where(eq(tasks.id, id));
      if (!row) throw new OriginalOwnerError(404, "物流任务不存在");
      const [order] = await tx.select({ addressStatus: orders.addressStatus }).from(orders).where(eq(orders.id, row.orderId));
      const productionPins = await tx.select({ productionVersionId: pins.productionVersionId }).from(pins)
        .where(eq(pins.taskId, id)).orderBy(asc(pins.productionVersionId));
      return {
        taskId: row.id, orderId: row.orderId, factoryId: row.factoryId,
        productionVersionIds: productionPins.map(pin => pin.productionVersionId),
        connectionVersionId: row.connectionVersionId, ruleVersionId: row.ruleVersionId,
        snapshotChecksum: row.snapshotHash, status: row.status as LogisticsTaskView["status"],
        createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), expiresAt: row.expiresAt.toISOString(),
        privateAvailable: privateAvailable(row, order?.addressStatus),
      };
    }, readOptions);
    return { ...result, privateAvailable: result.privateAvailable && Date.parse(result.expiresAt) > Date.now() };
  }

  private async view(tx: TenantTransaction, row: Task): Promise<LogisticsTaskView> {
    const [order] = await tx.select().from(orders).where(eq(orders.id, row.orderId));
    const [factory] = await tx.select().from(fulfillmentFactories).where(eq(fulfillmentFactories.id, row.factoryId));
    const [connection] = await tx.select().from(versions).where(eq(versions.id, row.connectionVersionId));
    const history = await tx.select().from(quotes).where(eq(quotes.taskId, row.id)).orderBy(desc(quotes.createdAt)).limit(400);
    const files = await tx.select().from(labels).where(eq(labels.taskId, row.id));
    const retained = privateAvailable(row, order?.addressStatus);
    const snapshot = retained && row.encryptedSnapshot
      ? this.pii.withSecret(row.encryptedSnapshot, value => LogisticsTaskSnapshotSchema.parse(JSON.parse(value))) : null;
    return {
      id: row.id, orderId: row.orderId, factoryId: row.factoryId, externalReference: row.externalReference,
      status: row.status as LogisticsTaskView["status"], diagnostic: row.diagnostic, createdAt: row.createdAt.toISOString(),
      quotedCostMinor: row.selectedQuote?.totalMinor ?? null, actualCostMinor: row.actualCostMinor,
      currency: row.actualCurrency ?? row.selectedQuote?.currency ?? null,
      quotedCurrency: row.selectedQuote?.currency ?? null, actualCurrency: row.actualCurrency,
      minorUnitDigits: connection?.profile.minorUnitDigits ?? 2,
      trackingNumbers: retained ? row.trackingNumbers : [], labelMode: connection?.profile.labelMode ?? "include",
      labelCount: retained ? files.length : 0, quotes: history.map(entry => entry.quote),
      latestShipAt: snapshot?.latestShipAt ?? "", deliverBy: snapshot?.deliverBy ?? "",
      connectionName: connection?.profile.name ?? "连接不可用", factoryName: factory?.name ?? "工厂不可用",
      orderNumber: order?.externalOrderId ?? "订单不可用",
      labels: retained ? files.map(file => ({ id: file.id, fileName: file.fileName, checksum: file.checksum })) : [],
    };
  }
}

function requireRead(context: TenantContext) {
  requireTenantOrderPermissions(context, [Permission.OrderRead, Permission.OrderPiiRead]);
}

function privateAvailable(row: Task, addressStatus: string | undefined) {
  return Boolean(row.encryptedSnapshot) && row.expiresAt > new Date() && addressStatus === "protected";
}

function hidePrivateFields(view: LogisticsTaskView): LogisticsTaskView {
  return { ...view, trackingNumbers: [], labelCount: 0, labels: [], latestShipAt: "", deliverBy: "" };
}
