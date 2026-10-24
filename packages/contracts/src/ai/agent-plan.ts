import { z } from "zod";
import { TenantContextSchema } from "@yummyai/contracts/tenant/tenant-context";
import { HarnessExecutionContractSchema } from "@yummyai/contracts/harness";
import { AssistModelSchema } from "@yummyai/contracts/ai/assist";
import { AgentReadToolKeySchema, AgentReadWorkspaceSchema } from "@yummyai/contracts/ai/agent-read";
import { AgentLoopLimitsSchema, AgentLoopReadRequestSchema, AgentLoopCollectionSchema, AgentLoopClaimSchema,
  AgentLoopCostSchema, AgentLoopStepViewSchema, AgentLoopStatusSchema } from "@yummyai/contracts/ai/agent-loop";
import { AgentCommandOriginalSchema, AgentCommandCapabilitySchema } from "@yummyai/contracts/ai/agent-command";
import { ProcurementCommandKindSchema } from "@yummyai/contracts/procurement/procurement-command";
import { IncomingCommandKindSchema } from "@yummyai/contracts/procurement/incoming-command";
import { FinanceCommandKindSchema } from "@yummyai/contracts/finance/finance-command";
import { AdCommandKindSchema } from "@yummyai/contracts/advertising/command";
import { ProductionCommandKindSchema } from "@yummyai/contracts/order/production-command";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";

