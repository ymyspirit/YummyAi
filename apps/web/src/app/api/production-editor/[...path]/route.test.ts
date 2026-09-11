import { createEntityId } from "@yummyai/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn<typeof fetch>() }));
vi.mock("../../../../server-api", () => ({ apiFetch: apiFetchMock }));
import { DELETE, GET, POST } from "./route";

describe("production editor authenticated proxy", () => {
  beforeEach(() => { apiFetchMock.mockReset(); process.env.API_BASE_URL = "http://api.test"; });
  const context = (path: string[]) => ({ params: Promise.resolve({ path }) });
  it("only proxies same-origin POST refinement with bounded JSON and private responses", async () => {
    const id = createEntityId(), asset = createEntityId(), path = ["projects", id, "images", asset, "refine"];
    const url = `http://web.test/api/production-editor/${path.join("/")}`;
    expect((await GET(new Request(url), context(path))).status).toBe(404);
    expect((await POST(new Request(url, { method: "POST", headers: { origin: "http://elsewhere.test", "content-type": "application/json" }, body: "{}" }), context(path))).status).toBe(403);
    expect((await POST(new Request(url, { method: "POST", headers: { origin: "http://web.test", "content-type": "application/json" }, body: JSON.stringify({ mask: "x".repeat(3 * 1024 * 1024) }) }), context(path))).status).toBe(413);
    expect(apiFetchMock).not.toHaveBeenCalled();
    apiFetchMock.mockResolvedValue(Response.json({ engine: "vitmatte-small" }));
    const response = await POST(new Request(url, { method: "POST", headers: { origin: "http://web.test", "content-type": "application/json" }, body: "{}" }), context(path));
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
  it("passes versioned saves through server authentication without forwarding browser credentials", async () => {
    const id = createEntityId();
    apiFetchMock.mockResolvedValue(Response.json({ saved: true }));
    const body = JSON.stringify({ expectedVersionId: createEntityId(), document: {} });
    const response = await POST(new Request(`http://web.test/api/production-editor/projects/${id}/versions`, { method: "POST", headers: { origin: "http://web.test", "content-type": "application/json", authorization: "browser-supplied" }, body }), context(["projects", id, "versions"]));
    expect(response.status).toBe(200);
    expect(apiFetchMock).toHaveBeenCalledWith(new URL(`http://api.test/v1/production-editor/projects/${id}/versions`), expect.objectContaining({ method: "POST", body, headers: { "content-type": "application/json" }, cache: "no-store" }));
  });
  it("rejects cross-origin writes, deletes, and unrelated upstream routes", async () => {
    const id = createEntityId();
    const request = new Request(`http://web.test/api/production-editor/projects/${id}`, { method: "DELETE", headers: { origin: "https://elsewhere.test" } });
    expect((await DELETE(request, context(["projects", id]))).status).toBe(403);
    expect((await GET(new Request("http://web.test/api/production-editor/admin"), context(["..", "admin"]))).status).toBe(404);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
  it("caps streamed document uploads before forwarding and does not trust absent content-length", async () => {
    const response = await POST(new Request("http://web.test/api/production-editor/projects", { method: "POST", headers: { origin: "http://web.test", "content-type": "application/json" }, body: '"' + "x".repeat(2 * 1024 * 1024) + '"' }), context(["projects"]));
    expect(response.status).toBe(413);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
  it("preserves original-media selection and private binary headers", async () => {
    const project = createEntityId(), asset = createEntityId();
    apiFetchMock.mockResolvedValue(new Response("opaque private bytes", { headers: { "content-type": "image/tiff", "content-disposition": "attachment; filename=artwork.tiff" } }));
    const response = await GET(new Request(`http://web.test/api/production-editor/projects/${project}/images/${asset}?kind=original`), context(["projects", project, "images", asset]));
    expect(apiFetchMock).toHaveBeenCalledWith(new URL(`http://api.test/v1/production-editor/projects/${project}/images/${asset}?kind=original`), expect.anything());
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-type")).toBe("image/tiff");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(await response.text()).toBe("opaque private bytes");
  });
  it("validates pinned version queries and redacts upstream diagnostics", async () => {
    const project = createEntityId();
    expect((await GET(new Request(`http://web.test/api/production-editor/projects/${project}?versionId=invalid`), context(["projects", project]))).status).toBe(400);
    apiFetchMock.mockResolvedValue(Response.json({ message: "buyer name and private object key" }, { status: 422 }));
    const response = await GET(new Request(`http://web.test/api/production-editor/projects/${project}`), context(["projects", project]));
    expect(response.status).toBe(422);
    expect(await response.text()).not.toContain("buyer");
  });
});
