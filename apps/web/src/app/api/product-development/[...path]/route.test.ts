import { randomUUID } from "node:crypto";
import { createEntityId } from "@yummyai/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { upstream } = vi.hoisted(() => ({ upstream: vi.fn<typeof fetch>() }));
vi.mock("../../../../server-api", () => ({ apiFetch: upstream }));
import { POST } from "./route";
const context = (path: string) => ({ params: Promise.resolve({ path: path.split("/") }) });
const request = (body: unknown, origin = "https://erp.example") =>
  new Request("https://erp.example/api/product-development/channels", {
    method: "POST",
    headers: { origin, "content-type": "application/json", authorization: "untrusted-client" },
    body: JSON.stringify(body),
  });
const input = () => ({
  packageId: createEntityId(),
  accountId: createEntityId(),
  externalSku: "CHANNEL-1",
  externalListingId: "LISTING-1",
  customChoice: {},
  effectiveFrom: "2026-01-01T00:00:00.000Z",
});
describe("channel mapping personal proxy", () => {
  beforeEach(() => {
    vi.stubEnv("API_BASE_URL", "https://api.example");
    upstream.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());
  it("forwards a read-only preflight with server identity and rejects caller authority fields", async () => {
    const body = input();
    upstream.mockResolvedValue(Response.json({ input: body }));
    const response = await POST(request(body), context("channels/preview"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(upstream).toHaveBeenCalledWith(
      "https://api.example/v1/product-development/channels/preview",
      expect.objectContaining({
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      }),
    );
    upstream.mockClear();
    for (const extra of [
      { tenantId: createEntityId() },
      { idempotencyKey: randomUUID() },
      { evidence: "preview must not write" },
    ])
      expect((await POST(request({ ...body, ...extra }), context("channels/preview"))).status).toBe(
        400,
      );
    expect(upstream).not.toHaveBeenCalled();
  });
  it("requires original bind identity and same origin before any upstream mutation", async () => {
    expect((await POST(request(input()), context("channels"))).status).toBe(400);
    const body = {
      ...input(),
      evidence: "Synthetic original record",
      idempotencyKey: randomUUID(),
    };
    expect((await POST(request(body, "https://other.example"), context("channels"))).status).toBe(
      403,
    );
    expect(
      (await POST(request({ ...body, customChoice: { "invalid key": "x" } }), context("channels")))
        .status,
    ).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
    upstream.mockResolvedValue(Response.json({ bindingId: createEntityId() }));
    expect((await POST(request(body), context("channels"))).status).toBe(200);
    expect(JSON.parse(upstream.mock.calls[0]![1]!.body as string).idempotencyKey).toBe(
      body.idempotencyKey,
    );
  });
  it("distinguishes an unconfirmed write from a read failure without exposing upstream content", async () => {
    upstream.mockRejectedValue(Error("private upstream detail"));
    const body = {
      ...input(),
      evidence: "Synthetic original record",
      idempotencyKey: randomUUID(),
    };
    const write = await POST(request(body), context("channels"));
    expect(write.status).toBe(502);
    expect(await write.text()).toContain("结果尚未确认");
    const read = await POST(request(input()), context("channels/preview"));
    expect(read.status).toBe(502);
    expect(await read.text()).not.toContain("private upstream detail");
    upstream.mockResolvedValue(new Response("private upstream failure", { status: 503 }));
    expect(await (await POST(request(body), context("channels"))).text()).toContain("原请求重试");
  });
});
