import { sql, type SQL } from "drizzle-orm";
import { authorize, assertBusinessBenchmarkScope, intersectPermissionContexts, permissionScope, Permission, requiredAssistPermissions, requireTenantOrderPermissions, type PermissionValue } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import type { CreateAssist } from "@yummyai/contracts/ai/assist";
import { BenchmarkResourceBindingsSchema, type BenchmarkResourceBinding, type BenchmarkResourceBindings, type BusinessBenchmarkCase } from "@yummyai/contracts/knowledge/benchmark";
import type { TenantTransaction } from "./tenant-transaction.js";
import { loadCurrentMembershipContext } from "./membership-access.js";
import { orderPrivateSourceAvailable } from "./order-source-availability.js";

export type BusinessTask = BusinessBenchmarkCase["task"] | Exclude<CreateAssist, { kind: "knowledge_answer" }>;
export type BenchmarkResourceMode = "metadata" | "content" | "run";
/** Only authenticated, server-prepared packets enter capture. No private source is decrypted here. */
export type BenchmarkPreparedResources = {
  request: CreateAssist; data: Record<string, unknown>;
  images: readonly { sourceId: string; dataUrl?: string; url?: string }[];
  allowedArtworkIds: readonly string[]; allowedSpecificationIds: readonly string[];
  accessPolicy?: { requiredPermissions: readonly string[] };
};
export class BenchmarkBusinessResourceError extends Error {
  readonly status = 409;
  readonly statusCode = 409;
  readonly code = "benchmark_business_source_unavailable";
  constructor() { super("benchmark_business_source_unavailable"); }
}
function invalid(): never { throw new BenchmarkBusinessResourceError(); }
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const records = (value: unknown) => Array.isArray(value) ? value.map(object) : [];
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const legacy = (task: { kind: string }) => task.kind === "procurement_review" || task.kind === "business_review";
const rank = { self: 0, team: 1, tenant: 2 };
const permissionValues = new Set<string>(Object.values(Permission));

