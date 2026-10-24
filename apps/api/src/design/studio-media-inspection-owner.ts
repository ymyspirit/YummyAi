import { isDeepStrictEqual } from "node:util";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { CANVAS_BRIDGE, SubmitCanvasResultInputSchema, type CanvasResultReceipt } from "@yummyai/contracts/pod/canvas-bridge";
import {
  StudioOriginalPinSchema, StudioPinnedResultRequestSchema, StudioResultIntentSchema,
  studioResultIntentKey, type StudioOriginalPin, type StudioPinnedResultRequest, type StudioResultIntent,
} from "@yummyai/contracts/pod/studio-original";
import type { assetFiles, creativeStudioEntries } from "@yummyai/database";

export type StudioAssetRow = typeof assetFiles.$inferSelect;
export type StudioEntryRow = typeof creativeStudioEntries.$inferSelect;
export function storedStudioValue(value: unknown): unknown {
  return value && typeof value === "object" && "studioDocument" in value && value.studioDocument === true && "data" in value ? value.data : value;
}
export function studioOriginalPin(entry: StudioEntryRow, asset: StudioAssetRow): StudioOriginalPin {
  return StudioOriginalPinSchema.parse({ entryId: entry.id, revision: entry.revision, namespace: entry.namespace,
    assetId: asset.id, assetVersion: asset.version, checksumSha256: asset.checksumSha256, mediaType: asset.mediaType,
    byteSize: asset.byteSize, sourceKind: (asset.rightsMetadata.source as { kind?: string } | undefined)?.kind });
}
export function sameStudioAsset(asset: StudioAssetRow, other: StudioAssetRow): boolean {
  return asset.id === other.id && asset.version === other.version && asset.objectKey === other.objectKey &&
    asset.checksumSha256 === other.checksumSha256 && asset.mediaType === other.mediaType && asset.byteSize === other.byteSize &&
    (asset.rightsMetadata.source as { kind?: string } | undefined)?.kind === (other.rightsMetadata.source as { kind?: string } | undefined)?.kind;
}
export function assertSameStudioAsset(asset: StudioAssetRow, other: StudioAssetRow) {
  if (!sameStudioAsset(asset, other)) throw new ConflictException("原素材已变化 请重新核对");
}
export function assertStudioAssetPin(asset: StudioAssetRow, pin: StudioOriginalPin) {
  if (asset.id !== pin.assetId || asset.version !== pin.assetVersion || asset.checksumSha256 !== pin.checksumSha256 ||
    asset.mediaType !== pin.mediaType || asset.byteSize !== pin.byteSize ||
    (asset.rightsMetadata.source as { kind?: string } | undefined)?.kind !== pin.sourceKind)
    throw new ConflictException("原素材版本或来源已变化 请重新核对");
}
export function normalizeStudioPinnedRequest(input: unknown): StudioPinnedResultRequest {
  const parsed = StudioPinnedResultRequestSchema.safeParse(input && typeof input === "object" ? { ...input, operation: "result.submit.pinned" } : input);
  if (!parsed.success) throw new BadRequestException("固定方案请求格式无效");
  return parsed.data;
}
export function studioCanvasInput(request: StudioPinnedResultRequest, contentBase64: string) {
  return SubmitCanvasResultInputSchema.parse({ submissionId: request.submissionId, protocolVersion: 1,
    pluginVersion: CANVAS_BRIDGE.pluginVersion, upstreamVersion: CANVAS_BRIDGE.upstreamVersion,
    sourceNodeId: `studio:${request.source.entryId}:${request.source.revision}`, title: request.title, contentBase64,
    rightsAttested: true, sourceKind: request.source.sourceKind, sourceReference: request.sourceReference });
}
export function parseStudioIntent(value: unknown, scope: string, key: string): StudioResultIntent {
  const parsed = StudioResultIntentSchema.safeParse(value);
  if (!parsed.success || parsed.data.request.scope !== scope || studioResultIntentKey(parsed.data.request.source) !== key)
    throw new BadRequestException("送审意图与原项目或素材版本不匹配");
  return parsed.data;
}
export function sameStudioRequest(a: StudioPinnedResultRequest, b: StudioPinnedResultRequest) { return isDeepStrictEqual(a, b); }
export function sameStudioReceipt(a: CanvasResultReceipt, b: CanvasResultReceipt) {
  return a.batchId === b.batchId && a.candidateId === b.candidateId && a.versionId === b.versionId && a.assetId === b.assetId;
}
/** CAS protects storage revision; these rules protect the independent original
 * request identity when a response was lost. A receipt is verified by its owner. */
export function assertStudioIntentTransition(previous: StudioResultIntent | undefined, next: StudioResultIntent | undefined) {
  if (!previous) {
    if (!next || next.status !== "prepared") throw new ConflictException("新送审须先固定原请求");
    return;
  }
  if (!next) {
    if (previous.status !== "confirmed") throw new ConflictException("送审结果尚未确认 不能删除原请求");
    return;
  }
  const same = sameStudioRequest(previous.request, next.request);
  if (previous.status !== "confirmed") {
    if (!same) throw new ConflictException("原送审尚未核对 不能更换提交编号或正文");
    if (previous.status === "unknown" && next.status === "prepared") throw new ConflictException("原结果仍待核对 不能重置送审状态");
    return;
  }
  if (same) {
    if (next.status !== "confirmed" || !sameStudioReceipt(previous.receipt, next.receipt))
      throw new ConflictException("已确认回执不能重置或替换");
    return;
  }
  if (next.status !== "prepared" || next.request.submissionId === previous.request.submissionId)
    throw new ConflictException("再次送审须明确固定新的提交编号");
}
