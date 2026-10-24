import type { z } from "zod";

export class IntegrationClientError extends Error {
  constructor(readonly status: number, readonly code: "authority_changed" | null = null) {
    super(status === 401 ? "请重新登录自己的运营账户" : status === 403 ? "当前没有开放集成操作权限" : status === 404 ? "当前无法读取这笔客户端记录" : code ? "当前身份或授权范围已变化 请重新核对" : status === 409 ? "原状态或委派依据已变化 请核对原请求结果" : status === 400 || status === 422 ? "请核对名称 权限范围或到期时间" : "请求结果尚未确认 请保留原编号核对 不要创建第二笔请求");
  }
}
export const integrationDenied = (error: unknown) => error instanceof IntegrationClientError && ([401, 403, 404].includes(error.status) || error.code === "authority_changed");
export async function integrationClientRequest<T>(path: string, authority: string, schema: z.ZodType<T>, input?: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try { response = await fetch("/api/integration-clients/" + path, { method: input === undefined ? "GET" : "POST", cache: "no-store", credentials: "same-origin",
    headers: { "x-yummyai-context-authority": authority, ...(input === undefined ? {} : { "content-type": "application/json" }) },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: input === undefined ? AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(25_000)]) : AbortSignal.timeout(40_000) }); }
  catch { throw new IntegrationClientError(0); }
  const reader = response.body?.getReader(); if (!reader) throw new IntegrationClientError(502);
  let size = 0; const chunks: Uint8Array[] = [];
  try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength;
    if (size > (response.ok ? 8 * 1024 * 1024 : 8192)) { await reader.cancel(); throw new IntegrationClientError(502); } chunks.push(part.value); } }
  finally { reader.releaseLock(); }
  let raw: unknown;
  try { const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; } raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new IntegrationClientError(response.ok ? 502 : response.status); }
  if (!response.ok) throw new IntegrationClientError(response.status, raw && typeof raw === "object" && "code" in raw && raw.code === "authority_changed" ? "authority_changed" : null);
  if (response.headers.get("x-yummyai-context-authority") !== authority) throw new IntegrationClientError(409, "authority_changed");
  const parsed = schema.safeParse(raw); if (!parsed.success) throw new IntegrationClientError(502);
  return parsed.data;
}
