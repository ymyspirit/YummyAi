import { z } from "zod";
import { CreativeExecutionKindSchema, HarnessUsdSchema } from "@yummyai/contracts/harness";
import { CreativeResponseAdoptionCommandSchema } from "@yummyai/contracts/harness/creative-response-adoption";
import { CreativeResponseMediaTypeSchema } from "@yummyai/contracts/harness/creative-response";

const Id=z.uuidv7(),Hash=z.string().regex(/^[a-f0-9]{64}$/);
export const CREATIVE_OWNER_RESPONSE_ADOPTION_VERSION="creative-owner-response-adoption-v1" as const;
export const CreativeAdoptionOwnerKindSchema=CreativeExecutionKindSchema.exclude(["creative_candidate"]);
export const CreativeOwnerResponseAdoptionCommandSchema=CreativeResponseAdoptionCommandSchema;
export const CreativeAdoptionOwnerPinSchema=z.object({version:z.literal(1),executionId:Id,kind:CreativeAdoptionOwnerKindSchema,
  ownerId:Id,parentId:Id.nullable(),status:z.string().min(1).max(100),checksum:Hash}).strict();
export const CreativeOwnerAdoptionArtifactSchema=z.object({role:z.string().regex(/^[a-zA-Z0-9_:-]{1,100}$/),
  assetId:Id,version:z.literal(1),checksumSha256:Hash,mediaType:CreativeResponseMediaTypeSchema,
  byteSize:z.int().positive().max(50*1024*1024),width:z.int().positive().nullable(),height:z.int().positive().nullable()}).strict();
export const CreativeOwnerResponseAdoptionReceiptSchema=z.object({version:z.literal(CREATIVE_OWNER_RESPONSE_ADOPTION_VERSION),
  id:Id,executionId:Id,requestId:z.uuid(),basis:Hash,kind:CreativeAdoptionOwnerKindSchema,stepKey:z.string().min(1).max(160),
  ownerId:Id,parentId:Id.nullable(),ownerStatus:z.string().min(1).max(100),ownerReceiptChecksum:Hash,
  originalPhase:z.enum(["failed","uncertain"]),inputFingerprint:Hash,responseChecksum:Hash,encryptedChecksum:Hash,
  originalCostUsd:HarnessUsdSchema.nullable(),artifacts:z.array(CreativeOwnerAdoptionArtifactSchema).min(1).max(8),
  disposition:z.enum(["aspect_ready","outpaint_artifact_ready","template_inspected","mockup_ready","studio_image_ready"]),
  rightsStatus:z.literal("unverified"),approval:z.literal("review_required"),noNewModelCall:z.literal(true),
  committedAt:z.iso.datetime()}).strict();
export const CreativeOwnerResponseAdoptionRequestSchema=z.object({id:Id,executionId:Id,requestId:z.uuid(),
  command:CreativeOwnerResponseAdoptionCommandSchema,status:z.enum(["prepared","processing","committed","cancelled"]),
  attempts:z.int().nonnegative().max(3),leaseActive:z.boolean(),canRetry:z.boolean(),canCancel:z.boolean(),
  errorCode:z.string().max(100).nullable(),artifactCleanup:z.enum(["not_required","pending","complete","registered"]),
  createdAt:z.iso.datetime(),updatedAt:z.iso.datetime(),receipt:CreativeOwnerResponseAdoptionReceiptSchema.nullable(),
}).strict().superRefine((v,c)=>{
  if(v.requestId!==v.command.requestId||(v.status==="committed")!==(v.receipt!==null)
    ||v.receipt&&(v.receipt.id!==v.id||v.receipt.executionId!==v.executionId||v.receipt.requestId!==v.requestId
      ||v.receipt.basis!==v.command.expectedBasis))c.addIssue({code:"custom",message:"Original owner adoption identity changed"});
});
export const CreativeOwnerResponseAdoptionWorkspaceSchema=z.object({version:z.literal(CREATIVE_OWNER_RESPONSE_ADOPTION_VERSION),
  executionId:Id,kind:CreativeAdoptionOwnerKindSchema,stepKey:z.string().min(1).max(160),ownerId:Id,parentId:Id.nullable(),parentExecutionId:Id.nullable(),
  ownerStatus:z.string().min(1).max(100),identityStamp:Hash,
  originalPhase:z.enum(["pending","preparing","submitted","response_staging","response_ready","completed","failed","uncertain"]),
  basis:Hash.nullable(),canInspectOriginal:z.boolean(),canAdopt:z.boolean(),blockers:z.array(z.string().max(240)).max(16),
  source:z.object({inputFingerprint:Hash,responseChecksum:Hash.nullable(),encryptedChecksum:Hash.nullable(),
    archiveState:z.enum(["registered_unverified","missing","expired","purged"]),archiveExpiresAt:z.iso.datetime().nullable(),
    providerRequestId:z.string().max(512).nullable(),receivedAt:z.iso.datetime().nullable(),
    originalCostUsd:HarnessUsdSchema.nullable(),providerInvoiceVerified:z.literal(false)}).strict(),
  requests:z.array(CreativeOwnerResponseAdoptionRequestSchema).max(1),noNewModelCall:z.literal(true),resultRequiresReview:z.literal(true),
}).strict();
export type CreativeAdoptionOwnerPin=z.infer<typeof CreativeAdoptionOwnerPinSchema>;
export type CreativeOwnerResponseAdoptionReceipt=z.infer<typeof CreativeOwnerResponseAdoptionReceiptSchema>;
export type CreativeOwnerResponseAdoptionRequest=z.infer<typeof CreativeOwnerResponseAdoptionRequestSchema>;
export type CreativeOwnerResponseAdoptionWorkspace=z.infer<typeof CreativeOwnerResponseAdoptionWorkspaceSchema>;
