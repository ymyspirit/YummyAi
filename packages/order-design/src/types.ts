import type { ProductionEditorDocument, TenantContext } from "@yummyai/contracts";
import type { OrderRuleSnapshot } from "@yummyai/contracts/rules";
import type { OrderDesignResponseRecoveryEvidence } from "@yummyai/contracts/order/design-agent";
import type { OrderWorkDraft } from "@yummyai/contracts/order/workspace";
import type { ArtworkLayout } from "@yummyai/contracts/catalog/artwork";
import type { CustomizationDefinition } from "@yummyai/contracts/catalog/product";
import type { OrderRequirementInterpretation } from "@yummyai/contracts/order/requirement-interpretation";
import type { DesignAutomationPlan, DesignAutomationRecipe, DesignAutomationStep } from "@yummyai/contracts/pod/design-automation";
import type { ModelTokenUsage } from "@yummyai/contracts/ai/model-usage";
import { ModelProviderHttpFailureSchema, type ModelProviderHttpFailure } from "@yummyai/contracts/ai/provider-failure";

export type OrderDesignAssetPin = {
  key:string; name:string; kind:"image"|"font"; origin:"editor"|"authorized"|"work"|"report";
  assetId?:string; projectId?:string; reportLineId?:string; reportVersionId?:string; fileKey?:string;
  checksum?:string; buyerOriginal?:boolean; usage?:string;
};
export type OrderDesignSnapshot = {
  /** An explicit child attempt. Never inferred or backfilled onto historical runs. */
  revisionRequest?: OrderDesignRevisionRequest;
  /** Absent on legacy runs; never substitute current rules during a resume. */
  ruleSnapshot?: OrderRuleSnapshot;
  schemaVersion:1; workItemId:string; workRevisionId:string; sourceVersionId:string|null;
  templateProjectId:string; templateVersionId:string; templateChecksum:string; document:ProductionEditorDocument;
  assets:OrderDesignAssetPin[]; templateAssetKeys:Record<string,string>; masterAssetKey:string|null;
  layout:ArtworkLayout; customization:CustomizationDefinition; draft:OrderWorkDraft; photoOnlyPillow:boolean;
  recipe:DesignAutomationRecipe; plan:DesignAutomationPlan; model:null|{routeId:string;providerConfigId:string;model:string;endpoint:string|null};
  blockers?:string[];
  /** Present only on new, source-interpreted runs. Legacy snapshots keep their original behavior. */
  requirements?:OrderRequirementInterpretation;
  preparationDiagnostics?:Array<{code:string;severity:"error"|"warning"|"manual";message:string}>;
};
export interface OrderDesignDispatcher { enqueue(input:{tenantId:string;requestedBy:string;runId:string;dispatchId:string}):Promise<void>; }
/** Original provider billing metadata, independent of image validity or adoption. */
export type OrderDesignModelResponseReceipt = {requestId:string;actualCostUsd?:number;tokenUsage?:ModelTokenUsage|null};
export interface OrderDesignImageGateway {
  generate(input:{context:TenantContext;requestId:string;model:NonNullable<OrderDesignSnapshot["model"]>;prompt:string;bytes:Buffer;size:string;transparent:boolean;signal:AbortSignal;
    feedbackImages?:Array<{bytes:Buffer;mediaType:"image/png"|"image/jpeg"|"image/webp"}>;
    onReceipt?:(receipt:OrderDesignModelResponseReceipt)=>Promise<void>}):Promise<{bytes:Buffer;actualCostUsd?:number;tokenUsage?:ModelTokenUsage|null}>;
}
export type OrderDesignRevisionFeedbackImage = {
  id:string;name:string;objectKey:string;checksum:string;byteSize:number;
  mediaType:"image/png"|"image/jpeg"|"image/webp";purpose:"operator_revision_feedback";
};
export type OrderDesignRevisionRequest = {
  /** Missing only on historical candidate-only revision requests. */
  source?:OrderDesignRevisionSource;
  submittedEventId?:string;
  baseProof?:OrderDesignRevisionBaseProof;
  sourceProofs?:OrderDesignRevisionBaseProof[];
  requestId:string;parentRunId:string;baseProjectId:string;baseVersionId:string;baseDocumentChecksum:string;
  targetImageId:string;targetImageChecksum:string;targetLayerIds:string[];
  reason:string;mode:"image_edit"|"contour_only";contourRoundingPx?:20|25|30;
  feedbackImages:OrderDesignRevisionFeedbackImage[];
};
export type OrderDesignRevisionSource="agent_candidate"|"submitted_successor";
export type OrderDesignRevisionBaseProof={renderId:string;manifestChecksum:string;files:Array<{key:string;objectKey:string;mediaType:string;byteSize:number;checksumSha256:string}>};
/** Historical native previews predate a raw-byte checksum in their manifest.
 * Admission keeps their immutable locator; only actual file verification can
 * produce the complete checksum evidence persisted in a child snapshot. */
export type OrderDesignRevisionProofLocator=Omit<OrderDesignRevisionBaseProof,"files">&{
  files:Array<Omit<OrderDesignRevisionBaseProof["files"][number],"checksumSha256">&{checksumSha256?:string}>;
};
export interface OrderDesignSuperResolutionGateway {
  validatePolicy(policy:NonNullable<DesignAutomationRecipe["pillowPipeline"]>["upscale"]):Promise<void>;
  upscale(input:{bytes:Buffer;policy:NonNullable<DesignAutomationRecipe["pillowPipeline"]>["upscale"];signal?:AbortSignal}):Promise<{bytes:Buffer;evidence:Record<string,unknown>}>;
}
/** Encrypted step-only evidence. Quarantined response bytes are never registered as UI assets. */
export type OrderDesignResponseReceipt = OrderDesignModelResponseReceipt & {
  version:1; checksum:string; byteSize:number; receivedAt:string; quarantined:true;
};
export type OrderDesignResponseCheckpoint = OrderDesignResponseReceipt & { objectKey:string };
export type OrderDesignStepCheckpoint = {
  submissionState?:"not_submitted"|"submitted"|"received";
  responseReceipt?:OrderDesignResponseReceipt; responseCheckpoint?:OrderDesignResponseCheckpoint;
  responseProcessingAttempts?:number; localRecovery?:Array<{attempt:number;code:string}>;
  responseRecovery?:OrderDesignResponseRecoveryEvidence;
  providerFailures?:Array<{attempt:number;failure:ModelProviderHttpFailure}>;
  /** Trusted local failures before provider I/O; never inferred from a timeout. */
  unsubmittedAttempts?:number[];
  nextRetryAt?:string;
};
export class OrderDesignError extends Error {
  constructor(readonly code:string, readonly uncertain=false) {super(code);this.name="OrderDesignError";}
}
/** Only for failures proven to occur before any provider submission. */
export class OrderDesignSubmissionNotSentError extends OrderDesignError {
  constructor(code:string){super(code);this.name="OrderDesignSubmissionNotSentError";}
}
/** A received HTTP error, not a generated image or a zero-cost invoice. */
export class OrderDesignProviderRejectedError extends OrderDesignError {
  readonly failure:ModelProviderHttpFailure;
  constructor(failure:ModelProviderHttpFailure){
    super("agent_provider_http_error");
    this.name="OrderDesignProviderRejectedError";
    this.failure=ModelProviderHttpFailureSchema.parse(failure);
  }
}
export type DesignStepInput = DesignAutomationStep;
