import { z } from "zod";
import { TenantContextSchema } from "@yummyai/contracts/tenant/tenant-context";
import { HarnessExecutionContractSchema } from "@yummyai/contracts/harness";
import { AssistModelSchema } from "@yummyai/contracts/ai/assist";
import { AgentExceptionPageInputSchema, AgentBalancePageInputSchema } from "@yummyai/contracts/ai/agent-read";
import { AgentLoopCostSchema, AgentLoopStepViewSchema, AgentLoopStatusSchema } from "@yummyai/contracts/ai/agent-loop";
import { AgentPlanCommandKeySchema, AgentPlanResolvedProposalSchema, AgentPlanItemViewSchema, AgentPlanSlotSchema, agentPlanCommandKey } from "@yummyai/contracts/ai/agent-plan";
import { AgentToolKeySchema, AgentToolSelectionSchema, AgentToolDefinitionSchema, AgentToolResultSchema, AgentToolWorkspaceSchema, AgentCreativeHistoryInputSchema, AgentFactoryCapacityInputSchema } from "@yummyai/contracts/ai/agent-tools";
import { KnowledgeSearchSchema } from "@yummyai/contracts/knowledge";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";

/** New ABI; no old read/loop/plan input or saved checksum is widened in place. */
export const AGENT_NATIVE_VERSION = "erp-agent-native-v1" as const;
export const AGENT_NATIVE_INTENT_PREFIX = "yummyai.agent-native.intent.v1:";
export const AGENT_NATIVE_CLEAR_EVENT = "yummyai.agent-native-intents-cleared";
export const AGENT_NATIVE_PREPARATION_INTENT_PREFIX = "yummyai.agent-native-preparation.intent.v1:";
const Id=z.uuidv7(), Hash=z.string().regex(/^[a-f0-9]{64}$/), Time=z.iso.datetime(), Authority=z.string().min(1).max(65_536);
const Version={version:z.literal(AGENT_NATIVE_VERSION)};

// The operator fixes object/range authority; only the knowledge keyword is chosen
// by the model. Cursors and page sizes always belong to the server collector.
export const AgentNativeBindingSchema=z.discriminatedUnion("tool",[
 z.object({tool:z.literal("orders.exceptions.page"),scope:AgentExceptionPageInputSchema.omit({pageSize:true,cursor:true})}).strict(),
 z.object({tool:z.literal("inventory.balances.page"),scope:AgentBalancePageInputSchema.omit({pageSize:true,cursor:true})}).strict(),
 z.object({tool:z.literal("knowledge.search"),scope:KnowledgeSearchSchema.omit({query:true})}).strict(),
 z.object({tool:z.literal("creative.history"),scope:AgentCreativeHistoryInputSchema.omit({after:true})}).strict(),
 z.object({tool:z.literal("factory.capacity"),scope:AgentFactoryCapacityInputSchema}).strict(),
]);
export const AgentNativeLimitsSchema=z.object({maxModelTurns:z.int().min(2).max(16),maxToolCalls:z.int().min(2).max(32),
 maxRows:z.int().min(1).max(10_000),maxOutputTokens:z.int().min(128).max(8192),
 maxPromptBytes:z.int().min(4096).max(1_048_576),deadlineSeconds:z.int().min(30).max(600),maxProposals:z.int().min(1).max(8)}).strict();
