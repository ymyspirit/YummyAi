import type { TenantContext } from "@yummyai/contracts";
import {
  organizations,
  orderWorkItems,
  orderLineResponsibilities as arrangements,
  recordNotificationInTransaction,
  withTenant,
  type DatabaseConnection,
} from "@yummyai/database";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  OrderResponsibilityError,
  orderResponsibilityEnabled,
  orderResponsibilityRecipient,
  orderResponsibilitySource,
  orderResponsibilityProjection,
  responsibilityTimestamp,
} from "./responsibility.js";

/** Delivery checkpoints only; the current business projection decides whether to notify. */
export class OrderLineAttentionDispatcher {
  private readonly identity = "00000000-0000-7000-8000-000000000003";
  constructor(
    private readonly database: DatabaseConnection,
    private readonly notify = recordNotificationInTransaction,
  ) {}
  async dispatch() {
    const result = { checked: 0, notices: 0, deferred: 0, failures: 0 };
    const tenants = await this.database.db.select({ id: organizations.id }).from(organizations);
    for (const tenant of tenants) {
      if (!orderResponsibilityEnabled(tenant.id)) continue;
      const context: TenantContext = {
        tenantId: tenant.id,
        userId: this.identity,
        permissions: [],
        dataScope: "tenant",
      };
      try {
        const counts = await withTenant(this.database.db, context, async (tx) => {
          const counts = { checked: 0, notices: 0, deferred: 0, failures: 0 };
          const rows = await tx
            .select({ work: orderWorkItems, arrangement: arrangements })
            .from(orderWorkItems)
            .innerJoin(arrangements, eq(arrangements.workItemId, orderWorkItems.id))
            .where(
              and(
                sql`${arrangements.assignedUserId} is not null`,
                sql`${arrangements.attentionNextAt}<=clock_timestamp()`,
              ),
            )
            .orderBy(asc(arrangements.attentionNextAt), asc(arrangements.workItemId))
            .limit(100)
            .for("update", { of: orderWorkItems, skipLocked: true });
          if (!rows.length) return counts;
          const projected = await tx.execute<Record<string, unknown>>(
            sql`with v as (${orderResponsibilityProjection}) select * from v where id in (${sql.join(
              rows.map((row) => sql`${row.work.id}`),
              sql`,`,
            )})`,
          );
          const byId = new Map(projected.map((row) => [String(row.id), row]));
          for (const row of rows) {
            try {
              const item = await tx.transaction(async (tx) => {
                const item = { checked: 1, notices: 0, deferred: 0 };
                const projected = byId.get(row.work.id);
                if (!projected) throw new OrderResponsibilityError(404, "订单依据不可用");
                const now = await responsibilityTimestamp(tx),
                  current = orderResponsibilitySource(row.work, projected, now),
                  arrangement = row.arrangement;
                const changed = arrangement.observedSourceChecksum !== current.checksum,
                  cycle = changed ? arrangement.attentionCycle + 1 : arrangement.attentionCycle;
                let assigned = changed ? null : arrangement.assignmentNotifiedAt,
                  due = changed ? null : arrangement.dueNotifiedAt,
                  escalated = changed ? null : arrangement.escalationNotifiedAt;
                let error: string | null = null;
                const send = async (userId: string, stage: "assigned" | "due" | "escalated") => {
                  const target = await orderResponsibilityRecipient(
                    tx,
                    tenant.id,
                    userId,
                    stage !== "escalated",
                    true,
                  );
                  if (!target) {
                    error =
                      stage === "escalated" ? "ESCALATION_UNAVAILABLE" : "RECIPIENT_UNAVAILABLE";
                    return null;
                  }
                  const delivered = await this.notify(tx, target, {
                    kind: "system",
                    title:
                      stage === "assigned"
                        ? changed
                          ? "订单跟进依据已更新"
                          : "订单跟进安排已更新"
                        : stage === "due"
                          ? "订单跟进已到内部截止时间"
                          : "订单跟进已逾期 需要核对",
                    body: "请打开订单商品 核对当前跟进安排与业务进度",
                    resourceType: "order_work_item",
                    resourceId: row.work.id,
                    metadata: { assignmentRevision: arrangement.revision, cycle, stage },
                    deduplicationKey: `order-line/${row.work.id}/${arrangement.revision}/${cycle}/${stage}`,
                  });
                  item.notices++;
                  return delivered.createdAt;
                };
                const deadline = arrangement.internalDueAt,
                  escalation =
                    deadline && arrangement.escalationDelayMinutes
                      ? new Date(deadline.getTime() + arrangement.escalationDelayMinutes * 60000)
                      : null;
                if (current.active) {
                  if (deadline && deadline <= now && !due)
                    due = await send(arrangement.assignedUserId!, "due");
                  else if ((!deadline || deadline > now) && !assigned)
                    assigned = await send(arrangement.assignedUserId!, "assigned");
                  if (arrangement.escalationUserId && escalation && escalation <= now && !escalated)
                    escalated = await send(arrangement.escalationUserId, "escalated");
                }
                if (error) item.deferred++;
                const dates = [
                  new Date(now.getTime() + 300000),
                  ...(current.active && deadline && deadline > now ? [deadline] : []),
                  ...(current.active &&
                  arrangement.escalationUserId &&
                  !escalated &&
                  escalation &&
                  escalation > now
                    ? [escalation]
                    : []),
                ];
                await tx
                  .update(arrangements)
                  .set({
                    attentionCycle: cycle,
                    observedSourceChecksum: current.checksum,
                    attentionNextAt: current.available
                      ? dates.sort((a, b) => a.getTime() - b.getTime())[0]!
                      : null,
                    attentionLastError: error,
                    assignmentNotifiedAt: assigned,
                    dueNotifiedAt: due,
                    escalationNotifiedAt: escalated,
                  })
                  .where(eq(arrangements.workItemId, row.work.id));
                return item;
              });
              counts.checked += item.checked;
              counts.notices += item.notices;
              counts.deferred += item.deferred;
            } catch {
              counts.checked++;
              counts.deferred++;
              counts.failures++;
              await tx
                .update(arrangements)
                .set({
                  attentionNextAt: sql`clock_timestamp()+interval '5 minutes'`,
                  attentionLastError: "DISPATCH_FAILED",
                })
                .where(eq(arrangements.workItemId, row.work.id));
            }
          }
          return counts;
        });
        result.checked += counts.checked;
        result.notices += counts.notices;
        result.deferred += counts.deferred;
        result.failures += counts.failures;
      } catch {
        result.failures++;
      }
    }
    return result;
  }
}
