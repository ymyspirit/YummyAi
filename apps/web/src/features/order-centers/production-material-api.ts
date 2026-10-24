"use client";
import type { z } from "zod";

export class MaterialRequestError extends Error {
  constructor(readonly status: number, message: string, readonly code: string | null = null) { super(message); }
}
export function materialAuthorityChanged(error: unknown) {
  return error instanceof MaterialRequestError && ([401, 403, 404].includes(error.status) || error.code === "authority_changed");
}
export async function materialRequest<T extends z.ZodType>(path: string, schema: T, identity: { authority: string | null; localDevelopment: boolean }, body?: unknown, signal?: AbortSignal): Promise<z.output<T>> {
  let response: Response;
  try {
    response = await fetch(`/api/production-materials/${path}`, { method: body === undefined ? "GET" : "POST", cache: "no-store",
      headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(body === undefined ? 25_000 : 50_000)]) : AbortSignal.timeout(body === undefined ? 25_000 : 50_000) });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new MaterialRequestError(0, body === undefined ? "物料记录暂时无法读取 请保留填写后重新核对" : "本次物料提交结果待核对 请保留原记录并重新读取");
  }
  const raw = await response.json().catch(() => null);
  if (!response.ok) throw new MaterialRequestError(response.status,
    typeof raw?.message === "string" ? raw.message : "物料记录暂时无法确认 请重新核对", typeof raw?.code === "string" ? raw.code : null);
  const value = schema.parse(raw);
  if (!identity.localDevelopment && (!identity.authority || !value || typeof value !== "object" || !("contextAuthority" in value) || value.contextAuthority !== identity.authority))
    throw new MaterialRequestError(409, "当前账号或权限已变化 请重新核对物料资料", "authority_changed");
  return value;
}
