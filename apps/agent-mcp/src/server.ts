import { McpServer, type StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  AGENT_MCP_VERSION, AGENT_MCP_TOOL_NAMES, AGENT_MCP_NATIVE_OPERATIONS,
  AgentMcpSearchSchema, AgentMcpDefinitionRequestSchema, AgentMcpExecuteSchema,
  AgentMcpSavedResultSchema, AgentMcpUsageSchema, AgentMcpPacketSchema,
  parseAgentMcpCapabilityKey, type AgentMcpSearch, type AgentMcpExecute,
  type AgentMcpSavedResult, type AgentMcpPacket,
} from "@yummyai/contracts/ai/agent-mcp";
import {
  AgentToolWorkspaceSchema, AgentToolDefinitionSchema, AgentToolDefinitionRequestSchema,
  AgentToolCallSchema, AgentToolResultSchema, type AgentToolSelection,
} from "@yummyai/contracts/ai/agent-tools";
import {
  AGENT_NATIVE_VERSION, AgentNativeWorkspaceSchema, AgentNativeViewSchema,
  AgentNativeReceiptQuerySchema, AgentNativeReceiptSchema, CreateAgentNativeSchema,
  StopAgentNativeSchema, PrepareAgentNativeItemSchema, AgentNativeItemReceiptSchema,
  canonicalAgentNativeRequest, type AgentNativeView, type AgentNativeItemReceipt,
} from "@yummyai/contracts/ai/agent-native";
import {
  AgentCommandViewSchema, canonicalAgentCommandOriginal,
} from "@yummyai/contracts/ai/agent-command";
import { AgentPlanCommandKeySchema } from "@yummyai/contracts/ai/agent-plan";
import {
  verifyAgentNativeTransport, verifyAgentToolTransport, verifyAgentToolDefinitionTransport,
  agentTransportTextHash,
} from "@yummyai/contracts/ai/agent-transport";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import {
  AGENT_RESOURCES_VERSION, AgentResourceKeySchema, AgentResourceWorkspaceSchema, AgentResourceDefinitionSchema,
  AgentResourceCallSchema, AgentResourceResultSchema, AgentResourceCandidatesQuerySchema, AgentResourceCandidatesSchema,
  AgentResourceMcpDefinitionRequestSchema, AgentResourceMcpCandidatesRequestSchema,
} from "@yummyai/contracts/ai/agent-resources";
import { verifyAgentResourceDefinition, verifyAgentResourceCandidates, verifyAgentResourceResult } from "@yummyai/contracts/ai/agent-resource-transport";
import { AGENT_FULFILLMENT_VERSION, AGENT_FULFILLMENT_TOOL, AgentFulfillmentWorkspaceSchema, AgentFulfillmentDefinitionSchema,
  AgentFulfillmentCallSchema, AgentFulfillmentResultSchema, AgentFulfillmentCandidatesSchema, AgentFulfillmentMcpDefinitionSchema,
  AgentFulfillmentMcpCandidatesSchema } from "@yummyai/contracts/ai/agent-fulfillment";
import { verifyAgentFulfillmentDefinition, verifyAgentFulfillmentCandidates, verifyAgentFulfillmentResult } from "@yummyai/contracts/ai/agent-fulfillment-transport";
import { parseAgentMcpConfig, type AgentMcpConfig } from "./config.js";
import { AgentMcpHttpClient, AgentMcpHttpError, type AgentMcpHttpScope } from "./http-client.js";
import type { AgentMcpCredentialProvider } from "./credential-provider.js";

type Item = AgentNativeView["items"][number];
type Entry = { key: string; kind: "read" | "command" | "native"; label: string; available: boolean;
  blockReason: string | null; effect: string; execution: string };
const bad = () => new AgentMcpHttpError("mcp_response_invalid", 502);
const denied = () => new AgentMcpHttpError("mcp_policy_denied", 403);
const UsageDataSchema = z.object({
  id: AgentNativeViewSchema.shape.id, requestId: AgentNativeViewSchema.shape.requestId,
  status: AgentNativeViewSchema.shape.status, cost: AgentNativeViewSchema.shape.cost,
  scope: z.literal("run"), organizationBalance: z.literal("not_provided"),
}).strict();

