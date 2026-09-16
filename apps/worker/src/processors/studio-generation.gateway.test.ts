import { describe, expect, it, vi } from "vitest";
import { createEntityId } from "@yummyai/contracts";
import { StudioGenerateSchema } from "@yummyai/contracts/pod/creative-studio";
import { HttpStudioGateway, boundedBody, studioEndpoint, type StudioExecution } from "./studio-generation.gateway.js";
const request = (): StudioExecution => ({ endpoint: "https://example.test/v1", apiKey: "synthetic", model: "gpt-image-fixture", capability: "image", references: [], providerTaskId: null, input: StudioGenerateSchema.parse({ requestId: createEntityId(), modelId: createEntityId(), prompt: "Synthetic square" }) });
describe("studio HTTP gateway", () => {
  it("uses bounded OpenAI-compatible image requests without returning credentials", async () => {
    const bytes = Buffer.from("89504e470d0a1a0a", "hex"), fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ data: [{ b64_json: bytes.toString("base64") }] }));
    const output = await new HttpStudioGateway(fetch).generate(request(), async () => undefined);
    expect(output).toEqual({ bytes, mediaType: "image/png" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toBe("https://example.test/v1/images/generations");
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body))).toMatchObject({ n: 1, model: "gpt-image-fixture", size: "1024x1024" });
    expect(fetch.mock.calls[0]![1]!.redirect).toBe("error");
  });
  it("uses multipart edits and never sends a reference URL to the model", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ data: [{ b64_json: "iVBORw0KGgo=" }] }));
    await new HttpStudioGateway(fetch).generate({ ...request(), references: [{ bytes: Buffer.from("fixture"), mediaType: "image/png" }] }, async () => undefined);
    expect(fetch.mock.calls[0]![0]).toBe("https://example.test/v1/images/edits");
    expect(fetch.mock.calls[0]![1]!.body).toBeInstanceOf(FormData);
    expect((fetch.mock.calls[0]![1]!.body as FormData).get("image")).toBeInstanceOf(Blob);
  });
  it("resumes a known video task with GET requests only", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(Response.json({ status: "completed" })).mockResolvedValueOnce(new Response(Buffer.from("fixture-video")));
    const remember = vi.fn();
    const result = await new HttpStudioGateway(fetch, 1).generate({ ...request(), capability: "video", providerTaskId: "video_fixture" }, remember);
    expect(remember).not.toHaveBeenCalled();
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(["https://example.test/v1/videos/video_fixture", "https://example.test/v1/videos/video_fixture/content"]);
    expect(result).toMatchObject({ mediaType: "video/mp4" });
  });
  it("does not retry a rejected request or expose the provider error body", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("synthetic-private-provider-body", { status: 401 }));
    await expect(new HttpStudioGateway(fetch).generate(request(), vi.fn())).rejects.toThrow("studio_provider_http_401");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("rejects unsafe endpoints and oversize response streams", async () => {
    for (const endpoint of ["http://example.test", "https://user:pass@example.test", "https://example.test?token=fixture", "file:///tmp/test"]) expect(() => studioEndpoint(endpoint)).toThrow();
    expect(studioEndpoint("http://127.0.0.1:1234/v1/")).toBe("http://127.0.0.1:1234/v1");
    await expect(boundedBody(new Response("123456"), 5)).rejects.toThrow("studio_result_too_large");
  });
});
