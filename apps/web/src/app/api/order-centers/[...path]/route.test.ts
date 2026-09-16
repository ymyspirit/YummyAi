import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn<typeof fetch>() }));
vi.mock("../../../../server-api", () => ({ apiFetch: apiFetchMock }));
import { GET, POST } from "./route";

describe("order list proxy recovery", () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    vi.stubEnv("API_BASE_URL", "http://api.test");
  });
  afterEach(() => vi.unstubAllEnvs());
  const context = (path: string[]) => ({ params: Promise.resolve({ path }) });

  it("propagates cancellation of an obsolete list query to the upstream read", async () => {
    const abort = new AbortController();
    apiFetchMock.mockImplementation(async (_url, init) => {
      abort.abort();
      expect(init?.signal?.aborted).toBe(true);
      return Response.json({ items: [] });
    });
    await GET(
      new Request("http://web.test/api/order-centers/workspace?stage=pending_review", {
        signal: abort.signal,
      }),
      context(["workspace"]),
    );
    expect(apiFetchMock.mock.calls[0]?.[0]).toBe(
      "http://api.test/v1/order-centers/workspace?stage=pending_review",
    );
  });

  it("returns a recoverable gateway message without exposing the upstream failure", async () => {
    apiFetchMock.mockRejectedValue(new Error("Private upstream connection details"));
    const response = await GET(
      new Request("http://web.test/api/order-centers/options"),
      context(["options"]),
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ message: "订单服务暂时无法连接，请重试" });
  });

  it("does not replay an order write after an upstream failure", async () => {
    const lineId = "019f0000-0000-7000-8000-000000000001";
    apiFetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const response = await POST(
      new Request(`http://web.test/api/order-centers/lines/${lineId}/actions`, {
        method: "POST",
        headers: { origin: "http://web.test", "content-type": "application/json" },
        body: JSON.stringify({ action: "push", idempotencyKey: "synthetic-only" }),
      }),
      context(["lines", lineId, "actions"]),
    );
    expect(response.status).toBe(502);
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(apiFetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
  });
});
