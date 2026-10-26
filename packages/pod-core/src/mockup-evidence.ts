import type { TenantContext } from "@yummyai/contracts";
import { assetFiles, creativeExecutions, creativeExecutionChecksum, creativeOwnerResponseAdoptions, mockupBatchItems, mockupBatches, mockupTemplateSlots, type mockupBatchOutputs, type TenantTransaction } from "@yummyai/database";
import { CreativeOwnerResponseAdoptionReceiptSchema } from "@yummyai/contracts/harness/creative-owner-response-adoption";
import { requireMockupAsset } from "@yummyai/catalog-core";
import { and, eq } from "drizzle-orm";
import { readCreativeExecutionSource, type CreativeOperation } from "./creative-execution-input.js";
import { creativeOriginalFingerprint } from "./creative-execution-stage.js";
import { PodOwnerError } from "./errors.js";

/** Legacy is explicit. A present original must prove the exact input and adopted files. */
export async function requireMockupCompletionEvidence(tx: TenantTransaction, authority: TenantContext,
  operation: CreativeOperation, assets: Array<{ id: string; version: number; checksumSha256: string }>, allowLegacy = false) {
  const owner = operation.kind === "template_compile" ? creativeExecutions.inspectionId : creativeExecutions.mockupItemId;
  const [execution] = await tx.select().from(creativeExecutions).where(and(eq(creativeExecutions.kind, operation.kind),
    eq(owner, operation.ownerId), eq(creativeExecutions.stepKey, operation.stepKey))).for("share");
  if (!execution && allowLegacy && operation.kind === "template_compile") return "legacy_compilation" as const;
  const stop = () => new PodOwnerError("MOCKUP_ORIGINAL_COMPLETION_REQUIRED", 409, "缺少当前原执行的完整交接证据 请驳回旧结果后重新渲染");
  if (!execution) throw stop();
  if (["failed", "uncertain"].includes(execution.phase)) {
    const [adoption] = await tx.select().from(creativeOwnerResponseAdoptions).where(and(
      eq(creativeOwnerResponseAdoptions.executionId, execution.id), eq(creativeOwnerResponseAdoptions.status, "committed")));
    const parsed = CreativeOwnerResponseAdoptionReceiptSchema.safeParse(adoption?.receipt);
    const checksum = (value: unknown) => creativeExecutionChecksum(JSON.parse(JSON.stringify(value)));
    if (!adoption || !parsed.success || !adoption.ownerReceipt || !adoption.artifactIntents || !adoption.planPin
      || execution.completionEvidence || execution.completionChecksum || adoption.requestedBy !== execution.requestedBy
      || adoption.sourcePin.executionChecksum !== checksum({ ...execution, updatedAt: null, responsePurgedAt: null }) || adoption.expectedBasis !== checksum(adoption.sourcePin)
      || adoption.requestChecksum !== checksum(adoption.request)) throw stop();
    const receipt = parsed.data, { checksum: ownerChecksum, ...owner } = adoption.ownerReceipt;
    if (ownerChecksum !== checksum(owner) || ownerChecksum !== receipt.ownerReceiptChecksum || receipt.id !== adoption.id
      || receipt.executionId !== execution.id || receipt.kind !== operation.kind || receipt.ownerId !== operation.ownerId
      || receipt.stepKey !== operation.stepKey || receipt.originalPhase !== execution.phase
      || receipt.inputFingerprint !== execution.inputFingerprint || receipt.responseChecksum !== execution.responseChecksum
      || receipt.encryptedChecksum !== execution.encryptedChecksum || receipt.basis !== adoption.expectedBasis
      || owner.basisChecksum !== adoption.planPin.checksum || receipt.artifacts.length !== adoption.artifactIntents.length) throw stop();
    const source = await readCreativeExecutionSource(tx, authority, operation);
    if (creativeOriginalFingerprint(operation, source, execution) !== execution.inputFingerprint) throw stop();
    for (const artifact of receipt.artifacts) {
      const intent = adoption.artifactIntents.find(value => value.role === artifact.role);
      const [file] = await tx.select().from(assetFiles).where(eq(assetFiles.id, artifact.assetId)).for("share");
      if (!intent || intent.assetId !== artifact.assetId || intent.checksumSha256 !== artifact.checksumSha256
        || !file || file.deletedAt || file.version !== artifact.version || file.checksumSha256 !== artifact.checksumSha256
        || file.objectKey !== intent.objectKey || file.mediaType !== artifact.mediaType || file.byteSize !== artifact.byteSize
        || checksum(file.rightsMetadata.creativeResponseAdoption) !== checksum({ adoptionId: adoption.id, executionId: execution.id,
          ownerKind: operation.kind, ownerId: operation.ownerId, basisChecksum: adoption.planPin.checksum, role: artifact.role })) throw stop();
    }
    if (assets.some(asset => !receipt.artifacts.some(pin => pin.assetId === asset.id && pin.version === asset.version && pin.checksumSha256 === asset.checksumSha256))
      || operation.kind === "mockup_render" && (assets.length !== 1 || receipt.artifacts.length !== 1)) throw stop();
    return "adopted_original_response" as const;
  }
  if (execution.phase !== "completed" || !execution.completionEvidence || !execution.completionChecksum) throw stop();
  const complete = execution.completionEvidence;
  if (complete.executionId !== execution.id || complete.inputFingerprint !== execution.inputFingerprint
    || creativeExecutionChecksum(complete) !== execution.completionChecksum) throw stop();
  const source = await readCreativeExecutionSource(tx, authority, operation);
  if (creativeOriginalFingerprint(operation, source, execution) !== execution.inputFingerprint) throw stop();
  if (assets.some(asset => !complete.artifacts.some(pin => pin.assetId === asset.id && pin.version === asset.version && pin.checksumSha256 === asset.checksumSha256))) throw stop();
  if (operation.kind === "mockup_render" && (assets.length !== 1 || complete.artifacts.length !== 1)) throw stop();
  return "original_execution" as const;
}

