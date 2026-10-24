import { describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createEntityId } from "@yummyai/contracts";
import { AGENT_MCP_TOOL_NAMES } from "@yummyai/contracts/ai/agent-mcp";
import { AgentMcpV2PacketSchema } from "@yummyai/contracts/ai/agent-mcp-v2";
import { AGENT_READINESS_VERSION, AgentReadinessFamilySchema, type AgentReadinessFamily } from "@yummyai/contracts/ai/agent-readiness";
import { AGENT_MCP_READINESS_VERSION, AgentMcpReadinessResultSchema } from "@yummyai/contracts/ai/agent-mcp-readiness";
import { ErpSessionViewSchema, erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { parseAgentMcpConfig } from "./config.js";
import { parseAgentMcpV2Config } from "./config-v2.js";
import { createAgentMcpReadinessOperations } from "./readiness.js";
import { createAgentMcpV2Server } from "./server-v2.js";

const token = "e30.e30.c3ludGhldGlj", leased = "e30.e30.Zml4ZWRsZWFzZQ";
const env = { YUMMYAI_MCP_ERP_API_URL: "http://127.0.0.1:8130", YUMMYAI_MCP_ERP_ACCESS_TOKEN: token };
const families = AgentReadinessFamilySchema.options, flags = families.map(family => "--allow-readiness=" + family);
const personal = ErpSessionViewSchema.parse({ authenticated: true, canUseErp: true, userId: createEntityId(), tenantId: createEntityId(),
  displayName: "Synthetic metadata operator", organizationName: "Synthetic metadata tenant", permissions: ["workflow:read", "workflow:run"], dataScope: "tenant",
  permissionScopes: { "workflow:read": "tenant", "workflow:run": "self" }, teamIds: [], teamAuthority: "0".repeat(64) });
const authority = erpSessionAuthority(personal);
function diagnostic(family: AgentReadinessFamily) {
  return { version: AGENT_READINESS_VERSION, family, contextAuthority: authority, workspaceVersion: "original-workspace",
    checkedAt: "2026-10-23T00:00:00.000Z", state: "no_known_blocker", blockers: [],
    checks: { runPermission: "granted", model: "available", originalCapability: "available", taskBudget: "positive", monthlyBudget: "available", concurrency: "available" },
    canConfigureModels: true, metadataOnly: true, notChecked: ["request_budget", "selected_sources", "provider_connection", "consumer_readiness"],
    effects: { modelCalls: 0, queueDispatches: 0, budgetReservations: 0, businessWrites: 0 } };
}
const fetcher = (handler: (url: URL, init?: RequestInit) => Promise<Response>): typeof fetch => (raw, init) => handler(new URL(raw instanceof Request ? raw.url : String(raw)), init);

describe("MCP v2 explicit GET-only readiness startup policy and original lease", () => {
  it("rejects duplicate or unknown startup flags and copies mutable embedding policy without widening old defaults", async () => {
    expect(parseAgentMcpV2Config(env, []).readinessFamilies).toEqual([]);
    for (const args of [["--allow-readiness=loop", "--allow-readiness=loop"], ["--allow-readiness=native_v4"], ["--allow-readiness="], ["--allow-readiness=loop,plan"]])
      expect(() => parseAgentMcpV2Config(env, args)).toThrow("mcp_config_invalid");
    expect(() => parseAgentMcpConfig(env, ["--allow-readiness=loop"])).toThrow("mcp_config_invalid");
    const parsed = parseAgentMcpV2Config(env, flags);
    expect(Object.isFrozen(parsed)).toBe(true); expect(Object.isFrozen(parsed.readinessFamilies)).toBe(true);
    let requests = 0;
    const allowed: AgentReadinessFamily[] = ["loop"], raw = { ...parsed, readinessFamilies: allowed };
    const operations = createAgentMcpReadinessOperations(raw, { fetch: fetcher(async url => {
      requests++; return Response.json(url.pathname === "/v1/identity/session" ? personal : diagnostic("loop"));
    }) });
    allowed.push("native_v3");
    await expect(operations.execute({ version: AGENT_MCP_READINESS_VERSION, family: "native_v3" })).rejects.toMatchObject({ code: "mcp_policy_denied", status: 403 });
    expect(requests).toBe(0);
    const result = AgentMcpReadinessResultSchema.parse((await operations.execute({ version: AGENT_MCP_READINESS_VERSION, family: "loop" })).data);
    expect(result.startupPolicy.allowedFamilies).toEqual(["loop"]);
    expect(result.startupPolicy.allowModelRun).toBe(false); expect(result.startupPolicy.maxCostUsd).toBe(0);
    expect(result.startTransport).toBe("not_registered"); expect(result.paidSubmissionEnabledByStartup).toBe(false);
  });

  it("reads all five fixed family GETs with one acquired token per call and keeps local paid admission independent", async () => {
    const traffic: Array<{ path: string; method: string; correctToken: boolean; hasBody: boolean }> = [];
    let acquired = 0, assertions = 0;
    const operations = createAgentMcpReadinessOperations(parseAgentMcpV2Config(env, flags), {
      credentials: { acquire: async () => { acquired++; return { accessToken: leased, assertCurrent: async () => { assertions++; } }; } },
      fetch: fetcher(async (url, init) => {
        traffic.push({ path: url.pathname, method: init?.method ?? "GET", correctToken: new Headers(init?.headers).get("authorization") === "Bearer " + leased, hasBody: init?.body !== undefined });
        if (url.pathname === "/v1/identity/session") return Response.json(personal);
        const family = AgentReadinessFamilySchema.parse(url.pathname.split("/").at(-1)); return Response.json(diagnostic(family));
      }),
    });
    for (const family of families) {
      const packet = await operations.execute({ version: AGENT_MCP_READINESS_VERSION, family }), value = AgentMcpReadinessResultSchema.parse(packet.data);
      expect(packet.kind).toBe("read"); expect(value.family).toBe(family); expect(value.contextAuthority).toBe(authority);
      expect(value.startTransport).toBe(family === "native_v1" ? "original_native_v1" : "not_registered");
      expect(value.paidSubmissionEnabledByStartup).toBe(false); expect(value.selectedMcpStartInputsChecked).toBe(false);
    }
    expect(acquired).toBe(5); expect(assertions).toBeGreaterThanOrEqual(20);
    expect(traffic.filter(row => row.path !== "/v1/identity/session").map(row => row.path)).toEqual(families.map(family => "/v1/ai/agent-readiness/" + family));
    expect(traffic.every(row => row.method === "GET" && row.correctToken && !row.hasBody)).toBe(true);
    const enabled = createAgentMcpReadinessOperations(parseAgentMcpV2Config(env, [...flags, "--allow-native-v3", "--allow-model-run", "--max-cost-usd=0.000001"]), {
      fetch: fetcher(async url => Response.json(url.pathname === "/v1/identity/session" ? personal : diagnostic("native_v3"))),
    });
    const view = AgentMcpReadinessResultSchema.parse((await enabled.execute({ version: AGENT_MCP_READINESS_VERSION, family: "native_v3" })).data);
    expect(view.startTransport).toBe("explicit_native_v3"); expect(view.paidSubmissionEnabledByStartup).toBe(true);
    expect(view.startupPolicy.maxCostUsd).toBe(0.000001); expect(view.selectedMcpStartInputsChecked).toBe(false);
  });

  it("rejects wrong family, fake effects, wrong status, non-JSON and oversized upstream bodies without echo or retry", async () => {
    const sentinel = "SYNTHETIC_READINESS_SECRET_do_not_echo", good = diagnostic("native_v3");
    const variants = [() => Response.json({ ...good, family: "loop" }),
      () => Response.json({ ...good, effects: { ...good.effects, budgetReservations: 1 } }),
      () => Response.json({ ...good, private: sentinel }), () => Response.json(good, { status: 201 }),
      () => new Response(sentinel, { headers: { "content-type": "text/plain" } }),
      () => Response.json(good, { headers: { "content-length": String(8 * 1024 * 1024 + 1) } })];
    for (const response of variants) {
      let reads = 0;
      const server = createAgentMcpV2Server(parseAgentMcpV2Config(env, ["--allow-readiness=native_v3"]), { fetch: fetcher(async url => {
        if (url.pathname === "/v1/identity/session") return Response.json(personal); reads++; return response();
      }) });
      const client = new Client({ name: "synthetic-readiness-response-test", version: "1" }), [left, right] = InMemoryTransport.createLinkedPair();
      await server.connect(right); await client.connect(left);
      try {
        const actual = await client.callTool({ name: AGENT_MCP_TOOL_NAMES.execute, arguments: { version: AGENT_MCP_READINESS_VERSION, family: "native_v3" } });
        expect(actual.isError).toBe(true); expect(AgentMcpV2PacketSchema.parse(actual.structuredContent).data.code).toBe("mcp_response_invalid");
        expect(JSON.stringify(actual).includes(sentinel)).toBe(false); expect(reads).toBe(1);
      } finally { await client.close(); await server.close(); }
    }
  });

  it("discards a late original diagnostic on exact lease revocation or changed personal authority", async () => {
    for (const mode of ["lease", "authority"] as const) {
      let live = true, acquired = 0, reads = 0;
      const operations = createAgentMcpReadinessOperations(parseAgentMcpV2Config(env, ["--allow-readiness=native_v3"]), {
        credentials: { acquire: async () => { acquired++; return { accessToken: leased, assertCurrent: async () => { if (mode === "lease" && !live) throw new Error("SYNTHETIC_GRANT_SECRET"); } }; } },
        fetch: fetcher(async url => {
          if (url.pathname === "/v1/identity/session") return Response.json(!live && mode === "authority" ? { ...personal, permissions: ["workflow:read"], permissionScopes: { "workflow:read": "tenant" } } : personal);
          reads++; live = false; return Response.json(diagnostic("native_v3"));
        }),
      });
      let failed: unknown;
      try { await operations.execute({ version: AGENT_MCP_READINESS_VERSION, family: "native_v3" }); } catch (error) { failed = error; }
      expect(failed).toMatchObject({ code: mode === "lease" ? "mcp_identity_required" : "mcp_authority_changed" });
      expect(String(failed).includes("SYNTHETIC_GRANT_SECRET")).toBe(false); expect(acquired).toBe(1); expect(reads).toBe(1);
    }
  });

  it("advertises only five official tools and rejects malformed diagnostic inputs before any HTTP with fixed safe errors", async () => {
    let requests = 0;
    const server = createAgentMcpV2Server(parseAgentMcpV2Config(env, ["--allow-readiness=native_v3"]), { fetch: fetcher(async () => { requests++; throw new Error("unexpected_http"); }) });
    const client = new Client({ name: "synthetic-readiness-input-test", version: "1" }), [left, right] = InMemoryTransport.createLinkedPair();
    await server.connect(right); await client.connect(left);
    try {
      expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual(Object.values(AGENT_MCP_TOOL_NAMES).sort());
      const sentinel = "SYNTHETIC_INPUT_SECRET";
      for (const input of [{ version: AGENT_MCP_READINESS_VERSION, family: "native_v4" },
        { version: AGENT_MCP_READINESS_VERSION, family: "native_v3", [sentinel]: sentinel },
        { version: AGENT_MCP_READINESS_VERSION, family: "native_v3", requestJson: sentinel },
        { version: AGENT_MCP_READINESS_VERSION, family: "native_v3", allowedFamilies: ["loop"] }]) {
        let actual: unknown;
        try { actual = await client.callTool({ name: AGENT_MCP_TOOL_NAMES.execute, arguments: input }); }
        catch (error) { actual = error instanceof Error ? error.message : "protocol_error"; }
        expect(JSON.stringify(actual).includes(sentinel)).toBe(false);
        expect(JSON.stringify(actual)).toContain("mcp_input_invalid");
      }
      expect(requests).toBe(0);
    } finally { await client.close(); await server.close(); }
  });
});
