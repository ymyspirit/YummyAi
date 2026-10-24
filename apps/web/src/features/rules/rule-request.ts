class RuleRequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function requestOnce(path: string, body: unknown, signal?: AbortSignal) {
  const response = await fetch(`/api/rules/${path}`, {
    method: body === undefined ? "GET" : "POST", cache: "no-store", signal,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new RuleRequestError(response.status,
    typeof data?.message === "string" ? data.message : "规则服务暂时不可用，请点击“刷新”重新加载");
  if (data === null) throw new Error("规则数据无法读取，请点击“刷新”重新加载");
  return data;
}

function delay(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const stop = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, milliseconds);
    signal.addEventListener("abort", stop, { once: true });
  });
}

export async function ruleRequest(path: string, body?: unknown, signal?: AbortSignal) {
  // A lost response must never automatically replay a save, publish, or disable action.
  if (body !== undefined) return requestOnce(path, body, signal);
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), 15_000);
  const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  try {
    for (let attempt = 0; ; attempt += 1) {
      combined.throwIfAborted();
      try { return await requestOnce(path, undefined, combined); }
      catch (cause) {
        combined.throwIfAborted();
        const transient = cause instanceof TypeError ||
          cause instanceof RuleRequestError && [502, 503, 504].includes(cause.status);
        if (!transient) throw cause;
        if (attempt >= 3) throw new Error("规则服务暂时不可用，请点击“刷新”重新加载");
        await delay(1_000 * 2 ** attempt, combined);
      }
    }
  } catch (cause) {
    if (signal?.aborted) throw cause;
    if (deadline.signal.aborted) throw new Error("读取规则超时，请点击“刷新”重新加载");
    throw cause;
  } finally { clearTimeout(timer); }
}
