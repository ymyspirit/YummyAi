import { z } from "zod";
import {
  AGENT_MCP_NATIVE_OPERATIONS, type AgentMcpPacket,
} from "@yummyai/contracts/ai/agent-mcp";
import {
  AgentMcpV2NativeDefinitionSchema, AgentMcpV2NativeUsageSchema,
  type AgentMcpV2NativeExecute, type AgentMcpV2NativeSavedResult,
} from "@yummyai/contracts/ai/agent-mcp-v2";
import {
  AGENT_NATIVE_V3_VERSION, AgentNativeV3WorkspaceSchema, AgentNativeV3ViewSchema,
  AgentNativeV3ReceiptQuerySchema, AgentNativeV3ReceiptSchema, CreateAgentNativeV3Schema,
  StopAgentNativeV3Schema, PrepareAgentNativeV3ItemSchema, AgentNativeV3ItemReceiptSchema,
  AgentNativeV3BindingSchema, canonicalAgentNativeV3Request,
  type AgentNativeV3View, type AgentNativeV3ItemReceipt, type AgentNativeV3ReadKey,
} from "@yummyai/contracts/ai/agent-native-v3";
import { verifyAgentNativeV3Transport } from "@yummyai/contracts/ai/agent-native-v3-transport";
import { AgentToolKeySchema } from "@yummyai/contracts/ai/agent-tools";
import { AgentResourceKeySchema } from "@yummyai/contracts/ai/agent-resources";
import { verifyAgentFulfillmentDefinition } from "@yummyai/contracts/ai/agent-fulfillment-transport";
import { agentTransportTextHash } from "@yummyai/contracts/ai/agent-transport";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import type { AgentMcpV2Config } from "./config-v2.js";
import { AgentMcpHttpClient, AgentMcpHttpError, type AgentMcpHttpScope } from "./http-client.js";
import { checkWorkspace, commandAllowed, originalJson, packet, parse, type AgentMcpServerOptions } from "./server.js";

const bad = () => new AgentMcpHttpError("mcp_response_invalid", 502);
const denied = () => new AgentMcpHttpError("mcp_policy_denied", 403);
const sameId = (left: string | null, right: string) => left?.toLowerCase() === right.toLowerCase();
const fixedUsd = (value: string) => {
  const [integer, fraction = ""] = value.split("."); return integer + "." + fraction.padEnd(6, "0");
};
const Usage = z.object({ version: z.literal(AGENT_NATIVE_V3_VERSION), scope: z.literal("run"),
  id: AgentNativeV3ViewSchema.shape.id, requestId: AgentNativeV3ViewSchema.shape.requestId,
  status: AgentNativeV3ViewSchema.shape.status, cost: AgentNativeV3ViewSchema.shape.cost,
  organizationBalance: z.literal("not_provided") }).strict();

/** Routes only the explicit new ABI to the original v3 owner. It does not
 * convert an old request, persist business facts or confirm any command. */
