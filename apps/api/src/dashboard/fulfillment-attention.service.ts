import { ConflictException, Inject, Injectable, Optional } from "@nestjs/common";
import type { SecretVault } from "@yummyai/ai-core";
import { authorize, ForbiddenError, Permission } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import { fulfillmentAttentionSources, FulfillmentAttentionQuerySchema, FulfillmentAttentionViewSchema,
  type FulfillmentAttentionSource, type FulfillmentAttentionItem } from "@yummyai/contracts/operations/fulfillment-attention";
import { withTenant, type DatabaseConnection } from "@yummyai/database";
import { currentOrderAuthority, factoryErpVoidSummarySql } from "@yummyai/order-core";
import { sql, type SQL } from "drizzle-orm";
import { DATABASE_CONNECTION, ORDER_PII_VAULT } from "../platform.tokens.js";
import { factoryErpProgress } from "../orders/factory-erp-projection.js";

const pageSize = 12 as const;
/** A read projection of existing business state. It never dispatches or changes tasks. */
@Injectable()
export class FulfillmentAttentionService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    // Optional only for existing direct constructions. The application provides
    // this token; an unavailable vault never turns a SQL hint into an ERP fact.
    @Optional() @Inject(ORDER_PII_VAULT) private readonly vault?: SecretVault,
  ) {}

  async workspace(context: TenantContext, raw: unknown, now = new Date()) {
    authorize(context, Permission.DashboardRead);
    const query = FulfillmentAttentionQuerySchema.parse(raw), allowed = attentionSources(context);
    if (query.source !== "all" && !allowed.includes(query.source)) throw new ForbiddenError(Permission.OrderRead, "outside_data_scope");
    const sources = fulfillmentAttentionSources.map(source => ({ source, available: allowed.includes(source), count: allowed.includes(source) ? 0 : null }));
    if (!allowed.length) return FulfillmentAttentionViewSchema.parse({ ...query, generatedAt: now.toISOString(), pageSize, total: 0, hasMore: false, sources, items: [] });
    const data = await withTenant(this.database.db, context, async tx => {
      // The original order authority distinguishes live membership credentials
      // from legacy direct adapters by permissionScopes. Adapters retain only
      // their existing feedback projection, including its counts and ordering.
      const factoryProgressEligible = context.permissionScopes !== undefined;
      if (allowed.includes("delivery")) await currentOrderAuthority(tx, context,
        [Permission.DashboardRead, Permission.OrderRead, Permission.OrderPiiRead, Permission.DesignRead, Permission.AssetRead],
        { lock: false, requireMembership: factoryProgressEligible });
      const branches = allowed.map(source => sourceQuery(source, now, factoryProgressEligible, !!this.vault));
      const result = await tx.execute(sql`
      with raw_attention as (${sql.join(branches, sql` union all `)}),
      attention as (select * from raw_attention a where not (a.source = 'production' and a.status = 'failed' and exists
        (select 1 from raw_attention d where d.source = 'delivery' and d.status = 'rejected' and d.production_id = a.production_id))),
      filtered as (select * from attention where ${query.source === "all" ? sql`true` : sql`source = ${query.source}`})
      select (select count(*)::int from filtered) as total,
        (select coalesce(jsonb_object_agg(source, n), '{}'::jsonb) from (select source, count(*)::int n from attention group by source) c) as counts,
        (select coalesce(jsonb_agg(r order by r.priority, r.sort_at, r.source, r.id), '[]'::jsonb) from
          (select * from filtered order by priority, sort_at, source, id limit ${pageSize} offset ${(query.page - 1) * pageSize}) r) as items
      `);
      const selected = result[0] as unknown as { total: number; counts: Partial<Record<FulfillmentAttentionSource, number>>; items: AttentionRow[] };
      const items: FulfillmentAttentionItem[] = [];
      for (const row of selected.items) {
        if (row.source !== "delivery") { items.push(attentionItem(row)); continue; }
        const progress = this.vault && row.has_factory_observation ? await factoryErpProgress(tx, this.vault, row.id) : undefined;
        // Counts and page selection come from the same snapshot. If an original
        // source expires during the read, fail closed rather than drop a row or
        // publish a different total after pagination.
        if (row.has_factory_observation && this.vault && (!progress || progress.bindingReleased))
          throw new ConflictException("工厂状态来源已变化 请刷新履约待办后核对");
        items.push(attentionItem(row, progress));
      }
      return { ...selected, items };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
    for (const source of sources) if (source.available) source.count = data.counts[source.source] ?? 0;
    return FulfillmentAttentionViewSchema.parse({ ...query, generatedAt: now.toISOString(), pageSize, sources, total: data.total,
      hasMore: query.page * pageSize < data.total, items: data.items });
  }
}

export function attentionSources(context: TenantContext): FulfillmentAttentionSource[] {
  if (context.dataScope !== "tenant" || ![Permission.OrderRead, Permission.OrderPiiRead].every(p => context.permissions.includes(p))) return [];
  return context.permissions.includes(Permission.DesignRead) && context.permissions.includes(Permission.AssetRead)
    ? [...fulfillmentAttentionSources] : ["logistics", "production"];
}

// Only projected identifiers, states and timestamps are selected: no addresses,
// encrypted envelopes, free-form carrier errors or private production files.
function sourceQuery(source: FulfillmentAttentionSource, now: Date, factoryProgressEligible: boolean, factoryStatusAvailable: boolean): SQL {
  const timestamp = now.toISOString();
  if (source === "logistics") return sql`
    select 'logistics'::text source, t.id, t.order_id, null::uuid line_id, null::uuid package_id, null::uuid production_id, t.status,
      case when t.status in ('attention','reconciliation_required','purchasing','label_requesting') then 0 else 2 end priority,
      null::timestamptz due_at, t.updated_at, t.updated_at sort_at,
      false submitted, false has_factory_observation, false factory_void_requires_review
    from logistics_tasks t
    where t.status in ('pending','quoted','attention','reconciliation_required','purchasing','created','label_requesting')
      and (t.lease_until is null or t.lease_until <= ${timestamp}::timestamptz)`;
  if (source === "production") return sql`
    select 'production'::text source, p.id, p.order_id, p.order_line_id line_id, null::uuid package_id, p.id production_id, p.status,
      case when p.status in ('quality_hold','failed','cancel_requested') then 0 else 1 end priority,
      p.expected_completion_at due_at, p.updated_at, p.expected_completion_at sort_at,
      false submitted, false has_factory_observation, false factory_void_requires_review
    from production_orders p join orders o on o.id = p.order_id
    where (p.status in ('quality_hold','failed','cancel_requested') or
      (p.status in ('planned','submitted','acknowledged','in_production') and p.expected_completion_at < ${timestamp}::timestamptz))
      and (o.side_state is distinct from 'cancelled' or p.status = 'cancel_requested')
      and o.address_status <> 'anonymized'
      and not exists (select 1 from production_orders child where child.parent_production_order_id = p.id and child.status not in ('cancelled','failed'))`;
  return sql`
    select 'delivery'::text source, d.id, d.order_id, d.line_id, d.package_id, d.production_id, d.status,
      case when d.status = 'rejected' or d.factory_void_requires_review or (${!factoryStatusAvailable} and d.has_factory_observation) then 0
        when d.due_at < ${timestamp}::timestamptz then 1 else 2 end priority,
      d.due_at, d.updated_at, d.due_at sort_at, d.submitted, d.has_factory_observation, d.factory_void_requires_review
    from (
      select distinct on (p.id) i.id, p.order_id, p.order_line_id line_id, i.package_id, p.id production_id,
        coalesce(f.kind, 'pending') status, p.expected_completion_at due_at, coalesce(f.recorded_at, k.created_at) updated_at,
        exists(select 1 from production_delivery_feedback sent where sent.item_id=i.id and sent.kind='submitted') submitted,
        ${factoryProgressEligible ? sql`exists(select 1 from factory_erp_observations observed where observed.binding_id=erp_binding.id and observed.tenant_id=erp_binding.tenant_id)` : sql`false`} has_factory_observation,
        ${factoryProgressEligible && factoryStatusAvailable ? sql`coalesce((erp_void.summary->>'pending')::int,0)>0 or coalesce((erp_void.summary->>'requiresOrderHandling')::int,0)>0` : sql`false`} as factory_void_requires_review
      from production_delivery_items i join production_delivery_packages k on k.id = i.package_id
      join production_orders p on p.id = i.production_order_id
      join production_order_versions v on v.id = i.production_version_id and v.production_order_id = p.id and v.version_number = p.current_version_number
      join orders o on o.id = p.order_id
      join order_work_items w on w.id = p.source_work_item_id
      left join lateral (select kind, recorded_at from production_delivery_feedback where item_id = i.id and kind <> 'rework' order by sequence desc limit 1) f on true
      ${factoryProgressEligible ? sql`left join lateral (select b.id,b.tenant_id from factory_erp_binding_items bi
        join factory_erp_bindings b on b.tenant_id=bi.tenant_id and b.id=bi.binding_id
        where bi.delivery_item_id=i.id and bi.released_by is null and b.released_by is null
        order by b.created_at desc,b.id desc limit 1) erp_binding on true` : sql``}
      ${factoryProgressEligible && factoryStatusAvailable ? sql`left join lateral (select ${factoryErpVoidSummarySql(sql`erp_binding.tenant_id`, sql`erp_binding.id`)} as summary) erp_void on true` : sql``}
      where p.status not in ('cancelled','cancel_requested') and (p.status <> 'failed' or f.kind = 'rejected') and o.side_state is null and o.address_status <> 'anonymized'
        and w.encrypted_data_key is not null and w.expires_at > ${timestamp}::timestamptz and w.archived_at is null and not w.held
        and w.artwork = 'approved' and w.approved_editor_version_id = v.source_editor_version_id and w.pushed_revision_id = v.source_work_revision_id
        and not exists (select 1 from production_orders child where child.parent_production_order_id = p.id and child.status not in ('cancelled','failed'))
      order by p.id, k.created_at desc, k.id desc
    ) d where d.status in ('pending','submitted','received','rejected') or d.factory_void_requires_review`;
}

type AttentionRow = { source: FulfillmentAttentionSource; id: string; order_id: string; line_id: string | null;
  package_id: string | null; status: string; priority: number; due_at: string | null; updated_at: string;
  submitted?: boolean; has_factory_observation?: boolean; factory_void_requires_review?: boolean };
type FactoryProgress = Awaited<ReturnType<typeof factoryErpProgress>>;
export function attentionItem(row: AttentionRow, factory?: FactoryProgress): FulfillmentAttentionItem {
  if (row.source === "delivery") row = deliveryAttentionRow(row, factory);
  const priority = row.priority === 0 ? "blocked" : row.priority === 1 ? "overdue" : "pending";
  const details = row.source === "logistics" ? logisticsCopy(row.status) : row.source === "delivery" ? deliveryCopy(row.status) : productionCopy(row.status);
  const href = row.source === "logistics" ? `/logistics?task=${row.id}`
    : `/production?order=${row.order_id}&line=${row.line_id}${row.package_id ? `&delivery=${row.package_id}` : ""}`;
  return { id: `${row.source}:${row.id}`, source: row.source, entityId: row.id, orderId: row.order_id, status: row.status,
    title: `${details[0]} · ${row.id.slice(-8)}`, reason: details[1], nextAction: details[2], href, priority,
    dueAt: row.due_at ? new Date(row.due_at).toISOString() : null, updatedAt: new Date(row.updated_at).toISOString() };
}
function deliveryAttentionRow(row: AttentionRow, factory: FactoryProgress | undefined): AttentionRow {
  let status = row.status;
  if (row.has_factory_observation && factory === undefined) status = "factory_status_unavailable";
  else if (factory && !factory.bindingReleased && factory.exception === "voided_requires_review") status = "factory_voided_requires_review";
  else if (factory && !factory.bindingReleased && (factory.voidSummary?.requiresOrderHandling ?? 0) > 0) status = "factory_voided_requires_handling";
  else if (status !== "rejected") {
    if (factory && !factory.bindingReleased && factory.status === "shipped") status = "factory_shipped";
    else if (factory && !factory.bindingReleased && factory.status === "scheduled") status = "factory_scheduled";
    else if (status === "submitted" || row.submitted) status = "scheduled_by_submission";
    else if (status === "received") status = "legacy_received";
  }
  const updated = factory && !factory.bindingReleased && Date.parse(factory.recordedAt) > Date.parse(row.updated_at)
    ? factory.recordedAt : row.updated_at;
  return { ...row, status, updated_at: updated };
}
function logisticsCopy(status: string) {
  if (["reconciliation_required", "purchasing", "label_requesting"].includes(status)) return ["物流结果待核对", "查单确认原请求结果，沿用原物流任务处理", "核对原任务"] as const;
  if (status === "attention") return ["物流需要处理", "核对预算、渠道、时效或费用异常", "查看原因"] as const;
  if (status === "created") return ["面单待准备", "物流订单已确认，继续核对面单获取结果", "核对面单"] as const;
  if (status === "quoted") return ["询价等待处理", "已有报价，核对固定规则及自动购单配置", "查看报价"] as const;
  return ["物流任务待执行", "核对已固定的包裹、发货工厂与时效要求", "查看物流任务"] as const;
}
function productionCopy(status: string) {
  if (status === "cancel_requested") return ["生产取消待确认", "核对工厂的实际取消结果并登记凭证", "核对取消结果"] as const;
  if (status === "quality_hold") return ["生产质检待处理", "查看质检问题，按原生产记录处理返工或复检", "处理质检"] as const;
  if (status === "failed") return ["生产异常待处理", "核对失败证据与返工安排", "查看生产记录"] as const;
  return ["生产超过预计交期", "核对实际进度与完工时间，登记工厂提供的证据", "核对生产进度"] as const;
}
function deliveryCopy(status: string) {
  if (status === "rejected") return ["工厂拒收待处理", "核对拒收原因及对应文件版本，决定改稿或返工", "处理拒收"] as const;
  if (status === "factory_voided_requires_review") return ["工厂作废待核对", "工厂表出现已作废记录，请核对原绑定与异常；订单和发货记录保持原状态", "核对工厂作废"] as const;
  if (status === "factory_voided_requires_handling") return ["工厂作废待处理", "已确认工厂作废，请按原异常处理订单、生产或补做安排", "处理作废异常"] as const;
  if (status === "factory_status_unavailable") return ["工厂状态待核对", "当前无法核验工厂状态，请查看原交付记录后重试", "核对原交付记录"] as const;
  if (status === "factory_shipped") return ["工厂已发货", "工厂表已确认发货，继续核对实际交运数量、物流凭证与平台确认", "核对实际发货"] as const;
  if (status === "factory_scheduled") return ["工厂已排产", "工厂表已确认排产，后续通过 Excel 或 CSV 同步工厂进度", "同步工厂进度"] as const;
  if (status === "scheduled_by_submission") return ["已排产 · 按提交默认", "正式文件已登记提交成功，后续通过 Excel 或 CSV 跟进工厂进度", "同步工厂进度"] as const;
  if (status === "legacy_received") return ["工厂文件已收件", "原收件回执已保留，后续通过 Excel 或 CSV 跟进工厂进度", "同步工厂进度"] as const;
  return ["交付包待提交", "核对正式文件和物流资料，上传工厂 ERP 后登记提交结果", "打开交付包"] as const;
}
