import { Permission, requireAssetAuthority } from "@yummyai/authz";
import { assertCatalogSalesPlanAccess, currentCreativeWorkspaceAuthority, requireBatchAccess, requireBatchInputs,
  requireCreativeVersionAccess, requirePrintSpecAccess, requireReferenceAuthority, requireMockupInspectionAccess,
  requireMockupInspectionSources, requireMockupBatchAccess, requireMockupPackAccess, requireMockupPackSources,
  requireMockupDesignSource } from "@yummyai/catalog-core";
import type { TenantContext } from "@yummyai/contracts";
import { assetFiles, creativeExecutions, currentCreativeExecutionAuthority, creativeDesignCandidates,
  creativeDesignVersionAssets, creativeStudioGenerations,
  mockupBatchItems, mockupBatchOutputs,
  creativeDesignBatches, modelProviderConfigs, modelRoutes, assertVisualDeliveryCurrent, visualDeliveryArtwork, visualDeliveryModelFingerprint,
  type TenantTransaction } from "@yummyai/database";
import { assertCreativeMethod, creativeHarness } from "./creative-harness.js";
import { creativeOriginalFingerprint, creativeOwnerCondition } from "./creative-execution-stage.js";
import { creativeMockupStep, readCreativeExecutionSource, type CreativeOperation } from "./creative-execution-input.js";
import { PodOwnerError } from "./errors.js";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { requireMockupCompletionEvidence } from "./mockup-evidence.js";

export type CreativeWorkerIdentity = Pick<TenantContext, "tenantId" | "userId">;
const changed = () => new PodOwnerError("CREATIVE_INPUT_CHANGED", 409, "原创作输入、业务状态或当前权利已变化");
const legacy = () => new PodOwnerError("CREATIVE_LEGACY_AUTHORITY_MISSING", 409, "历史创作任务缺少原执行权限与方法记录 请核对后创建新操作");
const queuedDeliveryFailed = (execution: typeof creativeExecutions.$inferSelect, code: string | null) => code === "QUEUE_UNAVAILABLE"
  && execution.phase === "pending" && !execution.submittedAt && !execution.receipt && !execution.responseObjectKey;

