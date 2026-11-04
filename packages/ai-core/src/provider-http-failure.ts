import { ModelProviderHttpFailureSchema, type ModelProviderHttpFailure } from "@yummyai/contracts/ai/provider-failure";

export type { ModelProviderHttpFailure } from "@yummyai/contracts/ai/provider-failure";

export class ModelProviderHttpError extends Error {
  readonly failure: ModelProviderHttpFailure;
  constructor(failure: ModelProviderHttpFailure) {
    super(`studio_provider_http_${failure.status}`);
    this.name = "ModelProviderHttpError";
    this.failure = ModelProviderHttpFailureSchema.parse(failure);
  }
}

const knownCodes = new Set([
  "moderation_blocked", "content_policy_violation", "content_filter", "safety_violation",
  "rate_limit_exceeded", "rate_limit_error", "slow_down", "insufficient_quota", "billing_hard_limit_reached",
  "invalid_api_key", "authentication_error", "permission_denied", "invalid_request_error", "invalid_value",
  "invalid_parameter", "unsupported_parameter", "model_not_found", "invalid_image", "image_parse_error",
  "server_error", "service_unavailable", "overloaded_error",
]);
const moderationCodes = new Set(["moderation_blocked", "content_policy_violation", "content_filter", "safety_violation"]);
const rateCodes = new Set(["rate_limit_exceeded", "rate_limit_error", "slow_down"]);

/** A non-2xx response is not automatically proof of a rejected generation.
 * Only explicit supported 4xx errors qualify; 5xx and unreadable bodies stay
 * uncertain. No body/message or arbitrary provider string survives this parser. */
export async function parseModelProviderHttpFailure(response: Response): Promise<ModelProviderHttpError> {
  const receivedAt = new Date().toISOString();
  const body = await readErrorBody(response);
  const error = record(body?.error);
  const rawCode = typeof error?.code === "string" ? error.code : null;
  const rawType = typeof error?.type === "string" ? error.type : null;
  const code = rawCode && knownCodes.has(rawCode) ? rawCode : null;
  let kind: ModelProviderHttpFailure["kind"] = "unknown";
  if (response.status >= 500) kind = "unavailable";
  else if (response.status === 401 || response.status === 403 && (code === "permission_denied" || rawType === "authentication_error")) kind = "authentication";
  else if ([400, 403].includes(response.status) && code && moderationCodes.has(code)) kind = "moderation";
  else if (response.status === 429 && (code && rateCodes.has(code) || rawType === "rate_limit_error") && code !== "insufficient_quota" && code !== "billing_hard_limit_reached") kind = "rate_limit";
  else if ([400, 404, 422].includes(response.status) && error && (rawType === "invalid_request_error" || code && ["invalid_value", "invalid_parameter", "unsupported_parameter", "model_not_found", "invalid_image", "image_parse_error"].includes(code))) kind = "invalid_request";
  else if (response.status === 429 && ["insufficient_quota", "billing_hard_limit_reached"].includes(code ?? "")) kind = "authentication";
  const requestId = response.headers.get("x-request-id");
  return new ModelProviderHttpError({ version: 1, status: response.status, kind, code,
    providerRequestId: requestId && /^[a-zA-Z0-9_-]{1,160}$/.test(requestId) ? requestId : null,
    receivedAt, retryAfterMs: kind === "rate_limit" ? retryAfter(response.headers, receivedAt) : null });
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

async function readErrorBody(response: Response): Promise<Record<string, unknown> | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 32_768) { await reader.cancel().catch(() => undefined); return null; }
      chunks.push(chunk.value);
    }
    return record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch { return null; }
  finally { reader.releaseLock(); }
}

function retryAfter(headers: Headers, receivedAt: string): number | null {
  const ms = headers.get("retry-after-ms"), raw = headers.get("retry-after");
  const delay = ms && /^\d+(?:\.\d+)?$/.test(ms) ? Number(ms)
    : raw && /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) * 1000
    : raw ? Date.parse(raw) - Date.parse(receivedAt) : NaN;
  // Oversized hints stop autonomous retries instead of retrying earlier than requested.
  return Number.isFinite(delay) && delay <= 86_400_000 ? Math.max(0, Math.ceil(delay)) : raw || ms ? 86_400_000 : null;
}
