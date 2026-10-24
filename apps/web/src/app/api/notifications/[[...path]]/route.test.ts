import { createEntityId } from "@yummyai/contracts/common/ids";
import { beforeEach, describe, expect, it, vi } from "vitest";
const { api } = vi.hoisted(() => ({ api: vi.fn<typeof fetch>() }));
vi.mock("../../../../server-api", () => ({ apiFetch: api }));
import { GET, PATCH } from "./route";
const id = createEntityId();
const context = (path: string[] = []) => ({ params: Promise.resolve({ path }) });
const read = (query = "", path: string[] = []) =>
  GET(new Request(`http://web.test/api/notifications${query}`), context(path));
const write = (path: string[], body = "{}", origin = "http://web.test") =>
  PATCH(
    new Request("http://web.test/api/notifications/" + path.join("/"), {
      method: "PATCH",
      headers: { origin, "content-type": "application/json" },
      body,
    }),
    context(path),
  );
beforeEach(() => {
  api.mockReset();
  process.env.API_BASE_URL = "http://api.test";
});
describe("notification inbox boundary", () => {
  it("projects a private paginated inbox with server counts", async () => {
    api.mockResolvedValueOnce(
      Response.json({ items: [], total: 50, unread: 45, nextCursor: id, secret: "private" }),
    );
    const response = await read(`?limit=30&after=${id}&unreadOnly=true`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ items: [], total: 50, unread: 45, nextCursor: id });
    expect(String(api.mock.calls[0]?.[0])).toContain("/v1/notifications/inbox?");
  });
  it.each([
    "?limit=NaN",
    "?limit=0",
    "?limit=101",
    "?unreadOnly=yes",
    "?after=forged",
    "?tenantId=forged",
    "?limit=1&limit=2",
  ])("rejects unsupported scope and queries %s", async (query) => {
    expect((await read(query)).status).toBe(400);
    expect(api).not.toHaveBeenCalled();
  });
  it("requires an allowlisted action, same origin and an empty bounded JSON body", async () => {
    expect((await write(["send"])).status).toBe(404);
    expect((await write([id, "read"], "{}", "https://untrusted.test")).status).toBe(400);
    expect((await write([id, "read"], '{"userId":"forged"}')).status).toBe(400);
    expect((await write(["read-all"], " ".repeat(1025))).status).toBe(413);
    expect(api).not.toHaveBeenCalled();
  });
  it("persists read-all through the authenticated API", async () => {
    api.mockResolvedValueOnce(Response.json({ count: 41, secret: "private" }));
    expect(await (await write(["read-all"])).json()).toEqual({ count: 41 });
    expect(api.mock.calls[0]?.[1]).toMatchObject({ method: "PATCH", body: "{}" });
  });
  it("hides upstream errors and refuses invalid service responses", async () => {
    api.mockResolvedValueOnce(Response.json({ message: "raw private error" }, { status: 403 }));
    const denied = await read();
    expect(denied.status).toBe(403);
    expect(await denied.text()).not.toContain("raw private");
    api.mockResolvedValueOnce(Response.json({ items: [], unread: -1 }));
    expect((await read()).status).toBe(502);
  });
});
