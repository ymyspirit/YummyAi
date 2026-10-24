import { ConflictException, NotFoundException } from "@nestjs/common";
import { authorize, Permission } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import type { OrderWorkDraft } from "@yummyai/contracts/order/workspace";
import { manufacturingApprovalProblems } from "@yummyai/contracts/catalog/manufacturing";
import { specificationFactsReady } from "@yummyai/contracts/catalog/specification-facts";
import { assertCatalogSourceActive, assertCatalogSpuAccess, currentCatalogContext } from "@yummyai/catalog-core";
import { manufacturingRecipes as recipes, manufacturingRecipeVersions as versions, manufacturingRecipeReviews as reviews,
  spus, productSpecifications, productSpecificationVersions, inventoryStockItems, salesRecipeVersions, printProfileVersions, skus, type TenantTransaction } from "@yummyai/database";
import { and, asc, desc, lt, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { throwCatalogFailure } from "./catalog-access.js";
import { readManufacturingVersion } from "./manufacturing-read.js";
import { catalogContextAuthority } from "@yummyai/catalog-core";
import { ProductionManufacturingOptionsSchema } from "@yummyai/contracts/order/production-manufacturing";
import { ProductionProductTypeSchema } from "@yummyai/contracts/pod/production-editor";

export type ManufacturingProductionSource =
  | { kind: "order_work_revision"; specificationVersionId: string; processProfileVersionId: string }
  | { kind: "approved_product_confirmation"; specificationVersionId: string }
  | { kind: "original_production_binding"; specificationVersionId: string; processProfileVersionId: string };

/** Read only immutable references in the actual decrypted revision, never today's channel mapping. */
export async function manufacturingSourceFromOrderDraft(tx: TenantTransaction, draft: OrderWorkDraft, profileVersionId: string) {
  const [recipe] = draft.salesRecipeVersionId ? await tx.select({ specificationVersionId: salesRecipeVersions.specificationVersionId, skuId: salesRecipeVersions.skuId })
    .from(salesRecipeVersions).where(eq(salesRecipeVersions.id, draft.salesRecipeVersionId)) : [];
  const specificationVersionId = draft.specificationVersionId ?? recipe?.specificationVersionId;
  if (!specificationVersionId || draft.salesRecipeVersionId && !recipe || draft.printProfileVersionId !== profileVersionId ||
      recipe && recipe.specificationVersionId !== specificationVersionId)
    throw new ConflictException("原审单未固定一致的产品规格 请先补齐新审单版本并重新审核");
  return { kind: "order_work_revision" as const, specificationVersionId, processProfileVersionId: profileVersionId, skuId: recipe?.skuId ?? null };
}

/** Whole-order callers acquire catalog parents in a consistent order before individual bindings. */
export async function lockManufacturingProductionVersions(tx: TenantTransaction, input: TenantContext, selectedIds: string[]) {
  try {
    const ids = [...new Set(z.array(z.uuidv7()).min(1).max(100).parse(selectedIds))];
    const current = await currentCatalogContext(tx, input); authorize(current, Permission.ProductRead);
    const rows = await tx.select({ root: recipes, planId: spus.productPlanId }).from(versions)
      .innerJoin(recipes, eq(recipes.id, versions.recipeId)).innerJoin(spus, eq(spus.id, recipes.spuId))
      .where(inArray(versions.id, ids)).orderBy(asc(spus.productPlanId), asc(recipes.id));
    if (rows.length !== ids.length) throw new NotFoundException("制造版本不存在或不可读取");
    for (const { root, planId } of [...new Map(rows.map(row => [row.root.id, row])).values()]) {
      const parent = await assertCatalogSpuAccess(tx, current, root.spuId, [Permission.ProductRead], true);
      if (parent.planId !== planId) throw new ConflictException("产品归属已变化 请重新核对制造来源");
      await tx.select({ id: recipes.id }).from(recipes).where(eq(recipes.id, root.id)).for("update");
    }
  } catch (error) { throwCatalogFailure(error); }
}

/** Catalog-owned validation inside the production transaction; it does not reserve or post material. */
export async function approvedManufacturingForProduction(tx: TenantTransaction, input: TenantContext, versionId: string, source: ManufacturingProductionSource) {
  try {
    z.uuidv7().parse(versionId); z.uuidv7().parse(source.specificationVersionId);
    await lockManufacturingProductionVersions(tx, input, [versionId]);
    const [record] = await tx.select({ root: recipes, version: versions }).from(versions)
      .innerJoin(recipes, eq(recipes.id, versions.recipeId)).where(eq(versions.id, versionId));
    if (!record) throw new NotFoundException("制造版本不存在或不可读取");
    if (record.root.archivedAt) throw new ConflictException("制造模板已停用 请重新核对");
    await assertCatalogSourceActive(tx, record.root.spuId);
    if (record.version.specificationVersionId !== source.specificationVersionId) throw new ConflictException("制造版本必须与本次生产固定的原产品规格一致");
    const specification = await readProductionSpecification(tx, input, source);
    if (specification.spuId !== record.root.spuId) throw new ConflictException("制造版本与原产品归属不一致");
    const [review] = await tx.select().from(reviews).where(and(eq(reviews.versionId, versionId), eq(reviews.decision, "approved")));
    if (!review) throw new ConflictException("生产必须明确选择已批准的制造版本");
    const view = await readManufacturingVersion(tx, record.root, versionId);
    if (manufacturingApprovalProblems(view.content).length) throw new ConflictException("已选制造版本的材料或工序依据不完整");
    if (view.content.outputUnit === "each" && specification.facts.packageQuantity !== 1 ||
        view.content.outputUnit === "pair" && specification.facts.packageQuantity !== 2)
      throw new ConflictException("制造产出单位与原规格每份件数不一致 请明确件、双、套后新建并审核制造版本");
    const ids = [...new Set(view.content.materials.map(line => line.stockItemId!))].sort();
    const stock = ids.length ? await tx.select({ id: inventoryStockItems.id, status: inventoryStockItems.status, unit: inventoryStockItems.baseUnit })
      .from(inventoryStockItems).where(inArray(inventoryStockItems.id, ids)).orderBy(asc(inventoryStockItems.id)).for("share") : [];
    if (view.content.materials.some(line => !stock.some(item => item.id === line.stockItemId && item.status === "active" && item.unit === line.unit)))
      throw new ConflictException("制造版本关联物料已停用、不可用或基本单位已变化 请商品负责人复核");
    return { view, reviewId: review.id, source, processProfileVersionId: specification.processProfileVersionId, canvasPrintSpecVersionId: specification.canvasPrintSpecVersionId,
      dimensionBasis: specification.facts.physicalDimensions?.basis ?? null,
      factoryBasis: specificationFactoryBasis(specification) };
  } catch (error) { throwCatalogFailure(error); }
}

/** Read-only factory choices and submission share the exact original specification. */
export async function productionFactorySource(tx: TenantTransaction, input: TenantContext, source: ManufacturingProductionSource, skuId: string | null) {
  try {
    const specification = await readProductionSpecification(tx, input, source);
    return { processProfileVersionId: specification.processProfileVersionId, spuId: specification.spuId,
      skuId: await manufacturingSku(tx, skuId, specification.spuId), dimensionBasis: specification.facts.physicalDimensions?.basis ?? null,
      factoryBasis: specificationFactoryBasis(specification) };
  } catch (error) { throwCatalogFailure(error); }
}

async function readProductionSpecification(tx: TenantTransaction, input: TenantContext, source: ManufacturingProductionSource) {
  const current = await currentCatalogContext(tx, input); authorize(current, Permission.ProductRead);
  const [specification] = await tx.select({ facts: productSpecificationVersions.facts, processProfileVersionId: printProfileVersions.id,
    productType: printProfileVersions.productType, productPlanId: spus.productPlanId, canvasPrintSpecVersionId: productSpecificationVersions.canvasPrintSpecVersionId,
    versionNumber: productSpecificationVersions.versionNumber, currentVersionNumber: productSpecifications.versionNumber, spuId: productSpecifications.spuId })
    .from(productSpecificationVersions).innerJoin(productSpecifications, eq(productSpecifications.id, productSpecificationVersions.specificationId))
    .innerJoin(spus, eq(spus.id, productSpecifications.spuId)).innerJoin(printProfileVersions, eq(printProfileVersions.id, productSpecificationVersions.processProfileVersionId))
    .where(eq(productSpecificationVersions.id, source.specificationVersionId));
  if (!specification || !specificationFactsReady(specification.facts)) throw new ConflictException("原产品规格的制造事实尚未完整核实");
  await assertCatalogSpuAccess(tx, current, specification.spuId, [Permission.ProductRead]);
  await assertCatalogSourceActive(tx, specification.spuId);
  if (source.kind !== "approved_product_confirmation" && specification.processProfileVersionId !== source.processProfileVersionId)
    throw new ConflictException("制造规格与本单原审核工艺版本不一致");
  if (source.kind === "approved_product_confirmation" && specification.currentVersionNumber !== specification.versionNumber)
    throw new ConflictException("本次商品确认须引用当前完整规格 不能替代原审单版本");
  return specification;
}

function specificationFactoryBasis(specification: Awaited<ReturnType<typeof readProductionSpecification>>) {
  const measurement = specification.facts.physicalDimensions;
  const lengths = measurement ? [measurement.length, measurement.width, measurement.height].filter((value): value is number => value !== null) : [];
  const scale = measurement?.unit === "in" ? 25.4 : measurement?.unit === "cm" ? 10 : measurement?.unit === "mm" ? 1 : null;
  return { productPlanId: specification.productPlanId, productType: ProductionProductTypeSchema.parse(specification.productType),
    longestMm: scale && lengths.length ? Math.max(...lengths) * scale : null, templateVersionId: specification.processProfileVersionId };
}

/** Check a production SKU inside the same catalog authority boundary; never substitute another SPU. */
export async function manufacturingSku(tx: TenantTransaction, skuId: string | null, spuId: string) {
  if (!skuId) return null;
  const [sku] = await tx.select({ id: skus.id, spuId: skus.spuId, status: skus.status }).from(skus).where(eq(skus.id, skuId)).for("share");
  if (!sku || sku.spuId !== spuId || sku.status === "archived") throw new ConflictException("生产 SKU 与原产品规格不一致或已归档 请重新核对原制作依据");
  return sku.id;
}

export async function productionManufacturingOptions(tx: TenantTransaction, input: TenantContext, specificationVersionId: string | null, after?: string) {
  try {
    const current = await currentCatalogContext(tx, input); authorize(current, Permission.ProductRead);
    const contextAuthority = catalogContextAuthority(current);
    if (!specificationVersionId) return ProductionManufacturingOptionsSchema.parse({ source: null, items: [], nextCursor: null, contextAuthority,
      diagnostics: ["原制作来源尚未固定完整产品规格 请先补齐审单并重新推送、审核"] });
    const [source] = await tx.select({ specification: productSpecificationVersions, identity: productSpecifications }).from(productSpecificationVersions)
      .innerJoin(productSpecifications, eq(productSpecifications.id, productSpecificationVersions.specificationId)).where(eq(productSpecificationVersions.id, specificationVersionId));
    if (!source) throw new NotFoundException("原产品规格不存在或不可读取");
    await assertCatalogSpuAccess(tx, current, source.identity.spuId, [Permission.ProductRead]);
    await assertCatalogSourceActive(tx, source.identity.spuId);
    if (!source.specification.processProfileVersionId || !specificationFactsReady(source.specification.facts)) return ProductionManufacturingOptionsSchema.parse({ source: null, items: [], nextCursor: null, contextAuthority,
      diagnostics: ["原产品规格的工艺、尺寸口径或制造事实不完整 请核对新的审单及审核稿"] });
    const rows = await tx.select({ root: recipes, version: versions, approvedAt: reviews.createdAt }).from(versions)
      .innerJoin(recipes, eq(recipes.id, versions.recipeId)).innerJoin(reviews, eq(reviews.versionId, versions.id))
      .where(and(eq(versions.specificationVersionId, specificationVersionId), eq(reviews.decision, "approved"), isNull(recipes.archivedAt), after ? lt(versions.id, z.uuidv7().parse(after)) : undefined))
      .orderBy(desc(versions.id)).limit(26);
    const page = rows.slice(0, 25);
    return ProductionManufacturingOptionsSchema.parse({ source: { specificationVersionId, specificationId: source.identity.id, spuId: source.identity.spuId,
      name: source.specification.name, versionNumber: source.specification.versionNumber, packageContents: source.specification.facts.packageContents,
      packageQuantity: source.specification.facts.packageQuantity, processProfileVersionId: source.specification.processProfileVersionId },
      items: page.map(({ root, version, approvedAt }) => ({ versionId: version.id, recipeId: root.id, code: root.code, name: version.name,
        versionNumber: version.versionNumber, outputQuantity: version.outputQuantity, outputUnit: version.outputUnit, approvedAt: approvedAt.toISOString() })),
      nextCursor: rows.length > 25 ? page.at(-1)!.version.id : null, diagnostics: page.length ? [] : ["原规格尚无已批准制造版本 请商品负责人建立并审核"], contextAuthority });
  } catch (error) { throwCatalogFailure(error); }
}