export const defaultAgentNativeLimits=()=>AgentNativeLimitsSchema.parse({maxModelTurns:12,maxToolCalls:32,maxRows:2000,maxOutputTokens:4096,maxPromptBytes:1_048_576,deadlineSeconds:600,maxProposals:8});
export const maximumAgentNativeLimits=()=>AgentNativeLimitsSchema.parse({...defaultAgentNativeLimits(),maxModelTurns:16,maxRows:10_000,maxOutputTokens:8192});
export const CreateAgentNativeSchema=z.object({...Version,requestId:z.uuid(),goal:z.string().trim().min(2).max(4000),
 contextText:z.string().max(16_000),modelId:Id,bindings:z.array(AgentNativeBindingSchema).min(1).max(8),
 allowedCommands:z.array(AgentPlanCommandKeySchema).max(37),limits:AgentNativeLimitsSchema,
 maxCostUsd:z.number().finite().min(0.000001).max(100).multipleOf(0.000001),executionContract:HarnessExecutionContractSchema,
}).strict().superRefine((value,ctx)=>{
 if(new Set(value.bindings.map(canonicalJson)).size!==value.bindings.length||new Set(value.allowedCommands.map(agentPlanCommandKey)).size!==value.allowedCommands.length)
  ctx.addIssue({code:"custom",message:"Each fixed binding and command must be unique"});
});
export const canonicalAgentNativeRequest=(raw:unknown)=>canonicalJson(CreateAgentNativeSchema.parse(raw));
export const AgentNativeReadRequestSchema=z.object({bindingIndex:z.int().min(0).max(7),keyword:z.string().trim().min(1).max(300).nullable()}).strict();

// Native schemas remain on demand. A model supplies JSON text for one original
// command; the server later parses the exact selected Zod branch and original key.
export const AgentNativeClaimSchema=z.object({stepId:Id,resultIndex:z.int().min(0).max(31),dataChecksum:Hash,
 path:z.array(z.union([z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/).max(100),z.int().min(0).max(10_000)])).min(1).max(16),
 value:z.union([z.string().max(4000),z.number().finite(),z.boolean(),z.null()])}).strict();
export const AgentNativeDraftSchema=z.object({position:z.int().min(0).max(7),capability:AgentPlanCommandKeySchema,
 label:z.string().min(1).max(160),reason:z.string().min(1).max(2000),draftJson:z.string().min(2).max(128_000).nullable(),
 claimIndexes:z.array(z.int().min(0).max(99)).max(20),missingInformation:z.array(z.string().min(1).max(500)).max(20),
}).strict().superRefine((value,ctx)=>{
 if((value.draftJson===null)!==(value.missingInformation.length>0))ctx.addIssue({code:"custom",message:"Missing original input requires explicit missing information"});
});
export const AgentNativeModelResultSchema=z.object({summary:z.string().min(1).max(4000),claims:z.array(AgentNativeClaimSchema).max(100),
 missingInformation:z.array(z.string().min(1).max(500)).max(30),proposals:z.array(AgentNativeDraftSchema).max(8)}).strict();
export const AgentNativeDecisionSchema=z.object({action:z.enum(["definition","read","finish"]),label:z.string().min(1).max(160),
 definition:AgentToolSelectionSchema.nullable(),read:AgentNativeReadRequestSchema.nullable(),result:AgentNativeModelResultSchema.nullable(),
}).strict().superRefine((value,ctx)=>{
 if(value.action==="definition"?value.definition===null||value.read!==null||value.result!==null:
  value.action==="read"?value.read===null||value.definition!==null||value.result!==null:value.result===null||value.definition!==null||value.read!==null)
  ctx.addIssue({code:"custom",message:"A model decision must contain exactly its chosen payload"});
});
export const AgentNativeDefinitionEvidenceSchema=z.object({stepId:Id,definition:AgentToolDefinitionSchema}).strict();
export const AgentNativeObservationSchema=z.object({stepId:Id,tool:AgentToolKeySchema,request:AgentNativeReadRequestSchema,
 results:z.array(AgentToolResultSchema).min(1).max(32),basisChecksum:Hash,observedRows:z.int().min(0).max(10_000),
 collectionComplete:z.boolean().nullable(),truncatedBy:z.enum(["row_limit","tool_limit"]).nullable(),
}).strict().superRefine((value,ctx)=>{
 const paged=value.tool==="orders.exceptions.page"||value.tool==="inventory.balances.page";
 if(value.results.some(result=>result.tool!==value.tool)||paged!==(value.collectionComplete!==null)||
  !paged&&(value.results.length!==1||value.truncatedBy!==null)||paged&&value.collectionComplete!==(value.truncatedBy===null))
  ctx.addIssue({code:"custom",message:"Coverage must describe the original native result kind"});
});
export const AgentNativeResolvedProposalSchema=AgentPlanResolvedProposalSchema.safeExtend({claimIndexes:z.array(z.int().min(0).max(99)).max(20)});
export const AgentNativeResultSchema=z.object({summary:z.string().min(1).max(4000),claims:z.array(AgentNativeClaimSchema).max(100),
 missingInformation:z.array(z.string().min(1).max(500)).max(30),proposals:z.array(AgentNativeResolvedProposalSchema).max(8)}).strict()
 .superRefine((value,ctx)=>{if(value.proposals.some((proposal,index)=>proposal.position!==index||proposal.claimIndexes.some(index=>!value.claims[index])))ctx.addIssue({code:"custom",message:"Resolved proposal order and source claims must be bound"});});
