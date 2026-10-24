import { z } from "zod";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { MarketplaceAuthorizationModeSchema, MarketplaceCapabilitySnapshotViewSchema, MarketplacePlatformSchema,
  MarketplaceRegionSchema, SyncMarketplaceCapabilitiesInputSchema } from "@yummyai/contracts/marketplace/store";
import { StoreNodeExecutionPinsSchema, StoreNodeExecutionStateSchema, StoreNodeExecutionPhaseSchema, StoreNodeExecutionErrorSchema } from "@yummyai/contracts/marketplace/store-node-execution-base";
import { PublicationPreviewNodeInputSchema, STORE_NODE_PUBLICATION_OPERATION, StoreNodePublicationResultSchema } from "@yummyai/contracts/marketplace/publication-preview";
import {PublicationSubmitNodeInputSchema,PublicationStatusNodeInputSchema,StoreNodeAmazonSubmissionResultSchema,StoreNodeAmazonStatusResultSchema,
  STORE_NODE_PUBLICATION_SUBMIT_OPERATION,STORE_NODE_PUBLICATION_STATUS_OPERATION} from "@yummyai/contracts/marketplace/publication-submit";
export { StoreNodeExecutionPinsSchema, StoreNodeExecutionStateSchema, StoreNodeExecutionPhaseSchema, StoreNodeExecutionErrorSchema } from "@yummyai/contracts/marketplace/store-node-execution-base";

export const STORE_NODE_EXECUTION_PROTOCOL = "erp-store-node-execution-v1" as const;
export const STORE_NODE_EXECUTION_OPERATION = "marketplace.capabilities.sync.v1" as const;
export const STORE_NODE_EXECUTION_RESULT_BYTES = 16 * 1024 * 1024;
export const STORE_NODE_EXECUTION_WIRE_BYTES = 24 * 1024 * 1024;
const Protocol = z.literal(STORE_NODE_EXECUTION_PROTOCOL), Digest = z.string().regex(/^[a-f0-9]{64}$/), Instant = z.iso.datetime();
export const StoreNodeExecutionOperationSchema = z.enum([STORE_NODE_EXECUTION_OPERATION, STORE_NODE_PUBLICATION_OPERATION, STORE_NODE_PUBLICATION_SUBMIT_OPERATION, STORE_NODE_PUBLICATION_STATUS_OPERATION]);
export const CreateStoreNodeExecutionInputSchema = StoreNodeExecutionPinsSchema.extend({ requestId: EntityIdSchema, requestChecksum: Digest,
  operation: z.literal(STORE_NODE_EXECUTION_OPERATION), input: SyncMarketplaceCapabilitiesInputSchema }).strict();
export type CreateStoreNodeExecutionInput = z.infer<typeof CreateStoreNodeExecutionInputSchema>;
/** Browser and server hash this exact normalized tuple; no secrets enter it. */
export function storeNodeExecutionRequestText(accountId: string, raw: CreateStoreNodeExecutionInput): string {
  const value = CreateStoreNodeExecutionInputSchema.parse(raw);
  return JSON.stringify([STORE_NODE_EXECUTION_PROTOCOL, EntityIdSchema.parse(accountId).toLowerCase(), value.requestId.toLowerCase(),
    value.operation, value.nodeId.toLowerCase(), value.certificateGeneration, value.authorizationGeneration.toLowerCase(), value.bindingRevision,
    value.input.amazonProductTypes, value.input.etsyTaxonomyNodeIds, value.input.ttlHours]);
}
export const StoreNodeExecutionSummarySchema = StoreNodeExecutionPinsSchema.extend({ id: EntityIdSchema, requestId: EntityIdSchema, requestChecksum: Digest,
  operation: z.literal(STORE_NODE_EXECUTION_OPERATION), state: StoreNodeExecutionStateSchema, phase: StoreNodeExecutionPhaseSchema,
  errorCode: StoreNodeExecutionErrorSchema.nullable(), createdAt: Instant, updatedAt: Instant, expiresAt: Instant,
  startedAt: Instant.nullable(), completedAt: Instant.nullable(), canCancel: z.boolean(), snapshotId: EntityIdSchema.nullable(), snapshotVersion: z.int().positive().nullable() }).strict();
