import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { OpenAiProvider } from "./openai.js";
import { readResponsesPayload } from "./responses-payload.js";

const payload = { id: "resp_synthetic", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: '{"connected":true}' }] }], usage: { input_tokens: 12, output_tokens: 4 } };
const event = (type: string, response?: unknown) => `event: ${type}\r\ndata: ${JSON.stringify({ type, ...(response ? { response } : {}) })}\r\n\r\n`;
const sse = (text: string) => new Response(text, { headers: { "content-type": "text/event-stream; charset=utf-8" } });

describe("bounded Responses envelopes", () => {
  it("reads ordinary JSON responses", async () => {
    expect(await readResponsesPayload(Response.json(payload))).toEqual(payload);
  });
  it("uses only the complete final event and ignores partial deltas", async () => {
    expect(await readResponsesPayload(sse(event("response.created", { id: "resp_synthetic" }) + 'data: {"type":"response.output_text.delta","delta":"incomplete"}\n\n' + event("response.completed", payload) + "data: [DONE]\n\n"))).toEqual(payload);
  });
  it("handles split UTF-8 bytes and event delimiters", async () => {
    const final = { ...payload, model: "测试" };
    const encoded = new TextEncoder().encode(event("response.completed", final));
    const response = new Response(new ReadableStream({ start(controller) { for (const byte of encoded) controller.enqueue(Uint8Array.of(byte)); controller.close(); } }), { headers: { "content-type": "text/event-stream" } });
    expect(await readResponsesPayload(response)).toEqual(final);
  });
  it("cancels an open upstream stream after complete evidence", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(event("response.completed", payload))); }, cancel }), { headers: { "content-type": "text/event-stream" } });
    expect(await readResponsesPayload(response)).toEqual(payload);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it.each(["", 'data: [DONE]\n\n', 'data: {"type":"response.output_text.delta","delta":"finished?"}\n\n', event("response.created", payload)])("rejects a stream without complete evidence", async text => {
    await expect(readResponsesPayload(sse(text))).rejects.toThrow("model_response_incomplete");
  });
  it.each(["error", "response.failed", "response.incomplete"])("rejects %s without exposing provider errors", async type => {
    await expect(readResponsesPayload(sse(event(type, { error: "synthetic-private-body" })))).rejects.toThrow(/^model_response_incomplete$/);
  });
  it.each(["incomplete", "failed", "in_progress"])("rejects nonterminal final status %s", async status => {
    await expect(readResponsesPayload(sse(event("response.completed", { ...payload, status })))).rejects.toThrow("model_response_incomplete");
    await expect(readResponsesPayload(Response.json({ ...payload, status }))).rejects.toThrow("model_response_incomplete");
  });
  it("rejects mismatched labels and malformed events", async () => {
    await expect(readResponsesPayload(sse('event: response.completed\ndata: {"type":"response.failed"}\n\n'))).rejects.toThrow("model_response_invalid");
    await expect(readResponsesPayload(sse("data: synthetic-private-body\n\n"))).rejects.toThrow(/^model_response_invalid$/);
    await expect(readResponsesPayload(new Response("synthetic-private-body"))).rejects.toThrow(/^model_response_invalid$/);
  });
  it("bounds JSON and SSE bytes and cancels overflow", async () => {
    await expect(readResponsesPayload(Response.json(payload), 10)).rejects.toThrow("model_response_too_large");
    await expect(readResponsesPayload(sse(event("response.completed", payload)), 10)).rejects.toThrow("model_response_too_large");
  });
  it.each([null, false, "", 0])("rejects an explicit invalid JSON completion status %s", async status => {
    await expect(readResponsesPayload(Response.json({ ...payload, status }))).rejects.toThrow("model_response_incomplete");
  });
  it.each([
    { type: "message", status: "incomplete", content: payload.output[0]!.content },
    { type: "message", status: null, content: payload.output[0]!.content },
    { type: "message", content: [...payload.output[0]!.content, { type: "refusal", refusal: "synthetic refusal" }] },
  ])("rejects unfinished or refused messages even with otherwise valid JSON text", async message => {
    const final = { ...payload, output: [message] };
    await expect(readResponsesPayload(Response.json(final))).rejects.toThrow("model_response_incomplete");
    await expect(readResponsesPayload(sse(event("response.completed", final)))).rejects.toThrow("model_response_incomplete");
  });
  it("accepts a final event at EOF without a trailing blank line", async () => {
    expect(await readResponsesPayload(sse(event("response.completed", payload).trimEnd()))).toEqual(payload);
  });
});

describe("OpenAI Responses transport", () => {
  it("requests nonstreaming once and checkpoints a relay's complete SSE response", async () => {
    const transport = vi.fn(async () => sse(event("response.completed", payload)));
    const checkpoint = vi.fn();
    const provider = new OpenAiProvider({ apiKey: "synthetic-key", endpoint: "http://localhost:8080/v1", pricing: null, fetch: transport });
    const result = await provider.generate({ taskType: "connection", modelKey: "synthetic", providerModel: "synthetic-model", maxCostUsd: 1, systemInstructions: "Return JSON", untrustedSourceData: {}, outputSchema: z.object({ connected: z.boolean() }), onResponseCheckpoint: checkpoint }, new AbortController().signal);
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, init] = (transport.mock.calls as unknown as Array<[string, RequestInit]>)[0]!;
    expect(url).toBe("http://localhost:8080/v1/responses");
    expect(JSON.parse(String(init.body))).toMatchObject({ model: "synthetic-model", stream: false, store: false, text: { format: { type: "json_schema", strict: true } } });
    expect(checkpoint).toHaveBeenCalledWith(expect.objectContaining({ payload, inputTokens: 12, outputTokens: 4, costUsd: null }));
    expect(result.value).toEqual({ connected: true });
    expect(result.costUsd).toBeNull();
  });
  it("does not retry or checkpoint a truncated stream", async () => {
    const transport = vi.fn(async () => sse(event("response.created", payload)));
    const checkpoint = vi.fn();
    await expect(new OpenAiProvider({ apiKey: "synthetic-key", pricing: null, fetch: transport }).generate({ taskType: "connection", modelKey: "synthetic", providerModel: "synthetic-model", maxCostUsd: 1, systemInstructions: "Return JSON", untrustedSourceData: {}, outputSchema: z.object({ connected: z.boolean() }), onResponseCheckpoint: checkpoint }, new AbortController().signal)).rejects.toThrow("model_response_incomplete");
    expect(transport).toHaveBeenCalledTimes(1);
    expect(checkpoint).not.toHaveBeenCalled();
  });
});
