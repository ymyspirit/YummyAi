export type McpConnectionVersion = "v1" | "v2";
export type McpHostFormat = "codex" | "json";

export const MCP_PROJECT_PATH = "<ERP_PROJECT_ABSOLUTE_PATH>";
export const MCP_AUTH_PROFILE_PATH = "<AUTH_PROFILE_ABSOLUTE_PATH>";
export const AGENT_MCP_V2_START_COMMAND =
  "pnpm --filter @yummyai/agent-mcp start:v2 --personal-auth --allow-native-v3";
export const AGENT_MCP_V2_READINESS_START_COMMAND = AGENT_MCP_V2_START_COMMAND +
  " --allow-readiness=loop --allow-readiness=plan --allow-readiness=native_v1 --allow-readiness=native_v2 --allow-readiness=native_v3";
export const MCP_PERSONAL_AUTH_COMMANDS = [
  { id: "login", title: "个人登录", copyLabel: "复制登录命令", command: "pnpm --filter @yummyai/agent-mcp auth login" },
  { id: "status", title: "核对本机登录", copyLabel: "复制登录状态命令", command: "pnpm --filter @yummyai/agent-mcp auth status" },
  { id: "logout", title: "本机退出", copyLabel: "复制退出命令", command: "pnpm --filter @yummyai/agent-mcp auth logout" },
] as const;

/** Public launch examples only. Credentials and local configuration are never read. */
export function agentMcpHostTemplate(version: McpConnectionVersion, format: McpHostFormat): string {
  if (!["v1", "v2"].includes(version) || !["codex", "json"].includes(format))
    throw new Error("mcp_template_unsupported");
  const name = "yummyai_erp_" + version;
  const args = ["--import", "tsx", "src/" + (version === "v2" ? "main-v2.ts" : "main.ts"),
    ...(version === "v2" ? ["--personal-auth", "--allow-native-v3"] : [])];
  const cwd = MCP_PROJECT_PATH + "/apps/agent-mcp";
  const env = version === "v2"
    ? { YUMMYAI_MCP_AUTH_PROFILE: MCP_AUTH_PROFILE_PATH }
    : { YUMMYAI_MCP_ERP_API_URL: "<ERP_API_ORIGIN>" };
  if (format === "json") return JSON.stringify({
    mcpServers: { [name]: { command: "node", args, cwd, env } },
  }, null, 2);
  return [
    "[mcp_servers." + name + "]",
    'command = "node"',
    "args = [" + args.map(value => JSON.stringify(value)).join(", ") + "]",
    "cwd = " + JSON.stringify(cwd),
    ...(version === "v1" ? ['env_vars = ["YUMMYAI_MCP_ERP_ACCESS_TOKEN"]'] : []),
    "",
    "[mcp_servers." + name + ".env]",
    ...Object.entries(env).map(([key, value]) => key + " = " + JSON.stringify(value)),
  ].join("\n");
}
