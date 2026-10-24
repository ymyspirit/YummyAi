import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { erpSessionAuthority, type ErpSessionView } from "@yummyai/contracts/auth/session";
import { CreateIntegrationApiClientInputSchema, integrationApiClientRequestCanonical, type IntegrationApiClientView } from "@yummyai/contracts/integration";
import { PersonalSessionError } from "../../../../identity/core";

const mocks = vi.hoisted(() => ({ upstream: vi.fn<typeof fetch>(), identity: vi.fn(), current: vi.fn<() => Promise<void>>(), failure: vi.fn<(error: PersonalSessionError) => Response>() }));
vi.mock("../../../../server-api", () => ({ apiFetch: mocks.upstream }));
vi.mock("../../../../erp-auth/server", () => ({ erpRequestIdentity: mocks.identity, assertErpIdentityCurrent: mocks.current, erpAuthFailure: mocks.failure }));
import { GET, POST } from "./route";

const origin = "http://localhost:3130", base = "http://127.0.0.1:8130/v1/integrations";
const ids = { tenant: "019f0000-0000-7000-8000-000000000001", actor: "019f0000-0000-7000-8000-000000000002",
  client: "019f0000-0000-7000-8000-000000000003", membership: "019f0000-0000-7000-8000-000000000004",
  team: "019f0000-0000-7000-8000-000000000005", other: "019f0000-0000-7000-8000-000000000006" };
const actor: ErpSessionView = { authenticated: true, canUseErp: true, tenantId: ids.tenant, userId: ids.actor,
  displayName: "Synthetic client operator", organizationName: "Synthetic organization", dataScope: "tenant",
  permissions: ["integration:read", "integration:manage", "inventory:read"],
  permissionScopes: { "integration:read": "tenant", "integration:manage": "tenant", "inventory:read": "team" }, teamIds: [ids.team] };
const authority = erpSessionAuthority(actor), at = "2026-10-22T08:00:00.000Z";
const original = () => CreateIntegrationApiClientInputSchema.parse({ label: "Synthetic delegation", scopes: ["inventory:read"], scopeLimits: { "inventory:read": "self" },
  teamIds: [ids.team], expiresAt: null, idempotencyKey: "synthetic-client-original-request" });
function client(): IntegrationApiClientView {
  return { id: ids.client, label: original().label, keyPrefix: `yai_${ids.client}`, scopes: original().scopes, status: "active", expiresAt: null,
    createdAt: at, revokedAt: null, credentialState: "pinned", delegation: { version: "integration-api-delegation-v1", membershipId: ids.membership,
      permissionScopes: original().scopeLimits!, teamIds: original().teamIds!, capturedAt: at,
      requestChecksum: createHash("sha256").update(integrationApiClientRequestCanonical(original())).digest("hex") } };
}
const created = (bearerToken: string | null = null) => ({ contextAuthority: authority, client: client(), bearerToken });
const workspace = () => ({ contextAuthority: authority, clientAdmission: { scopes: [{ scope: "inventory:read", maximumScope: "team" }], teamIds: [ids.team], canManage: true },
  agentCatalog: { contextAuthority: authority, version: "erp-agent-catalog-v1", mcpState: "not_connected", capabilities: [] }, apiClients: [client()], webhookEndpoints: [], webhookEvents: [], webhookDeliveries: [], retentionRuns: [] });