export const AgentNativePinnedInputSchema=z.object({...Version,request:CreateAgentNativeSchema,ceiling:TenantContextSchema,
 model:AssistModelSchema.extend({providerConfigId:Id,routeFingerprint:Hash}),readExecutionContract:HarnessExecutionContractSchema}).strict();
export const AgentNativeStepViewSchema=z.object({...AgentLoopStepViewSchema.shape,sequence:z.int().min(1).max(32),kind:z.enum(["model","read","definition"]),tool:AgentToolKeySchema.nullable()}).strict();
export const AgentNativeCostSchema=AgentLoopCostSchema.safeExtend({modelTurns:z.int().min(0).max(16)});
export const AgentNativeViewSchema=z.object({...Version,id:Id,requestId:z.uuid(),requestChecksum:Hash,contextAuthority:Authority,
 revision:z.int().positive(),status:AgentLoopStatusSchema,goal:z.string().max(4000).nullable(),contextText:z.string().max(16_000).nullable(),
 modelLabel:z.string().max(200),bindings:z.array(AgentNativeBindingSchema).max(8),allowedCommands:z.array(AgentPlanCommandKeySchema).max(37),
 executionContract:HarnessExecutionContractSchema,limits:AgentNativeLimitsSchema,cost:AgentNativeCostSchema,toolCalls:z.int().nonnegative(),observedRows:z.int().nonnegative(),
 stopRequestedAt:Time.nullable(),errorCode:z.string().max(100).nullable(),createdAt:Time,updatedAt:Time,deadlineAt:Time,expiresAt:Time,
 privateAvailable:z.boolean(),stepsComplete:z.literal(true),steps:z.array(AgentNativeStepViewSchema).max(32),
 definitions:z.array(AgentNativeDefinitionEvidenceSchema).max(15),observations:z.array(AgentNativeObservationSchema).max(15),
 result:AgentNativeResultSchema.nullable(),items:z.array(AgentPlanItemViewSchema).max(8),
 verification:z.enum(["pending","native_scalar_values_and_current_source_basis_only","not_adopted"]),businessExecution:z.literal("separate_original_confirmation"),
}).strict().superRefine((value,ctx)=>{
 if(!value.privateAvailable&&(value.goal!==null||value.contextText!==null||value.bindings.length||value.steps.length||value.definitions.length||value.observations.length||value.result!==null))ctx.addIssue({code:"custom",message:"Unavailable native content must be cleared"});
 if(value.result&&(value.items.length!==value.result.proposals.length||value.items.some((item,index)=>{const proposal=value.result!.proposals[index];return !proposal||item.id!==proposal.id||item.position!==proposal.position||item.proposalChecksum!==proposal.proposalChecksum||item.originalChecksum!==proposal.originalChecksum||item.preparationRequestChecksum!==proposal.preparationRequestChecksum;})))ctx.addIssue({code:"custom",message:"Items must match immutable native proposals"});
});
export const AgentNativeWorkspaceSchema=z.object({...Version,contextAuthority:Authority,executionContract:HarnessExecutionContractSchema,
 toolWorkspace:AgentToolWorkspaceSchema,models:z.array(AssistModelSchema).max(200),limits:AgentNativeLimitsSchema,canStart:z.boolean(),
 recent:z.array(z.object({id:Id,requestId:z.uuid(),status:AgentLoopStatusSchema,createdAt:Time}).strict()).max(20),recentLimit:z.literal(20),recentHasMore:z.boolean(),mcpState:z.literal("not_connected")}).strict();
