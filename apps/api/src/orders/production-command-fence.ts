import { createHash } from "node:crypto";
import { ConflictException } from "@nestjs/common";
import type { PrepareProductionCommand, ProductionCommandReceipt } from "@yummyai/contracts/order/production-command";
import type { TenantContext } from "@yummyai/contracts";
import { orderWorkEvents, productionCommandIntents, productionOrders, type TenantTransaction } from "@yummyai/database";
import { and, eq, inArray, sql } from "drizzle-orm";

export type ProductionCommandFence = { intentId: string; leaseToken: string };
export const productionCommandChecksum = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Match the existing business owner's exact idempotency scope and checksum. */
export function productionCommandDescriptor(command: PrepareProductionCommand) {
  const { kind, input } = command;
  const targetId = kind === "approved_design" ? input.orderLineId : command.targetId;
  const lineIds = kind === "reviewed_order" ? input.items.map(item => item.lineId) : [targetId];
  const businessKey = kind === "reviewed_order" ? `whole-order:${input.idempotencyKey}` : input.idempotencyKey;
  const lockKey = kind === "approved_design" ? `production-create-command:${targetId}:${input.idempotencyKey}`
    : kind === "reviewed_line" ? `production-release-command:${targetId}:${input.idempotencyKey}` : `whole-production-command:${input.idempotencyKey}`;
  return { kind, targetId, lineIds, businessKey, lockKey, requestKey: input.idempotencyKey,
    requestChecksum: productionCommandChecksum(command),
    ownerChecksum: productionCommandChecksum(kind === "reviewed_line" ? input : { orderId: command.targetId, input }) };
}
export type ProductionCommandDescriptor = ReturnType<typeof productionCommandDescriptor>;

export async function lockProductionCommand(tx: TenantTransaction, descriptor: ProductionCommandDescriptor) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${descriptor.lockKey},0))`);
}

export class ProductionCommandFenceError extends ConflictException {
  constructor() { super("本次执行已失效 请从原生产提交记录恢复"); }
}

/** Called after the business locks, before any business write. SHARE remains
 * held until commit, so a replacement claim cannot overtake an admitted writer. */
export async function assertProductionCommandFence(tx: TenantTransaction, context: TenantContext,
  descriptor: ProductionCommandDescriptor, fence?: ProductionCommandFence) {
  const rows = await tx.select().from(productionCommandIntents).where(and(
    eq(productionCommandIntents.kind, descriptor.kind), eq(productionCommandIntents.targetId, descriptor.targetId),
    eq(productionCommandIntents.requestKey, descriptor.requestKey))).for("share");
  if (!rows.length && !fence) return; // Existing, unmanaged API callers retain their contract.
  const [now] = await tx.execute<{ now: Date }>(sql`select clock_timestamp() as now`);
  const intent = rows.find(row => row.id === fence?.intentId);
  const [source] = intent ? await tx.execute<{ available: boolean }>(sql`select production_command_source_available(c) as available from production_command_intents c where c.id=${intent.id}::uuid`) : [];
  if (!intent || !fence || intent.createdBy !== context.userId || intent.tenantId !== context.tenantId ||
    intent.requestChecksum !== descriptor.requestChecksum || intent.ownerChecksum !== descriptor.ownerChecksum ||
    intent.status !== "executing" || intent.leaseToken !== fence.leaseToken || !intent.encryptedInput || !source?.available ||
    intent.expiresAt <= new Date(now!.now) || !intent.leaseExpiresAt || intent.leaseExpiresAt <= new Date(now!.now)) {
    throw new ProductionCommandFenceError();
  }
}

/** Read only committed owner evidence. No journal state can manufacture success. */
export async function productionCommandReceipt(tx: TenantTransaction, context: TenantContext, orderId: string,
  descriptor: ProductionCommandDescriptor): Promise<ProductionCommandReceipt | null> {
  const rows = await tx.select().from(productionOrders).where(and(eq(productionOrders.idempotencyKey, descriptor.businessKey),
    descriptor.kind === "reviewed_order" ? undefined : inArray(productionOrders.orderLineId, descriptor.lineIds)));
  if (!rows.length) return null;
  if (rows.length !== descriptor.lineIds.length || rows.some(row => row.orderId !== orderId || row.createdBy !== context.userId ||
    !descriptor.lineIds.includes(row.orderLineId) || (descriptor.kind !== "reviewed_line" && row.requestChecksum !== descriptor.ownerChecksum))) {
    throw new ConflictException("原生产提交的订单 正文或操作员不匹配");
  }
  if (descriptor.kind === "reviewed_line") {
    const [event] = await tx.select().from(orderWorkEvents).where(and(eq(orderWorkEvents.workItemId, descriptor.targetId),
      eq(orderWorkEvents.idempotencyKey, descriptor.requestKey)));
    if (!event || event.actorId !== context.userId || event.requestHash !== descriptor.ownerChecksum) throw new ConflictException("原生产提交的审核回执不匹配");
  }
  return { productionOrderIds: rows.map(row => row.id).sort() };
}
