import { AgentToolKeySchema, type AgentToolKey } from "@yummyai/contracts/ai/agent-tools";
import { AgentPlanCommandKeySchema } from "@yummyai/contracts/ai/agent-plan";
import { AgentResourceKeySchema, type AgentResourceKey } from "@yummyai/contracts/ai/agent-resources";
import type { z } from "zod";

export type AgentMcpCommandKey = z.infer<typeof AgentPlanCommandKeySchema>;
export type AgentMcpPolicy = Readonly<{
  allowModelRun: boolean;
  allowPrepare: boolean;
  maxCostUsd: number;
  allowedReads: readonly AgentToolKey[];
  allowedCommands: readonly Readonly<AgentMcpCommandKey>[];
  allowedResources?: readonly AgentResourceKey[];
  allowFulfillment?: boolean;
}>;
export type AgentMcpConfig = Readonly<{
  apiUrl: string;
  accessToken: string;
  policy: AgentMcpPolicy;
}>;

export class AgentMcpConfigError extends Error {
  readonly code = "mcp_config_invalid";
  constructor() { super("mcp_config_invalid"); this.name = "AgentMcpConfigError"; }
}

function invalid(): never { throw new AgentMcpConfigError(); }

/** A single immutable origin; tool arguments can never supply a destination. */
export function parseAgentMcpApiUrl(raw: string | undefined): string {
  if (!raw || raw !== raw.trim() || raw.includes("@") || raw.includes("?") || raw.includes("#") ||
    [...raw].some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)) invalid();
  let url: URL;
  try { url = new URL(raw); } catch { return invalid(); }
  const hostname = url.hostname.toLowerCase();
  const loopback = hostname === "localhost" || hostname === "[::1]" ||
    /^127(?:\.[0-9]{1,3}){3}$/.test(hostname) && hostname.split(".").every(part => Number(part) <= 255);
  if (url.username || url.password || url.search || url.hash ||
    url.pathname !== "/" || !["https:", "http:"].includes(url.protocol) || url.protocol === "http:" && !loopback) invalid();
  return url.origin;
}

/** Only startup flags may opt into fees or original-command preparation. */
export function parseAgentMcpConfig(env: NodeJS.ProcessEnv, args: readonly string[]): AgentMcpConfig {
  const apiUrl = parseAgentMcpApiUrl(env.YUMMYAI_MCP_ERP_API_URL);
  const accessToken = env.YUMMYAI_MCP_ERP_ACCESS_TOKEN;
  // Shape checking is not JWT authentication. The personal session endpoint is
  // authoritative and rejects model API keys, API clients, and expired tokens.
  if (!accessToken || accessToken.length > 32_768 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(accessToken)) invalid();
  let allowModelRun = false, allowPrepare = false, allowFulfillment = false, cost: number | null = null;
  const seen = new Set<string>(), reads: AgentToolKey[] = [], commands: AgentMcpCommandKey[] = [], resources: AgentResourceKey[] = [];
  for (const arg of args) {
    if (seen.has(arg)) invalid();
    seen.add(arg);
    if (arg === "--allow-model-run") { allowModelRun = true; continue; }
    if (arg === "--allow-prepare") { allowPrepare = true; continue; }
    if (arg === "--allow-fulfillment") { allowFulfillment = true; continue; }
    if (arg.startsWith("--max-cost-usd=")) {
      const raw = arg.slice("--max-cost-usd=".length);
      if (cost !== null || !/^(?:0|[1-9][0-9]{0,2})(?:\.[0-9]{1,6})?$/.test(raw)) invalid();
      cost = Number(raw);
      if (cost <= 0 || cost > 100) invalid();
      continue;
    }
    if (arg.startsWith("--allow-read=")) {
      const parsed = AgentToolKeySchema.safeParse(arg.slice("--allow-read=".length));
      if (!parsed.success || reads.includes(parsed.data)) invalid();
      reads.push(parsed.data); continue;
    }
    if (arg.startsWith("--allow-command=")) {
      const parts = arg.slice("--allow-command=".length).split("/");
      if (parts.length !== 2) invalid();
      const parsed = AgentPlanCommandKeySchema.safeParse({ domain: parts[0], kind: parts[1] });
      if (!parsed.success || commands.some(item => item.domain === parsed.data.domain && item.kind === parsed.data.kind)) invalid();
      commands.push(parsed.data); continue;
    }
    if (arg.startsWith("--allow-resource=")) {
      const parsed = AgentResourceKeySchema.safeParse(arg.slice("--allow-resource=".length));
      if (!parsed.success || resources.includes(parsed.data)) invalid();
      resources.push(parsed.data); continue;
    }
    invalid();
  }
  if (allowModelRun !== (cost !== null) || allowPrepare && !commands.length) invalid();
  return Object.freeze({ apiUrl, accessToken, policy: Object.freeze({
    allowModelRun, allowPrepare, maxCostUsd: cost ?? 0,
    allowedReads: Object.freeze(reads.length ? reads : [...AgentToolKeySchema.options]),
    allowedCommands: Object.freeze(commands.map(item => Object.freeze({ ...item }))),
    ...(resources.length ? { allowedResources: Object.freeze([...resources]) } : {}),
    ...(allowFulfillment ? { allowFulfillment: true } : {}),
  }) });
}
