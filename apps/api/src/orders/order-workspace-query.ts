import { sql, type SQL } from "drizzle-orm";
import type { OrderWorkQuery } from "@yummyai/contracts/order/workspace";

/** Read projections from existing order, production, shipment and after-sales records. */
const baseProjection = sql`
  select ol.id, o.id as "orderId", o.external_order_id as "externalOrderId", ol.external_line_id as "externalLineId",
    o.account_id as "accountId", ma.display_name as "storeName", o.platform, ol.sku_code as "skuCode", ol.title, ol.quantity,
    o.provider_status as "providerStatus", o.side_state as "sideState", o.placed_at as "placedAt",
    o.created_at as "importedAt", w.archived_at as "archivedAt",
    w.search_design_executor as "designExecutor", spu.code as "spuCode", psv.name as "specificationName",
    (select max(e.occurred_at) from order_work_events e where e.work_item_id=ol.id and e.action='dispatch') as "dispatchedAt",
    coalesce(packages.total,0) as "packageCount", coalesce(packages.labeled,0) as "labeledPackageCount",
    rl.id as "reportLineId", coalesce(w.preparation, 'pending_review') as preparation,
    coalesce(w.artwork, 'not_pushed') as artwork, coalesce(w.proof, 'not_required') as proof,
    coalesce(w.revision, 0) as revision, coalesce(w.projection_version, 0) as "projectionVersion",
    coalesce(w.held, false) as held, w.print_sku as "printSku", w.due_at as "dueAt", w.editor_project_id as "editorProjectId",
    coalesce(w.updated_at, o.updated_at) as "updatedAt",
    (w.id is not null and w.source_version_id is distinct from rl.current_version_id) as "sourceChanged",
    coalesce((select case
      when count(*) = 0 then null
      when bool_or(po.status = 'quality_hold') then 'quality_hold'
      when bool_and(po.status = 'completed') and bool_and(coalesce((select qi.result = 'passed' from quality_inspections qi where qi.production_order_id = po.id order by qi.created_at desc, qi.id desc limit 1),false)) then case when sum(pov.quantity) >= ol.quantity then 'completed' else 'partially_completed' end
      when bool_and(po.status = 'completed') then 'awaiting_quality'
      when bool_or(po.status = 'in_production') then 'in_production'
      when bool_or(po.status = 'acknowledged') then 'acknowledged'
      when bool_or(po.status = 'submitted') then 'submitted'
      when bool_or(po.status = 'cancel_requested') then 'cancel_requested'
      when bool_or(po.status = 'failed') then 'failed' else 'planned' end
      from production_orders po join production_order_versions pov on pov.production_order_id = po.id and pov.version_number = po.current_version_number
      where po.order_line_id = ol.id and po.status <> 'cancelled'
        and not exists(select 1 from production_orders child where child.parent_production_order_id = po.id and child.status <> 'cancelled')),
      case when exists(select 1 from production_orders cancelled where cancelled.order_line_id = ol.id and cancelled.status = 'cancelled') then 'cancelled' else 'not_released' end) as production,
    coalesce((select sum(pv.quantity)::int from production_orders p join production_order_versions pv on pv.production_order_id=p.id and pv.version_number=p.current_version_number
      where p.order_line_id=ol.id and p.status='completed' and (select qi.result from quality_inspections qi where qi.production_order_id=p.id order by qi.created_at desc, qi.id desc limit 1)='passed'
      and not exists(select 1 from production_orders child where child.parent_production_order_id=p.id and child.status<>'cancelled')),0) as "readyQuantity",
    coalesce((select sum(spl.quantity)::int from shipment_package_lines spl
      join shipment_versions sv on sv.id = spl.shipment_version_id join shipments s on s.id = sv.shipment_id
      where spl.order_line_id = ol.id and sv.version_number = s.approved_version_number
        and s.status in ('shipped','in_transit','delivered','exception')),0) as "shippedQuantity",
    (select count(*)::int from after_sales_cases a where a.order_id = o.id and a.status not in ('resolved','cancelled','rejected')) as "afterSalesCount",
    rl.batch_id as "batchId"
  from order_lines ol join orders o on o.id = ol.order_id join marketplace_accounts ma on ma.id = o.account_id
  left join amazon_order_report_lines rl on rl.order_line_id = ol.id left join order_work_items w on w.id = ol.id
  left join product_specification_versions psv on psv.id=w.search_specification_version_id
  left join product_specifications ps on ps.id=psv.specification_id
  left join spus spu on spu.id=ps.spu_id
  left join lateral (
    select count(*)::int as total, count(*) filter(where p.label_asset_id is not null or nullif(trim(p.external_label_id),'') is not null)::int as labeled
    from shipment_package_lines pl join shipment_packages p on p.id=pl.package_id
    join shipments s on s.id=p.shipment_id join shipment_versions sv on sv.id=p.shipment_version_id
    where pl.order_line_id=ol.id and s.status <> 'cancelled' and sv.version_number=s.current_version_number
  ) packages on true`;

