import { createEntityId } from "@yummyai/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn<typeof fetch>() }));
vi.mock("../../../../../server-api", () => ({ apiFetch: apiFetchMock }));
import { GET, POST } from "./route";

describe("Amazon report authenticated proxy", () => {
  beforeEach(() => { apiFetchMock.mockReset(); process.env.API_BASE_URL = "http://api.test"; });

  it("forwards import JSON and optimistic version without a browser-supplied token", async () => {
    apiFetchMock.mockResolvedValue(Response.json({ ok: true }));
    const body = JSON.stringify({ expectedVersionId: null });
    const id = createEntityId();
    const response = await POST(new Request(`http://web.test/api/orders/reports/lines/${id}/process`, { method: "POST", headers: { origin: "http://web.test", "content-type": "application/json", authorization: "untrusted" }, body }), { params: Promise.resolve({ path: ["lines", id, "process"] }) });
    expect(response.status).toBe(200);
    expect(apiFetchMock).toHaveBeenCalledWith(new URL(`http://api.test/v1/orders/reports/lines/${id}/process`), expect.objectContaining({ body, method: "POST", headers: { "content-type": "application/json" }, cache: "no-store" }));
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("rejects cross-origin mutations and arbitrary upstream paths", async () => {
    const response = await POST(new Request("http://web.test/api/orders/reports/import", { method: "POST", headers: { origin: "http://evil.test", "content-type": "application/json" }, body: "{}" }), { params: Promise.resolve({ path: ["import"] }) });
    expect(response.status).toBe(403);
    const traversal = await GET(new Request("http://web.test/api/orders/reports/anything"), { params: Promise.resolve({ path: ["..", "marketplace-accounts"] }) });
    expect(traversal.status).toBe(404);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("caps request streams without content length before forwarding", async () => {
    const response = await POST(new Request("http://web.test/api/orders/reports/import", { method: "POST", headers: { origin: "http://web.test", "content-type": "application/json" }, body: '"' + "x".repeat(16 * 1024 * 1024) + '"' }), { params: Promise.resolve({ path: ["import"] }) });
    expect(response.status).toBe(413);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("does not relay upstream protected diagnostic content on errors", async () => {
    apiFetchMock.mockResolvedValue(Response.json({ message: "secret download URL and buyer name" }, { status: 409 }));
    const response = await GET(new Request("http://web.test/api/orders/reports/workspace"), { params: Promise.resolve({ path: ["workspace"] }) });
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain("secret");
  });

  it("streams protected images without caching, with no-sniff and a restrictive CSP", async () => {
    const id = createEntityId();
    apiFetchMock.mockResolvedValue(new Response("image bytes", { headers: { "content-type": "image/jpeg", "content-disposition": 'inline; filename="preview.jpg"' } }));
    const versionId = createEntityId();
    const response = await GET(new Request(`http://web.test/api/orders/reports/lines/${id}/files/preview-1?versionId=${versionId}`), { params: Promise.resolve({ path: ["lines", id, "files", "preview-1"] }) });
    expect(apiFetchMock).toHaveBeenCalledWith(new URL(`http://api.test/v1/orders/reports/lines/${id}/files/preview-1?versionId=${versionId}`), expect.anything());
    expect(await response.text()).toBe("image bytes");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-type")).toBe("image/jpeg");
  });

  it("rejects media requests not pinned to a customization version", async () => {
    const id = createEntityId();
    const response = await GET(new Request(`http://web.test/api/orders/reports/lines/${id}/files/preview-1`), { params: Promise.resolve({ path: ["lines", id, "files", "preview-1"] }) });
    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});
