import { ConflictException, NotFoundException } from "@nestjs/common";
import { authorize, Permission } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import type { SpecificationFacts } from "@yummyai/contracts/catalog/specification-facts";
import { ProductionProductTypeSchema } from "@yummyai/contracts/pod/production-editor";
import { assertCatalogEditorSource } from "@yummyai/catalog-core";
import { printProfiles, printProfileVersions, productionEditorProjects, productionEditorVersions, type TenantTransaction } from "@yummyai/database";
import { and, eq } from "drizzle-orm";
import { assertSpecificationProductionRuleReferences } from "../rules/rule-center.service.js";

/** A registered profile already pins a physically confirmed document. Recheck its reviewed general source before a new confirmation. */
async function assertProductionProfileAvailable(tx: TenantTransaction, context: TenantContext, versionId: string) {
  authorize(context, Permission.DesignRead);
  const [source] = await tx.select({ profile: printProfiles, version: printProfileVersions, project: productionEditorProjects })
    .from(printProfileVersions).innerJoin(printProfiles, eq(printProfiles.id, printProfileVersions.profileId))
    .innerJoin(productionEditorProjects, eq(productionEditorProjects.id, printProfileVersions.projectId))
    .innerJoin(productionEditorVersions, and(eq(productionEditorVersions.id, printProfileVersions.sourceVersionId),
      eq(productionEditorVersions.projectId, productionEditorProjects.id)))
    .where(eq(printProfileVersions.id, versionId)).for("share", { of: [printProfiles, productionEditorProjects] });
  if (!source) throw new NotFoundException("生产确认引用的工艺底稿不存在");
  await assertCatalogEditorSource(tx, context, source.project, { operation: "read" });
  const { project, profile, version } = source;
  if (profile.archivedAt || project.status !== "active" || project.archivedAt || !project.encryptedDataKey ||
    project.expiresAt && project.expiresAt <= new Date() || project.sourceReportLineId || project.sourceReportVersionId ||
    project.sourceWorkItemId || project.sourceWorkRevisionId || project.sourceSalesRecipeId || project.sourceSalesSkuId ||
    project.currentVersionId !== version.sourceVersionId || project.reviewedVersionId !== version.sourceVersionId)
    throw new ConflictException("生产资料须引用当前可用且已审核的通用工艺底稿 不能使用订单或销售私有素材");
  return ProductionProductTypeSchema.parse(version.productType);
}

/** Catalog delegates rule provenance to its original owner; neither module writes the other's tables. */
export async function assertSpecificationProductionSources(
  tx: TenantTransaction,
  context: TenantContext,
  input: { spuId: string; processProfileVersionId: string | null; facts: SpecificationFacts; previousFacts?: SpecificationFacts },
) {
  const references = input.facts.productionRuleReferences ?? [];
  const productionConfirmed = input.facts.productionConfirmed === true;
  if (!productionConfirmed && !references.length) return;
  let productType: string | null = null;
  if (productionConfirmed) {
    if (!input.processProfileVersionId) throw new ConflictException("生产资料确认前须绑定已审核通用工艺底稿");
    productType = await assertProductionProfileAvailable(tx, context, input.processProfileVersionId);
  } else if (input.processProfileVersionId) {
    const [profile] = await tx.select({ productType: printProfileVersions.productType }).from(printProfileVersions)
      .where(eq(printProfileVersions.id, input.processProfileVersionId));
    productType = profile?.productType ?? null;
  }
  await assertSpecificationProductionRuleReferences(tx, context, references, {
    spuId: input.spuId, productType, requireActive: productionConfirmed,
    retainedReferences: input.previousFacts?.productionRuleReferences,
  });
}
