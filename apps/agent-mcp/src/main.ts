import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { parseAgentMcpConfig } from "./config.js";
import { createAgentMcpServer } from "./server.js";

try {
  const config = parseAgentMcpConfig(process.env, process.argv.slice(2));
  const handle = serveStdio(() => createAgentMcpServer(config), {
    onerror: () => process.stderr.write("mcp_protocol_error\n"),
  });
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    void handle.close().catch(() => { process.stderr.write("mcp_close_failed\n"); process.exitCode = 1; });
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
} catch {
  process.stderr.write("mcp_config_invalid\n");
  process.exitCode = 1;
}
