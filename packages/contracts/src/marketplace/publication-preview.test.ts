import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createEntityId } from "@yummyai/contracts/common/ids";
import {
  CreatePublicationPreviewInputSchema, PUBLICATION_PREVIEW_PROTOCOL, PublicationPreviewLookupSchema,
  PublicationPreviewNodeInputSchema, PublicationPreviewReceiptSchema, PublicationPreviewRequestViewSchema,
  PublicationPreviewTargetSchema, publicationPreviewPayloadText, publicationPreviewRequestText,
  STORE_NODE_PUBLICATION_OPERATION, StoreNodePublicationResultSchema,
} from "./publication-preview.js";
import { StoreNodeExecutionClaimInputSchema, StoreNodePublicationLeaseSchema, STORE_NODE_EXECUTION_OPERATION,
  STORE_NODE_EXECUTION_PROTOCOL } from "./store-node-execution.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const target = () => ({ accountId: createEntityId(), listingId: createEntityId(), listingVersionId: createEntityId(),
  marketplaceId: "ATVPDKIKX0DER", variantSkuId: "SKU-Case-Sensitive", capabilitySnapshotId: createEntityId(),
  payloadChecksum: "a".repeat(64), assetManifestChecksum: "b".repeat(64), nodeId: createEntityId(),
  certificateGeneration: 2, authorizationGeneration: createEntityId(), bindingRevision: 3 });
const instant = "2026-10-22T12:00:00.000Z";
const payload = { platform: "amazon" as const, marketplaceId: "ATVPDKIKX0DER", locale: "en-US", productType: "HOME",
  sku: "SYNTHETIC-PREVIEW-SKU", attributes: { item_name: "Synthetic original approved Listing" } };

function view() {
  const selected = target(), id = createEntityId();
  return { protocol: PUBLICATION_PREVIEW_PROTOCOL, admission: "node_preview" as const,
    intent: { requestKey: createEntityId(), requestChecksum: digest(publicationPreviewRequestText(selected)), target: selected },
    execution: { id: createEntityId(), nodeId: selected.nodeId, certificateGeneration: selected.certificateGeneration,
      authorizationGeneration: selected.authorizationGeneration, bindingRevision: selected.bindingRevision,
      state: "waiting_node" as const, phase: "queued" as const, errorCode: null, createdAt: instant,
      updatedAt: instant, expiresAt: "2026-10-22T13:00:00.000Z", completedAt: null },
    access: { canCancel: true, canContinue: false },
    request: { id, accountId: selected.accountId, capabilitySnapshotId: selected.capabilitySnapshotId,
      listingId: selected.listingId, listingVersionId: selected.listingVersionId, platform: "amazon" as const,
      marketplaceId: selected.marketplaceId, action: "amazon_validation_preview" as const, batchId: null,
      parentRequestId: null, sourceExternalListingId: null, idempotencyKey: "c".repeat(64),
      payloadChecksum: selected.payloadChecksum, targetLabel: payload.sku, assetCount: 1, scheduledFor: null,
      createdBy: createEntityId(), createdAt: instant, current: { id: createEntityId(), sequence: 1, status: "queued" as const,
        code: null, message: null, issues: [], externalListingId: null, externalSubmissionId: null,
        externalMediaIds: [], externalState: null, retryable: false, occurredAt: instant } } };
}

