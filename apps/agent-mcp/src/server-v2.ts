import { McpServer } from "@modelcontextprotocol/server";
import { AGENT_MCP_TOOL_NAMES, AgentMcpSearchSchema, type AgentMcpPacket, type AgentMcpSearch } from "@yummyai/contracts/ai/agent-mcp";
import {
  AGENT_MCP_V2_VERSION,
  AgentMcpV2SavedResultSchema, AgentMcpV2UsageSchema, AgentMcpV2PacketSchema,
} from "@yummyai/contracts/ai/agent-mcp-v2";
import {
  AGENT_MCP_READINESS_VERSION, AgentMcpReadinessV2DefinitionSchema, AgentMcpReadinessV2ExecuteSchema,
} from "@yummyai/contracts/ai/agent-mcp-readiness";
import { type AgentMcpV2Config } from "./config-v2.js";
import { createAgentMcpOperations, safeInput, packet, type AgentMcpServerOptions } from "./server.js";
import { createNativeV3McpOperations } from "./native-v3.js";
import { createAgentMcpReadinessOperations, fixedAgentMcpReadinessFamilies } from "./readiness.js";
import { AgentMcpHttpError } from "./http-client.js";

export function createAgentMcpV2Server(rawConfig: AgentMcpV2Config, options: AgentMcpServerOptions = {}): McpServer {
  if (typeof rawConfig.allowNativeV3 !== "boolean") throw new AgentMcpHttpError("mcp_policy_denied", 403);
  const base = createAgentMcpOperations(rawConfig, options);
  const readinessFamilies = fixedAgentMcpReadinessFamilies(rawConfig.readinessFamilies);
  const config = Object.freeze({ ...base.config, allowNativeV3: rawConfig.allowNativeV3, readinessFamilies });
  const native = createNativeV3McpOperations(config, options);
  const readiness = createAgentMcpReadinessOperations(config, options);
  const server = new McpServer({ name: "yummyai-erp", version: AGENT_MCP_V2_VERSION }, { maxToolInputElements: 10_000 });
  async function dispatch(action: () => Promise<AgentMcpPacket>) {
    const original = await base.dispatch(action);
    const result = AgentMcpV2PacketSchema.parse({ ...original.structuredContent, version: AGENT_MCP_V2_VERSION });
    return { ...original, content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result };
  }
  async function search(input: AgentMcpSearch, signal?: AbortSignal) {
    const extended = config.allowNativeV3 || readinessFamilies.length > 0;
    const old = await base.search(extended ? { ...input, limit: 100 } : input, signal);
    if (!extended) return old;
    const extra: { key: string; kind: "read" | "native"; label: string }[] = [];
    if (config.allowNativeV3) {
      const current = await native.capabilities(signal);
      if (old.contextAuthority !== current.contextAuthority) throw new AgentMcpHttpError("mcp_authority_changed", 409);
      extra.push(...current.data.entries as { key: string; kind: "native"; label: string }[]);
    }
    if (readinessFamilies.length) {
      const current = await readiness.capabilities(signal);
      if (old.contextAuthority !== current.contextAuthority) throw new AgentMcpHttpError("mcp_authority_changed", 409);
      extra.push(...current.data.entries as { key: string; kind: "read"; label: string }[]);
    }
    const needle = input.query.toLocaleLowerCase();
    const matches = extra.filter(entry => (input.kind === "all" || input.kind === entry.kind) &&
      (entry.key + " " + entry.label).toLocaleLowerCase().includes(needle));
    const entries = [...old.data.entries as Record<string, unknown>[], ...matches];
    const totalMatched = Number(old.data.totalMatched) + matches.length;
    return packet("capabilities", old.contextAuthority, { ...old.data,
      entries: entries.slice(0, input.limit), totalMatched,
      registrySize: Number(old.data.registrySize) + extra.length, complete: totalMatched <= input.limit,
      adapterVersion: AGENT_MCP_V2_VERSION,
      ...(config.allowNativeV3 ? { nativeV3Enabled: true } : {}),
      ...(readinessFamilies.length ? { readinessFamilies: [...readinessFamilies] } : {}) });
  }
  const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  server.registerTool(AGENT_MCP_TOOL_NAMES.search, { description: "Search fixed ERP capabilities. Explicit native-v3 keys preserve all historical native keys. No business execution.",
    inputSchema: safeInput(AgentMcpSearchSchema), outputSchema: AgentMcpV2PacketSchema, annotations: read },
  (input, context) => dispatch(() => search(input, context.mcpReq.signal)));
  server.registerTool(AGENT_MCP_TOOL_NAMES.schema, { description: "Read one exact original schema and its live execution pins. native-v3/start uses a separately versioned request.",
    inputSchema: safeInput(AgentMcpReadinessV2DefinitionSchema), outputSchema: AgentMcpV2PacketSchema, annotations: read },
  (input, context) => dispatch(() => input.key.startsWith("readiness/") ? readiness.toolSchema(input.key, context.mcpReq.signal) :
    input.key.startsWith("native-v3/") ? native.toolSchema(input.key, context.mcpReq.signal) : base.toolSchema(input.key, context.mcpReq.signal)));
  server.registerTool(AGENT_MCP_TOOL_NAMES.execute, { description: "Call one fixed reader or explicitly start/stop/prepare an original task. Native v3 requires its explicit version. No business confirmation. Unknown submissions must use original saved-result recovery without retry.",
    inputSchema: safeInput(AgentMcpReadinessV2ExecuteSchema), outputSchema: AgentMcpV2PacketSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
  (input, context) => dispatch(() => "version" in input ?
    input.version === AGENT_MCP_READINESS_VERSION ? readiness.execute(input, context.mcpReq.signal) : native.execute(input, context.mcpReq.signal) :
    base.execute(input, context.mcpReq.signal)));
  server.registerTool(AGENT_MCP_TOOL_NAMES.savedResult, { description: "Read an original saved task or identifier-only receipt. Explicit versions route to their original owner. Never dispatch, prepare, pay or confirm.",
    inputSchema: safeInput(AgentMcpV2SavedResultSchema), outputSchema: AgentMcpV2PacketSchema, annotations: read },
  (input, context) => dispatch(() => "version" in input ? native.savedResult(input, context.mcpReq.signal) : base.savedResult(input, context.mcpReq.signal)));
  server.registerTool(AGENT_MCP_TOOL_NAMES.usage, { description: "Read a single original task's recorded cost and unknown state. Organization balance is not provided.",
    inputSchema: safeInput(AgentMcpV2UsageSchema), outputSchema: AgentMcpV2PacketSchema, annotations: read },
  (input, context) => dispatch(() => "version" in input ? native.usage(input, context.mcpReq.signal) : base.usage(input, context.mcpReq.signal)));
  return server;
}
