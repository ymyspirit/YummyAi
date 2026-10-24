"use client";

import type { z } from "zod";

export class ProcurementCommandRequestError extends Error {
  constructor(readonly status: number, message: string, readonly code: string | null = null) { super(message); }
}
export const procurementCommandDenied = (error: unknown) => error instanceof ProcurementCommandRequestError &&
  ([401, 403, 404].includes(error.status) || error.code === "authority_changed");

/** Private command copies never enter local storage or browser history. */
export async function procurementCommandRequest<T extends z.ZodType>(path: string, schema: T,
  identity: { authority: string | null; localDevelopment: boolean }, body?: unknown, signal?: AbortSignal): Promise<z.output<T>> {
  let response: Response;
  try {
    response = await fetch(`/api/procurement-commands/${path}`, { method: body === undefined ? "GET" : "POST", cache: "no-store",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(body === undefined ? 25_000 : 50_000)]) : AbortSignal.timeout(body === undefined ? 25_000 : 50_000) });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ProcurementCommandRequestError(0, body === undefined ? "暂时无法读取采购原提交 请重新读取" : "未能确认本次提交结果 请先读取原提交核对");
  }
  const raw = await response.json().catch(() => null);
  if (!response.ok) throw new ProcurementCommandRequestError(response.status,
    typeof raw?.message === "string" ? raw.message : "暂时无法确认采购记录", typeof raw?.code === "string" ? raw.code : null);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ProcurementCommandRequestError(502, "返回记录与当前采购操作不一致 请读取原提交核对");
  const value = parsed.data;
  if (!identity.localDevelopment && (!identity.authority || !value || typeof value !== "object" || !("contextAuthority" in value) || value.contextAuthority !== identity.authority))
    throw new ProcurementCommandRequestError(409, "当前账号或权限已变化 已停止显示原私有填写 请重新读取", "authority_changed");
  return value;
}
