import { z } from "zod";
import type { AgentMcpPacket } from "@yummyai/contracts/ai/agent-mcp";
import {
  AGENT_MCP_READINESS_VERSION,
  AgentMcpReadinessCallSchema,
  AgentMcpReadinessDefinitionRequestSchema,
  AgentMcpReadinessResultSchema,
  AgentMcpReadinessStartupPolicySchema,
  type AgentMcpReadinessCall,
} from "@yummyai/contracts/ai/agent-mcp-readiness";
import {
  AGENT_READINESS_VERSION,
  AgentReadinessFamilySchema,
  AgentReadinessSchema,
  type AgentReadinessFamily,
} from "@yummyai/contracts/ai/agent-readiness";
import type { AgentMcpV2Config } from "./config-v2.js";
import { AgentMcpHttpClient, AgentMcpHttpError, type AgentMcpHttpScope } from "./http-client.js";
import { fixedConfig, packet, parse, type AgentMcpServerOptions } from "./server.js";

const denied = () => new AgentMcpHttpError("mcp_policy_denied", 403);
const bad = () => new AgentMcpHttpError("mcp_response_invalid", 502);

/** Freeze the embedding host's opt-in independently of the original policy. */
export function fixedAgentMcpReadinessFamilies(value: AgentMcpV2Config["readinessFamilies"]): readonly AgentReadinessFamily[] {
  const result = AgentReadinessFamilySchema.array().max(5).safeParse(value === undefined ? [] : value);
  if (!result.success || new Set(result.data).size !== result.data.length) throw denied();
  return Object.freeze([...result.data]);
}

/** A GET-only sidecar. No task, original request, credential or source is created. */
export function createAgentMcpReadinessOperations(rawConfig: AgentMcpV2Config, options: AgentMcpServerOptions = {}) {
  if (typeof rawConfig.allowNativeV3 !== "boolean") throw denied();
  const base = fixedConfig(rawConfig), families = fixedAgentMcpReadinessFamilies(rawConfig.readinessFamilies);
  const parsed = families.length ? parse(AgentMcpReadinessStartupPolicySchema, {
    allowedFamilies: [...families], allowModelRun: base.policy.allowModelRun, maxCostUsd: base.policy.maxCostUsd,
    allowPrepare: base.policy.allowPrepare, allowNativeV3: rawConfig.allowNativeV3,
    allowedReads: [...base.policy.allowedReads], allowedCommands: base.policy.allowedCommands.map(item => ({ ...item })),
    allowedResources: [...(base.policy.allowedResources ?? [])], allowFulfillment: base.policy.allowFulfillment === true,
  }) : null;
  const startupPolicy = parsed ? Object.freeze({ ...parsed,
    allowedFamilies: Object.freeze([...parsed.allowedFamilies]), allowedReads: Object.freeze([...parsed.allowedReads]),
    allowedCommands: Object.freeze(parsed.allowedCommands.map(item => Object.freeze({ ...item }))),
    allowedResources: Object.freeze([...parsed.allowedResources]),
  }) : null;
  const http = new AgentMcpHttpClient(base, options.fetch, options.credentials);

  function allowed(family: AgentReadinessFamily) {
    if (!startupPolicy || !families.includes(family)) throw denied();
    return startupPolicy;
  }

  async function diagnostic(scope: AgentMcpHttpScope, family: AgentReadinessFamily) {
    allowed(family);
    const value = await scope.request("GET", "/v1/ai/agent-readiness/" + family, AgentReadinessSchema);
    if (value.family !== family) throw bad();
    if (value.contextAuthority !== scope.authority) throw new AgentMcpHttpError("mcp_authority_changed", 409);
    return value;
  }

  async function capabilities(signal?: AbortSignal): Promise<AgentMcpPacket> {
    const first = families[0];
    if (!first) throw denied();
    const result = await http.withAuthority(async scope => {
      let readable = true;
      try { await diagnostic(scope, first); }
      catch (error) {
        if (!(error instanceof AgentMcpHttpError) || error.status !== 403) throw error;
        readable = false;
      }
      return { entries: families.map(family => ({
        key: "readiness/" + family, kind: "read" as const, label: "ERP " + family + " startup readiness",
        available: readable, blockReason: readable ? null : "workflow_read_permission_required",
        effect: "read", execution: "metadata_only_startup_advisory", metadataOnly: true, startupEnabled: true,
      })) };
    }, signal);
    return packet("capabilities", result.authority, result.value);
  }

  async function toolSchema(key: string, signal?: AbortSignal): Promise<AgentMcpPacket> {
    const selected = parse(AgentMcpReadinessDefinitionRequestSchema, { key });
    const family = parse(AgentReadinessFamilySchema, selected.key.slice("readiness/".length));
    allowed(family);
    const result = await http.withAuthority(async scope => {
      await diagnostic(scope, family);
      return {
        key, family, inputSchema: z.toJSONSchema(AgentMcpReadinessCallSchema, { io: "input" }),
        outputSchema: z.toJSONSchema(AgentMcpReadinessResultSchema, { io: "input" }),
        originalVersion: AGENT_READINESS_VERSION, wrapperVersionRequired: AGENT_MCP_READINESS_VERSION,
        transport: "erp_execute", requestEncoding: "structured", startupEnabled: true,
        metadataOnly: true, advisoryOnly: true, automaticBusinessExecution: false,
      };
    }, signal);
    return packet("definition", result.authority, result.value);
  }

  async function execute(raw: AgentMcpReadinessCall, signal?: AbortSignal): Promise<AgentMcpPacket> {
    const input = parse(AgentMcpReadinessCallSchema, raw), policy = allowed(input.family);
    const result = await http.withAuthority(async scope => {
      const value = await diagnostic(scope, input.family);
      const startTransport = input.family === "native_v1" ? "original_native_v1" :
        input.family === "native_v3" && policy.allowNativeV3 ? "explicit_native_v3" : "not_registered";
      return AgentMcpReadinessResultSchema.parse({
        version: AGENT_MCP_READINESS_VERSION, family: input.family, contextAuthority: scope.authority,
        diagnostic: value, startupPolicy: policy, startTransport,
        paidSubmissionEnabledByStartup: startTransport !== "not_registered" && policy.allowModelRun,
        advisoryOnly: true, selectedMcpStartInputsChecked: false,
      });
    }, signal);
    return packet("read", result.authority, result.value);
  }

  return { capabilities, toolSchema, execute };
}
