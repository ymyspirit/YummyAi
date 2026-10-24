import type { z } from "zod";
import {
  AGENT_NATIVE_V2_VERSION, AGENT_NATIVE_V2_CLEAR_EVENT, CreateAgentNativeV2Schema, AgentNativeV2BindingSchema,
  AgentNativeV2PreparationIntentSchema, defaultAgentNativeV2Limits,
  type AgentNativeV2View, type AgentNativeV2Workspace, type AgentNativeV2Receipt, type AgentNativeV2ItemReceipt,
  type AgentNativeV2Observation, type AgentNativeV2DefinitionEvidence, type CreateAgentNativeV2,
} from "@yummyai/contracts/ai/agent-native-v2";
import {
  AGENT_NATIVE_V3_VERSION, AGENT_NATIVE_V3_CLEAR_EVENT, CreateAgentNativeV3Schema, AgentNativeV3BindingSchema,
  AgentNativeV3PreparationIntentSchema, defaultAgentNativeV3Limits,
  type AgentNativeV3View, type AgentNativeV3Workspace, type AgentNativeV3Receipt, type AgentNativeV3ItemReceipt,
  type AgentNativeV3Observation, type AgentNativeV3DefinitionEvidence, type AgentNativeV3Binding, type CreateAgentNativeV3,
} from "@yummyai/contracts/ai/agent-native-v3";
import * as v2 from "./agent-native-v2-client";
import * as v3 from "./agent-native-v3-client";
import * as intent2 from "./agent-native-v2-intent";
import * as intent3 from "./agent-native-v3-intent";
import { AGENT_NATIVE_V4_VERSION, AGENT_NATIVE_V4_CLEAR_EVENT, CreateAgentNativeV4Schema, AgentNativeV4BindingSchema,
  AgentNativeV4PreparationIntentSchema, defaultAgentNativeV4Limits,
  type AgentNativeV4View, type AgentNativeV4Workspace, type AgentNativeV4Receipt, type AgentNativeV4ItemReceipt,
  type AgentNativeV4DefinitionEvidence, type CreateAgentNativeV4 } from "@yummyai/contracts/ai/agent-native-v4";
import { AgentPlanCommandKeySchema } from "@yummyai/contracts/ai/agent-plan";
import { AgentCommandV2KeySchema, type AgentCommandV2Key } from "@yummyai/contracts/ai/agent-command-v2-discovery";
import type { AgentReadinessFamily } from "@yummyai/contracts/ai/agent-readiness";
import * as v4 from "./agent-native-v4-client";
import * as intent4 from "./agent-native-v4-intent";

export type NativeTaskView = AgentNativeV2View | AgentNativeV3View | AgentNativeV4View;
export type LegacyNativeTaskView = AgentNativeV2View | AgentNativeV3View;
export type NativeTaskWorkspace = AgentNativeV2Workspace | AgentNativeV3Workspace | AgentNativeV4Workspace;
export type NativeTaskReceipt = AgentNativeV2Receipt | AgentNativeV3Receipt | AgentNativeV4Receipt;
export type NativeTaskItemReceipt = AgentNativeV2ItemReceipt | AgentNativeV3ItemReceipt | AgentNativeV4ItemReceipt;
export type NativeTaskObservation = AgentNativeV2Observation | AgentNativeV3Observation;
export type NativeTaskDefinitionEvidence = AgentNativeV2DefinitionEvidence | AgentNativeV3DefinitionEvidence | AgentNativeV4DefinitionEvidence;
export type NativeTaskBinding = AgentNativeV3Binding;
export type NativeTaskCreate = CreateAgentNativeV2 | CreateAgentNativeV3 | CreateAgentNativeV4;
export type NativeTaskIntent = intent2.AgentNativeV2Intent;
export type NativeTaskPreparationIntent = intent2.AgentNativeV2PreparationIntent;
export type NativeTaskRequestError = v2.AgentNativeV2RequestError | v3.AgentNativeV3RequestError | v4.AgentNativeV4RequestError;

