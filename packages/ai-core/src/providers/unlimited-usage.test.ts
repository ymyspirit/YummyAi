import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ResolvedModelRequest } from "../provider.js";
import { decodeModelResponse, type ModelResponseCheckpoint } from "../response-checkpoint.js";
import { OpenAiProvider } from "./openai.js";
import { OpenAiCompatibleProvider } from "./openai-compatible.js";

const protocols = ["responses", "compatible-modern", "compatible-legacy"] as const;
type Protocol = typeof protocols[number];
const schema = z.object({ answer: z.string() }).strict();
const endpoint = "https://synthetic-provider.invalid/v1";
const pricing = { inputUsdPerMillion: 1, outputUsdPerMillion: 2 };
const outputParameters = ["max_output_tokens", "max_completion_tokens", "max_tokens"] as const;
const parameter = (protocol: Protocol) => protocol === "responses" ? "max_output_tokens"
  : protocol === "compatible-modern" ? "max_completion_tokens" : "max_tokens";

function request(protocol: Protocol, maxOutputTokens: number | null | undefined): ResolvedModelRequest<z.infer<typeof schema>> {
  return {
    modelKey: "synthetic-unlimited", providerModel: protocol === "compatible-modern" ? "gpt-5.6-synthetic" : "synthetic-model",
    taskType: "synthetic-analysis", systemInstructions: "Return the requested JSON only", untrustedSourceData: { synthetic: true },
    outputSchema: schema, maxCostUsd: 1, maxOutputTokens,
  };
}

function payload(protocol: Protocol, text = '{"answer":"synthetic"}', withUsage = true): Record<string, unknown> {
  const usage = protocol === "responses" ? {
    input_tokens: 120, output_tokens: 7200, total_tokens: 7320,
    input_tokens_details: { cached_tokens: 30 }, output_tokens_details: { reasoning_tokens: 200 },
  } : {
    prompt_tokens: 120, completion_tokens: 7200, total_tokens: 7320,
    prompt_tokens_details: { cached_tokens: 30 }, completion_tokens_details: { reasoning_tokens: 200 },
  };
  return {
    id: "synthetic-original-response", ...(withUsage ? { usage } : {}),
    ...(protocol === "responses" ? {
      status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text }] }],
    } : { choices: [{ finish_reason: "stop", message: { role: "assistant", content: text } }] }),
  };
}

function fixture(protocol: Protocol, response: () => Response, priced = true) {
  const sent: Array<Record<string, unknown>> = [];
  const transport = vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    expect(String(url)).toBe(endpoint + (protocol === "responses" ? "/responses" : "/chat/completions"));
    expect(init?.method).toBe("POST");
    sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return response();
  });
  const config = { apiKey: "synthetic-not-a-real-key", endpoint, pricing: priced ? pricing : null, fetch: transport as typeof fetch };
  const provider = protocol === "responses" ? new OpenAiProvider(config)
    : new OpenAiCompatibleProvider({ ...config, providerId: "synthetic-compatible" });
  return { provider, transport, sent };
}

