import { Permission } from "@yummyai/authz";
import { catalogAssetReadFilter, catalogOwnerFilter } from "@yummyai/catalog-core";
import type { TenantContext } from "@yummyai/contracts";
import type { AssistTargetPageItem, AssistTargetPageSelection } from "@yummyai/contracts/ai/task-target-page";
import {
  afterSalesCases, assetFiles, creativeDesignBatches, financeProfitRuns,
  inventoryBalances, inventoryLocations, inventoryStockItems, listings,
  orderLines, orders, personalizationTemplateSourceInspections, spus,
  type TenantTransaction,
} from "@yummyai/database";
import { and, eq, ilike, isNull, or, sql, type SQL } from "drizzle-orm";

type Selection = Pick<AssistTargetPageSelection, "kind" | "q">;

/** One source/filter/projection for the frozen v1 search and complete v2 pages. */
export function assistTargetSource(context: TenantContext, query: Selection): { source: SQL; legacyOrder: SQL } {
  const pattern = `%${query.q.replace(/[\\%_]/g, "\\$&")}%`;
  if (query.kind === "knowledge_answer") return {
    source: sql`select null::text as id, null::text as label, null::text as detail, null::text as href where false`,
    legacyOrder: sql`source.id`,
  };
  if (query.kind === "order_review" || query.kind === "artwork_preflight") return {
    source: sql`
      select ${orderLines.id}::text as id, ${orders.externalOrderId} || ' · ' || ${orderLines.title} as label,
        '本订单行数量 ' || ${orderLines.quantity}::text || '；读取依据时固定当前修订' as detail,
        ${query.kind === "order_review" ? "/orders?line=" : "/order-artwork?line="} || ${orderLines.id}::text as href,
        ${orders.placedAt} as legacy_first, ${orderLines.id} as legacy_second
      from ${orderLines} join ${orders} on ${orders.id} = ${orderLines.orderId}
      where ${and(isNull(orders.sideState), or(ilike(orderLines.title, pattern), ilike(orders.externalOrderId, pattern), ilike(orderLines.skuCode, pattern)))}`,
    legacyOrder: sql`source.legacy_first desc, source.legacy_second desc`,
  };
  if (query.kind === "creative") return {
    source: sql`
      select ${creativeDesignBatches.id}::text as id, ${creativeDesignBatches.name} as label,
        '使用项目已保存的需求和研究来源'::text as detail,
        '/content-projects?project=' || ${creativeDesignBatches.id}::text as href, ${creativeDesignBatches.createdAt} as legacy_first
      from ${creativeDesignBatches}
      where ${and(isNull(creativeDesignBatches.archivedAt), catalogOwnerFilter(context, Permission.DesignRead, creativeDesignBatches.createdBy),
        eq(creativeDesignBatches.executionMode, "infinite_canvas"), ilike(creativeDesignBatches.name, pattern),
        sql`(${creativeDesignBatches.canvasWorkflow}->>'rootBatchId' is null or ${creativeDesignBatches.canvasWorkflow}->>'rootBatchId' = ${creativeDesignBatches.id}::text)`)}`,
    legacyOrder: sql`source.legacy_first desc`,
  };
  if (query.kind === "sku_package") return {
    source: sql`
      select ${listings.id}::text as id, ${spus.name} || ' · ' || ${listings.platform} || ' · ' || ${listings.locale} as label,
        '读取当前 Listing、制作配方与授权套图'::text as detail, '/listings/' || ${listings.id}::text as href, ${listings.updatedAt} as legacy_first
      from ${listings} join ${spus} on ${spus.id} = ${listings.spuId}
      where ${and(sql`${listings.status} <> 'archived'`, ilike(spus.name, pattern), catalogOwnerFilter(context, Permission.ListingRead, listings.createdBy),
        sql`exists(select 1 from product_plans scope_plan where scope_plan.id = ${spus.productPlanId} and scope_plan.tenant_id = ${spus.tenantId}
          and ${catalogOwnerFilter(context, Permission.ProductRead, sql`scope_plan.created_by`, sql`scope_plan.team_id`) ?? sql`true`})`)}`,
    legacyOrder: sql`source.legacy_first desc`,
  };
  if (query.kind === "template_config") {
    const teams = context.teamIds ?? (context.teamId ? [context.teamId] : []);
    const teamArray = sql`array[${sql.join(teams.map(id => sql`${id}::uuid`), sql`, `)}]::uuid[]`;
    const sourceTeam = sql`(select scope_master.team_id from artwork_master_versions scope_version
      join artwork_masters scope_master on scope_master.id = scope_version.artwork_id and scope_master.tenant_id = scope_version.tenant_id
      where scope_version.tenant_id = ${assetFiles.tenantId}
        and (scope_version.asset_id = ${assetFiles.id} or scope_version.materials @> jsonb_build_array(jsonb_build_object('assetId', ${assetFiles.id}::text)))
        and scope_master.team_id = any(${teamArray}) order by scope_master.id limit 1)`;
    return {
      source: sql`
        select ${personalizationTemplateSourceInspections.id}::text as id, ${assetFiles.fileName} as label,
          '已完成 ' || upper(${personalizationTemplateSourceInspections.source}) || ' 图层解析；源文件权限会再次核对' as detail,
          '/pod-workbench?module=personalization'::text as href, ${personalizationTemplateSourceInspections.createdAt} as legacy_first
        from ${personalizationTemplateSourceInspections} join ${assetFiles} on ${assetFiles.id} = ${personalizationTemplateSourceInspections.sourceAssetId}
        where ${and(eq(personalizationTemplateSourceInspections.status, "completed"),
          catalogOwnerFilter(context, Permission.DesignRead, assetFiles.ownerUserId, sourceTeam),
          catalogAssetReadFilter(context, assetFiles.ownerUserId, assetFiles.id), ilike(assetFiles.fileName, pattern))}`,
      legacyOrder: sql`source.legacy_first desc`,
    };
  }
  if (query.kind === "business_review") return {
    source: sql`
      select ${financeProfitRuns.id}::text as id,
        ${financeProfitRuns.reportingCurrency} || ' 利润计算 · ' || to_char(${financeProfitRuns.calculatedAt} at time zone 'UTC', 'YYYY-MM-DD') as label,
        '使用固定财务计算；缺失成本保持未知'::text as detail, '/finance'::text as href, ${financeProfitRuns.calculatedAt} as legacy_first
      from ${financeProfitRuns} where ${ilike(financeProfitRuns.reportingCurrency, pattern)}`,
    legacyOrder: sql`source.legacy_first desc`,
  };
  if (query.kind === "procurement_review") return {
    source: sql`
      select distinct ${inventoryStockItems.id}::text || ':' || ${inventoryLocations.id}::text as id,
        ${inventoryStockItems.code} || ' · ' || ${inventoryStockItems.name} || ' · ' || ${inventoryLocations.name} as label,
        '读取这个库存品与库位的补货依据'::text as detail, '/procurement'::text as href,
        ${inventoryStockItems.name} as legacy_first, ${inventoryLocations.name} as legacy_second
      from ${inventoryBalances}
      join ${inventoryStockItems} on ${inventoryStockItems.id} = ${inventoryBalances.stockItemId}
      join ${inventoryLocations} on ${inventoryLocations.id} = ${inventoryBalances.locationId}
      where ${and(eq(inventoryStockItems.status, "active"), eq(inventoryLocations.status, "active"),
        or(ilike(inventoryStockItems.name, pattern), ilike(inventoryStockItems.code, pattern), ilike(inventoryLocations.name, pattern)))}`,
    legacyOrder: sql`source.legacy_first, source.legacy_second`,
  };
  return {
    source: sql`
      select ${afterSalesCases.id}::text as id, ${orders.externalOrderId} || ' · ' || ${afterSalesCases.reasonCode} as label,
        '核对当前处理进度；回复保持草稿'::text as detail, '/after-sales'::text as href, ${afterSalesCases.updatedAt} as legacy_first
      from ${afterSalesCases} join ${orders} on ${orders.id} = ${afterSalesCases.orderId}
      where ${and(sql`${afterSalesCases.status} not in ('resolved', 'cancelled')`,
        or(ilike(orders.externalOrderId, pattern), ilike(afterSalesCases.reasonCode, pattern)))}`,
    legacyOrder: sql`source.legacy_first desc`,
  };
}

export async function readLegacyAssistTargets(tx: TenantTransaction, context: TenantContext, query: Selection): Promise<AssistTargetPageItem[]> {
  const { source, legacyOrder } = assistTargetSource(context, query);
  const rows = await tx.execute<AssistTargetPageItem>(sql`
    select source.id, source.label, source.detail, source.href from (${source}) source order by ${legacyOrder} limit 41`);
  return Array.from(rows);
}
