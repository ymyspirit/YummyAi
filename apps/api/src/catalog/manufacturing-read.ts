import { NotFoundException } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import { ManufacturingRecipeContentSchema, type ManufacturingRecipeVersionView } from "@yummyai/contracts/catalog/manufacturing";
import { type manufacturingRecipes, manufacturingRecipeVersions as versions, manufacturingBomLines as materials,
  manufacturingOperations as operations, manufacturingRecipeReviews as reviews, productSpecificationVersions, type TenantTransaction } from "@yummyai/database";

/** Owning catalog reader; callers must authorize the original SPU in the same transaction. */
export async function readManufacturingVersion(tx: TenantTransaction, root: typeof manufacturingRecipes.$inferSelect, versionId: string): Promise<ManufacturingRecipeVersionView> {
  const [row] = await tx.select().from(versions).where(and(eq(versions.id, versionId), eq(versions.recipeId, root.id)));
  if (!row) throw new NotFoundException("制造版本不存在或不可访问");
  const lines = await tx.select({ payload: materials.payload }).from(materials).where(eq(materials.versionId, versionId)).orderBy(asc(materials.position));
  const steps = await tx.select({ payload: operations.payload }).from(operations).where(eq(operations.versionId, versionId)).orderBy(asc(operations.position));
  const [review] = await tx.select().from(reviews).where(eq(reviews.versionId, versionId));
  const [spec] = await tx.select({ number: productSpecificationVersions.versionNumber }).from(productSpecificationVersions).where(eq(productSpecificationVersions.id, row.specificationVersionId));
  return { recipeId: root.id, versionId, versionNumber: row.versionNumber, spuId: root.spuId, specificationId: root.specificationId, code: root.code,
    createdAt: row.createdAt.toISOString(), specificationVersionNumber: spec!.number, content: ManufacturingRecipeContentSchema.parse({ specificationVersionId: row.specificationVersionId,
      name: row.name, outputQuantity: row.outputQuantity, outputUnit: row.outputUnit, notes: row.notes, materials: lines.map(item => item.payload), operations: steps.map(item => item.payload) }),
    review: review ? { decision: review.decision as "approved" | "rejected", note: review.note, reviewedAt: review.createdAt.toISOString() } : null };
}
