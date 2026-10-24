import { createEntityId } from "@yummyai/contracts";
import { OrderWorkDetailViewSchema } from "@yummyai/contracts/order/workspace";
import { erpSessionAuthority, type ErpSessionView } from "@yummyai/contracts/auth/session";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PersonalSessionError } from "../../../../identity/core";
const mocks = vi.hoisted(() => ({ upstream: vi.fn<typeof fetch>(), identity: vi.fn(), current: vi.fn<() => Promise<void>>(), failure: vi.fn() }));
vi.mock("../../../../server-api", () => ({ apiFetch: mocks.upstream }));
vi.mock("../../../../erp-auth/server", () => ({ erpRequestIdentity: mocks.identity, assertErpIdentityCurrent: mocks.current, erpAuthFailure: mocks.failure }));
import { GET } from "./route";
const actor: ErpSessionView = { authenticated: true, canUseErp: true, tenantId: createEntityId(), userId: createEntityId(), displayName: "Synthetic batch reader", organizationName: "Synthetic tenant",
  dataScope: "tenant", permissions: ["order:read", "order:pii:read"], permissionScopes: { "order:read": "tenant", "order:pii:read": "tenant" } };
const stamp = erpSessionAuthority(actor), id = createEntityId(), context = { params: Promise.resolve({ path: ["lines", id] }) };
const request = (query = "", authority: string | null = stamp) => new Request("http://web.test/api/order-centers/lines/" + id + query,
  { headers: authority === null ? {} : { "x-yummyai-context-authority": authority } });
function detail() { return OrderWorkDetailViewSchema.parse({ line: { id, orderId: createEntityId(), externalOrderId: "Synthetic order", externalLineId: "Synthetic line", accountId: createEntityId(), storeName: "Synthetic store",
  platform: "etsy", skuCode: null, title: "Synthetic original private line", quantity: 1, providerStatus: "paid", sideState: null, placedAt: "2026-10-22T00:00:00.000Z", reportLineId: null,
  preparation: "pending_review", artwork: "not_pushed", proof: "not_required", production: "none", readyQuantity: 0, shippedQuantity: 0, afterSalesCount: 0, printSku: null,
  revision: 0, projectionVersion: 0, held: false, sourceChanged: false, dueAt: null, updatedAt: "2026-10-22T00:00:00.000Z", editorProjectId: null },
  draft: { printProfileVersionId: null, fields: [], images: [], instructions: "", customerApprovalRequired: false, dueAt: null }, report: null, profile: null, assets: [], events: [], versions: [] }); }
describe("Independent batch entry personal order reads", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.upstream.mockReset(); mocks.identity.mockResolvedValue({ view: actor }); mocks.current.mockResolvedValue();
    mocks.failure.mockImplementation((error: PersonalSessionError) => Response.json({ code: error.code }, { status: error.status })); process.env.API_BASE_URL = "http://api.test"; });
  it("keeps legacy reads while binding a stamped detail to the original line and rejecting extra query or DTO data", async () => {
    expect((await GET(request("?tenantId=caller"), context)).status).toBe(400);
    expect((await GET(request("", "stale"), context)).status).toBe(409); expect(mocks.upstream).not.toHaveBeenCalled();
    const value = detail(); mocks.upstream.mockResolvedValueOnce(Response.json(value));
    const response = await GET(request(), context); expect(response.status).toBe(200); expect(response.headers.get("x-yummyai-context-authority")).toBe(stamp);
    expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(await response.json()).toEqual(value);
    for (const corrupt of [{ ...value, hiddenPrompt: "synthetic-private" }, { ...value, line: { ...value.line, id: createEntityId() } }]) {
      mocks.upstream.mockResolvedValueOnce(Response.json(corrupt)); expect((await GET(request(), context)).status).toBe(502);
    }
    mocks.upstream.mockResolvedValueOnce(Response.json(value)); expect((await GET(request("", null), context)).status).toBe(200);
  });
  it("does not echo upstream private errors or return a valid old detail after the current personal authority changes", async () => {
    mocks.upstream.mockResolvedValueOnce(Response.json({ message: "synthetic-private-source-diagnostic" }, { status: 500 }));
    const error = await GET(request(), context); expect(error.status).toBe(502); expect(await error.text()).not.toContain("synthetic-private-source-diagnostic");
    let read = false;
    mocks.upstream.mockResolvedValueOnce(new Response(new ReadableStream({ pull(controller) { read = true; controller.enqueue(new TextEncoder().encode(JSON.stringify(detail()))); controller.close(); } })));
    mocks.current.mockImplementationOnce(async () => { expect(read).toBe(true); throw new PersonalSessionError(409, "authority_changed"); });
    const denied = await GET(request(), context); expect(denied.status).toBe(409); expect(await denied.text()).not.toContain("Synthetic original private line");
  });
});
