import { ProductionManufacturingPinSchema, type ProductionManufacturingPin } from "@yummyai/contracts/order/production-manufacturing";
import { productionManufacturingBindings as bindings, manufacturingRecipes, manufacturingRecipeVersions, productSpecificationVersions, type TenantTransaction } from "@yummyai/database";
import { eq, inArray } from "drizzle-orm";
export async function readProductionManufacturingPins(tx: TenantTransaction, productionVersionIds: string[]) {
  const result = new Map<string, ProductionManufacturingPin>();
  if (!productionVersionIds.length) return result;
  const rows = await tx.select({ binding: bindings, recipe: manufacturingRecipes, version: manufacturingRecipeVersions, specification: productSpecificationVersions })
    .from(bindings).innerJoin(manufacturingRecipes, eq(manufacturingRecipes.id, bindings.recipeId))
    .innerJoin(manufacturingRecipeVersions, eq(manufacturingRecipeVersions.id, bindings.manufacturingVersionId))
    .innerJoin(productSpecificationVersions, eq(productSpecificationVersions.id, bindings.specificationVersionId)).where(inArray(bindings.productionVersionId, productionVersionIds));
  for (const { binding, recipe, version, specification } of rows) result.set(binding.productionVersionId, ProductionManufacturingPinSchema.parse({
    id: binding.id, bindingVersion: binding.bindingVersion, productionOrderId: binding.productionOrderId, productionVersionId: binding.productionVersionId,
    recipeId: recipe.id, versionId: version.id, reviewId: binding.reviewId, versionNumber: version.versionNumber, code: recipe.code, name: version.name,
    spuId: recipe.spuId, skuId: binding.skuId, specificationId: recipe.specificationId, specificationVersionId: binding.specificationVersionId,
    processProfileVersionId: specification.processProfileVersionId, canvasPrintSpecVersionId: specification.canvasPrintSpecVersionId,
    source: binding.source, workRevisionId: binding.sourceWorkRevisionId, originalBindingId: binding.originalBindingId, quantity: binding.quantity,
    unit: binding.outputUnit, quantityBasis: "ordered_sku_units", contentChecksum: binding.contentChecksum, createdAt: binding.createdAt.toISOString(),
  }));
  return result;
}
