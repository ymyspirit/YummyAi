import type { TenantContext } from "@yummyai/contracts";
import { FollowupSourceSchema } from "@yummyai/contracts/operations/followup";
import {
  organizations,
  recordNotificationInTransaction,
  withTenant,
  type DatabaseConnection,
  type TenantTransaction,
} from "@yummyai/database";
import { sql } from "drizzle-orm";
import {
  followupAdapter,
  followupEnabled,
  followupTable,
  lockFollowupSource,
  readFollowupSource,
  type FollowupAdapter,
} from "./sources.js";
import { followupRecipient, readArrangement } from "./responsibility.js";

const empty = () => ({ checked: 0, notices: 0, deferred: 0, failures: 0 });
/** Parent locks match each owning service. Notification and checkpoint commit together. */
export class FollowupAttentionDispatcher {
  constructor(
    private readonly database: DatabaseConnection,
    private readonly notify = recordNotificationInTransaction,
  ) {}
  async dispatch() {
    const result = empty();
    for (const tenant of await this.database.db
      .select({ id: organizations.id })
      .from(organizations)) {
      if (!followupEnabled(tenant.id)) continue;
      const context: TenantContext = {
        tenantId: tenant.id,
        userId: "00000000-0000-7000-8000-000000000004",
        permissions: [],
        dataScope: "tenant",
      };
      try {
        const candidates = await withTenant(this.database.db, context, (tx) =>
          tx.execute<{ id: string; source: string }>(sql`
          select id,source from (${sql.join(
            FollowupSourceSchema.options.map((source) => {
              const adapter = followupAdapter(source);
              return sql`select object_id as id,${source}::text as source,attention_next_at as next from ${followupTable(adapter)} where assigned_user_id is not null and attention_next_at<=clock_timestamp()`;
            }),
            sql` union all `,
          )}) v order by next,id,source limit 100`),
        );
        for (const candidate of candidates) {
          const adapter = followupAdapter(candidate.source);
          const counts = await withTenant(this.database.db, context, async (tx) => {
            if (
              !followupEnabled(tenant.id) ||
              !(await lockFollowupSource(tx, context, adapter, candidate.id, true))
            )
              return empty();
            try {
              return await tx.transaction((savepoint) =>
                this.deliver(savepoint, context, adapter, candidate.id),
              );
            } catch {
              await tx.execute(
                sql`update ${followupTable(adapter)} set attention_next_at=clock_timestamp()+interval '5 minutes',attention_last_error='DISPATCH_FAILED' where object_id=${candidate.id}`,
              );
              return { checked: 1, notices: 0, deferred: 1, failures: 1 };
            }
          });
          for (const key of Object.keys(result) as Array<keyof typeof result>)
            result[key] += counts[key];
        }
      } catch {
        result.failures++;
      }
    }
    return result;
  }
  private async deliver(
    tx: TenantTransaction,
    context: TenantContext,
    adapter: FollowupAdapter,
    id: string,
  ) {
    const result = { ...empty(), checked: 1 },
      arrangement = await readArrangement(tx, adapter, id);
    const [clock] = await tx.execute<{ now: Date }>(sql`select clock_timestamp() as now`),
      now = new Date(clock!.now);
    if (
      !arrangement?.assigned_user_id ||
      !arrangement.attention_next_at ||
      new Date(arrangement.attention_next_at) > now
    )
      return empty();
    const current = await readFollowupSource(tx, adapter, id),
      changed = current.sourceChecksum !== arrangement.observed_source_checksum;
    const cycle = arrangement.attention_cycle + (changed ? 1 : 0);
    let assigned = changed ? null : arrangement.assignment_notified_at,
      due = changed ? null : arrangement.due_notified_at,
      escalated = changed ? null : arrangement.escalation_notified_at;
    let error: string | null = current.available ? null : "SOURCE_UNAVAILABLE";
    const active = current.available && !current.isClosed;
    const send = async (userId: string, stage: "assigned" | "due" | "escalated") => {
      const recipient = await followupRecipient(
        tx,
        context.tenantId,
        userId,
        adapter,
        stage !== "escalated",
        true,
      );
      if (!recipient) {
        error = stage === "escalated" ? "ESCALATION_UNAVAILABLE" : "RECIPIENT_UNAVAILABLE";
        return null;
      }
      const notice = await this.notify(tx, recipient, {
        kind: "system",
        title:
          stage === "assigned"
            ? changed
              ? "业务跟进依据已更新"
              : "业务跟进安排已更新"
            : stage === "due"
              ? "业务跟进已到内部截止时间"
              : "业务跟进已逾期 需要核对",
        body: "请打开业务待办 核对当前安排与实际处理进度",
        resourceType: adapter.kind,
        resourceId: id,
        metadata: { assignmentRevision: arrangement.revision, cycle, stage },
        deduplicationKey: `business-followup/${adapter.kind}/${id}/${arrangement.revision}/${cycle}/${stage}`,
      });
      result.notices++;
      return notice.createdAt;
    };
    const deadline = arrangement.internal_due_at ? new Date(arrangement.internal_due_at) : null;
    const escalation =
      deadline && arrangement.escalation_delay_minutes
        ? new Date(deadline.getTime() + arrangement.escalation_delay_minutes * 60000)
        : null;
    if (active) {
      if (deadline && deadline <= now && !due)
        due = await send(arrangement.assigned_user_id, "due");
      else if ((!deadline || deadline > now) && !assigned)
        assigned = await send(arrangement.assigned_user_id, "assigned");
      if (arrangement.escalation_user_id && escalation && escalation <= now && !escalated)
        escalated = await send(arrangement.escalation_user_id, "escalated");
    }
    if (error) result.deferred++;
    const dates = [
      new Date(now.getTime() + 300000),
      ...(active && deadline && deadline > now ? [deadline] : []),
      ...(active && escalation && escalation > now && !escalated ? [escalation] : []),
    ];
    const next = current.available
      ? dates.sort((a, b) => a.getTime() - b.getTime())[0]!.toISOString()
      : null;
    const stamp = (value: Date | null) => (value ? new Date(value).toISOString() : null);
    await tx.execute(
      sql`update ${followupTable(adapter)} set attention_cycle=${cycle},observed_source_checksum=${current.sourceChecksum},attention_next_at=${next}::timestamptz,attention_last_error=${error},assignment_notified_at=${stamp(assigned)}::timestamptz,due_notified_at=${stamp(due)}::timestamptz,escalation_notified_at=${stamp(escalated)}::timestamptz where object_id=${id}`,
    );
    return result;
  }
}