export const AGENT_PLAN_VERSION = "erp-agent-plan-v1" as const;
export const AGENT_PLAN_INTENT_PREFIX = "yummyai.agent-plan.intent.v1:";
export const AGENT_PLAN_CLEAR_EVENT = "yummyai.agent-plan-intents-cleared";
export const AGENT_PLAN_PREPARATION_INTENT_PREFIX = "yummyai.agent-plan-preparation.intent.v1:";
const Id=z.uuidv7(),Hash=z.string().regex(/^[a-f0-9]{64}$/),Time=z.iso.datetime(),Authority=z.string().min(1).max(65_536);
const Version={version:z.literal(AGENT_PLAN_VERSION)};
export const AgentPlanCommandKeySchema=z.discriminatedUnion("domain",[
 z.object({domain:z.literal("procurement"),kind:ProcurementCommandKindSchema}).strict(),
 z.object({domain:z.literal("incoming"),kind:IncomingCommandKindSchema}).strict(),
 z.object({domain:z.literal("production"),kind:ProductionCommandKindSchema}).strict(),
 z.object({domain:z.literal("finance"),kind:FinanceCommandKindSchema}).strict(),
 z.object({domain:z.literal("advertising"),kind:AdCommandKindSchema}).strict(),
]);
export const agentPlanCommandKey=(value:{domain:string;kind:string})=>value.domain+"/"+value.kind;
export const AgentPlanLimitsSchema=AgentLoopLimitsSchema.safeExtend({maxProposals:z.int().min(1).max(8)});
export const defaultAgentPlanLimits=()=>AgentPlanLimitsSchema.parse({maxModelTurns:4,maxToolCalls:16,maxRows:500,maxOutputTokens:4096,maxPromptBytes:1_048_576,deadlineSeconds:600,maxProposals:8});
export const maximumAgentPlanLimits=()=>AgentPlanLimitsSchema.parse({...defaultAgentPlanLimits(),maxModelTurns:8,maxToolCalls:32,maxRows:1000});
export const CreateAgentPlanSchema=z.object({...Version,requestId:z.uuid(),goal:z.string().trim().min(2).max(4000),
 contextText:z.string().max(16_000),modelId:Id,allowedReads:z.array(AgentReadToolKeySchema).max(2),
 allowedCommands:z.array(AgentPlanCommandKeySchema).min(1).max(37),limits:AgentPlanLimitsSchema,
 maxCostUsd:z.number().finite().min(0.000001).max(100).multipleOf(0.000001),executionContract:HarnessExecutionContractSchema,
}).strict().superRefine((value,ctx)=>{
 if(new Set(value.allowedReads).size!==value.allowedReads.length||new Set(value.allowedCommands.map(agentPlanCommandKey)).size!==value.allowedCommands.length)
  ctx.addIssue({code:"custom",message:"Each permitted tool or command must be unique"});
});
export const canonicalAgentPlanRequest=(raw:unknown)=>canonicalJson(CreateAgentPlanSchema.parse(raw));
/** A model proposal is an unapproved draft. Native preparation is a separate explicit API action. */
export const AgentPlanDraftSchema=z.object({position:z.int().min(0).max(7),capability:AgentPlanCommandKeySchema,
 label:z.string().min(1).max(160),reason:z.string().min(1).max(2000),
 original:AgentCommandOriginalSchema.nullable(),claims:z.array(AgentLoopClaimSchema).max(20),
 missingInformation:z.array(z.string().min(1).max(500)).max(20),
}).strict().superRefine((value,ctx)=>{
 if(value.original&&(value.original.domain!==value.capability.domain||value.original.command.kind!==value.capability.kind))
  ctx.addIssue({code:"custom",message:"Proposal capability must match its exact native draft"});
 if((value.original===null)!==(value.missingInformation.length>0))
  ctx.addIssue({code:"custom",message:"An incomplete proposal must list missing information and cannot supply a preparable draft"});
});
export const canonicalAgentPlanDraft=(raw:unknown)=>canonicalJson(AgentPlanDraftSchema.parse(raw));
export const AgentPlanModelResultSchema=z.object({summary:z.string().min(1).max(4000),claims:z.array(AgentLoopClaimSchema).max(100),
 missingInformation:z.array(z.string().min(1).max(500)).max(30),proposals:z.array(AgentPlanDraftSchema).max(8),
}).strict().superRefine((value,ctx)=>{
 if(value.proposals.some((item,index)=>item.position!==index))ctx.addIssue({code:"custom",message:"Proposal positions must be a contiguous server slot prefix"});
});
export const AgentPlanDecisionSchema=z.object({action:z.enum(["read","finish"]),label:z.string().min(1).max(160),
 read:AgentLoopReadRequestSchema.nullable(),result:AgentPlanModelResultSchema.nullable(),
}).strict().superRefine((value,ctx)=>{
 if(value.action==="read"?value.read===null||value.result!==null:value.read!==null||value.result===null)
  ctx.addIssue({code:"custom",message:"A planning decision must contain exactly its read or finish payload"});
});
export const AgentPlanSlotSchema=z.object({position:z.int().min(0).max(7),id:Id,idempotencyKey:Id}).strict();
export const AgentPlanResolvedProposalSchema=z.object({id:Id,position:z.int().min(0).max(7),proposalChecksum:Hash,
 originalChecksum:Hash.nullable(),preparationRequestChecksum:Hash.nullable(),draft:AgentPlanDraftSchema,
}).strict().superRefine((value,ctx)=>{
 if(value.position!==value.draft.position||(value.draft.original===null)!==(value.originalChecksum===null)||
  (value.originalChecksum===null)!==(value.preparationRequestChecksum===null)||value.draft.original&&value.draft.original.command.input.idempotencyKey!==value.id)
  ctx.addIssue({code:"custom",message:"Proposal slot, native key and original checksums must be bound"});
});
export const AgentPlanResultSchema=z.object({summary:z.string().min(1).max(4000),claims:z.array(AgentLoopClaimSchema).max(100),
 missingInformation:z.array(z.string().min(1).max(500)).max(30),proposals:z.array(AgentPlanResolvedProposalSchema).max(8),
}).strict().superRefine((value,ctx)=>{if(value.proposals.some((item,index)=>item.position!==index))ctx.addIssue({code:"custom",message:"Resolved proposal order changed"});});
export const AgentPlanPinnedInputSchema=z.object({...Version,request:CreateAgentPlanSchema,ceiling:TenantContextSchema,
 model:AssistModelSchema.extend({providerConfigId:Id,routeFingerprint:Hash}),readExecutionContract:HarnessExecutionContractSchema,
}).strict();
export const AgentPlanItemViewSchema=z.object({id:Id,position:z.int().min(0).max(7),proposalChecksum:Hash,originalChecksum:Hash.nullable(),
 preparationRequestChecksum:Hash.nullable(),preparationRequestedAt:Time.nullable(),agentCommandId:Id.nullable(),ownerCommandId:Id.nullable(),
 preparationState:z.enum(["not_requested","requested_unknown","known","blocked"]),canPrepare:z.boolean(),
 blockReason:z.enum(["missing_information","permission_denied","plan_stopped","input_unavailable","expired","read_sources_changed","planning_incomplete"]).nullable(),
}).strict();
export const AgentPlanViewSchema=z.object({...Version,id:Id,requestId:z.uuid(),requestChecksum:Hash,contextAuthority:Authority,
 revision:z.int().positive(),status:AgentLoopStatusSchema,goal:z.string().max(4000).nullable(),contextText:z.string().max(16_000).nullable(),
 modelLabel:z.string().max(200),allowedReads:z.array(AgentReadToolKeySchema).max(2),allowedCommands:z.array(AgentPlanCommandKeySchema).min(1).max(37),
 executionContract:HarnessExecutionContractSchema,limits:AgentPlanLimitsSchema,cost:AgentLoopCostSchema,toolCalls:z.int().nonnegative(),observedRows:z.int().nonnegative(),
 stopRequestedAt:Time.nullable(),errorCode:z.string().max(100).nullable(),createdAt:Time,updatedAt:Time,deadlineAt:Time,expiresAt:Time,
 privateAvailable:z.boolean(),stepsComplete:z.literal(true),steps:z.array(AgentLoopStepViewSchema).max(16),collections:z.array(AgentLoopCollectionSchema).max(7),
 result:AgentPlanResultSchema.nullable(),items:z.array(AgentPlanItemViewSchema).max(8),
 verification:z.enum(["pending","cited_fields_and_collection_versions_only","not_adopted"]),businessExecution:z.literal("separate_original_confirmation"),
}).strict().superRefine((value,ctx)=>{
 if(!value.privateAvailable&&(value.goal!==null||value.contextText!==null||value.result!==null||value.collections.length>0))
  ctx.addIssue({code:"custom",message:"Unavailable planning input must not retain private proposal content"});
 if(value.result&&(value.items.length!==value.result.proposals.length||value.items.some((item,index)=>{
  const proposal=value.result!.proposals[index];return !proposal||item.id!==proposal.id||item.position!==proposal.position||
   item.proposalChecksum!==proposal.proposalChecksum||item.originalChecksum!==proposal.originalChecksum||item.preparationRequestChecksum!==proposal.preparationRequestChecksum;
 })))ctx.addIssue({code:"custom",message:"Planning items must match their immutable resolved proposals"});
});
export const AgentPlanWorkspaceSchema=z.object({...Version,contextAuthority:Authority,executionContract:HarnessExecutionContractSchema,
 readWorkspace:AgentReadWorkspaceSchema,commandCapabilities:z.array(AgentCommandCapabilitySchema).max(37),models:z.array(AssistModelSchema).max(200),
 limits:AgentPlanLimitsSchema,canStart:z.boolean(),recent:z.array(z.object({id:Id,requestId:z.uuid(),status:AgentLoopStatusSchema,createdAt:Time}).strict()).max(20),
 recentLimit:z.literal(20),recentHasMore:z.boolean(),mcpState:z.literal("not_connected"),
}).strict();
export const AgentPlanReceiptQuerySchema=z.object({requestId:z.uuid(),requestChecksum:Hash}).strict();
export const AgentPlanReceiptSchema=z.object({...Version,requestId:z.uuid(),requestChecksum:Hash,disposition:z.enum(["known","not_found"]),
 runId:Id.nullable(),status:AgentLoopStatusSchema.nullable(),contextAuthority:Authority,privateAvailable:z.boolean(),
}).strict().superRefine((value,ctx)=>{if(value.disposition==="known"?!value.runId||!value.status:value.runId!==null||value.status!==null||value.privateAvailable)ctx.addIssue({code:"custom",message:"Receipt must match its original disposition"});});
export const StopAgentPlanSchema=z.object({...Version,requestId:z.uuid()}).strict();
export const PrepareAgentPlanItemSchema=z.object({...Version,requestId:z.uuid(),proposalChecksum:Hash}).strict();
export const AgentPlanItemReceiptSchema=z.object({...Version,runId:Id,itemId:Id,proposalChecksum:Hash,
 preparationRequestChecksum:Hash.nullable(),disposition:z.enum(["not_requested","unknown","known","blocked"]),
 agentCommandId:Id.nullable(),ownerCommandId:Id.nullable(),contextAuthority:Authority,
}).strict().superRefine((value,ctx)=>{if(value.disposition==="known"?!value.agentCommandId:value.agentCommandId!==null||value.ownerCommandId!==null)ctx.addIssue({code:"custom",message:"Only a known original receipt can carry command IDs"});});
/** Seven scalar fields; no goal, model output, original draft or confirmation token. */
export const AgentPlanIntentSchema=z.object({version:z.literal(1),ownerScope:Hash,requestId:z.uuid(),requestChecksum:Hash,
 runId:Id.nullable(),state:z.enum(["prepared","unknown","known"]),createdAt:Time}).strict();