export async function captureBusinessBenchmarkResources(tx: TenantTransaction, context: TenantContext, prepared: BenchmarkPreparedResources): Promise<BenchmarkResourceBindings> {
  context = intersectPermissionContexts(context, await loadCurrentMembershipContext(tx, context, { lock: true }));
  const task = prepared.request;
  if (task.kind === "knowledge_answer" || legacy(task)) invalid();
  const selected = new Map<string, BenchmarkResourceBinding>();
  const add = (kind: BenchmarkResourceBinding["kind"], id: unknown, extra: Omit<BenchmarkResourceBinding, "kind" | "id"> = {}) => {
    if (!uuid(id)) invalid();
    const binding = { kind, id: id.toLowerCase(), ...extra };
    const key = `${kind}:${binding.id}`, previous = selected.get(key);
    if (previous && JSON.stringify(previous) !== JSON.stringify(binding)) invalid();
    selected.set(key, binding);
    if (selected.size > 512) invalid();
  };
  async function row<T extends Record<string, unknown>>(query: SQL): Promise<T> {
    const rows = await tx.execute<T>(query);
    if (rows.length !== 1) invalid();
    return rows[0]! as T;
  }
  async function artwork(id: string) {
    const value = await row<{ artwork_id: string }>(sql`select artwork_id from artwork_master_versions where tenant_id=${context.tenantId} and id=${id}`);
    add("artwork_version", id, { parentId: value.artwork_id });
  }
  async function recipe(id: string) {
    const value = await row<{ sku_id: string; specification_version_id: string; artwork_version_id: string }>(sql`select sku_id,specification_version_id,artwork_version_id from sales_recipe_versions where tenant_id=${context.tenantId} and id=${id}`);
    add("sku_recipe", id, { parentId: value.sku_id });
    add("specification_version", value.specification_version_id);
    await artwork(value.artwork_version_id);
    const bindings = await tx.execute<{ artwork_version_id: string }>(sql`select artwork_version_id from sales_recipe_print_bindings where tenant_id=${context.tenantId} and recipe_id=${id} order by artwork_version_id`);
    for (const binding of bindings) await artwork(binding.artwork_version_id);
  }
  if (task.salesPlan) add("sales_plan", task.salesPlan.id);
  if (task.kind === "creative") {
    if (task.projectId) add("creative_project", task.projectId);
    for (const source of task.sources) {
      add("research_item", source.researchItemId);
      if (!source.snapshotId) invalid();
      add("research_snapshot", source.snapshotId, { parentId: source.researchItemId });
      if (source.studyRevisionId) add("research_study", source.studyRevisionId, { parentId: source.researchItemId });
    }
    for (const id of task.requirements.specificationVersionIds) add("specification_version", id);
  } else if (task.kind === "order_review" || task.kind === "artwork_preflight") {
    if (task.kind === "artwork_preflight" && (task.automaticAudit || task.retryAudit)) invalid();
    const line = await row<{ order_id: string }>(sql`select order_id from order_lines where tenant_id=${context.tenantId} and id=${task.orderLineId}`);
    add("order_line", task.orderLineId, { parentId: line.order_id });
    for (const value of records(object(prepared.data.catalog).artworks)) { if (!uuid(value.id)) invalid(); await artwork(value.id); }
    for (const value of records(object(prepared.data.catalog).specifications)) add("specification_version", value.id);
    for (const id of prepared.allowedArtworkIds) await artwork(id);
    for (const id of prepared.allowedSpecificationIds) add("specification_version", id);
    const attachments = await tx.execute<{ id: string; checksum: string }>(sql`select id,checksum from order_work_assets where tenant_id=${context.tenantId} and work_item_id=${task.orderLineId} order by id limit 513`);
    for (const attachment of attachments) add("order_attachment", attachment.id, { parentId: task.orderLineId, checksum: attachment.checksum });
    if (task.kind === "artwork_preflight") {
      const editor = await row<{ project_id: string; checksum: string }>(sql`select project_id,checksum from production_editor_versions where tenant_id=${context.tenantId} and id=${task.expectedEditorVersionId}`);
      add("editor_version", task.expectedEditorVersionId, { parentId: editor.project_id, checksum: editor.checksum });
      for (const image of prepared.images) if (image.sourceId.startsWith("artwork-material:")) add("artwork_material", image.sourceId.slice("artwork-material:".length));
    }
  } else if (task.kind === "template_config") {
    const inspection = await row<{ source_asset_id: string; checksum_sha256: string }>(sql`select source_asset_id,checksum_sha256 from personalization_template_source_inspections where tenant_id=${context.tenantId} and id=${task.inspectionId}`);
    add("template_inspection", task.inspectionId, { parentId: inspection.source_asset_id, checksum: inspection.checksum_sha256 });
    add("asset", inspection.source_asset_id, { checksum: inspection.checksum_sha256 });
  } else if (task.kind === "sku_package") {
    add("listing_version", task.expectedVersionId, { parentId: task.listingId });
    for (const value of records(prepared.data.recipes)) { if (!uuid(value.id)) invalid(); await recipe(value.id); }
    for (const image of prepared.images) {
      if (!uuid(image.sourceId)) invalid();
      const asset = await row<{ checksum_sha256: string }>(sql`select checksum_sha256 from asset_files where tenant_id=${context.tenantId} and id=${image.sourceId}`);
      add("asset", image.sourceId, { checksum: asset.checksum_sha256 });
    }
  } else if (task.kind === "after_sales_review") {
    const value = await row<{ order_id: string }>(sql`select order_id from after_sales_cases where tenant_id=${context.tenantId} and id=${task.caseId}`);
    add("after_sales_case", task.caseId, { parentId: value.order_id });
  } else invalid();
  const permissions = new Set<PermissionValue>([...requiredAssistPermissions(task.kind, "run"), Permission.WorkflowRead, Permission.WorkflowRun, Permission.WorkflowManage]);
  for (const bit of prepared.accessPolicy?.requiredPermissions ?? []) {
    if (!permissionValues.has(bit)) invalid();
    permissions.add(bit as PermissionValue);
  }
  if (task.salesPlan || [...selected.values()].some(value => value.kind === "specification_version" || value.kind === "sku_recipe")) permissions.add(Permission.ProductRead);
  if ([...selected.values()].some(value => value.kind === "artwork_version" || value.kind === "sku_recipe")) permissions.add(Permission.DesignRead);
  if ([...selected.values()].some(value => value.kind === "asset" || value.kind === "artwork_material")) permissions.add(Permission.AssetRead);
  const permissionScopes: BenchmarkResourceBindings["permissionScopes"] = {};
  for (const bit of [...permissions].sort()) { authorize(context, bit); permissionScopes[bit] = permissionScope(context, bit); }
  const bindings = BenchmarkResourceBindingsSchema.parse({ version: "role-benchmark-resources-v1", permissionScopes,
    teamIds: [...new Set(context.teamIds ?? (context.teamId ? [context.teamId] : []))].sort(),
    items: [...selected.values()].sort((a, b) => `${a.kind}:${a.id}` < `${b.kind}:${b.id}` ? -1 : 1) });
  await assertBusinessBenchmarkResources(tx, context, [task as BusinessTask], bindings, "run");
  return bindings;
}

