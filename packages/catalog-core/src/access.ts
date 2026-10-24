import {
  authorize,
  ForbiddenError,
  Permission,
  permissionScope,
  summarizeRoleGrants,
  erpPermissions,
  type PermissionValue,
} from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import {
  loadCurrentMembershipContext,
  organizationTeams,
  productPlans,
  spus,
  skus,
  artworkMasters,
  artworkMasterVersions,
  salesRecipeVersions,
  salesRecipePrintBindings,
  salesPackageVersions,
  productSpecifications,
  productSpecificationVersions,
  listings,
  listingVersions,
  marketplaceAccounts,
  creativeDesignVersions,
  creativeDesignVersionAssets,
  researchItems,
  assetFiles,
  type TenantTransaction,
} from "@yummyai/database";
import { and, eq, inArray, or, sql, type SQLWrapper } from "drizzle-orm";
import { salesPlans } from "@yummyai/database";
import { catalogErrors } from "./errors.js";

export class CatalogAccessNotFoundError extends Error {
  readonly status = 404;
  readonly statusCode = 404;
  constructor() {
    super("商品对象不存在或不可访问");
  }
}
export class CatalogAuthorityChangedError extends Error {
  readonly status = 409;
  readonly statusCode = 409;
  constructor() {
    super("当前团队范围已变化 请重新读取资料后操作");
  }
}
const rank = { self: 0, team: 1, tenant: 2 } as const;
export const catalogTeamIds = (context: TenantContext) =>
  context.teamIds ?? (context.teamId ? [context.teamId] : []);

/** New membership contexts are revalidated in the owning transaction. */
export function catalogContextAuthority(context: TenantContext) {
  const permissions = erpPermissions(context.permissions);
  return erpSessionAuthority({
    ...context,
    permissions,
    permissionScopes:
      context.permissionScopes &&
      Object.fromEntries(
        permissions.map((permission) => [permission, context.permissionScopes![permission]!]),
      ),
  });
}

export async function currentCatalogContext(
  tx: TenantTransaction,
  input: TenantContext,
): Promise<TenantContext> {
  if (input.permissionScopes === undefined) return input;
  const current = await loadCurrentMembershipContext(tx, input, { lock: true });
  if (input.teamAuthority !== undefined && input.teamAuthority !== current.teamAuthority)
    throw new CatalogAuthorityChangedError();
  const grants = current.permissions
    .filter((p) => input.permissions.includes(p) && input.permissionScopes?.[p])
    .map((p) => {
      const before = input.permissionScopes![p]!,
        now = current.permissionScopes![p]!;
      return { permissions: [p], scope: rank[before] < rank[now] ? before : now };
    });
  return {
    ...current,
    ...summarizeRoleGrants(grants),
    teamIds: catalogTeamIds(current).filter((id) => catalogTeamIds(input).includes(id)),
  };
}

export function catalogOwnerFilter(
  context: TenantContext,
  permission: PermissionValue,
  owner: SQLWrapper,
  team?: SQLWrapper,
) {
  authorize(context, permission);
  const scope = permissionScope(context, permission);
  if (scope === "tenant") return undefined;
  const own = eq(owner, context.userId),
    teams = catalogTeamIds(context);
  return scope === "team" && team && teams.length ? or(own, inArray(team, teams)) : own;
}
export function catalogPlanFilter(context: TenantContext, permission: PermissionValue) {
  return catalogOwnerFilter(context, permission, productPlans.createdBy, productPlans.teamId);
}

export async function assertCatalogPlanAccess(
  tx: TenantTransaction,
  context: TenantContext,
  id: string,
  permissions: readonly PermissionValue[],
  lock = false,
) {
  for (const p of permissions) authorize(context, p);
  const query = tx
    .select()
    .from(productPlans)
    .where(and(eq(productPlans.id, id), ...permissions.map((p) => catalogPlanFilter(context, p))));
  const [plan] = await (lock ? query.for("update") : query);
  if (!plan) throw new CatalogAccessNotFoundError();
  return plan;
}
/** Call after authorizing and locking the parent plan. Historical children may
 * still be read/used by their explicit IDs; shared plan edits need reconciliation. */
