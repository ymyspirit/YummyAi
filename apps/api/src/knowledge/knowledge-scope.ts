import { NotFoundException } from "@nestjs/common";
import { authorize, Permission, type PermissionValue } from "@yummyai/authz";
import { catalogOwnerFilter, catalogPlanFilter, currentCatalogContext } from "@yummyai/catalog-core";
import type { TenantContext } from "@yummyai/contracts";
import {
  knowledgeEntries as entries, knowledgeVersions as versions, marketplaceAccounts as stores, productPlans, spus,
  type TenantTransaction,
} from "@yummyai/database";
import { and, eq, ne, sql, type SQLWrapper } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

export async function currentKnowledgeContext(tx: TenantTransaction, ceiling: TenantContext, permission: PermissionValue) {
  const current = await currentCatalogContext(tx, ceiling);
  authorize(current, permission);
  return current;
}

export function authorizeKnowledgeAccount(context: TenantContext, ownerId?: string) {
  authorize(context, Permission.StoreRead, ownerId ? { ownerId } : undefined);
  authorize(context, Permission.FinanceRead, ownerId ? { ownerId } : undefined);
}

export function knowledgeAccountScopeFilter(context: TenantContext, owner: SQLWrapper, storeId: SQLWrapper) {
  if (!context.permissions.includes(Permission.StoreRead) || !context.permissions.includes(Permission.FinanceRead)) return sql`false`;
  const store = alias(stores, "knowledge_scope_store");
  return sql`(${catalogOwnerFilter(context, Permission.StoreRead, owner) ?? sql`true`})
    and (${catalogOwnerFilter(context, Permission.FinanceRead, owner) ?? sql`true`})
    and exists (select 1 from ${stores} as ${store} where ${store.id}=${storeId}
      and (${catalogOwnerFilter(context, Permission.StoreRead, store.createdBy) ?? sql`true`})
      and (${catalogOwnerFilter(context, Permission.FinanceRead, store.createdBy) ?? sql`true`}))`;
}

export async function assertKnowledgeAccountScope(tx: TenantTransaction, context: TenantContext, ownerId: string, storeId: string | null) {
  authorizeKnowledgeAccount(context, ownerId);
  const [store] = storeId ? await tx.select().from(stores).where(and(eq(stores.id, storeId),
    catalogOwnerFilter(context, Permission.StoreRead, stores.createdBy),
    catalogOwnerFilter(context, Permission.FinanceRead, stores.createdBy))).for("share") : [];
  if (!store) throw new NotFoundException("店铺不存在或不可访问");
  authorizeKnowledgeAccount(context, store.createdBy ?? undefined);
  return store;
}

/** JSON product IDs are compared as text, so malformed legacy data cannot cause an unsafe UUID cast. */
export function knowledgeProductScopeFilter(context: TenantContext, id: SQLWrapper) {
  const access = context.permissions.includes(Permission.ProductRead)
    ? sql`exists (select 1 from ${spus} inner join ${productPlans} on ${productPlans.id}=${spus.productPlanId}
        where ${spus.id}::text=(${id})::text and ${catalogPlanFilter(context, Permission.ProductRead) ?? sql`true`})`
    : sql`false`;
  return sql`((${id}) is null or ${access})`;
}

/** A card includes all immutable versions, including product versions predating a general latest version. */
export function knowledgeEntryScopeFilter(context: TenantContext, id: SQLWrapper = entries.id) {
  const scoped = alias(versions, "knowledge_scope_version");
  return sql`not exists (select 1 from ${versions} as ${scoped}
    where ${scoped.entryId}=${id} and not (${knowledgeProductScopeFilter(context, scoped.scopeSpuId)}))`;
}

export function knowledgeSearchScopeFilter(context: TenantContext, scope: SQLWrapper) {
  return sql`jsonb_typeof((${scope})->'spuIds')='array' and not exists (
    select 1 from jsonb_array_elements_text(case when jsonb_typeof((${scope})->'spuIds')='array'
      then (${scope})->'spuIds' else '[]'::jsonb end) as knowledge_scope_products(id)
    where not (${knowledgeProductScopeFilter(context, sql`knowledge_scope_products.id`)}))`;
}

export function knowledgeEntryIdsScopeFilter(context: TenantContext, ids: SQLWrapper) {
  const related = alias(entries, "knowledge_scope_entry");
  return sql`jsonb_typeof(${ids})='array' and not exists (
    select 1 from jsonb_array_elements_text(case when jsonb_typeof(${ids})='array'
      then ${ids} else '[]'::jsonb end) as knowledge_scope_references(id)
    where not exists (select 1 from ${entries} as ${related}
      where ${related.id}::text=knowledge_scope_references.id and ${knowledgeEntryScopeFilter(context, related.id)}))`;
}

export function knowledgeVersionScopeFilter(context: TenantContext, id: SQLWrapper) {
  const version = alias(versions, "knowledge_scope_selected_version");
  const entry = alias(entries, "knowledge_scope_selected_entry");
  return sql`exists (select 1 from ${versions} as ${version}
    inner join ${entries} as ${entry} on ${entry.id}=${version.entryId}
    where ${version.id}=${id} and ${knowledgeEntryScopeFilter(context, entry.id)})`;
}

export async function assertKnowledgeSpuScope(tx: TenantTransaction, context: TenantContext, id: string, active = false) {
  authorize(context, Permission.ProductRead);
  const [row] = await tx.select({ id: spus.id }).from(spus)
    .innerJoin(productPlans, eq(productPlans.id, spus.productPlanId))
    .where(and(eq(spus.id, id), catalogPlanFilter(context, Permission.ProductRead),
      active ? ne(spus.status, "archived") : undefined,
      active ? ne(productPlans.status, "archived") : undefined))
    .for("share", { of: [spus, productPlans] });
  if (!row) throw new NotFoundException("适用 SPU 不存在或不可访问");
}

export async function knowledgeScopedEntry(
  tx: TenantTransaction, context: TenantContext, id: string, lock: "share" | "update" = "share",
  additionalSpus: readonly string[] = [], activeSpuId: string | null = null,
) {
  const [entry] = await tx.select().from(entries)
    .where(and(eq(entries.id, id), knowledgeEntryScopeFilter(context))).for(lock, { of: entries });
  if (!entry) throw new NotFoundException("知识不存在或不可访问");
  const scopes = await tx.select({ spuId: versions.scopeSpuId }).from(versions).where(eq(versions.entryId, id));
  const ids = [...new Set([...scopes.flatMap(row => row.spuId ? [row.spuId] : []), ...additionalSpus])].sort();
  for (const spuId of ids) await assertKnowledgeSpuScope(tx, context, spuId, spuId === activeSpuId);
  return entry;
}

export async function assertKnowledgeScope(
  tx: TenantTransaction, context: TenantContext, scope: { spuIds?: readonly string[]; entryIds?: readonly string[] },
  activeEntries = false,
) {
  for (const id of [...new Set(scope.entryIds ?? [])].sort()) {
    const entry = await knowledgeScopedEntry(tx, context, id);
    if (activeEntries && entry.archivedAt) throw new NotFoundException("关联知识卡不存在或已归档");
  }
  for (const id of [...new Set(scope.spuIds ?? [])].sort()) await assertKnowledgeSpuScope(tx, context, id);
}
