import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn<typeof fetch>() }));
vi.mock("../../../../server-api", () => ({ apiFetch: apiFetchMock }));
import { GET, POST } from "./route";
const supplier = "019f0000-0000-7000-8000-000000000001", record = "019f0000-0000-7000-8000-000000000002";
const context = (path: string[]) => ({ params: Promise.resolve({ path }) });
describe("ShipOS private proxy", () => {
  beforeEach(() => { apiFetchMock.mockReset(); vi.stubEnv("API_BASE_URL", "http://api.test"); });
  afterEach(() => vi.unstubAllEnvs());
  it("rejects billing actions, arbitrary forwarding and caller-selected tenancy", async () => {
    for (const action of ["createOrder", "getLabels", "refund", "cancel", "orderList", "proxy", "https:"]) {
      expect((await POST(new Request(`http://web.test/api/shipos/${supplier}/${action}`, { method: "POST" }), context([supplier, action]))).status).toBe(404);
    }
    expect((await GET(new Request(`http://web.test/api/shipos/${supplier}?tenantId=other`), context([supplier]))).status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
  it("requires same-origin JSON, caps input and safely reports an upstream failure", async () => {
    const request = (origin: string, body = "{}") => new Request(`http://web.test/api/shipos/${supplier}/sync`, { method: "POST", headers: { origin, "content-type": "application/json" }, body });
    expect((await POST(request("http://foreign.test"), context([supplier, "sync"]))).status).toBe(403);
    expect((await POST(request("http://web.test", JSON.stringify({ payload: "a".repeat(17000) })), context([supplier, "sync"]))).status).toBe(413);
    expect(apiFetchMock).not.toHaveBeenCalled();
    apiFetchMock.mockRejectedValue(new Error("private upstream secret"));
    const response = await POST(request("http://web.test"), context([supplier, "sync"]));
    expect(response.status).toBe(502); expect(await response.text()).not.toContain("secret"); expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });
  it("keeps label downloads private and in the authenticated API boundary", async () => {
    apiFetchMock.mockResolvedValue(new Response("%PDF-1.7 synthetic", { headers: { "content-type": "application/pdf", "content-disposition": "attachment; filename=synthetic.pdf" } }));
    const path = [supplier, "records", record, "label"];
    const response = await GET(new Request(`http://web.test/api/shipos/${path.join("/")}`), context(path));
    expect(apiFetchMock.mock.calls[0]?.[0]).toBe(`http://api.test/v1/sourcing/suppliers/${supplier}/shipos/records/${record}/label`);
    expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(response.headers.get("content-disposition")).toContain("attachment");
  });
});
