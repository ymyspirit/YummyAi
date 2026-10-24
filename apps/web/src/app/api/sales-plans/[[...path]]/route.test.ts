import { createEntityId } from "@yummyai/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn<typeof fetch>() }));
vi.mock("../../../../server-api", () => ({ apiFetch: apiFetchMock }));
import { GET, POST } from "./route";
const context = (path: string[]) => ({ params: Promise.resolve({ path }) });
const post = (value: unknown, origin = "http://web.test") =>
  new Request("http://web.test/api/sales-plans", {
    method: "POST",
    headers: { origin, "content-type": "application/json", authorization: "browser-supplied" },
    body: JSON.stringify(value),
  });
describe("sales launch authenticated proxy", () => {
  it("forwards bounded package history pagination and an explicit historical download purpose", async () => {
    const id = createEntityId(),
      pack = createEntityId();
    apiFetchMock.mockResolvedValue(Response.json({ ok: true }));
    expect(
      (
        await GET(
          new Request(`http://web.test/api/sales-plans/${id}/launch/delivery?packagePage=3`),
          context([id, "launch", "delivery"]),
        )
      ).status,
    ).toBe(200);
    expect(apiFetchMock.mock.calls.at(-1)![0]).toContain("/launch/delivery?packagePage=3");
    apiFetchMock.mockResolvedValue(
      new Response(new Uint8Array([0x50, 0x4b, 3, 4]), {
        headers: { "content-type": "application/zip" },
      }),
    );
    const file = await GET(
      new Request(
        `http://web.test/api/sales-plans/${id}/launch/delivery/packages/${pack}/export?basis=history`,
      ),
      context([id, "launch", "delivery", "packages", pack, "export"]),
    );
    expect(file.status).toBe(200);
    expect(file.headers.get("cache-control")).toBe("private, no-store");
    expect(apiFetchMock.mock.calls.at(-1)![0]).toContain("/export?basis=history");
    expect(apiFetchMock.mock.calls.at(-1)![1]?.headers).toBeUndefined();
  });
  it("rejects unknown, duplicate and unbounded history/export query values without contacting the API", async () => {
    const id = createEntityId(),
      pack = createEntityId();
    for (const query of [
      "packagePage=0",
      "packagePage=1&packagePage=2",
      "packagePage=2&tenantId=guessed",
      "packagePage=100001",
    ]) {
      expect(
        (
          await GET(
            new Request(`http://web.test/api/sales-plans/${id}/launch/delivery?${query}`),
            context([id, "launch", "delivery"]),
          )
        ).status,
      ).toBe(400);
    }
    expect(
      (
        await GET(
          new Request(
            `http://web.test/api/sales-plans/${id}/launch/delivery/packages/${pack}/export?basis=unsafe`,
          ),
          context([id, "launch", "delivery", "packages", pack, "export"]),
        )
      ).status,
    ).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
  it("keeps reference resolution read-only, strict and server-authenticated", async () => {
    const id = createEntityId(),
      source = createEntityId();
    apiFetchMock.mockResolvedValue(
      Response.json({ planId: id, selection: { researchItemIds: [source] } }),
    );
    expect(
      (await POST(post({ researchItemIds: [source] }), context([id, "reference-options"]))).status,
    ).toBe(200);
    expect(apiFetchMock.mock.calls[0]![0]).toContain(`/v1/sales-plans/${id}/reference-options`);
    expect(apiFetchMock.mock.calls[0]![1]?.headers).toEqual({ "content-type": "application/json" });
    apiFetchMock.mockClear();
    expect(
      (
        await POST(
          post({ researchItemIds: [source], tenantId: createEntityId() }),
          context([id, "reference-options"]),
        )
      ).status,
    ).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
  afterEach(() => vi.unstubAllEnvs());
  it("uses the configured API and server identity for personal production deployments", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("API_BASE_URL", "https://api.example");
    apiFetchMock.mockResolvedValue(Response.json({ options: "synthetic" }));
    const response = await GET(
      new Request("https://erp.example/api/sales-plans/options", {
        headers: { authorization: "untrusted-browser-header" },
      }),
      context(["options"]),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(apiFetchMock).toHaveBeenCalledWith(
      "https://api.example/v1/sales-plans/options",
      expect.objectContaining({
        method: "GET",
        cache: "no-store",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(apiFetchMock.mock.calls[0]![1]?.headers).toBeUndefined();
  });
  it("exposes only bounded preparation commands with pinned revisions", async () => {
    const id = createEntityId(),
      run = createEntityId();
    apiFetchMock.mockResolvedValue(Response.json({ ok: true }));
    const body = { expectedRevision: 1, expectedRunRevision: 2, idempotencyKey: createEntityId() };
    expect((await POST(post(body), context([id, "launch", "agent", run, "resume"]))).status).toBe(
      200,
    );
    expect(
      (
        await POST(
          post({ ...body, tools: ["publish"] }),
          context([id, "launch", "agent", run, "resume"]),
        )
      ).status,
    ).toBe(400);
    expect((await POST(post(body), context([id, "launch", "agent", run, "publish"]))).status).toBe(
      404,
    );
    expect(
      (
        await GET(
          new Request("http://web.test/api/sales-plans"),
          context([id, "launch", "agent", run]),
        )
      ).headers.get("cache-control"),
    ).toBe("private, no-store");
  });
  it("keeps delivery attestation strict and streams only scoped private ZIP downloads", async () => {
    process.env.API_BASE_URL = "http://127.0.0.1:8116";
    const id = createEntityId(),
      pack = createEntityId();
    expect(
      (
        await POST(
          post({
            reviewId: createEntityId(),
            skuId: createEntityId(),
            expectedFingerprint: "a".repeat(64),
            idempotencyKey: createEntityId(),
            tenantId: createEntityId(),
          }),
          context([id, "launch", "delivery", "seal"]),
        )
      ).status,
    ).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
    apiFetchMock.mockResolvedValue(
      new Response(new Uint8Array([80, 75, 3, 4]), {
        headers: {
          "content-type": "application/zip",
          "content-disposition": `attachment; filename="sales-package-${pack}.zip"`,
        },
      }),
    );
    const response = await GET(
      new Request("http://web.test/api/sales-plans"),
      context([id, "launch", "delivery", "packages", pack, "export"]),
    );
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-disposition")).toContain(pack);
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([80, 75, 3, 4]);
    expect(
      (
        await GET(
          new Request("http://web.test/api/sales-plans"),
          context([id, "launch", "delivery", "packages", pack, "admin"]),
        )
      ).status,
    ).toBe(404);
  });
  beforeEach(() => {
    apiFetchMock.mockReset();
    process.env.API_BASE_URL = "http://127.0.0.1:8116";
  });
  it("rejects cross-origin writes, unrelated paths and caller-supplied adoption values", async () => {
    const id = createEntityId(),
      path = [id, "launch", "adopt"];
    expect((await POST(post({}, "http://elsewhere.test"), context(path))).status).toBe(403);
    expect(
      (await GET(new Request("http://web.test/api/sales-plans"), context([id, "launch", "admin"])))
        .status,
    ).toBe(404);
    expect(
      (
        await POST(
          post({
            kind: "creative",
            runId: createEntityId(),
            fields: ["positioning"],
            expectedRevision: 1,
            idempotencyKey: createEntityId(),
            values: { positioning: "forged" },
          }),
          context(path),
        )
      ).status,
    ).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
  it("forwards only validated command fields with server identity and private caching", async () => {
    const id = createEntityId(),
      body = {
        kind: "creative",
        runId: createEntityId(),
        fields: ["positioning"],
        expectedRevision: 1,
        idempotencyKey: createEntityId(),
      };
    apiFetchMock.mockResolvedValue(Response.json({ plan: { revision: 2 } }));
    const response = await POST(post(body), context([id, "launch", "adopt"]));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(apiFetchMock).toHaveBeenCalledWith(
      `http://127.0.0.1:8116/v1/sales-plans/${id}/launch/adopt`,
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
        cache: "no-store",
      }),
    );
    expect(JSON.parse(String(apiFetchMock.mock.calls[0]![1]!.body))).toEqual({
      ...body,
      directionIndex: 0,
    });
  });
  it("preserves actionable version conflicts and sanitizes unexpected upstream failures", async () => {
    const id = createEntityId(),
      request = new Request(`http://web.test/api/sales-plans/${id}/launch`);
    apiFetchMock.mockResolvedValueOnce(
      Response.json({ message: "销售方案已有新版本" }, { status: 409 }),
    );
    expect(await (await GET(request, context([id, "launch"]))).json()).toEqual({
      message: "销售方案已有新版本",
    });
    apiFetchMock.mockResolvedValueOnce(
      Response.json({ message: "private token" }, { status: 500 }),
    );
    expect(await (await GET(request, context([id, "launch"]))).text()).not.toContain("token");
  });
  it("validates visual review and keeps result collection free of generation commands", async () => {
    const id = createEntityId(),
      group = createEntityId(),
      path = [id, "launch", "visuals", group];
    for (const [action, value] of [
      ["collect", { modelId: createEntityId() }],
      [
        "review",
        {
          versionId: createEntityId(),
          decision: "approve",
          checks: { identity: true, shape: true, facts: false, sides: true },
        },
      ],
      ["generate", { requestId: createEntityId(), modelId: createEntityId(), slotKey: "detail" }],
    ] as const)
      expect((await POST(post(value), context([...path, action]))).status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
    apiFetchMock.mockResolvedValue(Response.json({ ok: true }));
    expect((await POST(post({}), context([...path, "collect"]))).status).toBe(200);
    expect(apiFetchMock.mock.calls[0]![0]).toBe(
      `http://127.0.0.1:8116/v1/sales-plans/${id}/launch/visuals/${group}/collect`,
    );
    expect(apiFetchMock.mock.calls[0]![1]?.body).toBe("{}");
  });
});