export async function assertCatalogUnambiguousPlan(
  tx: TenantTransaction,
  planId: string,
  conflict: (message: string) => Error = catalogErrors.conflict,
) {
  const children = await tx.select({ legacy: spus.legacyPlanAmbiguous }).from(spus)
    .where(eq(spus.productPlanId, planId));
  if (children.length > 1 || children.some(child => child.legacy))
    throw conflict("历史商品关系待核对 请明确选择原 SPU 共享企划暂时只读");
}

export async function assertCatalogSpuAccess(
  tx: TenantTransaction,
  context: TenantContext,
  id: string,
  permissions: readonly PermissionValue[],
  lock = false,
) {
  const [spu] = await tx
    .select({ id: spus.id, planId: spus.productPlanId })
    .from(spus)
    .where(eq(spus.id, id));
  if (!spu) throw new CatalogAccessNotFoundError();
  await assertCatalogPlanAccess(tx, context, spu.planId, permissions, lock);
  return spu;
}
export async function assertCatalogSkuAccess(
  tx: TenantTransaction,
  context: TenantContext,
  id: string,
  permissions: readonly PermissionValue[],
  lock = false,
) {
  const [sku] = await tx
    .select({ id: skus.id, spuId: skus.spuId })
    .from(skus)
    .where(eq(skus.id, id));
  if (!sku) throw new CatalogAccessNotFoundError();
  await assertCatalogSpuAccess(tx, context, sku.spuId, permissions, lock);
  return sku;
}
export async function assertCatalogRecipeAccess(
  tx: TenantTransaction,
  context: TenantContext,
  id: string,
  permissions: readonly PermissionValue[],
  lock = false,
) {
  const [recipe] = await tx
    .select({ id: salesRecipeVersions.id, skuId: salesRecipeVersions.skuId })
    .from(salesRecipeVersions)
    .where(eq(salesRecipeVersions.id, id));
  if (!recipe) throw new CatalogAccessNotFoundError();
  await assertCatalogSkuAccess(tx, context, recipe.skuId, permissions, lock);
  return recipe;
}
export async function assertCatalogSpecificationAccess(
  tx: TenantTransaction,
  context: TenantContext,
  id: string,
  permissions: readonly PermissionValue[],
  lock = false,
) {
  const [spec] = await tx
    .select({ id: productSpecifications.id, spuId: productSpecifications.spuId })
    .from(productSpecifications)
    .where(eq(productSpecifications.id, id));
  if (!spec) throw new CatalogAccessNotFoundError();
  await assertCatalogSpuAccess(tx, context, spec.spuId, permissions, lock);
  return spec;
}
export async function assertCatalogSalesPlanAccess(
  tx: TenantTransaction,
  context: TenantContext,
  id: string,
  permissions: readonly PermissionValue[],
  lock = false,
) {
  const [plan] = await tx
    .select({ spuId: salesPlans.spuId })
    .from(salesPlans)
    .where(eq(salesPlans.id, id));
  if (!plan) throw new CatalogAccessNotFoundError();
  return assertCatalogSpuAccess(tx, context, plan.spuId, permissions, lock);
}
export async function assertCatalogArtworkAccess(
  tx: TenantTransaction,
  context: TenantContext,
  id: string,
  permissions: readonly PermissionValue[],
  lock = false,
) {
  const query = tx
    .select()
    .from(artworkMasters)
    .where(
      and(
        eq(artworkMasters.id, id),
        ...permissions.map((p) =>
          catalogOwnerFilter(context, p, artworkMasters.createdBy, artworkMasters.teamId),
        ),
      ),
    );
  const [master] = await (lock ? query.for("update") : query);
  if (!master) throw new CatalogAccessNotFoundError();
  return master;
}
export async function assertCatalogListingAccess(
  tx: TenantTransaction,
  context: TenantContext,
  id: string,
  permissions: readonly PermissionValue[],
  lock: boolean | "share" = false,
) {
  for (const permission of permissions) authorize(context, permission);
  const query = tx
    .select()
    .from(listings)
    .where(
      and(
        eq(listings.id, id),
        ...permissions.map((permission) =>
          catalogOwnerFilter(context, permission, listings.createdBy),
        ),
      ),
    );
  const [row] =
    lock === "share"
      ? await query.limit(1).for("share")
      : lock
        ? await query.limit(1).for("update")
        : await query.limit(1);
  if (!row) throw new CatalogAccessNotFoundError();
  return row;
}

