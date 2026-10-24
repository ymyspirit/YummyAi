import { z } from "zod";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { AmazonPublicationPayloadSchema, MarketplacePublicationIssueSchema, MarketplacePublicationRequestViewSchema } from "@yummyai/contracts/marketplace/publication";
import { MarketplaceQuotaTelemetrySchema } from "@yummyai/contracts/marketplace/store";
import { StoreNodeExecutionPinsSchema, StoreNodeExecutionPhaseSchema, StoreNodeExecutionStateSchema } from "@yummyai/contracts/marketplace/store-node-execution-base";

export const PUBLICATION_PREVIEW_PROTOCOL = "erp-publication-preview-v1" as const;
export const STORE_NODE_PUBLICATION_OPERATION = "marketplace.publication.validation-preview.v1" as const;
const Protocol=z.literal(PUBLICATION_PREVIEW_PROTOCOL), Digest=z.string().regex(/^[a-f0-9]{64}$/), Instant=z.iso.datetime();
const Id=EntityIdSchema.transform(value=>value.toLowerCase());
export const PublicationPreviewTargetSchema=StoreNodeExecutionPinsSchema.extend({ nodeId:Id,authorizationGeneration:z.uuid().transform(value=>value.toLowerCase()),accountId:Id,listingId:Id,listingVersionId:Id,
  marketplaceId:z.string().trim().min(1).max(80),variantSkuId:z.string().trim().min(1).max(160).optional(),
  capabilitySnapshotId:Id,payloadChecksum:Digest,assetManifestChecksum:Digest }).strict();
export const CreatePublicationPreviewInputSchema=PublicationPreviewTargetSchema.extend({ requestKey:Id,requestChecksum:Digest }).strict();
export const PublicationPreviewLookupSchema=z.object({requestKey:Id,requestChecksum:Digest}).strict();
export const PublicationPreviewWorkspaceInputSchema=z.object({listingId:Id,listingVersionId:Id,
  variantSkuId:z.string().trim().min(1).max(160).optional()}).strict();
export const PublicationPreviewNodeInputSchema=z.object({publicationRequestId:EntityIdSchema,target:PublicationPreviewTargetSchema,payload:AmazonPublicationPayloadSchema}).strict()
  .refine(value=>value.payload.marketplaceId===value.target.marketplaceId,"Preview payload and original target disagree");
export const StoreNodePublicationResultSchema=z.object({publicationRequestId:EntityIdSchema,payloadChecksum:Digest,
  status:z.enum(["validation_passed","validation_failed"]),externalListingId:z.string().min(1).max(500).optional(),externalSubmissionId:z.string().min(1).max(500).optional(),
  externalState:z.string().min(1).max(500),issues:z.array(MarketplacePublicationIssueSchema).max(200),quota:MarketplaceQuotaTelemetrySchema.optional(),submittedAt:Instant}).strict();
export const PublicationPreviewExecutionSchema=StoreNodeExecutionPinsSchema.extend({id:EntityIdSchema,state:StoreNodeExecutionStateSchema,phase:StoreNodeExecutionPhaseSchema,
  errorCode:z.string().min(1).max(128).nullable(),createdAt:Instant,updatedAt:Instant,expiresAt:Instant,completedAt:Instant.nullable()}).strict();
export const PublicationPreviewRequestViewSchema=z.object({protocol:Protocol,request:MarketplacePublicationRequestViewSchema.strict(),
  intent:z.object({requestKey:EntityIdSchema,requestChecksum:Digest,target:PublicationPreviewTargetSchema}).strict().nullable(),
  execution:PublicationPreviewExecutionSchema.nullable(),admission:z.enum(["node_preview","legacy"]),
  access:z.object({canCancel:z.boolean(),canContinue:z.boolean()}).strict()}).strict().refine(value=>value.admission==="node_preview"?value.intent!==null&&value.execution!==null:value.intent===null&&value.execution===null);
export const PublicationPreviewReceiptSchema=z.object({protocol:Protocol,requestKey:EntityIdSchema,requestChecksum:Digest,found:z.boolean(),
  request:PublicationPreviewRequestViewSchema.nullable(),observedAt:Instant}).strict().refine(value=>value.found===(value.request!==null));
export const PublicationPreviewSourceSchema=z.object({accountId:EntityIdSchema,accountName:z.string().min(1).max(200),marketplaceId:z.string().min(1).max(80),
  target:PublicationPreviewTargetSchema.nullable(),canPrepare:z.boolean(),reason:z.enum(["ready","not_configured","not_supported","not_authorized","not_bound","draining","node_offline","credential_unavailable","capability_unavailable","listing_not_approved","source_changed"])}).strict();
