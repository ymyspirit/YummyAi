"use client";
import type { z } from "zod";

export class IncomingRequestError extends Error {
  constructor(readonly status: number, message: string, readonly code: string | null = null) { super(message); }
}
export const incomingDenied = (error: unknown) => error instanceof IncomingRequestError &&
  ([401, 403, 404].includes(error.status) || error.code === "authority_changed");
export async function incomingRequest<T extends z.ZodType>(path: string, schema: T,
  identity: { authority: string | null; localDevelopment: boolean }, body?: unknown, signal?: AbortSignal): Promise<z.output<T>> {
  let response: Response;
  try {
    response = await fetch(`/api/incoming/${path}`, { method: body === undefined ? "GET" : "POST", cache: "no-store",
      headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(body === undefined ? 25_000 : 50_000)]) : AbortSignal.timeout(body === undefined ? 25_000 : 50_000) });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new IncomingRequestError(0, body === undefined ? "暂时无法读取来料记录 你的填写会保留" : "未能确认本次提交结果 请先读取原提交核对");
  }
  const raw = await response.json().catch(() => null);
  if (!response.ok) throw new IncomingRequestError(response.status, typeof raw?.message === "string" ? raw.message : "暂时无法确认来料记录",
    typeof raw?.code === "string" ? raw.code : null);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new IncomingRequestError(502, "返回记录与当前操作不一致 请读取原提交核对");
  const value = parsed.data;
  if (!identity.localDevelopment && (!identity.authority || !value || typeof value !== "object" || !("contextAuthority" in value) || value.contextAuthority !== identity.authority))
    throw new IncomingRequestError(409, "当前账号或权限已变化 已停止显示原私有填写 请重新读取", "authority_changed");
  return value;
}