/** Validate the exact adopted result before any rights approval or Listing use. */
export async function requireMockupOutputEvidence(tx: TenantTransaction, authority: TenantContext,
  output: typeof mockupBatchOutputs.$inferSelect, checkedAt: number, write = false) {
  if (!output.assetId || !output.assetVersion || !output.checksumSha256) throw new PodOwnerError("MOCKUP_OUTPUT_PIN_MISSING", 409, "套图缺少实际产物版本");
  const asset = await requireMockupAsset(tx, authority, output.assetId,
    { version: output.assetVersion, checksumSha256: output.checksumSha256 }, checkedAt, true, write);
  const [source] = await tx.select({ item: mockupBatchItems, batch: mockupBatches, slot: mockupTemplateSlots }).from(mockupBatchItems)
    .innerJoin(mockupBatches, eq(mockupBatches.id, mockupBatchItems.batchId))
    .innerJoin(mockupTemplateSlots, and(eq(mockupTemplateSlots.id, output.templateSlotId), eq(mockupTemplateSlots.templatePackVersionId, mockupBatches.templatePackVersionId)))
    .where(eq(mockupBatchItems.id, output.itemId));
  const metadata = asset.rightsMetadata;
  if (!source || !asset.mediaType.startsWith("image/") || metadata.mockupOutputId !== output.id
    || metadata.mockupBatchItemId !== output.itemId || metadata.designVersionId !== source.item.designVersionId
    || metadata.templatePackVersionId !== source.batch.templatePackVersionId || metadata.templateInspectionId !== source.slot.inspectionId
    || (metadata.derivative as { kind?: string } | undefined)?.kind !== "controlled_mockup_render")
    throw new PodOwnerError("MOCKUP_OUTPUT_PROVENANCE_CHANGED", 409, "套图实际产物与原任务来源不匹配");
  await requireMockupCompletionEvidence(tx, authority, { kind: "mockup_render", ownerId: output.itemId,
    stepKey: output.attempt === 1 ? `slot:${output.templateSlotId}` : `slot:${output.templateSlotId}:attempt:${output.attempt}` }, [asset]);
  return asset;
}
