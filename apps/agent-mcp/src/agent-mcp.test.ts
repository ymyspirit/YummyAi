import { describe, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import { createEntityId } from "@yummyai/contracts";
import { AgentMcpExecuteSchema, AgentMcpSavedResultSchema, parseAgentMcpCapabilityKey } from "@yummyai/contracts/ai/agent-mcp";
import { ErpSessionViewSchema, erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { parseAgentMcpConfig } from "./config.js";
import { AgentMcpHttpClient, AgentMcpHttpError } from "./http-client.js";
import { createAgentMcpServer } from "./server.js";

const token = "e30.e30.c3ludGhldGlj", environment = { YUMMYAI_MCP_ERP_API_URL: "http://127.0.0.1:8130", YUMMYAI_MCP_ERP_ACCESS_TOKEN: token };
const view = ErpSessionViewSchema.parse({ authenticated: true, canUseErp: true, userId: createEntityId(), tenantId: createEntityId(),
  displayName: "Synthetic operator", organizationName: "Synthetic tenant", permissions: ["workflow:read", "inventory:read"], dataScope: "tenant",
  permissionScopes: { "workflow:read": "tenant", "inventory:read": "tenant" }, teamIds: [], teamAuthority: "0".repeat(64) });
const authority = erpSessionAuthority(view), output = z.object({ contextAuthority: z.string(), value: z.string(), missing: z.null() }).strict();
function transport(handler: (url: URL, input: RequestInit | undefined) => Promise<Response>): typeof fetch {
  return (input, init) => handler(new URL(input instanceof Request ? input.url : String(input)), init);
}

describe("personal ERP MCP immutable startup and bounded HTTP boundary", () => {
  it("defaults to read-only and freezes explicitly selected paid prepare limits without accepting destinations or secret-bearing arguments", () => {
    const defaults = parseAgentMcpConfig(environment, []);
    expect(defaults.policy).toEqual({ allowModelRun: false, allowPrepare: false, maxCostUsd: 0,
      allowedReads: ["orders.exceptions.page", "inventory.balances.page", "knowledge.search", "creative.history", "factory.capacity"], allowedCommands: [] });
    const args = ["--allow-model-run", "--max-cost-usd=1.000000", "--allow-read=inventory.balances.page", "--allow-command=finance/bill_record", "--allow-prepare"];
    const selected = parseAgentMcpConfig(environment, args); args.length = 0;
    expect(selected.policy).toEqual({ allowModelRun: true, allowPrepare: true, maxCostUsd: 1,
      allowedReads: ["inventory.balances.page"], allowedCommands: [{ domain: "finance", kind: "bill_record" }] });
    expect([selected, selected.policy, selected.policy.allowedReads, selected.policy.allowedCommands, selected.policy.allowedCommands[0]].every(Object.isFrozen)).toBe(true);
    for (const flags of [["--allow-model-run"], ["--max-cost-usd=1"], ["--allow-prepare"], ["--allow-model-run", "--max-cost-usd=0.0000001"],
      ["--allow-model-run", "--max-cost-usd=100.000001"], ["--allow-read=inventory.balances.page", "--allow-read=inventory.balances.page"], ["--url=https://foreign.invalid"]])
      expect(() => parseAgentMcpConfig(environment, flags)).toThrow("mcp_config_invalid");
    for (const url of ["http://foreign.invalid", "https://user:synthetic@example.invalid", "https://example.invalid/v1", "https://example.invalid/?token=synthetic", "file:///private", "https://example.invalid/#secret"])
      expect(() => parseAgentMcpConfig({ ...environment, YUMMYAI_MCP_ERP_API_URL: url }, [])).toThrow("mcp_config_invalid");
  });

  it("identifies only registered definitions and exact existing references with no arbitrary URL SQL shell or business confirmation operation", () => {
    expect(parseAgentMcpCapabilityKey("read/knowledge.search")).toEqual({ kind: "read", tool: "knowledge.search" });
    expect(parseAgentMcpCapabilityKey("command/finance/bill_record")).toEqual({ kind: "command", command: { domain: "finance", kind: "bill_record" } });
    for (const key of ["native/confirm", "command/finance/pay", "https://foreign.invalid", "read/../inventory", "shell/exec"])
      expect(() => parseAgentMcpCapabilityKey(key)).toThrow();
    const id = createEntityId(), valid = { operation: "prepare", id, itemId: createEntityId(), requestJson: "{}" };
    expect(AgentMcpExecuteSchema.parse(valid)).toEqual(valid);
    for (const raw of [{ ...valid, itemId: null }, { ...valid, operation: "confirm" }, { ...valid, url: "https://foreign.invalid" },
      { ...valid, sql: "select 1" }, { ...valid, requestJson: "x".repeat(1_048_577) }]) expect(AgentMcpExecuteSchema.safeParse(raw).success).toBe(false);
    expect(AgentMcpSavedResultSchema.safeParse({ kind: "command", id, originalChecksum: "a".repeat(64), url: "https://foreign.invalid" }).success).toBe(false);
  });

  it("sends one original JSON request to the fixed origin and verifies personal authority before and after the full response", async () => {
    const calls: Array<{ path: string; method: string }> = [];
    const client = new AgentMcpHttpClient(parseAgentMcpConfig(environment, []), transport(async (url, init) => {
      expect(url.origin).toBe(environment.YUMMYAI_MCP_ERP_API_URL); expect(init?.redirect).toBe("error"); expect(init?.credentials).toBe("omit");
      expect(new Headers(init?.headers).get("authorization") === "Bearer " + token).toBe(true);
      calls.push({ path: url.pathname, method: init?.method ?? "GET" });
      if (url.pathname === "/v1/identity/session") return Response.json(view);
      expect(JSON.parse(String(init?.body))).toEqual({ quantity: "1.000000001", missing: null });
      expect(new Headers(init?.headers).get("x-yummyai-context-authority")).toBe(authority);
      return Response.json({ contextAuthority: authority, value: "1.000000001", missing: null });
    }));
    const result = await client.withAuthority(scope => scope.request("POST", "/v1/agent-tools/call", output, { body: { quantity: "1.000000001", missing: null } }));
    expect(result).toEqual({ authority, value: { contextAuthority: authority, value: "1.000000001", missing: null } });
    expect(calls).toEqual([{ path: "/v1/identity/session", method: "GET" }, { path: "/v1/agent-tools/call", method: "POST" }, { path: "/v1/identity/session", method: "GET" }]);
  });

  it("rejects a late result after actual transport authority changes instead of returning the already-read private body", async () => {
    let reads = 0;
    const client = new AgentMcpHttpClient(parseAgentMcpConfig(environment, []), transport(async url => {
      if (url.pathname === "/v1/identity/session") return Response.json(++reads === 1 ? view : { ...view, teamAuthority: "1".repeat(64) });
      return Response.json({ contextAuthority: authority, value: "SYNTHETIC_PRIVATE_FIELD", missing: null });
    }));
    await expect(client.withAuthority(scope => scope.request("GET", "/v1/agent-native/runs/" + createEntityId(), output))).rejects.toMatchObject({ code: "mcp_authority_changed" });
    expect(reads).toBe(2);
  });

  it("never retries an uncertain submitted POST and exposes only its fixed original request identifiers", async () => {
    let posts = 0; const recovery = { requestId: crypto.randomUUID(), requestChecksum: "b".repeat(64) };
    const client = new AgentMcpHttpClient(parseAgentMcpConfig(environment, []), transport(async url => {
      if (url.pathname === "/v1/identity/session") return Response.json(view);
      posts++; throw new Error("Synthetic upstream body and bearer must not escape " + token);
    }));
    let error: unknown;
    try { await client.withAuthority(scope => scope.request("POST", "/v1/agent-native/runs", output, { body: {}, submitted: true, recovery })); }
    catch (value) { error = value; }
    expect(error).toBeInstanceOf(AgentMcpHttpError); expect(error).toMatchObject({ code: "mcp_submission_unknown", recovery });
    expect(String(error).includes(token)).toBe(false); expect(String(error).includes("Synthetic upstream body")).toBe(false); expect(posts).toBe(1);
  });

  it("rejects oversized or invalid UTF8 JSON and pre-cancelled reads without returning partial success or starting a submission", async () => {
    for (const response of [() => new Response("x".repeat(8 * 1024 * 1024 + 1), { headers: { "content-type": "application/json" } }),
      () => new Response(new Uint8Array([0xc3, 0x28]), { headers: { "content-type": "application/json" } }), () => new Response("{}", { headers: { "content-type": "text/plain" } })]) {
      const client = new AgentMcpHttpClient(parseAgentMcpConfig(environment, []), transport(async url => url.pathname === "/v1/identity/session" ? Response.json(view) : response()));
      await expect(client.withAuthority(scope => scope.request("GET", "/v1/agent-native/runs/" + createEntityId(), output))).rejects.toMatchObject({ code: "mcp_response_invalid" });
    }
    let requests = 0; const aborted = new AbortController(); aborted.abort();
    const client = new AgentMcpHttpClient(parseAgentMcpConfig(environment, []), transport(async () => { requests++; return Response.json(view); }));
    await expect(client.withAuthority(async () => "never", aborted.signal)).rejects.toMatchObject({ code: "mcp_cancelled" }); expect(requests).toBe(0);
  });

  it("keeps known-tool invalid property names and invalid original JSON out of actual SDK error responses", async () => {
    let requests = 0;
    const server = createAgentMcpServer(parseAgentMcpConfig(environment, []), { fetch: transport(async () => { requests++; return Response.json(view); }) });
    const sdk = new Client({ name: "synthetic-in-memory-mcp-validation", version: "1" }), [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await sdk.connect(clientTransport);
    const sentinel = "SYNTHETIC_SECRET_PROPERTY_must_not_echo";
    try {
      for (const input of [{ operation: "read", requestJson: "{}", [sentinel]: sentinel }, { operation: "read", requestJson: "{" + sentinel }]) {
        let result: unknown;
        try { result = await sdk.callTool({ name: "erp_execute", arguments: input }); }
        catch (error) { result = error instanceof Error ? error.message : "unexpected_protocol_failure"; }
        const safe = JSON.stringify(result); expect(safe.includes(sentinel)).toBe(false); expect(safe.includes("mcp_input_invalid")).toBe(true);
      }
      expect(requests).toBe(0);
    } finally { await sdk.close(); await server.close(); }
  });

  it("distinguishes the declared120second deadline from caller cancellation and releases unread early-rejected bodies", async () => {
    const earlyHeaders: Array<Record<string, string>> = [{ "content-type": "text/plain" }, { "content-type": "application/json", "content-length": String(8 * 1024 * 1024 + 1) }];
    for (const headers of earlyHeaders) {
      let cancelled = 0;
      const response = new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled++; } }), { headers });
      const client = new AgentMcpHttpClient(parseAgentMcpConfig(environment, []), transport(async url => url.pathname === "/v1/identity/session" ? Response.json(view) : response));
      await expect(client.withAuthority(scope => scope.request("GET", "/v1/agent-native/runs/" + createEntityId(), output))).rejects.toMatchObject({ code: "mcp_response_invalid" });
      expect(cancelled).toBe(1);
    }
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(milliseconds => {
      expect(milliseconds).toBe(120_000); const controller = new AbortController(); setTimeout(() => controller.abort(), milliseconds); return controller.signal;
    });
    try {
      for (const mode of ["deadline", "caller"] as const) {
        const caller = new AbortController();
        const client = new AgentMcpHttpClient(parseAgentMcpConfig(environment, []), transport(async (url, init) => {
          init?.signal?.throwIfAborted(); if (url.pathname === "/v1/identity/session") return Response.json(view);
          return new Promise<Response>((_accept, reject) => init!.signal!.addEventListener("abort", () => reject(new DOMException("Synthetic aborted response", "AbortError")), { once: true }));
        }));
        const failure = client.withAuthority(scope => scope.request("GET", "/v1/agent-native/runs/" + createEntityId(), output), caller.signal).catch(error => error as unknown);
        await vi.advanceTimersByTimeAsync(0);
        if (mode === "caller") caller.abort(); else await vi.advanceTimersByTimeAsync(120_000);
        expect(await failure).toMatchObject({ code: mode === "caller" ? "mcp_cancelled" : "mcp_deadline_exceeded" });
      }
    } finally { timeout.mockRestore(); vi.useRealTimers(); }
  });
});
