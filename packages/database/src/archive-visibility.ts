import { sql } from "drizzle-orm";
import { assetFiles } from "./schema/assets.js";

/** Pinned versions remain readable. Archived creative outputs are not new input choices. */
export function activeCreativeAsset() {
  return sql`not exists (
    select 1 from creative_design_version_assets av
    join creative_design_versions v on v.id = av.creative_design_version_id and v.tenant_id = av.tenant_id
    join creative_design_candidates c on c.id = v.source_candidate_id and c.tenant_id = v.tenant_id
    join creative_design_batch_items i on i.id = c.item_id and i.tenant_id = c.tenant_id
    join creative_design_batches b on b.id = i.batch_id and b.tenant_id = i.tenant_id
    where av.asset_id = ${assetFiles.id} and b.archived_at is not null
  ) and not exists (
    select 1 from design_version_files f
    join design_versions v on v.id = f.version_id and v.tenant_id = f.tenant_id
    join design_tasks t on t.id = v.task_id and t.tenant_id = v.tenant_id
    join skus s on s.id = t.sku_id and s.tenant_id = t.tenant_id
    join spus p on p.id = s.spu_id and p.tenant_id = s.tenant_id
    join product_plans plan on plan.id = p.product_plan_id and plan.tenant_id = p.tenant_id
    where f.asset_file_id = ${assetFiles.id} and f.role = 'production'
      and (s.status = 'archived' or p.status = 'archived' or plan.status = 'archived')
      and not exists (
        select 1 from design_version_files live_file
        join design_versions live_version on live_version.id = live_file.version_id and live_version.tenant_id = live_file.tenant_id
        join design_tasks live_task on live_task.id = live_version.task_id and live_task.tenant_id = live_version.tenant_id
        join skus live_sku on live_sku.id = live_task.sku_id and live_sku.tenant_id = live_task.tenant_id
        join spus live_spu on live_spu.id = live_sku.spu_id and live_spu.tenant_id = live_sku.tenant_id
        join product_plans live_plan on live_plan.id = live_spu.product_plan_id and live_plan.tenant_id = live_spu.tenant_id
        where live_file.asset_file_id = ${assetFiles.id} and live_file.role = 'production'
          and live_sku.status <> 'archived' and live_spu.status <> 'archived' and live_plan.status <> 'archived'
      )
  )`;
}
