import type { ProductionEditorDocument, TenantContext } from "@yummyai/contracts";
import type { OrderRuleSnapshot } from "@yummyai/contracts/rules";
import type { OrderDesignResponseRecoveryEvidence } from "@yummyai/contracts/order/design-agent";
import type { OrderWorkDraft } from "@yummyai/contracts/order/workspace";
import type { ArtworkLayout } from "@yummyai/contracts/catalog/artwork";
import type { CustomizationDefinition } from "@yummyai/contracts/catalog/product";
import type { DesignAutomationPlan, DesignAutomationRecipe, DesignAutomationStep } from "@yummyai/contracts/pod/design-automation";

export type OrderDesignAssetPin = {
  key:string; name:string; kind:"image"|"font"; origin:"editor"|"authorized"|"work"|"report";
  assetId?:string; projectId?:string; reportLineId?:string; reportVersionId?:string; fileKey?:string;
  checksum?:string; buyerOriginal?:boolean; usage?:string;
};
export type OrderDesignSnapshot = {
  /** Absent on legacy runs; never substitute current rules during a resume. */
  ruleSnapshot?: OrderRuleSnapshot;
  schemaVersion:1; workItemId:string; workRevisionId:string; sourceVersionId:string|null;
  templateProjectId:string; templateVersionId:string; templateChecksum:string; document:ProductionEditorDocument;
  assets:OrderDesignAssetPin[]; templateAssetKeys:Record<string,string>; masterAssetKey:string|null;
  layout:ArtworkLayout; customization:CustomizationDefinition; draft:OrderWorkDraft; photoOnlyPillow:boolean;
  recipe:DesignAutomationRecipe; plan:DesignAutomationPlan; model:null|{routeId:string;providerConfigId:string;model:string;endpoint:string|null};
  blockers?:string[];
};
export interface OrderDesignDispatcher { enqueue(input:{tenantId:string;requestedBy:string;runId:string;dispatchId:string}):Promise<void>; }
export interface OrderDesignImageGateway {
  generate(input:{context:TenantContext;requestId:string;model:NonNullable<OrderDesignSnapshot["model"]>;prompt:string;bytes:Buffer;size:string;transparent:boolean;signal:AbortSignal}):Promise<{bytes:Buffer;actualCostUsd?:number}>;
}
export interface OrderDesignSuperResolutionGateway {
  validatePolicy(policy:NonNullable<DesignAutomationRecipe["pillowPipeline"]>["upscale"]):Promise<void>;
  upscale(input:{bytes:Buffer;policy:NonNullable<DesignAutomationRecipe["pillowPipeline"]>["upscale"];signal?:AbortSignal}):Promise<{bytes:Buffer;evidence:Record<string,unknown>}>;
}
/** Encrypted step-only evidence. Quarantined response bytes are never registered as UI assets. */
export type OrderDesignResponseReceipt = {
  version:1; requestId:string; checksum:string; byteSize:number; receivedAt:string; quarantined:true; actualCostUsd?:number;
};
export type OrderDesignResponseCheckpoint = OrderDesignResponseReceipt & { objectKey:string };
export type OrderDesignStepCheckpoint = {
  submissionState?:"not_submitted"|"submitted"|"received";
  responseReceipt?:OrderDesignResponseReceipt; responseCheckpoint?:OrderDesignResponseCheckpoint;
  responseProcessingAttempts?:number; localRecovery?:Array<{attempt:number;code:string}>;
  responseRecovery?:OrderDesignResponseRecoveryEvidence;
};
export class OrderDesignError extends Error {
  constructor(readonly code:string, readonly uncertain=false) {super(code);this.name="OrderDesignError";}
}
/** Only for failures proven to occur before any provider submission. */
export class OrderDesignSubmissionNotSentError extends OrderDesignError {
  constructor(code:string){super(code);this.name="OrderDesignSubmissionNotSentError";}
}
export type DesignStepInput = DesignAutomationStep;
