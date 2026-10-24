import { createHash } from "node:crypto";
import { authorize, ForbiddenError, Permission } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import { orderOperatorTask } from "@yummyai/contracts/order/workbench";
import { currentOrderAuthority, hasTenantOrderPermissions } from "./order-authority.js";
import {
  OrderLineResponsibilityInputSchema,
  OrderLineResponsibilityViewSchema,
} from "@yummyai/contracts/order/responsibility";
import {
  loadCurrentMembershipContext,
  recordAuditInTransaction,
  memberships,
  users,
  orderWorkItems,
  orderLineResponsibilities as arrangements,
  withTenant,
  type DatabaseConnection,
  type TenantTransaction,
} from "@yummyai/database";
import { and, asc, eq, ilike, inArray, sql } from "drizzle-orm";
import { parseWorkLine, workProjection } from "./work-query.js";
export const orderResponsibilityProjection = sql`with v as (${workProjection}), exceptions as (
  select v.*, o.latest_event_sequence as "__sequence",
    coalesce((select array_agg(e.id order by e.id) from order_exceptions e where e.order_id=v."orderId"
      and coalesce((select event.status from order_exception_events event where event.exception_id=e.id order by event.sequence desc limit 1),'open')='open'),ARRAY[]::uuid[]) as "__exceptions"
  from v join orders o on o.id=v."orderId")
  select exceptions.*, case when "archivedAt" is null and "sideState" is distinct from 'cancelled'
    and cardinality("__exceptions")>0 then 'order_exception' else "operatorTaskKey" end as "__taskKey"
  from exceptions`;

