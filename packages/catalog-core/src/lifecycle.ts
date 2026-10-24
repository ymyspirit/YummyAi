import { authorize, Permission, permissionScope } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import {
  loadCurrentMembershipContext,
  productPlans,
  salesRecipeVersions,
  skus,
  spus,
  type TenantTransaction,
} from "@yummyai/database";
import { eq } from "drizzle-orm";
import {
  assertCatalogRecipeAccess,
  assertCatalogRecipeRead,
  CatalogAccessNotFoundError,
  catalogTeamIds,
  currentCatalogContext,
} from "./access.js";
import { CatalogError } from "./errors.js";

async function catalogSource(tx: TenantTransaction, spuId: string, skuId: string | undefined, lock: boolean) {
  const parents = tx.select({ spu: spus, plan: productPlans }).from(spus)
    .innerJoin(productPlans, eq(productPlans.id, spus.productPlanId)).where(eq(spus.id, spuId));
  const [parent] = await (lock ? parents.for("share") : parents);
  if (!parent) throw new CatalogAccessNotFoundError();
  const archived: Array<"product_plan" | "spu" | "sku"> = [];
  if (parent.plan.status === "archived") archived.push("product_plan");
  if (parent.spu.status === "archived") archived.push("spu");
  if (skuId) {
    const query = tx.select({ spuId: skus.spuId, status: skus.status }).from(skus).where(eq(skus.id, skuId));
    const [sku] = await (lock ? query.for("share") : query);
    if (!sku || sku.spuId !== spuId) throw new CatalogAccessNotFoundError();
    if (sku.status === "archived") archived.push("sku");
  }
  return { parent, lifecycle: { active: archived.length === 0, archived } };
}

function requireActive(active: boolean) {
  if (!active) throw new CatalogError("CATALOG_SOURCE_ARCHIVED", 409, "产品、企划或销售 SKU 已归档 不能继续新的制作操作");
}

/** Shared owning check for new catalog commands and native editor execution. */
export async function assertCatalogSourceActive(tx: TenantTransaction, spuId: string, skuId?: string) {
  requireActive((await catalogSource(tx, spuId, skuId, true)).lifecycle.active);
}

export type CatalogEditorOperation = "read" | "edit" | "review" | "render" | "manage";
type EditorSource = {
  sourceSalesRecipeId: string | null;
  sourceSalesSkuId: string | null;
  createdBy: string;
  archivedAt?: Date | null;
};

/** Queue identity only routes a lookup. It never supplies the executing grants. */
export async function assertCatalogEditorSource(
  tx: TenantTransaction,
  input: TenantContext,
  source: EditorSource,
  options: { operation: CatalogEditorOperation; reloadMembership?: boolean },
) {
  if (!source.sourceSalesRecipeId && !source.sourceSalesSkuId) return null;
  if (!source.sourceSalesRecipeId || !source.sourceSalesSkuId) throw new CatalogAccessNotFoundError();
  const context = options.reloadMembership
    ? await loadCurrentMembershipContext(tx, input, { lock: true })
    : await currentCatalogContext(tx, input);
  const ref = await assertCatalogRecipeRead(tx, context, source.sourceSalesRecipeId);
  if (ref.skuId !== source.sourceSalesSkuId) throw new CatalogAccessNotFoundError();
  const [recipe] = await tx.select().from(salesRecipeVersions).where(eq(salesRecipeVersions.id, ref.id));
  const [sku] = await tx.select({ spuId: skus.spuId }).from(skus).where(eq(skus.id, ref.skuId));
  if (!recipe || !sku) throw new CatalogAccessNotFoundError();
  const write = options.operation !== "read";
  const designPermission = !write ? Permission.DesignRead : options.operation === "review" ? Permission.DesignReview : Permission.DesignWrite;
  authorize(context, designPermission);
  if (write) await assertCatalogRecipeAccess(tx, context, ref.id, [Permission.ProductWrite]);
  if (options.operation === "render") authorize(context, Permission.AssetRead);
  const { parent, lifecycle } = await catalogSource(tx, sku.spuId, ref.skuId, write);
  const scope = permissionScope(context, designPermission);
  if (scope !== "tenant" && source.createdBy !== context.userId &&
    !(scope === "team" && parent.plan.teamId && catalogTeamIds(context).includes(parent.plan.teamId)))
    throw new CatalogAccessNotFoundError();
  if (write && options.operation !== "manage") {
    requireActive(lifecycle.active && !source.archivedAt);
    if ((options.operation === "edit" || options.operation === "review") && recipe.status === "approved")
      throw new CatalogError("CATALOG_RECIPE_LOCKED", 409, "已审核制作版本不可修改 请从产品开发创建新版本");
  }
  return { context, recipe, lifecycle: { ...lifecycle, active: lifecycle.active && !source.archivedAt } };
}
