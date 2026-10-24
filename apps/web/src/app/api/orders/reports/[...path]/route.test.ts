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

  it("allows explicit background recovery while keeping it same-origin and credential-free", async () => {
    apiFetchMock.mockResolvedValue(Response.json({ queued: 2 }));
    const body = JSON.stringify({ accountId: createEntityId(), batchId: createEntityId() });
    const response = await POST(new Request("http://web.test/api/orders/reports/resume", { method: "POST", headers: { origin: "http://web.test", "content-type": "application/json" }, body }), { params: Promise.resolve({ path: ["resume"] }) });
    expect(response.status).toBe(200);
    expect(apiFetchMock).toHaveBeenCalledWith(new URL("http://api.test/v1/orders/reports/resume"), expect.objectContaining({ body, method: "POST", headers: { "content-type": "application/json" } }));
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

  it("relays only strict import diagnostics while retaining private caching", async () => {
    const diagnostic = { code: "report_headers_missing", missingHeaders: ["order-id", "sku"] };
    apiFetchMock.mockResolvedValue(Response.json(diagnostic, { status: 422 }));
    const response = await POST(importRequest(), { params: Promise.resolve({ path: ["import"] }) });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual(diagnostic);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it.each([
    { message: "secret buyer and URL" },
    { code: "report_columns_mismatch", row: 2, message: "secret buyer and URL" },
    { code: "report_headers_missing", missingHeaders: ["secret buyer"] },
    { code: "secret_internal_code", row: 2 },
  ])("does not relay unexpected fields or source data even on import: %j", async (body) => {
    apiFetchMock.mockResolvedValue(Response.json(body, { status: 422 }));
    const response = await POST(importRequest(), { params: Promise.resolve({ path: ["import"] }) });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ message: "操作未完成，请检查文件或稍后重试。" });
  });

  it("does not relay import diagnostics for unrelated operations or authentication failures", async () => {
    apiFetchMock.mockResolvedValueOnce(Response.json({ code: "report_columns_mismatch", row: 2 }, { status: 422 }));
    const response = await POST(importRequest(), { params: Promise.resolve({ path: ["resume"] }) });
    expect(await response.json()).toEqual({ message: "操作未完成，请检查文件或稍后重试。" });
    apiFetchMock.mockResolvedValueOnce(Response.json({ code: "report_columns_mismatch", row: 2 }, { status: 403 }));
    const denied = await POST(importRequest(), { params: Promise.resolve({ path: ["import"] }) });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ message: "当前账号没有执行此操作的权限。" });
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

  it("forwards only the supported thumbnail flag and keeps the response private", async () => {
    const id = createEntityId(), versionId = createEntityId();
    const path = ["lines", id, "files", "preview-1"];
    const url = `http://web.test/api/orders/reports/lines/${id}/files/preview-1?versionId=${versionId}`;
    const invalid = await GET(new Request(`${url}&thumbnail=large`), { params: Promise.resolve({ path }) });
    expect(invalid.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
    apiFetchMock.mockResolvedValue(new Response("thumbnail", { headers: { "content-type": "image/png" } }));
    const response = await GET(new Request(`${url}&thumbnail=1`), { params: Promise.resolve({ path }) });
    expect(apiFetchMock).toHaveBeenCalledWith(new URL(`http://api.test/v1/orders/reports/lines/${id}/files/preview-1?versionId=${versionId}&thumbnail=1`), expect.objectContaining({ cache: "no-store" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

function importRequest(): Request {
  return new Request("http://web.test/api/orders/reports/import", { method: "POST", headers: { origin: "http://web.test", "content-type": "application/json" }, body: "{}" });
}
