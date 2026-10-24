import { createEntityId } from "@yummyai/contracts";
import { AgentReadCallSchema, AgentBalancePageViewSchema } from "@yummyai/contracts/ai/agent-read";
import { erpSessionAuthority, type ErpSessionView } from "@yummyai/contracts/auth/session";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PersonalSessionError } from "../../../../identity/core";

const mocks = vi.hoisted(() => ({ upstream: vi.fn<typeof fetch>(), identity: vi.fn(), current: vi.fn<() => Promise<void>>(), failure: vi.fn() }));
vi.mock("../../../../server-api", () => ({ apiFetch: mocks.upstream }));
vi.mock("../../../../erp-auth/server", () => ({ erpRequestIdentity: mocks.identity, assertErpIdentityCurrent: mocks.current, erpAuthFailure: mocks.failure }));
import { GET, POST } from "./route";

const actor: ErpSessionView = { authenticated: true, canUseErp: true, tenantId: createEntityId(), userId: createEntityId(), dataScope: "tenant",
  displayName: "Synthetic read operator", organizationName: "Synthetic metadata tenant", permissions: ["inventory:read", "order:read"],
  permissionScopes: { "inventory:read": "tenant", "order:read": "tenant" } };
const authority = erpSessionAuthority(actor), origin = "http://web.test", hash = "a".repeat(64);
const pin = { contractVersion: "native-harness-v1", executorKey: "erp.agent.read", skill: { key: "erp.agent.read", version: "erp-agent-read-v1", checksum: hash },
  tools: ["orders.exceptions.page", "inventory.balances.page"].map(key => ({ key, version: "erp-agent-read-v1", checksum: hash })), checksum: hash };
const context = (path: string) => ({ params: Promise.resolve({ path: [path] }) });
const input = () => AgentReadCallSchema.parse({ version: "erp-agent-read-v1", executionContract: pin, tool: "inventory.balances.page", input: {} });
const request = (body: unknown, stamp: string | null = authority, requestOrigin = origin) => new Request(origin + "/api/agent-reads/call", {
  method: "POST", headers: { origin: requestOrigin, "content-type": "application/json", ...(stamp ? { "x-yummyai-context-authority": stamp } : {}) }, body: JSON.stringify(body) });
function page() {
  return AgentBalancePageViewSchema.parse({ version: "erp-agent-read-v1", effect: "read", tool: "inventory.balances.page", contextAuthority: authority,
    checkedAt: "2026-10-22T00:00:00.000Z", collectionFingerprint: hash, total: 1, readCount: 1, consistency: "unchanged_collection", complete: true,
    nextCursor: null, query: input().input, items: [{ id: createEntityId(), dimensionKey: "synthetic_dimension", stockItemId: createEntityId(), locationId: createEntityId(), lotId: null,
      unit: "meter", physicalQuantity: "1.000000001", reservedQuantity: "0.000000001", availableQuantity: 1, inTransitQuantity: 0, providerQuantity: 0,
      virtualQuantity: 0, projectionVersion: 1, updatedAt: "2026-10-22T00:00:00.000Z" }] });
}

describe("Personal Agent read proxy", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.upstream.mockReset(); mocks.identity.mockResolvedValue({ view: actor }); mocks.current.mockResolvedValue();
    mocks.failure.mockImplementation((error: PersonalSessionError) => Response.json({ code: error.code }, { status: error.status }));
    process.env.API_BASE_URL = "http://api.test";
  });

  it("requires the exact personal stamp, tenant business bit, same origin and fixed read allowlist", async () => {
    expect((await POST(request(input(), authority, "http://other.test"), context("call"))).status).toBe(403);
    expect((await POST(request({ ...input(), tool: "inventory.recordMovement" }), context("call"))).status).toBe(400);
    expect((await GET(new Request(origin + "/api/agent-reads/workspace?tenantId=other"), context("workspace"))).status).toBe(400);
    expect((await POST(request(input(), null), context("call"))).status).toBe(409);
    const mixed = { ...actor, permissionScopes: { "inventory:read": "self" as const, "order:read": "tenant" as const } };
    mocks.identity.mockResolvedValueOnce({ view: mixed });
    expect((await POST(request(input(), erpSessionAuthority(mixed)), context("call"))).status).toBe(403);
    expect(mocks.upstream).not.toHaveBeenCalled();
  });

  it("forwards exact read input and quantities while refusing substituted, incomplete or repeated output rows", async () => {
    const value = page(); mocks.upstream.mockResolvedValueOnce(Response.json(value));
    const response = await POST(request(input()), context("call")); expect(response.status).toBe(200);
    expect(await response.json()).toEqual(value); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-yummyai-context-authority")).toBe(authority);
    expect(mocks.upstream).toHaveBeenCalledWith("http://api.test/v1/agent-reads/call", expect.objectContaining({ method: "POST", body: JSON.stringify(input()),
      headers: { "content-type": "application/json" }, cache: "no-store" }));
    for (const forged of [{ ...value, query: { ...value.query, stockItemId: createEntityId() } },
      { ...value, total: 2 }, { ...value, items: [...value.items, ...value.items], total: 2, readCount: 2 },
      { ...value, complete: false, nextCursor: "opaque", items: [], total: 2, readCount: 0 }]) {
      mocks.upstream.mockResolvedValueOnce(Response.json(forged));
      expect((await POST(request(input()), context("call"))).status).toBe(502);
    }
    mocks.upstream.mockResolvedValueOnce(Response.json(value, { status: 201 }));
    expect((await POST(request(input()), context("call"))).status).toBe(502);
  });

  it("preserves only recognized conflict codes and rejects a late private result after identity changes", async () => {
    for (const code of ["agent_collection_changed", "authority_changed"] as const) {
      mocks.upstream.mockResolvedValueOnce(Response.json({ code, message: "synthetic-private-upstream-detail" }, { status: 409 }));
      const response = await POST(request(input()), context("call")); expect(response.status).toBe(409);
      const value = await response.json(); expect(value.code).toBe(code); expect(JSON.stringify(value)).not.toContain("synthetic-private-upstream-detail");
    }
    mocks.upstream.mockResolvedValueOnce(Response.json(page()));
    mocks.current.mockRejectedValueOnce(new PersonalSessionError(409, "authority_changed"));
    const denied = await POST(request(input()), context("call")); expect(denied.status).toBe(409);
    expect(await denied.json()).toEqual({ code: "authority_changed" });
  });
});
