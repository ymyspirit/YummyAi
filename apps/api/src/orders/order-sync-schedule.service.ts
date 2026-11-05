import { createHash } from "node:crypto";
import { ConflictException, Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import { authorize, Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { SaveOrderSyncSettingsSchema, OrderSyncSettingsViewSchema, OrderSyncRequestSchema } from "@yummyai/contracts/order/sync";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { orderSyncSchedules as schedules, orderSyncDispatchTenants, orderConnectorCheckpoints, marketplaceAccounts,
  type DatabaseConnection, type TenantTransaction, withTenant } from "@yummyai/database";
import { planOrderSync } from "@yummyai/marketplace-connectors";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { databaseNow, lockMarketplaceAccount, type MarketplaceAccountRow } from "../marketplaces/marketplace-authority.js";
import { StoreNodeService } from "../marketplaces/store-node.service.js";
import { StoreNodeExecutionService } from "../marketplaces/store-node-execution.service.js";
import { OrderIngestionService } from "./order-ingestion.service.js";
import { AmazonOrderReportService } from "./amazon-order-report.service.js";

const required = [Permission.OrderRead, Permission.OrderWrite, Permission.OrderPiiRead, Permission.StoreRead] as const;
const stream = "automatic-orders";
function requireOrderAccess(context: TenantContext) { for (const permission of required) authorize(context, permission); }
function supported(account: MarketplaceAccountRow) { return account.platform === "amazon" && ["amazon_private", "amazon_public"].includes(account.authorizationMode); }

@Injectable()
export class OrderSyncScheduleService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private closing = false;
  private tenantCursor?: string;
  constructor(@Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(StoreNodeService) private readonly nodes: StoreNodeService,
    @Inject(StoreNodeExecutionService) private readonly execution: StoreNodeExecutionService,
    @Inject(OrderIngestionService) private readonly ingestion: OrderIngestionService,
    @Inject(AmazonOrderReportService) private readonly reports: AmazonOrderReportService) {}

  onApplicationBootstrap() {
    if (process.env.ORDER_SYNC_COORDINATOR === "off") return;
    this.timer = setInterval(() => { void this.pulse(); }, 15_000); this.timer.unref();
  }
  async onApplicationShutdown() { this.closing = true; clearInterval(this.timer); await this.running; }
  pulse() {
    if (this.closing) return Promise.resolve();
    if (!this.running) this.running = this.scan().catch(() => {
      process.stderr.write("Order sync dispatch unavailable; original requests retained\n");
    }).finally(() => { this.running = undefined; });
    return this.running;
  }
  async view(context: TenantContext, accountId: string) {
    return withTenant(this.database.db, context, async tx => {
      const { account, authority } = await lockMarketplaceAccount(tx, context, accountId, Permission.StoreRead);
      const [row] = await tx.select().from(schedules).where(eq(schedules.accountId, accountId));
      let canManage = true;
      try { authorize(authority, Permission.StoreManage, { ownerId: account.createdBy }); requireOrderAccess(authority); } catch { canManage = false; }
      let setupReason = !supported(account) ? "此店铺类型尚未接入定时拉单"
        : !["valid", "expiring"].includes(account.credentialStatus) || ["disabled", "revoked"].includes(account.status) || account.credentialRefreshState !== "known"
          ? "请先完成本店平台授权" : process.env.STORE_NODE_EXECUTION_ENABLED !== "1" || process.env.STORE_NODE_RUNTIME_ENABLED !== "1"
            ? "管理员尚未启用店铺节点服务" : null;
      if (!setupReason) try { await this.nodes.executionBinding(tx, account, false); } catch { setupReason = "请在本店设置中核对节点绑定与授权"; }
      return OrderSyncSettingsViewSchema.parse({ accountId, version: row?.version ?? 0, enabled: row?.enabled ?? false, canManage, supported: supported(account),
        canEnable: canManage && !setupReason, reason: row?.errorCode ? reason(row.errorCode) : setupReason,
        nextRunAt: row?.enabled ? row.nextRunAt.toISOString() : null, lastRunId: row?.lastRunId ?? null,
        activeExecutionId: row?.activeExecutionId ?? null, updatedAt: row?.updatedAt.toISOString() ?? null });
    });
  }
  async save(context: TenantContext, accountId: string, raw: unknown) {
    const input = SaveOrderSyncSettingsSchema.parse(raw), requestHash = createHash("sha256").update(canonicalJson(input)).digest("hex");
    await withTenant(this.database.db, context, async tx => {
      const { account, authority } = await lockMarketplaceAccount(tx, context, accountId, Permission.StoreManage); requireOrderAccess(authority);
      const [previous] = await tx.select().from(schedules).where(eq(schedules.accountId, accountId)).for("update");
      if (previous?.requestKey === input.requestKey) {
        if (previous.requestHash !== requestHash) throw new ConflictException("原设置请求已变化 请重新读取");
        return;
      }
      if ((previous?.version ?? 0) !== input.expectedVersion) throw new ConflictException("拉单设置已变化 请重新读取");
      if (input.enabled) {
        if (!supported(account)) throw new ConflictException("此店铺类型尚未接入定时拉单");
        if (process.env.STORE_NODE_EXECUTION_ENABLED !== "1" || process.env.STORE_NODE_RUNTIME_ENABLED !== "1") throw new ConflictException("请先启用已有店铺节点运行服务");
        if (!["valid", "expiring"].includes(account.credentialStatus) || ["disabled", "revoked"].includes(account.status) || account.credentialRefreshState !== "known")
          throw new ConflictException("请先完成此店铺的平台授权并核对凭据状态");
        await this.nodes.executionBinding(tx, account, false);
      }
      if (previous?.activeExecutionId) await this.execution.reconcileOrderSyncInTransaction(tx, accountId, previous.activeExecutionId, true);
      const now = await databaseNow(tx), version = (previous?.version ?? 0) + 1;
      const values = { version, enabled: input.enabled, requestedBy: authority.userId, authority, authorizationGeneration: account.authorizationGeneration,
        requestKey: input.requestKey, requestHash, errorCode: null, failureCount: 0, activeExecutionId: null, nextRunAt: now, updatedAt: now };
      if (previous) await tx.update(schedules).set(values).where(eq(schedules.id, previous.id));
      else await tx.insert(schedules).values({ id: createEntityId(), tenantId: context.tenantId, accountId, ...values });
      await tx.insert(orderSyncDispatchTenants).values({ tenantId: context.tenantId }).onConflictDoNothing();
      await this.audit.recordInTransaction(tx, authority, { action: "order.sync.configure", resourceType: "marketplace_account", resourceId: accountId,
        result: "success", metadata: { enabled: input.enabled, version, requestKey: input.requestKey } });
    });
    void this.pulse();
    return this.view(context, accountId);
  }

  private async scan() {
    const tenants = await this.database.db.transaction(async tx => {
      await tx.execute(sql.raw("set local role yummyai_app"));
      return tx.select().from(orderSyncDispatchTenants).where(this.tenantCursor ? gt(orderSyncDispatchTenants.tenantId, this.tenantCursor) : undefined)
        .orderBy(asc(orderSyncDispatchTenants.tenantId)).limit(50);
    });
    if (!tenants.length) { this.tenantCursor = undefined; return; }
    for (const tenant of tenants) {
      if (this.closing) return;
      const scope: TenantContext = { tenantId: tenant.tenantId, userId: tenant.tenantId, permissions: [], dataScope: "tenant" };
      await this.reports.dispatchApiSources(scope);
      const due = await withTenant(this.database.db, scope, tx => tx.select({ id: schedules.id }).from(schedules)
        .where(and(eq(schedules.enabled, true), sql`${schedules.nextRunAt}<=clock_timestamp()`)).orderBy(asc(schedules.nextRunAt)).limit(10));
      for (const row of due) await this.advance(scope, row.id);
    }
    this.tenantCursor = tenants.at(-1)!.tenantId;
  }

  async advance(scope: TenantContext, scheduleId: string) {
    let version: number | undefined;
    try {
      await withTenant(this.database.db, scope, async tx => {
        const [initial] = await tx.select().from(schedules).where(eq(schedules.id, scheduleId));
        if (!initial?.enabled) return; version = initial.version;
        const { account, authority } = await lockMarketplaceAccount(tx, initial.authority, initial.accountId, Permission.StoreManage); requireOrderAccess(authority);
        const [schedule] = await tx.select().from(schedules).where(eq(schedules.id, scheduleId)).for("update"), now = await databaseNow(tx);
        if (!schedule?.enabled || schedule.version !== initial.version || schedule.nextRunAt > now) return;
        if (schedule.authorizationGeneration !== account.authorizationGeneration) throw new ConflictException("order_sync_authority_changed");
        if (schedule.activeExecutionId) { await this.execution.reconcileOrderSyncInTransaction(tx, account.id, schedule.activeExecutionId); return; }
        const request = schedule.request ? OrderSyncRequestSchema.parse(schedule.request) : await this.plan(tx, account.id, now);
        const runId = await this.ingestion.startInTransaction(tx, authority, { accountId: account.id, platform: "amazon", stream, sourceVersion: "amazon-orders-2026-01-01" });
        const execution = await this.execution.createOrderSyncInTransaction(tx, authority, account.id, { runId, request });
        await tx.update(schedules).set({ request, activeExecutionId: execution.id, lastRunId: runId,
          nextRunAt: new Date(now.getTime() + 5 * 60_000), updatedAt: now }).where(eq(schedules.id, schedule.id));
      });
    } catch (error) {
      if (!(error instanceof Error) || !["ConflictException", "ForbiddenException", "ForbiddenError", "UnauthorizedException", "NotFoundException", "ServiceUnavailableException"].includes(error.constructor.name)) throw error;
      await withTenant(this.database.db, scope, async tx => {
        const [initial] = await tx.select().from(schedules).where(eq(schedules.id, scheduleId));
        if (!initial || initial.version !== version) return;
        // Cancellation needs no provider I/O or new authority; keep the shared account lock order.
        await tx.select({ id: marketplaceAccounts.id }).from(marketplaceAccounts).where(eq(marketplaceAccounts.id, initial.accountId)).for("update");
        const [current] = await tx.select().from(schedules).where(eq(schedules.id, scheduleId)).for("update");
        if (!current || current.version !== version) return;
        if (current.activeExecutionId) await this.execution.reconcileOrderSyncInTransaction(tx, current.accountId, current.activeExecutionId, true);
        await tx.update(schedules).set({ enabled: false, errorCode: "order_sync_configuration_changed", updatedAt: await databaseNow(tx) }).where(eq(schedules.id, scheduleId));
      });
    }
  }
  private async plan(tx: TenantTransaction, accountId: string, now: Date) {
    const [checkpoint] = await tx.select().from(orderConnectorCheckpoints).where(and(eq(orderConnectorCheckpoints.accountId, accountId),
      eq(orderConnectorCheckpoints.platform, "amazon"), eq(orderConnectorCheckpoints.stream, stream)));
    const upper = new Date(now.getTime() - 2 * 60_000 - 30_000);
    if (checkpoint?.cursor || checkpoint?.highWaterAt && upper.getTime() - checkpoint.highWaterAt.getTime() > 30 * 86400_000)
      throw new ConflictException("order_sync_checkpoint_requires_review");
    return planOrderSync({ checkpoint: { cursor: null, highWaterAt: checkpoint?.highWaterAt?.toISOString() ?? null, version: checkpoint?.version ?? 1 },
      now: upper, requestedBackfillDays: checkpoint?.highWaterAt ? 30 : 7, pageSize: 50, maxPages: 1 });
  }
}

function reason(code: string) {
  if (code === "store_node_upstream_rate_limited" || code === "store_node_upstream_retryable" || code === "store_node_execution_expired")
    return "店铺读取暂未完成 已保留原分页请求 重试达到上限后暂停";
  if (code === "store_node_operation_unknown") return "原节点读取结果未收到 已保留请求等待安全恢复";
  if (code === "order_sync_result_invalid" || code === "store_node_policy_rejected") return "店铺返回结果与原查询不一致 请核对原同步记录";
  return "本次订单读取已暂停 请核对店铺授权、节点和原同步记录后重新启用";
}
