import { Permission, authorize } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import { WorkflowNodeKindSchema } from "@yummyai/contracts/workflow";
import {
  WorkflowTaskInboxQuerySchema,
  WorkflowTaskInboxViewSchema,
} from "@yummyai/contracts/workflow/task-inbox";
import {
  loadCurrentMembershipContext,
  productPlans,
  users,
  workflowDefinitionVersions,
  workflowNodeRuns,
  workflowRuns,
  withTenant,
  type DatabaseConnection,
} from "@yummyai/database";
import { and, asc, desc, eq, ilike, isNull, not, notInArray, or, sql } from "drizzle-orm";
import { workflowCenterEnabled } from "./feature.js";
import { WorkflowResponsibilityError } from "./responsibility.js";

/** Read existing node facts without migration, dispatch, or completion writes. */
export class WorkflowTaskInboxReader {
  constructor(private readonly database: DatabaseConnection) {}
  async list(context: TenantContext, raw: unknown = {}) {
    if (!workflowCenterEnabled(context.tenantId))
      throw new WorkflowResponsibilityError(404, "工作流任务当前不可用");
    authorize(context, Permission.WorkflowRead);
    authorize(context, Permission.ProductRead);
    const query = WorkflowTaskInboxQuerySchema.parse(raw);
    return withTenant(
      this.database.db,
      context,
      async (tx) => {
        const membership = await loadCurrentMembershipContext(tx, context);
        const permissions = membership.permissions.filter((value) =>
          context.permissions.includes(value),
        );
        if (
          ![Permission.WorkflowRead, Permission.ProductRead].every((permission) =>
            permissions.includes(permission),
          )
        )
          throw new WorkflowResponsibilityError(403, "当前成员没有读取工作流任务的权限");
        const tenantScope = membership.dataScope === "tenant" && context.dataScope === "tenant";
        const clock = await tx.execute<{ as_of: Date | string; supported: boolean }>(sql`
        select current_timestamp as as_of, exists(select 1 from pg_timezone_names where name=${query.timeZone}) as supported`);
        if (!clock[0]!.supported)
          throw new WorkflowResponsibilityError(400, "当前时区暂不可用 请使用 UTC");
        const asOf = new Date(clock[0]!.as_of).toISOString();
        const timestamp = sql`${asOf}::timestamptz`;
        const dayStart = sql`(date_trunc('day', ${timestamp} at time zone ${query.timeZone}) at time zone ${query.timeZone})`;
        const dayEnd = sql`((date_trunc('day', ${timestamp} at time zone ${query.timeZone}) + interval '1 day') at time zone ${query.timeZone})`;
        const node = sql<{
          id?: unknown;
          title?: unknown;
          kind?: unknown;
        } | null>`(select n.value from jsonb_array_elements(${workflowDefinitionVersions.graph}->'nodes') n(value) where n.value->>'id'=${workflowNodeRuns.nodeId} limit 1)`;
        const open = and(
          notInArray(workflowRuns.status, ["completed", "cancelled"]),
          notInArray(workflowNodeRuns.status, ["completed", "skipped", "cancelled"]),
        )!;
        const overdue = and(open, sql`${workflowNodeRuns.dueAt} < ${timestamp}`)!;
        const today = and(
          open,
          sql`${workflowNodeRuns.dueAt} >= ${dayStart} and ${workflowNodeRuns.dueAt} < ${dayEnd}`,
        )!;
        const search = "%" + query.q.replace(/[\\%_]/g, "\\$&") + "%";
        const predicate = and(
          tenantScope ? undefined : eq(productPlans.createdBy, context.userId),
          sql`coalesce((${node})->>'kind','') not in ('start','end')`,
          query.assignment === "mine"
            ? eq(workflowNodeRuns.assignedUserId, context.userId)
            : query.assignment === "unassigned"
              ? isNull(workflowNodeRuns.assignedUserId)
              : undefined,
          query.status === "open" ? open : query.status === "closed" ? not(open) : undefined,
          query.due === "overdue"
            ? overdue
            : query.due === "today"
              ? today
              : query.due === "unset"
                ? isNull(workflowNodeRuns.dueAt)
                : undefined,
          query.q
            ? or(
                ilike(workflowRuns.title, search),
                ilike(productPlans.name, search),
                ilike(users.displayName, search),
                sql`(${node})->>'title' ilike ${search}`,
              )
            : undefined,
        );
        const stats = await tx
          .select({
            total: sql<number>`count(*)::int`,
            overdue: sql<number>`count(*) filter (where ${overdue})::int`,
            dueToday: sql<number>`count(*) filter (where ${today})::int`,
            blocked: sql<number>`count(*) filter (where ${open} and ${workflowNodeRuns.status} in ('blocked','failed'))::int`,
            upcoming: sql<number>`count(*) filter (where ${open} and ${workflowRuns.currentNodeId} is distinct from ${workflowNodeRuns.nodeId})::int`,
            unassigned: sql<number>`count(*) filter (where ${open} and ${workflowNodeRuns.assignedUserId} is null)::int`,
          })
          .from(workflowNodeRuns)
          .innerJoin(workflowRuns, eq(workflowRuns.id, workflowNodeRuns.runId))
          .innerJoin(
            workflowDefinitionVersions,
            eq(workflowDefinitionVersions.id, workflowRuns.definitionVersionId),
          )
          .innerJoin(productPlans, eq(productPlans.id, workflowRuns.productPlanId))
          .leftJoin(users, eq(users.id, workflowNodeRuns.assignedUserId))
          .where(predicate);
        const rows = await tx
          .select({
            id: workflowNodeRuns.id,
            runId: workflowRuns.id,
            nodeId: workflowNodeRuns.nodeId,
            node,
            runTitle: workflowRuns.title,
            productPlanId: productPlans.id,
            productName: productPlans.name,
            productArchived: sql<boolean>`${productPlans.status}='archived'`,
            definitionVersion: workflowDefinitionVersions.version,
            nodeStatus: workflowNodeRuns.status,
            runStatus: workflowRuns.status,
            runRevision: workflowRuns.revision,
            responsibilityRevision: workflowNodeRuns.responsibilityRevision,
            assignedUserId: workflowNodeRuns.assignedUserId,
            assignedUserName: users.displayName,
            dueAt: workflowNodeRuns.dueAt,
            updatedAt: workflowNodeRuns.updatedAt,
            isCurrent: sql<boolean>`coalesce(${workflowRuns.currentNodeId}=${workflowNodeRuns.nodeId},false)`,
            isClosed: sql<boolean>`not (${open})`,
            isOverdue: sql<boolean>`coalesce(${overdue},false)`,
            isDueToday: sql<boolean>`coalesce(${today},false)`,
          })
          .from(workflowNodeRuns)
          .innerJoin(workflowRuns, eq(workflowRuns.id, workflowNodeRuns.runId))
          .innerJoin(
            workflowDefinitionVersions,
            eq(workflowDefinitionVersions.id, workflowRuns.definitionVersionId),
          )
          .innerJoin(productPlans, eq(productPlans.id, workflowRuns.productPlanId))
          .leftJoin(users, eq(users.id, workflowNodeRuns.assignedUserId))
          .where(predicate)
          .orderBy(
            ...(query.sort === "deadline"
              ? [sql`${workflowNodeRuns.dueAt} asc nulls last`, asc(workflowNodeRuns.id)]
              : [desc(workflowNodeRuns.updatedAt), desc(workflowNodeRuns.id)]),
          )
          .limit(query.pageSize)
          .offset((query.page - 1) * query.pageSize);
        const summary = stats[0]!;
        return WorkflowTaskInboxViewSchema.parse({
          source: "workflow",
          asOf,
          query,
          total: summary.total,
          page: query.page,
          pageSize: query.pageSize,
          summary: {
            overdue: summary.overdue,
            dueToday: summary.dueToday,
            blocked: summary.blocked,
            upcoming: summary.upcoming,
            unassigned: summary.unassigned,
          },
          items: rows.map(({ node, ...row }) => ({
            ...row,
            source: "workflow",
            title: node && typeof node.title === "string" ? node.title : "任务定义不可用",
            definitionMissing:
              !node ||
              typeof node.title !== "string" ||
              !WorkflowNodeKindSchema.safeParse(node.kind).success,
            dueAt: row.dueAt?.toISOString() ?? null,
            updatedAt: row.updatedAt.toISOString(),
          })),
        });
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }
}
