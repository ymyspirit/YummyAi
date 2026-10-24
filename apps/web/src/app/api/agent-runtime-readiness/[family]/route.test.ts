import { createEntityId } from "@yummyai/contracts";
import { AGENT_NATIVE_V3_VERSION } from "@yummyai/contracts/ai/agent-native-v3";
import { AGENT_RUNTIME_FAMILIES, AGENT_RUNTIME_PRESENCE_VERSION, AGENT_RUNTIME_READINESS_VERSION, type AgentRuntimeReadiness } from "@yummyai/contracts/ai/agent-runtime-readiness";
import { erpSessionAuthority, type ErpSessionView } from "@yummyai/contracts/auth/session";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PersonalSessionError } from "../../../../identity/core";

const mocks = vi.hoisted(() => ({ upstream: vi.fn<typeof fetch>(), identity: vi.fn(), current: vi.fn<() => Promise<void>>(), failure: vi.fn() }));
vi.mock("../../../../server-api", () => ({ apiFetch: mocks.upstream }));
vi.mock("../../../../erp-auth/server", () => ({ erpRequestIdentity: mocks.identity, assertErpIdentityCurrent: mocks.current, erpAuthFailure: mocks.failure }));
import { GET, POST } from "./route";

const actor: ErpSessionView = { authenticated: true, canUseErp: true, tenantId: createEntityId(), userId: createEntityId(), dataScope: "tenant",
  displayName: "Synthetic runtime operator", organizationName: "Synthetic runtime tenant", permissions: ["workflow:read", "workflow:run"],
  permissionScopes: { "workflow:read": "tenant", "workflow:run": "self" } };
const authority = erpSessionAuthority(actor);
const context = (family = "native_v3") => ({ params: Promise.resolve({ family }) });
const request = (query = "", stamp: string | null = authority) => new Request("http://web.test/api/agent-runtime-readiness/native_v3" + query,
  { headers: stamp ? { "x-yummyai-context-authority": stamp } : {} });
const view = (): AgentRuntimeReadiness => ({
  version: AGENT_RUNTIME_READINESS_VERSION, family: "native_v3", contextAuthority: authority,
  presenceVersion: AGENT_RUNTIME_PRESENCE_VERSION, executorVersion: AGENT_NATIVE_V3_VERSION,
  checkedAt: "2026-10-23T00:00:00.000Z", validUntil: "2026-10-23T00:00:00.000Z", validForMs: 0,
  state: "unavailable", checks: { consumer: "unavailable", dispatcher: "unavailable", queue: "open" }, reasons: ["runtime_not_observed"],
  metadataOnly: true, advisoryOnly: true, notChecked: ["request_budget", "selected_sources", "provider_connection", "business_admission"],
  effects: { modelCalls: 0, queueDispatches: 0, budgetReservations: 0, businessWrites: 0 },
});
const upstream = (value: unknown = view(), stamp = authority) => Response.json(value, { headers: { "x-yummyai-context-authority": stamp } });

beforeEach(() => {
  vi.clearAllMocks(); mocks.upstream.mockReset(); mocks.identity.mockResolvedValue({ view: actor }); mocks.current.mockResolvedValue();
  mocks.failure.mockImplementation((error: PersonalSessionError) => Response.json({ code: error.code }, { status: error.status }));
  vi.stubEnv("API_BASE_URL", "http://api.test");
});
afterEach(() => vi.unstubAllEnvs());

it("allows only a fixed-family metadata GET under the exact current personal authority", async () => {
  expect((await GET(request(), context("unknown"))).status).toBe(404);
  expect((await GET(request("?queue=agent-plan"), context())).status).toBe(400);
  expect((await GET(request("", null), context())).status).toBe(409);
  expect((await POST()).status).toBe(405);
  const denied = { ...actor, permissions: [], permissionScopes: {} };
  mocks.identity.mockResolvedValueOnce({ view: denied });
  expect((await GET(request("", erpSessionAuthority(denied)), context())).status).toBe(403);
  expect(mocks.upstream).not.toHaveBeenCalled();
});

