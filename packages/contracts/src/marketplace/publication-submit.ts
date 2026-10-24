import {z} from "zod";
import {EntityIdSchema} from "@yummyai/contracts/common/ids";
import {AmazonPublicationPayloadSchema,MarketplacePublicationIssueSchema,MarketplacePublicationRequestViewSchema} from "@yummyai/contracts/marketplace/publication";
import {MarketplaceQuotaTelemetrySchema} from "@yummyai/contracts/marketplace/store";
import {PublicationPreviewExecutionSchema,PublicationPreviewRequestViewSchema,PublicationPreviewTargetSchema,publicationPreviewPayloadText} from "@yummyai/contracts/marketplace/publication-preview";

export const PUBLICATION_SUBMIT_PROTOCOL="erp-publication-submit-v1" as const;
export const STORE_NODE_PUBLICATION_SUBMIT_OPERATION="marketplace.publication.amazon-submit.v1" as const;
export const STORE_NODE_PUBLICATION_STATUS_OPERATION="marketplace.publication.amazon-status.v1" as const;
const Protocol=z.literal(PUBLICATION_SUBMIT_PROTOCOL),Id=EntityIdSchema.transform(value=>value.toLowerCase()),Digest=z.string().regex(/^[a-f0-9]{64}$/),Instant=z.iso.datetime();
const Sku=z.string().min(1).max(160),ExternalId=z.string().min(1).max(500);
const Context=z.object({actorId:EntityIdSchema,tenantId:EntityIdSchema,authority:Digest}).strict();
export const PublicationSubmitTargetSchema=PublicationPreviewTargetSchema.extend({previewRequestId:Id,previewEventId:Id,previewEventSequence:z.int().positive(),previewExecutionId:Id,sku:Sku}).strict();
export const CreatePublicationSubmitInputSchema=PublicationSubmitTargetSchema.extend({requestKey:Id,requestChecksum:Digest,acknowledgeReplacement:z.literal(true)}).strict();
export const PublicationSubmitLookupSchema=z.object({requestKey:Id,requestChecksum:Digest}).strict();
export const PublicationSubmitWorkspaceInputSchema=z.object({previewRequestId:Id}).strict();

/** A status read is a separate operation. A nullable source receipt is never an inferred successful submission. */
export const PublicationStatusTargetSchema=PublicationPreviewTargetSchema.extend({publicationRequestId:Id,submissionExecutionId:Id,submissionTargetChecksum:Digest,
  sourceEventId:Id,sourceEventSequence:z.int().positive(),sourceSubmissionId:ExternalId.nullable(),sku:Sku}).strict();
export const CreatePublicationStatusInputSchema=PublicationStatusTargetSchema.extend({requestKey:Id,requestChecksum:Digest}).strict();
export const PublicationSubmitNodeInputSchema=z.object({operationId:EntityIdSchema,publicationRequestId:EntityIdSchema,target:PublicationSubmitTargetSchema,payload:AmazonPublicationPayloadSchema}).strict()
  .refine(value=>value.payload.marketplaceId===value.target.marketplaceId&&value.payload.sku===value.target.sku,"Submission payload and fixed target disagree");
export const PublicationStatusNodeInputSchema=z.object({operationId:EntityIdSchema,publicationRequestId:EntityIdSchema,target:PublicationStatusTargetSchema,payload:AmazonPublicationPayloadSchema}).strict()
  .refine(value=>value.publicationRequestId===value.target.publicationRequestId&&value.payload.marketplaceId===value.target.marketplaceId&&value.payload.sku===value.target.sku,"Status read and fixed submission disagree");

const Result=z.object({publicationRequestId:EntityIdSchema,payloadChecksum:Digest,externalListingId:ExternalId,externalState:z.string().min(1).max(500),
  issues:z.array(MarketplacePublicationIssueSchema).max(200),quota:MarketplaceQuotaTelemetrySchema.optional(),submittedAt:Instant}).strict();
export const StoreNodeAmazonSubmissionResultSchema=Result.extend({status:z.enum(["submission_accepted","publication_failed"]),externalSubmissionId:ExternalId}).strict();
export const StoreNodeAmazonStatusResultSchema=Result.extend({status:z.enum(["published","sync_pending","publication_failed","deactivated"]),sourceSubmissionId:ExternalId.nullable()}).strict();
export const PublicationStatusReadViewSchema=z.object({protocol:Protocol,id:EntityIdSchema,requestId:EntityIdSchema,requestKey:EntityIdSchema,requestChecksum:Digest,
  target:PublicationStatusTargetSchema,execution:PublicationPreviewExecutionSchema,result:StoreNodeAmazonStatusResultSchema.nullable(),
  adoptedAsRequestStatus:z.boolean(),createdAt:Instant}).strict()
  .refine(value=>value.requestId===value.target.publicationRequestId&&(!value.result||value.result.publicationRequestId===value.requestId&&value.result.sourceSubmissionId===value.target.sourceSubmissionId)
    &&(!value.adoptedAsRequestStatus||value.result!==null&&value.target.sourceSubmissionId!==null),"Status observation cannot prove an unknown submission");
