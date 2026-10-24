import { createEntityId } from "@yummyai/contracts/common/ids";
import { Permission } from "@yummyai/authz/permissions";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { beforeEach, describe, expect, it, vi } from "vitest";
const { api, identity, current } = vi.hoisted(() => ({
  api: vi.fn<typeof fetch>(), identity: vi.fn(), current: vi.fn(),
}));
vi.mock("../../../../server-api", () => ({ apiFetch: api }));
vi.mock("../../../../erp-auth/server", () => ({
  erpRequestIdentity: identity,
  assertErpIdentityCurrent: current,
  erpAuthFailure: (error: { status: number; code: string }) => Response.json(
    { message: "Current personal access unavailable", code: error.code }, { status: error.status },
  ),
}));
import { GET } from "./route";
const view = {
  userId: "019f0000-0000-7000-8000-000000000001",
  tenantId: "019f0000-0000-7000-8000-000000000002",
  permissions: [Permission.ListingRead], dataScope: "self" as const,
};
const authority = erpSessionAuthority(view);
const request = () =>
  new Request("https://erp.example/api/listings/unused", {
    headers: {
      authorization: "untrusted-browser-header",
      "x-yummyai-context-authority": authority,
    },
  });
const context = (listingId = createEntityId()) => ({ params: Promise.resolve({ listingId }) });
describe("Listing object read boundary", () => {
  beforeEach(() => {
    api.mockReset();
    identity.mockReset().mockResolvedValue({ view, authority: "a".repeat(64) });
    current.mockReset().mockResolvedValue(undefined);
    process.env.API_BASE_URL = "https://api.example";
  });
  it("uses current personal ListingRead and an exact bodyless object check without forwarding browser credentials", async () => {
    const id = createEntityId();
    const body = { listing: { id, ownerUserId: view.userId, status: "draft" }, version: { id: createEntityId() } };
    api.mockResolvedValueOnce(Response.json(body)).mockResolvedValueOnce(new Response(null));
    const response = await GET(request(), context(id));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(body);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-yummyai-context-authority")).toBe(authority);
    expect(api).toHaveBeenCalledTimes(2);
    expect(api).toHaveBeenNthCalledWith(1,
      `https://api.example/v1/listings/${id}`,
      expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }),
    );
    expect(api).toHaveBeenNthCalledWith(2,
      `https://api.example/v1/listings/${id}`,
      expect.objectContaining({ method: "HEAD", cache: "no-store", signal: expect.any(AbortSignal) }),
    );
    for (const [, init] of api.mock.calls) expect(init).not.toHaveProperty("headers");
    expect(identity).toHaveBeenCalledTimes(1);
    expect(current).toHaveBeenCalledTimes(3);
  });
  it("does not leak upstream private errors or accept arbitrary paths", async () => {
    expect((await GET(request(), context("../orders"))).status).toBe(404);
    expect(api).not.toHaveBeenCalled();
    expect(identity).not.toHaveBeenCalled();
    api.mockResolvedValue(Response.json({ secret: "private upstream data" }, { status: 404 }));
    const response = await GET(request(), context());
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("private upstream data");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(api).toHaveBeenCalledTimes(1);
    expect(api.mock.calls[0]![1]).not.toHaveProperty("method", "HEAD");
    expect(current).toHaveBeenCalledTimes(2);
  });
});
