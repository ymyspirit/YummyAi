import {
  authorize,
  ForbiddenError,
  Permission,
  permissionScope,
  intersectPermissionContexts,
  type PermissionValue,
} from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import {
  FollowupDetailViewSchema,
  FollowupResponsibilityInputSchema,
  FollowupResponsibilityViewSchema,
  type FollowupSource,
  type FollowupResponsibilityInput,
} from "@yummyai/contracts/operations/followup";
import {
  loadCurrentMembershipContext,
  memberships,
  recordAuditInTransaction,
  users,
  withTenant,
  type DatabaseConnection,
  type TenantTransaction,
} from "@yummyai/database";
import { and, asc, eq, ilike, inArray, sql } from "drizzle-orm";
import {
  FollowupError,
  followupAdapter,
  followupEnabled,
  followupTable,
  lockFollowupSource,
  readFollowupSource,
  type FollowupAdapter,
  type FollowupSourceRecord,
} from "./sources.js";

export function requireFollowupAccess(context: TenantContext, adapter: FollowupAdapter) {
  if (!followupEnabled(context.tenantId)) throw new FollowupError(404, "该类业务跟进暂未启用");
  for (const permission of adapter.read) authorize(context, permission);
}
function hasTenantSourcePermissions(context: TenantContext, required: readonly PermissionValue[]) {
  try {
    for (const permission of required) {
      authorize(context, permission);
      if (permissionScope(context, permission) !== "tenant") return false;
    }
    return true;
  } catch (error) {
    if (error instanceof ForbiddenError) return false;
    throw error;
  }
}
export async function followupActor(
  tx: TenantTransaction,
  input: TenantContext,
  adapter: FollowupAdapter,
  manage = false,
) {
  const current = await loadCurrentMembershipContext(tx, input, { lock: manage }),
    context = intersectPermissionContexts(input, current);
  if (!hasTenantSourcePermissions(context, adapter.read))
    throw new FollowupError(403, "当前成员没有该业务跟进的查看权限或范围");
  if (manage && !hasTenantSourcePermissions(context, [adapter.assign]))
    throw new FollowupError(403, "当前成员没有安排该业务责任的权限");
  return context;
}
export async function followupRecipient(
  tx: TenantTransaction,
  tenantId: string,
  userId: string,
  adapter: FollowupAdapter,
  acting: boolean,
  lock = false,
) {
  const context = await loadCurrentMembershipContext(tx, { tenantId, userId }, { lock });
  return hasTenantSourcePermissions(context, [
    ...adapter.read,
    ...(acting ? [adapter.write] : []),
  ]) && context.permissions.includes(Permission.NotificationRead)
    ? context
    : undefined;
}
export type Arrangement = {
  object_id: string;
  tenant_id: string;
  assigned_user_id: string | null;
  internal_due_at: Date | null;
  escalation_user_id: string | null;
  escalation_delay_minutes: number | null;
  revision: number;
  reason_code: string;
  updated_at: Date;
  attention_cycle: number;
  observed_source_checksum: string;
  attention_next_at: Date | null;
  attention_last_error: string | null;
  assignment_notified_at: Date | null;
  due_notified_at: Date | null;
  escalation_notified_at: Date | null;
};
export async function readArrangement(tx: TenantTransaction, adapter: FollowupAdapter, id: string) {
  return (
    await tx.execute<Arrangement>(
      sql`select * from ${followupTable(adapter)} where object_id=${id}`,
    )
  )[0];
}
const date = (value: Date | string | null | undefined) =>
  value == null ? null : new Date(value).toISOString();
export function followupItem(
  current: FollowupSourceRecord,
  arrangement:
    | Pick<Arrangement, "assigned_user_id" | "internal_due_at" | "revision" | "updated_at">
    | undefined,
  asOf: Date,
  timeZone = "UTC",
  assignedUserName: string | null = null,
) {
  const due = date(arrangement?.internal_due_at),
    day = (stamp: string) =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(stamp));
  return {
    ...current,
    assignedUserId: arrangement?.assigned_user_id ?? null,
    assignedUserName,
    dueAt: due,
    responsibilityRevision: arrangement?.revision ?? 0,
    updatedAt: new Date(
      Math.max(
        Date.parse(current.updatedAt),
        arrangement?.updated_at ? new Date(arrangement.updated_at).getTime() : 0,
      ),
    ).toISOString(),
    isOverdue: !current.isClosed && due !== null && Date.parse(due) < asOf.getTime(),
    isDueToday: !current.isClosed && due !== null && day(due) === day(asOf.toISOString()),
  };
}

