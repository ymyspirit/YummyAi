import { describe, expect, it, vi } from "vitest";
import { createEntityId } from "@yummyai/contracts";
import { StudioGenerateSchema } from "@yummyai/contracts/pod/creative-studio";
import { HttpStudioGateway, boundedBody, studioEndpoint, type StudioExecution } from "./studio-generation.gateway.js";
const request = (): StudioExecution => ({ endpoint: "https://example.test/v1", apiKey: "synthetic", model: "gpt-image-fixture", capability: "image", references: [], providerTaskId: null, input: StudioGenerateSchema.parse({ requestId: createEntityId(), modelId: createEntityId(), prompt: "Synthetic square" }) });
const textRequest = (): StudioExecution => ({ ...request(), endpoint: "http://localhost:8080/v1/", model: "synthetic-text", capability: "text", textProtocol: "responses" });
describe("studio HTTP gateway", () => {
  it("does not submit after cancellation and propagates takeover to an active transport without retry", async () => {
    const stopped = new AbortController(); stopped.abort();
    const unused = vi.fn<typeof globalThis.fetch>();
    await expect(new HttpStudioGateway(unused).generate({ ...request(), signal: stopped.signal }, vi.fn())).rejects.toThrow();
    expect(unused).not.toHaveBeenCalled();
    const active = new AbortController();
    const transport = vi.fn<typeof globalThis.fetch>(async (_url, options) => {
      active.abort();
      options!.signal!.throwIfAborted();
      throw new Error("unreachable");
    });
    await expect(new HttpStudioGateway(transport).generate({ ...request(), signal: active.signal }, vi.fn())).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  });
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

  it("submits Responses once without storage and joins all message text without duplicating the convenience field", async () => {
    const payload = { id: "response-synthetic", status: "completed", model: "synthetic-text",
      output_text: "must-not-be-added-twice", output: [
        { type: "reasoning", summary: [{ text: "must-not-be-returned" }] },
        { type: "message", status: "completed", content: [{ type: "output_text", text: "First\n" }, { type: "output_text", text: "second " }] },
        { type: "function_call", name: "must-not-be-executed", arguments: "{}" },
        { type: "message", status: "completed", content: [{ type: "output_text", text: "third" }] },
      ] };
    const transport = vi.fn<typeof fetch>(async () => Response.json(payload, { headers: { "x-request-id": "request-synthetic" } }));
    const remember = vi.fn(), checkpoint = vi.fn(), execution = textRequest();
    const actual = await new HttpStudioGateway(transport).generate(execution, remember, checkpoint);
    expect(actual).toEqual({ text: "First\nsecond third" });
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, init] = transport.mock.calls[0]!;
    expect(url).toBe("http://localhost:8080/v1/responses");
    expect(init).toMatchObject({ method: "POST", redirect: "error", headers: { authorization: "Bearer synthetic", "content-type": "application/json" } });
    expect(JSON.parse(String(init!.body))).toEqual({ model: "synthetic-text", input: execution.input.prompt,
      max_output_tokens: 4096, store: false, stream: false });
    expect(remember).not.toHaveBeenCalled();
    expect(checkpoint).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(checkpoint.mock.calls)).not.toContain(execution.input.prompt);
    expect(JSON.stringify(checkpoint.mock.calls)).not.toContain("Bearer synthetic");
  });

  it.each([{ output_text: "Synthetic complete answer" }, { status: "completed", output_text: "Synthetic complete answer", output: [] }])(
    "accepts a compatible complete text response without nested text: %j", async payload => {
      const transport = vi.fn<typeof fetch>(async () => Response.json(payload));
      await expect(new HttpStudioGateway(transport).generate(textRequest(), vi.fn())).resolves.toEqual({ text: "Synthetic complete answer" });
      expect(transport).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { status: "incomplete", output_text: "partial private answer" },
    { status: "failed", output_text: "failed private answer" },
    { status: "completed", error: { message: "private upstream error" }, output_text: "must not adopt" },
    { status: "completed", incomplete_details: { reason: "max_output_tokens" }, output_text: "must not adopt" },
  ])("rejects a provider-declared incomplete Responses result without resubmission: %#", async payload => {
    const transport = vi.fn<typeof fetch>(async () => Response.json(payload));
    await expect(new HttpStudioGateway(transport).generate(textRequest(), vi.fn())).rejects.toThrow("model_response_incomplete");
    expect(transport.mock.calls.map(([url]) => url)).toEqual(["http://localhost:8080/v1/responses"]);
  });

  it.each([
    { status: null, output_text: "unconfirmed private answer" },
    { status: "completed", refusal: "private refusal", output_text: "must not adopt" },
    { status: "completed", output: [{ type: "message", status: "incomplete", content: [{ type: "output_text", text: "partial" }] }] },
    { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "partial" }, { type: "refusal", refusal: "private refusal" }] }] },
    { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: 42 }] }] },
    { status: "completed", output: [{ type: "message", content: [null] }] },
    { status: "completed", output: "private incompatible output", output_text: "must not adopt" },
    { status: "completed", output_text: "   " },
    { status: "completed", output: [] },
    { status: "completed", output_text: "x".repeat(100_001) },
  ])("rejects refused or invalid Responses output without a second submission or chat fallback: %#", async payload => {
    const transport = vi.fn<typeof fetch>(async () => Response.json(payload));
    const error = await new HttpStudioGateway(transport).generate(textRequest(), vi.fn()).catch(cause => cause);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("studio_provider_invalid_result");
    expect(transport.mock.calls.map(([url]) => url)).toEqual(["http://localhost:8080/v1/responses"]);
  });

  it.each([400, 401, 403, 404, 429, 500])("retains an HTTP %i failure without retrying Responses or reflecting the body", async status => {
    const transport = vi.fn<typeof fetch>(async () => new Response("synthetic-private-provider-body", { status }));
    await expect(new HttpStudioGateway(transport).generate(textRequest(), vi.fn())).rejects.toThrow(`studio_provider_http_${status}`);
    expect(transport.mock.calls.map(([url]) => url)).toEqual(["http://localhost:8080/v1/responses"]);
  });

  it("does not retry or fall back after malformed JSON, transport failure or checkpoint failure", async () => {
    const malformed = vi.fn<typeof fetch>(async () => new Response("synthetic private invalid JSON"));
    await expect(new HttpStudioGateway(malformed).generate(textRequest(), vi.fn())).rejects.toThrow("model_response_invalid");
    const network = vi.fn<typeof fetch>(async () => { throw new TypeError("synthetic connection lost"); });
    await expect(new HttpStudioGateway(network).generate(textRequest(), vi.fn())).rejects.toThrow("synthetic connection lost");
    const received = vi.fn<typeof fetch>(async () => Response.json({ status: "completed", output_text: "Synthetic answer" }));
    await expect(new HttpStudioGateway(received).generate(textRequest(), vi.fn(), async () => { throw new Error("synthetic checkpoint unavailable"); })).rejects.toThrow("synthetic checkpoint unavailable");
    for (const transport of [malformed, network, received])
      expect(transport.mock.calls.map(([url]) => url)).toEqual(["http://localhost:8080/v1/responses"]);
  });

  it.each([undefined, "chat_completions"] as const)("retains legacy Chat Completions when textProtocol is %s", async textProtocol => {
    const transport = vi.fn<typeof fetch>(async () => Response.json({ choices: [{ message: { content: "Synthetic legacy answer" } }] }));
    const execution = { ...textRequest(), textProtocol };
    await expect(new HttpStudioGateway(transport).generate(execution, vi.fn())).resolves.toEqual({ text: "Synthetic legacy answer" });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]![0]).toBe("http://localhost:8080/v1/chat/completions");
    expect(JSON.parse(String(transport.mock.calls[0]![1]!.body))).toMatchObject({ messages: [{ role: "user", content: execution.input.prompt }], max_completion_tokens: 4096 });
  });

  it("uses only a complete SSE Responses result and never adopts deltas as the answer", async () => {
    const final = { id: "response-sse-synthetic", status: "completed", output: [
      { type: "message", status: "completed", content: [{ type: "output_text", text: "完整" }, { type: "output_text", text: "结果" }] },
    ] };
    const stream = [
      `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "must-not-adopt-partial" })}\n\n`,
      `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: final })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
    const transport = vi.fn<typeof fetch>(async () => new Response(stream, { headers: { "content-type": "text/event-stream" } }));
    await expect(new HttpStudioGateway(transport).generate(textRequest(), vi.fn())).resolves.toEqual({ text: "完整结果" });
    expect(transport.mock.calls.map(([url]) => url)).toEqual(["http://localhost:8080/v1/responses"]);
    expect(JSON.parse(String(transport.mock.calls[0]![1]!.body))).toMatchObject({ store: false, stream: false });
  });

  it("rejects an SSE stream ending after text deltas without retrying or falling back to chat", async () => {
    const stream = `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "private incomplete answer" })}\n\ndata: [DONE]\n\n`;
    const transport = vi.fn<typeof fetch>(async () => new Response(stream, { headers: { "content-type": "text/event-stream" } }));
    await expect(new HttpStudioGateway(transport).generate(textRequest(), vi.fn())).rejects.toThrow("model_response_incomplete");
    expect(transport.mock.calls.map(([url]) => url)).toEqual(["http://localhost:8080/v1/responses"]);
  });
});