export async function assertCatalogTeamAssignment(
  tx: TenantTransaction,
  context: TenantContext,
  teamId: string | undefined | null,
) {
  if (!teamId) return;
  const [team] = await tx
    .select({ id: organizationTeams.id })
    .from(organizationTeams)
    .where(and(eq(organizationTeams.id, teamId), eq(organizationTeams.status, "active")))
    .for("share");
  if (!team) throw new CatalogAccessNotFoundError();
  if (
    permissionScope(context, Permission.ProductWrite) !== "tenant" &&
    !catalogTeamIds(context).includes(teamId)
  )
    throw new ForbiddenError(Permission.ProductWrite, "outside_data_scope");
}

type CatalogAccessKind =
  | "create"
  | "spu"
  | "sku"
  | "recipe"
  | "artwork"
  | "specification"
  | "specificationVersion"
  | "artworkVersion"
  | "package"
  | "listingVersion"
  | "account"
  | "recipeArtwork"
  | "artworkCode"
  | "salesPlan"
  | "salesPlanListings"
  | "research"
  | "creativeVersion"
  | "listing"
  | "asset";
export type CatalogMutationAccess = {
  permissions: readonly PermissionValue[];
  kind: CatalogAccessKind;
  id?: string;
  additional?: readonly CatalogMutationAccess[];
};
export async function assertCatalogMutationAccess(
  tx: TenantTransaction,
  context: TenantContext,
  access: CatalogMutationAccess,
) {
  for (const p of access.permissions) authorize(context, p);
  if (access.kind !== "create") {
    if (!access.id) throw new CatalogAccessNotFoundError();
    const checks = {
      spu: assertCatalogSpuAccess,
      sku: assertCatalogSkuAccess,
      recipe: assertCatalogRecipeAccess,
      artwork: assertCatalogArtworkAccess,
      specification: assertCatalogSpecificationAccess,
      listing: assertCatalogListingAccess,
    };
    if (access.kind in checks)
      await checks[access.kind as keyof typeof checks](
        tx,
        context,
        access.id,
        access.permissions,
        true,
      );
    else if (access.kind === "specificationVersion") {
      const [v] = await tx
        .select({ id: productSpecificationVersions.specificationId })
        .from(productSpecificationVersions)
        .where(eq(productSpecificationVersions.id, access.id));
      if (!v) throw new CatalogAccessNotFoundError();
      await assertCatalogSpecificationAccess(tx, context, v.id, access.permissions, true);
    } else if (access.kind === "artworkVersion") {
      const [v] = await tx
        .select({ id: artworkMasterVersions.artworkId })
        .from(artworkMasterVersions)
        .where(eq(artworkMasterVersions.id, access.id));
      if (!v) throw new CatalogAccessNotFoundError();
      await assertCatalogArtworkAccess(tx, context, v.id, access.permissions, true);
    } else if (access.kind === "package") {
      const [v] = await tx
        .select({ id: salesPackageVersions.skuId })
        .from(salesPackageVersions)
        .where(eq(salesPackageVersions.id, access.id));
      if (!v) throw new CatalogAccessNotFoundError();
      await assertCatalogSkuAccess(tx, context, v.id, access.permissions, true);
    } else if (access.kind === "listingVersion") {
      const [v] = await tx
        .select({ ownerId: listings.createdBy })
        .from(listingVersions)
        .innerJoin(listings, eq(listings.id, listingVersions.listingId))
        .where(eq(listingVersions.id, access.id));
      if (!v) throw new CatalogAccessNotFoundError();
      for (const p of access.permissions) authorize(context, p, v);
    } else if (access.kind === "account") {
      const [v] = await tx
        .select({ ownerId: marketplaceAccounts.createdBy })
        .from(marketplaceAccounts)
        .where(eq(marketplaceAccounts.id, access.id));
      if (!v) throw new CatalogAccessNotFoundError();
      for (const p of access.permissions) authorize(context, p, v);
    } else if (access.kind === "research" || access.kind === "creativeVersion") {
      const table = access.kind === "research" ? researchItems : creativeDesignVersions;
      const owner =
        access.kind === "research" ? researchItems.ownerUserId : creativeDesignVersions.createdBy;
      const [row] = await tx
        .select({ ownerId: owner })
        .from(table)
        .where(eq(table.id, access.id))
        .for("share");
      if (!row) throw new CatalogAccessNotFoundError();
      for (const permission of access.permissions) authorize(context, permission, row);
      if (access.kind === "creativeVersion") {
        const sources = await tx
          .select({ id: creativeDesignVersionAssets.assetId })
          .from(creativeDesignVersionAssets)
          .where(
            and(
              eq(creativeDesignVersionAssets.creativeDesignVersionId, access.id),
              eq(creativeDesignVersionAssets.role, "master"),
            ),
          );
        for (const source of sources.sort((a, b) => a.id.localeCompare(b.id)))
          await assertCatalogMutationAccess(tx, context, {
            kind: "asset",
            id: source.id,
            permissions: [Permission.AssetRead],
          });
      }
    } else if (access.kind === "asset") {
      authorize(context, Permission.AssetRead);
      const [row] = await tx
        .select({ ownerId: assetFiles.ownerUserId })
        .from(assetFiles)
        .where(
          and(
            eq(assetFiles.id, access.id),
            catalogAssetReadFilter(context, assetFiles.ownerUserId, assetFiles.id),
          ),
        )
        .for("share");
      if (!row) throw new CatalogAccessNotFoundError();
      for (const permission of access.permissions)
        if (permission !== Permission.AssetRead) authorize(context, permission, row);
    } else if (access.kind === "artworkCode") {
      const [master] = await tx
        .select({ id: artworkMasters.id })
        .from(artworkMasters)
        .where(sql`lower(${artworkMasters.code})=${access.id.toLowerCase()}`);
      if (master)
        await assertCatalogArtworkAccess(tx, context, master.id, access.permissions, true);
    } else if (access.kind === "salesPlan") {
      const [plan] = await tx
        .select({ spuId: salesPlans.spuId })
        .from(salesPlans)
        .where(eq(salesPlans.id, access.id));
      if (!plan) throw new CatalogAccessNotFoundError();
      await assertCatalogSpuAccess(tx, context, plan.spuId, access.permissions, true);
    } else if (access.kind === "salesPlanListings") {
      const rows = await tx
        .select({ ownerId: listings.createdBy })
        .from(listings)
        .where(eq(listings.salesPlanId, access.id));
      for (const row of rows) for (const p of access.permissions) authorize(context, p, row);
    } else if (access.kind === "recipeArtwork") {
      const [recipe] = await tx
        .select({ id: salesRecipeVersions.artworkVersionId })
        .from(salesRecipeVersions)
        .where(eq(salesRecipeVersions.id, access.id));
      if (!recipe) throw new CatalogAccessNotFoundError();
      const pins = await tx
        .select({ id: salesRecipePrintBindings.artworkVersionId })
        .from(salesRecipePrintBindings)
        .where(eq(salesRecipePrintBindings.recipeId, access.id));
      for (const id of [
        ...new Set([recipe.id, ...pins.map((p) => p.id)].filter((v): v is string => Boolean(v))),
      ].sort())
        await assertCatalogMutationAccess(tx, context, {
          kind: "artworkVersion",
          id,
          permissions: access.permissions,
        });
    } else throw new CatalogAccessNotFoundError();
  }
  for (const extra of access.additional ?? [])
    await assertCatalogMutationAccess(tx, context, extra);
}