export const AgentNativeReceiptQuerySchema=z.object({requestId:z.uuid(),requestChecksum:Hash}).strict();
export const AgentNativeReceiptSchema=z.object({...Version,requestId:z.uuid(),requestChecksum:Hash,disposition:z.enum(["known","not_found"]),
 runId:Id.nullable(),status:AgentLoopStatusSchema.nullable(),contextAuthority:Authority,privateAvailable:z.boolean()}).strict()
 .superRefine((value,ctx)=>{if(value.disposition==="known"?!value.runId||!value.status:value.runId!==null||value.status!==null||value.privateAvailable)ctx.addIssue({code:"custom",message:"Receipt must identify only its original request"});});
export const StopAgentNativeSchema=z.object({...Version,requestId:z.uuid()}).strict();
export const PrepareAgentNativeItemSchema=z.object({...Version,requestId:z.uuid(),proposalChecksum:Hash}).strict();
export const AgentNativeItemReceiptSchema=z.object({...Version,runId:Id,itemId:Id,proposalChecksum:Hash,preparationRequestChecksum:Hash.nullable(),
 disposition:z.enum(["not_requested","unknown","known","blocked"]),agentCommandId:Id.nullable(),ownerCommandId:Id.nullable(),contextAuthority:Authority}).strict()
 .superRefine((value,ctx)=>{if(value.disposition==="known"?!value.agentCommandId||!value.ownerCommandId:value.agentCommandId!==null||value.ownerCommandId!==null)ctx.addIssue({code:"custom",message:"Only a known original receipt carries both original command IDs"});});
export const AgentNativeIntentSchema=z.object({version:z.literal(1),ownerScope:Hash,requestId:z.uuid(),requestChecksum:Hash,runId:Id.nullable(),state:z.enum(["prepared","unknown","known"]),createdAt:Time}).strict();
export const AgentNativePreparationIntentSchema=z.object({version:z.literal(1),ownerScope:Hash,runId:Id,itemId:Id,proposalChecksum:Hash,state:z.enum(["prepared","unknown","known"]),createdAt:Time}).strict();
export const AgentNativeTurnInputSchema=z.object({...Version,runId:Id,turn:z.int().min(1).max(16),goal:z.string().min(2).max(4000),contextText:z.string().max(16_000),
 bindings:z.array(AgentNativeBindingSchema).min(1).max(8),allowedCommands:z.array(AgentPlanCommandKeySchema).max(37),slots:z.array(AgentPlanSlotSchema).min(1).max(8),limits:AgentNativeLimitsSchema,
 definitions:z.array(AgentNativeDefinitionEvidenceSchema).max(15),observations:z.array(AgentNativeObservationSchema).max(15)}).strict();
export type AgentNativeBinding=z.infer<typeof AgentNativeBindingSchema>;
export type CreateAgentNative=z.infer<typeof CreateAgentNativeSchema>;
export type AgentNativeLimits=z.infer<typeof AgentNativeLimitsSchema>;
export type AgentNativeReadRequest=z.infer<typeof AgentNativeReadRequestSchema>;
export type AgentNativeClaim=z.infer<typeof AgentNativeClaimSchema>;
export type AgentNativeDecision=z.infer<typeof AgentNativeDecisionSchema>;
export type AgentNativeObservation=z.infer<typeof AgentNativeObservationSchema>;
export type AgentNativeDefinitionEvidence=z.infer<typeof AgentNativeDefinitionEvidenceSchema>;
export type AgentNativeModelResult=z.infer<typeof AgentNativeModelResultSchema>;
export type AgentNativeResult=z.infer<typeof AgentNativeResultSchema>;
export type AgentNativePinnedInput=z.infer<typeof AgentNativePinnedInputSchema>;
export type AgentNativeView=z.infer<typeof AgentNativeViewSchema>;
export type AgentNativeWorkspace=z.infer<typeof AgentNativeWorkspaceSchema>;
export type AgentNativeTurnInput=z.infer<typeof AgentNativeTurnInputSchema>;
export type AgentNativeIntent=z.infer<typeof AgentNativeIntentSchema>;
export type AgentNativeReceipt=z.infer<typeof AgentNativeReceiptSchema>;
export type AgentNativeItemReceipt=z.infer<typeof AgentNativeItemReceiptSchema>;
export type AgentNativePreparationIntent=z.infer<typeof AgentNativePreparationIntentSchema>;

