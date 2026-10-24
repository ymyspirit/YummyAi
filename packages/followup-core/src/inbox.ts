import type { TenantContext } from "@yummyai/contracts";
import {
  FollowupTaskInboxQuerySchema,
  FollowupTaskInboxViewSchema,
  type FollowupSource,
} from "@yummyai/contracts/operations/followup";
import { withTenant, type DatabaseConnection } from "@yummyai/database";
import { sql } from "drizzle-orm";
import { followupAdapter, followupTable, sourceRecord, FollowupError } from "./sources.js";
import { followupActor, requireFollowupAccess, followupItem } from "./responsibility.js";

export class FollowupInboxReader {
  constructor(private readonly database: DatabaseConnection) {}
  async list(context: TenantContext, source: FollowupSource, raw: unknown = {}) {
    const adapter = followupAdapter(source);
    requireFollowupAccess(context, adapter);
    const query = FollowupTaskInboxQuerySchema.parse(raw);
    return withTenant(
      this.database.db,
      context,
      async (tx) => {
        await followupActor(tx, context, adapter);
        const clock = await tx.execute<{ as_of: Date; supported: boolean }>(
          sql`select current_timestamp as as_of,exists(select 1 from pg_timezone_names where name=${query.timeZone}) as supported`,
        );
        if (!clock[0]!.supported) throw new FollowupError(400, "当前时区暂不可用 请使用 UTC");
        const asOf = new Date(clock[0]!.as_of),
          stamp = sql`${asOf.toISOString()}::timestamptz`,
          start = sql`(date_trunc('day',${stamp} at time zone ${query.timeZone}) at time zone ${query.timeZone})`,
          end = sql`((date_trunc('day',${stamp} at time zone ${query.timeZone})+interval '1 day') at time zone ${query.timeZone})`;
        const overdue = sql`not v."isClosed" and v."__dueAt"<${stamp}`,
          today = sql`not v."isClosed" and v."__dueAt">=${start} and v."__dueAt"<${end}`;
        const predicates = [sql`true`];
        if (query.assignment === "mine")
          predicates.push(sql`v."__assignedUserId"=${context.userId}`);
        else if (query.assignment === "unassigned")
          predicates.push(sql`v."__assignedUserId" is null`);
        if (query.status === "open") predicates.push(sql`not v."isClosed"`);
        else if (query.status === "closed") predicates.push(sql`v."isClosed"`);
        if (query.due === "overdue") predicates.push(overdue);
        else if (query.due === "today") predicates.push(today);
        else if (query.due === "unset") predicates.push(sql`v."__dueAt" is null`);
        if (query.q) {
          const term = `%${query.q.replace(/[\\%_]/g, "\\$&")}%`;
          predicates.push(
            sql`(v.label ilike ${term} or v.title ilike ${term} or v."contextLabel" ilike ${term} or v."__assignedUserName" ilike ${term})`,
          );
        }
        const order =
          query.sort === "deadline"
            ? sql`v."__dueAt" asc nulls last,v.id asc`
            : sql`v."__updatedAt" desc,v.id desc`;
        const rows = await tx.execute<{
          total: number;
          overdue: number;
          due_today: number;
          attention: number;
          unassigned: number;
          unavailable: number;
          items: Record<string, unknown>[];
        }>(sql`
        with source as (${adapter.projection}),enriched as materialized(select s.*,
          a.assigned_user_id as "__assignedUserId",u.display_name as "__assignedUserName",a.internal_due_at as "__dueAt",coalesce(a.revision,0) as "__responsibilityRevision",a.updated_at as "__arrangementUpdatedAt",
          greatest(s."updatedAt",a.updated_at) as "__updatedAt"
          from source s left join ${followupTable(adapter)} a on a.object_id=s.id
          left join memberships m on m.user_id=a.assigned_user_id and m.tenant_id=a.tenant_id
          left join app_users u on u.id=m.user_id),
        filtered as materialized(select v.*,coalesce(${overdue},false) as "__overdue",coalesce(${today},false) as "__today" from enriched v where ${sql.join(predicates, sql` and `)}),
        paged as(select v.* from filtered v order by ${order} limit ${query.pageSize} offset ${(query.page - 1) * query.pageSize})
        select count(*)::int as total,count(*)filter(where v."__overdue")::int as overdue,count(*)filter(where v."__today")::int as due_today,
          count(*)filter(where not v."isClosed" and v."needsAttention")::int as attention,
          count(*)filter(where not v."isClosed" and v."__assignedUserId" is null)::int as unassigned,
          count(*)filter(where not v."isClosed" and not v.available)::int as unavailable,
          coalesce((select jsonb_agg(to_jsonb(v) order by ${order}) from paged v),'[]'::jsonb) as items from filtered v`);
        const result = rows[0]!;
        return FollowupTaskInboxViewSchema.parse({
          source: adapter.kind,
          asOf: asOf.toISOString(),
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
            const current = sourceRecord(
              adapter,
              Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith("__"))),
            );
            return followupItem(
              current,
              {
                assigned_user_id: row.__assignedUserId as string | null,
                internal_due_at: row.__dueAt ? new Date(row.__dueAt as string) : null,
                revision: Number(row.__responsibilityRevision),
                updated_at: row.__arrangementUpdatedAt
                  ? new Date(row.__arrangementUpdatedAt as string)
                  : new Date(0),
              },
              asOf,
              query.timeZone,
              row.__assignedUserName as string | null,
            );
          }),
        });
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }
}
