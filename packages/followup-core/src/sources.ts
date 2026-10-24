import { createHash } from "node:crypto";
import { Permission } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import { FollowupSourceSchema, type FollowupSource } from "@yummyai/contracts/operations/followup";
import { orderPrivateSourceAvailable, type TenantTransaction } from "@yummyai/database";
import { sql, type SQL } from "drizzle-orm";

export class FollowupError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export function followupEnabled(tenantId: string) {
  return (process.env.BUSINESS_FOLLOWUP_TENANT_IDS ?? "")
    .split(",")
    .map((v) => v.trim())
    .some((v) => v === "*" || v === tenantId);
}
const privacy = orderPrivateSourceAvailable(sql`o.id`);
const firstLine = sql`(select l.id from order_lines l where l.order_id=o.id order by l.id limit 1)`;
const procurement = sql`with base as (
 select p.*,s.name as supplier_name,v.id as version_id,v.checksum as version_checksum,v.line_snapshot,
  coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'variance',r.has_variance,'lines',
    (select jsonb_agg(jsonb_build_object('key',rl.line_key,'received',rl.received_quantity,'rejected',rl.rejected_quantity) order by rl.id) from inventory_procurement_receipt_lines rl where rl.receipt_id=r.id)) order by r.id)
    from inventory_procurement_receipts r where r.purchase_order_id=p.id),'[]'::jsonb) as receipts,
  coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'status',i.status,'currency',i.currency,'variance',i.variance_minor,'lines',
    (select jsonb_agg(jsonb_build_object('key',il.line_key,'quantity',il.invoiced_quantity,'unitCost',il.unit_cost_minor) order by il.id) from inventory_supplier_invoice_lines il where il.invoice_id=i.id)) order by i.id)
    from inventory_supplier_invoices i where i.purchase_order_id=p.id),'[]'::jsonb) as invoices,
  (exists(select 1 from inventory_supplier_invoices i where i.purchase_order_id=p.id)
    and not exists(select 1 from inventory_supplier_invoices i where i.purchase_order_id=p.id and i.status<>'matched')
    and not exists(select 1 from jsonb_array_elements(v.line_snapshot) line where
      (select coalesce(sum(il.invoiced_quantity),0) from inventory_supplier_invoice_lines il join inventory_supplier_invoices i on i.id=il.invoice_id where i.purchase_order_id=p.id and il.line_key=line->>'lineKey')<>(line->>'quantity')::int)) as invoiced,
  (select count(*)::int from inventory_supplier_invoices i where i.purchase_order_id=p.id and i.status='reconciliation_required') as invoice_issues,
  (select max(i.created_at) from inventory_supplier_invoices i where i.purchase_order_id=p.id) as last_invoice_at
 from inventory_purchase_orders p join fulfillment_suppliers s on s.id=p.supplier_id
 left join inventory_purchase_order_versions v on v.purchase_order_id=p.id and v.version_number=p.current_version
), prepared as (select b.*,
 (archived_at is not null or status='cancelled' or status='received' and version_id is not null and invoiced) as closed,
 case when archived_at is not null then 'archived' when status='cancelled' then 'cancelled'
  when version_id is null then 'missing_version' when status='draft' then 'review'
  when status='rejected' then 'revise' when status='reconciliation_required' then 'reconcile'
  when status='received' and invoiced then 'complete' when status='received' then 'invoice' else 'receipt' end as task
 from base b)
 select id,code as label,supplier_name as "contextLabel",null::uuid as "parentOrderId",null::uuid as "parentLineId",
 status,current_version as "businessVersion",expected_at as "businessDueAt",version_id is not null as available,
 closed as "isClosed",(status in ('rejected','reconciliation_required') or version_id is null or status='received' and jsonb_array_length(invoices)>0 and not invoiced) as "needsAttention",
 (invoice_issues+case when status in ('rejected','reconciliation_required') or version_id is null or status='received' and jsonb_array_length(invoices)>0 and not invoiced then 1 else 0 end)::int as "issueCount",
 task as "taskKey",case task when 'archived' then '采购单已归档' when 'cancelled' then '采购单已取消'
  when 'missing_version' then '核对采购版本' when 'review' then '跟进采购审核' when 'revise' then '修订被退回的采购'
  when 'reconcile' then '核对收货与发票差异' when 'complete' then '采购收货与发票已核对'
  when 'invoice' then '核对供应商发票' else '跟进采购到货与收货' end as title,
 greatest(updated_at,last_invoice_at) as "updatedAt",
 jsonb_build_object('id',id,'status',status,'archived',archived_at,'version',version_id,'checksum',version_checksum,'due',expected_at,'receipts',receipts,'invoices',invoices) as fingerprint
 from prepared`;