const context = (...path: string[]) => ({ params: Promise.resolve({ path }) });
function request(path: string, input?: unknown, stamp: string | null = authority) {
  return new Request(origin + "/api/integration-clients/" + path, { method: input === undefined ? "GET" : "POST",
    headers: { ...(stamp ? { "x-yummyai-context-authority": stamp } : {}), ...(input === undefined ? {} : { origin, "content-type": "application/json" }) },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
}
beforeEach(() => {
  vi.stubEnv("API_BASE_URL", "http://127.0.0.1:8130");
  mocks.upstream.mockReset(); mocks.identity.mockReset(); mocks.current.mockReset(); mocks.failure.mockReset();
  mocks.identity.mockResolvedValue({ view: actor }); mocks.current.mockResolvedValue(undefined);
  mocks.failure.mockImplementation(error => Response.json({ message: "当前会话需重新核对", code: error.code }, { status: error.status, headers: { "cache-control": "private, no-store" } }));
});
afterEach(() => vi.unstubAllEnvs());

describe("personal integration client transport", () => {
  it("rejects unknown paths, wrong methods, queries, cross-origin and non-JSON input before forwarding", async () => {
    expect((await GET(request("clients"), context("clients"))).status).toBe(404);
    expect((await POST(request("workspace", {}), context("workspace"))).status).toBe(404);
    expect((await GET(request("workspace?limit=10"), context("workspace"))).status).toBe(400);
    expect((await POST(request("clients?x=1&x=2", original()), context("clients"))).status).toBe(400);
    expect((await POST(new Request(origin + "/api/integration-clients/clients", { method: "POST", headers: { origin: "https://other.example", "content-type": "application/json" }, body: JSON.stringify(original()) }), context("clients"))).status).toBe(403);
    expect((await POST(new Request(origin + "/api/integration-clients/clients", { method: "POST", headers: { origin, "content-type": "text/plain" }, body: "{}" }), context("clients"))).status).toBe(415);
    expect((await POST(request("clients", { ...original(), secret: "synthetic-rejected-extra" }), context("clients"))).status).toBe(400);
    expect(mocks.upstream).not.toHaveBeenCalled();
  });

  it("enforces read versus manage and the exact current authority before any owner call", async () => {
    for (const permissions of [["integration:manage"], []]) {
      mocks.identity.mockResolvedValue({ view: { ...actor, permissions } });
      expect((await GET(request("workspace"), context("workspace"))).status).toBe(403);
    }
    mocks.identity.mockResolvedValue({ view: { ...actor, permissions: ["integration:read"] } });
    expect((await POST(request("clients", original()), context("clients"))).status).toBe(403);
    mocks.identity.mockResolvedValue({ view: actor });
    expect((await POST(request("clients", original(), null), context("clients"))).status).toBe(409);
    expect(mocks.upstream).not.toHaveBeenCalled();
  });

  it("rejects scope elevation, unknown teams, missing selected permissions and unbounded input", async () => {
    expect((await POST(request("clients", { ...original(), scopeLimits: { "inventory:read": "tenant" } }), context("clients"))).status).toBe(403);
    expect((await POST(request("clients", { ...original(), teamIds: [ids.other] }), context("clients"))).status).toBe(403);
    expect((await POST(request("clients", { ...original(), scopes: ["finance:read"], scopeLimits: { "finance:read": "self" } }), context("clients"))).status).toBe(403);
    expect((await POST(request("clients", { ...original(), label: "x".repeat(33 * 1024) }), context("clients"))).status).toBe(413);
    expect(mocks.upstream).not.toHaveBeenCalled();
  });

  it("returns a private account-bound workspace only after the late authority check", async () => {
    mocks.upstream.mockResolvedValue(Response.json(workspace()));
    const response = await GET(request("workspace"), context("workspace"));
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-yummyai-context-authority")).toBe(authority);
    expect(await response.json()).toEqual(workspace());
    const call = mocks.upstream.mock.calls[0]!; expect(call[0]).toBe(base + "/workspace");
    expect(new Headers(call[1]?.headers).has("authorization")).toBe(false);
    expect(call[1]?.cache).toBe("no-store"); expect(mocks.current).toHaveBeenCalledOnce();
  });

  it("binds new delegation and one-time credential to the normalized original and accepts a null-credential replay", async () => {
    const oneTime = `yai_${ids.client}.${"S".repeat(43)}`;
    for (const token of [oneTime, null]) {
      mocks.upstream.mockResolvedValueOnce(Response.json(created(token), { status: 201 }));
      const response = await POST(request("clients", { ...original(), label: "  Synthetic delegation  " }), context("clients"));
      expect(response.status).toBe(201); const body = await response.json();
      expect(body.bearerToken === token).toBe(true); expect(body.client.delegation.requestChecksum).toBe(client().delegation!.requestChecksum);
    }
    expect(mocks.upstream.mock.calls.every(([url, options]) => url === base + "/api-clients" && options?.body === JSON.stringify(original()))).toBe(true);
  });

  it("does not release a credential with altered original scope, key prefix, request checksum or target", async () => {
    const mutations = [
      (value: ReturnType<typeof created>) => { value.client.delegation!.requestChecksum = "b".repeat(64); },
      (value: ReturnType<typeof created>) => { value.client.delegation!.permissionScopes["inventory:read"] = "team"; },
      (value: ReturnType<typeof created>) => { value.client.keyPrefix = "yai_wrong_target"; },
      (value: ReturnType<typeof created>) => { value.client.id = ids.other; },
    ];
    for (const mutate of mutations) {
      const value = created(`yai_${ids.client}.${"Q".repeat(43)}`); mutate(value);
      mocks.upstream.mockResolvedValueOnce(Response.json(value, { status: 201 }));
      const response = await POST(request("clients", original()), context("clients"));
      expect(response.status).toBe(502); expect(await response.text()).not.toContain("bearerToken");
    }
  });

  it("binds revoke to its exact target and never treats an active response as a completed revoke", async () => {
    const body = { expectedStatus: "active", reasonCode: "SYNTHETIC_REVOKE", idempotencyKey: "synthetic-revoke-original" };
    mocks.upstream.mockResolvedValueOnce(Response.json({ contextAuthority: authority, client: client() }, { status: 201 }));
    expect((await POST(request(`clients/${ids.client}/revoke`, body), context("clients", ids.client, "revoke"))).status).toBe(502);
    mocks.upstream.mockResolvedValueOnce(Response.json({ contextAuthority: authority, client: { ...client(), status: "revoked", credentialState: "revoked", revokedAt: at } }, { status: 201 }));
    expect((await POST(request(`clients/${ids.client}/revoke`, body), context("clients", ids.client, "revoke"))).status).toBe(201);
    expect(mocks.upstream.mock.lastCall?.[0]).toBe(`${base}/api-clients/${ids.client}/revoke`);
  });

  it("rejects late private success after current permission changes and mismatched response authority", async () => {
    mocks.upstream.mockResolvedValueOnce(Response.json(created(`yai_${ids.client}.${"L".repeat(43)}`), { status: 201 }));
    mocks.current.mockRejectedValueOnce(new PersonalSessionError(409, "authority_changed"));
    const late = await POST(request("clients", original()), context("clients"));
    expect(late.status).toBe(409); expect(await late.text()).not.toContain("bearerToken");
    const other = erpSessionAuthority({ ...actor, userId: ids.other });
    mocks.upstream.mockResolvedValueOnce(Response.json({ ...workspace(), contextAuthority: other }));
    const changed = await GET(request("workspace"), context("workspace"));
    expect(changed.status).toBe(409); expect((await changed.json()).code).toBe("authority_changed");
  });

  it("preserves only known authority conflict codes and short safe upstream failure statuses", async () => {
    for (const [status, raw] of [[409, { code: "authority_changed", message: "synthetic-private-upstream-detail" }],
      [409, { code: "ordinary_conflict", internal: "synthetic-private-upstream-detail" }], [422, { internal: "synthetic-private-upstream-detail" }]] as const) {
      mocks.upstream.mockResolvedValueOnce(Response.json(raw, { status }));
      const response = await POST(request("clients", original()), context("clients"));
      expect(response.status).toBe(status); const text = await response.text();
      expect(text).not.toContain("synthetic-private-upstream-detail");
      expect(text.includes('"code":"authority_changed"')).toBe(status === 409 && "code" in raw && raw.code === "authority_changed");
    }
  });
});
