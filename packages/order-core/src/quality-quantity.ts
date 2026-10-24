import { sql, type SQL } from "drizzle-orm";
import { productionInspectedQuantity, productionRemainingQuantity } from "./production-quantity.js";

/** A production's pinned projection orders its inspections. Recorder clocks do
 * not supersede a later business revision; unversioned history keeps its fallback. */
export function qualityInspectionOrder(alias: SQL = sql`q`): SQL {
  return sql`${alias}.production_projection_version desc nulls last,${alias}.created_at desc,${alias}.id desc`;
}

/** Qualified physical quantity, before reservations, from current root and leaf groups. */
export function productionReadyQuantity(productionId: SQL): SQL {
  return sql`(select case
    when quality_production.status not in ('completed','quality_hold') then 0
    when quality_root.assessment_version=3 and quality_root.production_version_id=quality_version.id then (
      with recursive group_tree as (
        select g.id,g.result,g.quantity,array[g.id] as visited from quality_inspection_groups g
          where g.inspection_id=quality_root.id and g.tenant_id=quality_root.tenant_id
        union all select child.id,child.result,child.quantity,parent.visited||child.id from group_tree parent
          join quality_group_reinspections scope on scope.parent_group_id=parent.id
          join quality_inspection_groups child on child.inspection_id=scope.inspection_id and child.tenant_id=scope.tenant_id
          where not child.id=any(parent.visited)
      ) select coalesce(sum(leaf.quantity),0)::int from group_tree leaf where leaf.result='passed'
        and not exists(select 1 from quality_group_reinspections scope where scope.parent_group_id=leaf.id)
        and not exists(select 1 from production_orders ungrouped where ungrouped.parent_production_order_id=quality_production.id and coalesce(${productionRemainingQuantity(sql`ungrouped.id`)},1)>0
          and not exists(select 1 from production_recovery_groups rg where rg.replacement_production_order_id=ungrouped.id and rg.tenant_id=ungrouped.tenant_id))
    )
    when quality_production.status='completed' and quality_root.result='passed' and quality_root.assessment_version=2 and quality_root.production_version_id=quality_version.id
      and not exists(select 1 from production_orders child where child.parent_production_order_id=quality_production.id and coalesce(${productionRemainingQuantity(sql`child.id`)},1)>0)
      then ${productionInspectedQuantity(productionId, sql`quality_root.created_at`)}
    else 0 end from production_orders quality_production
    join production_order_versions quality_version on quality_version.production_order_id=quality_production.id and quality_version.version_number=quality_production.current_version_number
    left join lateral(select q.* from quality_inspections q where q.production_order_id=quality_production.id
      and not exists(select 1 from quality_group_reinspections scope where scope.inspection_id=q.id and scope.tenant_id=q.tenant_id)
      order by ${qualityInspectionOrder()} limit 1) quality_root on true where quality_production.id=${productionId})`;
}
