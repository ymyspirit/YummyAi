import { createEntityId } from "@yummyai/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn<typeof fetch>() }));
vi.mock("../../../../server-api", () => ({ apiFetch: apiFetchMock }));
import { GET, POST } from "./route";

const context = (path: string[]) => ({ params: Promise.resolve({ path }) });
const post = (body: string, origin = "http://web.test") =>
  new Request("http://web.test/api/ai-assists/runs", {
    method: "POST",
    headers: { origin, "content-type": "application/json", authorization: "browser-supplied" },
    body,
  });
describe("AI assist authenticated proxy", () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    process.env.API_BASE_URL = "http://api.test";
  });

  it("rejects cross-origin writes, oversized bodies, invalid JSON and unrelated routes before authentication forwarding", async () => {
    expect((await POST(post("{}", "http://elsewhere.test"), context(["runs"]))).status).toBe(403);
    expect(
      (await POST(post(JSON.stringify({ prompt: "x".repeat(128 * 1024) })), context(["runs"])))
        .status,
    ).toBe(413);
    expect((await POST(post("{"), context(["runs"]))).status).toBe(400);
    expect(
      (await GET(new Request("http://web.test/api/ai-assists/admin"), context(["..", "admin"])))
        .status,
    ).toBe(404);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("uses server authentication and private cache policy without forwarding caller credentials", async () => {
    apiFetchMock.mockResolvedValue(Response.json({ status: "queued" }));
    const response = await POST(post("{}"), context(["runs"]));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(apiFetchMock).toHaveBeenCalledWith(
      "http://api.test/v1/ai-assists/runs",
      expect.objectContaining({
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json" },
        cache: "no-store",
      }),
    );
  });

  it("serves authenticated image bytes privately and sanitizes unexpected upstream errors", async () => {
    const id = createEntityId();
    const path = ["runs", id, "images", "0"];
    const request = new Request(`http://web.test/api/ai-assists/${path.join("/")}`);
    apiFetchMock.mockResolvedValue(new Response("private image bytes"));
    const image = await GET(request, context(path));
    expect(image.headers.get("content-type")).toBe("image/jpeg");
    expect(image.headers.get("cache-control")).toBe("private, no-store");
    expect(image.headers.get("content-security-policy")).toContain("sandbox");
    expect(await image.text()).toBe("private image bytes");
    apiFetchMock.mockResolvedValue(
      Response.json({ message: "buyer-secret/provider-token" }, { status: 500 }),
    );
    const failure = await GET(request, context(path));
    expect(failure.status).toBe(500);
    expect(await failure.text()).not.toContain("secret");
    expect((await GET(request, context(["runs", id, "images", "16"]))).status).toBe(404);
  });
});