/** Checks current resource authority against fixed IDs. Metadata never opens or rebuilds today's private packet. */
export async function assertBusinessBenchmarkResources(tx: TenantTransaction, context: TenantContext, tasks: readonly BusinessTask[], rawBindings?: BenchmarkResourceBindings, mode: BenchmarkResourceMode = "metadata"): Promise<void> {
  const tenant = context.tenantId;
  async function one<T extends Record<string, unknown>>(query: SQL): Promise<T> {
    const rows = await tx.execute<T>(query);
    if (rows.length !== 1) invalid();
    return rows[0]! as T;
  }
  const content = mode !== "metadata";
  const tasksNew = tasks.filter(task => !legacy(task));
  if (tasksNew.length && !rawBindings && mode !== "metadata") invalid();
  let bindings = rawBindings ? BenchmarkResourceBindingsSchema.parse(rawBindings) : undefined;
  // Unpublished drafts/target menus have only task roots. They must establish
  // root authority too, but this is never accepted as a published execution pin.
  if (tasksNew.length && !bindings) {
    const roots = new Map<string, BenchmarkResourceBinding>();
    const add = (kind: BenchmarkResourceBinding["kind"], id: string, parentId?: string) => roots.set(`${kind}:${id}`, { kind, id, ...(parentId ? { parentId } : {}) });
    for (const task of tasksNew) {
      if (task.salesPlan) add("sales_plan", task.salesPlan.id);
      if (task.kind === "creative") {
        if (task.projectId) add("creative_project", task.projectId);
        for (const source of task.sources) { add("research_item", source.researchItemId); if (source.snapshotId) add("research_snapshot", source.snapshotId, source.researchItemId); if (source.studyRevisionId) add("research_study", source.studyRevisionId, source.researchItemId); }
        for (const id of task.requirements.specificationVersionIds) add("specification_version", id);
      } else if (task.kind === "order_review" || task.kind === "artwork_preflight") {
        add("order_line", task.orderLineId);
        if (task.kind === "artwork_preflight") add("editor_version", task.expectedEditorVersionId);
      } else if (task.kind === "template_config") {
        add("template_inspection", task.inspectionId);
        const source = await one<{ source_asset_id: string }>(sql`select source_asset_id from personalization_template_source_inspections where tenant_id=${tenant} and id=${task.inspectionId}`);
        add("asset", source.source_asset_id);
      } else if (task.kind === "sku_package") add("listing_version", task.expectedVersionId, task.listingId);
      else if (task.kind === "after_sales_review") add("after_sales_case", task.caseId);
    }
    bindings = BenchmarkResourceBindingsSchema.parse({ version: "role-benchmark-resources-v1", items: [...roots.values()], permissionScopes: { [Permission.WorkflowRead]: permissionScope(context, Permission.WorkflowRead) },
      teamIds: [...new Set(context.teamIds ?? (context.teamId ? [context.teamId] : []))].sort() });
  }
  if (rawBindings && bindings) {
    const original = { ...context, permissions: Object.keys(bindings.permissionScopes).filter(bit => permissionValues.has(bit)) as PermissionValue[], permissionScopes: bindings.permissionScopes,
      teamId: undefined, teamIds: bindings.teamIds };
    context = intersectPermissionContexts(original, context);
  }
  if (bindings) for (const [bit, scope] of Object.entries(bindings.permissionScopes)) {
    if (!permissionValues.has(bit)) invalid();
    // A read does not newly require mutation authority; run rechecks every original bit.
    if (mode !== "run" && !bit.endsWith(":read") && bit !== Permission.OrderPiiRead) continue;
    const permission = bit as PermissionValue;
    authorize(context, permission);
    if (rank[permissionScope(context, permission)] < rank[scope]) {
      // Scoped resources below independently establish current owner/team authority.
      // A tenant aggregate or unscoped dependency cannot borrow that exception.
      if (tasks.some(task => legacy(task)) || permission.startsWith("order:")) invalid();
    }
  }
  const has = (kind: BenchmarkResourceBinding["kind"], id: string) => bindings?.items.some(value => value.kind === kind && value.id === id.toLowerCase());
  for (const task of tasks) {
    assertBusinessBenchmarkScope(context, "self", task.kind);
    for (const bit of requiredAssistPermissions(task.kind, mode === "run" ? "run" : "read")) authorize(context, bit);
    if (task.kind === "procurement_review") {
      const stock = await one<{ created_by: string }>(sql`select created_by from inventory_stock_items where tenant_id=${tenant} and id=${task.stockItemId}`);
      const location = await one<{ created_by: string }>(sql`select created_by from inventory_locations where tenant_id=${tenant} and id=${task.locationId}`);
      authorize(context, Permission.InventoryRead, { ownerId: stock.created_by }); authorize(context, Permission.InventoryRead, { ownerId: location.created_by });
    } else if (task.kind === "creative") {
      if (task.projectId && bindings && !has("creative_project", task.projectId)) invalid();
      for (const source of task.sources) if (bindings && (!has("research_item", source.researchItemId) || !source.snapshotId || !has("research_snapshot", source.snapshotId) || source.studyRevisionId && !has("research_study", source.studyRevisionId))) invalid();
      for (const id of task.requirements.specificationVersionIds) if (bindings && !has("specification_version", id)) invalid();
    } else if (task.kind === "order_review" || task.kind === "artwork_preflight") {
      requireTenantOrderPermissions(context, [Permission.OrderRead, Permission.OrderPiiRead]);
      if (mode === "run" && task.kind === "order_review") requireTenantOrderPermissions(context, [Permission.OrderWrite]);
      if (bindings && !has("order_line", task.orderLineId)) invalid();
      if (task.kind === "artwork_preflight" && (("automaticAudit" in task && task.automaticAudit) || ("retryAudit" in task && task.retryAudit) || bindings && !has("editor_version", task.expectedEditorVersionId))) invalid();
    } else if (task.kind === "template_config" && bindings && !has("template_inspection", task.inspectionId)) invalid();
    else if (task.kind === "sku_package" && bindings && !has("listing_version", task.expectedVersionId)) invalid();
    else if (task.kind === "after_sales_review") {
      requireTenantOrderPermissions(context, [Permission.OrderRead, Permission.OrderPiiRead]);
      if (bindings && !has("after_sales_case", task.caseId)) invalid();
    }
    if (task.salesPlan && bindings && !has("sales_plan", task.salesPlan.id)) invalid();
  }
  const parent = (binding: BenchmarkResourceBinding, actual: string | null | undefined) => { if (binding.parentId && binding.parentId !== actual) invalid(); };
  const checksum = (binding: BenchmarkResourceBinding, actual: string | null | undefined) => { if (mode === "run" && binding.checksum && binding.checksum !== actual) invalid(); };
  const graphCache = new Set<string>();
  async function product(spuId: string) {
    if (graphCache.has(`product:${spuId}`)) return;
    const value = await one<{ created_by: string; team_id: string | null }>(sql`select p.created_by,p.team_id from spus s join product_plans p on p.id=s.product_plan_id and p.tenant_id=s.tenant_id where s.tenant_id=${tenant} and s.id=${spuId}`);
    authorize(context, Permission.ProductRead, { ownerId: value.created_by, teamId: value.team_id }); graphCache.add(`product:${spuId}`);
  }
  async function artwork(id: string) {
    const value = await one<{ artwork_id: string; created_by: string; team_id: string | null }>(sql`select v.artwork_id,m.created_by,m.team_id from artwork_master_versions v join artwork_masters m on m.id=v.artwork_id and m.tenant_id=v.tenant_id where v.tenant_id=${tenant} and v.id=${id}`);
    authorize(context, Permission.DesignRead, { ownerId: value.created_by, teamId: value.team_id }); return value;
  }
  async function orderLine(id: string) {
    requireTenantOrderPermissions(context, [Permission.OrderRead, Permission.OrderPiiRead]);
    return one<{ order_id: string; available: boolean }>(sql`select l.order_id,${orderPrivateSourceAvailable(sql`l.order_id`)} as available from order_lines l where l.tenant_id=${tenant} and l.id=${id}`);
  }
  async function asset(binding: BenchmarkResourceBinding, permissions: readonly PermissionValue[] = [Permission.AssetRead]) {
    const teamIds = context.teamIds ?? (context.teamId ? [context.teamId] : []);
    const teams = sql`ARRAY[${sql.join(teamIds.map(id => sql`${id}::uuid`), sql`, `)}]::uuid[]`;
    const value = await one<{ owner_user_id: string | null; asset_domain: string; available: boolean; checksum_sha256: string; team_id: string | null; license_expires_at: string | null }>(sql`select a.owner_user_id,a.asset_domain,a.checksum_sha256,a.rights_metadata->'source'->>'licenseExpiresAt' as license_expires_at,(a.deleted_at is null and a.asset_domain='authorized' and a.rights_status='approved' and coalesce(a.rights_metadata->'source'->>'kind','') not in ('customer_provided','competitor')) as available,
      (select m.team_id from artwork_master_versions v join artwork_masters m on m.id=v.artwork_id and m.tenant_id=v.tenant_id where v.tenant_id=a.tenant_id and m.team_id=any(${teams}) and (v.asset_id=a.id or v.materials @> jsonb_build_array(jsonb_build_object('assetId',a.id::text))) order by m.id limit 1) as team_id
      from asset_files a where a.tenant_id=${tenant} and a.id=${binding.id}`);
    for (const bit of permissions) authorize(context, bit, { ownerId: value.owner_user_id, teamId: value.team_id });
    if (value.asset_domain === "order") requireTenantOrderPermissions(context, [Permission.OrderRead, Permission.OrderPiiRead]);
    if (content && (!value.available || value.license_expires_at !== null && !(Date.parse(value.license_expires_at) > Date.now()))) invalid();
    checksum(binding, value.checksum_sha256);
  }
  for (const binding of bindings?.items ?? []) {
    if (binding.kind === "creative_project") {
      const value = await one<{ created_by: string }>(sql`select created_by from creative_design_batches where tenant_id=${tenant} and id=${binding.id}`);
      authorize(context, Permission.DesignRead, { ownerId: value.created_by });
      if (mode === "run") authorize(context, Permission.DesignWrite, { ownerId: value.created_by });
    } else if (binding.kind === "research_item" || binding.kind === "research_snapshot" || binding.kind === "research_study") {
      const query = binding.kind === "research_item" ? sql`select id as item_id,owner_user_id from research_items where tenant_id=${tenant} and id=${binding.id}` :
        binding.kind === "research_snapshot" ? sql`select i.id as item_id,i.owner_user_id from capture_snapshots v join research_items i on i.id=v.research_item_id and i.tenant_id=v.tenant_id where v.tenant_id=${tenant} and v.id=${binding.id}` :
          sql`select i.id as item_id,i.owner_user_id from research_study_revisions v join research_items i on i.id=v.research_item_id and i.tenant_id=v.tenant_id where v.tenant_id=${tenant} and v.id=${binding.id}`;
      const value = await one<{ item_id: string; owner_user_id: string | null }>(query);
      authorize(context, Permission.ResearchRead, { ownerId: value.owner_user_id }); if (binding.kind !== "research_item") parent(binding, value.item_id);
    } else if (binding.kind === "specification_version") {
      const value = await one<{ specification_id: string; spu_id: string }>(sql`select v.specification_id,p.spu_id from product_specification_versions v join product_specifications p on p.id=v.specification_id and p.tenant_id=v.tenant_id where v.tenant_id=${tenant} and v.id=${binding.id}`);
      parent(binding, value.specification_id); await product(value.spu_id);
    } else if (binding.kind === "artwork_version") parent(binding, (await artwork(binding.id)).artwork_id);
    else if (binding.kind === "sales_plan") {
      const value = await one<{ spu_id: string }>(sql`select spu_id from sales_plans where tenant_id=${tenant} and id=${binding.id}`); await product(value.spu_id);
    } else if (binding.kind === "order_line") {
      const value = await orderLine(binding.id); parent(binding, value.order_id); if (content && !value.available) invalid();
    } else if (binding.kind === "order_attachment") {
      const value = await one<{ work_item_id: string; checksum: string }>(sql`select work_item_id,checksum from order_work_assets where tenant_id=${tenant} and id=${binding.id}`);
      parent(binding, value.work_item_id); checksum(binding, value.checksum); if (content && !(await orderLine(value.work_item_id)).available) invalid();
    } else if (binding.kind === "editor_version") {
      const value = await one<{ project_id: string; checksum: string; source_work_item_id: string | null; created_by: string; available: boolean }>(sql`select v.project_id,v.checksum,p.source_work_item_id,p.created_by,(p.encrypted_data_key is not null and p.status='active' and (p.expires_at is null or p.expires_at>clock_timestamp())) as available from production_editor_versions v join production_editor_projects p on p.id=v.project_id and p.tenant_id=v.tenant_id where v.tenant_id=${tenant} and v.id=${binding.id}`);
      parent(binding, value.project_id); checksum(binding, value.checksum);
      if (!value.source_work_item_id || !tasks.some(task => (task.kind === "artwork_preflight" || task.kind === "order_review") && task.orderLineId === value.source_work_item_id)) invalid();
      authorize(context, Permission.DesignRead);
      if (content && (!value.available || !(await orderLine(value.source_work_item_id)).available)) invalid();
    } else if (binding.kind === "artwork_material" || binding.kind === "asset") await asset(binding);
    else if (binding.kind === "template_inspection") {
      const value = await one<{ source_asset_id: string; checksum_sha256: string; available: boolean }>(sql`select source_asset_id,checksum_sha256,status='completed' as available from personalization_template_source_inspections where tenant_id=${tenant} and id=${binding.id}`);
      parent(binding, value.source_asset_id); checksum(binding, value.checksum_sha256);
      await asset({ kind: "asset", id: value.source_asset_id }, [Permission.DesignRead, ...(mode === "run" ? [Permission.DesignWrite] : [])]);
      if (content && !value.available) invalid();
    } else if (binding.kind === "listing_version") {
      const value = await one<{ listing_id: string; created_by: string }>(sql`select v.listing_id,l.created_by from listing_versions v join listings l on l.id=v.listing_id and l.tenant_id=v.tenant_id where v.tenant_id=${tenant} and v.id=${binding.id}`);
      parent(binding, value.listing_id); authorize(context, Permission.ListingRead, { ownerId: value.created_by });
      if (mode === "run") authorize(context, Permission.ListingWrite, { ownerId: value.created_by });
    } else if (binding.kind === "sku_recipe") {
      const value = await one<{ sku_id: string; spu_id: string; artwork_version_id: string }>(sql`select r.sku_id,k.spu_id,r.artwork_version_id from sales_recipe_versions r join skus k on k.id=r.sku_id and k.tenant_id=r.tenant_id where r.tenant_id=${tenant} and r.id=${binding.id}`);
      parent(binding, value.sku_id); await product(value.spu_id); await artwork(value.artwork_version_id);
    } else if (binding.kind === "after_sales_case") {
      requireTenantOrderPermissions(context, [Permission.OrderRead, Permission.OrderPiiRead]);
      const value = await one<{ order_id: string; available: boolean }>(sql`select c.order_id,${orderPrivateSourceAvailable(sql`c.order_id`)} as available from after_sales_cases c where c.tenant_id=${tenant} and c.id=${binding.id}`);
      parent(binding, value.order_id); if (content && !value.available) invalid();
    }
  }
}