/** Exact shared checksum payloads; authority and observation clocks are not
 * business versions. The full unmodified native result still has its own hash. */
export function agentNativeSourceBasis(result:z.infer<typeof AgentToolResultSchema>):unknown {
 const data=result.data as unknown as Record<string,unknown>;
 const omit=(value:Record<string,unknown>,names:readonly string[])=>Object.fromEntries(Object.entries(value).filter(([key])=>!names.includes(key)));
 const native=result.tool==="knowledge.search"?omit(data,["retrievedAt"]):
  result.tool==="factory.capacity"?omit(data,["recordedAt","contextAuthority","access"]):
  result.tool==="orders.exceptions.page"||result.tool==="inventory.balances.page"?{
   collectionFingerprint:data.collectionFingerprint,total:data.total,readCount:data.readCount,complete:data.complete,items:data.items,
   query:omit(data.query as Record<string,unknown>,["cursor"]),
  }:data;
 return{tool:result.tool,definitionChecksum:result.definitionChecksum,data:native,coverage:omit(result.coverage as unknown as Record<string,unknown>,["nextCursor"])};
}
export function agentNativeObservationBasisPayload(value:Pick<AgentNativeObservation,"tool"|"request"|"results"|"observedRows"|"collectionComplete"|"truncatedBy">){
 return{version:AGENT_NATIVE_VERSION,tool:value.tool,request:value.request,results:value.results.map(agentNativeSourceBasis),
  observedRows:value.observedRows,collectionComplete:value.collectionComplete,truncatedBy:value.truncatedBy};
}
export function agentNativeProposalChecksumPayload(value:z.infer<typeof AgentNativeResolvedProposalSchema>,claims:readonly AgentNativeClaim[]){
 return{version:AGENT_NATIVE_VERSION,draft:value.draft,claimIndexes:value.claimIndexes,claims:value.claimIndexes.map(index=>claims[index])};
}
/** Only business-data roots are citeable. A complete paged observation alone
 * may establish total; contextual availability never becomes execution authority. */
export function agentNativeClaimValue(observation:AgentNativeObservation,claim:AgentNativeClaim):unknown {
 const result=observation.results[claim.resultIndex];
 if(!result||claim.stepId!==observation.stepId||claim.dataChecksum!==result.dataChecksum)throw new Error("agent_native_claim_invalid");
 const roots:Record<z.infer<typeof AgentToolKeySchema>,readonly string[]>={
  "orders.exceptions.page":["items","total"],"inventory.balances.page":["items","total"],
  "knowledge.search":["references","mode","scanned"],"creative.history":["entries"],"factory.capacity":["factoryId","from","days","pools","calendar"],
 };
 if(!roots[result.tool].includes(String(claim.path[0]))||claim.path[0]==="total"&&observation.collectionComplete!==true)throw new Error("agent_native_claim_invalid");
 let value:unknown=result.data;
 for(const part of claim.path){
  if(["__proto__","constructor","prototype"].includes(String(part))||value===null||typeof value!=="object"||
   Array.isArray(value)!==(typeof part==="number")||!Object.hasOwn(value,part))throw new Error("agent_native_claim_invalid");
  value=(value as Record<string,unknown>)[part];
 }
 if(value!==null&&!["string","number","boolean"].includes(typeof value))throw new Error("agent_native_claim_invalid");
 return value;
}
