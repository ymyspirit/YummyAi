import { setTimeout as delay } from "node:timers/promises";
import type { StudioGenerate } from "@yummyai/contracts/pod/creative-studio";

export type StudioOutput = { bytes: Buffer; mediaType: string } | { text: string };
export type StudioReference = { bytes: Buffer; mediaType: string };
export type StudioExecution = {
  endpoint: string; apiKey: string; model: string; capability: "image" | "video" | "text";
  input: StudioGenerate; references: StudioReference[]; providerTaskId: string | null;
};
export interface StudioGateway {
  generate(input: StudioExecution, rememberTask: (id: string) => Promise<void>): Promise<StudioOutput>;
}

/** A request is submitted once. Transport errors never cause a second billed request. */
export class HttpStudioGateway implements StudioGateway {
  constructor(private readonly transport: typeof fetch = fetch, private readonly pollInterval = 5_000) {}
  async generate(execution: StudioExecution, rememberTask: (id: string) => Promise<void>): Promise<StudioOutput> {
    const { input, model, capability, references } = execution;
    const endpoint = studioEndpoint(execution.endpoint);
    const signal = AbortSignal.timeout(15 * 60_000);
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
    const json = async (path: string, body?: object | FormData): Promise<Record<string, unknown>> => JSON.parse((await boundedBody(await call(path, body), 30_000_000)).toString("utf8"));
    if (capability === "text") {
      const result = await json("/chat/completions", { model, messages: [{ role: "user", content: input.prompt }], max_completion_tokens: 4096 });
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