const event = (type: string, response: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, response })}\n\n`;
const stream = (type: string, response: Record<string, unknown>) => new Response(
  event("response.created", { id: response.id }) + event(type, response) + "data: [DONE]\n\n",
  { headers: { "content-type": "text/event-stream" } },
);

describe.each(protocols)("%s explicit unlimited output and original usage", protocol => {
  it("omits every output ceiling for null and leaves the estimate unknown", async () => {
    const { provider, transport, sent } = fixture(protocol, () => Response.json(payload(protocol)));
    const input = request(protocol, null);
    const estimate = await provider.estimate(input);
    expect(estimate.maxOutputTokens).toBeNull();
    expect(estimate.costUsd).toBeNull();
    expect(estimate.estimatedInputTokens).toBeGreaterThan(0);
    await provider.generate(input, new AbortController().signal);
    for (const key of outputParameters) expect(sent[0]).not.toHaveProperty(key);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("retains the legacy 1024 fallback only when the option is undefined", async () => {
    const { provider, sent } = fixture(protocol, () => Response.json(payload(protocol)));
    const input = request(protocol, undefined);
    const estimate = await provider.estimate(input);
    expect(estimate.maxOutputTokens).toBe(1024);
    expect(estimate.costUsd).toBeGreaterThan(0);
    await provider.generate(input, new AbortController().signal);
    expect(sent[0]).toHaveProperty(parameter(protocol), 1024);
    for (const key of outputParameters.filter(key => key !== parameter(protocol))) expect(sent[0]).not.toHaveProperty(key);
  });

  it("preserves an explicitly selected finite ceiling", async () => {
    const { provider, sent } = fixture(protocol, () => Response.json(payload(protocol)));
    await provider.generate(request(protocol, 2048), new AbortController().signal);
    expect(sent[0]).toHaveProperty(parameter(protocol), 2048);
    for (const key of outputParameters.filter(key => key !== parameter(protocol))) expect(sent[0]).not.toHaveProperty(key);
  });

  it("keeps output above the former ceiling and cached input inside its parent total", async () => {
    const raw = payload(protocol), checkpoint = vi.fn(async (value: ModelResponseCheckpoint) => { void value; });
    const { provider, transport } = fixture(protocol, () => Response.json(raw));
    const result = await provider.generate({ ...request(protocol, null), onResponseCheckpoint: checkpoint }, new AbortController().signal);
    expect(result.value).toEqual({ answer: "synthetic" });
    expect(result).toMatchObject({ inputTokens: 120, outputTokens: 7200, usageReported: true });
    expect(result.tokenUsage).toMatchObject({ version: "model-token-usage-v1", inputTokens: 120,
      outputTokens: 7200, cachedInputTokens: 30, totalTokens: 7320, totalTokensBasis: "provider", reasoningTokens: 200 });
    expect(result.costUsd).toBeCloseTo(0.01452, 10);
    expect(checkpoint).toHaveBeenCalledTimes(1);
    expect(checkpoint.mock.calls[0]![0]).toMatchObject({ payload: raw, tokenUsage: result.tokenUsage });
    expect(checkpoint.mock.calls[0]![0].costUsd).toBeCloseTo(0.01452, 10);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("records unknown usage and unknown cost when the provider reports neither", async () => {
    const checkpoint = vi.fn(async (value: ModelResponseCheckpoint) => { void value; });
    const { provider, transport } = fixture(protocol, () => Response.json(payload(protocol, undefined, false)));
    const result = await provider.generate({ ...request(protocol, null), onResponseCheckpoint: checkpoint }, new AbortController().signal);
    expect(result.usageReported).toBe(false);
    expect(result.costUsd).toBeNull();
    expect(result.tokenUsage).toBeNull();
    expect(checkpoint).toHaveBeenCalledTimes(1);
    expect(checkpoint.mock.calls[0]![0]).toMatchObject({ inputTokens: null, outputTokens: null, costUsd: null, tokenUsage: null });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("preserves reported usage independently of missing prices", async () => {
    const { provider } = fixture(protocol, () => Response.json(payload(protocol)), false);
    const result = await provider.generate(request(protocol, null), new AbortController().signal);
    expect(result.costUsd).toBeNull();
    expect(result.tokenUsage).toMatchObject({ inputTokens: 120, outputTokens: 7200, cachedInputTokens: 30, totalTokens: 7320 });
  });

  it.each(["invalid-json", "incomplete", "refusal"] as const)("checkpoints original usage once before rejecting %s JSON", async failure => {
    const raw = payload(protocol, failure === "invalid-json" ? "synthetic invalid JSON" : undefined);
    if (failure === "incomplete") {
      if (protocol === "responses") { raw.status = "incomplete"; raw.incomplete_details = { reason: "max_output_tokens" }; }
      else raw.choices = [{ finish_reason: "length", message: { content: '{"answer":"synthetic"}' } }];
    }
    if (failure === "refusal") {
      if (protocol === "responses") raw.output = [{ type: "message", content: [{ type: "refusal", refusal: "synthetic refusal" }] }];
      else raw.choices = [{ finish_reason: "stop", message: { content: null, refusal: "synthetic refusal" } }];
    }
    let saved: ModelResponseCheckpoint | undefined;
    const checkpoint = vi.fn(async (value: ModelResponseCheckpoint) => { await Promise.resolve(); saved = value; });
    const { provider, transport } = fixture(protocol, () => Response.json(raw));
    await expect(provider.generate({ ...request(protocol, null), onResponseCheckpoint: checkpoint }, new AbortController().signal)).rejects.toThrow();
    expect(saved).toMatchObject({ payload: raw, inputTokens: 120, outputTokens: 7200,
      tokenUsage: { cachedInputTokens: 30, totalTokens: 7320 } });
    expect(checkpoint).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("propagates checkpoint failure without interpreting or repeating the response", async () => {
    const checkpoint = vi.fn(async (value: ModelResponseCheckpoint) => { void value; throw new Error("synthetic checkpoint unavailable"); });
    const { provider, transport } = fixture(protocol, () => Response.json(payload(protocol, "invalid JSON must not be interpreted")));
    await expect(provider.generate({ ...request(protocol, null), onResponseCheckpoint: checkpoint }, new AbortController().signal))
      .rejects.toThrow("synthetic checkpoint unavailable");
    expect(checkpoint).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(1);
  });
});

describe("Responses relay SSE preserves actual usage before interpretation", () => {
  it("records one completed final response while keeping the request nonstreaming", async () => {
    const checkpoint = vi.fn(async (value: ModelResponseCheckpoint) => { void value; }), raw = payload("responses");
    const { provider, transport, sent } = fixture("responses", () => stream("response.completed", raw));
    const result = await provider.generate({ ...request("responses", null), onResponseCheckpoint: checkpoint }, new AbortController().signal);
    expect(sent[0]).toMatchObject({ stream: false });
    expect(result.tokenUsage).toMatchObject({ inputTokens: 120, outputTokens: 7200, cachedInputTokens: 30, totalTokens: 7320 });
    expect(checkpoint).toHaveBeenCalledTimes(1);
    expect(checkpoint.mock.calls[0]![0]).toMatchObject({ payload: raw, tokenUsage: result.tokenUsage });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each(["incomplete", "failed", "refusal", "invalid-json"] as const)("checkpoints one terminal %s response before rejecting it", async failure => {
    const raw = payload("responses", failure === "invalid-json" ? "synthetic invalid JSON" : undefined);
    let type = "response.completed";
    if (failure === "incomplete" || failure === "failed") { raw.status = failure; type = `response.${failure}`; }
    if (failure === "refusal") raw.output = [{ type: "message", content: [{ type: "refusal", refusal: "synthetic refusal" }] }];
    const checkpoint = vi.fn(async (value: ModelResponseCheckpoint) => { void value; });
    const { provider, transport } = fixture("responses", () => stream(type, raw));
    await expect(provider.generate({ ...request("responses", null), onResponseCheckpoint: checkpoint }, new AbortController().signal)).rejects.toThrow();
    expect(checkpoint).toHaveBeenCalledTimes(1);
    expect(checkpoint.mock.calls[0]![0]).toMatchObject({ payload: raw, inputTokens: 120, outputTokens: 7200,
      tokenUsage: { cachedInputTokens: 30, totalTokens: 7320 } });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("does not resubmit or replace a failed durable SSE checkpoint with a parse error", async () => {
    const checkpoint = vi.fn(async (value: ModelResponseCheckpoint) => { void value; throw new Error("synthetic SSE checkpoint unavailable"); });
    const { provider, transport } = fixture("responses", () => stream("response.completed", payload("responses", "invalid JSON")));
    await expect(provider.generate({ ...request("responses", null), onResponseCheckpoint: checkpoint }, new AbortController().signal))
      .rejects.toThrow("synthetic SSE checkpoint unavailable");
    expect(checkpoint).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(1);
  });
});

describe("recovery rejects charged failure envelopes with valid JSON", () => {
  async function assertRejectedReceipt(protocol: Protocol, raw: Record<string, unknown>, response: () => Response,
    initialFailure = "model_response_incomplete", recoveryFailure = initialFailure) {
    const checkpoint = vi.fn(async (value: ModelResponseCheckpoint) => { await Promise.resolve(); void value; });
    const { provider, transport } = fixture(protocol, response);
    await expect(provider.generate({ ...request(protocol, null), onResponseCheckpoint: checkpoint }, new AbortController().signal))
      .rejects.toThrow(initialFailure);
    expect(checkpoint).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(1);
    const saved = checkpoint.mock.calls[0]![0], original = structuredClone(saved);
    expect(saved).toMatchObject({ payload: raw, inputTokens: 120, outputTokens: 7200,
      tokenUsage: { inputTokens: 120, outputTokens: 7200, cachedInputTokens: 30, totalTokens: 7320, totalTokensBasis: "provider" } });
    expect(saved.costUsd).toBeCloseTo(0.01452, 10);
    expect(() => decodeModelResponse(saved, schema)).toThrow(recoveryFailure);
    expect(saved).toEqual(original);
    expect(checkpoint).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(1);
  }

  describe.each(["JSON", "SSE"] as const)("Responses %s saved response", format => {
    it.each(["failed", "refusal", "incomplete"] as const)("rejects %s on the first read and original-checkpoint recovery", async failure => {
      const raw = payload("responses");
      raw.output_text = '{"answer":"synthetic"}';
      if (failure === "refusal") raw.output = [{ type: "message", status: "completed", content: [
        { type: "output_text", text: '{"answer":"synthetic"}' },
        { type: "refusal", refusal: "synthetic refusal must not become an adopted answer" },
      ] }];
      else raw.status = failure;
      const type = failure === "refusal" ? "response.completed" : `response.${failure}`;
      await assertRejectedReceipt("responses", raw, () => format === "JSON" ? Response.json(raw) : stream(type, raw),
        "model_response_incomplete", failure === "incomplete" ? "model_output_truncated" : "model_response_incomplete");
    });
  });

  it.each(["queued", "in_progress", "cancelled"] as const)("does not recover noncompleted Responses status %s merely because JSON is valid", async status => {
    const raw = { ...payload("responses"), status, output_text: '{"answer":"synthetic"}' };
    await assertRejectedReceipt("responses", raw, () => Response.json(raw));
  });

  describe.each(["compatible-modern", "compatible-legacy"] as const)("%s saved chat response", protocol => {
    it.each(["refusal", "content_filter", "length"] as const)("retains usage but rejects %s even alongside valid JSON", async failure => {
      const raw = payload(protocol);
      raw.choices = [{ finish_reason: failure === "refusal" ? "stop" : failure, message: {
        role: "assistant", content: '{"answer":"synthetic"}',
        ...(failure === "refusal" ? { refusal: "synthetic refusal must not become an adopted answer" } : {}),
      } }];
      await assertRejectedReceipt(protocol, raw, () => Response.json(raw),
        failure === "length" ? "model_output_truncated" : "model_response_incomplete");
    });
  });
});
