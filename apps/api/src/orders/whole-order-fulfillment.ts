import { ConflictException, NotFoundException } from "@nestjs/common";
import { orderLines, orders, orderWorkItems, productionOrders, type TenantTransaction } from "@yummyai/database";
import type { WholeOrderLinePin } from "@yummyai/contracts/order/whole-fulfillment";
import { asc, eq, sql } from "drizzle-orm";
import { workProjection } from "./order-workspace-query.js";

export async function lockOrderProductionHeader(tx: TenantTransaction, orderId: string) {
  try {
    const [held] = await tx.execute<{ locked: boolean }>(sql`select pg_try_advisory_xact_lock(hashtextextended(current_setting('app.tenant_id') || ':whole-order:' || ${orderId},0)) as locked`);
    if (!held?.locked) throw new ConflictException("订单正在执行其他操作 请保留本次填写后重新核对");
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for("update", { noWait: true });
    if (!order) throw new NotFoundException("订单不存在或无权访问");
    return order;
  } catch (error) {
    const failure = error as { code?: string; cause?: { code?: string } };
    if (failure.code === "55P03" || failure.cause?.code === "55P03") throw new ConflictException("订单正在执行其他操作 请保留本次填写后重新核对");
    throw error;
  }
}

export async function lockWholeOrder(tx: TenantTransaction, orderId: string) {
  const order = await lockOrderProductionHeader(tx, orderId);
  if (order.sideState || order.addressStatus === "anonymized") throw new ConflictException("订单已暂停、作废或资料不可用");
  const lines = await tx.select().from(orderLines).where(eq(orderLines.orderId, orderId)).orderBy(asc(orderLines.id)).for("update");
  if (!lines.length || lines.length > 100) throw new ConflictException("整单操作支持 1 至 100 件商品任务，请核对订单");
  for (const line of lines) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'order-work:' + line.id},0))`);
  }
  return { order, lines };
}

export async function assertWholeOrderPins(tx: TenantTransaction, orderId: string, pins: WholeOrderLinePin[]) {
  const lines = await tx.select().from(orderLines).where(eq(orderLines.orderId, orderId)).orderBy(asc(orderLines.id));
  if (lines.length !== pins.length || new Set(pins.map(pin => pin.lineId)).size !== pins.length)
    throw new ConflictException("请包含订单全部商品，不能只提交筛选中的商品");
  for (const line of lines) {
    const pin = pins.find(item => item.lineId === line.id);
    if (!pin || pin.quantity !== line.quantity) throw new ConflictException(`商品 ${line.externalLineId} 的数量已变化，请重新读取整单`);
    const [work] = await tx.select().from(orderWorkItems).where(eq(orderWorkItems.id, line.id)).for("update");
    if (!work || work.revision !== pin.expectedRevision || work.projectionVersion !== pin.expectedProjectionVersion)
      throw new ConflictException(`商品 ${line.externalLineId} 的制作进度已变化，请重新读取整单`);
  }
}

/** Keep QC, factory progress and recovery stable until the whole command commits. */
export async function lockWholeOrderProduction(tx: TenantTransaction, orderId: string) {
  const records = await tx.select({ id: productionOrders.id }).from(productionOrders).where(eq(productionOrders.orderId, orderId)).orderBy(asc(productionOrders.id));
  for (const record of records) {
    for (const key of [`production-order:${record.id}`, `production-inspection:${record.id}`])
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key},0))`);
  }
}

export async function assertWholeOrderActive(tx: TenantTransaction, orderId: string) {
  const rows = await tx.execute(sql`select v.*,w.encrypted_data_key is not null and w.expires_at>now() as retained
    from (${workProjection}) v left join order_work_items w on w.id=v.id where v."orderId"=${orderId}`);
  if (!rows.length || rows.length > 100) throw new ConflictException("整单制作资料不可用");
  for (const row of rows) {
    const reasons = wholeOrderBlockers(row);
    if (reasons.length) throw new ConflictException(`商品 ${row.externalLineId}：${reasons.join("；")}`);
  }
  return rows;
}

export function wholeOrderBlockers(row: Record<string, unknown>): string[] {
  const reasons: string[] = [];
  if (row.sideState || row.held) reasons.push("已暂停或作废");
  if (row.archivedAt) reasons.push("商品已归档");
  if (!row.retained) reasons.push("订单资料不可用或已到期");
  if (row.sourceChanged) reasons.push("新导入资料尚未核对");
  if (row.artwork !== "approved") reasons.push("图稿尚未审核通过");
  if (row.proof !== "not_required" && (row.proof !== "approved" || !row.proofVersionCurrent)) reasons.push("当前稿件的客户校样尚未确认");
  return reasons;
}
