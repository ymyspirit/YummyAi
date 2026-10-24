import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { AgentMcpV2PacketSchema } from "../../packages/contracts/src/ai/agent-mcp-v2.js";
import { requireAgentMcpV2Environment } from "./require-agent-mcp-v2-environment.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url)), serverName = "yummyai_erp_v2";
const owned = path.resolve(root, "tmp/agent-mcp-v2-20261022-7c4e1b92/qa");
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function childPath(value: string) {
  const result = path.resolve(value), relative = path.relative(owned, result);
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "Codex host resources must be owned by this acceptance operation");
  return result;
}
type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout };

/** Uses the installed, unmodified Codex app-server RPC client path. No LLM turn,
 * user global configuration, user Codex account or ordinary ERP is involved. */
export async function openAgentMcpCodexHost(input: { apiUrl: string; profilePath: string; storeDir: string }) {
  requireAgentMcpV2Environment();
  const binary = process.env.E2E_AGENT_MCP_CODEX_BINARY;
  assert.ok(binary && path.isAbsolute(binary) && (await fs.lstat(binary)).isFile(), "Explicit installed Codex binary required");
  const userConfig = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "config.toml");
  const readUserConfigHash = async () => {
    try { return hash(await fs.readFile(userConfig)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  };
  const userConfigBefore = await readUserConfigHash();
  const home = childPath(path.join(owned, "codex-host", randomUUID()));
  childPath(input.profilePath); childPath(input.storeDir);
  await fs.mkdir(home, { recursive: true });
  const portable = (value: string) => value.replaceAll("\\", "/"), quote = (value: string) => JSON.stringify(portable(value));
  const configuration = [
    'model_provider = "isolated_mcp_no_model"', 'model = "gpt-5"', 'check_for_update_on_startup = false',
    '[analytics]', 'enabled = false', '[model_providers.isolated_mcp_no_model]',
    'name = "Isolated MCP protocol acceptance - no model turns"', 'base_url = "http://127.0.0.1:9/v1"',
    'wire_api = "responses"', 'requires_openai_auth = false', 'request_max_retries = 0',
    '[mcp_servers.' + serverName + ']', 'command = ' + quote(process.execPath),
    'args = ["--import", "tsx", "src/main-v2.ts", "--personal-auth", "--allow-native-v3", "--allow-resource=catalog.sku"]',
    'cwd = ' + quote(path.join(root, "apps/agent-mcp")), 'startup_timeout_sec = 120', 'tool_timeout_sec = 120',
    '[mcp_servers.' + serverName + '.env]', 'TSX_DISABLE_CACHE = "1"',
    'YUMMYAI_MCP_ERP_API_URL = ' + quote(input.apiUrl), 'YUMMYAI_MCP_AUTH_PROFILE = ' + quote(input.profilePath),
    'YUMMYAI_MCP_AUTH_STORE_DIR = ' + quote(input.storeDir), "",
  ].join("\n");
  const configPath = path.join(home, "config.toml"); await fs.writeFile(configPath, configuration, { flag: "wx" });
  const environment: Record<string, string> = { CODEX_HOME: home };
  for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP"]) if (process.env[key]) environment[key] = process.env[key]!;
  const process_ = spawn(binary, ["app-server", "--stdio"], { cwd: home, env: environment,
    windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let sequence = 0, stdout = "", closed = false, threadId: string | undefined;
  const pending = new Map<number, Pending>(), stderr = createHash("sha256");
  const evidence = { kind: "actual_installed_codex_cli_isolated_mcp", binarySha256: hash(await fs.readFile(binary)),
    configSha256: hash(configuration), home, pid: process_.pid ?? null, tools: [] as string[], methods: [] as string[],
    modelTurnsRequested: 0, globalConfigBeforeSha256: userConfigBefore, globalConfigModified: false, ordinaryAdopted: false,
    stderrBytes: 0, stderrSha256: "", exited: false, exitCode: null as number | null, forcedKill: false };
  const ended = new Promise<void>(resolve => process_.once("close", code => {
    evidence.exited = true; evidence.exitCode = code;
    for (const value of pending.values()) { clearTimeout(value.timer); value.reject(new Error("codex_host_exited")); }
    pending.clear(); resolve();
  }));
  process_.stderr.on("data", (chunk: Buffer) => { stderr.update(chunk); evidence.stderrBytes += chunk.byteLength; });
  process_.once("error", () => {
    for (const value of pending.values()) { clearTimeout(value.timer); value.reject(new Error("codex_host_spawn_failed")); }
    pending.clear();
  });
  process_.stdin.on("error", () => {});
  process_.stdout.setEncoding("utf8");
  process_.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    if (Buffer.byteLength(stdout, "utf8") > 16 * 1024 * 1024) { process_.kill(); return; }
    for (;;) {
      const end = stdout.indexOf("\n"); if (end < 0) break;
      const line = stdout.slice(0, end); stdout = stdout.slice(end + 1);
      let message: { id?: number; method?: string; result?: unknown; error?: unknown };
      try { message = JSON.parse(line) as typeof message; } catch { process_.kill(); continue; }
      if (typeof message.id === "number" && message.method) {
        process_.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: "Unrequested operation rejected" } }) + "\n");
      } else if (typeof message.id === "number") {
        const request = pending.get(message.id); if (!request) continue;
        clearTimeout(request.timer); pending.delete(message.id);
        if (message.error) request.reject(new Error("codex_host_rpc_failed")); else request.resolve(message.result);
      }
    }
  });
  const rpc = (method: string, params: Record<string, unknown>): Promise<unknown> => {
    assert.ok(["initialize", "thread/start", "mcpServerStatus/list", "mcpServer/tool/call"].includes(method));
    evidence.methods.push(method); const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("codex_host_rpc_timeout")); }, 150_000);
      pending.set(id, { resolve, reject, timer });
      process_.stdin.write(JSON.stringify({ id, method, params }) + "\n", error => {
        if (!error) return; clearTimeout(timer); pending.delete(id); reject(new Error("codex_host_rpc_write_failed"));
      });
    });
  };
  async function close() {
    if (closed) return; closed = true; process_.stdin.end();
    let timer: NodeJS.Timeout | undefined;
    try { await Promise.race([ended, new Promise<void>(resolve => { timer = setTimeout(() => {
      evidence.forcedKill = true; process_.kill(); resolve();
    }, 10_000); })]); } finally { if (timer) clearTimeout(timer); }
    if (!evidence.exited) await ended;
    evidence.stderrSha256 = stderr.digest("hex"); stdout = "";
    evidence.globalConfigModified = (await readUserConfigHash()) !== userConfigBefore;
    assert.equal(evidence.globalConfigModified, false, "User Codex configuration changed during isolated host acceptance");
    assert.ok(evidence.exited && !evidence.forcedKill, "Actual Codex test host did not close gracefully");
  }
  try {
    await rpc("initialize", { clientInfo: { name: "yummyai-actual-mcp-host-acceptance", version: "1" } });
    process_.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
    const started = await rpc("thread/start", { cwd: home, ephemeral: true, approvalPolicy: "never", sandbox: "read-only" }) as { thread: { id: string } };
    assert.equal(typeof started.thread?.id, "string"); threadId = started.thread.id;
    const registry = await rpc("mcpServerStatus/list", { threadId, detail: "toolsAndAuthOnly" }) as {
      data: { name: string; tools: Record<string, { name: string }>; serverInfo?: { version: string } }[]; nextCursor?: string | null };
    assert.equal(registry.nextCursor ?? null, null);
    assert.equal(registry.data.length, 1); const server = registry.data[0]!;
    assert.equal(server.name, serverName);
    if (server.serverInfo) assert.equal(server.serverInfo.version, "erp-agent-mcp-v2");
    evidence.tools = Object.values(server.tools).map(tool => tool.name).sort();
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Codex host initialization and cleanup failed"); }
    throw error;
  }
  return { evidence, close, async call(tool: string, arguments_: Record<string, unknown>) {
    assert.ok(evidence.tools.includes(tool));
    const result = await rpc("mcpServer/tool/call", { threadId, server: serverName, tool, arguments: arguments_ }) as {
      structuredContent?: unknown; isError?: boolean };
    return { packet: AgentMcpV2PacketSchema.parse(result.structuredContent), isError: result.isError === true };
  } };
}