describe("publication preview immutable protocol", () => {
  it("binds every original target and node pin while preserving business identifier case", () => {
    const original = target(), text = publicationPreviewRequestText(original);
    const changes = { accountId: createEntityId(), listingId: createEntityId(), listingVersionId: createEntityId(),
      marketplaceId: "A1F83G8C2ARO7P", variantSkuId: "sku-case-sensitive", capabilitySnapshotId: createEntityId(),
      payloadChecksum: "d".repeat(64), assetManifestChecksum: "e".repeat(64), nodeId: createEntityId(),
      certificateGeneration: 3, authorizationGeneration: createEntityId(), bindingRevision: 4 };
    for (const [key, value] of Object.entries(changes)) expect(digest(publicationPreviewRequestText({ ...original, [key]: value })), key).not.toBe(digest(text));
    const uppercaseIds = Object.fromEntries(Object.entries(original).map(([key, value]) =>
      [key, key.endsWith("Id") && key !== "marketplaceId" && key !== "variantSkuId" && typeof value === "string" ? value.toUpperCase() : value]));
    expect(publicationPreviewRequestText(PublicationPreviewTargetSchema.parse(uppercaseIds))).toBe(text);
    expect(publicationPreviewRequestText({ ...original, variantSkuId: undefined })).not.toBe(text);
  });

  it("rejects caller authority, arbitrary execution operations and recovery substitutions", () => {
    const selected = target(), input = { ...selected, requestKey: createEntityId(), requestChecksum: digest(publicationPreviewRequestText(selected)) };
    expect(CreatePublicationPreviewInputSchema.parse(input)).toEqual(input);
    for (const extra of [{ tenantId: createEntityId() }, { accessToken: "SYNTHETIC-SECRET" }, { operation: "amazon_submit" }, { url: "https://outside.invalid" }])
      expect(CreatePublicationPreviewInputSchema.safeParse({ ...input, ...extra }).success).toBe(false);
    expect(PublicationPreviewLookupSchema.safeParse({ requestKey: input.requestKey, requestChecksum: input.requestChecksum, target: selected }).success).toBe(false);
    expect(PublicationPreviewLookupSchema.parse({ requestKey: input.requestKey.toUpperCase(), requestChecksum: input.requestChecksum }).requestKey).toBe(input.requestKey);
    expect(PublicationPreviewTargetSchema.parse({ ...selected, listingId: selected.listingId.toUpperCase(), nodeId: selected.nodeId.toUpperCase() }))
      .toMatchObject({ listingId: selected.listingId, nodeId: selected.nodeId, variantSkuId: selected.variantSkuId });
    expect(CreatePublicationPreviewInputSchema.safeParse({ ...input, bindingRevision: 0 }).success).toBe(false);
    expect(CreatePublicationPreviewInputSchema.safeParse({ ...input, requestChecksum: "A".repeat(64) }).success).toBe(false);
  });

  it("keeps the original payload checksum ordering and exact marketplace boundary", () => {
    expect(publicationPreviewPayloadText({ z: [2, { b: false, a: null }], a: "original" }))
      .toBe('{"a":"original","z":[2,{"a":null,"b":false}]}');
    const input = { publicationRequestId: createEntityId(), target: target(), payload };
    expect(PublicationPreviewNodeInputSchema.parse(input).payload).toEqual(payload);
    expect(PublicationPreviewNodeInputSchema.safeParse({ ...input, payload: { ...payload, marketplaceId: "etsy" } }).success).toBe(false);
    expect(PublicationPreviewNodeInputSchema.safeParse({ ...input, payload: { ...payload, mode: "LIVE" } }).success).toBe(false);
  });

  it("requires explicit preview capability and correlates every sealed lease pin", () => {
    const original = target(), runtime = { protocol: STORE_NODE_EXECUTION_PROTOCOL, nodeId: original.nodeId,
      certificateGeneration: original.certificateGeneration, sessionId: createEntityId(), supportedAuthorizationModes: ["amazon_private"] };
    expect(StoreNodeExecutionClaimInputSchema.parse(runtime).supportedOperations).toEqual([STORE_NODE_EXECUTION_OPERATION]);
    expect(StoreNodeExecutionClaimInputSchema.parse({ ...runtime, supportedOperations: [STORE_NODE_PUBLICATION_OPERATION] }).supportedOperations).toEqual([STORE_NODE_PUBLICATION_OPERATION]);
    const wire = { protocol: STORE_NODE_EXECUTION_PROTOCOL, nodeId: original.nodeId, certificateGeneration: original.certificateGeneration,
      accountId: original.accountId, authorizationGeneration: original.authorizationGeneration, bindingRevision: original.bindingRevision,
      id: createEntityId(), requestId: createEntityId(),
      requestChecksum: "c".repeat(64), claimId: createEntityId(), sessionId: runtime.sessionId, credentialUseId: createEntityId(),
      credentialId: createEntityId(), credentialVersion: 1, expiresAt: instant, runExpiresAt: instant,
      sealedCredential: { nonce: "a".repeat(16), tag: "b".repeat(22), ciphertext: "c", wrappedKey: "d".repeat(512) },
      operation: STORE_NODE_PUBLICATION_OPERATION, input: { publicationRequestId: createEntityId(), target: original, payload } };
    expect(StoreNodePublicationLeaseSchema.safeParse(wire).success).toBe(true);
    for (const [key, value] of Object.entries({ accountId: createEntityId(), nodeId: createEntityId(), certificateGeneration: 4,
      authorizationGeneration: createEntityId(), bindingRevision: 9 }))
      expect(StoreNodePublicationLeaseSchema.safeParse({ ...wire, [key]: value }).success, key).toBe(false);
  });

  it("keeps legacy requests distinct and refuses contradictory receipt admission", () => {
    const original = view(); expect(PublicationPreviewRequestViewSchema.safeParse(original).success).toBe(true);
    expect(PublicationPreviewRequestViewSchema.safeParse({ ...original, intent: null }).success).toBe(false);
    expect(PublicationPreviewRequestViewSchema.safeParse({ ...original, admission: "legacy" }).success).toBe(false);
    const legacy = { ...original, admission: "legacy", intent: null, execution: null };
    expect(PublicationPreviewRequestViewSchema.safeParse(legacy).success).toBe(true);
    const receipt = { protocol: PUBLICATION_PREVIEW_PROTOCOL, requestKey: original.intent.requestKey,
      requestChecksum: original.intent.requestChecksum, found: true, request: original, observedAt: instant };
    expect(PublicationPreviewReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(PublicationPreviewReceiptSchema.safeParse({ ...receipt, found: false }).success).toBe(false);
    expect(PublicationPreviewReceiptSchema.safeParse({ ...receipt, request: null }).success).toBe(false);
  });

  it("accepts original validation issues without promoting preview to publication or exposing credentials", () => {
    const result = { publicationRequestId: createEntityId(), payloadChecksum: "a".repeat(64), status: "validation_failed",
      externalState: "INVALID", issues: [{ code: "SYNTHETIC_REQUIRED", message: "Original provider reports missing item_name", severity: "blocker", path: "attributes.item_name" }], submittedAt: instant };
    expect(StoreNodePublicationResultSchema.parse(result).status).toBe("validation_failed");
    for (const change of [{ status: "published" }, { credential: { refreshToken: "SYNTHETIC-SECRET" } }, { sharedSecret: "SYNTHETIC-SECRET" }, { issues: new Array(201).fill(result.issues[0]) }])
      expect(StoreNodePublicationResultSchema.safeParse({ ...result, ...change }).success).toBe(false);
  });
});
