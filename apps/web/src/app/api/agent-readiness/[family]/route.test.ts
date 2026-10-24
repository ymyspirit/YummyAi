import { createEntityId } from "@yummyai/contracts";
import { AGENT_READINESS_VERSION, type AgentReadiness } from "@yummyai/contracts/ai/agent-readiness";
import { erpSessionAuthority, type ErpSessionView } from "@yummyai/contracts/auth/session";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PersonalSessionError } from "../../../../identity/core";

const mocks = vi.hoisted(() => ({ upstream: vi.fn<typeof fetch>(), identity: vi.fn(), current: vi.fn<() => Promise<void>>(), failure: vi.fn() }));
vi.mock("../../../../server-api", () => ({ apiFetch: mocks.upstream }));
vi.mock("../../../../erp-auth/server", () => ({ erpRequestIdentity: mocks.identity, assertErpIdentityCurrent: mocks.current, erpAuthFailure: mocks.failure }));
import { GET, POST } from "./route";

const actor: ErpSessionView = { authenticated: true, canUseErp: true, tenantId: createEntityId(), userId: createEntityId(), dataScope: "tenant",
  displayName: "Synthetic diagnosis operator", organizationName: "Synthetic diagnosis tenant", permissions: ["workflow:read", "workflow:run", "model:configure"],
  permissionScopes: { "workflow:read": "tenant", "workflow:run": "tenant", "model:configure": "tenant" } };
const authority = erpSessionAuthority(actor);
const context = (family = "native_v3") => ({ params: Promise.resolve({ family }) });
const request = (query = "", stamp: string | null = authority) => new Request("http://web.test/api/agent-readiness/native_v3" + query, { headers: stamp ? { "x-yummyai-context-authority": stamp } : {} });
const view = (): AgentReadiness => ({ version: AGENT_READINESS_VERSION, family: "native_v3", contextAuthority: authority, workspaceVersion: "erp-agent-native-v3",
  checkedAt: "2026-10-23T00:00:00.000Z", state: "no_known_blocker", blockers: [], checks: { runPermission: "granted", model: "available", originalCapability: "available", taskBudget: "positive", monthlyBudget: "available", concurrency: "available" },
  canConfigureModels: true, metadataOnly: true, notChecked: ["request_budget", "selected_sources", "provider_connection", "consumer_readiness"], effects: { modelCalls: 0, queueDispatches: 0, budgetReservations: 0, businessWrites: 0 } });

beforeEach(() => {
  vi.clearAllMocks(); mocks.upstream.mockReset(); mocks.identity.mockResolvedValue({ view: actor }); mocks.current.mockResolvedValue();
  mocks.failure.mockImplementation((error: PersonalSessionError) => Response.json({ code: error.code }, { status: error.status }));
  vi.stubEnv("API_BASE_URL", "http://api.test");
});
afterEach(() => vi.unstubAllEnvs());

it("accepts only a fixed family read and an exact current personal authority", async () => {
  expect((await GET(request(), context("shell"))).status).toBe(404);
  expect((await GET(request("?tenantId=another"), context())).status).toBe(400);
  expect((await GET(request("", null), context())).status).toBe(409);
  expect((await POST()).status).toBe(405);
  mocks.identity.mockResolvedValueOnce({ view: { ...actor, permissions: [], permissionScopes: {} } });
  const denied = { ...actor, permissions: [], permissionScopes: {} };
  expect((await GET(request("", erpSessionAuthority(denied)), context())).status).toBe(403);
  expect(mocks.upstream).not.toHaveBeenCalled();
});