export const PublicationSubmitReasonSchema=z.enum(["ready","not_authorized","not_configured","legacy_preview","preview_not_passed","source_changed","not_bound","node_offline","draining","credential_unavailable","capability_unavailable","already_submitted","operation_pending","terminal"]);
export const PublicationSubmitRequestViewSchema=z.object({protocol:Protocol,request:MarketplacePublicationRequestViewSchema.strict(),
  intent:z.object({requestKey:EntityIdSchema,requestChecksum:Digest,target:PublicationSubmitTargetSchema}).strict(),execution:PublicationPreviewExecutionSchema,
  result:StoreNodeAmazonSubmissionResultSchema.nullable(),statusTarget:PublicationStatusTargetSchema.nullable(),statusReads:z.array(PublicationStatusReadViewSchema).max(20),
  access:z.object({canCancel:z.boolean(),canReadStatus:z.boolean()}).strict(),statusReason:PublicationSubmitReasonSchema}).strict()
  .refine(value=>value.request.platform==="amazon"&&value.request.action==="amazon_submit"&&value.request.parentRequestId===value.intent.target.previewRequestId
    &&(!value.result||value.result.publicationRequestId===value.request.id),"Submission view must retain its original parent and result");
export const PublicationSubmitWorkspaceSchema=z.object({protocol:Protocol,context:Context,preview:PublicationPreviewRequestViewSchema,target:PublicationSubmitTargetSchema.nullable(),
  access:z.object({canRead:z.literal(true),canSubmit:z.boolean()}).strict(),reason:PublicationSubmitReasonSchema,recent:z.array(PublicationSubmitRequestViewSchema).max(20),observedAt:Instant}).strict();
export const PublicationSubmitReceiptSchema=z.object({protocol:Protocol,requestKey:EntityIdSchema,requestChecksum:Digest,found:z.boolean(),request:PublicationSubmitRequestViewSchema.nullable(),observedAt:Instant}).strict()
  .refine(value=>value.found===(value.request!==null));
export const PublicationStatusReceiptSchema=z.object({protocol:Protocol,requestKey:EntityIdSchema,requestChecksum:Digest,found:z.boolean(),operation:PublicationStatusReadViewSchema.nullable(),observedAt:Instant}).strict()
  .refine(value=>value.found===(value.operation!==null));

function baseTuple(value:z.infer<typeof PublicationPreviewTargetSchema>){return [value.accountId,value.listingId,value.listingVersionId,value.marketplaceId,value.variantSkuId??null,value.capabilitySnapshotId,
  value.payloadChecksum,value.assetManifestChecksum,value.nodeId,value.certificateGeneration,value.authorizationGeneration,value.bindingRevision];}
export function publicationSubmitRequestText(raw:z.input<typeof PublicationSubmitTargetSchema>){const value=PublicationSubmitTargetSchema.parse(raw);
  return JSON.stringify([PUBLICATION_SUBMIT_PROTOCOL,STORE_NODE_PUBLICATION_SUBMIT_OPERATION,...baseTuple(value),value.previewRequestId,value.previewEventId,value.previewEventSequence,value.previewExecutionId,value.sku]);}
export function publicationStatusRequestText(raw:z.input<typeof PublicationStatusTargetSchema>){const value=PublicationStatusTargetSchema.parse(raw);
  return JSON.stringify([PUBLICATION_SUBMIT_PROTOCOL,STORE_NODE_PUBLICATION_STATUS_OPERATION,...baseTuple(value),value.publicationRequestId,value.submissionExecutionId,value.submissionTargetChecksum,value.sourceEventId,value.sourceEventSequence,value.sourceSubmissionId,value.sku]);}
export {publicationPreviewPayloadText as publicationSubmitPayloadText};
export type PublicationSubmitTarget=z.infer<typeof PublicationSubmitTargetSchema>;
export type CreatePublicationSubmitInput=z.infer<typeof CreatePublicationSubmitInputSchema>;
export type PublicationSubmitLookup=z.infer<typeof PublicationSubmitLookupSchema>;
export type PublicationSubmitWorkspaceInput=z.infer<typeof PublicationSubmitWorkspaceInputSchema>;
export type PublicationSubmitWorkspace=z.infer<typeof PublicationSubmitWorkspaceSchema>;
export type PublicationStatusTarget=z.infer<typeof PublicationStatusTargetSchema>;
export type CreatePublicationStatusInput=z.infer<typeof CreatePublicationStatusInputSchema>;
export type PublicationSubmitNodeInput=z.infer<typeof PublicationSubmitNodeInputSchema>;
export type PublicationStatusNodeInput=z.infer<typeof PublicationStatusNodeInputSchema>;
export type StoreNodeAmazonSubmissionResult=z.infer<typeof StoreNodeAmazonSubmissionResultSchema>;
export type StoreNodeAmazonStatusResult=z.infer<typeof StoreNodeAmazonStatusResultSchema>;
export type PublicationStatusReadView=z.infer<typeof PublicationStatusReadViewSchema>;
export type PublicationSubmitRequestView=z.infer<typeof PublicationSubmitRequestViewSchema>;
export type PublicationSubmitReceipt=z.infer<typeof PublicationSubmitReceiptSchema>;
export type PublicationStatusReceipt=z.infer<typeof PublicationStatusReceiptSchema>;
export type PublicationSubmitReason=z.infer<typeof PublicationSubmitReasonSchema>;
