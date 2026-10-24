import { pathToFileURL } from "node:url";
import { loadAgentMcpAuthProfile } from "./auth/config.js";
import { AgentMcpAuthError } from "./auth/error.js";
import { createPersonalAgentMcpSession } from "./auth/session.js";

export async function agentMcpAuthCli(env: NodeJS.ProcessEnv, args: readonly string[]): Promise<void> {
  if (args.length !== 1 || !["login", "status", "logout"].includes(args[0] ?? ""))
    throw new AgentMcpAuthError("mcp_auth_profile_invalid");
  const profile = await loadAgentMcpAuthProfile(env);
  const session = await createPersonalAgentMcpSession(profile, {
    ...(env.YUMMYAI_MCP_AUTH_STORE_DIR ? { storeDir: env.YUMMYAI_MCP_AUTH_STORE_DIR } : {}),
  });
  const controller = new AbortController(), abort = () => controller.abort();
  process.once("SIGINT", abort); process.once("SIGTERM", abort);
  try {
    if (args[0] === "login") process.stdout.write(JSON.stringify(await session.login({ signal: controller.signal })) + "\n");
    else {
      if (args[0] === "logout") await session.logout();
      process.stdout.write(JSON.stringify(await session.status()) + "\n");
    }
  } finally { process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort); }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await agentMcpAuthCli(process.env, process.argv.slice(2)).catch(error => {
    process.stderr.write((error instanceof AgentMcpAuthError ? error.code : "mcp_auth_login_failed") + "\n");
    process.exitCode = 1;
  });
}
