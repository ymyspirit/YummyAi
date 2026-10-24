import { Inject, Injectable } from "@nestjs/common";
import { authorize, ForbiddenError, Permission } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import { fulfillmentAttentionSources, FulfillmentAttentionQuerySchema, FulfillmentAttentionViewSchema,
  type FulfillmentAttentionSource, type FulfillmentAttentionItem } from "@yummyai/contracts/operations/fulfillment-attention";
import { withTenant, type DatabaseConnection } from "@yummyai/database";
import { sql, type SQL } from "drizzle-orm";
import { DATABASE_CONNECTION } from "../platform.tokens.js";

const pageSize = 12 as const;
/** A read projection of existing business state. It never dispatches or decrypts tasks. */
@Injectable()
export class FulfillmentAttentionService {
  constructor(@Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection) {}

  async workspace(context: TenantContext, raw: unknown, now = new Date()) {
    authorize(context, Permission.DashboardRead);
    const query = FulfillmentAttentionQuerySchema.parse(raw), allowed = attentionSources(context);
    if (query.source !== "all" && !allowed.includes(query.source)) throw new ForbiddenError(Permission.OrderRead, "outside_data_scope");
    const sources = fulfillmentAttentionSources.map(source => ({ source, available: allowed.includes(source), count: allowed.includes(source) ? 0 : null }));
    if (!allowed.length) return FulfillmentAttentionViewSchema.parse({ ...query, generatedAt: now.toISOString(), pageSize, total: 0, hasMore: false, sources, items: [] });
    const branches = allowed.map(source => sourceQuery(source, now));
    const result = await withTenant(this.database.db, context, tx => tx.execute(sql`
      with raw_attention as (${sql.join(branches, sql` union all `)}),
      attention as (select * from raw_attention a where not (a.source = 'production' and a.status = 'failed' and exists
        (select 1 from raw_attention d where d.source = 'delivery' and d.status = 'rejected' and d.production_id = a.production_id))),
      filtered as (select * from attention where ${query.source === "all" ? sql`true` : sql`source = ${query.source}`})
      select (select count(*)::int from filtered) as total,
        (select coalesce(jsonb_object_agg(source, n), '{}'::jsonb) from (select source, count(*)::int n from attention group by source) c) as counts,
        (select coalesce(jsonb_agg(r order by r.priority, r.sort_at, r.source, r.id), '[]'::jsonb) from
          (select * from filtered order by priority, sort_at, source, id limit ${pageSize} offset ${(query.page - 1) * pageSize}) r) as items
    `));
    const data = result[0] as unknown as { total: number; counts: Partial<Record<FulfillmentAttentionSource, number>>; items: AttentionRow[] };
    for (const source of sources) if (source.available) source.count = data.counts[source.source] ?? 0;
    return FulfillmentAttentionViewSchema.parse({ ...query, generatedAt: now.toISOString(), pageSize, sources, total: data.total,
      hasMore: query.page * pageSize < data.total, items: data.items.map(item => attentionItem(item)) });
  }
}

export function attentionSources(context: TenantContext): FulfillmentAttentionSource[] {
  if (context.dataScope !== "tenant" || ![Permission.OrderRead, Permission.OrderPiiRead].every(p => context.permissions.includes(p))) return [];
  return context.permissions.includes(Permission.DesignRead) && context.permissions.includes(Permission.AssetRead)
    ? [...fulfillmentAttentionSources] : ["logistics", "production"];
}