export function createNativeV3McpOperations(config: AgentMcpV2Config, options: AgentMcpServerOptions = {}) {
  const http = new AgentMcpHttpClient(config, options.fetch, options.credentials), submitted = new Set<string>();
  const enabled = () => { if (!config.allowNativeV3) throw denied(); };
  const readAllowed = (key: AgentNativeV3ReadKey) => {
    const old = AgentToolKeySchema.safeParse(key);
    if (old.success) return config.policy.allowedReads.includes(old.data);
    const resource = AgentResourceKeySchema.safeParse(key);
    return resource.success ? config.policy.allowedResources?.includes(resource.data) === true : config.policy.allowFulfillment === true;
  };
  async function scoped(kind: AgentMcpPacket["kind"], signal: AbortSignal | undefined,
    action: (scope: AgentMcpHttpScope) => Promise<Record<string, unknown>>) {
    enabled(); const value = await http.withAuthority(action, signal);
    return packet(kind, value.authority, value.value);
  }
  function mark(key: string) {
    if (submitted.has(key)) throw new AgentMcpHttpError("mcp_submission_unknown");
    if (submitted.size >= 10_000) throw new AgentMcpHttpError("mcp_policy_denied", 429);
    submitted.add(key);
  }
  async function workspace(scope: AgentMcpHttpScope) {
    const value = await scope.request("GET", "/v1/agent-native-v3/workspace", AgentNativeV3WorkspaceSchema);
    if (value.toolWorkspace.contextAuthority !== scope.authority || value.resourceWorkspace.contextAuthority !== scope.authority ||
      value.fulfillmentWorkspace.contextAuthority !== scope.authority) throw bad();
    checkWorkspace(value.toolWorkspace);
    await verifyAgentFulfillmentDefinition(value.fulfillmentWorkspace.definition);
    return value;
  }
  async function readRun(scope: AgentMcpHttpScope, id: string) {
    const value = await scope.request("GET", "/v1/agent-native-v3/runs/" + id, AgentNativeV3ViewSchema);
    if (value.id.toLowerCase() !== id.toLowerCase()) throw bad();
    await verifyAgentNativeV3Transport(value);
    if (value.bindings.some(binding => !readAllowed(binding.tool))) throw denied();
    return value;
  }
  function checkItem(value: AgentNativeV3ItemReceipt, run: AgentNativeV3View, item: AgentNativeV3View["items"][number]) {
    if (!sameId(value.runId, run.id) || !sameId(value.itemId, item.id) || value.proposalChecksum !== item.proposalChecksum ||
      value.preparationRequestChecksum !== item.preparationRequestChecksum ||
      item.agentCommandId !== null && !sameId(value.agentCommandId, item.agentCommandId) ||
      item.ownerCommandId !== null && !sameId(value.ownerCommandId, item.ownerCommandId)) throw bad();
  }

  async function capabilities(signal?: AbortSignal) {
    return scoped("capabilities", signal, async scope => {
      let current: z.infer<typeof AgentNativeV3WorkspaceSchema> | null;
      try { current = await workspace(scope); }
      catch (error) { if (!(error instanceof AgentMcpHttpError) || error.status !== 403) throw error; current = null; }
      return { entries: AGENT_MCP_NATIVE_OPERATIONS.map(operation => {
        const policy = operation === "start" ? config.policy.allowModelRun : operation === "prepare" ? config.policy.allowPrepare : true;
        return { key: "native-v3/" + operation, kind: "native" as const, label: "ERP native v3 " + operation,
          available: policy && current !== null && (operation !== "start" || current.canStart),
          blockReason: !policy ? "startup_policy_denied" : current === null ? "native_workspace_permission_required" :
            operation === "start" && !current.canStart ? "original_owner_denied" : null,
          effect: operation === "start" ? "paid_model_run" : operation === "prepare" ? "prepare_original_command" : operation === "stop" ? "stop_future_dispatch" : "read",
          execution: operation === "prepare" ? "separate_original_confirmation" : "registered_native_v3_owner" };
      }) };
    });
  }
  async function toolSchema(key: string, signal?: AbortSignal) {
    parse(AgentMcpV2NativeDefinitionSchema, { key });
    const operation = key.split("/")[1]!;
    return scoped("definition", signal, async scope => {
      const input = operation === "start" ? CreateAgentNativeV3Schema : operation === "stop" ? StopAgentNativeV3Schema :
        operation === "prepare" || operation === "item_receipt" ? PrepareAgentNativeV3ItemSchema :
          operation === "receipt" ? AgentNativeV3ReceiptQuerySchema : AgentMcpV2NativeUsageSchema;
      const output = operation === "start" || operation === "run" ? AgentNativeV3ViewSchema :
        operation === "prepare" || operation === "item_receipt" ? AgentNativeV3ItemReceiptSchema :
          operation === "stop" || operation === "receipt" ? AgentNativeV3ReceiptSchema : Usage;
      const current = operation === "start" ? await workspace(scope) : null;
      return { key, inputSchema: z.toJSONSchema(input, { io: "input" }), outputSchema: z.toJSONSchema(output, { io: "input" }),
        ...(current ? { executionContract: current.executionContract, models: current.models, limits: current.limits, canStart: current.canStart,
          bindingSchema: z.toJSONSchema(AgentNativeV3BindingSchema, { io: "input" }),
          readContracts: { legacy: current.toolWorkspace.executionContract, resources: current.resourceWorkspace.executionContract,
            fulfillment: current.fulfillmentWorkspace.executionContract } } : {}),
        transport: ["start", "stop", "prepare"].includes(operation) ? "erp_execute" : operation === "usage" ? "erp_usage" : "erp_saved_result",
        originalVersion: AGENT_NATIVE_V3_VERSION, wrapperVersionRequired: AGENT_NATIVE_V3_VERSION,
        requestEncoding: "requestJson", automaticBusinessExecution: false,
        startupEnabled: operation === "start" ? config.policy.allowModelRun : operation === "prepare" ? config.policy.allowPrepare : true };
    });
  }
  async function execute(input: AgentMcpV2NativeExecute, signal?: AbortSignal) {
    enabled(); const raw = originalJson(input.requestJson);
    if (input.operation === "start") {
      const request = parse(CreateAgentNativeV3Schema, raw);
      if (!config.policy.allowModelRun || request.maxCostUsd > config.policy.maxCostUsd ||
        request.bindings.some(binding => !readAllowed(binding.tool)) ||
        request.allowedCommands.some(command => !commandAllowed(config, command))) throw denied();
      const checksum = await agentTransportTextHash(canonicalAgentNativeV3Request(request));
      const recovery = { version: AGENT_NATIVE_V3_VERSION, kind: "request_receipt", requestId: request.requestId, requestChecksum: checksum };
      return scoped("run", signal, async scope => {
        const receipt = await scope.request("GET", "/v1/agent-native-v3/receipt?" + new URLSearchParams({ requestId: request.requestId, requestChecksum: checksum }), AgentNativeV3ReceiptSchema);
        if (!sameId(receipt.requestId, request.requestId) || receipt.requestChecksum !== checksum) throw bad();
        if (receipt.disposition === "known") {
          const value = await readRun(scope, receipt.runId!);
          if (!sameId(value.requestId, request.requestId) || value.requestChecksum !== checksum) throw bad(); return value;
        }
        const key = "start:" + request.requestId + ":" + checksum;
        if (submitted.has(key)) throw new AgentMcpHttpError("mcp_submission_unknown", 0, recovery);
        const current = await workspace(scope);
        if (!current.canStart || !current.models.some(model => sameId(model.id, request.modelId)) ||
          canonicalJson(current.executionContract) !== canonicalJson(request.executionContract)) throw denied();
        scope.throwIfCancelled(); mark(key);
        const value = await scope.request("POST", "/v1/agent-native-v3/runs", AgentNativeV3ViewSchema,
          { body: request, status: 201, submitted: true, recovery });
        try {
          if (!sameId(value.requestId, request.requestId) || value.requestChecksum !== checksum || fixedUsd(value.cost.capUsd) !== request.maxCostUsd.toFixed(6) || value.privateAvailable &&
            (value.goal !== request.goal || value.contextText !== request.contextText || canonicalJson(value.bindings) !== canonicalJson(request.bindings) ||
              canonicalJson(value.allowedCommands) !== canonicalJson(request.allowedCommands) || canonicalJson(value.limits) !== canonicalJson(request.limits) ||
              canonicalJson(value.executionContract) !== canonicalJson(request.executionContract))) throw bad();
          await verifyAgentNativeV3Transport(value);
        } catch { throw new AgentMcpHttpError("mcp_submission_unknown", 502, recovery); }
        return value;
      });
    }
    if (input.operation === "stop") {
      const request = parse(StopAgentNativeV3Schema, raw), id = input.id!.toLowerCase();
      return scoped("receipt", signal, async scope => {
        const recovery = { version: AGENT_NATIVE_V3_VERSION, kind: "run", id };
        const value = await scope.request("POST", "/v1/agent-native-v3/runs/" + id + "/stop", AgentNativeV3ReceiptSchema,
          { body: request, submitted: true, recovery });
        if (value.disposition !== "known" || !sameId(value.runId, id) || !sameId(value.requestId, request.requestId))
          throw new AgentMcpHttpError("mcp_submission_unknown", 502, recovery);
        return value;
      });
    }
    const request = parse(PrepareAgentNativeV3ItemSchema, raw), id = input.id!.toLowerCase(), itemId = input.itemId!.toLowerCase();
    if (!config.policy.allowPrepare) throw denied();
    return scoped("item_receipt", signal, async scope => {
      const run = await readRun(scope, id), item = run.items.find(value => sameId(value.id, itemId)), proposal = run.result?.proposals.find(value => sameId(value.id, itemId));
      if (!run.privateAvailable) throw new AgentMcpHttpError("mcp_result_unavailable", 409);
      if (!item || !proposal || !proposal.draft.original || !sameId(run.requestId, request.requestId) || item.proposalChecksum !== request.proposalChecksum ||
        proposal.proposalChecksum !== request.proposalChecksum) throw bad();
      if (!commandAllowed(config, proposal.draft.capability)) throw denied();
      const recovery = { version: AGENT_NATIVE_V3_VERSION, kind: "item_receipt", id, itemId, requestId: request.requestId, proposalChecksum: request.proposalChecksum };
      const key = "prepare:" + id + ":" + itemId + ":" + request.proposalChecksum, base = "/v1/agent-native-v3/runs/" + id + "/items/" + itemId;
      if (item.preparationRequestedAt !== null || submitted.has(key)) {
        const value = await scope.request("POST", base + "/receipt", AgentNativeV3ItemReceiptSchema, { body: request }); checkItem(value, run, item); return value;
      }
      if (!item.canPrepare || !run.privateAvailable || run.stopRequestedAt) throw new AgentMcpHttpError("mcp_result_unavailable", 409);
      scope.throwIfCancelled(); mark(key);
      const value = await scope.request("POST", base + "/prepare", AgentNativeV3ItemReceiptSchema,
        { body: request, status: 201, submitted: true, recovery });
      try { checkItem(value, run, item); } catch { throw new AgentMcpHttpError("mcp_submission_unknown", 502, recovery); } return value;
    });
  }
  async function savedResult(input: AgentMcpV2NativeSavedResult, signal?: AbortSignal): Promise<AgentMcpPacket> {
    if (input.kind === "request_receipt_from_request") {
      const original = parse(CreateAgentNativeV3Schema, originalJson(input.requestJson));
      const checksum = await agentTransportTextHash(canonicalAgentNativeV3Request(original));
      return savedResult({ version: AGENT_NATIVE_V3_VERSION, kind: "request_receipt",
        requestId: original.requestId, requestChecksum: checksum }, signal);
    }
    if (input.kind === "run") return scoped("run", signal, async scope => readRun(scope, input.id));
    if (input.kind === "request_receipt") return scoped("receipt", signal, async scope => {
      const value = await scope.request("GET", "/v1/agent-native-v3/receipt?" + new URLSearchParams({ requestId: input.requestId, requestChecksum: input.requestChecksum }), AgentNativeV3ReceiptSchema);
      if (!sameId(value.requestId, input.requestId) || value.requestChecksum !== input.requestChecksum) throw bad(); return value;
    });
    return scoped("item_receipt", signal, async scope => {
      const run = await readRun(scope, input.id), item = run.items.find(value => sameId(value.id, input.itemId));
      if (!sameId(run.requestId, input.requestId) || !item || item.proposalChecksum !== input.proposalChecksum) throw bad();
      const body = PrepareAgentNativeV3ItemSchema.parse({ version: AGENT_NATIVE_V3_VERSION, requestId: input.requestId, proposalChecksum: input.proposalChecksum });
      const value = await scope.request("POST", "/v1/agent-native-v3/runs/" + input.id.toLowerCase() + "/items/" + input.itemId.toLowerCase() + "/receipt", AgentNativeV3ItemReceiptSchema, { body });
      checkItem(value, run, item); return value;
    });
  }
  async function usage(input: z.infer<typeof AgentMcpV2NativeUsageSchema>, signal?: AbortSignal) {
    return scoped("usage", signal, async scope => {
      const run = await readRun(scope, input.id);
      return Usage.parse({ version: AGENT_NATIVE_V3_VERSION, scope: "run", id: run.id, requestId: run.requestId,
        status: run.status, cost: run.cost, organizationBalance: "not_provided" });
    });
  }
  return { capabilities, toolSchema, execute, savedResult, usage };
}
