import { randomUUID } from "node:crypto";
import { ConflictException, HttpException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import type { SecretVault } from "@yummyai/ai-core";
import { ForbiddenError, intersectPermissionContexts, Permission, requireTenantOrderPermissions } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { AgentCommandBindingSchema, type AgentCommandBinding, type AgentCommandOwnerReference } from "@yummyai/contracts/ai/agent-command";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { normalizeProductionCommand, ProductionCommandListSchema, ProductionCommandQuerySchema, ProductionCommandViewSchema,
  ProductionCommandKindSchema, type PrepareProductionCommand, type ProductionCommandSummary, type ProductionCommandView } from "@yummyai/contracts/order/production-command";
import { orders, orderLines, orderProtectedDetails, orderWorkItems, productionCommandIntents, productionCommandAttempts,
  withTenant, type DatabaseConnection, type TenantTransaction } from "@yummyai/database";
import { currentOrderAuthority } from "@yummyai/order-core";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { DATABASE_CONNECTION, ORDER_PII_VAULT } from "../platform.tokens.js";
import { OrderProductionService } from "./order-production.service.js";
import { lockProductionCommand, productionCommandDescriptor, productionCommandReceipt, ProductionCommandFenceError,
  type ProductionCommandDescriptor, type ProductionCommandFence } from "./production-command-fence.js";

type Intent = typeof productionCommandIntents.$inferSelect;
const readPermissions = [Permission.OrderRead, Permission.OrderPiiRead];
const writePermissions = [...readPermissions, Permission.OrderWrite];
const unfinished = ["prepared", "executing", "uncertain"] as const;
const isUnfinished = (row: Intent) => (unfinished as readonly string[]).includes(row.status);
const leaseMs = 120_000, retentionMs = 7 * 86_400_000;

@Injectable()
export class ProductionCommandService {
  constructor(@Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(ORDER_PII_VAULT) private readonly vault: SecretVault,
    @Inject(OrderProductionService) private readonly production: OrderProductionService) {}

  locateForAgent(context: TenantContext, raw: AgentCommandBinding): Promise<AgentCommandOwnerReference | null> {
    const binding = AgentCommandBindingSchema.parse(raw);
    if (binding.domain !== "production" || binding.accountId !== null || binding.targetId === null)
      throw new UnprocessableEntityException("生产原命令定位范围不正确");
    const kind = ProductionCommandKindSchema.parse(binding.kind), targetId = binding.targetId;
    return withTenant(this.database.db, context, async tx => {
      const current = await currentOrderAuthority(tx, context, readPermissions, { requireMembership: true });
      const [row] = await tx.select({ id: productionCommandIntents.id }).from(productionCommandIntents).where(and(
        eq(productionCommandIntents.tenantId, current.tenantId), eq(productionCommandIntents.createdBy, current.userId),
        eq(productionCommandIntents.kind, kind), eq(productionCommandIntents.targetId, targetId),
        eq(productionCommandIntents.requestChecksum, binding.ownerRequestChecksum),
        sql`encode(sha256(convert_to(${productionCommandIntents.requestKey},'UTF8')),'hex')=${binding.requestKeyHash}`,
      )).limit(1);
      return row ? { domain: "production", commandId: row.id, accountId: null } : null;
    });
  }

  /** The exact retained original is disclosed only behind the existing source, ceiling and privacy gates. */
  originalForAgent(context: TenantContext, rawId: string): Promise<PrepareProductionCommand | null> {
    const id = EntityIdSchema.parse(rawId).toLowerCase();
    return withTenant(this.database.db, context, async tx => {
      const { row, source } = await this.lockOwned(tx, context, id, false), now = await this.now(tx);
      if (!source.available || !row.encryptedInput || row.expiresAt <= now) return null;
      return this.envelope(context, row).command;
    });
  }

  async prepare(context: TenantContext, raw: unknown) {
    const command = normalizeProductionCommand(raw), descriptor = productionCommandDescriptor(command);
    const id = await withTenant(this.database.db, context, async tx => {
      const authority = await currentOrderAuthority(tx, context, writePermissions, { requireMembership: true });
      await lockProductionCommand(tx, descriptor);
      const previous = await tx.select().from(productionCommandIntents).where(and(eq(productionCommandIntents.kind, descriptor.kind),
        eq(productionCommandIntents.targetId, descriptor.targetId), eq(productionCommandIntents.requestKey, descriptor.requestKey)));
      if (previous.length) {
        const row = previous[0]!;
        if (previous.length !== 1 || row.createdBy !== context.userId || row.requestChecksum !== descriptor.requestChecksum) {
          throw new ConflictException("同一次生产提交的操作员和原始内容不能改变");
        }
        await this.authority(tx, context, row, true);
        return row.id;
      }
      const [line] = command.kind === "reviewed_line" ? await tx.select().from(orderLines).where(eq(orderLines.id, command.targetId)) : [];
      const orderId = command.kind === "reviewed_line" ? line?.orderId : command.targetId;
      if (!orderId) throw new NotFoundException("订单商品不存在或无权访问");
      // Sorted per-line admission locks serialize single-item and whole-order preparations.
      for (const lineId of [...descriptor.lineIds].sort()) await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`production-command-admission:${lineId}`},0))`);
      const blockers = await tx.select({ lineIds: productionCommandIntents.lineIds }).from(productionCommandIntents)
        .where(and(eq(productionCommandIntents.orderId, orderId), inArray(productionCommandIntents.status, [...unfinished])));
      if (blockers.some(row => row.lineIds.some(lineId => descriptor.lineIds.includes(lineId)))) {
        throw new ConflictException("该商品仍有待确认的生产提交 请先查看原提交结果");
      }
      const source = await this.source(tx, { kind: command.kind, orderId, lineIds: descriptor.lineIds }, true);
      if (!source.available) throw new ConflictException("订单制作资料已到期或不可用");
      const receipt = await productionCommandReceipt(tx, context, orderId, descriptor);
      if (!receipt && (command.kind === "reviewed_order"
        ? command.input.items.some(item => !item.capacityPlan)
        : !command.input.capacityPlan)) throw new UnprocessableEntityException("新生产提交须为每个商品选择已确认的工厂产能预约");
      const now = await this.now(tx), expiresAt = new Date(Math.min(now.getTime() + retentionMs, source.deadline));
      const intentId = createEntityId();
      const summary: ProductionCommandSummary = {
        orderNumber: source.order!.externalOrderId, lineCount: descriptor.lineIds.length,
        quantity: command.kind === "reviewed_line" ? command.input.quantity : source.lines.reduce((total, item) => total + item.quantity, 0),
        factoryName: await this.production.commandFactoryLabel(tx, authority, { factoryId: command.input.factoryId, factoryVersionId: command.input.factoryVersionId,
          capabilityVersionId: command.kind === "reviewed_order" ? command.input.items[0]!.capabilityVersionId : command.input.capabilityVersionId }),
        expectedCompletionAt: command.input.expectedCompletionAt, instructions: command.input.instructions,
      };
      await tx.insert(productionCommandIntents).values({ id: intentId, tenantId: context.tenantId, createdBy: context.userId,
        orderId, kind: command.kind, targetId: descriptor.targetId, lineIds: descriptor.lineIds,
        requestKey: descriptor.requestKey, requestChecksum: descriptor.requestChecksum, ownerChecksum: descriptor.ownerChecksum,
        authoritySnapshot: authority, admissionKind: receipt ? "existing_receipt" : "new_request", encryptedInput: this.vault.encrypt(JSON.stringify({
          tenantId: context.tenantId, userId: context.userId, intentId, command, summary,
        })), createdAt: now, expiresAt, status: receipt ? "succeeded" : "prepared",
        resultIds: receipt?.productionOrderIds ?? null, completedAt: receipt ? now : null });
      return intentId;
    });
    return this.get(context, id);
  }

  async list(context: TenantContext, raw: unknown) {
    const query = ProductionCommandQuerySchema.parse(raw);
    const ids = await withTenant(this.database.db, context, async tx => {
      await currentOrderAuthority(tx, context, readPermissions, { requireMembership: true });
      return tx.select({ id: productionCommandIntents.id }).from(productionCommandIntents).where(and(
        eq(productionCommandIntents.createdBy, context.userId), eq(productionCommandIntents.orderId, query.orderId),
        isNull(productionCommandIntents.acknowledgedAt), query.lineId ? sql`${productionCommandIntents.lineIds} ? ${query.lineId}` : undefined,
      )).orderBy(desc(productionCommandIntents.createdAt), desc(productionCommandIntents.id)).limit(101);
    });
    const items = [];
    for (const row of ids.slice(0, 100)) items.push(await this.get(context, row.id));
    return ProductionCommandListSchema.parse({ items, truncated: ids.length > 100 });
  }

  async get(context: TenantContext, id: string): Promise<ProductionCommandView> {
    // Invalidate an unavailable payload before checking the owner's receipt. Never
    // hold the journal row while taking a business lock in the opposite order.
    await withTenant(this.database.db, context, async tx => {
      const { row, source } = await this.lockOwned(tx, context, id, false), now = await this.now(tx);
      if (row.encryptedInput && (!source.available || row.expiresAt <= now)) await tx.update(productionCommandIntents).set({
        encryptedInput: null, redactedAt: now, leaseToken: null, leaseExpiresAt: null,
        status: isUnfinished(row) ? "uncertain" : row.status,
      }).where(eq(productionCommandIntents.id, id));
    });
    await this.reconcile(context, id);
    return withTenant(this.database.db, context, async tx => {
      const { row, source, authority } = await this.lockOwned(tx, context, id, false), now = await this.now(tx);
      const summary = source.available && row.encryptedInput && row.expiresAt > now ? this.envelope(context, row).summary : null;
      let canWrite = true;
      try { requireTenantOrderPermissions(authority, writePermissions); } catch { canWrite = false; }
      return ProductionCommandViewSchema.parse({ id: row.id, kind: row.kind, orderId: row.orderId, lineIds: row.lineIds,
        status: row.status, createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString(),
        leaseExpiresAt: row.leaseExpiresAt?.toISOString() ?? null, acknowledged: Boolean(row.acknowledgedAt),
        canExecute: canWrite && Boolean(summary) && isUnfinished(row) && (!row.leaseExpiresAt || row.leaseExpiresAt <= now),
        canCancel: row.status === "prepared" && row.generation === 0,
        summary, receipt: row.resultIds ? { productionOrderIds: row.resultIds } : null, errorCode: row.errorCode });
    });
  }

  async execute(context: TenantContext, id: string) {
    // Read-only owner reconciliation is allowed here; a new write always requires
    // an explicit execute request and a fresh claim.
    await this.get(context, id);
    const claim = await withTenant(this.database.db, context, async tx => {
      const { row, source, authority } = await this.lockOwned(tx, context, id, true), now = await this.now(tx);
      if (!isUnfinished(row) || !row.encryptedInput || row.expiresAt <= now || !source.available ||
        (row.leaseExpiresAt && row.leaseExpiresAt > now)) return null;
      const envelope = this.envelope(context, row), generation = row.generation + 1, leaseToken = randomUUID();
      await tx.update(productionCommandAttempts).set({ status: "superseded", errorCode: "superseded", finishedAt: now })
        .where(and(eq(productionCommandAttempts.intentId, id), eq(productionCommandAttempts.status, "executing")));
      await tx.update(productionCommandIntents).set({ status: "executing", generation, leaseToken,
        leaseExpiresAt: new Date(now.getTime() + leaseMs), errorCode: null }).where(eq(productionCommandIntents.id, id));
      await tx.insert(productionCommandAttempts).values({ id: createEntityId(), tenantId: context.tenantId, intentId: id,
        generation, leaseToken, startedAt: now });
      return { command: envelope.command, authority, generation, fence: { intentId: id, leaseToken } satisfies ProductionCommandFence };
    });
    if (!claim) return this.get(context, id);
    let failure: unknown;
    try {
      const command = claim.command;
      if (command.kind === "approved_design") await this.production.createReceipt(claim.authority, command.targetId, command.input, claim.fence);
      else if (command.kind === "reviewed_line") await this.production.releaseArtworkReceipt(claim.authority, command.targetId, command.input, claim.fence);
      else await this.production.releaseWholeOrderReceipt(claim.authority, command.targetId, command.input, claim.fence);
    } catch (error) { failure = error; }
    await this.finish(context, id, claim.generation, claim.fence.leaseToken, failure);
    return this.get(context, id);
  }

  async acknowledge(context: TenantContext, id: string) {
    await this.get(context, id);
    await withTenant(this.database.db, context, async tx => {
      const { row } = await this.lockOwned(tx, context, id, false);
      if (isUnfinished(row)) throw new ConflictException("结果仍待确认 请先恢复原提交");
      if (!row.acknowledgedAt) {
        const now = await this.now(tx);
        await tx.update(productionCommandIntents).set({ acknowledgedAt: now, encryptedInput: null,
          redactedAt: row.redactedAt ?? now }).where(eq(productionCommandIntents.id, id));
      }
    });
    return this.get(context, id);
  }

  async cancel(context: TenantContext, id: string) {
    await withTenant(this.database.db, context, async tx => {
      const { row } = await this.lockOwned(tx, context, id, false);
      if (row.status !== "prepared" || row.generation !== 0) throw new ConflictException("已执行的提交必须先确认结果");
      const now = await this.now(tx);
      await tx.update(productionCommandIntents).set({ status: "cancelled", acknowledgedAt: now, encryptedInput: null,
        redactedAt: now, completedAt: now }).where(eq(productionCommandIntents.id, id));
    });
    return this.get(context, id);
  }

  private async reconcile(context: TenantContext, id: string) {
    const row = await withTenant(this.database.db, context, async tx => {
      const found = await this.owned(tx, context, id); await this.authority(tx, context, found, false); return found;
    });
    if (!isUnfinished(row)) return;
    await this.finish(context, id);
  }

  private async finish(context: TenantContext, id: string, generation?: number, leaseToken?: string, failure?: unknown) {
    // Completion writes only technical metadata, even if business permissions
    // were revoked after commit. Every returned view rechecks current membership.
    await withTenant(this.database.db, context, async tx => {
      const before = await this.owned(tx, context, id), descriptor = this.descriptor(before);
      await lockProductionCommand(tx, descriptor);
      const receipt = await productionCommandReceipt(tx, context, before.orderId, descriptor);
      const row = await this.owned(tx, context, id, true), now = await this.now(tx);
      if (generation !== undefined && (row.generation !== generation || row.leaseToken !== leaseToken)) return;
      if (!isUnfinished(row)) return;
      const forbidden = failure instanceof ForbiddenError;
      const knownRejection = forbidden || failure instanceof HttpException && failure.getStatus() >= 400 && failure.getStatus() < 500 && !(failure instanceof ProductionCommandFenceError);
      const status = receipt ? "succeeded" : !row.encryptedInput ? "expired" : generation === undefined ? null : knownRejection ? "rejected" : "uncertain";
      if (!status) return;
      const errorCode = receipt ? null : status === "expired" ? "source_unavailable" : forbidden ? "forbidden" : knownRejection ? "conflict" : "unknown";
      await tx.update(productionCommandIntents).set({ status, resultIds: receipt?.productionOrderIds ?? null, errorCode,
        leaseToken: null, leaseExpiresAt: null, completedAt: status === "uncertain" ? null : now }).where(eq(productionCommandIntents.id, id));
      if (row.generation > 0) await tx.update(productionCommandAttempts).set({ status: status === "expired" ? "rejected" : status,
        resultIds: receipt?.productionOrderIds ?? null, errorCode, finishedAt: now }).where(and(
        eq(productionCommandAttempts.intentId, id), eq(productionCommandAttempts.generation, row.generation), eq(productionCommandAttempts.status, "executing")));
    });
  }

  private async authority(tx: TenantTransaction, input: TenantContext, row: Intent, write: boolean) {
    const required = write ? writePermissions : readPermissions;
    const current = await currentOrderAuthority(tx, input, required, { requireMembership: true });
    const ceiling = intersectPermissionContexts(row.authoritySnapshot, current);
    requireTenantOrderPermissions(ceiling, required); return ceiling;
  }
  /** Privacy writers lock the source before redacting intents. Use the same
   * order here; never wait for a source row while holding its intent row. */
  private async lockOwned(tx: TenantTransaction, context: TenantContext, id: string, write: boolean) {
    await currentOrderAuthority(tx, context, write ? writePermissions : readPermissions, { requireMembership: true });
    const before = await this.owned(tx, context, id), source = await this.source(tx, before, true);
    const row = await this.owned(tx, context, id, true), authority = await this.authority(tx, context, row, write);
    return { row, source, authority };
  }
  private async owned(tx: TenantTransaction, context: TenantContext, id: string, lock = false) {
    const query = tx.select().from(productionCommandIntents).where(and(eq(productionCommandIntents.id, id), eq(productionCommandIntents.createdBy, context.userId)));
    const [row] = await (lock ? query.for("update") : query);
    if (!row) throw new NotFoundException("生产提交不存在或无权访问"); return row;
  }
  private async now(tx: TenantTransaction) {
    const [record] = await tx.execute<{ now: Date }>(sql`select clock_timestamp() as now`); return new Date(record!.now);
  }
  private descriptor(row: Intent): ProductionCommandDescriptor {
    return { kind: row.kind, targetId: row.targetId, lineIds: row.lineIds, requestKey: row.requestKey,
      requestChecksum: row.requestChecksum, ownerChecksum: row.ownerChecksum,
      businessKey: row.kind === "reviewed_order" ? `whole-order:${row.requestKey}` : row.requestKey,
      lockKey: row.kind === "approved_design" ? `production-create-command:${row.targetId}:${row.requestKey}`
        : row.kind === "reviewed_line" ? `production-release-command:${row.targetId}:${row.requestKey}` : `whole-production-command:${row.requestKey}` };
  }
  private envelope(context: TenantContext, row: Intent) {
    if (!row.encryptedInput) throw new ConflictException("原提交正文已按保留规则清除");
    return this.vault.withSecret(row.encryptedInput, value => {
      const stored = JSON.parse(value) as { tenantId: string; userId: string; intentId: string; command: unknown; summary: ProductionCommandSummary };
      const command = normalizeProductionCommand(stored.command), descriptor = productionCommandDescriptor(command);
      if (stored.tenantId !== context.tenantId || stored.userId !== context.userId || stored.intentId !== row.id ||
        descriptor.kind !== row.kind || descriptor.targetId !== row.targetId || descriptor.requestKey !== row.requestKey ||
        descriptor.requestChecksum !== row.requestChecksum || descriptor.ownerChecksum !== row.ownerChecksum) throw new ConflictException("原生产提交校验失败");
      return { command, summary: stored.summary };
    });
  }
  private async source(tx: TenantTransaction, row: Pick<Intent, "kind" | "orderId" | "lineIds">, lock = false) {
    const orderQuery = tx.select().from(orders).where(eq(orders.id, row.orderId));
    const [order] = await (lock ? orderQuery.for("share") : orderQuery);
    const lines = await tx.select().from(orderLines).where(and(eq(orderLines.orderId, row.orderId), inArray(orderLines.id, row.lineIds)));
    const privacyQuery = tx.select().from(orderProtectedDetails).where(eq(orderProtectedDetails.orderId, row.orderId));
    const [privacy] = await (lock ? privacyQuery.for("share") : privacyQuery);
    const now = await this.now(tx);
    let available = Boolean(order && order.addressStatus !== "anonymized" && lines.length === row.lineIds.length &&
      ((!privacy && order.addressStatus === "missing") || (privacy?.status === "protected" && privacy.retentionExpiresAt > now)));
    let deadline = privacy?.retentionExpiresAt.getTime() ?? Number.POSITIVE_INFINITY;
    if (row.kind !== "approved_design") {
      const workQuery = tx.select().from(orderWorkItems).where(inArray(orderWorkItems.id, row.lineIds)).orderBy(orderWorkItems.id);
      const work = await (lock ? workQuery.for("share") : workQuery);
      available &&= work.length === row.lineIds.length && work.every(item => Boolean(item.encryptedDataKey && !item.archivedAt && item.expiresAt > now));
      for (const item of work) deadline = Math.min(deadline, item.expiresAt.getTime());
    }
    return { order, lines, available, deadline };
  }
}