export class FollowupCoordinator {
  constructor(private readonly database: DatabaseConnection) {}
  async get(context: TenantContext, source: FollowupSource, id: string, q = "") {
    const adapter = followupAdapter(source);
    requireFollowupAccess(context, adapter);
    if (q.length > 100) throw new FollowupError(400, "成员搜索过长");
    return withTenant(
      this.database.db,
      context,
      async (tx) => {
        const acting = await followupActor(tx, context, adapter),
          current = await readFollowupSource(tx, adapter, id),
          responsibility = await this.view(tx, acting, adapter, current, q);
        return FollowupDetailViewSchema.parse({
          item: followupItem(
            current,
            await readArrangement(tx, adapter, id),
            new Date(),
            "UTC",
            responsibility.assignedUserName,
          ),
          responsibility,
        });
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }
  async update(
    context: TenantContext,
    source: FollowupSource,
    id: string,
    raw: unknown,
    resume = false,
  ) {
    const adapter = followupAdapter(source);
    requireFollowupAccess(context, adapter);
    authorize(context, adapter.assign);
    const input = FollowupResponsibilityInputSchema.parse(raw);
    return withTenant(this.database.db, context, async (tx) => {
      const acting = await followupActor(tx, context, adapter, true);
      if (!(await lockFollowupSource(tx, context, adapter, id)))
        throw new FollowupError(404, "跟进对象不存在或不在当前范围内");
      const current = await readFollowupSource(tx, adapter, id),
        before = await readArrangement(tx, adapter, id);
      if (
        (before?.revision ?? 0) !== input.expectedRevision ||
        current.sourceChecksum !== input.expectedSourceChecksum
      )
        throw new FollowupError(409, "业务依据或责任安排已变化 请载入最新依据后重试");
      if (!current.available || current.isClosed)
        throw new FollowupError(409, "跟进对象已结束、归档或资料不可用");
      await this.validateRecipients(tx, context, adapter, input);
      const unchanged =
        (before?.assigned_user_id ?? null) === input.assignedUserId &&
        date(before?.internal_due_at) === date(input.dueAt) &&
        (before?.escalation_user_id ?? null) === input.escalationUserId &&
        (before?.escalation_delay_minutes ?? null) === input.escalationDelayMinutes;
      if (
        resume &&
        (!before || !before.assigned_user_id || before.attention_next_at !== null || !unchanged)
      )
        throw new FollowupError(409, "当前安排无需恢复 请先核对已保存的负责人和时限");
      if (unchanged && !resume) return this.view(tx, acting, adapter, current);
      const revision = (before?.revision ?? 0) + 1;
      await tx.execute(sql`insert into ${followupTable(adapter)}(object_id,tenant_id,assigned_user_id,internal_due_at,escalation_user_id,escalation_delay_minutes,revision,reason_code,updated_by,updated_at,attention_cycle,observed_source_checksum,attention_next_at)
        values(${id},${context.tenantId},${input.assignedUserId},${input.dueAt}::timestamptz,${input.escalationUserId},${input.escalationDelayMinutes},${revision},${input.reason},${acting.userId},clock_timestamp(),1,${current.sourceChecksum},case when ${input.assignedUserId}::uuid is not null then clock_timestamp() else null end)
        on conflict(object_id) do update set assigned_user_id=excluded.assigned_user_id,internal_due_at=excluded.internal_due_at,escalation_user_id=excluded.escalation_user_id,escalation_delay_minutes=excluded.escalation_delay_minutes,revision=excluded.revision,reason_code=excluded.reason_code,updated_by=excluded.updated_by,updated_at=excluded.updated_at,attention_cycle=1,observed_source_checksum=excluded.observed_source_checksum,attention_next_at=excluded.attention_next_at,attention_last_error=null,assignment_notified_at=null,due_notified_at=null,escalation_notified_at=null`);
      await recordAuditInTransaction(tx, acting, {
        action: resume ? "business.followup.resume" : "business.followup.update",
        resourceType: source,
        resourceId: id,
        result: "success",
        metadata: {
          revision,
          reason: input.reason,
          sourceChecksum: current.sourceChecksum,
          previous: before
            ? {
                assignedUserId: before.assigned_user_id,
                dueAt: date(before.internal_due_at),
                escalationUserId: before.escalation_user_id,
                escalationDelayMinutes: before.escalation_delay_minutes,
              }
            : null,
          next: {
            assignedUserId: input.assignedUserId,
            dueAt: input.dueAt,
            escalationUserId: input.escalationUserId,
            escalationDelayMinutes: input.escalationDelayMinutes,
          },
        },
      });
      return this.view(tx, acting, adapter, current);
    });
  }
  private async validateRecipients(
    tx: TenantTransaction,
    context: TenantContext,
    adapter: FollowupAdapter,
    input: FollowupResponsibilityInput,
  ) {
    if (
      input.assignedUserId &&
      !(await followupRecipient(tx, context.tenantId, input.assignedUserId, adapter, true, true))
    )
      throw new FollowupError(400, "负责人当前不具备该业务的处理、范围或通知权限");
    if (
      input.escalationUserId &&
      !(await followupRecipient(tx, context.tenantId, input.escalationUserId, adapter, false, true))
    )
      throw new FollowupError(400, "升级接收人当前无法查看该业务或通知");
  }
  private async view(
    tx: TenantTransaction,
    context: TenantContext,
    adapter: FollowupAdapter,
    current: FollowupSourceRecord,
    q = "",
  ) {
    const value = await readArrangement(tx, adapter, current.id),
      canManage =
        current.available &&
        !current.isClosed &&
        hasTenantSourcePermissions(context, [adapter.assign]);
    const members = canManage
      ? await tx
          .select({ id: users.id, label: users.displayName })
          .from(memberships)
          .innerJoin(users, eq(users.id, memberships.userId))
          .where(
            and(
              eq(memberships.status, "active"),
              q ? ilike(users.displayName, `%${q.replace(/[\\%_]/g, "\\$&")}%`) : undefined,
            ),
          )
          .orderBy(asc(users.displayName), asc(users.id))
          .limit(101)
      : [];
    const candidates = [];
    for (const member of members.slice(0, 100)) {
      const canEscalate = Boolean(
          await followupRecipient(tx, context.tenantId, member.id, adapter, false),
        ),
        canAssign =
          canEscalate &&
          Boolean(await followupRecipient(tx, context.tenantId, member.id, adapter, true));
      if (canEscalate || canAssign) candidates.push({ ...member, canAssign, canEscalate });
    }
    const ids = [value?.assigned_user_id, value?.escalation_user_id].filter((v): v is string =>
        Boolean(v),
      ),
      names = ids.length
        ? await tx
            .select({ id: users.id, label: users.displayName })
            .from(users)
            .innerJoin(memberships, eq(memberships.userId, users.id))
            .where(inArray(users.id, ids))
        : [];
    return FollowupResponsibilityViewSchema.parse({
      objectId: current.id,
      source: adapter.kind,
      revision: value?.revision ?? 0,
      assignmentRevision: value?.revision ?? 0,
      currentTask: current.title,
      sourceChecksum: current.sourceChecksum,
      active: !current.isClosed && current.available,
      available: current.available,
      businessVersion: current.businessVersion,
      reminderCycle: value?.attention_cycle ?? 0,
      lastReason: value?.reason_code ?? null,
      assignedUserId: value?.assigned_user_id ?? null,
      assignedUserName: names.find((v) => v.id === value?.assigned_user_id)?.label ?? null,
      dueAt: date(value?.internal_due_at),
      escalationUserId: value?.escalation_user_id ?? null,
      escalationUserName: names.find((v) => v.id === value?.escalation_user_id)?.label ?? null,
      escalationDelayMinutes: value?.escalation_delay_minutes ?? null,
      canManage,
      candidates,
      candidatesTruncated: members.length > 100,
      assignmentNotifiedAt: date(value?.assignment_notified_at),
      dueNotifiedAt: date(value?.due_notified_at),
      escalationNotifiedAt: date(value?.escalation_notified_at),
      nextCheckAt: date(value?.attention_next_at),
      lastError: value?.attention_last_error ?? null,
      canResume: canManage && Boolean(value?.assigned_user_id) && value?.attention_next_at === null,
    });
  }
}
