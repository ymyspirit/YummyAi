import { createHash } from "node:crypto";
import { createEntityId } from "@yummyai/contracts";
import { AGENT_TOOLS_VERSION, AgentToolCallSchema, agentToolDefinitionPayload } from "@yummyai/contracts/ai/agent-tools";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { erpSessionAuthority, type ErpSessionView } from "@yummyai/contracts/auth/session";
import { beforeEach, expect, it, vi } from "vitest";
import { PersonalSessionError } from "../../../../identity/core";
const mocks = vi.hoisted(() => ({ upstream: vi.fn<typeof fetch>(), identity: vi.fn(), current: vi.fn<() => Promise<void>>(), failure: vi.fn() }));
vi.mock("../../../../server-api", () => ({ apiFetch: mocks.upstream }));
vi.mock("../../../../erp-auth/server", () => ({ erpRequestIdentity: mocks.identity, assertErpIdentityCurrent: mocks.current, erpAuthFailure: mocks.failure }));
import { GET, POST } from "./route";
const actor: ErpSessionView = { authenticated: true, canUseErp: true, tenantId: createEntityId(), userId: createEntityId(), dataScope: "tenant",
  displayName: "Synthetic tool operator", organizationName: "Synthetic tools tenant", permissions: ["workflow:read"], permissionScopes: { "workflow:read": "tenant" } };
const authority = erpSessionAuthority(actor), origin = "http://web.test", hash = "a".repeat(64);
const sha = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const context = (path: string) => ({ params: Promise.resolve({ path: [path] }) });
const request = (body: unknown, stamp: string | null = authority, from = origin) => new Request(origin + "/api/agent-tools/call", { method: "POST", body: JSON.stringify(body), headers: { origin: from, "content-type": "application/json", ...(stamp ? { "x-yummyai-context-authority": stamp } : {}) } });
const pin = { contractVersion: "native-harness-v1", executorKey: "erp.agent.tools", skill: { key: "erp.agent.tools", version: AGENT_TOOLS_VERSION, checksum: hash }, tools: [{ key: "knowledge.search", version: AGENT_TOOLS_VERSION, checksum: hash }], checksum: hash };
const call = () => AgentToolCallSchema.parse({ version: AGENT_TOOLS_VERSION, tool: "knowledge.search", input: { query: "synthetic", topic: "all", platform: "all", market: "ALL" }, executionContract: pin, definitionChecksum: hash });
const result = () => { const data = { references: [], diagnostics: ["synthetic empty bounded search"], retrievedAt: "2026-10-22T00:00:00.000Z", mode: "keyword", scanned: 0 }; return { version: AGENT_TOOLS_VERSION, callId: createEntityId(), tool: "knowledge.search", data, contextAuthority: authority, definitionChecksum: hash, checkedAt: "2026-10-22T00:00:00.000Z", inputChecksum: sha(call().input), dataChecksum: sha(data), coverage: { kind: "ranked_subset", complete: false, scanned: 0, returned: 0 } }; };
beforeEach(() => { vi.clearAllMocks(); mocks.upstream.mockReset(); mocks.identity.mockResolvedValue({ view: actor }); mocks.current.mockResolvedValue(); mocks.failure.mockImplementation((error: PersonalSessionError) => Response.json({ code: error.code }, { status: error.status })); process.env.API_BASE_URL = "http://api.test"; });

it("rejects foreign origin, caller tenant query, missing authority and command dispatch before upstream", async () => {
  expect((await POST(request(call(), authority, "http://foreign.test"), context("call"))).status).toBe(403);
  expect((await GET(new Request(origin + "/api/agent-tools/workspace?tenantId=foreign"), context("workspace"))).status).toBe(400);
  expect((await POST(request(call(), null), context("call"))).status).toBe(409);
  expect((await POST(request({ ...call(), tool: "production.approve" }), context("call"))).status).toBe(400);
  expect(mocks.upstream).not.toHaveBeenCalled();
});
it("keeps an actual native subset, verifies checksum and refuses invented full coverage", async () => {
  const value = result(); mocks.upstream.mockResolvedValueOnce(Response.json(value));
  const response = await POST(request(call()), context("call")); expect(response.status).toBe(200); expect(await response.json()).toEqual(value);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  for (const forged of [{ ...value, inputChecksum: 'b'.repeat(64) }, { ...value, dataChecksum: "b".repeat(64) }, { ...value, coverage: { ...value.coverage, scanned: 1 } }, { ...value, coverage: { ...value.coverage, complete: true } }]) {
    mocks.upstream.mockResolvedValueOnce(Response.json(forged)); expect((await POST(request(call()), context("call"))).status).toBe(502);
  }
});
it("binds the selected definition and exact canonical contract without hidden branches", async () => {
  const selection = { kind: "read" as const, tool: "knowledge.search" as const };
  const payload = agentToolDefinitionPayload({ version: AGENT_TOOLS_VERSION, selection, inputSchema: { type: "object" }, outputSchema: { type: "object" }, effect: "read", execution: "registered_native_reader", limitations: ["synthetic selected schema"] });
  const definition = { ...payload, contextAuthority: authority, available: true, blockReason: null, definitionChecksum: sha(payload) };
  const input = { version: AGENT_TOOLS_VERSION, selection };
  mocks.upstream.mockResolvedValueOnce(Response.json(definition)); expect((await POST(request(input), context("definition"))).status).toBe(200);
  mocks.upstream.mockResolvedValueOnce(Response.json({ ...definition, inputSchema: { type: "array" } })); expect((await POST(request(input), context("definition"))).status).toBe(502);
});
it("reads candidates only from the fixed original owner path and strips private fields", async () => {
  const id = createEntityId(), input = { version: AGENT_TOOLS_VERSION, kind: "creative", scope: "design_batch" };
  mocks.upstream.mockResolvedValueOnce(Response.json([{ id, name: "Original batch", createdAt: "2026-10-22T00:00:00.000Z", status: "queued", privateNotes: "synthetic private notes" }]));
  const response = await POST(request(input), context("objects")); expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ query: input, complete: false, limit: 200, items: [{ id, label: "Original batch · queued" }] });
  expect(mocks.upstream).toHaveBeenLastCalledWith("http://api.test/v1/pod/design-batches", expect.objectContaining({ method: "GET" }));
});
it("discards late private data after personal authority changes", async () => {
  mocks.upstream.mockResolvedValueOnce(Response.json(result())); mocks.current.mockRejectedValueOnce(new PersonalSessionError(409, "authority_changed"));
  const response = await POST(request(call()), context("call")); expect(response.status).toBe(409); expect(await response.json()).toEqual({ code: "authority_changed" });
});