export const StoreNodeExecutionViewSchema = StoreNodeExecutionSummarySchema.extend({ input: SyncMarketplaceCapabilitiesInputSchema,
  snapshot: MarketplaceCapabilitySnapshotViewSchema.nullable() }).strict();
export const StoreNodeExecutionReceiptInputSchema = z.object({ requestId: EntityIdSchema, requestChecksum: Digest }).strict();
export const CancelStoreNodeExecutionInputSchema = z.object({ requestChecksum: Digest }).strict();
export const StoreNodeExecutionReceiptSchema = z.object({ protocol: Protocol, accountId: EntityIdSchema, requestId: EntityIdSchema, requestChecksum: Digest,
  found: z.boolean(), execution: StoreNodeExecutionViewSchema.nullable(), observedAt: Instant }).strict()
  .refine(value => value.found === (value.execution !== null), "Receipt and original execution disagree");
export const StoreNodeExecutionWorkspaceSchema = z.object({ protocol: Protocol, accountId: EntityIdSchema, platform: MarketplacePlatformSchema,
  authorizationMode: MarketplaceAuthorizationModeSchema, accountStatus: z.string().min(1).max(40), authorizationGeneration: z.uuid(),
  context: z.object({ actorId: EntityIdSchema, tenantId: EntityIdSchema, authority: Digest }).strict(),
  binding: z.object({ revision: z.int().nonnegative(), nodeId: EntityIdSchema.nullable(), certificateGeneration: z.int().positive().nullable(),
    state: z.enum(["unbound", "active", "draining"]), online: z.boolean(), lastSeenAt: Instant.nullable() }).strict(),
  access: z.object({ canSubmit: z.boolean(), canCancel: z.boolean() }).strict(),
  configuration: z.object({ enabled: z.boolean(), operationSupported: z.boolean(), reason: z.enum(["ready", "not_configured", "not_supported", "not_bound", "draining", "credential_unavailable", "not_authorized"]) }).strict(),
  operations: z.array(z.literal(STORE_NODE_EXECUTION_OPERATION)).max(1), recent: z.array(StoreNodeExecutionSummarySchema).max(20), observedAt: Instant }).strict();
export const StoreNodeExecutionHistorySchema = z.object({ protocol: Protocol, accountId: EntityIdSchema,
  items: z.array(StoreNodeExecutionSummarySchema).max(20), nextCursor: EntityIdSchema.nullable(), hasMore: z.boolean() }).strict();
export type StoreNodeExecutionWorkspace = z.infer<typeof StoreNodeExecutionWorkspaceSchema>;
export type StoreNodeExecutionSummary = z.infer<typeof StoreNodeExecutionSummarySchema>;
export type StoreNodeExecutionView = z.infer<typeof StoreNodeExecutionViewSchema>;
export type StoreNodeExecutionReceiptInput = z.infer<typeof StoreNodeExecutionReceiptInputSchema>;
export type StoreNodeExecutionReceipt = z.infer<typeof StoreNodeExecutionReceiptSchema>;
export type StoreNodeExecutionHistory = z.infer<typeof StoreNodeExecutionHistorySchema>;
export type StoreNodeExecutionState = z.infer<typeof StoreNodeExecutionStateSchema>;
export type StoreNodeExecutionPhase = z.infer<typeof StoreNodeExecutionPhaseSchema>;

