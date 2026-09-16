export class StudioApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function request<T>(url: string, value: unknown, method: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { method, signal, cache: "no-store", headers: value === undefined ? undefined : { "content-type": "application/json" }, body: value === undefined ? undefined : JSON.stringify(value) });
  const result = await response.json().catch(() => null) as (T & { error?: string }) | null;
  if (!response.ok) throw new StudioApiError(result?.error ?? "ERP 服务暂不可用", response.status);
  if (result === null) throw new StudioApiError("ERP 返回的内容无法读取", 502);
  return result;
}
export function studioApi<T>(path: string, value?: unknown, method = value === undefined ? "GET" : "POST", signal?: AbortSignal) {
  return request<T>(`/api/creative-studio/${path}`, value, method, signal);
}
export function studioRpc<T>(scope: string, input: Record<string, unknown>, signal?: AbortSignal) { return studioApi<T>("rpc", { ...input, scope }, "POST", signal); }
export function studioProject<T>(path: string, signal?: AbortSignal) { return request<T>(`/api/canvas-bridge/${path}`, undefined, "GET", signal); }

export const studioReadOperations = new Set(["state.get", "state.keys", "models", "assets", "asset.preview", "generations"]);
export function transientStudioError(cause: unknown) {
  return cause instanceof StudioApiError ? [408, 429, 500, 502, 503, 504].includes(cause.status)
    : cause instanceof TypeError || cause instanceof Error && cause.name === "TimeoutError";
}

/** Only use for reads. Keep hydration pending until the existing record can be read. */
export async function recoverStudioRead<T>(read: (signal: AbortSignal) => Promise<T>, options: { signal: AbortSignal; onRetry: (cause: unknown) => void }): Promise<T> {
  let attempt = 0;
  for (;;) {
    options.signal.throwIfAborted();
    try { return await read(AbortSignal.any([options.signal, AbortSignal.timeout(20_000)])); }
    catch (cause) {
      options.signal.throwIfAborted();
      if (!transientStudioError(cause)) throw cause;
      options.onRetry(cause);
      await waitForRecovery(Math.min(1000 * 2 ** Math.min(attempt++, 4), 15_000), options.signal);
    }
  }
}

function waitForRecovery(delay: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); if (typeof window !== "undefined") { window.removeEventListener("online", resume); window.removeEventListener("focus", resume); } };
    const resume = () => { cleanup(); resolve(); };
    const abort = () => { cleanup(); reject(signal.reason); };
    const timer = setTimeout(resume, delay);
    signal.addEventListener("abort", abort, { once: true });
    if (typeof window !== "undefined") { window.addEventListener("online", resume); window.addEventListener("focus", resume); }
    if (signal.aborted) abort();
  });
}
export type StudioAsset = { key: string; namespace: string; assetId: string; fileName: string; mediaType: string; rightsStatus: string; aiGenerated: boolean };
export type StudioJob = { id: string; status: string; input: { prompt: string }; model: { model: string; capability: string }; createdAt: string; error: string | null };
