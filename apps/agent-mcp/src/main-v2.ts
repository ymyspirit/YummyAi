import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { parseAgentMcpV2Config } from "./config-v2.js";
import { createAgentMcpV2Server } from "./server-v2.js";
import { loadAgentMcpAuthProfile } from "./auth/config.js";
import { createPersonalAgentMcpSession } from "./auth/session.js";
import type { AgentMcpCredentialProvider } from "./credential-provider.js";

try {
  const originalArgs = process.argv.slice(2), personal = originalArgs.filter(argument => argument === "--personal-auth");
  if (personal.length > 1) throw new Error("mcp_config_invalid");
  let env = process.env, credentials: AgentMcpCredentialProvider | undefined;
  if (personal.length) {
    if (env.YUMMYAI_MCP_ERP_ACCESS_TOKEN) throw new Error("mcp_config_invalid");
    const profile = await loadAgentMcpAuthProfile(env);
    if (env.YUMMYAI_MCP_ERP_API_URL && env.YUMMYAI_MCP_ERP_API_URL !== profile.apiUrl) throw new Error("mcp_config_invalid");
    const session = await createPersonalAgentMcpSession(profile, { storeDir: env.YUMMYAI_MCP_AUTH_STORE_DIR });
    credentials = session.credentials;
    const lease = await credentials.acquire(AbortSignal.timeout(30_000));
    env = { ...env, YUMMYAI_MCP_ERP_API_URL: profile.apiUrl, YUMMYAI_MCP_ERP_ACCESS_TOKEN: lease.accessToken };
  }
  const config = parseAgentMcpV2Config(env, originalArgs.filter(argument => argument !== "--personal-auth"));
  const handle = serveStdio(() => createAgentMcpV2Server(config, { credentials }), {
    onerror: () => process.stderr.write("mcp_protocol_error\n"),
  });
  let closing = false;
  const close = () => {
    if (closing) return; closing = true;
    void handle.close().catch(() => { process.stderr.write("mcp_close_failed\n"); process.exitCode = 1; });
  };
  process.once("SIGINT", close); process.once("SIGTERM", close);
} catch {
  process.stderr.write("mcp_personal_or_config_invalid\n"); process.exitCode = 1;
}