export const StoreNodeCipherSchema = z.object({ nonce: z.string().regex(/^[A-Za-z0-9_-]{16}$/), tag: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  ciphertext: z.string().min(1).max(Math.ceil(STORE_NODE_EXECUTION_RESULT_BYTES * 4 / 3)).regex(/^[A-Za-z0-9_-]+$/) }).strict();
export const StoreNodeSealedCredentialSchema = StoreNodeCipherSchema.extend({ wrappedKey: z.string().regex(/^[A-Za-z0-9_-]{512,684}$/) }).strict();
export const StoreNodeRuntimeIdentitySchema = z.object({ protocol: Protocol, nodeId: EntityIdSchema, certificateGeneration: z.int().positive(), sessionId: EntityIdSchema }).strict();
export const StoreNodeExecutionClaimInputSchema = StoreNodeRuntimeIdentitySchema.extend({ supportedAuthorizationModes: z.array(z.enum(["amazon_private", "amazon_public", "etsy_oauth"])).max(3),
  supportedOperations: z.array(StoreNodeExecutionOperationSchema).min(1).max(4).default([STORE_NODE_EXECUTION_OPERATION]) }).strict();
const StoreNodeExecutionLeaseBaseSchema = StoreNodeExecutionPinsSchema.extend({ protocol: Protocol, id: EntityIdSchema, accountId: EntityIdSchema,
  requestId: EntityIdSchema, requestChecksum: Digest, claimId: EntityIdSchema,
  sessionId: EntityIdSchema, credentialUseId: EntityIdSchema, credentialId: EntityIdSchema, credentialVersion: z.int().positive(),
  expiresAt: Instant, runExpiresAt: Instant, sealedCredential: StoreNodeSealedCredentialSchema }).strict();
export const StoreNodeCapabilityLeaseSchema = StoreNodeExecutionLeaseBaseSchema.extend({ operation: z.literal(STORE_NODE_EXECUTION_OPERATION), input: SyncMarketplaceCapabilitiesInputSchema }).strict();
export const StoreNodePublicationLeaseSchema = StoreNodeExecutionLeaseBaseSchema.extend({ operation: z.literal(STORE_NODE_PUBLICATION_OPERATION), input: PublicationPreviewNodeInputSchema }).strict()
  .refine(value => value.accountId===value.input.target.accountId && value.nodeId===value.input.target.nodeId
    && value.certificateGeneration===value.input.target.certificateGeneration && value.authorizationGeneration===value.input.target.authorizationGeneration
    && value.bindingRevision===value.input.target.bindingRevision,"Publication lease and original target disagree");
function originalTargetPins(value:{accountId:string;nodeId:string;certificateGeneration:number;authorizationGeneration:string;bindingRevision:number;
  input:{target:{accountId:string;nodeId:string;certificateGeneration:number;authorizationGeneration:string;bindingRevision:number}}}){
  return value.accountId===value.input.target.accountId&&value.nodeId===value.input.target.nodeId&&value.certificateGeneration===value.input.target.certificateGeneration
    &&value.authorizationGeneration===value.input.target.authorizationGeneration&&value.bindingRevision===value.input.target.bindingRevision;
}
export const StoreNodeAmazonSubmissionLeaseSchema=StoreNodeExecutionLeaseBaseSchema.extend({operation:z.literal(STORE_NODE_PUBLICATION_SUBMIT_OPERATION),input:PublicationSubmitNodeInputSchema}).strict().refine(originalTargetPins,"Submission lease and original target disagree");
export const StoreNodeAmazonStatusLeaseSchema=StoreNodeExecutionLeaseBaseSchema.extend({operation:z.literal(STORE_NODE_PUBLICATION_STATUS_OPERATION),input:PublicationStatusNodeInputSchema}).strict().refine(originalTargetPins,"Status lease and original target disagree");
export const StoreNodeExecutionLeaseSchema = z.discriminatedUnion("operation", [StoreNodeCapabilityLeaseSchema, StoreNodePublicationLeaseSchema,StoreNodeAmazonSubmissionLeaseSchema,StoreNodeAmazonStatusLeaseSchema]);
export const StoreNodeExecutionClaimSchema = z.object({ protocol: Protocol, state: z.enum(["empty", "lease"]), lease: StoreNodeExecutionLeaseSchema.nullable(), observedAt: Instant }).strict()
  .refine(value => (value.state === "lease") === (value.lease !== null));