it("reads all registered runtime families without changing original workspace or paid transport", async () => {
  const families = Object.keys(AGENT_RUNTIME_FAMILIES) as Array<keyof typeof AGENT_RUNTIME_FAMILIES>;
  expect(families).toEqual(["loop", "plan", "native_v1", "native_v2", "native_v3", "native_v4"]);
  for (const family of families) {
    const value = { ...view(), family, executorVersion: AGENT_RUNTIME_FAMILIES[family].executorVersion };
    mocks.upstream.mockResolvedValueOnce(upstream(value));
    const result = await GET(request(), context(family));
    expect(result.status).toBe(200); expect(await result.json()).toEqual(value);
    expect(result.headers.get("cache-control")).toBe("private, no-store");
    expect(result.headers.get("x-yummyai-context-authority")).toBe(authority);
    expect(mocks.upstream).toHaveBeenLastCalledWith("http://api.test/v1/ai/agent-runtime-readiness/" + family,
      expect.objectContaining({ method: "GET", cache: "no-store", headers: { "x-yummyai-context-authority": authority } }));
    expect(mocks.upstream.mock.calls.at(-1)![1]).not.toHaveProperty("body");
  }
  expect(mocks.current).toHaveBeenCalledTimes(families.length);
  expect(mocks.upstream).toHaveBeenCalledTimes(families.length);
});

it("preserves a read-only user's withheld transport checks without requiring WorkflowRun", async () => {
  const reader = { ...actor, permissions: ["workflow:read"], permissionScopes: { "workflow:read": "tenant" as const } }, stamp = erpSessionAuthority(reader);
  mocks.identity.mockResolvedValueOnce({ view: reader });
  const value = { ...view(), contextAuthority: stamp, state: "not_checked", checks: { consumer: "not_checked", dispatcher: "not_checked", queue: "not_checked" }, reasons: ["workflow_run_permission_missing"] };
  mocks.upstream.mockResolvedValueOnce(upstream(value, stamp));
  const result = await GET(request("", stamp), context()); expect(result.status).toBe(200); expect(await result.json()).toEqual(value);
});

it("rejects mismatched family, authority, forged effects and private extra fields", async () => {
  for (const value of [
    { ...view(), family: "loop", executorVersion: AGENT_RUNTIME_FAMILIES.loop.executorVersion },
    { ...view(), effects: { ...view().effects, budgetReservations: 1 } },
    { ...view(), state: "observed_ready" }, { ...view(), credential: "synthetic-private-detail" },
  ]) {
    mocks.upstream.mockResolvedValueOnce(upstream(value)); const result = await GET(request(), context());
    expect(result.status).toBe(502); expect(await result.text()).not.toContain("synthetic-private");
  }
  mocks.upstream.mockResolvedValueOnce(upstream({ ...view(), contextAuthority: "substituted" }));
  expect((await GET(request(), context())).status).toBe(409);
  mocks.upstream.mockResolvedValueOnce(upstream(view(), "substituted"));
  expect((await GET(request(), context())).status).toBe(409);
});

it("rechecks the live personal identity after the original read and discards late output", async () => {
  mocks.upstream.mockResolvedValueOnce(upstream()); mocks.current.mockRejectedValueOnce(new PersonalSessionError(409, "authority_changed"));
  const result = await GET(request(), context()); expect(result.status).toBe(409); expect(await result.json()).toEqual({ code: "authority_changed" });
});

it("bounds the original body and requires JSON status 200 without retries", async () => {
  for (const response of [
    new Response("{", { headers: { "content-type": "application/json" } }),
    new Response("x".repeat(16 * 1024 + 1), { headers: { "content-type": "application/json" } }),
    new Response(JSON.stringify(view()), { headers: { "content-type": "text/plain" } }),
    new Response(JSON.stringify(view()), { headers: { "content-type": "application/json-malformed", "x-yummyai-context-authority": authority } }),
    Response.json(view(), { status: 201 }),
  ]) {
    mocks.upstream.mockResolvedValueOnce(response); expect((await GET(request(), context())).status).toBe(502);
  }
  expect(mocks.upstream).toHaveBeenCalledTimes(5);
});

it("keeps recognized errors and exact authority changes without echoing transport diagnostics", async () => {
  for (const status of [400, 401, 403, 404, 409, 503]) {
    mocks.upstream.mockResolvedValueOnce(Response.json({ code: "private", message: "synthetic-private-transport" }, { status }));
    const result = await GET(request(), context()); expect(result.status).toBe(status); expect(await result.text()).not.toContain("synthetic-private");
  }
  mocks.upstream.mockResolvedValueOnce(Response.json({ code: "authority_changed", message: "synthetic-private-transport" }, { status: 409 }));
  expect(await (await GET(request(), context())).json()).toMatchObject({ code: "authority_changed" });
});
