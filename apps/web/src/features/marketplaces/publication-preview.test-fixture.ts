import type { PublicationPreviewContext } from "./publication-preview-client";
import { previewTargetChecksum } from "./publication-preview-client";
import type { PublicationPreviewRequestView, PublicationPreviewTarget, PublicationPreviewWorkspace } from "@yummyai/contracts/marketplace/publication-preview";

export const previewId = (n: number) => `0198fbef-4a10-7000-8000-${String(n).padStart(12, "0")}`;
export async function publicationPreviewFixture() {
  const context: PublicationPreviewContext = { actorId: previewId(1), tenantId: previewId(2), listingId: previewId(3), listingVersionId: previewId(4), authority: "a".repeat(64) };
  const target: PublicationPreviewTarget = { accountId: previewId(5), listingId: context.listingId, listingVersionId: context.listingVersionId, marketplaceId: "ATVPDKIKX0DER", variantSkuId: previewId(6),
    capabilitySnapshotId: previewId(7), payloadChecksum: "b".repeat(64), assetManifestChecksum: "c".repeat(64), nodeId: previewId(8), certificateGeneration: 2, authorizationGeneration: previewId(9), bindingRevision: 3 };
  const requestChecksum = await previewTargetChecksum(target), input = { ...target, requestKey: previewId(10), requestChecksum };
  const value: PublicationPreviewRequestView = { protocol: "erp-publication-preview-v1", admission: "node_preview", intent: { requestKey: input.requestKey, requestChecksum, target },
    request: { id: previewId(11), accountId: target.accountId, capabilitySnapshotId: target.capabilitySnapshotId, listingId: target.listingId, listingVersionId: target.listingVersionId,
      platform: "amazon", marketplaceId: target.marketplaceId, action: "amazon_validation_preview", batchId: null, parentRequestId: null, sourceExternalListingId: null,
      idempotencyKey: "d".repeat(64), payloadChecksum: target.payloadChecksum, targetLabel: "Synthetic preview", assetCount: 1, scheduledFor: null, createdBy: context.actorId, createdAt: "2026-10-22T00:00:00.000Z",
      current: { id: previewId(12), sequence: 1, status: "queued", code: null, message: null, issues: [], externalListingId: null, externalSubmissionId: null, externalMediaIds: [], externalState: null, retryable: false, occurredAt: "2026-10-22T00:00:00.000Z" } },
    execution: { id: previewId(13), nodeId: target.nodeId, certificateGeneration: target.certificateGeneration, authorizationGeneration: target.authorizationGeneration, bindingRevision: target.bindingRevision,
      state: "waiting_node", phase: "queued", errorCode: null, createdAt: "2026-10-22T00:00:00.000Z", updatedAt: "2026-10-22T00:00:00.000Z", expiresAt: "2026-10-23T00:00:00.000Z", completedAt: null },
    access: { canCancel: true, canContinue: false } };
  const workspace: PublicationPreviewWorkspace = { protocol: value.protocol, context: { actorId: context.actorId, tenantId: context.tenantId, authority: context.authority },
    listing: { id: target.listingId, versionId: target.listingVersionId, currentVersionId: target.listingVersionId, version: 2, status: "approved", title: "Synthetic immutable preview", content: { variants: [{ skuId: target.variantSkuId, skuCode: "SYNTHETIC" }] } },
    access: { canRead: true, canPrepare: true }, sources: [{ accountId: target.accountId, accountName: "Synthetic account", marketplaceId: target.marketplaceId, target, canPrepare: true, reason: "node_offline" }], recent: [value], observedAt: "2026-10-22T00:00:00.000Z" };
  return { context, target, input, value, workspace };
}