export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AgentMcpHttpError("mcp_input_invalid", 400);
  return result.data;
}
/** Keep the original strict parser and JSON Schema while preventing the SDK's
 * pre-handler formatter from echoing caller-controlled keys or issue paths. */
export function safeInput<S extends z.ZodType>(schema: S): StandardSchemaWithJSON<z.input<S>, z.output<S>> {
  return { "~standard": {
    version: 1, vendor: "yummyai-erp",
    validate(value) {
      try {
        const result = schema.safeParse(value);
        if (result.success) return { value: result.data };
      } catch { /* Validation errors remain fixed and contain no input. */ }
      return { issues: [{ message: "mcp_input_invalid" }] };
    },
    jsonSchema: {
      input: () => z.toJSONSchema(schema, { io: "input", target: "draft-2020-12" }),
      output: () => z.toJSONSchema(schema, { io: "output", target: "draft-2020-12" }),
    },
  } };
}
export function originalJson(value: string): unknown {
  if (Buffer.byteLength(value, "utf8") > 1_048_576) throw new AgentMcpHttpError("mcp_input_invalid", 400);
  try { return JSON.parse(value) as unknown; }
  catch { throw new AgentMcpHttpError("mcp_input_invalid", 400); }
}
export function packet(kind: AgentMcpPacket["kind"], authority: string | null, data: Record<string, unknown>): AgentMcpPacket {
  return AgentMcpPacketSchema.parse({ version: AGENT_MCP_VERSION, kind, contextAuthority: authority, data });
}
export function commandAllowed(config: AgentMcpConfig, value: { domain: string; kind: string }): boolean {
  return config.policy.allowedCommands.some(item => item.domain === value.domain && item.kind === value.kind);
}
function checkNativeWorkspace(value: z.infer<typeof AgentNativeWorkspaceSchema>): void {
  if (value.toolWorkspace.contextAuthority !== value.contextAuthority) throw bad();
  checkWorkspace(value.toolWorkspace);
}
export function checkWorkspace(value: z.infer<typeof AgentToolWorkspaceSchema>): void {
  if (new Set(value.tools.map(item => item.key)).size !== 5 ||
    new Set(value.commands.map(item => item.domain + "/" + item.kind)).size !== 37) throw bad();
  for (const item of value.commands) if (!AgentPlanCommandKeySchema.safeParse({ domain: item.domain, kind: item.kind }).success) throw bad();
}
function checkItem(value: AgentNativeItemReceipt, run: AgentNativeView, item: Item): void {
  if (value.runId !== run.id || value.itemId !== item.id || value.proposalChecksum !== item.proposalChecksum ||
    value.preparationRequestChecksum !== item.preparationRequestChecksum ||
    item.agentCommandId !== null && value.agentCommandId !== item.agentCommandId ||
    item.ownerCommandId !== null && value.ownerCommandId !== item.ownerCommandId) throw bad();
}

/** A copy prevents a test or embedding host from widening policy after startup. */
export function fixedConfig(config: AgentMcpConfig): AgentMcpConfig {
  if (!config.policy.allowModelRun && config.policy.maxCostUsd !== 0 || !config.policy.allowedReads.length) throw denied();
  return parseAgentMcpConfig({ YUMMYAI_MCP_ERP_API_URL: config.apiUrl, YUMMYAI_MCP_ERP_ACCESS_TOKEN: config.accessToken }, [
    ...(config.policy.allowModelRun ? ["--allow-model-run", "--max-cost-usd=" + config.policy.maxCostUsd] : []),
    ...(config.policy.allowPrepare ? ["--allow-prepare"] : []),
    ...config.policy.allowedReads.map(key => "--allow-read=" + key),
    ...config.policy.allowedCommands.map(key => "--allow-command=" + key.domain + "/" + key.kind),
    ...(config.policy.allowedResources ?? []).map(key => "--allow-resource=" + key),
    ...(config.policy.allowFulfillment ? ["--allow-fulfillment"] : []),
  ]);
}

