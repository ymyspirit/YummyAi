import { sql, type SQL } from "drizzle-orm";

/** A status cannot return production quantity; only an approved stop can. */
export function productionRemainingQuantity(productionId: SQL, pinnedVersionId?: SQL): SQL {
  const version = pinnedVersionId
    ? sql`remaining_version.id=${pinnedVersionId}`
    : sql`remaining_version.version_number=remaining_production.current_version_number`;
  return sql`(select (remaining_version.quantity-coalesce(remaining_review.cumulative_stopped_quantity,0))::int
    from production_orders remaining_production
    join production_order_versions remaining_version on remaining_version.tenant_id=remaining_production.tenant_id
      and remaining_version.production_order_id=remaining_production.id and ${version}
    left join lateral(select r.cumulative_stopped_quantity from production_quantity_reviews r
      where r.tenant_id=remaining_production.tenant_id and r.production_order_id=remaining_production.id
        and r.production_version_id=remaining_version.id order by r.sequence desc limit 1) remaining_review on true
    where remaining_production.id=${productionId})`;
}

/** Retain the quantity the inspection actually covered, before later production. */
export function productionInspectedQuantity(productionId: SQL, inspectedCreatedAt: SQL): SQL {
  return sql`(select case when ${inspectedCreatedAt} is null then 0
      else coalesce(inspected_review.completed_quantity,inspected_version.quantity)::int end
    from production_orders inspected_production
    join production_order_versions inspected_version on inspected_version.tenant_id=inspected_production.tenant_id
      and inspected_version.production_order_id=inspected_production.id
      and inspected_version.version_number=inspected_production.current_version_number
    left join lateral(select (r.quantities->>'completedQuantity')::int as completed_quantity from production_quantity_reviews r
      where r.tenant_id=inspected_production.tenant_id and r.production_order_id=inspected_production.id
        and r.production_version_id=inspected_version.id and r.created_at<=${inspectedCreatedAt}
      order by r.sequence desc limit 1) inspected_review on true
    where inspected_production.id=${productionId})`;
}
