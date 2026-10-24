import { authorize, Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext, type WorkflowNode } from "@yummyai/contracts";
import {
  WorkflowResponsibilityInputSchema,
  WorkflowResponsibilityViewSchema,
  type WorkflowResponsibilityInput,
} from "@yummyai/contracts/workflow/responsibility";
import {
  loadCurrentMembershipContext,
  recordAuditInTransaction,
  recordNotificationInTransaction,
  memberships,
  organizations,
  productPlans,
  users,
  workflowRuns,
  workflowNodeRuns,
  workflowDefinitionVersions,
  workflowRunEvents,
  withTenant,
  type DatabaseConnection,
  type TenantTransaction,
} from "@yummyai/database";
import { and, asc, eq, ilike, inArray, sql } from "drizzle-orm";
import { workflowCenterEnabled } from "./feature.js";

type Run = typeof workflowRuns.$inferSelect;
type NodeRun = typeof workflowNodeRuns.$inferSelect;
type Basis = { run: Run; current: NodeRun; node: WorkflowNode; ownerId: string | null };
const terminal = new Set(["completed", "skipped", "cancelled"]);
export class WorkflowResponsibilityError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
async function now(tx: TenantTransaction) {
  const rows = await tx.execute<{ value: Date | string }>(sql`select clock_timestamp() as value`);
  return new Date(rows[0]!.value);
}
async function basis(tx: TenantTransaction, runId: string, nodeId: string): Promise<Basis> {
  const [record] = await tx
    .select({
      run: workflowRuns,
      ownerId: productPlans.createdBy,
      graph: workflowDefinitionVersions.graph,
    })
    .from(workflowRuns)
    .innerJoin(productPlans, eq(productPlans.id, workflowRuns.productPlanId))
    .innerJoin(
      workflowDefinitionVersions,
      eq(workflowDefinitionVersions.id, workflowRuns.definitionVersionId),
    )
    .where(eq(workflowRuns.id, runId))
    .limit(1);
  const [current] = record
    ? await tx
        .select()
        .from(workflowNodeRuns)
        .where(and(eq(workflowNodeRuns.runId, runId), eq(workflowNodeRuns.nodeId, nodeId)))
        .limit(1)
    : [];
  const node = record?.graph.nodes.find((node) => node.id === nodeId);
  if (!record || !current || !node)
    throw new WorkflowResponsibilityError(404, "任务不存在或不在当前范围内");
  return { run: record.run, ownerId: record.ownerId, current, node };
}
function visible(context: TenantContext, source: Basis) {
  return (
    context.permissions.includes(Permission.WorkflowRead) &&
    context.permissions.includes(Permission.ProductRead) &&
    (context.dataScope === "tenant" || source.ownerId === context.userId)
  );
}
function actionable(source: Basis) {
  return (
    !["completed", "cancelled"].includes(source.run.status) &&
    !terminal.has(source.current.status) &&
    !["start", "end"].includes(source.node.kind)
  );
}
export async function workflowResponsibilityRecipient(
  tx: TenantTransaction,
  base: Pick<TenantContext, "tenantId" | "userId">,
  source: Basis,
  assign: boolean,
  lock = false,
) {
  const context = await loadCurrentMembershipContext(tx, base, { lock });
  const eligible =
    visible(context, source) &&
    context.permissions.includes(Permission.NotificationRead) &&
    (!assign ||
      (context.permissions.includes(Permission.WorkflowRun) &&
        (!source.node.requiredPermission ||
          context.permissions.includes(source.node.requiredPermission)) &&
        (source.node.kind !== "approval_gate" ||
          context.permissions.includes(Permission.WorkflowApprove))));
  return eligible ? context : undefined;
}
async function currentActor(
  tx: TenantTransaction,
  input: TenantContext,
  source: Basis,
  manage = false,
) {
  const current = await loadCurrentMembershipContext(tx, input, { lock: manage });
  const ranks = { self: 0, team: 1, tenant: 2 };
  const context = {
    ...current,
    permissions: current.permissions.filter((permission) => input.permissions.includes(permission)),
    dataScope:
      ranks[current.dataScope] < ranks[input.dataScope] ? current.dataScope : input.dataScope,
  };
  if (!visible(context, source))
    throw new WorkflowResponsibilityError(404, "任务不存在或不在当前范围内");
  if (manage && !context.permissions.includes(Permission.WorkflowAssign))
    throw new WorkflowResponsibilityError(403, "当前成员没有分配任务的权限");
  return context;
}
export class WorkflowResponsibilityCoordinator {
  constructor(private readonly database: DatabaseConnection) {}
  async get(context: TenantContext, runId: string, nodeId: string, query = "") {
    authorize(context, Permission.WorkflowRead);
    authorize(context, Permission.ProductRead);
    return withTenant(this.database.db, context, async (tx) => {
      const source = await basis(tx, runId, nodeId),
        actor = await currentActor(tx, context, source);
      return this.view(tx, actor, source, query);
    });
  }
  async update(
    context: TenantContext,
    runId: string,
    nodeId: string,
    raw: WorkflowResponsibilityInput,
  ) {
    authorize(context, Permission.WorkflowRead);
    authorize(context, Permission.ProductRead);
    authorize(context, Permission.WorkflowAssign);
    const input = WorkflowResponsibilityInputSchema.parse(raw);
    return withTenant(this.database.db, context, async (tx) => {
      await tx
        .select({ id: workflowRuns.id })
        .from(workflowRuns)
        .where(eq(workflowRuns.id, runId))
        .for("update");
      const source = await basis(tx, runId, nodeId),
        actor = await currentActor(tx, context, source, true);
      if (source.run.revision !== input.expectedRevision)
        throw new WorkflowResponsibilityError(409, "任务已变化 请载入最新安排后重试");
      if (!actionable(source))
        throw new WorkflowResponsibilityError(409, "已结束的任务不能修改责任安排");
      if (
        input.assignedUserId &&
        !(await workflowResponsibilityRecipient(
          tx,
          { tenantId: context.tenantId, userId: input.assignedUserId },
          source,
          true,
          true,
        ))
      )
        throw new WorkflowResponsibilityError(400, "负责人当前不具备该任务的范围、节点或通知权限");
      if (
        input.escalationUserId &&
        !(await workflowResponsibilityRecipient(
          tx,
          { tenantId: context.tenantId, userId: input.escalationUserId },
          source,
          false,
          true,
        ))
      )
        throw new WorkflowResponsibilityError(400, "升级接收人当前无法查看该任务或通知");
      const dueAt = input.dueAt ? new Date(input.dueAt) : null;
      if (
        source.current.assignedUserId === input.assignedUserId &&
        source.current.dueAt?.toISOString() === dueAt?.toISOString() &&
        source.current.escalationUserId === input.escalationUserId &&
        source.current.escalationDelayMinutes === input.escalationDelayMinutes
      )
        return this.view(tx, actor, source);
      const timestamp = await now(tx),
        revision = source.run.revision + 1,
        responsibilityRevision = source.current.responsibilityRevision + 1;
      const [current] = await tx
        .update(workflowNodeRuns)
        .set({
          assignedUserId: input.assignedUserId,
          dueAt,
          escalationUserId: input.escalationUserId,
          escalationDelayMinutes: input.escalationDelayMinutes,
          responsibilityRevision,
          attentionNextAt: input.assignedUserId ? timestamp : null,
          attentionLastError: null,
          assignmentNotifiedAt: null,
          dueNotifiedAt: null,
          escalationNotifiedAt: null,
          updatedBy: actor.userId,
          updatedAt: timestamp,
        })
        .where(eq(workflowNodeRuns.id, source.current.id))
        .returning();
      await tx
        .update(workflowRuns)
        .set({ revision, updatedAt: timestamp })
        .where(eq(workflowRuns.id, runId));
      await tx.insert(workflowRunEvents).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        runId,
        nodeId,
        type: "node_responsibility_updated",
        actorUserId: actor.userId,
        runRevision: revision,
        note: input.reason,
        payload: {
          responsibilityRevision,
          assignedUserId: input.assignedUserId,
          dueAt: dueAt?.toISOString() ?? null,
          escalationUserId: input.escalationUserId,
          escalationDelayMinutes: input.escalationDelayMinutes,
        },
        occurredAt: timestamp,
      });
      await recordAuditInTransaction(tx, actor, {
        action: "workflow.node.responsibility.update",
        resourceType: "workflow_run",
        resourceId: runId,
        result: "success",
        metadata: { nodeRunId: source.current.id, responsibilityRevision },
      });
      return this.view(tx, actor, {
        ...source,
        run: { ...source.run, revision },
        current: current!,
      });
    });
  }
  private async view(tx: TenantTransaction, actor: TenantContext, source: Basis, query = "") {
    const canManage = actor.permissions.includes(Permission.WorkflowAssign) && actionable(source);
    const rows = canManage
      ? await tx
          .select({ id: users.id, label: users.displayName })
          .from(memberships)
          .innerJoin(users, eq(users.id, memberships.userId))
          .where(
            and(
              eq(memberships.status, "active"),
              query ? ilike(users.displayName, `%${query}%`) : undefined,
            ),
          )
          .orderBy(asc(users.displayName), asc(users.id))
          .limit(101)
      : [];
    const candidates = [];
    for (const row of rows.slice(0, 100)) {
      const canEscalate = Boolean(
          await workflowResponsibilityRecipient(
            tx,
            { tenantId: actor.tenantId, userId: row.id },
            source,
            false,
          ),
        ),
        canAssign =
          canEscalate &&
          Boolean(
            await workflowResponsibilityRecipient(
              tx,
              { tenantId: actor.tenantId, userId: row.id },
              source,
              true,
            ),
          );
      if (canEscalate || canAssign) candidates.push({ ...row, canAssign, canEscalate });
    }
    const ids = [source.current.assignedUserId, source.current.escalationUserId].filter(
      (id): id is string => Boolean(id),
    );
    const names = ids.length
      ? await tx
          .select({ id: users.id, label: users.displayName })
          .from(users)
          .where(inArray(users.id, ids))
      : [];
    const node = source.current;
    return WorkflowResponsibilityViewSchema.parse({
      runId: source.run.id,
      nodeId: node.nodeId,
      revision: source.run.revision,
      assignmentRevision: node.responsibilityRevision,
      assignedUserId: node.assignedUserId,
      assignedUserName: names.find((row) => row.id === node.assignedUserId)?.label ?? null,
      dueAt: node.dueAt?.toISOString() ?? null,
      escalationUserId: node.escalationUserId,
      escalationUserName: names.find((row) => row.id === node.escalationUserId)?.label ?? null,
      escalationDelayMinutes: node.escalationDelayMinutes,
      canManage,
      candidates,
      candidatesTruncated: rows.length > 100,
      assignmentNotifiedAt: node.assignmentNotifiedAt?.toISOString() ?? null,
      dueNotifiedAt: node.dueNotifiedAt?.toISOString() ?? null,
      escalationNotifiedAt: node.escalationNotifiedAt?.toISOString() ?? null,
      nextCheckAt: node.attentionNextAt?.toISOString() ?? null,
      lastError: node.attentionLastError,
    });
  }
}

