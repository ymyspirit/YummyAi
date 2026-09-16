import { createEntityId } from "@yummyai/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn<typeof fetch>() }));
vi.mock("../../../../server-api", () => ({ apiFetch: apiFetchMock }));
import { GET, POST } from "./route";

describe("authenticated research handoff proxy", () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    vi.stubEnv("API_BASE_URL", "http://api.test");
  });
  const context = (path: string[]) => ({ params: Promise.resolve({ path }) });
  const request = (path: string, body = "{}", origin = "http://web.test") =>
    new Request(`http://web.test/api/research/${path}`, {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/json",
        authorization: "untrusted-browser-header",
      },
      body,
    });
  it("rejects unrelated routes, foreign origins and oversized bodies before authentication forwarding", async () => {
    expect((await POST(request("admin"), context(["admin"]))).status).toBe(404);
    expect(
      (
        await POST(
          request("creative-sources", "{}", "http://elsewhere.test"),
          context(["creative-sources"]),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await POST(
          request("creative-sources", JSON.stringify({ text: "x".repeat(1024 * 1024) })),
          context(["creative-sources"]),
        )
      ).status,
    ).toBe(413);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
  it("uses server membership for versioned saves and preserves actionable conflicts", async () => {
    const id = createEntityId();
    apiFetchMock.mockResolvedValue(
      Response.json({ message: "研究结论已被更新，请重新读取后合并修改" }, { status: 409 }),
    );
    const response = await POST(request(`${id}/study`), context([id, "study"]));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ message: expect.stringContaining("已被更新") });
    expect(apiFetchMock).toHaveBeenCalledWith(
      `http://api.test/v1/research-items/${id}/study`,
      expect.objectContaining({
        headers: { "content-type": "application/json" },
        cache: "no-store",
      }),
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
  it("preserves only the requested revision query on reads", async () => {
    const id = createEntityId(),
      revision = createEntityId();
    apiFetchMock.mockResolvedValue(Response.json({ revision: null }));
    const response = await GET(
      new Request(`http://web.test/api/research/${id}/study?revision=${revision}&tenantId=caller`),
      context([id, "study"]),
    );
    expect(response.ok).toBe(true);
    expect(apiFetchMock).toHaveBeenCalledWith(
      `http://api.test/v1/research-items/${id}/study?revision=${revision}`,
      expect.objectContaining({ method: "GET" }),
    );
  });
});