export function catalogRecipeReadFilter(context: TenantContext, recipeColumn: SQLWrapper) {
  if (
    !context.permissions.includes(Permission.ProductRead) ||
    !context.permissions.includes(Permission.DesignRead)
  )
    return sql`false`;
  const plan = catalogOwnerFilter(
    context,
    Permission.ProductRead,
    sql`scope_plan.created_by`,
    sql`scope_plan.team_id`,
  );
  const artwork = catalogOwnerFilter(
    context,
    Permission.DesignRead,
    sql`scope_master.created_by`,
    sql`scope_master.team_id`,
  );
  return and(
    plan
      ? sql`exists(select 1 from sales_recipe_versions scope_recipe join skus scope_sku on scope_sku.id=scope_recipe.sku_id join spus scope_spu on scope_spu.id=scope_sku.spu_id join product_plans scope_plan on scope_plan.id=scope_spu.product_plan_id where scope_recipe.id=${recipeColumn} and ${plan})`
      : undefined,
    artwork
      ? sql`not exists(select 1 from sales_recipe_versions scope_recipe join artwork_master_versions scope_version on scope_version.id=scope_recipe.artwork_version_id join artwork_masters scope_master on scope_master.id=scope_version.artwork_id where scope_recipe.id=${recipeColumn} and not coalesce(${artwork},false)) and not exists(select 1 from sales_recipe_print_bindings scope_binding join artwork_master_versions scope_version on scope_version.id=scope_binding.artwork_version_id join artwork_masters scope_master on scope_master.id=scope_version.artwork_id where scope_binding.recipe_id=${recipeColumn} and not coalesce(${artwork},false))`
      : undefined,
  );
}
/** Approved package metadata carries both recipe and Listing information. */
export function catalogPackageReadFilter(
  context: TenantContext,
  recipeColumn: SQLWrapper,
  listingColumn: SQLWrapper,
) {
  if (
    ![Permission.ProductRead, Permission.DesignRead, Permission.ListingRead].every((p) =>
      context.permissions.includes(p),
    )
  )
    return sql`false`;
  const listing = catalogOwnerFilter(
    context,
    Permission.ListingRead,
    sql`scope_package_listing.created_by`,
  );
  return and(
    catalogRecipeReadFilter(context, recipeColumn),
    listing
      ? sql`exists(select 1 from listings scope_package_listing where scope_package_listing.id=${listingColumn} and ${listing})`
      : undefined,
  );
}
export async function assertCatalogRecipeRead(
  tx: TenantTransaction,
  context: TenantContext,
  id: string,
) {
  const [recipe] = await tx
    .select({ id: salesRecipeVersions.id, skuId: salesRecipeVersions.skuId })
    .from(salesRecipeVersions)
    .where(
      and(eq(salesRecipeVersions.id, id), catalogRecipeReadFilter(context, salesRecipeVersions.id)),
    );
  if (!recipe) throw new CatalogAccessNotFoundError();
  await assertCatalogSkuAccess(tx, context, recipe.skuId, [Permission.ProductRead]);
  return recipe;
}

export function catalogAssetReadFilter(
  context: TenantContext,
  owner: SQLWrapper,
  assetId: SQLWrapper,
) {
  authorize(context, Permission.AssetRead);
  const scope = permissionScope(context, Permission.AssetRead);
  if (scope === "tenant") return undefined;
  const own = eq(owner, context.userId),
    ids = catalogTeamIds(context);
  if (scope !== "team" || !ids.length) return own;
  return or(
    own,
    sql`exists(select 1 from artwork_master_versions shared_version join artwork_masters shared_master on shared_master.id=shared_version.artwork_id where ${inArray(sql`shared_master.team_id`, ids)} and (shared_version.asset_id=${assetId} or shared_version.materials @> jsonb_build_array(jsonb_build_object('assetId',${assetId}::text))))`,
  );
}