export class OrderResponsibilityError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export function orderResponsibilityEnabled(tenantId: string) {
  const configured = (process.env.ORDER_RESPONSIBILITY_TENANT_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return configured.includes("*") || configured.includes(tenantId);
}
const requiredRead = [Permission.OrderRead, Permission.OrderPiiRead] as const;
function canRead(context: TenantContext) {
  return hasTenantOrderPermissions(context, requiredRead);
}
export async function responsibilityTimestamp(tx: TenantTransaction) {
  const rows = await tx.execute<{ value: Date | string }>(sql`select clock_timestamp() as value`);
  return new Date(rows[0]!.value);
}
type Work = typeof orderWorkItems.$inferSelect;
export type OrderResponsibilitySource = {
  work: Work;
  line: ReturnType<typeof parseWorkLine>;
  checksum: string;
  active: boolean;
  available: boolean;
  openExceptionCount: number;
  task: { key: ReturnType<typeof orderOperatorTask>["key"] | "order_exception"; title: string };
};
export function orderResponsibilitySource(
  work: Work,
  row: Record<string, unknown>,
  now: Date,
): OrderResponsibilitySource {
  if (
    !Array.isArray(row.__exceptions) ||
    !row.__exceptions.every((value) => typeof value === "string") ||
    !Number.isSafeInteger(row.__sequence)
  )
    throw new Error("Order exception projection is incomplete");
  const line = parseWorkLine(
      Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith("__"))),
    ),
    available = Boolean(work.encryptedDataKey) && work.expiresAt > now;
  const currentTask = orderOperatorTask(line);
  const task =
    row.__exceptions.length && !line.archivedAt && line.sideState !== "cancelled"
      ? { key: "order_exception" as const, title: "核对订单级异常" }
      : currentTask;
  return {
    work,
    line,
    checksum: createHash("sha256")
      .update(JSON.stringify({ line, sequence: row.__sequence, exceptions: row.__exceptions }))
      .digest("hex"),
    openExceptionCount: row.__exceptions.length,
    task,
    available,
    active:
      available && !line.archivedAt && line.sideState !== "cancelled" && task.key !== "complete",
  };
}
async function basis(tx: TenantTransaction, lineId: string) {
  const [work] = await tx
    .select()
    .from(orderWorkItems)
    .where(eq(orderWorkItems.id, lineId))
    .limit(1);
  if (!work) throw new OrderResponsibilityError(404, "订单商品不存在或不在当前范围内");
  const rows = await tx.execute<Record<string, unknown>>(
    sql`with v as (${orderResponsibilityProjection}) select * from v where id=${lineId}`,
  );
  if (!rows[0]) throw new OrderResponsibilityError(404, "订单商品不存在或不在当前范围内");
  return orderResponsibilitySource(work, rows[0], await responsibilityTimestamp(tx));
}
export async function loadOrderResponsibilityActor(
  tx: TenantTransaction,
  input: TenantContext,
  manage = false,
) {
  try {
    return await currentOrderAuthority(
      tx,
      input,
      [...requiredRead, ...(manage ? [Permission.OrderAssign] : [])],
      { lock: manage, requireMembership: true },
    );
  } catch (error) {
    if (!(error instanceof ForbiddenError)) throw error;
    throw new OrderResponsibilityError(
      403,
      manage ? "当前成员没有安排订单责任的权限或范围" : "当前成员没有订单跟进的查看权限或范围",
    );
  }
}
export async function orderResponsibilityRecipient(
  tx: TenantTransaction,
  tenantId: string,
  userId: string,
  manage: boolean,
  lock = false,
) {
  const context = await loadCurrentMembershipContext(tx, { tenantId, userId }, { lock });
  return canRead(context) &&
    context.permissions.includes(Permission.NotificationRead) &&
    (!manage || hasTenantOrderPermissions(context, [Permission.OrderWrite]))
    ? context
    : undefined;
}
export function requireOrderResponsibilityAccess(context: TenantContext) {
  if (!orderResponsibilityEnabled(context.tenantId))
    throw new OrderResponsibilityError(404, "订单责任安排暂未启用");
  for (const permission of requiredRead) authorize(context, permission);
}
export class OrderLineResponsibilityCoordinator {
  constructor(private readonly database: DatabaseConnection) {}
  async get(context: TenantContext, lineId: string, query = "") {
    requireOrderResponsibilityAccess(context);
    if (query.length > 100) throw new OrderResponsibilityError(400, "成员搜索过长");
    return withTenant(this.database.db, context, async (tx) =>
      this.view(
        tx,
        await loadOrderResponsibilityActor(tx, context),
        await basis(tx, lineId),
        query,
      ),
    );
  }
  async update(context: TenantContext, lineId: string, raw: unknown) {
    requireOrderResponsibilityAccess(context);
    authorize(context, Permission.OrderAssign);
    const input = OrderLineResponsibilityInputSchema.parse(raw);
    return withTenant(this.database.db, context, async (tx) => {
      await tx
        .select({ id: orderWorkItems.id })
        .from(orderWorkItems)
        .where(eq(orderWorkItems.id, lineId))
        .for("update");
      const current = await basis(tx, lineId),
        acting = await loadOrderResponsibilityActor(tx, context, true);
      const [before] = await tx
        .select()
        .from(arrangements)
        .where(eq(arrangements.workItemId, lineId));
      if (
        (before?.revision ?? 0) !== input.expectedRevision ||
        current.checksum !== input.expectedSourceChecksum
      )
        throw new OrderResponsibilityError(409, "订单资料或责任安排已变化 请载入最新依据后重试");
      if (!current.active)
        throw new OrderResponsibilityError(409, "当前订单商品已结束、归档或资料过期");
      if (
        input.assignedUserId &&
        !(await orderResponsibilityRecipient(
          tx,
          context.tenantId,
          input.assignedUserId,
          true,
          true,
        ))
      )
        throw new OrderResponsibilityError(400, "负责人当前不具备订单处理、范围或通知权限");
      if (
        input.escalationUserId &&
        !(await orderResponsibilityRecipient(
          tx,
          context.tenantId,
          input.escalationUserId,
          false,
          true,
        ))
      )
        throw new OrderResponsibilityError(400, "升级接收人当前无法查看订单或通知");
      const dueAt = input.dueAt ? new Date(input.dueAt) : null;
      if (
        (before?.assignedUserId ?? null) === input.assignedUserId &&
        (before?.internalDueAt?.toISOString() ?? null) === (dueAt?.toISOString() ?? null) &&
        (before?.escalationUserId ?? null) === input.escalationUserId &&
        (before?.escalationDelayMinutes ?? null) === input.escalationDelayMinutes
      )
        return this.view(tx, acting, current);
      const now = await responsibilityTimestamp(tx),
        revision = (before?.revision ?? 0) + 1;
      const values = {
        assignedUserId: input.assignedUserId,
        internalDueAt: dueAt,
        escalationUserId: input.escalationUserId,
        escalationDelayMinutes: input.escalationDelayMinutes,
        revision,
        reasonCode: input.reason,
        updatedBy: acting.userId,
        updatedAt: now,
        attentionCycle: 1,
        observedSourceChecksum: current.checksum,
        attentionNextAt: input.assignedUserId ? now : null,
        attentionLastError: null,
        assignmentNotifiedAt: null,
        dueNotifiedAt: null,
        escalationNotifiedAt: null,
      };
      if (before)
        await tx.update(arrangements).set(values).where(eq(arrangements.workItemId, lineId));
      else
        await tx
          .insert(arrangements)
          .values({ ...values, tenantId: context.tenantId, workItemId: lineId });
      await recordAuditInTransaction(tx, acting, {
        action: "order.line.responsibility.update",
        resourceType: "order_work_item",
        resourceId: lineId,
        result: "success",
        metadata: {
          revision,
          reason: input.reason,
          sourceChecksum: current.checksum,
          previous: before
            ? {
                assignedUserId: before.assignedUserId,
                dueAt: before.internalDueAt?.toISOString() ?? null,
                escalationUserId: before.escalationUserId,
                escalationDelayMinutes: before.escalationDelayMinutes,
              }
            : null,
          next: {
            assignedUserId: input.assignedUserId,
            dueAt: dueAt?.toISOString() ?? null,
            escalationUserId: input.escalationUserId,
            escalationDelayMinutes: input.escalationDelayMinutes,
          },
        },
      });
      return this.view(tx, acting, current);
    });
  }
  private async view(
    tx: TenantTransaction,
    context: TenantContext,
    current: OrderResponsibilitySource,
    query = "",
  ) {
    const [value] = await tx
      .select()
      .from(arrangements)
      .where(eq(arrangements.workItemId, current.work.id));
    const canManage =
      current.active && hasTenantOrderPermissions(context, [Permission.OrderAssign]);
    const rows = canManage
      ? await tx
          .select({ id: users.id, label: users.displayName })
          .from(memberships)
          .innerJoin(users, eq(users.id, memberships.userId))
          .where(
            and(
              eq(memberships.status, "active"),
              query ? ilike(users.displayName, `%${query.replace(/[\\%_]/g, "\\$&")}%`) : undefined,
            ),
          )
          .orderBy(asc(users.displayName), asc(users.id))
          .limit(101)
      : [];
    const candidates = [];
    for (const row of rows.slice(0, 100)) {
      const canEscalate = Boolean(
        await orderResponsibilityRecipient(tx, context.tenantId, row.id, false),
      );
      const canAssign =
        canEscalate &&
        Boolean(await orderResponsibilityRecipient(tx, context.tenantId, row.id, true));
      if (canEscalate || canAssign) candidates.push({ ...row, canAssign, canEscalate });
    }
    const ids = [value?.assignedUserId, value?.escalationUserId].filter((id): id is string =>
      Boolean(id),
    );
    const names = ids.length
      ? await tx
          .select({ id: users.id, label: users.displayName })
          .from(users)
          .where(inArray(users.id, ids))
      : [];
    return OrderLineResponsibilityViewSchema.parse({
      lineId: current.work.id,
      orderId: current.line.orderId,
      revision: value?.revision ?? 0,
      assignmentRevision: value?.revision ?? 0,
      currentTaskKey: current.task.key,
      currentTask: current.task.title,
      openExceptionCount: current.openExceptionCount,
      active: current.active,
      available: current.available,
      sourceChecksum: current.checksum,
      businessRevision: current.work.revision,
      businessProjectionVersion: current.work.projectionVersion,
      reminderCycle: value?.attentionCycle ?? 0,
      lastReason: value?.reasonCode ?? null,
      assignedUserId: value?.assignedUserId ?? null,
      assignedUserName: names.find((row) => row.id === value?.assignedUserId)?.label ?? null,
      dueAt: value?.internalDueAt?.toISOString() ?? null,
      escalationUserId: value?.escalationUserId ?? null,
      escalationUserName: names.find((row) => row.id === value?.escalationUserId)?.label ?? null,
      escalationDelayMinutes: value?.escalationDelayMinutes ?? null,
      canManage,
      candidates,
      candidatesTruncated: rows.length > 100,
      assignmentNotifiedAt: value?.assignmentNotifiedAt?.toISOString() ?? null,
      dueNotifiedAt: value?.dueNotifiedAt?.toISOString() ?? null,
      escalationNotifiedAt: value?.escalationNotifiedAt?.toISOString() ?? null,
      nextCheckAt: value?.attentionNextAt?.toISOString() ?? null,
      lastError: value?.attentionLastError ?? null,
    });
  }
}
