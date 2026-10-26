import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { authorize, ForbiddenError, Permission, permissionScope } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import { StudioImageBudgetSettingsSchema, StudioImageBudgetWorkspaceSchema, type StudioImageBudgetWorkspace } from "@yummyai/contracts/pod/studio-image-budget";
import { aiBudgetLedger, aiBudgetPolicies, recordAuditInTransaction, withTenant, type DatabaseConnection, type TenantTransaction } from "@yummyai/database";
import { studioImageHash } from "@yummyai/pod-core";
import { eq, sql } from "drizzle-orm";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { currentDesignAuthority } from "./design-access.js";

const invalid = () => new BadRequestException({ code: "studio_image_budget_invalid", message: "请填写完整且精确的组织预算金额" });
const forbidden = () => new ForbiddenException({ code: "studio_image_budget_forbidden", message: "组织预算需要整个组织范围的模型配置权限" });
const changed = () => new ConflictException({ code: "studio_image_budget_changed", message: "组织预算已变化 请重新读取后核对" });
const unavailable = () => new ServiceUnavailableException({ code: "studio_image_budget_unavailable", message: "组织预算暂时无法完整核对 请保留当前设置" });
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export function studioImageBudgetMicros(value: string, maxWhole: 8 | 16 = 8): bigint {
  const pattern = new RegExp(`^(0|[1-9]\\d{0,${maxWhole - 1}})(?:\\.\\d{1,6})?$`);
  if (!pattern.test(value)) throw invalid();
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}
const decimal = (value: bigint) => `${value / 1_000_000n}.${String(value % 1_000_000n).padStart(6, "0")}`;

/** JSON stores this one cap as a number, but conversion must preserve every micro. */
export function studioImageBudgetJsonCap(value: string): number {
  const expected = studioImageBudgetMicros(value), numeric = Number(value);
  if (!Number.isFinite(numeric) || studioImageBudgetMicros(String(numeric)) !== expected) throw invalid();
  return numeric;
}

/** SQL supplies jsonb's canonical, lossless text for the complete policy except
 * updated_at, which is separately normalized to UTC without losing microseconds.
 * Never round-trip unknown task caps through JavaScript before hashing them. */
export function studioImageBudgetPolicyRevision(value: { policySql: string; updatedAtSql: string } | null): string | null {
  return value === null ? null : studioImageHash({ version: 1, policySql: value.policySql, updatedAtSql: value.updatedAtSql });
}

export function studioImageBudgetCapView(taskCaps: unknown, defaultTaskCapUsd: string, imageCapSql?: string | null): {
  imageTaskCapUsd: string | null; imageCapSource: "specific" | "default" | "invalid";
} {
  if (!object(taskCaps)) return { imageTaskCapUsd: null, imageCapSource: "invalid" };
  if (!Object.prototype.hasOwnProperty.call(taskCaps, "studio_image"))
    return { imageTaskCapUsd: decimal(studioImageBudgetMicros(defaultTaskCapUsd)), imageCapSource: "default" };
  const value = taskCaps.studio_image;
  if (typeof value !== "number" || !Number.isFinite(value)) return { imageTaskCapUsd: null, imageCapSource: "invalid" };
  if (imageCapSql === null) return { imageTaskCapUsd: null, imageCapSource: "invalid" };
  // Read legacy numeric precision from PostgreSQL, where JSON.parse cannot hide
  // a seventh decimal behind its nearest JavaScript number.
  const text = (imageCapSql ?? String(value)).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  try { return { imageTaskCapUsd: decimal(studioImageBudgetMicros(text)), imageCapSource: "specific" }; }
  catch { return { imageTaskCapUsd: null, imageCapSource: "invalid" }; }
}

type Policy = { row: typeof aiBudgetPolicies.$inferSelect; policySql: string; updatedAtSql: string; imageCapSql: string | null };

/** Only organization-wide model administrators can inspect or replace policy.
 * Existing holds, receipts and ledger state remain exclusively with their owners. */
@Injectable()
export class StudioImageBudgetService {
  constructor(@Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection) {}

