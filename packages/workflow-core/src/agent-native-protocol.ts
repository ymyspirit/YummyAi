import type { AgentNativeV3Binding, AgentNativeV3ReadKey, AgentNativeV3Selection, AgentNativeV3DefinitionEvidence,
  AgentNativeV3Observation, AgentNativeV3ReadResultSchema, AgentNativeV3Workspace } from "@yummyai/contracts/ai/agent-native-v3";
import type { AgentFulfillmentCall } from "@yummyai/contracts/ai/agent-fulfillment";
import type { SharedAgentFulfillmentGateway } from "./agent-fulfillment-gateway.js";
import type { HarnessRegistry } from "@yummyai/ai-core";
import type { TenantContext } from "@yummyai/contracts";
import type { HarnessExecutionContract } from "@yummyai/contracts/harness";
import type { AgentNativeV2PinnedInput, CreateAgentNativeV2, AgentNativeV2TurnInput, AgentNativeV2Result,
  AgentNativeV2DefinitionEvidence, AgentNativeV2Observation, AgentNativeV2Selection, AgentNativeV2ReadRequest,
  AgentNativeV2View, AgentNativeV2Workspace, AgentNativeV2Receipt, AgentNativeV2ItemReceipt,
  AgentNativeV2ReadResultSchema, AgentNativeV2DecisionSchema, AgentNativeV2ModelResultSchema, AgentNativeV2ReadKey,
} from "@yummyai/contracts/ai/agent-native-v2";
import type { AgentToolCall } from "@yummyai/contracts/ai/agent-tools";
import type { AgentResourceCall } from "@yummyai/contracts/ai/agent-resources";
import type { z } from "zod";
import type { AgentNativeToolsPort } from "./agent-native-model.js";
import type { SharedAgentResourcesGateway } from "./agent-resources-gateway.js";
import type { NativeEvidenceOpen, NativeEvidenceStep } from "./agent-native-evidence.js";
import type { AgentCommandV2Key, AgentCommandV2DefinitionWorkspace } from "@yummyai/contracts/ai/agent-command-v2-discovery";
import type { AgentFulfillmentSuggestion } from "@yummyai/contracts/ai/agent-fulfillment-proposal";
import type { AgentCommandV2DefinitionsPort } from "./agent-command-v2-gateway.js";
import type { AgentNativeV4Selection, AgentNativeV4Definition, AgentNativeV4ModelResult, AgentNativeV4Result,
  AgentNativeV4ItemReceipt, AgentNativeV4View, PrepareAgentNativeV4Item } from "@yummyai/contracts/ai/agent-native-v4";

type NativeResolvedDraft = Omit<AgentNativeV2Result["proposals"][number]["draft"], "capability"> & {
  capability: AgentCommandV2Key; fulfillment?: AgentFulfillmentSuggestion | null;
};
export type NativeResolvedProposal = Omit<AgentNativeV2Result["proposals"][number], "draft"> & { draft: NativeResolvedDraft };
type NativeResultShape = Omit<AgentNativeV2Result, "proposals"> & { proposals: NativeResolvedProposal[] };
type NativePrepareShape = { version: string; requestId: string; proposalChecksum: string; completion?: PrepareAgentNativeV4Item["completion"] };
type NativeItemReceiptShape = Omit<AgentNativeV2ItemReceipt, "version"> & { version: string;
  originalProtocol?: AgentNativeV4ItemReceipt["originalProtocol"]; fulfillmentIntentId?: string | null; completionChecksum?: string | null };