export const workProjection = sql`select b.*,
  case when "sideState"='cancelled' then 'cancelled'
    when "shippedQuantity">=quantity then 'shipped'
    when "readyQuantity">"shippedQuantity" then 'ready_to_ship'
    when production not in ('not_released','cancelled') then 'production'
    when artwork='approved' then 'approved'
    when artwork='in_review' then 'in_review'
    when artwork='changes_requested' then 'changes_requested'
    when artwork in ('starting','in_progress') then 'in_progress'
    when artwork='queued' then 'queued'
    when preparation='needs_information' then 'needs_information'
    when preparation in ('ready_to_push','pushed') then 'ready_to_push'
    else 'pending_review' end as "queueStage",
  case when "packageCount"=0 then case when "readyQuantity">"shippedQuantity" then 'unplanned' else 'not_due' end
    when "labeledPackageCount"=0 then 'missing'
    when "labeledPackageCount"<"packageCount" then 'partial' else 'ready' end as "labelStatus"
  from (${baseProjection}) b`;

export function workFilter(q: OrderWorkQuery): SQL {
  const filters: SQL[] = [sql`true`];
  filters.push(q.archived === "only" ? sql`"archivedAt" is not null` : sql`"archivedAt" is null`);
  if (q.orderNumbers) {
    const numbers = [...new Set(q.orderNumbers.split(/[\s,，;；]+/).filter(Boolean))];
    if (numbers.length)
      filters.push(
        sql`"externalOrderId" in (${sql.join(
          numbers.map((number) => sql`${number}`),
          sql`,`,
        )})`,
      );
  }
  for (const [column, value] of [
    ["skuCode", q.sku],
    ["printSku", q.printSku],
    ["spuCode", q.spu],
    ["specificationName", q.specification],
  ] as const) {
    if (value)
      filters.push(sql`${sql.identifier(column)} ilike ${`%${value.replace(/[\\%_]/g, "\\$&")}%`}`);
  }
  if (q.designExecutor) filters.push(sql`"designExecutor"=${q.designExecutor}`);
  if (q.stage) filters.push(sql`"queueStage"=${q.stage}`);
  if (q.labelStatus)
    filters.push(
      q.labelStatus === "missing"
        ? sql`"labelStatus" in ('missing','partial')`
        : sql`"labelStatus"=${q.labelStatus}`,
    );
  if (q.q) {
    const term = `%${q.q.replace(/[\\%_]/g, "\\$&")}%`;
    filters.push(sql`("externalOrderId" ilike ${term} or "externalLineId" ilike ${term} or "skuCode" ilike ${term} or "printSku" ilike ${term} or title ilike ${term} or id::text ilike ${term}
      or exists(select 1 from production_orders p where p.order_line_id = v.id and p.id::text ilike ${term})
      or exists(select 1 from shipment_package_lines pl join shipment_packages p on p.id = pl.package_id where pl.order_line_id = v.id and p.tracking_number ilike ${term}))`);
  }
  if (q.accountId) filters.push(sql`"accountId" = ${q.accountId}`);
  if (q.platform) filters.push(sql`platform = ${q.platform}`);
  if (q.batchId) filters.push(sql`"batchId" = ${q.batchId}`);
  if (q.preparation) filters.push(sql`preparation = ${q.preparation}`);
  if (q.artwork) filters.push(sql`artwork = ${q.artwork}`);
  if (q.proof) filters.push(sql`proof = ${q.proof}`);
  if (q.production) filters.push(sql`production = ${q.production}`);
  if (q.shipment === "unshipped") filters.push(sql`"shippedQuantity" = 0`);
  if (q.shipment === "partial")
    filters.push(sql`"shippedQuantity" > 0 and "shippedQuantity" < quantity`);
  if (q.shipment === "shipped") filters.push(sql`"shippedQuantity" >= quantity`);
  if (q.afterSales)
    filters.push(
      sql`exists(select 1 from after_sales_cases a where a.order_id = v."orderId" and a.status = ${q.afterSales})`,
    );
  if (q.attention === "held") filters.push(sql`held or "sideState"='on_hold'`);
  if (q.attention === "overdue")
    filters.push(
      sql`"dueAt" < now() and "shippedQuantity" < quantity and "sideState" is distinct from 'cancelled'`,
    );
  if (q.attention === "source_changed") filters.push(sql`"sourceChanged"`);
  const dateColumn = sql.identifier(
    { placed: "placedAt", imported: "importedAt", due: "dueAt", dispatched: "dispatchedAt" }[
      q.dateField
    ],
  );
  if (q.from)
    filters.push(sql`${dateColumn} >= (${q.from}::date::timestamp at time zone ${q.timeZone})`);
  if (q.to)
    filters.push(
      sql`${dateColumn} < ((${q.to}::date + interval '1 day') at time zone ${q.timeZone})`,
    );
  if (q.module === "artwork") filters.push(sql`artwork <> 'not_pushed'`);
  if (q.module === "production")
    filters.push(sql`artwork = 'approved' or production <> 'not_released'`);
  if (q.module === "shipments") filters.push(sql`"readyQuantity" > 0 or "shippedQuantity" > 0`);
  if (q.module === "after-sales")
    filters.push(sql`exists(select 1 from after_sales_cases a where a.order_id = v."orderId")`);
  return sql.join(
    filters.map((filter) => sql`(${filter})`),
    sql` and `,
  );
}