export const AgentPlanPreparationIntentSchema=z.object({version:z.literal(1),ownerScope:Hash,runId:Id,itemId:Id,proposalChecksum:Hash,
 state:z.enum(["prepared","unknown","known"]),createdAt:Time}).strict();
export type CreateAgentPlan=z.infer<typeof CreateAgentPlanSchema>;
export type AgentPlanCommandKey=z.infer<typeof AgentPlanCommandKeySchema>;
export type AgentPlanLimits=z.infer<typeof AgentPlanLimitsSchema>;
export type AgentPlanDraft=z.infer<typeof AgentPlanDraftSchema>;
export type AgentPlanDecision=z.infer<typeof AgentPlanDecisionSchema>;
export type AgentPlanSlot=z.infer<typeof AgentPlanSlotSchema>;
export type AgentPlanResult=z.infer<typeof AgentPlanResultSchema>;
export type AgentPlanPinnedInput=z.infer<typeof AgentPlanPinnedInputSchema>;
export type AgentPlanItemView=z.infer<typeof AgentPlanItemViewSchema>;
export type AgentPlanView=z.infer<typeof AgentPlanViewSchema>;
export type AgentPlanWorkspace=z.infer<typeof AgentPlanWorkspaceSchema>;
export type AgentPlanReceipt=z.infer<typeof AgentPlanReceiptSchema>;
export type AgentPlanItemReceipt=z.infer<typeof AgentPlanItemReceiptSchema>;
export type AgentPlanIntent=z.infer<typeof AgentPlanIntentSchema>;
export type AgentPlanPreparationIntent=z.infer<typeof AgentPlanPreparationIntentSchema>;