/** Owning transactions use the same resource policies as current API producers. */
export async function admitCreativeExecution(tx: TenantTransaction, identity: CreativeWorkerIdentity, operation: CreativeOperation) {
  const [execution] = await tx.select().from(creativeExecutions).where(creativeOwnerCondition(operation)).for("share");
  if (!execution) throw legacy();
  const bundle = creativeHarness(operation.kind, execution.effect);
  const authority = await currentCreativeExecutionAuthority(tx, identity, execution, bundle.requiredPermissions);
  await assertCreativeMethod(tx, authority, execution);
  const [clock] = await tx.execute<{ now: string }>(sql`select extract(epoch from clock_timestamp())*1000 as now`);
  const checkedAt = Number(clock?.now);
  if (!Number.isFinite(checkedAt)) throw changed();
  const source = await readCreativeExecutionSource(tx, authority, operation);
  if (creativeOriginalFingerprint(operation, source, execution) !== execution.inputFingerprint) throw changed();

  if (source.kind === "creative_candidate") {
    const [candidate] = await tx.select().from(creativeDesignCandidates).where(eq(creativeDesignCandidates.id, operation.ownerId)).for("share");
    if (!candidate || (!["queued", "running"].includes(candidate.status) && !queuedDeliveryFailed(execution, candidate.errorCode)) || candidate.assetId) throw changed();
    const batch = await requireBatchAccess(tx, authority, source.batchId, [Permission.DesignRead, Permission.DesignWrite], { mutation: true });
    await requireBatchInputs(tx, authority, batch, checkedAt);
  } else if (source.kind === "creative_adaptation") {
    const { version, batch } = await requireCreativeVersionAccess(tx, authority, operation.ownerId, [Permission.DesignRead, Permission.DesignWrite], { mutation: true });
    if (version.status !== "adapting") throw changed();
    await requireBatchInputs(tx, authority, batch, checkedAt);
    const spec = await requirePrintSpecAccess(tx, authority, source.spec.id, [Permission.DesignRead]);
    if (spec.status !== "approved") throw changed();
    const [master] = await tx.select({ link: creativeDesignVersionAssets, file: assetFiles, candidate: creativeDesignCandidates })
      .from(creativeDesignVersionAssets).innerJoin(assetFiles, eq(assetFiles.id, creativeDesignVersionAssets.assetId))
      .innerJoin(creativeDesignCandidates, eq(creativeDesignCandidates.id, version.sourceCandidateId))
      .where(and(eq(creativeDesignVersionAssets.creativeDesignVersionId, version.id), eq(creativeDesignVersionAssets.role, "master")))
      .for("share", { of: [assetFiles, creativeDesignCandidates] });
    if (!master || master.file.version !== master.link.assetVersion || master.candidate.assetId !== master.file.id || master.candidate.assetVersion !== master.file.version || master.candidate.checksumSha256 !== master.file.checksumSha256) throw changed();
    requireAvailableAsset(authority, master.file, checkedAt, true);
    if (master.file.rightsStatus === "unverified" && (master.file.rightsMetadata.source as { kind?: string } | undefined)?.kind !== "ai_generated") throw changed();
  } else if (source.kind === "template_compile") {
    const inspection = await requireMockupInspectionAccess(tx, authority, operation.ownerId, [Permission.DesignRead, Permission.DesignWrite]);
    if (!["queued", "running"].includes(inspection.status) && !queuedDeliveryFailed(execution, inspection.errorCode)) throw changed();
    await requireMockupInspectionSources(tx, authority, inspection, checkedAt);
  } else if (source.kind === "mockup_render") {
    const batch = await requireMockupBatchAccess(tx, authority, source.batchId, [Permission.DesignRead, Permission.DesignWrite]);
    const [item] = await tx.select().from(mockupBatchItems).where(and(eq(mockupBatchItems.id, operation.ownerId), eq(mockupBatchItems.batchId, batch.id))).for("share");
    const pack = await requireMockupPackAccess(tx, authority, batch.templatePackVersionId, [Permission.DesignRead]);
    if (!item || [batch.status, item.status].includes("cancelled") || pack.status !== "approved"
      || pack.platform !== batch.platform || pack.locale !== batch.locale) throw changed();
    const design = await requireMockupDesignSource(tx, authority, item.designVersionId, item.skuId, checkedAt);
    const templates = await requireMockupPackSources(tx, authority, pack, checkedAt);
    if (templates.slots.some(slot => !slot.acceptedPrintSpecVersionIds.includes(design.printSpecVersionId))) throw changed();
    for (const inspection of templates.inspections) {
      const { assets } = await requireMockupInspectionSources(tx, authority, inspection, checkedAt, true);
      await requireMockupCompletionEvidence(tx, authority, { kind: "template_compile", ownerId: inspection.id, stepKey: "compile" }, assets, true);
    }
    const [output] = await tx.select().from(mockupBatchOutputs).where(eq(mockupBatchOutputs.id, source.output.id)).for("share");
    if (!output || (!["queued", "running"].includes(output.status) && !queuedDeliveryFailed(execution, output.errorCode))) throw changed();
    const [latest] = await tx.select({ id: mockupBatchOutputs.id }).from(mockupBatchOutputs).where(and(
      eq(mockupBatchOutputs.itemId, item.id), eq(mockupBatchOutputs.templateSlotId, creativeMockupStep(operation.stepKey).slotId)))
      .orderBy(desc(mockupBatchOutputs.attempt)).limit(1);
    if (latest?.id !== output.id) throw changed();
  } else {
    await currentCreativeWorkspaceAuthority(tx, authority, source.scope, [Permission.DesignWrite, Permission.AssetWrite]);
    const [generation] = await tx.select().from(creativeStudioGenerations).where(eq(creativeStudioGenerations.id, operation.ownerId)).for("share");
    if (!generation || generation.ownerId !== identity.userId || !["queued", "running"].includes(generation.status)) throw changed();
    if (!generation.modelSnapshot.routeId || !generation.modelSnapshot.providerFingerprint) throw legacy();
    if (generation.input.modelId !== generation.modelSnapshot.routeId) throw changed();
    const [provider] = await tx.select().from(modelProviderConfigs).where(eq(modelProviderConfigs.id, generation.modelSnapshot.providerConfigId)).for("share");
    const [route] = await tx.select().from(modelRoutes).where(eq(modelRoutes.id, generation.modelSnapshot.routeId)).for("share");
    if (!provider || provider.status !== "enabled" || !["openai", "openai-compatible"].includes(provider.provider)
      || !route || route.status !== "enabled" || route.taskType !== `studio_${generation.modelSnapshot.capability}` || route.targets.length !== 1
      || route.targets[0]!.providerConfigId !== provider.id || route.targets[0]!.providerModel !== generation.modelSnapshot.model
      || visualDeliveryModelFingerprint(provider, route.targets[0]!) !== generation.modelSnapshot.providerFingerprint) throw changed();
    if (generation.modelSnapshot.visualCeilingUsd !== undefined) {
      const [project] = await tx.select().from(creativeDesignBatches).where(eq(creativeDesignBatches.id, generation.scope)).for("share");
      const pin = project?.canvasWorkflow?.visualDelivery;
      if (!pin || pin.slotKey !== generation.input.visualSlotKey || pin.callCeilingUsd !== generation.modelSnapshot.visualCeilingUsd
        || pin.providerFingerprint !== generation.modelSnapshot.providerFingerprint) throw changed();
      await assertCatalogSalesPlanAccess(tx, authority, pin.salesPlanId, [Permission.ProductRead]);
      await assertVisualDeliveryCurrent(tx, pin);
      if (pin.slotKey !== "artwork") {
        const original = await visualDeliveryArtwork(tx, pin, generation.input.visualArtworkVersionId ?? "");
        if (!generation.references.some(reference => reference.assetId === original)) throw changed();
      }
    }
    const ids = source.references.map(ref => ref.assetId), refs = ids.length ? await tx.select().from(assetFiles).where(inArray(assetFiles.id, ids)).for("share") : [];
    if (refs.length !== new Set(ids).size) throw changed();
    for (const ref of source.references) {
      const file = refs.find(asset => asset.id === ref.assetId)!;
      if (file.version !== ref.version || file.checksumSha256 !== ref.checksum) throw changed();
      requireAvailableAsset(authority, file, checkedAt);
    }
  }
  return { execution, authority, source, operation, checkedAt };
}

function requireAvailableAsset(authority: TenantContext, file: typeof assetFiles.$inferSelect, checkedAt: number, allowDraft = false) {
  requireAssetAuthority(authority, Permission.AssetRead, file);
  requireReferenceAuthority(authority, [file], checkedAt);
  const kind = (file.rightsMetadata.source as { kind?: string } | undefined)?.kind;
  if (file.deletedAt || file.assetDomain !== "authorized" || (file.rightsStatus !== "approved" && !(allowDraft && file.rightsStatus === "unverified")) || ["competitor", "customer_provided"].includes(kind ?? "")) throw changed();
}