  private async authority(tx: TenantTransaction, context: TenantContext) {
    const { authority } = await currentDesignAuthority(tx, context, [Permission.ModelConfigure]);
    authorize(authority, Permission.ModelConfigure);
    if (permissionScope(authority, Permission.ModelConfigure) !== "tenant") throw forbidden();
    return authority;
  }
  private async lock(tx: TenantTransaction, tenantId: string) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${tenantId}:ai-assist-budget`},0))`);
  }
  private async policy(tx: TenantTransaction, tenantId: string, mutation = false): Promise<Policy | null> {
    const query = tx.select({ row: aiBudgetPolicies,
      policySql: sql<string>`(to_jsonb(${aiBudgetPolicies})-'updated_at')::text`,
      updatedAtSql: sql<string>`(${aiBudgetPolicies.updatedAt} AT TIME ZONE 'UTC')::text`,
      imageCapSql: sql<string | null>`${aiBudgetPolicies.taskCapsUsd}->>'studio_image'`,
    }).from(aiBudgetPolicies).where(eq(aiBudgetPolicies.tenantId, tenantId));
    const [value] = await (mutation ? query.for("update") : query.for("share"));
    return value ?? null;
  }
  private async view(tx: TenantTransaction, tenantId: string, policy: Policy | null): Promise<StudioImageBudgetWorkspace> {
    const [period] = await tx.execute<{ periodStart: string; periodEnd: string; occupiedUsd: string }>(sql`
      with period as (select date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC') as start_utc)
      select (start_utc AT TIME ZONE 'UTC')::text as "periodStart",
        ((start_utc+interval '1 month') AT TIME ZONE 'UTC')::text as "periodEnd",
        coalesce((select sum(${aiBudgetLedger.amountUsd}) from ${aiBudgetLedger}
          where ${aiBudgetLedger.tenantId}=${tenantId} and ${aiBudgetLedger.state} in ('reserved','committed')
          and ${aiBudgetLedger.createdAt}>=(start_utc AT TIME ZONE 'UTC')
          and ${aiBudgetLedger.createdAt}<((start_utc+interval '1 month') AT TIME ZONE 'UTC')),0)::text as "occupiedUsd"
      from period`);
    if (!period) throw unavailable();
    const start = new Date(period.periodStart), end = new Date(period.periodEnd);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end.getTime() <= start.getTime()) throw unavailable();
    const row = policy?.row;
    return StudioImageBudgetWorkspaceSchema.parse({ version: 1, revision: studioImageBudgetPolicyRevision(policy),
      periodStart: start.toISOString(), periodEnd: end.toISOString(), occupiedUsd: decimal(studioImageBudgetMicros(period.occupiedUsd, 16)),
      policy: row ? { monthlyCapUsd: decimal(studioImageBudgetMicros(row.monthlyCapUsd)),
        defaultTaskCapUsd: decimal(studioImageBudgetMicros(row.defaultTaskCapUsd)),
        ...studioImageBudgetCapView(row.taskCapsUsd, row.defaultTaskCapUsd, policy!.imageCapSql) } : null });
  }
  private async run<T>(context: TenantContext, action: (tx: TenantTransaction, authority: TenantContext) => Promise<T>): Promise<T> {
    try {
      return await withTenant(this.database.db, context, async tx => {
        const authority = await this.authority(tx, context);
        await this.lock(tx, authority.tenantId);
        return action(tx, authority);
      });
    } catch (cause) {
      if (cause instanceof ForbiddenError) throw forbidden();
      if (cause instanceof BadRequestException || cause instanceof ConflictException || cause instanceof ForbiddenException || cause instanceof ServiceUnavailableException) throw cause;
      throw unavailable();
    }
  }
  async workspace(context: TenantContext): Promise<StudioImageBudgetWorkspace> {
    return this.run(context, async (tx, authority) => this.view(tx, authority.tenantId, await this.policy(tx, authority.tenantId)));
  }
  async save(context: TenantContext, settings: unknown): Promise<StudioImageBudgetWorkspace> {
    const parsed = StudioImageBudgetSettingsSchema.safeParse(settings);
    if (!parsed.success) throw invalid();
    const input = parsed.data, imageCap = studioImageBudgetJsonCap(input.imageTaskCapUsd);
    return this.run(context, async (tx, authority) => {
      const previous = await this.policy(tx, authority.tenantId, true), revision = studioImageBudgetPolicyRevision(previous);
      if (input.revision !== revision) throw changed();
      if (previous) {
        // Preserve all other keys and their original JSON numeric precision in SQL.
        if (!object(previous.row.taskCapsUsd)) throw invalid();
        await tx.update(aiBudgetPolicies).set({ monthlyCapUsd: input.monthlyCapUsd, defaultTaskCapUsd: input.defaultTaskCapUsd,
          taskCapsUsd: sql`jsonb_set(${aiBudgetPolicies.taskCapsUsd},'{studio_image}',to_jsonb(${imageCap}::numeric),true)`,
          updatedAt: sql`clock_timestamp()` }).where(eq(aiBudgetPolicies.tenantId, authority.tenantId));
      } else {
        await tx.insert(aiBudgetPolicies).values({ tenantId: authority.tenantId, monthlyCapUsd: input.monthlyCapUsd,
          defaultTaskCapUsd: input.defaultTaskCapUsd, taskCapsUsd: { studio_image: imageCap }, updatedAt: sql`clock_timestamp()` });
      }
      const saved = await this.policy(tx, authority.tenantId);
      if (!saved) throw unavailable();
      const workspace = await this.view(tx, authority.tenantId, saved);
      await recordAuditInTransaction(tx, authority, { action: "studio.image.budget.save", resourceType: "ai_budget_policy",
        resourceId: authority.tenantId, result: "success", metadata: { previousRevision: revision, revision: workspace.revision,
          firstConfiguration: previous === null, fields: ["monthlyCapUsd", "defaultTaskCapUsd", "studio_image"] } });
      return workspace;
    });
  }
}