export const PublicationPreviewWorkspaceSchema=z.object({protocol:Protocol,
  context:z.object({actorId:EntityIdSchema,tenantId:EntityIdSchema,authority:Digest}).strict(),
  listing:z.object({id:EntityIdSchema,versionId:EntityIdSchema,currentVersionId:EntityIdSchema.nullable(),version:z.int().positive(),status:z.string().min(1).max(80),
    title:z.string().max(2000),content:z.record(z.string(),z.unknown())}).strict(),
  access:z.object({canRead:z.literal(true),canPrepare:z.boolean()}).strict(),sources:z.array(PublicationPreviewSourceSchema).max(100),
  recent:z.array(PublicationPreviewRequestViewSchema).max(20),observedAt:Instant}).strict();

/** A bodyless current-read check. These IDs confer no authority and never enter immutable target checksums. */
export const PublicationPreviewReadCheckInputSchema=z.object({listingId:Id,listingVersionId:Id,
  accountIds:z.string().max(4439).refine(value=>{
    if(value==="")return true;
    const ids=value.split(",");
    return ids.length<=120&&ids.every(id=>EntityIdSchema.safeParse(id).success&&id===id.toLowerCase())&&new Set(ids).size===ids.length&&[...ids].sort().join(",")===value;
  },"Read-check accounts must be unique sorted lowercase IDs")}).strict();
export function publicationPreviewReadCheckInput(value:{listing:{id:string;versionId:string};sources:ReadonlyArray<{accountId:string}>;recent:ReadonlyArray<{request:{accountId:string}}>} ){
  return PublicationPreviewReadCheckInputSchema.parse({listingId:value.listing.id,listingVersionId:value.listing.versionId,
    accountIds:[...new Set([...value.sources.map(source=>source.accountId),...value.recent.map(row=>row.request.accountId)].map(id=>id.toLowerCase()))].sort().join(",")});
}
export type PublicationPreviewReadCheckInput=z.infer<typeof PublicationPreviewReadCheckInputSchema>;

/** Only immutable target scalars. Never credentials, authority tokens or a refreshed target. */
export function publicationPreviewRequestText(raw:z.input<typeof PublicationPreviewTargetSchema>):string {
  const v=PublicationPreviewTargetSchema.parse(raw);
  return JSON.stringify([PUBLICATION_PREVIEW_PROTOCOL,v.accountId.toLowerCase(),v.listingId.toLowerCase(),v.listingVersionId.toLowerCase(),v.marketplaceId,
    v.variantSkuId??null,v.capabilitySnapshotId.toLowerCase(),v.payloadChecksum,v.assetManifestChecksum,v.nodeId.toLowerCase(),v.certificateGeneration,
    v.authorizationGeneration.toLowerCase(),v.bindingRevision]);
}
/** Preserve the original Publication checksum algorithm, including localeCompare ordering. */
export function publicationPreviewPayloadText(value:unknown):string {
  if(Array.isArray(value)) return `[${value.map(publicationPreviewPayloadText).join(",")}]`;
  if(value&&typeof value==="object") return `{${Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b))
    .map(([key,entry])=>`${JSON.stringify(key)}:${publicationPreviewPayloadText(entry)}`).join(",")}}`;
  return JSON.stringify(value)??"null";
}
export type PublicationPreviewTarget=z.infer<typeof PublicationPreviewTargetSchema>;
export type CreatePublicationPreviewInput=z.infer<typeof CreatePublicationPreviewInputSchema>;
export type PublicationPreviewLookup=z.infer<typeof PublicationPreviewLookupSchema>;
export type PublicationPreviewWorkspaceInput=z.infer<typeof PublicationPreviewWorkspaceInputSchema>;
export type PublicationPreviewNodeInput=z.infer<typeof PublicationPreviewNodeInputSchema>;
export type StoreNodePublicationResult=z.infer<typeof StoreNodePublicationResultSchema>;
export type PublicationPreviewExecution=z.infer<typeof PublicationPreviewExecutionSchema>;
export type PublicationPreviewRequestView=z.infer<typeof PublicationPreviewRequestViewSchema>;
export type PublicationPreviewReceipt=z.infer<typeof PublicationPreviewReceiptSchema>;
export type PublicationPreviewWorkspace=z.infer<typeof PublicationPreviewWorkspaceSchema>;
