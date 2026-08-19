import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiFetchMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn<typeof fetch>(),
}));

vi.mock("../../../../server-api", () => ({ apiFetch: apiFetchMock }));

import { PATCH } from "./route";

describe("research product type proxy", () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    process.env.API_BASE_URL = "http://api.test";
  });

  it("forwards the explicit batch assignment and preserves the API response", async () => {
    apiFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ cascaded: 2, updated: 1 }), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
    );
    const body = JSON.stringify({
      itemIds: ["019f7600-0000-7000-8000-000000000001"],
      productTypeName: "Mugs",
    });

    const response = await PATCH(
      new Request("http://web.test/v1/research-items/product-type", {
        body,
        headers: { "content-type": "application/json" },
        method: "PATCH",
      }),
    );

    expect(apiFetchMock).toHaveBeenCalledWith(
      "http://api.test/v1/research-items/product-type",
      expect.objectContaining({ body, method: "PATCH" }),
    );
    await expect(response.json()).resolves.toEqual({ cascaded: 2, updated: 1 });
  });

  it("passes through permission failures for the explicit Web error state", async () => {
    apiFetchMock.mockResolvedValue(
      Response.json({ message: "Forbidden" }, { status: 403 }),
    );

    const response = await PATCH(
      new Request("http://web.test/v1/research-items/product-type", {
        body: JSON.stringify({
          itemIds: ["019f7600-0000-7000-8000-000000000001"],
          productTypeName: null,
        }),
        method: "PATCH",
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ message: "Forbidden" });
  });
});