// Only projected identifiers, states and timestamps are selected: no addresses,
// encrypted envelopes, free-form carrier errors or private production files.
function sourceQuery(source: FulfillmentAttentionSource, now: Date): SQL {
  const timestamp = now.toISOString();
  if (source === "logistics") return sql`
    select 'logistics'::text source, t.id, t.order_id, null::uuid line_id, null::uuid package_id, null::uuid production_id, t.status,
      case when t.status in ('attention','reconciliation_required','purchasing','label_requesting') then 0 else 2 end priority,
      null::timestamptz due_at, t.updated_at, t.updated_at sort_at
    from logistics_tasks t
    where t.status in ('pending','quoted','attention','reconciliation_required','purchasing','created','label_requesting')
      and (t.lease_until is null or t.lease_until <= ${timestamp}::timestamptz)`;
  if (source === "production") return sql`
    select 'production'::text source, p.id, p.order_id, p.order_line_id line_id, null::uuid package_id, p.id production_id, p.status,
      case when p.status in ('quality_hold','failed','cancel_requested') then 0 else 1 end priority,
      p.expected_completion_at due_at, p.updated_at, p.expected_completion_at sort_at
    from production_orders p join orders o on o.id = p.order_id
    where (p.status in ('quality_hold','failed','cancel_requested') or
      (p.status in ('planned','submitted','acknowledged','in_production') and p.expected_completion_at < ${timestamp}::timestamptz))
      and (o.side_state is distinct from 'cancelled' or p.status = 'cancel_requested')
      and o.address_status <> 'anonymized'
      and not exists (select 1 from production_orders child where child.parent_production_order_id = p.id and child.status not in ('cancelled','failed'))`;
  return sql`
    select 'delivery'::text source, d.id, d.order_id, d.line_id, d.package_id, d.production_id, d.status,
      case when d.status = 'rejected' then 0 when d.due_at < ${timestamp}::timestamptz then 1 else 2 end priority,
      d.due_at, d.updated_at, d.due_at sort_at
    from (
      select distinct on (p.id) i.id, p.order_id, p.order_line_id line_id, i.package_id, p.id production_id,
        coalesce(f.kind, 'pending') status, p.expected_completion_at due_at, coalesce(f.recorded_at, k.created_at) updated_at
      from production_delivery_items i join production_delivery_packages k on k.id = i.package_id
      join production_orders p on p.id = i.production_order_id
      join production_order_versions v on v.id = i.production_version_id and v.production_order_id = p.id and v.version_number = p.current_version_number
      join orders o on o.id = p.order_id
      join order_work_items w on w.id = p.source_work_item_id
      left join lateral (select kind, recorded_at from production_delivery_feedback where item_id = i.id and kind <> 'rework' order by sequence desc limit 1) f on true
      where p.status not in ('cancelled','cancel_requested') and (p.status <> 'failed' or f.kind = 'rejected') and o.side_state is null and o.address_status <> 'anonymized'
        and w.encrypted_data_key is not null and w.expires_at > ${timestamp}::timestamptz and w.archived_at is null and not w.held
        and w.artwork = 'approved' and w.approved_editor_version_id = v.source_editor_version_id and w.pushed_revision_id = v.source_work_revision_id
        and not exists (select 1 from production_orders child where child.parent_production_order_id = p.id and child.status not in ('cancelled','failed'))
      order by p.id, k.created_at desc, k.id desc
    ) d where d.status in ('pending','submitted','received','rejected')`;
}

type AttentionRow = { source: FulfillmentAttentionSource; id: string; order_id: string; line_id: string | null;
  package_id: string | null; status: string; priority: number; due_at: string | null; updated_at: string };
export function attentionItem(row: AttentionRow): FulfillmentAttentionItem {
  const priority = row.priority === 0 ? "blocked" : row.priority === 1 ? "overdue" : "pending";
  const details = row.source === "logistics" ? logisticsCopy(row.status) : row.source === "delivery" ? deliveryCopy(row.status) : productionCopy(row.status);
  const href = row.source === "logistics" ? `/logistics?task=${row.id}`
    : `/production?order=${row.order_id}&line=${row.line_id}${row.package_id ? `&delivery=${row.package_id}` : ""}`;
  return { id: `${row.source}:${row.id}`, source: row.source, entityId: row.id, orderId: row.order_id, status: row.status,
    title: `${details[0]} · ${row.id.slice(-8)}`, reason: details[1], nextAction: details[2], href, priority,
    dueAt: row.due_at ? new Date(row.due_at).toISOString() : null, updatedAt: new Date(row.updated_at).toISOString() };
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
  if (status === "received") return ["等待工厂接受", "工厂已收到文件，继续核对接受结果", "登记接受结果"] as const;
  if (status === "submitted") return ["等待工厂收件", "已登记提交，核对工厂实际收到文件的凭证", "核对收件"] as const;
  return ["交付包待提交", "核对正式文件和物流资料，上传工厂 ERP 后登记提交结果", "打开交付包"] as const;
}