it("forwards a metadata-only GET and preserves exact private family-bound output", async () => {
  const value = view(); mocks.upstream.mockResolvedValueOnce(Response.json(value));
  const result = await GET(request(), context());
  expect(result.status).toBe(200); expect(await result.json()).toEqual(value);
  expect(result.headers.get("cache-control")).toBe("private, no-store");
  expect(result.headers.get("x-yummyai-context-authority")).toBe(authority);
  expect(mocks.upstream).toHaveBeenCalledExactlyOnceWith("http://api.test/v1/ai/agent-readiness/native_v3", expect.objectContaining({ method: "GET", cache: "no-store", headers: { "x-yummyai-context-authority": authority } }));
  expect(mocks.upstream.mock.calls[0]![1]).not.toHaveProperty("body");
  expect(mocks.current).toHaveBeenCalledOnce();
});

it("does not require run or configuration permission to explain why a read-only owner is blocked", async () => {
  const reader = { ...actor, permissions: ["workflow:read"], permissionScopes: { "workflow:read": "tenant" as const } }, stamp = erpSessionAuthority(reader);
  mocks.identity.mockResolvedValueOnce({ view: reader });
  mocks.upstream.mockResolvedValueOnce(Response.json({ ...view(), contextAuthority: stamp, state: "blocked", blockers: ["workflow_run_permission_missing"], canConfigureModels: false,
    checks: { ...view().checks, runPermission: "missing", taskBudget: "not_checked", monthlyBudget: "not_checked", concurrency: "not_checked" } }));
  const result = await GET(request("", stamp), context()); expect(result.status).toBe(200);
  expect((await result.json()).blockers).toEqual(["workflow_run_permission_missing"]);
});

it("rejects substituted family, authority, permissive effects, malformed state and extra private data", async () => {
  for (const value of [{ ...view(), family: "loop" }, { ...view(), effects: { ...view().effects, modelCalls: 1 } },
    { ...view(), blockers: ["active_task_limit"] }, { ...view(), credential: "synthetic-private-key" }]) {
    mocks.upstream.mockResolvedValueOnce(Response.json(value)); const result = await GET(request(), context());
    expect(result.status).toBe(502); expect(await result.text()).not.toContain("synthetic-private");
  }
  mocks.upstream.mockResolvedValueOnce(Response.json({ ...view(), contextAuthority: "other-authority" }));
  expect((await GET(request(), context())).status).toBe(409);
  mocks.upstream.mockResolvedValueOnce(Response.json(view(), { headers: { "x-yummyai-context-authority": "other-authority" } }));
  expect((await GET(request(), context())).status).toBe(409);
});

it("rejects late output when the current identity changes without echoing the old metadata", async () => {
  mocks.upstream.mockResolvedValueOnce(Response.json(view())); mocks.current.mockRejectedValueOnce(new PersonalSessionError(409, "authority_changed"));
  const result = await GET(request(), context()); expect(result.status).toBe(409); expect(await result.json()).toEqual({ code: "authority_changed" });
});

it("bounds upstream bodies and rejects non-200 or invalid JSON without retry", async () => {
  for (const response of [new Response("{", { headers: { "content-type": "application/json" } }),
    new Response("x".repeat(512 * 1024 + 1), { headers: { "content-type": "application/json" } }),
    new Response(JSON.stringify(view()), { headers: { "content-type": "text/plain" } }), Response.json(view(), { status: 201 })]) {
    mocks.upstream.mockResolvedValueOnce(response); expect((await GET(request(), context())).status).toBe(502);
  }
  expect(mocks.upstream).toHaveBeenCalledTimes(4);
});

it("retains recognized failure statuses and authority changes while hiding original error bodies", async () => {
  for (const status of [400, 401, 403, 404, 409, 503]) {
    mocks.upstream.mockResolvedValueOnce(Response.json({ code: "private", message: "synthetic-private-organization-details" }, { status }));
    const result = await GET(request(), context()); expect(result.status).toBe(status); expect(await result.text()).not.toContain("synthetic-private");
  }
  mocks.upstream.mockResolvedValueOnce(Response.json({ code: "authority_changed", message: "synthetic-private-detail" }, { status: 409 }));
  expect(await (await GET(request(), context())).json()).toMatchObject({ code: "authority_changed" });
});
