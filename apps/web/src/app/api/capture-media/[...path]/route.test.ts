import { createEntityId } from "@yummyai/contracts/common/ids";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const { api, storage } = vi.hoisted(() => ({
  api: vi.fn<typeof fetch>(),
  storage: vi.fn<typeof fetch>(),
}));
vi.mock("../../../../server-api", () => ({ apiFetch: api }));
import { GET } from "./route";
const snapshot = createEntityId(),
  media = createEntityId();
const lease = {
  url: "http://storage.test/fixture-bucket/tenant/research/example.png?X-Amz-Signature=synthetic",
  expiresInSeconds: 60,
  mediaType: "image/png",
  byteSize: 4,
  checksumSha256: "a".repeat(64),
};
const read = (path: string[], query = "", headers?: HeadersInit) =>
  GET(new Request(`http://web.test/api/capture-media/${path.join("/")}${query}`, { headers }), {
    params: Promise.resolve({ path }),
  });
beforeEach(() => {
  api.mockReset();
  storage.mockReset();
  vi.stubGlobal("fetch", storage);
  process.env.API_BASE_URL = "http://api.test";
  process.env.S3_ENDPOINT = "http://storage.test";
  process.env.S3_PRIVATE_BUCKET = "fixture-bucket";
});
afterEach(() => vi.unstubAllGlobals());
describe("private capture-media proxy", () => {
  it.each([["invalid"], [snapshot, "not-an-id"], [snapshot, media, "extra"]])(
    "rejects paths outside the fixed boundary %j",
    async (...path) => {
      expect((await read(path)).status).toBe(404);
      expect(api).not.toHaveBeenCalled();
    },
  );
  it("rejects arbitrary sources, repeated cursors, cross-site embedding and multiple byte ranges", async () => {
    expect((await read([snapshot], "?url=https://evil.test")).status).toBe(400);
    expect((await read([snapshot], `?after=${media}&after=${media}`)).status).toBe(400);
    expect((await read([snapshot, media], "", { "sec-fetch-site": "cross-site" })).status).toBe(
      403,
    );
    expect((await read([snapshot, media], "", { range: "bytes=0-1,2-3" })).status).toBe(400);
    expect(api).not.toHaveBeenCalled();
  });
  it("projects metadata without raw sources or storage credentials", async () => {
    api.mockResolvedValueOnce(
      Response.json({
        snapshotId: snapshot,
        researchItemId: createEntityId(),
        captureStatus: "complete",
        fieldCaptureStatus: "complete",
        archivedItem: false,
        canReadArchive: true,
        total: 0,
        counts: { queued: 0, processing: 0, archived: 0, excluded: 0, failed: 0 },
        kinds: { image: 0, video: 0 },
        nextCursor: null,
        media: [],
        objectKey: "private",
        url: lease.url,
      }),
    );
    const result = await read([snapshot]);
    expect(result.status).toBe(200);
    const body = await result.json();
    expect(body).not.toHaveProperty("objectKey");
    expect(body).not.toHaveProperty("url");
    expect(result.headers.get("cache-control")).toBe("private, no-store");
  });
  it("streams only the configured private bucket and does not forward caller credentials", async () => {
    api.mockResolvedValueOnce(Response.json(lease));
    storage.mockResolvedValueOnce(
      new Response(new Uint8Array([1, 2, 3, 4]), {
        headers: { "content-type": "image/png", "content-length": "4" },
      }),
    );
    const response = await read([snapshot, media], "?v=1", {
      authorization: "Bearer caller-value",
      cookie: "caller-cookie",
    });
    expect(response.status).toBe(200);
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3, 4]);
    expect(api.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(storage.mock.calls[0]?.[1]?.headers).toBeUndefined();
    expect(storage.mock.calls[0]?.[1]?.redirect).toBe("error");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
  });
  it("forwards a single Range and validates the returned byte interval", async () => {
    api.mockResolvedValueOnce(Response.json(lease));
    storage.mockResolvedValueOnce(
      new Response(new Uint8Array([2, 3]), {
        status: 206,
        headers: {
          "content-type": "image/png",
          "content-length": "2",
          "content-range": "bytes 1-2/4",
        },
      }),
    );
    const result = await read([snapshot, media], "", { range: "bytes=1-2" });
    expect(result.status).toBe(206);
    expect(result.headers.get("content-range")).toBe("bytes 1-2/4");
    expect(storage.mock.calls[0]?.[1]?.headers).toEqual({ range: "bytes=1-2" });
  });
  it.each(["https://evil.test/fixture-bucket/secret", "http://storage.test/other-bucket/secret"])(
    "refuses a lease outside the configured storage boundary %s",
    async (url) => {
      api.mockResolvedValueOnce(Response.json({ ...lease, url }));
      expect((await read([snapshot, media])).status).toBe(502);
      expect(storage).not.toHaveBeenCalled();
    },
  );
  it("checks the current lease before returning an unsatisfiable range and masks private errors", async () => {
    api.mockResolvedValueOnce(Response.json(lease));
    storage.mockResolvedValueOnce(new Response(null, { status: 416 }));
    const result = await read([snapshot, media], "", { range: "bytes=99-" });
    expect(result.status).toBe(416);
    expect(result.headers.get("content-range")).toBe("bytes */4");
    api.mockResolvedValueOnce(
      Response.json({ message: "private signed URL and provider diagnostic" }, { status: 403 }),
    );
    expect(await (await read([snapshot, media])).text()).not.toContain("signed");
    expect(storage).toHaveBeenCalledTimes(1);
  });
  it("rejects a different byte interval even when the upstream headers are internally consistent", async () => {
    api.mockResolvedValueOnce(Response.json(lease));
    storage.mockResolvedValueOnce(
      new Response(new Uint8Array([1, 2]), {
        status: 206,
        headers: {
          "content-type": "image/png",
          "content-length": "2",
          "content-range": "bytes 0-1/4",
        },
      }),
    );
    expect((await read([snapshot, media], "", { range: "bytes=1-2" })).status).toBe(502);
  });
  it("accepts a suffix range against the authorized archive length", async () => {
    api.mockResolvedValueOnce(Response.json(lease));
    storage.mockResolvedValueOnce(
      new Response(new Uint8Array([3, 4]), {
        status: 206,
        headers: {
          "content-type": "image/png",
          "content-length": "2",
          "content-range": "bytes 2-3/4",
        },
      }),
    );
    expect((await read([snapshot, media], "", { range: "bytes=-2" })).status).toBe(206);
  });
  it("refuses unexpected file content headers instead of rendering active content", async () => {
    api.mockResolvedValueOnce(Response.json(lease));
    storage.mockResolvedValueOnce(
      new Response("html", { headers: { "content-type": "text/html", "content-length": "4" } }),
    );
    expect((await read([snapshot, media])).status).toBe(502);
  });
});