const cases = sql`select c.id,o.external_order_id as label,c.type as "contextLabel",o.id as "parentOrderId",${firstLine} as "parentLineId",
 c.status,c.current_decision_version as "businessVersion",null::timestamptz as "businessDueAt",(${privacy}) as available,
 (c.status in ('resolved','cancelled')) as "isClosed",c.status='awaiting_internal' as "needsAttention",case when c.status='awaiting_internal' then 1 else 0 end as "issueCount",
 c.status as "taskKey",case c.status when 'resolved' then '售后已结案' when 'cancelled' then '售后已取消'
  when 'awaiting_customer' then '跟进客户补充资料' when 'awaiting_internal' then '协调售后内部处理'
  when 'approved' then '核对已批准方案的实际执行' when 'rejected' then '登记实际处理与结案依据' else '核对售后诉求' end as title,
 greatest(c.updated_at,o.updated_at,(select max(x.recorded_at) from customer_contact_records x where x.case_id=c.id),
  (select max(r.updated_at) from return_shipments r where r.case_id=c.id)) as "updatedAt",
 jsonb_build_object('id',c.id,'status',c.status,'decisionVersion',c.current_decision_version,'summary',c.summary_checksum,'orderSequence',o.latest_event_sequence,'address',o.address_status,
  'contacts',(select jsonb_agg(jsonb_build_object('id',x.id,'checksum',x.body_checksum) order by x.id) from customer_contact_records x where x.case_id=c.id),
  'decisions',(select jsonb_agg(jsonb_build_object('id',d.id,'version',d.version_number,'resolution',d.resolution,'checksum',d.reason_checksum) order by d.id) from after_sales_decisions d where d.case_id=c.id),
  'returns',(select jsonb_agg(jsonb_build_object('id',r.id,'status',r.status,'updated',r.updated_at) order by r.id) from return_shipments r where r.case_id=c.id),
  'replacement',(select array_agg(r.id order by r.id) from replacement_order_links r where r.case_id=c.id),
  'evidence',(select array_agg(e.id order by e.id) from after_sales_responsibility_evidence e where e.case_id=c.id)) as fingerprint
 from after_sales_cases c join orders o on o.id=c.order_id`;
const exceptions = sql`select e.id,o.external_order_id as label,e.category as "contextLabel",o.id as "parentOrderId",${firstLine} as "parentLineId",
 coalesce(last.status,'open') as status,coalesce(last.sequence,0) as "businessVersion",null::timestamptz as "businessDueAt",(${privacy}) as available,
 coalesce(last.status='resolved',false) as "isClosed",coalesce(last.status,'open')='open' as "needsAttention",
 case when coalesce(last.status,'open')='open' then 1 else 0 end as "issueCount",
 coalesce(last.status,'open') as "taskKey",case when last.status='resolved' then '订单异常已解决' else '核对独立订单异常' end as title,
 greatest(e.opened_at,last.occurred_at,o.updated_at) as "updatedAt",
 jsonb_build_object('id',e.id,'category',e.category,'event',last.id,'sequence',last.sequence,'status',coalesce(last.status,'open'),'orderSequence',o.latest_event_sequence,'address',o.address_status) as fingerprint
 from order_exceptions e join orders o on o.id=e.order_id
 left join lateral(select ev.id,ev.sequence,ev.status,ev.occurred_at from order_exception_events ev where ev.exception_id=e.id order by ev.sequence desc limit 1) last on true`;

