import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { OpenAiProvider } from "./openai.js";
import { readResponsesPayload } from "./responses-payload.js";

const payload = {
  id: "resp_stream_synthetic",
  status: "completed",
  output: [{ type: "message", content: [{ type: "output_text", text: '{"answer":"你好"}' }] }],
  usage: { input_tokens: 17, output_tokens: 9 },
};
const event = (type: string, fields: Record<string, unknown> = {}) =>
  `event: ${type}\r\ndata: ${JSON.stringify({ type, ...fields })}\r\n\r\n`;
const finalEvent = () => event("response.completed", { response: payload });
const sse = (text: string) =>
  new Response(text, { headers: { "content-type": "text/event-stream" } });
const request = () => ({
  taskType: "synthetic_streaming",
  modelKey: "synthetic",
  providerModel: "synthetic-model",
  maxCostUsd: null,
  maxOutputTokens: null,
  systemInstructions: "Return JSON",
  untrustedSourceData: {},
  outputSchema: z.object({ answer: z.string() }),
});

describe("actual Responses text streaming", () => {
  it("delivers a real delta before completion is available and checkpoints only the final envelope", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
        },
      }),
      {
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      },
    );
    let resolveFirstDelta!: () => void;
    const firstDelta = new Promise<void>((resolve) => {
      resolveFirstDelta = resolve;
    });
    const delta = vi.fn(() => {
      resolveFirstDelta();
    });
    const checkpoint = vi.fn();
    const result = readResponsesPayload(response, undefined, checkpoint, delta);
    controller.enqueue(
      new TextEncoder().encode(event("response.output_text.delta", { delta: '{"answer":"你' })),
    );
    await firstDelta;
    expect(delta).toHaveBeenCalledWith('{"answer":"你');
    expect(checkpoint).not.toHaveBeenCalled();
    controller.enqueue(
      new TextEncoder().encode(
        event("response.output_text.delta", { delta: '好"}' }) + finalEvent(),
      ),
    );
    expect(await result).toEqual(payload);
    expect(delta.mock.calls).toEqual([['{"answer":"你'], ['好"}']]);
    expect(checkpoint).toHaveBeenCalledExactlyOnceWith(payload);
  });

  it("does not forward reasoning, refusals, function arguments, or whole-envelope events", async () => {
    const delta = vi.fn();
    const text = [
      event("response.reasoning_text.delta", { delta: "private reasoning" }),
      event("response.reasoning_summary_text.delta", { delta: "private reasoning summary" }),
      event("response.function_call_arguments.delta", { delta: "private arguments" }),
      event("response.refusal.delta", { delta: "refusal" }),
      event("response.output_text.delta", { delta: "visible output" }),
      finalEvent(),
    ].join("");
    expect(await readResponsesPayload(sse(text), undefined, undefined, delta)).toEqual(payload);
    expect(delta).toHaveBeenCalledExactlyOnceWith("visible output");
  });

  it("preserves exact UTF-8 text when events and characters arrive one byte at a time", async () => {
    const delta = vi.fn();
    const bytes = new TextEncoder().encode(
      event("response.output_text.delta", { delta: "你好\nERP" }) + finalEvent(),
    );
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
          controller.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
    await readResponsesPayload(response, undefined, undefined, delta);
    expect(delta).toHaveBeenCalledExactlyOnceWith("你好\nERP");
  });

  it("continues to the original receipt when an asynchronous preview sink fails", async () => {
    const delta = vi.fn(async () => {
      throw new Error("disconnected preview sink");
    });
    const checkpoint = vi.fn();
    const text =
      event("response.output_text.delta", { delta: "first" }) +
      event("response.output_text.delta", { delta: "second" }) +
      finalEvent();
    expect(await readResponsesPayload(sse(text), undefined, checkpoint, delta)).toEqual(payload);
    expect(delta).toHaveBeenCalledTimes(1);
    expect(checkpoint).toHaveBeenCalledExactlyOnceWith(payload);
  });

  it("continues to the original receipt when a synchronous preview sink fails", async () => {
    const delta = vi.fn(() => {
      throw new Error("disconnected preview sink");
    });
    const checkpoint = vi.fn();
    await readResponsesPayload(
      sse(event("response.output_text.delta", { delta: "first" }) + finalEvent()),
      undefined,
      checkpoint,
      delta,
    );
    expect(checkpoint).toHaveBeenCalledExactlyOnceWith(payload);
  });

  it("does not manufacture deltas for a JSON-only relay response", async () => {
    const delta = vi.fn();
    const checkpoint = vi.fn();
    expect(
      await readResponsesPayload(Response.json(payload), undefined, checkpoint, delta),
    ).toEqual(payload);
    expect(delta).not.toHaveBeenCalled();
    expect(checkpoint).toHaveBeenCalledExactlyOnceWith(payload);
  });

  it("does not accept deltas as successful completion or invent a usage receipt", async () => {
    const delta = vi.fn();
    const checkpoint = vi.fn();
    await expect(
      readResponsesPayload(
        sse(event("response.output_text.delta", { delta: "partial" })),
        undefined,
        checkpoint,
        delta,
      ),
    ).rejects.toThrow("model_response_incomplete");
    expect(delta).toHaveBeenCalledExactlyOnceWith("partial");
    expect(checkpoint).not.toHaveBeenCalled();
  });

  it("rejects a malformed text delta rather than forwarding arbitrary event objects", async () => {
    const delta = vi.fn();
    await expect(
      readResponsesPayload(
        sse(event("response.output_text.delta", { delta: { secret: true } }) + finalEvent()),
        undefined,
        undefined,
        delta,
      ),
    ).rejects.toThrow("model_response_invalid");
    expect(delta).not.toHaveBeenCalled();
  });
});

