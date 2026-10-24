import { setTimeout as delay } from "node:timers/promises";

const retryDelays = [250, 750, 1500, 2500];
const connectionCodes = new Set(["ECONNREFUSED", "ECONNRESET", "EPIPE", "EAI_AGAIN", "ETIMEDOUT", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT"]);

export class ApiConnectionError extends Error {
  constructor(service: "api" | "identity", cause: unknown) {
    super(service === "identity"
      ? "登录服务暂时无法连接，请稍后重新加载页面。"
      : "数据服务暂时无法连接，可能正在重启。请稍后重新加载页面。", { cause });
    this.name = "ApiConnectionError";
  }
}

function connectionFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (connectionCodes.has(String((error as Error & { code?: string }).code))) return true;
  if (error instanceof TypeError && error.message === "fetch failed") return true;
  return error.cause !== error && connectionFailure(error.cause);
}

// Fetch uses Node's Undici transport. Replay only reads and the token grant,
// never business mutations whose first request may already have been accepted.
export async function fetchApiTransport(url: string | URL, init: RequestInit, service: "api" | "identity" = "api"): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const retryable = service === "identity" || ((method === "GET" || method === "HEAD") && init.body == null);
  const deadline = new AbortController();
  const timer = retryable ? setTimeout(() => deadline.abort(), 15_000) : undefined;
  const signal = retryable ? (init.signal ? AbortSignal.any([init.signal, deadline.signal]) : deadline.signal) : init.signal;
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        signal?.throwIfAborted();
        return await fetch(url, { ...init, signal });
      } catch (error) {
        if (init.signal?.aborted) throw init.signal.reason;
        if (!connectionFailure(error) && !deadline.signal.aborted) throw error;
        const wait = retryDelays[attempt];
        if (!retryable || deadline.signal.aborted || wait === undefined) throw new ApiConnectionError(service, error);
        try {
          await delay(wait, undefined, { signal: signal ?? undefined });
        } catch (waitingError) {
          if (init.signal?.aborted) throw init.signal.reason;
          throw new ApiConnectionError(service, waitingError);
        }
      }
    }
  } finally {
    // The deadline covers connection/headers, not a user's later media download.
    if (timer !== undefined) clearTimeout(timer);
  }
}
