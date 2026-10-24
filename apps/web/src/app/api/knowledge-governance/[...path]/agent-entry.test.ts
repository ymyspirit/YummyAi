import { randomUUID } from "node:crypto";
import { createEntityId } from "@yummyai/contracts";
import { erpSessionAuthority, type ErpSessionView } from "@yummyai/contracts/auth/session";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PersonalSessionError } from "../../../../identity/core";
const mocks = vi.hoisted(() => ({ upstream: vi.fn<typeof fetch>(), identity: vi.fn(), current: vi.fn<() => Promise<void>>(), failure: vi.fn() }));
vi.mock("../../../../server-api", () => ({ apiFetch: mocks.upstream }));
vi.mock("../../../../erp-auth/server", () => ({ erpRequestIdentity: mocks.identity, assertErpIdentityCurrent: mocks.current, erpAuthFailure: mocks.failure }));
import { GET } from "./route";
const actor: ErpSessionView = { authenticated: true, canUseErp: true, tenantId: createEntityId(), userId: createEntityId(), displayName: "Synthetic chat reader", organizationName: "Synthetic tenant",
  dataScope: "self", permissions: ["workflow:read"], permissionScopes: { "workflow:read": "self" } };
const stamp = erpSessionAuthority(actor), context = { params: Promise.resolve({ path: ["conversations"] }) };
const request = (query = "", authority: string | null = stamp) => new Request("http://web.test/api/knowledge-governance/conversations" + query,
  { headers: authority === null ? {} : { "x-yummyai-context-authority": authority } });
const row = () => ({ scopeId: randomUUID(), question: "Synthetic private original question", updatedAt: "2026-10-22T00:00:00.000Z", modelLabel: "Synthetic model" });
describe("Independent knowledge entry personal conversation reads", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.upstream.mockReset(); mocks.identity.mockResolvedValue({ view: actor }); mocks.current.mockResolvedValue();
    mocks.failure.mockImplementation((error: PersonalSessionError) => Response.json({ code: error.code }, { status: error.status })); process.env.API_BASE_URL = "http://api.test"; });
  it("keeps optional legacy reads but requires exact empty-query current identity and strict unique conversation DTOs on the stamped path", async () => {
    expect((await GET(request("?limit=20"), context)).status).toBe(400);
    expect((await GET(request("", "stale"), context)).status).toBe(409); expect(mocks.upstream).not.toHaveBeenCalled();
    const saved = row(); mocks.upstream.mockResolvedValueOnce(Response.json([saved]));
    const response = await GET(request(), context); expect(response.status).toBe(200); expect(response.headers.get("x-yummyai-context-authority")).toBe(stamp);
    expect(await response.json()).toEqual([saved]);
    for (const rows of [[{ ...row(), fullPrompt: "synthetic-private" }], [saved, saved], Array.from({ length: 21 }, row)]) {
      mocks.upstream.mockResolvedValueOnce(Response.json(rows)); expect((await GET(request(), context)).status).toBe(502);
    }
    mocks.upstream.mockResolvedValueOnce(Response.json([])); expect((await GET(request("", null), context)).status).toBe(200);
  });
  it("rejects invalid UTF8 and late authority loss and masks upstream private errors without adopting any old question", async () => {
    const json = JSON.stringify([row()]), invalidUtf8 = new TextEncoder().encode(json);
    invalidUtf8[json.indexOf("Synthetic private original question")] = 0xff;
    mocks.upstream.mockResolvedValueOnce(new Response(invalidUtf8));
    expect((await GET(request(), context)).status).toBe(502);
    mocks.upstream.mockResolvedValueOnce(Response.json({ message: "synthetic-private-source-error" }, { status: 500 }));
    const error = await GET(request(), context); expect(error.status).toBe(502); expect(await error.text()).not.toContain("synthetic-private-source-error");
    let read = false;
    mocks.upstream.mockResolvedValueOnce(new Response(new ReadableStream({ pull(controller) { read = true; controller.enqueue(new TextEncoder().encode(JSON.stringify([row()]))); controller.close(); } })));
    mocks.current.mockImplementationOnce(async () => { expect(read).toBe(true); throw new PersonalSessionError(409, "authority_changed"); });
    const denied = await GET(request(), context); expect(denied.status).toBe(409); expect(await denied.text()).not.toContain("Synthetic private original question");
  });
});