export type AgentMcpServerOptions = { fetch?: typeof globalThis.fetch; credentials?: AgentMcpCredentialProvider };

/** Original operations are shared without reinterpreting any historical body. */
export function createAgentMcpOperations(rawConfig: AgentMcpConfig, options: AgentMcpServerOptions = {}) {
  const config = fixedConfig(rawConfig), http = new AgentMcpHttpClient(config, options.fetch, options.credentials);
  const submitted = new Set<string>();

  async function dispatch(action: () => Promise<AgentMcpPacket>) {
    let result: AgentMcpPacket;
    try { result = await action(); }
    catch (failure) {
      const error = failure instanceof AgentMcpHttpError ? failure : new AgentMcpHttpError("mcp_response_invalid", 502);
      result = packet("error", null, { code: error.code, status: error.status,
        ...(error.recovery ? { recovery: error.recovery, retrySubmittedWrite: false,
          nextAction: "read_original_receipt_only" } : {}) });
    }
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result,
      ...(result.kind === "error" ? { isError: true } : {}) };
  }
  async function scoped(kind: AgentMcpPacket["kind"], signal: AbortSignal | undefined,
    action: (scope: AgentMcpHttpScope) => Promise<Record<string, unknown>>) {
    const result = await http.withAuthority(action, signal);
    return packet(kind, result.authority, result.value);
  }
  function markSubmitted(key: string): void {
    if (submitted.has(key)) throw new AgentMcpHttpError("mcp_submission_unknown");
    // This is a bounded identifier set, never a private request cache.
    if (submitted.size >= 10_000) throw new AgentMcpHttpError("mcp_policy_denied", 429);
    submitted.add(key);
  }
  async function definition(scope: AgentMcpHttpScope, selection: AgentToolSelection) {
    const input = AgentToolDefinitionRequestSchema.parse({ version: "erp-agent-tools-v1", selection });
    const result = await scope.request("POST", "/v1/agent-tools/definition", AgentToolDefinitionSchema, { body: input });
    await verifyAgentToolDefinitionTransport(result, selection);
    return result;
  }
  async function readRun(scope: AgentMcpHttpScope, id: string): Promise<AgentNativeView> {
    const result = await scope.request("GET", "/v1/agent-native/runs/" + id, AgentNativeViewSchema);
    if (result.id.toLowerCase() !== id.toLowerCase()) throw bad();
    await verifyAgentNativeTransport(result);
    if (result.bindings.some(binding => !config.policy.allowedReads.includes(binding.tool))) throw denied();
    return result;
  }

  async function search(input: AgentMcpSearch, signal?: AbortSignal) {
    return scoped("capabilities", signal, async scope => {
      const tools = await scope.request("GET", "/v1/agent-tools/workspace", AgentToolWorkspaceSchema);
      checkWorkspace(tools);
      let native: z.infer<typeof AgentNativeWorkspaceSchema> | null;
      try { native = await scope.request("GET", "/v1/agent-native/workspace", AgentNativeWorkspaceSchema); checkNativeWorkspace(native); }
      catch (error) {
        if (!(error instanceof AgentMcpHttpError) || error.status !== 403) throw error;
        native = null;
      }
      const entries: Entry[] = [
        ...tools.tools.map(item => ({ key: "read/" + item.key, kind: "read" as const, label: item.label,
          available: item.available && config.policy.allowedReads.includes(item.key),
          blockReason: config.policy.allowedReads.includes(item.key) ? item.blockReason : "startup_policy_denied",
          effect: item.effect, execution: "registered_native_reader" })),
        ...tools.commands.map(item => ({ key: "command/" + item.domain + "/" + item.kind, kind: "command" as const,
          label: item.label, available: item.available && config.policy.allowPrepare && commandAllowed(config, item),
          blockReason: config.policy.allowPrepare && commandAllowed(config, item) ? item.blockReason : "startup_policy_denied",
          effect: item.effect, execution: "separate_original_confirmation" })),
        ...AGENT_MCP_NATIVE_OPERATIONS.map(operation => {
          const policyAllows = operation === "start" ? config.policy.allowModelRun : operation === "prepare" ? config.policy.allowPrepare : true;
          return { key: "native/" + operation, kind: "native" as const, label: "ERP native " + operation,
            available: policyAllows && native !== null && (operation !== "start" || native.canStart),
            blockReason: !policyAllows ? "startup_policy_denied" : native === null ? "native_workspace_permission_required" : operation === "start" && !native.canStart ? "original_owner_denied" : null,
            effect: operation === "start" ? "paid_model_run" : operation === "prepare" ? "prepare_original_command" : operation === "stop" ? "stop_future_dispatch" : "read",
            execution: operation === "prepare" ? "separate_original_confirmation" : "registered_native_owner" };
        }),
      ];
      if (config.policy.allowedResources?.length) {
        const resources = await scope.request("GET", "/v1/agent-resources/workspace", AgentResourceWorkspaceSchema);
        entries.push(...resources.tools.map(item => ({ key: "resource/" + item.key, kind: "read" as const, label: item.label,
          available: item.available && config.policy.allowedResources!.includes(item.key),
          blockReason: config.policy.allowedResources!.includes(item.key) ? item.blockReason : "startup_policy_denied",
          effect: "read", execution: "original_owner_object_projection" })));
      }
      if (config.policy.allowFulfillment) {
        const workspace = await scope.request("GET", "/v1/agent-fulfillment/workspace", AgentFulfillmentWorkspaceSchema);
        await verifyAgentFulfillmentDefinition(workspace.definition);
        entries.push({ key: "fulfillment/orders.fulfillment", kind: "read", label: workspace.definition.label, available: workspace.definition.available,
          blockReason: workspace.definition.blockReason, effect: "read", execution: "original_owner_fulfillment_projection" });
      }
      const needle = input.query.toLocaleLowerCase(), matches = entries.filter(item =>
        (input.kind === "all" || item.kind === input.kind) && (item.key + " " + item.label).toLocaleLowerCase().includes(needle));
      return { entries: matches.slice(0, input.limit), totalMatched: matches.length, registrySize: entries.length,
        complete: matches.length <= input.limit, policy: config.policy,
        businessExecution: "separate_original_confirmation", apiClientCredentials: "not_supported" };
    });
  }

  async function toolSchema(key: string, signal?: AbortSignal) {
    return scoped("definition", signal, async scope => {
      if (key.startsWith("fulfillment/")) {
        parse(AgentFulfillmentMcpDefinitionSchema, { key }); if (!config.policy.allowFulfillment) throw denied();
        const workspace = await scope.request("GET", "/v1/agent-fulfillment/workspace", AgentFulfillmentWorkspaceSchema);
        const definition = await scope.request("POST", "/v1/agent-fulfillment/definition", AgentFulfillmentDefinitionSchema,
          { body: { version: AGENT_FULFILLMENT_VERSION, tool: AGENT_FULFILLMENT_TOOL } });
        await verifyAgentFulfillmentDefinition(definition);
        if (workspace.definition.definitionChecksum !== definition.definitionChecksum) throw bad();
        return { key, definition, executionContract: workspace.executionContract, startupEnabled: true,
          callSchema: z.toJSONSchema(AgentFulfillmentCallSchema, { io: "input" }),
          candidatesRequestSchema: z.toJSONSchema(AgentFulfillmentMcpCandidatesSchema, { io: "input" }),
          transport: "erp_execute", operation: "read", requestEncoding: "requestJson", candidateCoverage: "bounded_candidates" };
      }
      if (key.startsWith("resource/")) {
        const parsed = parse(AgentResourceMcpDefinitionRequestSchema, { key });
        const tool = parse(AgentResourceKeySchema, parsed.key.split("/")[1]);
        if (!config.policy.allowedResources?.includes(tool)) throw denied();
        const workspace = await scope.request("GET", "/v1/agent-resources/workspace", AgentResourceWorkspaceSchema);
        const value = await scope.request("POST", "/v1/agent-resources/definition", AgentResourceDefinitionSchema,
          { body: { version: AGENT_RESOURCES_VERSION, tool } });
        await verifyAgentResourceDefinition(value, tool);
        const querySchema = AgentResourceCandidatesQuerySchema.options.find(option => option.shape.tool.value === tool)!;
        const callSchema = AgentResourceCallSchema.options.find(option => option.shape.tool.value === tool)!;
        return { key, definition: value, executionContract: workspace.executionContract, startupEnabled: true,
          callSchema: z.toJSONSchema(callSchema, { io: "input" }),
          candidatesRequestSchema: z.toJSONSchema(z.object({ version: z.literal(AGENT_RESOURCES_VERSION), kind: z.literal("candidates"), query: querySchema }).strict(), { io: "input" }),
          transport: "erp_execute", operation: "read", requestEncoding: "requestJson", candidateCoverage: "bounded_candidates" };
      }
      const selection = parseAgentMcpCapabilityKey(key);
      if (selection.kind !== "native") {
        const workspace = await scope.request("GET", "/v1/agent-tools/workspace", AgentToolWorkspaceSchema); checkWorkspace(workspace);
        return { key, definition: await definition(scope, selection), executionContract: workspace.executionContract,
        startupEnabled: selection.kind === "read" ? config.policy.allowedReads.includes(selection.tool) :
          config.policy.allowPrepare && commandAllowed(config, selection.command) };
      }
      const schema = selection.operation === "start" ? CreateAgentNativeSchema : selection.operation === "stop" ? StopAgentNativeSchema :
        selection.operation === "prepare" || selection.operation === "item_receipt" ? PrepareAgentNativeItemSchema :
        selection.operation === "receipt" ? AgentNativeReceiptQuerySchema : AgentMcpUsageSchema;
      const output = selection.operation === "start" || selection.operation === "run" ? AgentNativeViewSchema :
        selection.operation === "prepare" || selection.operation === "item_receipt" ? AgentNativeItemReceiptSchema :
        selection.operation === "stop" || selection.operation === "receipt" ? AgentNativeReceiptSchema : UsageDataSchema;
      const workspace = selection.operation === "start" ? await scope.request("GET", "/v1/agent-native/workspace", AgentNativeWorkspaceSchema) : null;
      if (workspace) checkNativeWorkspace(workspace);
      return { key, inputSchema: z.toJSONSchema(schema, { io: "input" }), outputSchema: z.toJSONSchema(output, { io: "input" }),
        ...(workspace ? { executionContract: workspace.executionContract, models: workspace.models, limits: workspace.limits, canStart: workspace.canStart } : {}),
        transport: selection.operation === "start" || selection.operation === "stop" || selection.operation === "prepare" ? "erp_execute" :
          selection.operation === "usage" ? "erp_usage" : "erp_saved_result",
        originalVersion: AGENT_NATIVE_VERSION, automaticBusinessExecution: false,
        startupEnabled: selection.operation === "start" ? config.policy.allowModelRun : selection.operation === "prepare" ? config.policy.allowPrepare : true };
    });
  }

  async function execute(input: AgentMcpExecute, signal?: AbortSignal) {
    const raw = originalJson(input.requestJson);
    if (input.operation === "read") {
      if (raw !== null && typeof raw === "object" && "version" in raw && raw.version === AGENT_FULFILLMENT_VERSION) {
        if (!config.policy.allowFulfillment) throw denied();
        const candidates = AgentFulfillmentMcpCandidatesSchema.safeParse(raw);
        if (candidates.success) return scoped("read", signal, async scope => {
          const value = await scope.request("POST", "/v1/agent-fulfillment/candidates", AgentFulfillmentCandidatesSchema, { body: candidates.data.query });
          await verifyAgentFulfillmentCandidates(value, candidates.data.query); return value;
        });
        const call = parse(AgentFulfillmentCallSchema, raw);
        return scoped("read", signal, async scope => {
          const value = await scope.request("POST", "/v1/agent-fulfillment/call", AgentFulfillmentResultSchema, { body: call });
          await verifyAgentFulfillmentResult(value, call); return value;
        });
      }
      if (raw !== null && typeof raw === "object" && "version" in raw && raw.version === AGENT_RESOURCES_VERSION) {
        const candidates = AgentResourceMcpCandidatesRequestSchema.safeParse(raw);
        if (candidates.success) {
          if (!config.policy.allowedResources?.includes(candidates.data.query.tool)) throw denied();
          return scoped("read", signal, async scope => {
            const value = await scope.request("POST", "/v1/agent-resources/candidates", AgentResourceCandidatesSchema, { body: candidates.data.query });
            await verifyAgentResourceCandidates(value, candidates.data.query); return value;
          });
        }
        const call = parse(AgentResourceCallSchema, raw);
        if (!config.policy.allowedResources?.includes(call.tool)) throw denied();
        return scoped("read", signal, async scope => {
          const value = await scope.request("POST", "/v1/agent-resources/call", AgentResourceResultSchema, { body: call });
          await verifyAgentResourceResult(value, call); return value;
        });
      }
      const call = parse(AgentToolCallSchema, raw);
      if (!config.policy.allowedReads.includes(call.tool)) throw denied();
      return scoped("read", signal, async scope => {
        const value = await scope.request("POST", "/v1/agent-tools/call", AgentToolResultSchema, { body: call });
        await verifyAgentToolTransport(value, call);
        return value;
      });
    }
    if (input.operation === "start") {
      const request = parse(CreateAgentNativeSchema, raw);
      if (!config.policy.allowModelRun || request.maxCostUsd > config.policy.maxCostUsd ||
        request.bindings.some(binding => !config.policy.allowedReads.includes(binding.tool)) ||
        request.allowedCommands.some(command => !commandAllowed(config, command))) throw denied();
      const checksum = await agentTransportTextHash(canonicalAgentNativeRequest(request));
      const recovery = { kind: "request_receipt", requestId: request.requestId, requestChecksum: checksum };
      return scoped("run", signal, async scope => {
        const query = new URLSearchParams({ requestId: request.requestId, requestChecksum: checksum });
        const receipt = await scope.request("GET", "/v1/agent-native/receipt?" + query, AgentNativeReceiptSchema);
        if (receipt.requestId !== request.requestId || receipt.requestChecksum !== checksum) throw bad();
        if (receipt.disposition === "known") {
          const value = await readRun(scope, receipt.runId!);
          if (value.requestId !== request.requestId || value.requestChecksum !== checksum) throw bad();
          return value;
        }
        const key = "start:" + request.requestId + ":" + checksum;
        if (submitted.has(key)) throw new AgentMcpHttpError("mcp_submission_unknown", 0, recovery);
        const workspace = await scope.request("GET", "/v1/agent-native/workspace", AgentNativeWorkspaceSchema);
        checkNativeWorkspace(workspace);
        if (!workspace.canStart || !workspace.models.some(model => model.id === request.modelId) ||
          canonicalJson(workspace.executionContract) !== canonicalJson(request.executionContract)) throw denied();
        scope.throwIfCancelled(); markSubmitted(key);
        const value = await scope.request("POST", "/v1/agent-native/runs", AgentNativeViewSchema,
          { body: request, status: 201, submitted: true, recovery });
        try {
          if (value.requestId !== request.requestId || value.requestChecksum !== checksum || value.privateAvailable &&
            (value.goal !== request.goal || value.contextText !== request.contextText || canonicalJson(value.bindings) !== canonicalJson(request.bindings) ||
              canonicalJson(value.allowedCommands) !== canonicalJson(request.allowedCommands) || canonicalJson(value.limits) !== canonicalJson(request.limits) ||
              canonicalJson(value.executionContract) !== canonicalJson(request.executionContract))) throw bad();
          await verifyAgentNativeTransport(value);
        } catch { throw new AgentMcpHttpError("mcp_submission_unknown", 502, recovery); }
        return value;
      });
    }
    if (input.operation === "stop") {
      const request = parse(StopAgentNativeSchema, raw), id = input.id!;
      return scoped("receipt", signal, async scope => {
        const recovery = { kind: "run", id, requestId: request.requestId };
        const value = await scope.request("POST", "/v1/agent-native/runs/" + id + "/stop", AgentNativeReceiptSchema,
          { body: request, submitted: true, recovery });
        if (value.disposition !== "known" || value.runId !== id || value.requestId !== request.requestId)
          throw new AgentMcpHttpError("mcp_submission_unknown", 502, recovery);
        return value;
      });
    }
    const request = parse(PrepareAgentNativeItemSchema, raw), id = input.id!, itemId = input.itemId!;
    if (!config.policy.allowPrepare) throw denied();
    return scoped("item_receipt", signal, async scope => {
      const run = await readRun(scope, id), item = run.items.find(value => value.id === itemId), proposal = run.result?.proposals.find(value => value.id === itemId);
      if (!item || !proposal || !proposal.draft.original || run.requestId !== request.requestId ||
        item.proposalChecksum !== request.proposalChecksum || proposal.proposalChecksum !== request.proposalChecksum) throw bad();
      if (!commandAllowed(config, proposal.draft.capability)) throw denied();
      const recovery = { kind: "item_receipt", id, itemId, requestId: request.requestId, proposalChecksum: request.proposalChecksum };
      const key = "prepare:" + id + ":" + itemId + ":" + request.proposalChecksum;
      const receiptPath = "/v1/agent-native/runs/" + id + "/items/" + itemId;
      // An existing intent is recovered with the original read-only endpoint.
      if (item.preparationRequestedAt !== null || submitted.has(key)) {
        const value = await scope.request("POST", receiptPath + "/receipt", AgentNativeItemReceiptSchema, { body: request });
        checkItem(value, run, item); return value;
      }
      if (!item.canPrepare || !run.privateAvailable || run.stopRequestedAt) throw new AgentMcpHttpError("mcp_result_unavailable", 409);
      scope.throwIfCancelled(); markSubmitted(key);
      const value = await scope.request("POST", receiptPath + "/prepare", AgentNativeItemReceiptSchema,
        { body: request, status: 201, submitted: true, recovery });
      try { checkItem(value, run, item); } catch { throw new AgentMcpHttpError("mcp_submission_unknown", 502, recovery); }
      return value;
    });
  }

  async function savedResult(input: AgentMcpSavedResult, signal?: AbortSignal) {
    if (input.kind === "run") return scoped("run", signal, async scope => readRun(scope, input.id));
    if (input.kind === "request_receipt") return scoped("receipt", signal, async scope => {
      const value = await scope.request("GET", "/v1/agent-native/receipt?" + new URLSearchParams({ requestId: input.requestId, requestChecksum: input.requestChecksum }), AgentNativeReceiptSchema);
      if (value.requestId !== input.requestId || value.requestChecksum !== input.requestChecksum) throw bad(); return value;
    });
    if (input.kind === "item_receipt") return scoped("item_receipt", signal, async scope => {
      const run = await readRun(scope, input.id), item = run.items.find(value => value.id === input.itemId);
      if (run.requestId !== input.requestId || !item || item.proposalChecksum !== input.proposalChecksum) throw bad();
      const body = PrepareAgentNativeItemSchema.parse({ version: AGENT_NATIVE_VERSION, requestId: input.requestId, proposalChecksum: input.proposalChecksum });
      const value = await scope.request("POST", "/v1/agent-native/runs/" + input.id + "/items/" + input.itemId + "/receipt", AgentNativeItemReceiptSchema, { body });
      checkItem(value, run, item);
      return value;
    });
    return scoped("command_receipt", signal, async scope => {
      const value = await scope.request("GET", "/v1/agent-commands/requests/" + input.id, AgentCommandViewSchema);
      if (value.id !== input.id || value.originalChecksum === null || value.originalChecksum !== input.originalChecksum) throw bad();
      if (value.snapshot?.original && await agentTransportTextHash(canonicalAgentCommandOriginal(value.snapshot.original)) !== input.originalChecksum) throw bad();
      // Neither original business content nor the confirmation token is exposed.
      return { id: value.id, requestId: value.requestId, requestChecksum: value.requestChecksum,
        originalChecksum: value.originalChecksum, domain: value.domain, kind: value.kind,
        state: value.state, ownerCommandId: value.ownerCommandId, createdAt: value.createdAt, expiresAt: value.expiresAt,
        reviewPath: "/ai-tasks?agentCommand=" + value.id, businessExecution: "separate_original_confirmation" };
    });
  }

  async function usage(input: z.infer<typeof AgentMcpUsageSchema>, signal?: AbortSignal) {
    return scoped("usage", signal, async scope => {
      const run = await readRun(scope, input.id);
      return UsageDataSchema.parse({ scope: "run", id: run.id, requestId: run.requestId, status: run.status,
        cost: run.cost, organizationBalance: "not_provided" });
    });
  }
  return { config, dispatch, search, toolSchema, execute, savedResult, usage };
}

