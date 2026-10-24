export class KnowledgeRequestError extends Error {
  constructor(readonly status: number, message: string, readonly code: "authority_changed" | null = null) { super(message); }
}
export const knowledgeReadDenied = (error: unknown): error is KnowledgeRequestError => error instanceof KnowledgeRequestError &&
  ([401, 403, 404].includes(error.status) || error.status === 409 && error.code === "authority_changed");

async function readJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader(); if (!reader) throw new Error("body");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > (response.ok ? 8 * 1024 * 1024 : 8192)) { await reader.cancel(); throw new Error("size"); }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    chunks.forEach(chunk => { bytes.set(chunk, offset); offset += chunk.byteLength; });
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } finally { reader.releaseLock(); }
}

/** Evaluation callers explicitly bind the current authority. Other knowledge
 * routes retain their existing transport contract in this incremental slice. */
export async function governanceApi(path: string, body?: unknown, signal?: AbortSignal, authority?: string) {
  const headers = new Headers();
  if (body !== undefined) headers.set("content-type", "application/json");
  if (authority !== undefined) headers.set("x-yummyai-context-authority", authority);
  const timeout = AbortSignal.timeout(body === undefined ? 30_000 : 120_000);
  let response: Response;
  try {
    response = await fetch("/api/knowledge-governance/" + path, {
      method: body === undefined ? "GET" : "POST", cache: "no-store", credentials: "same-origin", headers,
      signal: body === undefined && signal ? AbortSignal.any([signal, timeout]) : timeout,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    if (signal?.aborted && body === undefined) throw error;
    throw new KnowledgeRequestError(0, body === undefined ? "读取未完成 请按原编号重新读取" : "请求结果尚未确认 请保留原正文和编号核对 不自动重做");
  }
  let data: unknown = null;
  try { data = await readJson(response); }
  catch { if (response.ok) throw new KnowledgeRequestError(502, "完整知识记录无法核对 请按原编号重新读取 未截断或补造结果"); }
  if (!response.ok) {
    const item = data && typeof data === "object" ? data as Record<string, unknown> : null;
    const code = item?.code === "authority_changed" ? "authority_changed" : null;
    const messages: Record<number, string> = { 400: "填写内容或原编号无法核对", 401: "当前登录已失效 私有评测资料已隐藏",
      403: "当前权限不足 私有评测资料已隐藏", 404: "原记录当前不可访问 私有评测资料已隐藏",
      409: "原依据或版本存在冲突 请保留原请求核对 不自动换键", 413: "完整内容超过限制 本次未截断提交", 422: "当前评测依据未通过核对" };
    const message = authority === undefined && typeof item?.message === "string" ? item.message.slice(0, 500) :
      code ? "当前身份或资料范围已变化 私有评测资料已隐藏" : messages[response.status] ?? "知识服务未完成 请保留原编号后重读";
    throw new KnowledgeRequestError(response.status, message, code);
  }
  if (authority !== undefined && response.headers.get("x-yummyai-context-authority") !== authority)
    throw new KnowledgeRequestError(409, "当前身份或资料范围已变化 私有评测资料已隐藏", "authority_changed");
  return data;
}
