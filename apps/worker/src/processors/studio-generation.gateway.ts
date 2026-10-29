import { setTimeout as delay } from "node:timers/promises";
import { readResponsesPayload } from "@yummyai/ai-core";
import type { StudioGenerate } from "@yummyai/contracts/pod/creative-studio";
import type { PodInvocationReceipt } from "@yummyai/contracts/harness";
import { podInvocationReceipt } from "./pod-invocation-receipt.js";
import { hashPodResponse } from "./pod-artwork-response.js";

export type StudioOutput = { bytes: Buffer; mediaType: string } | { text: string };
export type StudioReference = { bytes: Buffer; mediaType: string };
export type StudioExecution = {
  endpoint: string; apiKey: string; model: string; capability: "image" | "video" | "text";
  input: StudioGenerate; references: StudioReference[]; providerTaskId: string | null;
  textProtocol?: "responses" | "chat_completions";
  signal?: AbortSignal;
  originalReceipt?: PodInvocationReceipt | null;
};
export interface StudioGateway {
  generate(input: StudioExecution, rememberTask: (id: string) => Promise<void>, onReceipt?: (receipt: PodInvocationReceipt) => Promise<void>): Promise<StudioOutput>;
}

/** A request is submitted once. Transport errors never cause a second billed request. */
export class HttpStudioGateway implements StudioGateway {
  constructor(private readonly transport: typeof fetch = fetch, private readonly pollInterval = 5_000) {}
  async generate(execution: StudioExecution, rememberTask: (id: string) => Promise<void>, onReceipt?: (receipt: PodInvocationReceipt) => Promise<void>): Promise<StudioOutput> {
    const { input, model, capability, references } = execution;
    const endpoint = studioEndpoint(execution.endpoint);
    const timeout = AbortSignal.timeout(15 * 60_000);
    const signal = execution.signal ? AbortSignal.any([timeout, execution.signal]) : timeout;
    signal.throwIfAborted();
    const call = async (path: string, body?: object | FormData) => {
      const multipart = body instanceof FormData;
      const response = await this.transport(`${endpoint}${path}`, {
        method: body ? "POST" : "GET", redirect: "error", signal,
        headers: { authorization: `Bearer ${execution.apiKey}`, ...(body && !multipart ? { "content-type": "application/json" } : {}) },
        body: multipart ? body : body ? JSON.stringify(body) : undefined,
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`studio_provider_http_${response.status}`); }
      return response;
    };
    let receipt = execution.originalReceipt ?? undefined;
    const json = async (path: string, body?: object | FormData): Promise<Record<string, unknown>> => {
      const response = await call(path, body);
      const capture = async (value: unknown, raw: string) => {
        const data = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
        if (!receipt && (body || capability === "video")) {
          const taskId = typeof data?.id === "string" && /^[a-zA-Z0-9_-]{1,160}$/.test(data.id) ? data.id : null;
          receipt = podInvocationReceipt({ modelKey: model, modelVersion: data?.model, costUsd: data?.costUsd, usage: data?.usage }, hashPodResponse(raw), response.headers.get("x-request-id") ?? taskId);
          await onReceipt?.(receipt);
        }
      };
      let value: unknown, raw: string;
      if (path === "/responses") {
        value = await readResponsesPayload(response, undefined, payload => capture(payload, JSON.stringify(payload)));
        raw = JSON.stringify(value);
      } else {
        raw = (await boundedBody(response, 30_000_000)).toString("utf8");
        try { value = JSON.parse(raw); } catch { value = null; }
      }
      const data = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
      await capture(value, raw);
      if (!data) throw new Error("studio_provider_invalid_result");
      return data;
    };
    if (capability === "text") {
      if (execution.textProtocol === "responses") {
        const result = await json("/responses", { model, input: input.prompt, store: false, stream: false });
        return { text: responsesText(result) };
      }
      const result = await json("/chat/completions", { model, messages: [{ role: "user", content: input.prompt }] });
      const choices = result.choices as Array<{ message?: { content?: unknown } }> | undefined;
      const text = choices?.[0]?.message?.content;
      if (typeof text !== "string" || !text.trim() || text.length > 100_000) throw new Error("studio_provider_invalid_result");
      return { text };
    }
    if (capability === "image") {
      const fields = { model, prompt: input.prompt, n: 1, size: imageSize(input.size), quality: input.quality,
        ...(input.background !== "auto" ? { background: input.background } : {}),
        ...(/gpt-image/.test(model) ? { output_format: "png" } : { response_format: "b64_json" }),
      };
      let body: object | FormData = fields;
      if (references.length) {
        const form = new FormData();
        for (const [key, value] of Object.entries(fields)) form.set(key, String(value));
        for (const [index, ref] of references.entries()) form.append(references.length > 1 ? "image[]" : "image", new Blob([new Uint8Array(ref.bytes)], { type: ref.mediaType }), `reference-${index}.${ref.mediaType.split("/")[1]}`);
        body = form;
      }
      const result = await json(references.length ? "/images/edits" : "/images/generations", body);
      const data = result.data as Array<{ b64_json?: unknown }> | undefined;
      const encoded = data?.[0]?.b64_json;
      if (typeof encoded !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error("studio_provider_requires_base64_result");
      const bytes = Buffer.from(encoded, "base64");
      if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error("studio_result_too_large");
      const mediaType = bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a" ? "image/png" : bytes.subarray(0, 2).toString("hex") === "ffd8" ? "image/jpeg" : "image/webp";
      return { bytes, mediaType };
    }
    let taskId = execution.providerTaskId;
    if (!taskId) {
      const form = new FormData();
      form.set("model", model); form.set("prompt", input.prompt); form.set("seconds", String(input.seconds)); form.set("size", videoSize(input.size));
      const ref = references[0];
      if (ref) form.set("input_reference", new Blob([new Uint8Array(ref.bytes)], { type: ref.mediaType }), `reference.${ref.mediaType.split("/")[1]}`);
      const created = await json("/videos", form);
      if (typeof created.id !== "string" || !/^[a-zA-Z0-9_-]{1,160}$/.test(created.id)) throw new Error("studio_provider_invalid_task");
      taskId = created.id;
      await rememberTask(taskId);
    }
    if (!/^[a-zA-Z0-9_-]{1,160}$/.test(taskId)) throw new Error("studio_provider_invalid_task");
    for (;;) {
      const result = await json(`/videos/${taskId}`);
      if (result.status === "completed") return { bytes: await boundedBody(await call(`/videos/${taskId}/content`), 20 * 1024 * 1024), mediaType: "video/mp4" };
      if (result.status === "failed") throw new Error("studio_provider_generation_failed");
      if (!["queued", "in_progress"].includes(String(result.status))) throw new Error("studio_provider_invalid_task");
      await delay(this.pollInterval, undefined, { signal });
    }
  }
}

/** A completed response is consumed once; missing status is allowed for compatible servers. */
function responsesText(result: Record<string, unknown>): string {
  if (result.status !== undefined && result.status !== "completed" || result.error != null || result.incomplete_details != null || result.refusal != null)
    throw new Error("studio_provider_invalid_result");
  const parts: string[] = [];
  if (result.output !== undefined) {
    if (!Array.isArray(result.output)) throw new Error("studio_provider_invalid_result");
    for (const item of result.output) {
      if (!item || typeof item !== "object" || item.type !== "message") continue;
      if (item.status !== undefined && item.status !== "completed" || !Array.isArray(item.content)) throw new Error("studio_provider_invalid_result");
      for (const content of item.content) {
        if (!content || typeof content !== "object") throw new Error("studio_provider_invalid_result");
        if (content.type === "refusal") throw new Error("studio_provider_invalid_result");
        if (content.type === "output_text") {
          if (typeof content.text !== "string") throw new Error("studio_provider_invalid_result");
          parts.push(content.text);
        }
      }
    }
  }
  // output_text is an aggregated convenience field; do not duplicate nested text.
  const text = parts.length ? parts.join("") : result.output_text;
  if (typeof text !== "string" || !text.trim() || text.length > 100_000) throw new Error("studio_provider_invalid_result");
  return text;
}

export function studioEndpoint(raw: string): string {
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash || url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("studio_provider_invalid_endpoint");
  const base = url.href.replace(/\/$/, "");
  return /\/v\d+(?:beta)?$/.test(base) ? base : `${base}/v1`;
}
export function imageSize(value: string): string {
  if (value === "auto" || /^\d+x\d+$/.test(value)) return value;
  const [w = 1, h = 1] = value.split(":").map(Number);
  return w > h ? "1536x1024" : w < h ? "1024x1536" : "1024x1024";
}
export function videoSize(value: string): string {
  if (/^\d+x\d+$/.test(value)) return value;
  const [w = 16, h = 9] = value.split(":").map(Number);
  return w < h ? "720x1280" : "1280x720";
}
export async function boundedBody(response: Response, max: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("studio_provider_invalid_result");
  let length = 0; const chunks: Uint8Array[] = [];
  for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.byteLength; if (length > max) { await reader.cancel(); throw new Error("studio_result_too_large"); } chunks.push(part.value); }
  return Buffer.concat(chunks);
}