/** Official SDK server. The only I/O dependency is the fixed personal ERP API. */
export function createAgentMcpServer(rawConfig: AgentMcpConfig, options: AgentMcpServerOptions = {}): McpServer {
  const { config, dispatch, search, toolSchema, execute, savedResult, usage } = createAgentMcpOperations(rawConfig, options);
  const server = new McpServer({ name: "yummyai-erp", version: AGENT_MCP_VERSION }, { maxToolInputElements: 10_000 });
  const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  server.registerTool(AGENT_MCP_TOOL_NAMES.search, {
    description: "Search registered ERP readers, original commands, native operations and explicitly enabled business resources. Metadata does not execute a command.",
    inputSchema: safeInput(AgentMcpSearchSchema), outputSchema: AgentMcpPacketSchema, annotations: readAnnotations,
  }, (input, context) => dispatch(() => search(input, context.mcpReq.signal)));
  server.registerTool(AGENT_MCP_TOOL_NAMES.schema, {
    description: "Load one exact registered original ERP definition. No preparation, payment or business execution.",
    inputSchema: safeInput(config.policy.allowFulfillment ? config.policy.allowedResources?.length
      ? z.union([AgentMcpDefinitionRequestSchema, AgentResourceMcpDefinitionRequestSchema, AgentFulfillmentMcpDefinitionSchema])
      : z.union([AgentMcpDefinitionRequestSchema, AgentFulfillmentMcpDefinitionSchema])
      : config.policy.allowedResources?.length ? z.union([AgentMcpDefinitionRequestSchema, AgentResourceMcpDefinitionRequestSchema]) : AgentMcpDefinitionRequestSchema),
    outputSchema: AgentMcpPacketSchema, annotations: readAnnotations,
  }, (input, context) => dispatch(() => toolSchema(input.key, context.mcpReq.signal)));
  server.registerTool(AGENT_MCP_TOOL_NAMES.execute, {
    description: "Call a fixed ERP reader or explicitly start/stop a native model run or prepare its exact proposal. Startup policy applies. Never confirms or executes a business command. Unknown submissions require saved-result recovery, never retry.",
    inputSchema: safeInput(AgentMcpExecuteSchema), outputSchema: AgentMcpPacketSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, (input, context) => dispatch(() => execute(input, context.mcpReq.signal)));
  server.registerTool(AGENT_MCP_TOOL_NAMES.savedResult, {
    description: "Recover a known original run or pure-ID receipt. Does not dispatch, pay, prepare, confirm or execute. Command receipts expose metadata and an operator review path only.",
    inputSchema: safeInput(AgentMcpSavedResultSchema), outputSchema: AgentMcpPacketSchema, annotations: readAnnotations,
  }, (input, context) => dispatch(() => savedResult(input, context.mcpReq.signal)));
  server.registerTool(AGENT_MCP_TOOL_NAMES.usage, {
    description: "Read one original run's recorded model cost and unknown-cost state. This is not an organization balance or remaining budget.",
    inputSchema: safeInput(AgentMcpUsageSchema), outputSchema: AgentMcpPacketSchema, annotations: readAnnotations,
  }, (input, context) => dispatch(() => usage(input, context.mcpReq.signal)));
  return server;
}