/** Standing in-app reminders survive dispatcher restarts. The assignment is not
 * permission: every recipient and source scope is checked again at delivery. */
export class WorkflowAttentionDispatcher {
  private readonly identity = createEntityId();
  constructor(
    private readonly database: DatabaseConnection,
    private readonly notify = recordNotificationInTransaction,
  ) {}
  async dispatch() {
    const result = { checked: 0, notices: 0, deferred: 0, failures: 0 };
    const tenants = await this.database.db.select({ id: organizations.id }).from(organizations);
    for (const tenant of tenants) {
      if (!workflowCenterEnabled(tenant.id)) continue;
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
            .select({ runId: workflowRuns.id, nodeId: workflowNodeRuns.nodeId })
            .from(workflowRuns)
            .innerJoin(workflowNodeRuns, eq(workflowNodeRuns.runId, workflowRuns.id))
            .where(
              and(
                sql`${workflowRuns.status} in ('active','blocked','failed')`,
                sql`${workflowNodeRuns.status} not in ('completed','skipped','cancelled')`,
                sql`${workflowNodeRuns.responsibilityRevision}>0`,
                sql`${workflowNodeRuns.attentionNextAt}<=clock_timestamp()`,
              ),
            )
            .orderBy(asc(workflowNodeRuns.attentionNextAt), asc(workflowNodeRuns.id))
            .limit(100)
            .for("update", { of: workflowRuns, skipLocked: true });
          for (const ref of rows) {
            try {
              const delivered = await tx.transaction(async (tx) => {
                const counts = { checked: 0, notices: 0, deferred: 0 };
                const source = await basis(tx, ref.runId, ref.nodeId);
                if (!actionable(source)) return counts;
                counts.checked++;
                const node = source.current,
                  timestamp = await now(tx),
                  due = Boolean(node.dueAt && node.dueAt <= timestamp);
                let error: string | null = null,
                  assignedAt = node.assignmentNotifiedAt,
                  dueAt = node.dueNotifiedAt,
                  escalatedAt = node.escalationNotifiedAt;
                const send = async (userId: string, kind: "assigned" | "due" | "escalated") => {
                  const recipient = await workflowResponsibilityRecipient(
                    tx,
                    { tenantId: tenant.id, userId },
                    source,
                    kind !== "escalated",
                    true,
                  );
                  if (!recipient) {
                    error =
                      kind === "escalated" ? "ESCALATION_UNAVAILABLE" : "RECIPIENT_UNAVAILABLE";
                    return null;
                  }
                  const record = await this.notify(tx, recipient, {
                    kind: "system",
                    title:
                      kind === "assigned"
                        ? "任务安排已更新"
                        : kind === "due"
                          ? "任务已到内部截止时间"
                          : "任务已逾期 需要核对",
                    body: "请打开任务详情 核对当前安排与业务状态",
                    resourceType: "workflow_run",
                    resourceId: source.run.id,
                    metadata: {
                      nodeRunId: node.id,
                      assignmentRevision: node.responsibilityRevision,
                      stage: kind,
                    },
                    deduplicationKey: `workflow/${node.id}/${node.responsibilityRevision}/${kind}`,
                  });
                  counts.notices++;
                  return record.createdAt;
                };
                if (node.assignedUserId) {
                  if (due && !dueAt) dueAt = await send(node.assignedUserId, "due");
                  else if (!due && !assignedAt)
                    assignedAt = await send(node.assignedUserId, "assigned");
                } else error = "RECIPIENT_UNAVAILABLE";
                const escalationTime =
                  node.dueAt && node.escalationDelayMinutes
                    ? new Date(node.dueAt.getTime() + node.escalationDelayMinutes * 60_000)
                    : null;
                if (
                  node.escalationUserId &&
                  escalationTime &&
                  escalationTime <= timestamp &&
                  !escalatedAt
                )
                  escalatedAt = await send(node.escalationUserId, "escalated");
                const pendingDates = [
                  !due && node.dueAt ? node.dueAt : null,
                  node.escalationUserId &&
                  !escalatedAt &&
                  escalationTime &&
                  escalationTime > timestamp
                    ? escalationTime
                    : null,
                ].filter((date): date is Date => Boolean(date));
                const next = error
                  ? new Date(timestamp.getTime() + 300_000)
                  : (pendingDates.sort((a, b) => a.getTime() - b.getTime())[0] ?? null);
                if (error) counts.deferred++;
                await tx
                  .update(workflowNodeRuns)
                  .set({
                    assignmentNotifiedAt: assignedAt,
                    dueNotifiedAt: dueAt,
                    escalationNotifiedAt: escalatedAt,
                    attentionNextAt: next,
                    attentionLastError: error,
                  })
                  .where(eq(workflowNodeRuns.id, node.id));
                return counts;
              });
              counts.checked += delivered.checked;
              counts.notices += delivered.notices;
              counts.deferred += delivered.deferred;
            } catch (error) {
              counts.checked++;
              counts.deferred++;
              counts.failures++;
              await tx
                .update(workflowNodeRuns)
                .set({
                  attentionNextAt: sql`clock_timestamp() + interval '5 minutes'`,
                  attentionLastError:
                    error instanceof WorkflowResponsibilityError && error.status === 404
                      ? "SOURCE_UNAVAILABLE"
                      : "DISPATCH_FAILED",
                })
                .where(
                  and(
                    eq(workflowNodeRuns.runId, ref.runId),
                    eq(workflowNodeRuns.nodeId, ref.nodeId),
                  ),
                );
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