export type NativeTaskAdapter = {
  version: typeof AGENT_NATIVE_V2_VERSION | typeof AGENT_NATIVE_V3_VERSION | typeof AGENT_NATIVE_V4_VERSION;
  urlKey: "agentNativeV2" | "agentNativeV3" | "agentNativeV4";
  readinessFamily: AgentReadinessFamily;
  commandKeySchema: z.ZodType<AgentCommandV2Key>;
  commandDomains: readonly string[];
  clearEvent: string;
  text(value: string): string;
  defaults: typeof defaultAgentNativeV2Limits;
  createSchema: z.ZodType<NativeTaskCreate>;
  bindingSchema: z.ZodType<NativeTaskBinding>;
  preparationSchema: z.ZodType<NativeTaskPreparationIntent>;
  RequestError: typeof v2.AgentNativeV2RequestError;
  readDenied(error: unknown): error is NativeTaskRequestError;
  useIntents: typeof intent2.useAgentNativeV2Intents;
  prepareIntent(raw: unknown, owner: string): Promise<{ input: NativeTaskCreate; intent: NativeTaskIntent }>;
  readIntents: typeof intent2.readAgentNativeV2Intents;
  saveIntent: typeof intent2.saveAgentNativeV2Intent;
  updateIntent: typeof intent2.updateAgentNativeV2Intent;
  forgetIntent: typeof intent2.forgetAgentNativeV2Intent;
  readPreparations: typeof intent2.readAgentNativeV2PreparationIntents;
  savePreparation: typeof intent2.saveAgentNativeV2PreparationIntent;
  updatePreparation: typeof intent2.updateAgentNativeV2PreparationIntent;
  readWorkspace(authority: string, signal?: AbortSignal): Promise<NativeTaskWorkspace>;
  readRun(id: string, authority: string, signal?: AbortSignal): Promise<NativeTaskView>;
  readReceipt(query: { requestId: string; requestChecksum: string }, authority: string, signal?: AbortSignal): Promise<NativeTaskReceipt>;
  create(input: NativeTaskCreate, authority: string): Promise<NativeTaskView>;
  stop(id: string, requestId: string, authority: string): Promise<NativeTaskReceipt>;
  readItemReceipt(run: NativeTaskView, item: NativeTaskView["items"][number], authority: string, signal?: AbortSignal): Promise<NativeTaskItemReceipt>;
  prepareItem(run: NativeTaskView, item: NativeTaskView["items"][number], authority: string): Promise<NativeTaskItemReceipt>;
};
export const nativeTaskV2Adapter: NativeTaskAdapter = {
  version: AGENT_NATIVE_V2_VERSION, urlKey: "agentNativeV2", clearEvent: AGENT_NATIVE_V2_CLEAR_EVENT,
  readinessFamily:"native_v2",commandKeySchema:AgentPlanCommandKeySchema,commandDomains:["procurement","incoming","production","finance","advertising"],
  text: value => value, defaults: defaultAgentNativeV2Limits, createSchema: CreateAgentNativeV2Schema,
  bindingSchema: AgentNativeV2BindingSchema, preparationSchema: AgentNativeV2PreparationIntentSchema,
  RequestError: v2.AgentNativeV2RequestError, readDenied: v2.agentNativeV2ReadDenied,
  useIntents: intent2.useAgentNativeV2Intents,
  prepareIntent: (raw, owner) => intent2.prepareAgentNativeV2Intent(CreateAgentNativeV2Schema.parse(raw), owner),
  readIntents: intent2.readAgentNativeV2Intents, saveIntent: intent2.saveAgentNativeV2Intent,
  updateIntent: intent2.updateAgentNativeV2Intent, forgetIntent: intent2.forgetAgentNativeV2Intent,
  readPreparations: intent2.readAgentNativeV2PreparationIntents, savePreparation: intent2.saveAgentNativeV2PreparationIntent,
  updatePreparation: intent2.updateAgentNativeV2PreparationIntent,
  readWorkspace: v2.readAgentNativeV2Workspace, readRun: v2.readAgentNativeV2Run, readReceipt: v2.readAgentNativeV2Receipt,
  create: (input, authority) => v2.createAgentNativeV2(CreateAgentNativeV2Schema.parse(input), authority),
  stop: (id, requestId, authority) => v2.stopAgentNativeV2(id, { version: AGENT_NATIVE_V2_VERSION, requestId }, authority),
  readItemReceipt: (run, item, authority, signal) => {
    if (run.version !== AGENT_NATIVE_V2_VERSION) throw new v2.AgentNativeV2RequestError(502, "原任务协议不匹配 不改用其它版本读取回执");
    const fixed=run.items.find(value=>value.id===item.id&&value.proposalChecksum===item.proposalChecksum);
    if(!fixed)throw new v2.AgentNativeV2RequestError(502,"原提案身份无法核对");
    return v2.readAgentNativeV2ItemReceipt(run, fixed, authority, signal);
  },
  prepareItem: (run, item, authority) => {
    if (run.version !== AGENT_NATIVE_V2_VERSION) throw new v2.AgentNativeV2RequestError(502, "原任务协议不匹配 不改用其它版本准备");
    const fixed=run.items.find(value=>value.id===item.id&&value.proposalChecksum===item.proposalChecksum);
    if(!fixed)throw new v2.AgentNativeV2RequestError(502,"原提案身份无法核对");
    return v2.prepareAgentNativeV2Item(run, fixed, authority);
  },
};
export const nativeTaskV3Adapter: NativeTaskAdapter = {
  version: AGENT_NATIVE_V3_VERSION, urlKey: "agentNativeV3", clearEvent: AGENT_NATIVE_V3_CLEAR_EVENT,
  readinessFamily:"native_v3",commandKeySchema:AgentPlanCommandKeySchema,commandDomains:["procurement","incoming","production","finance","advertising"],
  text: value => value.replaceAll("十一类", "十二类").replaceAll("独立 v2", "独立 v3").replaceAll("保留旧 v1 与原业务历史", "保留旧 v1 v2 与原业务历史"), defaults: defaultAgentNativeV3Limits, createSchema: CreateAgentNativeV3Schema,
  bindingSchema: AgentNativeV3BindingSchema, preparationSchema: AgentNativeV3PreparationIntentSchema,
  RequestError: v3.AgentNativeV3RequestError, readDenied: v3.agentNativeV3ReadDenied,
  useIntents: intent3.useAgentNativeV3Intents,
  prepareIntent: (raw, owner) => intent3.prepareAgentNativeV3Intent(CreateAgentNativeV3Schema.parse(raw), owner),
  readIntents: intent3.readAgentNativeV3Intents, saveIntent: intent3.saveAgentNativeV3Intent,
  updateIntent: intent3.updateAgentNativeV3Intent, forgetIntent: intent3.forgetAgentNativeV3Intent,
  readPreparations: intent3.readAgentNativeV3PreparationIntents, savePreparation: intent3.saveAgentNativeV3PreparationIntent,
  updatePreparation: intent3.updateAgentNativeV3PreparationIntent,
  readWorkspace: v3.readAgentNativeV3Workspace, readRun: v3.readAgentNativeV3Run, readReceipt: v3.readAgentNativeV3Receipt,
  create: (input, authority) => v3.createAgentNativeV3(CreateAgentNativeV3Schema.parse(input), authority),
  stop: (id, requestId, authority) => v3.stopAgentNativeV3(id, { version: AGENT_NATIVE_V3_VERSION, requestId }, authority),
  readItemReceipt: (run, item, authority, signal) => {
    if (run.version !== AGENT_NATIVE_V3_VERSION) throw new v3.AgentNativeV3RequestError(502, "原任务协议不匹配 不改用其它版本读取回执");
    const fixed=run.items.find(value=>value.id===item.id&&value.proposalChecksum===item.proposalChecksum);
    if(!fixed)throw new v3.AgentNativeV3RequestError(502,"原提案身份无法核对");
    return v3.readAgentNativeV3ItemReceipt(run, fixed, authority, signal);
  },
  prepareItem: (run, item, authority) => {
    if (run.version !== AGENT_NATIVE_V3_VERSION) throw new v3.AgentNativeV3RequestError(502, "原任务协议不匹配 不改用其它版本准备");
    const fixed=run.items.find(value=>value.id===item.id&&value.proposalChecksum===item.proposalChecksum);
    if(!fixed)throw new v3.AgentNativeV3RequestError(502,"原提案身份无法核对");
    return v3.prepareAgentNativeV3Item(run, fixed, authority);
  },
};
export const nativeTaskV4Adapter: NativeTaskAdapter = {
  version:AGENT_NATIVE_V4_VERSION,urlKey:"agentNativeV4",clearEvent:AGENT_NATIVE_V4_CLEAR_EVENT,
  readinessFamily:"native_v4",commandKeySchema:AgentCommandV2KeySchema,commandDomains:["procurement","incoming","production","finance","advertising","fulfillment"],
  text:value=>value.replaceAll("十一类","十二类").replaceAll("独立 v2","独立 v4").replaceAll("保留旧 v1 与原业务历史","保留旧 v1 v2 v3 与原业务历史"),
  defaults:defaultAgentNativeV4Limits,createSchema:CreateAgentNativeV4Schema,bindingSchema:AgentNativeV4BindingSchema,preparationSchema:AgentNativeV4PreparationIntentSchema,
  RequestError:v4.AgentNativeV4RequestError,readDenied:v4.agentNativeV4ReadDenied,useIntents:intent4.useAgentNativeV4Intents,
  prepareIntent:(raw,owner)=>intent4.prepareAgentNativeV4Intent(CreateAgentNativeV4Schema.parse(raw),owner),
  readIntents:intent4.readAgentNativeV4Intents,saveIntent:intent4.saveAgentNativeV4Intent,updateIntent:intent4.updateAgentNativeV4Intent,forgetIntent:intent4.forgetAgentNativeV4Intent,
  readPreparations:intent4.readAgentNativeV4PreparationIntents,savePreparation:intent4.saveAgentNativeV4PreparationIntent,updatePreparation:intent4.updateAgentNativeV4PreparationIntent,
  readWorkspace:v4.readAgentNativeV4Workspace,readRun:v4.readAgentNativeV4Run,readReceipt:v4.readAgentNativeV4Receipt,
  create:(input,authority)=>v4.createAgentNativeV4(CreateAgentNativeV4Schema.parse(input),authority),
  stop:(id,requestId,authority)=>v4.stopAgentNativeV4(id,{version:AGENT_NATIVE_V4_VERSION,requestId},authority),
  readItemReceipt:(run,item,authority,signal)=>{
    if(run.version!==AGENT_NATIVE_V4_VERSION)throw new v4.AgentNativeV4RequestError(502,"原任务协议不匹配 请按原版本读取");
    const fixed=run.items.find(value=>value.id===item.id&&value.proposalChecksum===item.proposalChecksum);
    if(!fixed)throw new v4.AgentNativeV4RequestError(502,"原提案身份无法核对");
    return v4.readAgentNativeV4ItemReceipt(run,fixed,authority,signal);
  },
  prepareItem:(run,item,authority)=>{
    if(run.version!==AGENT_NATIVE_V4_VERSION)throw new v4.AgentNativeV4RequestError(502,"原任务协议不匹配 请按原版本补全");
    const fixed=run.items.find(value=>value.id===item.id&&value.proposalChecksum===item.proposalChecksum);
    if(!fixed)throw new v4.AgentNativeV4RequestError(502,"原提案身份无法核对");
    return v4.prepareAgentNativeV4Item(run,fixed,authority,null);
  },
};
export const nativeTaskCommandChoices = (workspace:NativeTaskWorkspace) => workspace.version===AGENT_NATIVE_V4_VERSION
  ? workspace.commandWorkspace.capabilities : workspace.toolWorkspace.commands;
export const nativeTaskErrorText = (error: unknown) => error instanceof v2.AgentNativeV2RequestError || error instanceof v3.AgentNativeV3RequestError || error instanceof v4.AgentNativeV4RequestError
  ? error.message : "原响应暂不可核对 请读取原回执 不另起付费或原准备请求";
