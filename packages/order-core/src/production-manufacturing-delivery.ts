import { createHash } from "node:crypto";
import { OriginalOwnerError } from "@yummyai/contracts/common/original-owner-error";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { ManufacturingRecipeContentSchema, calculateManufacturingDemand } from "@yummyai/contracts/catalog/manufacturing";
import { FactoryManufacturingPlanContentSchema, FactoryManufacturingPlanSchema, ProductionDeliveryManufacturingSchema } from "@yummyai/contracts/order/manufacturing-delivery";
import { productionManufacturingBindings, manufacturingRecipes, manufacturingRecipeVersions, type TenantTransaction } from "@yummyai/database";
import { eq } from "drizzle-orm";

/** Internal order-owner read, called only after the enclosing order or assigned-factory scope is authorized. */
export async function readVerifiedManufacturingBasis(tx: TenantTransaction, productionVersionId: string) {
  const [row] = await tx.select({ binding: productionManufacturingBindings, code: manufacturingRecipes.code, versionNumber: manufacturingRecipeVersions.versionNumber })
    .from(productionManufacturingBindings).innerJoin(manufacturingRecipes, eq(manufacturingRecipes.id, productionManufacturingBindings.recipeId))
    .innerJoin(manufacturingRecipeVersions, eq(manufacturingRecipeVersions.id, productionManufacturingBindings.manufacturingVersionId))
    .where(eq(productionManufacturingBindings.productionVersionId, productionVersionId));
  if (!row) return null;
  try {
    const { binding } = row;
    if (hash(binding.contentCanonical) !== binding.contentChecksum) throw new Error("Invalid sealed bytes");
    const content = ManufacturingRecipeContentSchema.parse(JSON.parse(binding.contentCanonical));
    if (canonicalJson(content) !== binding.contentCanonical || content.specificationVersionId !== binding.specificationVersionId || content.outputUnit !== binding.outputUnit)
      throw new Error("Invalid original manufacturing basis");
    const demand = calculateManufacturingDemand(content, binding.quantity);
    return { ...row, content, demand };
  } catch { throw new OriginalOwnerError(409, "原生产制造依据校验失败 请核对原版本后重新交付"); }
}

export async function readManufacturingDelivery(tx: TenantTransaction, productionVersionId: string) {
  const row = await readVerifiedManufacturingBasis(tx, productionVersionId);
  if (!row) return null;
  const { binding, content, demand } = row;
    const publicContent = FactoryManufacturingPlanContentSchema.parse({ schemaVersion: 1, code: row.code, name: content.name, versionNumber: row.versionNumber,
      sourceContentChecksum: binding.contentChecksum, quantity: binding.quantity, unit: binding.outputUnit, recipeOutputQuantity: content.outputQuantity, proposalOnly: true,
      materials: content.materials.map((line, index) => ({ code: line.code, name: line.name, unit: line.unit, responsibility: line.responsibility, operationCode: line.operationCode,
        recipeQuantityNumerator: line.quantityNumerator, recipeQuantityDenominator: line.quantityDenominator, lossBps: line.lossBps, lossBasis: line.lossBasis,
        plannedNumerator: demand.lines[index]!.exactNumerator, plannedDenominator: demand.lines[index]!.exactDenominator })),
      operations: content.operations.map(line => ({ code: line.code, name: line.name, processCode: line.processCode, responsibility: line.responsibility })) });
    const plan = FactoryManufacturingPlanSchema.parse({ ...publicContent, checksum: hash(canonicalJson(publicContent)) });
    return ProductionDeliveryManufacturingSchema.parse({ bindingId: binding.id, versionId: binding.manufacturingVersionId, specificationVersionId: binding.specificationVersionId,
      sourceWorkRevisionId: binding.sourceWorkRevisionId, sourceContentChecksum: binding.contentChecksum, plan });
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