describe("opt-in OpenAI provider streaming", () => {
  it("requests streaming once, omits the artificial token cap, and retains actual final usage", async () => {
    const delta = vi.fn();
    const checkpoint = vi.fn();
    const transport = vi.fn(async () =>
      sse(event("response.output_text.delta", { delta: '{"answer":"你好"}' }) + finalEvent()),
    );
    const provider = new OpenAiProvider({
      apiKey: "synthetic-key",
      endpoint: "http://localhost:8080/v1",
      pricing: null,
      fetch: transport,
    });
    const result = await provider.generate(
      { ...request(), onTextDelta: delta, onResponseCheckpoint: checkpoint },
      new AbortController().signal,
    );
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, init] = transport.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:8080/v1/responses");
    expect(JSON.parse(String(init.body))).toMatchObject({ stream: true, store: false });
    expect(JSON.parse(String(init.body))).not.toHaveProperty("max_output_tokens");
    expect(new Headers(init.headers).get("accept")).toBe("text/event-stream, application/json");
    expect(delta).toHaveBeenCalledExactlyOnceWith('{"answer":"你好"}');
    expect(checkpoint).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ payload, inputTokens: 17, outputTokens: 9 }),
    );
    expect(result).toMatchObject({
      value: { answer: "你好" },
      inputTokens: 17,
      outputTokens: 9,
      usageReported: true,
      costUsd: null,
    });
  });

  it("does not retry a received model completion when the preview listener is lost", async () => {
    const delta = vi.fn(() => {
      throw new Error("UI disconnected");
    });
    const checkpoint = vi.fn();
    const transport = vi.fn(async () =>
      sse(event("response.output_text.delta", { delta: "first" }) + finalEvent()),
    );
    const provider = new OpenAiProvider({
      apiKey: "synthetic-key",
      pricing: null,
      fetch: transport,
    });
    const result = await provider.generate(
      { ...request(), onTextDelta: delta, onResponseCheckpoint: checkpoint },
      new AbortController().signal,
    );
    expect(result.value).toEqual({ answer: "你好" });
    expect(checkpoint).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("keeps a real receipt even when final structured-output validation fails", async () => {
    const checkpoint = vi.fn();
    const transport = vi.fn(async () =>
      sse(event("response.output_text.delta", { delta: "partial" }) + finalEvent()),
    );
    const provider = new OpenAiProvider({
      apiKey: "synthetic-key",
      pricing: null,
      fetch: transport,
    });
    await expect(
      provider.generate(
        {
          ...request(),
          outputSchema: z.object({ required: z.number() }),
          onTextDelta: vi.fn(),
          onResponseCheckpoint: checkpoint,
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(checkpoint).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ payload, inputTokens: 17, outputTokens: 9 }),
    );
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("retains the legacy nonstreaming request when no preview was requested", async () => {
    const transport = vi.fn(async () => Response.json(payload));
    const provider = new OpenAiProvider({
      apiKey: "synthetic-key",
      pricing: null,
      fetch: transport,
    });
    await provider.generate(request(), new AbortController().signal);
    const [, init] = transport.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({ stream: false, store: false });
    expect(new Headers(init.headers).get("accept")).toBe("application/json");
  });
});