export function followupAdapter(raw: unknown) {
  const kind = FollowupSourceSchema.parse(raw),
    purchase = kind === "procurement_order";
  return {
    kind,
    table: purchase
      ? "procurement_order_followups"
      : kind === "after_sales_case"
        ? "after_sales_case_followups"
        : "order_exception_followups",
    sourceTable: purchase
      ? "inventory_purchase_orders"
      : kind === "after_sales_case"
        ? "after_sales_cases"
        : "order_exceptions",
    projection: purchase ? procurement : kind === "after_sales_case" ? cases : exceptions,
    read: purchase ? [Permission.ProcurementRead] : [Permission.OrderRead, Permission.OrderPiiRead],
    write: purchase ? Permission.ProcurementWrite : Permission.OrderWrite,
    assign: purchase ? Permission.ProcurementAssign : Permission.OrderAssign,
  };
}
export type FollowupAdapter = ReturnType<typeof followupAdapter>;
export type FollowupSourceRecord = {
  id: string;
  source: FollowupSource;
  label: string;
  contextLabel: string;
  parentOrderId: string | null;
  parentLineId: string | null;
  status: string;
  businessVersion: number;
  businessDueAt: string | null;
  available: boolean;
  isClosed: boolean;
  needsAttention: boolean;
  issueCount: number;
  taskKey: string;
  title: string;
  updatedAt: string;
  sourceChecksum: string;
};
export function sourceRecord(
  adapter: FollowupAdapter,
  row: Record<string, unknown>,
): FollowupSourceRecord {
  const { fingerprint, ...value } = row;
  if (!fingerprint || typeof fingerprint !== "object")
    throw new Error("Follow-up source fingerprint missing");
  return {
    ...value,
    source: adapter.kind,
    businessDueAt:
      row.businessDueAt == null ? null : new Date(row.businessDueAt as string).toISOString(),
    updatedAt: new Date(row.updatedAt as string).toISOString(),
    sourceChecksum: createHash("sha256")
      .update(
        JSON.stringify({
          fingerprint,
          available: row.available,
          isClosed: row.isClosed,
          taskKey: row.taskKey,
        }),
      )
      .digest("hex"),
  } as FollowupSourceRecord;
}
export async function readFollowupSource(
  tx: TenantTransaction,
  adapter: FollowupAdapter,
  id: string,
) {
  const rows = await tx.execute<Record<string, unknown>>(
    sql`with v as (${adapter.projection}) select * from v where id=${id}`,
  );
  if (!rows[0]) throw new FollowupError(404, "跟进对象不存在或不在当前范围内");
  return sourceRecord(adapter, rows[0]);
}
/** Match the owning services' locks, then use a mutable parent row, including for immutable exceptions. */
export async function lockFollowupSource(
  tx: TenantTransaction,
  context: TenantContext,
  adapter: FollowupAdapter,
  id: string,
  tryOnly = false,
) {
  const initial = await tx.execute<{ id: string; order_id?: string }>(
    sql`select id${adapter.kind === "procurement_order" ? sql`` : sql`,order_id`} from ${sql.identifier(adapter.sourceTable)} where id=${id}`,
  );
  if (!initial[0]) return false;
  const orderId = initial[0].order_id,
    key =
      adapter.kind === "procurement_order"
        ? `procurement-order:${context.tenantId}:${id}`
        : adapter.kind === "after_sales_case"
          ? `after-sales-case:${id}`
          : orderId!;
  if (tryOnly) {
    const rows = await tx.execute<{ locked: boolean }>(
      sql`select pg_try_advisory_xact_lock(hashtextextended(${key},0)) as locked`,
    );
    if (!rows[0]!.locked) return false;
  } else await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key},0))`);
  const root = adapter.kind === "order_exception" ? "orders" : adapter.sourceTable,
    rootId = adapter.kind === "order_exception" ? orderId! : id;
  const locked = await tx.execute(
    sql`select id from ${sql.identifier(root)} where id=${rootId} for update ${tryOnly ? sql`skip locked` : sql``}`,
  );
  if (!locked.length) return false;
  if (adapter.kind === "after_sales_case") {
    const parent = await tx.execute(
      sql`select id from orders where id=${orderId} for share ${tryOnly ? sql`skip locked` : sql``}`,
    );
    if (!parent.length) return false;
  }
  return true;
}
export function followupTable(adapter: FollowupAdapter): SQL {
  return sql`${sql.identifier(adapter.table)}`;
}
