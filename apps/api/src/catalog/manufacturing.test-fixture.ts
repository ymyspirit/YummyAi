import { randomUUID } from "node:crypto";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { CreateStockItemInputSchema } from "@yummyai/contracts/inventory";
import type { ProductionProductType } from "@yummyai/contracts/pod/production-editor";
import {
  withTenant, productPlans, spus, productSpecifications, productSpecificationVersions,
  productionEditorProjects, productionEditorVersions, printProfiles, printProfileVersions,
  inventoryStockItems, type DatabaseConnection,
} from "@yummyai/database";
import { syntheticSpecificationFacts } from "../../../../tools/testing/specification-fixtures.js";
import { requireDisposableIntegrationEnvironment } from "../../../../tools/testing/require-disposable-integration.mjs";

/** Referential fixtures only. No artwork is rendered, approved or released to a factory. */
export async function manufacturingBasis(db: DatabaseConnection, context: TenantContext, productType: ProductionProductType = "rectangular_print") {
  requireDisposableIntegrationEnvironment();
  const planId = createEntityId(), spuId = createEntityId(), specificationId = createEntityId(), specificationVersionId = createEntityId();
  const projectId = createEntityId(), editorVersionId = createEntityId(), profileId = createEntityId(), profileVersionId = createEntityId(), stockId = createEntityId();
  const stock = CreateStockItemInputSchema.parse({ skuId: null, code: `SYNTHETIC-${randomUUID()}`.toUpperCase(), name: "Synthetic fabric", baseUnit: "meter" });
  await withTenant(db.db, context, async tx => {
    await tx.insert(productPlans).values({ id: planId, tenantId: context.tenantId, name: "Synthetic textile", createdBy: context.userId, status: "approved", customization: { version: 1, fields: [] } });
    await tx.insert(spus).values({ id: spuId, tenantId: context.tenantId, productPlanId: planId, code: randomUUID(), name: "Synthetic textile", customization: { version: 1, fields: [] } });
    await tx.insert(productionEditorProjects).values({ id: projectId, tenantId: context.tenantId, name: "Synthetic process reference", createdBy: context.userId });
    await tx.insert(productionEditorVersions).values({ id: editorVersionId, tenantId: context.tenantId, projectId, versionNumber: 1,
      encryptedDocument: "synthetic-unused-process-reference", checksum: "a".repeat(64), createdBy: context.userId });
    await tx.insert(printProfiles).values({ id: profileId, tenantId: context.tenantId, code: randomUUID() });
    await tx.insert(printProfileVersions).values({ id: profileVersionId, tenantId: context.tenantId, profileId, versionNumber: 1, name: "Synthetic process",
      productType, projectId, sourceVersionId: editorVersionId, instructions: "Synthetic reference only", idempotencyKey: randomUUID(), requestHash: "b".repeat(64), createdBy: context.userId });
    await tx.insert(productSpecifications).values({ id: specificationId, tenantId: context.tenantId, spuId, code: randomUUID(), createdBy: context.userId });
    await tx.insert(productSpecificationVersions).values({ id: specificationVersionId, tenantId: context.tenantId, specificationId, versionNumber: 1,
      name: "Synthetic measured specification", attributes: {}, facts: syntheticSpecificationFacts(), processProfileVersionId: profileVersionId, createdBy: context.userId });
    await tx.insert(inventoryStockItems).values({ ...stock, id: stockId, tenantId: context.tenantId, createdBy: context.userId });
  });
  return { planId, spuId, specificationId, specificationVersionId, profileVersionId, stockId };
}