/** Family types keep historical adapters exact while the executor remains shared. */
export interface NativeFamily {
  binding: AgentNativeV3Binding; readKey: AgentNativeV3ReadKey; selection: AgentNativeV4Selection;
  definition: AgentNativeV4Definition;
  observation: Omit<AgentNativeV3Observation, "indexComplete"> & { indexComplete?: boolean | null };
  readResult: z.infer<typeof AgentNativeV3ReadResultSchema>;
  command: AgentCommandV2Key; modelResult: AgentNativeV4ModelResult; result: NativeResultShape;
  itemView: AgentNativeV4View["items"][number] | AgentNativeV2View["items"][number];
  prepare: NativePrepareShape; itemReceipt: NativeItemReceiptShape;
}
export interface NativeV2Family extends NativeFamily {
  binding: CreateAgentNativeV2["bindings"][number]; readKey: AgentNativeV2ReadKey; selection: AgentNativeV2Selection;
  definition: AgentNativeV2DefinitionEvidence["definition"]; observation: AgentNativeV2Observation;
  readResult: z.infer<typeof AgentNativeV2ReadResultSchema>;
  command: CreateAgentNativeV2["allowedCommands"][number]; modelResult: z.infer<typeof AgentNativeV2ModelResultSchema>;
  result: AgentNativeV2Result; itemView: AgentNativeV2View["items"][number];
  prepare: { version: string; requestId: string; proposalChecksum: string }; itemReceipt: Omit<AgentNativeV2ItemReceipt, "version"> & { version: string };
}
export interface NativeV3Family extends NativeFamily {
  observation: AgentNativeV3Observation; selection: AgentNativeV3Selection; definition: AgentNativeV3DefinitionEvidence["definition"];
  command: CreateAgentNativeV2["allowedCommands"][number]; modelResult: z.infer<typeof AgentNativeV2ModelResultSchema>;
  result: AgentNativeV2Result; itemView: AgentNativeV2View["items"][number];
  prepare: NativeV2Family["prepare"]; itemReceipt: NativeV2Family["itemReceipt"];
}
export interface NativeV4Family extends NativeFamily {
  observation: AgentNativeV3Observation; result: AgentNativeV4Result; itemView: AgentNativeV4View["items"][number];
  prepare: PrepareAgentNativeV4Item; itemReceipt: Omit<AgentNativeV4ItemReceipt, "version"> & { version: string };
}
export type NativeRequest<F extends NativeFamily = NativeV2Family> = Omit<CreateAgentNativeV2, "version" | "bindings" | "allowedCommands"> & { version: string; bindings: F["binding"][]; allowedCommands: F["command"][] };
export type NativePinned<F extends NativeFamily = NativeV2Family> = Omit<AgentNativeV2PinnedInput, "version" | "request" | "legacyReadExecutionContract" | "resourceExecutionContract"> & {
  version: string; request: NativeRequest<F>; legacyReadExecutionContract?: HarnessExecutionContract; resourceExecutionContract?: HarnessExecutionContract; fulfillmentExecutionContract?: HarnessExecutionContract;
};
export type NativeDefinitionEvidence<F extends NativeFamily = NativeV2Family> = { stepId: string; definition: F["definition"] };
export type NativeTurn<F extends NativeFamily = NativeV2Family> = Omit<AgentNativeV2TurnInput, "version" | "bindings" | "definitions" | "observations" | "allowedCommands"> & {
  version: string; bindings: F["binding"][]; definitions: NativeDefinitionEvidence<F>[]; observations: F["observation"][]; allowedCommands: F["command"][];
};
export type NativeView<F extends NativeFamily = NativeV2Family> = Omit<AgentNativeV2View, "version" | "bindings" | "definitions" | "observations" | "steps" | "readContracts" | "allowedCommands" | "result" | "items"> & {
  version: string; bindings: F["binding"][]; definitions: NativeDefinitionEvidence<F>[]; observations: F["observation"][];
  steps: Array<Omit<AgentNativeV2View["steps"][number], "tool"> & { tool: F["readKey"] | null }>;
  readContracts?: { legacy: HarnessExecutionContract; resources: HarnessExecutionContract; fulfillment?: HarnessExecutionContract } | null;
  allowedCommands: F["command"][]; result: F["result"] | null; items: F["itemView"][];
};
export type NativeWorkspace = Omit<AgentNativeV2Workspace, "version" | "resourceWorkspace"> & { version: string; resourceWorkspace?: AgentNativeV2Workspace["resourceWorkspace"]; fulfillmentWorkspace?: AgentNativeV3Workspace["fulfillmentWorkspace"]; commandWorkspace?: AgentCommandV2DefinitionWorkspace };
export type NativeReceipt = Omit<AgentNativeV2Receipt, "version"> & { version: string };
export type NativeItemReceipt<F extends NativeFamily = NativeV2Family> = F["itemReceipt"];
export type NativeDecision<F extends NativeFamily = NativeV2Family> = Omit<z.infer<typeof AgentNativeV2DecisionSchema>, "definition" | "result"> & { definition: F["selection"] | null; result: F["modelResult"] | null };
export type NativeModelResult<F extends NativeFamily = NativeV2Family> = F["modelResult"];
export type NativeReadResult<F extends NativeFamily = NativeV2Family> = F["readResult"];
export type NativeEvidence<F extends NativeFamily = NativeV2Family> = { definitions: NativeDefinitionEvidence<F>[]; observations: F["observation"][] };
export type NativePorts = { commandDefinitions?: AgentCommandV2DefinitionsPort; fulfillment?: Pick<SharedAgentFulfillmentGateway, "workspace" | "definition" | "call" | "assertBindingAccess" | "assertResultAccess">; tools: AgentNativeToolsPort; resources?: Pick<SharedAgentResourcesGateway, "workspace" | "definition" | "call" | "assertBindingAccess"> };
export type NativeReadWorkspace = {
  contextAuthority: string; executionContract: HarnessExecutionContract;
  legacy: AgentNativeV2Workspace["toolWorkspace"]; resources?: AgentNativeV2Workspace["resourceWorkspace"];
  fulfillment?: AgentNativeV3Workspace["fulfillmentWorkspace"];
  commandWorkspace?: AgentCommandV2DefinitionWorkspace;
  tools: { key: string; available: boolean }[];
};
export type NativeCall = AgentToolCall | AgentResourceCall | AgentFulfillmentCall;
export interface NativeProtocol<F extends NativeFamily = NativeV2Family> {
  version: string; maxSteps: number; maxHistoryCalls: number; outputSchemaName: string; modelTool: string;
  harness: HarnessRegistry; skill: { key: string; version: string };
  decisionWireSchema: z.ZodType; decisionJsonSchema: unknown;
  schemas: {
    request: z.ZodType<NativeRequest<F>>; pinned: z.ZodType<NativePinned<F>>; turn: z.ZodType<NativeTurn<F>>;
    decision: z.ZodType<NativeDecision<F>>; readRequest: z.ZodType<AgentNativeV2ReadRequest>; selection: z.ZodType<F["selection"]>;
    result: z.ZodType<F["result"]>; progress: z.ZodType<{ results: NativeReadResult<F>[] }>;
    workspace: z.ZodType<NativeWorkspace>; view: z.ZodType<NativeView<F>>; receipt: z.ZodType<NativeReceipt>;
    receiptQuery: z.ZodType<{ requestId: string; requestChecksum: string }>;
    stop: z.ZodType<{ version: string; requestId: string }>;
    prepare: z.ZodType<F["prepare"]>; itemReceiptQuery?: z.ZodType<{ version: string; requestId: string; proposalChecksum: string }>;
    itemReceipt: z.ZodType<NativeItemReceipt<F>>;
  };
  readPageState?(binding: F["binding"], result?: F["readResult"]): { paged: boolean; hasMore: boolean; cursor: string | null; maxPageSize: number };
  turnFields?(input: NativePinned<F>): Record<string, unknown>;
  isPartialObservation?(observation: F["observation"]): boolean;
  maximumLimits(): NativeRequest<F>["limits"];
  checkDomains(context: TenantContext, selection: { bindings?: NativeRequest<F>["bindings"]; allowedReads?: string[]; allowedCommands: NativeRequest<F>["allowedCommands"] }, requireRun?: boolean): void;
  readKeys(selection: { bindings?: NativeRequest<F>["bindings"]; allowedReads?: string[] }): F["readKey"][];
  slots(runId: string, count: number): NativeTurn<F>["slots"];
  itemBirthFields?(proposal: F["result"]["proposals"][number]): {
    originalProtocol: "erp-agent-command-v1" | "erp-agent-fulfillment-command-v1"; originalOrderId: string | null;
  };
  workspace(context: TenantContext, ports: NativePorts): Promise<NativeReadWorkspace>;
  pinReads(workspace: NativeReadWorkspace): Pick<NativePinned<F>, "readExecutionContract" | "legacyReadExecutionContract" | "resourceExecutionContract" | "fulfillmentExecutionContract">;
  assertReadContract(input: NativePinned<F>): void;
  viewFields(input: NativePinned<F> | null): Record<string, unknown>;
  workspaceFields(workspace: NativeReadWorkspace): Record<string, unknown>;
  selectionOf(definition: F["definition"]): F["selection"];
  definition(context: TenantContext, selection: F["selection"], ports: NativePorts): Promise<F["definition"]>;
  validateDefinition(input: {request: Pick<NativeRequest<F>, "bindings" | "allowedCommands">}, definition: unknown, selection?: F["selection"]): F["definition"];
  readCall(input: NativePinned<F>, request: AgentNativeV2ReadRequest, checksum: string, options?: { pageSize?: number; cursor?: string | null; factoryFrom?: string }): NativeCall;
  call(context: TenantContext, call: NativeCall, ports: NativePorts): Promise<NativeReadResult<F>>;
  verifyReadResult(result: NativeReadResult<F>, call: NativeCall): void;
  observationRows(result: NativeReadResult<F>): number;
  buildObservation(input: { stepId: string; input: {request: Pick<NativeRequest<F>, "bindings">; fulfillmentExecutionContract?: HarnessExecutionContract}; request: AgentNativeV2ReadRequest; results: readonly NativeReadResult<F>[]; truncatedBy: "row_limit" | "tool_limit" | null }): F["observation"];
  evidenceChain(rows: readonly NativeEvidenceStep[], checksum: string, open: NativeEvidenceOpen): NativeEvidence<F>;
  verifyClaims(result: Pick<F["result"], "claims" | "proposals">, observations: readonly F["observation"][]): void;
  validateCompletion?(proposal: F["result"]["proposals"][number], completion: unknown, observations: readonly F["observation"][]): void;
  resolveResult(runId: string, raw: unknown, allowed: NativeRequest<F>["allowedCommands"], limit: number, definitions: readonly NativeDefinitionEvidence<F>[]): F["result"];
  recheck(input: NativePinned<F>, definitions: readonly NativeDefinitionEvidence<F>[], observations: readonly F["observation"][], ports: NativePorts, take: () => Promise<TenantContext>): Promise<void>;
  scopeAvailable(context: TenantContext, input: NativePinned<F>, evidence: NativeEvidence<F>, ports: NativePorts): Promise<boolean>;
  beforeModelSubmit(context: TenantContext, input: NativePinned<F>, evidence: NativeEvidence<F>, ports: NativePorts, take?: () => Promise<TenantContext>): Promise<void>;
}
