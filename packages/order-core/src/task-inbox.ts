import type { TenantContext } from "@yummyai/contracts";
import { orderOperatorTask } from "@yummyai/contracts/order/workbench";
import {
  OrderTaskInboxQuerySchema,
  OrderTaskInboxViewSchema,
} from "@yummyai/contracts/order/task-inbox";
import { withTenant, type DatabaseConnection } from "@yummyai/database";
import { sql } from "drizzle-orm";
import { parseWorkLine } from "./work-query.js";
import {
  loadOrderResponsibilityActor,
  orderResponsibilityProjection,
  OrderResponsibilityError,
  requireOrderResponsibilityAccess,
} from "./responsibility.js";

/** Follow-up arrangements project existing business facts; reading never creates work records. */
export class OrderTaskInboxReader {
  constructor(private readonly database: DatabaseConnection) {}
  async list(context: TenantContext, raw: unknown = {}) {
    requireOrderResponsibilityAccess(context);
    const query = OrderTaskInboxQuerySchema.parse(raw);
    return withTenant(
      this.database.db,
      context,
      async (tx) => {
        await loadOrderResponsibilityActor(tx, context);
        const clock = await tx.execute<{ as_of: Date | string; supported: boolean }>(sql`
        select current_timestamp as as_of, exists(select 1 from pg_timezone_names where name=${query.timeZone}) as supported`);
        if (!clock[0]!.supported)
          throw new OrderResponsibilityError(400, "当前时区暂不可用 请使用 UTC");
        const asOf = new Date(clock[0]!.as_of).toISOString(),
          stamp = sql`${asOf}::timestamptz`,
          start = sql`(date_trunc('day', ${stamp} at time zone ${query.timeZone}) at time zone ${query.timeZone})`,
          end = sql`((date_trunc('day', ${stamp} at time zone ${query.timeZone}) + interval '1 day') at time zone ${query.timeZone})`;
        const closed = sql`v."__taskKey" in ('complete','cancelled','archived')`,
          overdue = sql`not (${closed}) and v."__dueAt" < ${stamp}`,
          today = sql`not (${closed}) and v."__dueAt">=${start} and v."__dueAt"<${end}`;
        const predicates = [sql`true`];
        if (query.assignment === "mine")
          predicates.push(sql`v."__assignedUserId"=${context.userId}`);
        else if (query.assignment === "unassigned")
          predicates.push(sql`v."__assignedUserId" is null`);
        if (query.status === "open") predicates.push(sql`not (${closed})`);
        else if (query.status === "closed") predicates.push(closed);
        if (query.due === "overdue") predicates.push(overdue);
        else if (query.due === "today") predicates.push(today);
        else if (query.due === "unset") predicates.push(sql`v."__dueAt" is null`);
        if (query.q) {
          const term = `%${query.q.replace(/[\\%_]/g, "\\$&")}%`;
          predicates.push(sql`(v."externalOrderId" ilike ${term} or v."externalLineId" ilike ${term}
          or v.title ilike ${term} or v."storeName" ilike ${term} or v."skuCode" ilike ${term}
          or v."__assignedUserName" ilike ${term})`);
        }
        const order =
          query.sort === "deadline"
            ? sql`v."__dueAt" asc nulls last, v.id asc`
            : sql`v."__updatedAt" desc, v.id desc`;
        const rows = await tx.execute<{
          total: number;
          overdue: number;
          due_today: number;
          attention: number;
          unassigned: number;
          unavailable: number;
          items: Record<string, unknown>[];
        }>(sql`with source as (${orderResponsibilityProjection}),
        enriched as materialized (select s.*, a.assigned_user_id as "__assignedUserId",
          u.display_name as "__assignedUserName", a.internal_due_at as "__dueAt",
          coalesce(a.revision,0) as "__responsibilityRevision", w.id is not null as "__hasWorkRecord",
          coalesce(w.encrypted_data_key is not null and w.expires_at>${stamp},false) as "__sourceAvailable",
          greatest(s."updatedAt",o.updated_at,a.updated_at) as "__updatedAt"
          from source s join orders o on o.id=s."orderId"
          left join order_work_items w on w.id=s.id
          left join order_line_responsibilities a on a.work_item_id=s.id
          left join app_users u on u.id=a.assigned_user_id),
        filtered as materialized (select v.*,
          (${closed}) as "__closed", coalesce(${overdue},false) as "__overdue",
          coalesce(${today},false) as "__today",
          (not (${closed}) and (v."operatorException" or cardinality(v."__exceptions")>0)) as "__attention"
          from enriched v where ${sql.join(predicates, sql` and `)}),
        paged as (select v.* from filtered v order by ${order}
          limit ${query.pageSize} offset ${(query.page - 1) * query.pageSize})
        select count(*)::int as total,
          count(*) filter(where v."__overdue")::int as overdue,
          count(*) filter(where v."__today")::int as due_today,
          count(*) filter(where v."__attention")::int as attention,
          count(*) filter(where not v."__closed" and v."__assignedUserId" is null)::int as unassigned,
          count(*) filter(where not v."__closed" and not v."__sourceAvailable")::int as unavailable,
          coalesce((select jsonb_agg(to_jsonb(v) order by ${order}) from paged v),'[]'::jsonb) as items
        from filtered v`);
        const result = rows[0]!;
        return OrderTaskInboxViewSchema.parse({
          source: "order",
          asOf,
          query,
          total: result.total,
          page: query.page,
          pageSize: query.pageSize,
          summary: {
            overdue: result.overdue,
            dueToday: result.due_today,
            attention: result.attention,
            unassigned: result.unassigned,
            unavailable: result.unavailable,
          },
          items: result.items.map((row) => {
            const line = parseWorkLine(
              Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith("__"))),
            );
            return {
              id: line.id,
              source: "order",
              orderId: line.orderId,
              externalOrderId: line.externalOrderId,
              externalLineId: line.externalLineId,
              title:
                row.__taskKey === "order_exception"
                  ? "核对订单级异常"
                  : orderOperatorTask(line).title,
              itemTitle: line.title,
              storeName: line.storeName,
              skuCode: line.skuCode,
              quantity: line.quantity,
              taskKey: row.__taskKey,
              orderStatus: line.orderStatus,
              openExceptionCount: (row.__exceptions as string[]).length,
              hasWorkRecord: row.__hasWorkRecord,
              sourceAvailable: row.__sourceAvailable,
              responsibilityRevision: row.__responsibilityRevision,
              assignedUserId: row.__assignedUserId,
              assignedUserName: row.__assignedUserName,
              dueAt: row.__dueAt == null ? null : new Date(row.__dueAt as string).toISOString(),
              platformShipByAt: line.platformShipByAt,
              updatedAt: new Date(row.__updatedAt as string).toISOString(),
              isClosed: row.__closed,
              isOverdue: row.__overdue,
              isDueToday: row.__today,
              needsAttention: row.__attention,
            };
          }),
        });
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }
}