export const StoreNodeExecutionCredentialSchema = z.object({ account: z.object({ authorizationMode: MarketplaceAuthorizationModeSchema,
  externalAccountId: z.string().nullable(), grantedScopes: z.array(z.string()), marketplaceIds: z.array(z.string()).min(1).max(64),
  platform: MarketplacePlatformSchema, region: MarketplaceRegionSchema }).strict(), credential: z.record(z.string().min(1).max(80), z.string().max(16384)),
  etsyAppKeySha256: Digest.nullable(), amazonAppClientIdSha256: Digest.optional() }).strict()
  .refine(value => value.account.authorizationMode !== "amazon_public" || value.account.platform === "amazon"
    && value.credential.kind === "amazon_public" && Boolean(value.credential.clientId?.trim()) && value.amazonAppClientIdSha256 !== undefined,
  "Public Amazon credentials require their original application identity");
export const StoreNodeExecutionCallSchema = StoreNodeRuntimeIdentitySchema.extend({ executionId: EntityIdSchema, claimId: EntityIdSchema, requestChecksum: Digest }).strict();
export const StoreNodeExecutionRequestClassSchema = z.enum(["amazon_lwa", "amazon_participations", "amazon_product_definition", "amazon_schema", "amazon_meta_schema",
  "amazon_listing_validation_preview", "amazon_listing_submit", "amazon_listing_status", "etsy_refresh", "etsy_shop", "etsy_sections", "etsy_return_policies", "etsy_taxonomy", "etsy_shipping_profiles", "etsy_readiness_profiles", "etsy_taxonomy_properties"]);
export const StoreNodeExecutionPermitInputSchema = StoreNodeExecutionCallSchema.extend({ stepId: EntityIdSchema, ordinal: z.int().min(1).max(128),
  requestClass: StoreNodeExecutionRequestClassSchema, requestDigest: Digest }).strict();
export const StoreNodeExecutionPermitSchema = z.object({ protocol: Protocol, executionId: EntityIdSchema, claimId: EntityIdSchema, stepId: EntityIdSchema,
  requestDigest: Digest, permitId: EntityIdSchema, expiresAt: Instant }).strict();
export const StoreNodeExecutionStepInputSchema = StoreNodeExecutionCallSchema.extend({ stepId: EntityIdSchema, permitId: EntityIdSchema,
  requestDigest: Digest, responseDigest: Digest.nullable(), httpStatus: z.int().min(100).max(599).nullable(), outcome: z.enum(["received", "unknown", "not_sent"]) }).strict()
  .refine(value => value.outcome === "received" ? value.responseDigest !== null && value.httpStatus !== null : value.responseDigest === null && value.httpStatus === null);
export const StoreNodeExecutionCheckpointInputSchema = StoreNodeExecutionCallSchema.extend({ originalCredentialVersion: z.int().positive(),
  payload: StoreNodeCipherSchema, payloadChecksum: Digest }).strict();
