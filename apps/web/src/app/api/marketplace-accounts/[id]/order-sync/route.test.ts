import { createEntityId } from "@yummyai/contracts/common/ids";
import { Permission } from "@yummyai/authz/permissions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PersonalSessionError } from "../../../../../identity/core";
import { executionActor, executionAuthority, executionIds } from "../../../../../features/marketplaces/store-node-execution.test-fixture";
const mocks = vi.hoisted(() => ({ identity: vi.fn(), upstream: vi.fn<typeof fetch>(), current: vi.fn<() => Promise<void>>() }));
vi.mock("../../../../../server-api", () => ({ apiFetch: mocks.upstream }));
vi.mock("../../../../../erp-auth/server", () => ({ erpRequestIdentity: mocks.identity, assertErpIdentityCurrent: mocks.current,
  erpAuthFailure: (error: PersonalSessionError) => Response.json({ code: error.code }, { status: error.status }) }));
import { GET, POST } from "./route";
const origin = "http://localhost:3130", base = `${origin}/api/marketplace-accounts/${executionIds.account}/order-sync`;
const context = { params: Promise.resolve({ id: executionIds.account }) };
const actor = { ...executionActor, permissions: [...executionActor.permissions, Permission.OrderRead, Permission.OrderWrite, Permission.OrderPiiRead] };
const view = { accountId: executionIds.account, version: 1, enabled: true, canManage: true, canEnable: true, supported: true, reason: null, nextRunAt: null, lastRunId: null, activeExecutionId: null, updatedAt: null };
const input = () => ({ requestKey: createEntityId(), expectedVersion: 0, enabled: true });
function request(body?: unknown, from = origin, authority = executionAuthority) {
  return new Request(base, { method: body === undefined ? "GET" : "POST", headers: { origin: from, "content-type": "application/json", "x-yummyai-context-authority": authority },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
beforeEach(() => { vi.stubEnv("API_BASE_URL", "http://127.0.0.1:8130"); mocks.upstream.mockReset(); mocks.current.mockReset().mockResolvedValue(undefined);
  mocks.identity.mockReset().mockResolvedValue({ view: actor, authority: executionAuthority }); });
afterEach(() => vi.unstubAllEnvs());
describe("personal automatic order sync settings", () => {
  it("blocks foreign origins, changed identity, unknown fields and readers from enabling a schedule", async () => {
    expect((await POST(request(input(), "https://other.example"), context)).status).toBe(403);
    expect((await POST(request(input(), origin, "wrong"), context)).status).toBe(409);
    expect((await POST(request({ ...input(), tenantId: executionIds.tenant }), context)).status).toBe(400);
    mocks.identity.mockResolvedValue({ view: { ...actor, permissions: [Permission.StoreRead] }, authority: executionAuthority });
    expect((await POST(request(input()), context)).status).toBe(403); expect(mocks.upstream).not.toHaveBeenCalled();
  });
  it("forwards only the original settings, validates the returned account, and refuses a late authority change", async () => {
    const command = input(); mocks.upstream.mockResolvedValueOnce(Response.json(view));
    const response = await POST(request(command), context);
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.upstream.mock.calls[0]![0]).toBe(`http://127.0.0.1:8130/v1/marketplace-accounts/${executionIds.account}/order-sync`);
    expect(JSON.parse(mocks.upstream.mock.calls[0]![1]!.body as string)).toEqual(command);
    mocks.upstream.mockResolvedValueOnce(Response.json({ ...view, accountId: createEntityId() }));
    expect((await GET(request(), context)).status).toBe(409);
    mocks.upstream.mockResolvedValueOnce(Response.json(view));
    mocks.current.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new PersonalSessionError(409, "authority_changed"));
    expect((await GET(request(), context)).status).toBe(409);
  });
  it("does not expose raw upstream errors or accept unknown settings fields", async () => {
    mocks.upstream.mockResolvedValueOnce(Response.json({ secret: "SYNTHETIC-PRIVATE" }, { status: 500 }));
    const response = await GET(request(), context); expect(response.status).toBe(502); expect(await response.text()).not.toContain("SYNTHETIC-PRIVATE");
    mocks.upstream.mockResolvedValueOnce(Response.json({ ...view, secret: "SYNTHETIC-PRIVATE" }));
    expect((await GET(request(), context)).status).toBe(502);
  });
});
