const DEFAULT_LIMIT = 8 * 1024 * 1024;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const invalid = (): never => { throw new Error("model_response_invalid"); };
function assertComplete(payload: Record<string, unknown>) {
  if (payload.status !== undefined && payload.status !== "completed" || payload.error || payload.incomplete_details)
    throw new Error("model_response_incomplete");
  if (payload.output !== undefined && !Array.isArray(payload.output)) return invalid();
  for (const item of (payload.output ?? []) as unknown[]) {
    if (!record(item)) return invalid();
    if (item.status !== undefined && item.status !== "completed" || item.type === "refusal") throw new Error("model_response_incomplete");
    if (item.content !== undefined && !Array.isArray(item.content)) return invalid();
    for (const part of (item.content ?? []) as unknown[]) {
      if (!record(part)) return invalid();
      if (part.type === "refusal" || part.refusal !== undefined || part.status !== undefined && part.status !== "completed")
        throw new Error("model_response_incomplete");
    }
  }
}

/** Some Responses relays always stream. Only the complete final envelope is usable. */
export async function readResponsesPayload(response: Response, maxBytes = DEFAULT_LIMIT): Promise<Record<string, unknown>> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError("Invalid response limit");
  const reader = response.body?.getReader();
  if (!reader) return invalid();
  const streaming = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() === "text/event-stream";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0, buffer = "";
  let completed: Record<string, unknown> | undefined;
  function event(block: string) {
    const lines = block.split(/\r\n|\n|\r/);
    const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
    if (!data || data === "[DONE]") return;
    let parsed: unknown;
    try { parsed = JSON.parse(data); } catch { return invalid(); }
    if (!record(parsed)) return invalid();
    const label = lines.find(line => line.startsWith("event:"))?.slice(6).trim();
    const type = typeof parsed.type === "string" ? parsed.type : label;
    if (label && label !== type) return invalid();
    if (["error", "response.failed", "response.incomplete"].includes(type ?? "")) throw new Error("model_response_incomplete");
    if (type === "response.completed") {
      const final = parsed.response;
      if (!record(final) || final.status !== "completed" || final.error || final.incomplete_details) throw new Error("model_response_incomplete");
      assertComplete(final);
      completed = final;
    }
  }
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) { buffer += decoder.decode(); break; }
      bytes += part.value.byteLength;
      if (bytes > maxBytes) throw new Error("model_response_too_large");
      buffer += decoder.decode(part.value, { stream: true });
      if (streaming) {
        let boundary: RegExpExecArray | null;
        while ((boundary = /\r\n\r\n|\n\n|\r\r/.exec(buffer))) {
          const block = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          event(block);
          if (completed) return completed;
        }
      }
    }
    if (streaming) {
      if (buffer.trim()) event(buffer);
      if (!completed) throw new Error("model_response_incomplete");
      return completed;
    }
    let payload: unknown;
    try { payload = JSON.parse(buffer); } catch { return invalid(); }
    if (!record(payload)) return invalid();
    assertComplete(payload);
    return payload;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
