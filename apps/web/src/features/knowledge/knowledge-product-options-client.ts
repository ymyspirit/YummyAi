import { KnowledgeProductOptionsQuerySchema, KnowledgeProductOptionsSchema } from "@yummyai/contracts/knowledge";
import { KnowledgeRequestError } from "./knowledge-api";

async function productJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new KnowledgeRequestError(502, "产品候选未完整返回 请重新读取");
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      length += part.value.byteLength;
      if (length > (response.ok ? 128 * 1024 : 8192)) {
        await reader.cancel(); throw new KnowledgeRequestError(502, "产品候选超过读取范围 本次未截断采用");
      }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally { reader.releaseLock(); }
}

export async function readKnowledgeProductOptions(query: string, authority: string, signal?: AbortSignal) {
  const input = KnowledgeProductOptionsQuerySchema.safeParse({ q: query });
  if (!authority) throw new KnowledgeRequestError(401, "请先核对当前本人身份");
  if (!input.success) throw new KnowledgeRequestError(400, "产品搜索词最多 200 字 请核对后重新读取");
  const combined = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)]);
  combined.throwIfAborted();
  let response: Response;
  try {
    const search = input.data.q ? "?" + new URLSearchParams({ q: input.data.q }) : "";
    response = await fetch("/api/knowledge/product-options" + search, {
      method: "GET", cache: "no-store", credentials: "same-origin", redirect: "error", signal: combined,
      headers: { accept: "application/json", "x-yummyai-context-authority": authority },
    });
  } catch (failure) {
    if (combined.aborted) throw failure;
    throw new KnowledgeRequestError(0, "产品候选暂不可读取 请重试 不填写替代编号");
  }
  let raw: unknown;
  try { raw = await productJson(response); }
  catch (failure) {
    combined.throwIfAborted();
    if (!response.ok) raw = null;
    else {
      if (failure instanceof KnowledgeRequestError) throw failure;
      throw new KnowledgeRequestError(502, "产品候选格式无法核对 请重新读取");
    }
  }
  combined.throwIfAborted();
  if (!response.ok) {
    const changed = response.status === 409 && raw !== null && typeof raw === "object" && "code" in raw && raw.code === "authority_changed";
    throw new KnowledgeRequestError(response.status,
      changed || [401, 403, 404].includes(response.status) ? "当前产品读取权限已变化 原候选已隐藏" : "产品候选暂不可读取 请重试",
      changed ? "authority_changed" : null);
  }
  const parsed = KnowledgeProductOptionsSchema.safeParse(raw);
  if (response.status !== 200 || !parsed.success) throw new KnowledgeRequestError(502, "产品候选格式无法核对 请重新读取");
  if (response.headers.get("x-yummyai-context-authority") !== authority || parsed.data.contextAuthority !== authority)
    throw new KnowledgeRequestError(409, "当前身份或产品范围已变化 原候选已隐藏", "authority_changed");
  return parsed.data;
}
