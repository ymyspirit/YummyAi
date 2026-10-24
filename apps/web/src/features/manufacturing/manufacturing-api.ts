"use client";
import type { z } from "zod";
import { ManufacturingResponseEnvelopeSchema } from "@yummyai/contracts/catalog/manufacturing";
export class ManufacturingRequestError extends Error {
  constructor(message: string, readonly status: number | null, readonly uncertain = false) { super(message); }
}
export class ManufacturingContextChanged extends Error {
  constructor() { super("当前身份或范围已变化 请重新核对身份与提交结果"); }
}
export async function manufacturingRequest<T extends z.ZodType>(path: string, schema: T, authority: string, localDevelopment: boolean,
  options: { body?: unknown; signal?: AbortSignal; readOnly?: boolean } = {}): Promise<z.infer<T>> {
  const writing = options.body !== undefined, mutation = writing && !options.readOnly;
  let response: Response;
  try {
    response = await fetch(`/api/manufacturing-recipes${path}`, { method: writing ? "POST" : "GET", cache: "no-store",
      body: writing ? JSON.stringify(options.body) : undefined, headers: writing ? { "content-type": "application/json" } : undefined, signal: options.signal });
  } catch {
    throw new ManufacturingRequestError(mutation ? "提交结果尚未确认 请恢复本次提交结果后再继续" : "资料暂时无法读取 请重试", null, mutation);
  }
  const value = await response.json().catch(() => null);
  if (response.status === 409 && value?.code === "authority_changed") throw new ManufacturingContextChanged();
  if (!response.ok) throw new ManufacturingRequestError(typeof value?.message === "string" ? value.message : "操作未完成 请重试", response.status, mutation && response.status >= 500);
  const parsed = ManufacturingResponseEnvelopeSchema.safeParse(value);
  if (!parsed.success) throw new ManufacturingRequestError(mutation ? "返回结果无法核对 请恢复本次提交结果" : "返回资料无法核对 请重新读取", null, mutation);
  if (!localDevelopment && parsed.data.contextAuthority !== authority) throw new ManufacturingContextChanged();
  const payload = schema.safeParse(parsed.data.data);
  if (!payload.success) throw new ManufacturingRequestError(mutation ? "返回结果无法核对 请恢复本次提交结果" : "返回资料无法核对 请重新读取", null, mutation);
  return payload.data;
}