export const StoreNodeExecutionCheckpointPayloadSchema = z.object({ credential: z.record(z.string().min(1).max(80), z.string().max(16384)), expiresAt: Instant }).strict();
export const StoreNodeCapabilityResultSchema = MarketplaceCapabilitySnapshotViewSchema.omit({ id: true, accountId: true, version: true, stale: true, platform: true })
  .extend({ healthStatus: z.enum(["healthy", "degraded"]), issues: z.array(z.object({ code: z.string().min(1).max(128), message: z.string().max(1024), severity: z.enum(["blocker", "warning"]) }).strict()).max(200),
    sourceChecksum: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
export const StoreNodeExecutionCompletionPayloadSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("success"), result: StoreNodeCapabilityResultSchema }).strict(),
  z.object({ outcome: z.literal("publication_validation"), result: StoreNodePublicationResultSchema }).strict(),
  z.object({ outcome: z.literal("publication_submit"), result: StoreNodeAmazonSubmissionResultSchema }).strict(),
  z.object({ outcome: z.literal("publication_status"), result: StoreNodeAmazonStatusResultSchema }).strict(),
  z.object({ outcome: z.enum(["failure", "unknown"]), code: StoreNodeExecutionErrorSchema }).strict(),
]);
export const StoreNodeExecutionCompleteInputSchema = StoreNodeExecutionCallSchema.extend({ payload: StoreNodeCipherSchema, payloadChecksum: Digest }).strict();
export const StoreNodeExecutionRuntimeReceiptSchema = z.object({ protocol: Protocol, executionId: EntityIdSchema, claimId: EntityIdSchema,
  state: StoreNodeExecutionStateSchema, phase: StoreNodeExecutionPhaseSchema, checkpointChecksum: Digest.nullable(), credentialVersion: z.int().positive(),
  completionChecksum: Digest.nullable(), snapshotId: EntityIdSchema.nullable(), observedAt: Instant }).strict();
export const StoreNodeExecutionAckSchema = z.object({ protocol: Protocol, executionId: EntityIdSchema, claimId: EntityIdSchema, acknowledged: z.literal(true), observedAt: Instant }).strict();
export type StoreNodeCipher = z.infer<typeof StoreNodeCipherSchema>;
export type StoreNodeSealedCredential = z.infer<typeof StoreNodeSealedCredentialSchema>;
export type StoreNodeExecutionLease = z.infer<typeof StoreNodeExecutionLeaseSchema>;
export type StoreNodeCapabilityLease = z.infer<typeof StoreNodeCapabilityLeaseSchema>;
export type StoreNodePublicationLease = z.infer<typeof StoreNodePublicationLeaseSchema>;
export type StoreNodeAmazonSubmissionLease=z.infer<typeof StoreNodeAmazonSubmissionLeaseSchema>;
export type StoreNodeAmazonStatusLease=z.infer<typeof StoreNodeAmazonStatusLeaseSchema>;
export type StoreNodeExecutionCredential = z.infer<typeof StoreNodeExecutionCredentialSchema>;
export type StoreNodeExecutionCall = z.infer<typeof StoreNodeExecutionCallSchema>;
export type StoreNodeExecutionClaimInput = z.infer<typeof StoreNodeExecutionClaimInputSchema>;
export type StoreNodeExecutionPermitInput = z.infer<typeof StoreNodeExecutionPermitInputSchema>;
export type StoreNodeExecutionStepInput = z.infer<typeof StoreNodeExecutionStepInputSchema>;
export type StoreNodeExecutionCheckpointInput = z.infer<typeof StoreNodeExecutionCheckpointInputSchema>;
export type StoreNodeExecutionCompleteInput = z.infer<typeof StoreNodeExecutionCompleteInputSchema>;
export type StoreNodeExecutionRequestClass = z.infer<typeof StoreNodeExecutionRequestClassSchema>;
export type StoreNodeCapabilityResult = z.infer<typeof StoreNodeCapabilityResultSchema>;
export function storeNodeExecutionSealText(lease: Pick<StoreNodeExecutionLease, "id" | "nodeId" | "certificateGeneration" | "requestChecksum" | "claimId">,
  purpose: "credential" | "checkpoint" | "completion"): string {
  return JSON.stringify([STORE_NODE_EXECUTION_PROTOCOL, purpose, lease.id, lease.nodeId, lease.certificateGeneration, lease.requestChecksum, lease.claimId]);
}
export function storeNodeExecutionCipherText(payload: StoreNodeCipher): string {
  const value = StoreNodeCipherSchema.parse(payload); return JSON.stringify([value.nonce, value.tag, value.ciphertext]);
}
