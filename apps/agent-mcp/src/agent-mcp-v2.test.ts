import { describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import { createEntityId } from "@yummyai/contracts";
import { AGENT_MCP_TOOL_NAMES, AgentMcpExecuteSchema } from "@yummyai/contracts/ai/agent-mcp";
import { AgentMcpV2NativeExecuteSchema, AgentMcpV2SavedResultSchema, AgentMcpV2UsageSchema } from "@yummyai/contracts/ai/agent-mcp-v2";
import { AGENT_NATIVE_V3_VERSION } from "@yummyai/contracts/ai/agent-native-v3";
import { ErpSessionViewSchema, erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { parseAgentMcpV2Config } from "./config-v2.js";
import { parseAgentMcpConfig } from "./config.js";
import { AgentMcpHttpClient } from "./http-client.js";
import { createAgentMcpV2Server } from "./server-v2.js";

const token = "e30.e30.c3ludGhldGlj", nextToken = "e30.e30.cm90YXRlZA";
const env = { YUMMYAI_MCP_ERP_API_URL: "http://127.0.0.1:8130", YUMMYAI_MCP_ERP_ACCESS_TOKEN: token };
const personal = ErpSessionViewSchema.parse({ authenticated: true, canUseErp: true, userId: createEntityId(), tenantId: createEntityId(), displayName: "Synthetic MCP operator",
  organizationName: "Synthetic MCP tenant", permissions: ["workflow:read", "workflow:run", "inventory:read"], dataScope: "tenant", permissionScopes: {
    "workflow:read": "tenant", "workflow:run": "tenant", "inventory:read": "tenant" }, teamIds: [], teamAuthority: "0".repeat(64) });
const authority = erpSessionAuthority(personal), value = z.object({ contextAuthority: z.string(), accepted: z.boolean() }).strict();
const fetcher = (handler: (url: URL, init?: RequestInit) => Promise<Response>): typeof fetch => (url, init) => handler(new URL(url instanceof Request ? url.url : String(url)), init);

describe("explicit MCP v2 protocol and personal lease boundary", () => {
  it("keeps historical unversioned calls intact and requires an explicit immutable native v3 startup opt-in", () => {
    const original = { operation: "start", id: null, itemId: null, requestJson: "{}" };
    expect(AgentMcpExecuteSchema.parse(original)).toEqual(original);
    expect(AgentMcpV2NativeExecuteSchema.safeParse(original).success).toBe(false);
    const requested = { ...original, version: AGENT_NATIVE_V3_VERSION };
    expect(AgentMcpV2NativeExecuteSchema.parse(requested)).toEqual(requested);
    expect(AgentMcpExecuteSchema.safeParse(requested).success).toBe(false);
    expect(parseAgentMcpV2Config(env, []).allowNativeV3).toBe(false);
    const config = parseAgentMcpV2Config(env, ["--allow-native-v3"]);
    expect(config.allowNativeV3).toBe(true); expect(config.policy.allowModelRun).toBe(false); expect(config.policy.allowPrepare).toBe(false); expect(Object.isFrozen(config)).toBe(true);
    expect(() => parseAgentMcpConfig(env, ["--allow-native-v3"])).toThrow("mcp_config_invalid");
    expect(() => parseAgentMcpV2Config(env, ["--allow-native-v3", "--allow-native-v3"])).toThrow("mcp_config_invalid");
  });

  it("rejects mixed versions arbitrary destinations and business execution while retaining exact original recovery references", () => {
    const id = createEntityId(), itemId = createEntityId();
    for (const raw of [{ version: "erp-agent-native-v2", operation: "start", requestJson: "{}" },
      { version: AGENT_NATIVE_V3_VERSION, operation: "confirm", id, itemId, requestJson: "{}" },
      { version: AGENT_NATIVE_V3_VERSION, operation: "prepare", id, itemId: null, requestJson: "{}" },
      { version: AGENT_NATIVE_V3_VERSION, operation: "start", requestJson: "{}", url: "https://foreign.invalid" }])
      expect(AgentMcpV2NativeExecuteSchema.safeParse(raw).success).toBe(false);
    expect(AgentMcpV2SavedResultSchema.safeParse({ version: AGENT_NATIVE_V3_VERSION, kind: "run", id }).success).toBe(true);
    expect(AgentMcpV2SavedResultSchema.safeParse({ version: "erp-agent-native-v2", kind: "run", id }).success).toBe(false);
    expect(AgentMcpV2SavedResultSchema.safeParse({ version: AGENT_NATIVE_V3_VERSION, kind: "command", id, originalChecksum: "a".repeat(64) }).success).toBe(false);
    expect(AgentMcpV2SavedResultSchema.safeParse({ version: AGENT_NATIVE_V3_VERSION, kind: "request_receipt_from_request", requestJson: "{}" }).success).toBe(true);
    expect(AgentMcpV2SavedResultSchema.safeParse({ version: AGENT_NATIVE_V3_VERSION, kind: "request_receipt_from_request", requestJson: "{}", requestId: crypto.randomUUID() }).success).toBe(false);
    expect(AgentMcpV2UsageSchema.safeParse({ version: AGENT_NATIVE_V3_VERSION, id, organization: true }).success).toBe(false);
  });

  it("uses one acquired credential for the complete original HTTP fence and never silently refreshes or retries a submitted401", async () => {
    let acquired = 0, assertions = 0, posts = 0;
    const tokens: boolean[] = [];
    const client = new AgentMcpHttpClient(parseAgentMcpV2Config(env, ["--allow-native-v3"]), fetcher(async (url, init) => {
      tokens.push(new Headers(init?.headers).get("authorization") === "Bearer " + nextToken);
      if (url.pathname === "/v1/identity/session") return Response.json(personal);
      posts++; return Response.json({ code: "synthetic_session_expired", private: token }, { status: 401 });
    }), { acquire: async () => { acquired++; return { accessToken: nextToken, assertCurrent: async () => { assertions++; } }; } });
    await expect(client.withAuthority(scope => scope.request("POST", "/v1/agent-native-v3/runs", value, {
      submitted: true, recovery: { requestId: crypto.randomUUID(), requestChecksum: "b".repeat(64) }, body: {} }))).rejects.toMatchObject({ code: "mcp_identity_required", status: 401 });
    expect(acquired).toBe(1); expect(posts).toBe(1); expect(tokens.every(Boolean)).toBe(true); expect(assertions).toBeGreaterThanOrEqual(3);
  });

  it("discards a completed private result if the same fixed personal grant is revoked during original owner I O", async () => {
    let live = true, acquired = 0;
    const client = new AgentMcpHttpClient(parseAgentMcpV2Config(env, ["--allow-native-v3"]), fetcher(async url => {
      if (url.pathname === "/v1/identity/session") return Response.json(personal);
      live = false; return Response.json({ contextAuthority: authority, accepted: true });
    }), { acquire: async () => { acquired++; return { accessToken: nextToken, assertCurrent: async () => { if (!live) throw new Error("SYNTHETIC_VAULT_SECRET_do_not_echo"); } }; } });
    let failure: unknown;
    try { await client.withAuthority(scope => scope.request("GET", "/v1/agent-native-v3/runs/" + createEntityId(), value)); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "mcp_identity_required", status: 401 }); expect(String(failure).includes("SYNTHETIC_VAULT_SECRET")).toBe(false); expect(acquired).toBe(1);
  });

  it("retains only original recovery references when a submitted201 has the wrong authority despite unchanged personal sessions", async () => {
    let posts = 0; const recovery = { version: AGENT_NATIVE_V3_VERSION, kind: "request_receipt", requestId: crypto.randomUUID(), requestChecksum: "d".repeat(64) };
    const client = new AgentMcpHttpClient(parseAgentMcpV2Config(env, ["--allow-native-v3"]), fetcher(async url => {
      if (url.pathname === "/v1/identity/session") return Response.json(personal);
      posts++; return Response.json({ contextAuthority: "SYNTHETIC_OTHER_AUTHORITY", accepted: true }, { status: 201 });
    }));
    let failure: unknown;
    try { await client.withAuthority(scope => scope.request("POST", "/v1/agent-native-v3/runs", value, { body: {}, status: 201, submitted: true, recovery })); }
    catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "mcp_authority_changed", recovery }); expect(posts).toBe(1);
    expect(JSON.stringify(failure).includes("SYNTHETIC_OTHER_AUTHORITY")).toBe(false); expect(JSON.stringify(failure).includes("accepted")).toBe(false);
  });

  it("advertises exactly five SDK tools and keeps malformed explicit version requests out of ERP without echoing caller secrets", async () => {
    let posts = 0;
    const server = createAgentMcpV2Server(parseAgentMcpV2Config(env, []), { fetch: fetcher(async (url, init) => {
      if (init?.method === "POST") posts++; if (url.pathname === "/v1/identity/session") return Response.json(personal);
      return Response.json({ code: "synthetic_not_found" }, { status: 404 });
    }) });
    const client = new Client({ name: "synthetic-v2-schema-acceptance", version: "1" }), [left, right] = InMemoryTransport.createLinkedPair();
    await server.connect(right); await client.connect(left);
    try {
      expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual(Object.values(AGENT_MCP_TOOL_NAMES).sort());
      const sentinel = "SYNTHETIC_V2_SECRET_do_not_echo";
      for (const arguments_ of [{ version: AGENT_NATIVE_V3_VERSION, operation: "confirm", requestJson: "{}", [sentinel]: sentinel },
        { version: AGENT_NATIVE_V3_VERSION, operation: "start", requestJson: "{" + sentinel }]) {
        let actual: unknown; try { actual = await client.callTool({ name: AGENT_MCP_TOOL_NAMES.execute, arguments: arguments_ }); }
        catch (error) { actual = error instanceof Error ? error.message : "protocol_error"; }
        expect(JSON.stringify(actual).includes(sentinel)).toBe(false);
      }
      expect(posts).toBe(0);
    } finally { await client.close(); await server.close(); }
  });
});
