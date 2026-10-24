import { authorize, Permission } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import type { CreativeExecutionKind } from "@yummyai/contracts/harness";
import { assetFiles, canvasPrintSpecVersions, creativeDesignBatches, creativeDesignBatchItems, creativeDesignCandidates,
  creativeDesignVersions, creativeDesignVersionAssets, creativeStudioGenerations, mockupBatches, mockupBatchItems,
  mockupTemplatePackVersions, mockupTemplateSlots, mockupTemplateSourceInspections, mockupBatchOutputs, type TenantTransaction } from "@yummyai/database";
import { and, eq } from "drizzle-orm";
import { PodOwnerError } from "./errors.js";

export type CreativeOperation = { kind: CreativeExecutionKind; ownerId: string; stepKey: string };
const missing = () => new PodOwnerError("CREATIVE_INPUT_MISSING", 404, "原创作任务或输入不存在");
export function creativeMockupStep(stepKey: string) {
  const match = /^slot:([a-f0-9-]{36})(?::attempt:(\d{1,2}))?$/.exec(stepKey), attempt = Number(match?.[2] ?? 1);
  if (!match || attempt < 1 || attempt > 20) throw missing();
  return { slotId: match[1]!, attempt };
}

/** Read original owning rows; never copy private prompts into execution metadata. */
export async function readCreativeExecutionSource(tx: TenantTransaction, authority: TenantContext, operation: CreativeOperation) {
  authorize(authority, Permission.DesignRead);
  const { kind, ownerId, stepKey } = operation;
  if (kind === "creative_candidate") {
    const [row] = await tx.select({ candidate: creativeDesignCandidates, item: creativeDesignBatchItems, batch: creativeDesignBatches })
      .from(creativeDesignCandidates).innerJoin(creativeDesignBatchItems, eq(creativeDesignBatchItems.id, creativeDesignCandidates.itemId))
      .innerJoin(creativeDesignBatches, eq(creativeDesignBatches.id, creativeDesignBatchItems.batchId)).where(eq(creativeDesignCandidates.id, ownerId));
    if (!row || stepKey !== "generate") throw missing();
    authorize(authority, Permission.DesignRead, { ownerId: row.batch.createdBy });
    return { kind, ownerId, stepKey, batchId: row.batch.id, requestedBy: row.batch.createdBy, recipeVersionId: row.batch.recipeVersionId,
      itemId: row.item.id, name: row.item.name, prompt: row.item.prompt, negativePrompt: row.item.negativePrompt,
      referenceSnapshot: row.item.referenceSnapshot, printSpecVersionIds: row.item.printSpecVersionIds,
      focalPoint: row.item.focalPoint, ordinal: row.candidate.ordinal, parameterSnapshot: row.candidate.parameterSnapshot,
      promptTemplateVersion: row.candidate.promptTemplateVersion, inputChecksum: row.candidate.inputChecksum };
  }
  if (kind === "creative_adaptation") {
    const [version] = await tx.select().from(creativeDesignVersions).where(eq(creativeDesignVersions.id, ownerId));
    if (!version || !/^(spec|outpaint):/.test(stepKey)) throw missing();
    authorize(authority, Permission.DesignRead, { ownerId: version.createdBy });
    const [master] = await tx.select({ binding: creativeDesignVersionAssets, asset: assetFiles }).from(creativeDesignVersionAssets)
      .innerJoin(assetFiles, eq(assetFiles.id, creativeDesignVersionAssets.assetId)).where(and(eq(creativeDesignVersionAssets.creativeDesignVersionId, ownerId), eq(creativeDesignVersionAssets.role, "master")));
    const [item] = await tx.select({ row: creativeDesignBatchItems }).from(creativeDesignCandidates)
      .innerJoin(creativeDesignBatchItems, eq(creativeDesignBatchItems.id, creativeDesignCandidates.itemId)).where(eq(creativeDesignCandidates.id, version.sourceCandidateId));
    const specId = stepKey.slice(stepKey.indexOf(":") + 1), [spec] = await tx.select().from(canvasPrintSpecVersions).where(eq(canvasPrintSpecVersions.id, specId));
    if (!master || !item || !spec || !item.row.printSpecVersionIds.includes(specId)) throw missing();
    return { kind, ownerId, stepKey, requestedBy: version.createdBy, sourceCandidateId: version.sourceCandidateId,
      batchId: item.row.batchId, focalPoint: item.row.focalPoint, prompt: item.row.prompt, printSpecVersionIds: item.row.printSpecVersionIds,
      master: { assetId: master.asset.id, version: master.binding.assetVersion, checksumSha256: master.asset.checksumSha256 },
      spec: { id: spec.id, version: spec.versionNumber, aspectWidth: spec.aspectWidth, aspectHeight: spec.aspectHeight,
        targetDpi: spec.targetDpi, bleedMm: spec.bleedMm, safeZoneMm: spec.safeZoneMm, wrapMode: spec.wrapMode, physicalSizes: spec.physicalSizes } };
  }
  if (kind === "template_compile") {
    const [row] = await tx.select().from(mockupTemplateSourceInspections).where(eq(mockupTemplateSourceInspections.id, ownerId));
    if (!row || stepKey !== "compile") throw missing();
    authorize(authority, Permission.DesignRead, { ownerId: row.requestedBy });
    return { kind, ownerId, stepKey, requestedBy: row.requestedBy, sourceAssetId: row.sourceAssetId, sourceAssetVersion: row.sourceAssetVersion,
      checksumSha256: row.checksumSha256, slotKey: row.slotKey, compilerVersion: row.compilerVersion };
  }
  if (kind === "mockup_render") {
    const [row] = await tx.select({ item: mockupBatchItems, batch: mockupBatches, pack: mockupTemplatePackVersions }).from(mockupBatchItems)
      .innerJoin(mockupBatches, eq(mockupBatches.id, mockupBatchItems.batchId))
      .innerJoin(mockupTemplatePackVersions, eq(mockupTemplatePackVersions.id, mockupBatches.templatePackVersionId)).where(eq(mockupBatchItems.id, ownerId));
    if (!row) throw missing();
    const step = creativeMockupStep(stepKey);
    authorize(authority, Permission.DesignRead, { ownerId: row.batch.createdBy });
    const [slot] = await tx.select().from(mockupTemplateSlots).where(and(eq(mockupTemplateSlots.id, step.slotId), eq(mockupTemplateSlots.templatePackVersionId, row.pack.id)));
    const [output] = await tx.select().from(mockupBatchOutputs).where(and(eq(mockupBatchOutputs.itemId, ownerId), eq(mockupBatchOutputs.templateSlotId, step.slotId), eq(mockupBatchOutputs.attempt, step.attempt)));
    if (!slot || !output) throw missing();
    return { kind, ownerId, stepKey, requestedBy: row.batch.createdBy, batchId: row.batch.id,
      templatePackVersionId: row.pack.id, platform: row.batch.platform, locale: row.batch.locale,
      item: omitState(row.item), slot: omitState(slot), output: { id: output.id, attempt: output.attempt, slotKey: output.slotKey } };
  }
  const [row] = await tx.select().from(creativeStudioGenerations).where(eq(creativeStudioGenerations.id, ownerId));
  if (!row || stepKey !== "generate") throw missing();
  authorize(authority, Permission.DesignRead, { ownerId: row.ownerId });
  return { kind, ownerId, stepKey, requestedBy: row.ownerId, scope: row.scope, requestId: row.requestId,
    input: row.input, modelSnapshot: row.modelSnapshot, references: row.references };
}

function omitState(row: object) {
  const mutable = new Set(["status", "reviewedBy", "reviewedAt", "rejectionReason", "completedAt", "updatedAt", "createdAt", "errorCode", "errorMessage"]);
  return Object.fromEntries(Object.entries(row).filter(([key]) => !mutable.has(key)));
}
