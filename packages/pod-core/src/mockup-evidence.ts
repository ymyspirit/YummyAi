import type { TenantContext } from "@yummyai/contracts";
import { creativeExecutions, creativeExecutionChecksum, mockupBatchItems, mockupBatches, mockupTemplateSlots, type mockupBatchOutputs, type TenantTransaction } from "@yummyai/database";
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
  if (!execution || execution.phase !== "completed" || !execution.completionEvidence || !execution.completionChecksum) throw stop();
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
